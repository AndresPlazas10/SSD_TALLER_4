// Replicación del auth-service (Taller 7): single-writer replication.
//
// - Un líder a la vez. Solo el líder acepta escrituras: las aplica a su BD, las
//   anota en el log de replicación (seq, term, op, data) y las propaga a las
//   réplicas por WS (write_propagate). Las réplicas las aplican en el mismo
//   orden y con los mismos datos (mismo userId en todas).
// - Consistencia: opción B. El líder responde al cliente recién cuando al menos
//   una réplica confirmó la escritura (mayoría de 3). Así, si el líder muere
//   justo después de responder, la escritura ya está en otro nodo y la elección
//   (que solo vota a candidatos con el log al día) no la pierde.
// - Elección (estilo Raft, mensajes del enunciado): si una réplica no recibe
//   heartbeat del líder en ELECTION_TIMEOUT (6 s, más un azar para no empatar),
//   sube el term y pide votos (election). Cada nodo vota una vez por term y solo
//   a un candidato cuyo log esté al menos tan al día como el suyo (vote). Con
//   mayoría (2 de 3) el candidato es líder y lo anuncia (new_leader).
// - Log encadenado: el hash de cada entrada incluye el de la anterior, así que
//   comparar el último hash compara toda la historia.
// - Sincronización: una réplica atrasada pide request_sync con su último seq y
//   hash. Si el hash no coincide con el del líder en ese seq (su historia
//   divergió, p. ej. una escritura que nunca se confirmó), el líder le manda el
//   log completo y la réplica rehace su copia (reset, con respaldo previo). Si
//   coincide, solo lo que le falta.
// - Seguridad: el hello lleva un JWT firmado con la JWT_SECRET (role: 'auth');
//   un proceso cualquiera no puede entrar al cluster a inyectar usuarios.

const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');

const MAX_PEER_MESSAGE_BYTES = 8 * 1024 * 1024; // un sync_response puede traer el log completo
const HELLO_TIMEOUT_MS = 5000;

class ReplicationError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    Object.assign(this, extra);
  }
}

function entryHash(prevHash, op, data) {
  return crypto.createHash('sha256').update(`${prevHash}|${op}|${JSON.stringify(data)}`).digest('hex');
}

// (term, seq) de a es al menos tan nuevo como el de b
const atLeastAsNew = (aTerm, aSeq, bTerm, bSeq) => aTerm > bTerm || (aTerm === bTerm && aSeq >= bSeq);

function createReplication({
  db, dbFile, authId, publicUrl, peerUrl, peers = {}, secret,
  heartbeatMs = 2000, electionTimeoutMs = 6000, ackTimeoutMs = 3000, readLagTolerance = 10,
  peerPort = null, applyOp, clearData, getDirectory = () => [], onDirectory = () => {},
}) {
  // peers: { 'auth-b': 'ws://host:4102', ... }. Puede incluir a este nodo (así
  // los tres usan la misma AUTH_PEERS); se descarta. Sin peers = modo solo.
  peers = { ...peers };
  delete peers[authId];
  const clusterSize = Object.keys(peers).length + 1;
  const standalone = clusterSize === 1;
  const majority = Math.floor(clusterSize / 2) + 1;

  // --- Persistencia: log de replicación y metadatos (term y voto) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS replication_log (
      seq INTEGER PRIMARY KEY,
      term INTEGER NOT NULL,
      op TEXT NOT NULL,
      data TEXT NOT NULL,
      hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const q = {
    last: db.prepare('SELECT seq, term, hash FROM replication_log ORDER BY seq DESC LIMIT 1'),
    at: db.prepare('SELECT seq, term, hash FROM replication_log WHERE seq = ?'),
    insert: db.prepare('INSERT INTO replication_log (seq, term, op, data, hash) VALUES (?, ?, ?, ?, ?)'),
    from: db.prepare('SELECT seq, term, op, data, hash FROM replication_log WHERE seq >= ? ORDER BY seq'),
    getMeta: db.prepare('SELECT value FROM auth_meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO auth_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    users: db.prepare('SELECT count(*) AS n FROM users'),
  };
  const log = (msg) => console.log(`[auth ${authId}] ${msg}`);

  // Arranque: los usuarios que ya estaban en la BD (Talleres 4-6) entran al log
  // como 'import', así se replican igual que cualquier escritura.
  if (!q.last.get()) {
    const rows = db.prepare('SELECT * FROM users ORDER BY id').all();
    if (rows.length) {
      db.exec('BEGIN');
      try {
        let prev = '';
        rows.forEach((r, i) => {
          const data = { userId: r.id, username: r.username, provider: r.provider, password_hash: r.password_hash,
            google_sub: r.google_sub, email: r.email, created_at: r.created_at, vehicle: r.vehicle };
          prev = entryHash(prev, 'import', data);
          q.insert.run(i + 1, 0, 'import', JSON.stringify(data), prev);
        });
        db.exec('COMMIT');
        log(`${rows.length} usuarios que ya existían entran al log como 'import'`);
      } catch (err) { db.exec('ROLLBACK'); throw err; }
    }
  }

  const lastEntry = () => q.last.get() || { seq: 0, term: 0, hash: '' };
  let last = lastEntry(); // copia en memoria de la última entrada
  let currentTerm = Number((q.getMeta.get('term') || {}).value || 0);
  let votedFor = (q.getMeta.get('votedFor') || {}).value || null;
  const saveTerm = () => { q.setMeta.run('term', String(currentTerm)); q.setMeta.run('votedFor', votedFor || ''); };

  let role = standalone ? 'leader' : 'replica';
  let leaderId = standalone ? authId : null;
  let lastHeartbeatAt = 0;
  let leaderLastSeq = 0;
  let votes = new Set();
  let electionDeadline = 0;
  const resetElectionTimer = () => {
    electionDeadline = Date.now() + electionTimeoutMs + Math.random() * electionTimeoutMs * 0.25;
  };
  resetElectionTimer();

  // peerId -> { ws, matchSeq }   (conexiones abiertas)
  const links = new Map();
  // peerId -> { peerUrl, publicUrl, lastSeq, lastTerm }   (lo que se sabe de cada par)
  const peerInfo = new Map(Object.keys(peers).map((id) => [id, { peerUrl: peers[id], publicUrl: null, lastSeq: 0, lastTerm: 0 }]));
  const pendingAcks = []; // { seq, resolve, reject, timer }
  let syncingUntil = 0;

  const token = () => jwt.sign({ role: 'auth', authId }, secret, { expiresIn: '2m' });
  const hello = () => JSON.stringify({ type: 'hello', authId, role, term: currentTerm, lastSeq: last.seq, lastTerm: last.term,
    publicUrl, peerUrl, auth: token() });
  const send = (peerId, obj) => { const l = links.get(peerId); if (l && l.ws.readyState === WebSocket.OPEN) l.ws.send(JSON.stringify(obj)); };
  const broadcast = (obj) => { const s = JSON.stringify(obj); for (const l of links.values()) if (l.ws.readyState === WebSocket.OPEN) l.ws.send(s); };
  const notePeerLog = (peerId, msg) => {
    const info = peerInfo.get(peerId);
    if (info && Number.isInteger(msg.lastSeq)) { info.lastSeq = msg.lastSeq; info.lastTerm = Number(msg.lastTerm) || 0; }
  };

  function failPending(code) {
    while (pendingAcks.length) {
      const p = pendingAcks.shift();
      clearTimeout(p.timer);
      p.reject(new ReplicationError(code));
    }
  }

  function becomeFollower(term, newLeader) {
    const was = role;
    if (term > currentTerm) { currentTerm = term; votedFor = null; saveTerm(); }
    role = 'replica';
    if (newLeader !== undefined) leaderId = newLeader;
    if (was === 'leader') {
      log(`deja de ser líder (term ${currentTerm})`);
      failPending('not_leader');
    }
  }

  function becomeLeader() {
    role = 'leader';
    leaderId = authId;
    for (const l of links.values()) l.matchSeq = 0;
    log(`es el nuevo LÍDER (term ${currentTerm}, seq ${last.seq}, ${votes.size} de ${links.size + 1} vivos / ${clusterSize} nodos)`);
    broadcast({ type: 'new_leader', leader: authId, term: currentTerm, publicUrl });
    sendHeartbeat();
  }

  // Mayoría sobre los nodos vivos conectados: con 2 o 3 vivos exige 2 votos;
  // si los otros dos cayeron y queda 1 solo vivo (links.size === 0), ese último
  // sobreviviente puede asumir como líder con su propio voto (1 de 1 vivo).
  const activeMajority = () => Math.floor((links.size + 1) / 2) + 1;

  // Se postula si ningún par conectado tiene un log más nuevo (ese par ganaría
  // igual; así, al arrancar, gana el que trae los usuarios existentes).
  function canRunForLeader() {
    if (links.size + 1 < activeMajority()) return false;
    for (const id of links.keys()) {
      const p = peerInfo.get(id);
      if (p && !atLeastAsNew(last.term, last.seq, p.lastTerm, p.lastSeq)) return false;
    }
    return true;
  }

  function startElection() {
    currentTerm += 1;
    votedFor = authId;
    saveTerm();
    role = 'candidate';
    leaderId = null;
    votes = new Set([authId]);
    resetElectionTimer();
    log(`no hay líder: se postula (term ${currentTerm}, seq ${last.seq})`);
    broadcast({ type: 'election', candidate: authId, term: currentTerm, lastSeq: last.seq, lastTerm: last.term });
    if (votes.size >= activeMajority()) becomeLeader();
  }

  function sendHeartbeat() {
    if (role !== 'leader' || standalone) return;
    // members: la URL pública de cada nodo que conoce el líder, así una réplica
    // sabe la de un par al que todavía no se conectó (para /peers y leaderUrl)
    const members = { [authId]: publicUrl };
    for (const [id, info] of peerInfo) if (info.publicUrl) members[id] = info.publicUrl;
    broadcast({ type: 'heartbeat', authId, term: currentTerm, lastSeq: last.seq, lastTerm: last.term, lastHash: last.hash,
      publicUrl, members, directory: getDirectory() });
  }

  // Estado del log de una réplica para los demás (decide quién puede postularse).
  // Lleva también su copia del directorio: si un coordinador le mandó a ella
  // el heartbeat (el líder acababa de caer), el resto, y sobre todo el líder
  // nuevo, se entera sin esperar a que el coordinador se cambie de auth.
  function sendState() {
    if (role === 'leader' || standalone) return;
    broadcast({ type: 'state', authId, term: currentTerm, lastSeq: last.seq, lastTerm: last.term, directory: getDirectory() });
  }

  // --- Aplicar entradas que manda el líder ---
  function applyEntries(entries, reset) {
    db.exec('BEGIN');
    try {
      if (reset) {
        clearData();
        db.exec('DELETE FROM replication_log');
        last = { seq: 0, term: 0, hash: '' };
      }
      for (const e of entries) {
        if (e.seq <= last.seq) continue;
        if (e.seq !== last.seq + 1) break; // hueco: lo resuelve el próximo sync
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        const hash = entryHash(last.hash, e.op, data);
        if (e.hash && e.hash !== hash) throw new Error(`hash distinto en seq ${e.seq}`);
        applyOp(e.op, data);
        q.insert.run(e.seq, e.term, e.op, JSON.stringify(data), hash);
        last = { seq: e.seq, term: e.term, hash };
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      last = lastEntry();
      log(`error aplicando entradas: ${err.message}`);
      return false;
    }
    return true;
  }

  // Respaldo antes de rehacer la copia: si esta BD tenía usuarios que el líder
  // no tiene (escrituras nunca confirmadas), quedan en el archivo .bak
  function backupBeforeReset() {
    if (!dbFile || dbFile === ':memory:' || q.users.get().n === 0) return;
    const bak = `${dbFile}.bak-${Date.now()}`;
    try {
      db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
      log(`respaldo de la copia anterior en ${bak}`);
    } catch (err) { log(`no se pudo respaldar antes del reset: ${err.message}`); }
  }

  function requestSync(force = false) {
    if (!leaderId || leaderId === authId) return;
    if (!force && Date.now() < syncingUntil) return;
    syncingUntil = Date.now() + 2000;
    send(leaderId, { type: 'request_sync', fromSeq: last.seq + 1, lastSeq: last.seq, lastHash: last.hash });
  }

  function ack() {
    if (leaderId && leaderId !== authId) send(leaderId, { type: 'ack', authId, seq: last.seq, hash: last.hash, term: currentTerm });
  }

  function checkPending() {
    const need = activeMajority();
    for (let i = pendingAcks.length - 1; i >= 0; i--) {
      const p = pendingAcks[i];
      const acked = [...links.values()].filter((l) => (l.matchSeq || 0) >= p.seq).length;
      if (acked + 1 >= need) {
        clearTimeout(p.timer);
        pendingAcks.splice(i, 1);
        p.resolve();
      }
    }
  }

  // Mensaje de quien este nodo reconoce como líder del term actual (o más nuevo)
  function fromLeader(peerId, term) {
    if (!Number.isInteger(term) || term < currentTerm) return false;
    if (term > currentTerm || leaderId !== peerId || role !== 'replica') becomeFollower(term, peerId);
    lastHeartbeatAt = Date.now();
    resetElectionTimer();
    return true;
  }

  // --- Mensajes del cluster ---
  function onMessage(peerId, msg) {
    const link = links.get(peerId);
    switch (msg.type) {
      case 'heartbeat':
      case 'new_leader': {
        const leader = msg.type === 'heartbeat' ? msg.authId : msg.leader;
        if (leader !== peerId) return;
        const changed = leaderId !== leader;
        if (!fromLeader(peerId, msg.term)) return;
        if (msg.publicUrl) peerInfo.get(peerId).publicUrl = msg.publicUrl;
        if (changed) log(`sigue al líder ${leader} (term ${currentTerm})`);
        if (msg.type === 'new_leader') { requestSync(true); return; }
        notePeerLog(peerId, msg);
        if (msg.members && typeof msg.members === 'object') {
          for (const [id, url] of Object.entries(msg.members)) {
            const info = peerInfo.get(id);
            if (info && !info.publicUrl && typeof url === 'string' && /^https?:\/\//.test(url)) info.publicUrl = url;
          }
        }
        leaderLastSeq = msg.lastSeq;
        if (Array.isArray(msg.directory)) onDirectory(msg.directory);
        // Atrasada, con otra historia o recién llegada: comprobar y pedir
        if (changed || msg.lastSeq !== last.seq || msg.lastHash !== last.hash) requestSync(changed);
        else ack();
        return;
      }
      case 'write_propagate': {
        if (peerId !== leaderId || !fromLeader(peerId, msg.term)) return;
        leaderLastSeq = Math.max(leaderLastSeq, msg.seq);
        if (msg.seq === last.seq + 1 && entryHash(last.hash, msg.op, msg.data) === msg.hash) {
          if (applyEntries([msg], false)) {
            log(`replicado seq ${msg.seq} (${msg.op} ${msg.data && msg.data.username}), ${q.users.get().n} usuarios`);
            ack();
          } else requestSync(true);
        } else if (msg.seq <= last.seq) {
          const mine = q.at.get(msg.seq);
          if (mine && mine.hash === msg.hash) ack(); else requestSync(true);
        } else requestSync();
        return;
      }
      case 'request_sync': {
        if (role !== 'leader') return;
        const lastSeq = Number(msg.lastSeq) || 0;
        const mine = lastSeq > 0 ? q.at.get(lastSeq) : null;
        const diverged = lastSeq > 0 && (!mine || mine.hash !== msg.lastHash);
        const entries = q.from.all(diverged ? 1 : lastSeq + 1)
          .map((e) => ({ seq: e.seq, term: e.term, op: e.op, data: JSON.parse(e.data), hash: e.hash }));
        if (diverged) log(`${peerId} tiene otra historia (seq ${lastSeq}): se le manda el log completo`);
        send(peerId, { type: 'sync_response', term: currentTerm, reset: diverged, entries });
        return;
      }
      case 'sync_response': {
        if (peerId !== leaderId || !fromLeader(peerId, msg.term) || !Array.isArray(msg.entries)) return;
        const before = last.seq;
        if (msg.reset) backupBeforeReset();
        const ok = applyEntries(msg.entries, msg.reset === true);
        syncingUntil = 0;
        if (msg.reset || last.seq !== before) {
          log(`sync con ${peerId}: seq ${before} -> ${last.seq}${msg.reset ? ' (copia rehecha)' : ''}, ${q.users.get().n} usuarios`);
        }
        if (ok) ack();
        return;
      }
      case 'ack': {
        if (role !== 'leader' || !link || msg.term !== currentTerm) return;
        const mine = q.at.get(Number(msg.seq));
        if (mine && mine.hash === msg.hash) link.matchSeq = Math.max(link.matchSeq || 0, mine.seq);
        checkPending();
        return;
      }
      case 'state': {
        if (msg.authId !== peerId) return;
        notePeerLog(peerId, msg);
        if (Array.isArray(msg.directory)) onDirectory(msg.directory);
        return;
      }
      case 'election': {
        if (!Number.isInteger(msg.term) || msg.candidate !== peerId) return;
        notePeerLog(peerId, msg);
        if (msg.term > currentTerm) becomeFollower(msg.term, null);
        const grant = msg.term === currentTerm && role !== 'leader' && (!votedFor || votedFor === peerId)
          && atLeastAsNew(Number(msg.lastTerm) || 0, Number(msg.lastSeq) || 0, last.term, last.seq);
        if (grant) {
          votedFor = peerId;
          saveTerm();
          resetElectionTimer();
          log(`vota por ${peerId} (term ${currentTerm})`);
        }
        send(peerId, { type: 'vote', voter: authId, term: currentTerm, voteGranted: grant });
        return;
      }
      case 'vote': {
        if (msg.term > currentTerm) { becomeFollower(msg.term, null); return; }
        if (role !== 'candidate' || msg.term !== currentTerm || msg.voter !== peerId || msg.voteGranted !== true) return;
        votes.add(peerId);
        if (votes.size >= activeMajority()) becomeLeader();
        return;
      }
      default:
    }
  }

  // --- Conexiones entre auths ---
  function checkHello(msg) {
    if (!msg || msg.type !== 'hello' || typeof msg.authId !== 'string' || msg.authId === authId) return null;
    if (!peerInfo.has(msg.authId)) return null; // solo los nodos de AUTH_PEERS
    try {
      const p = jwt.verify(msg.auth, secret, { algorithms: ['HS256'] });
      if (p.role !== 'auth' || p.authId !== msg.authId) return null;
    } catch (_) { return null; }
    return msg;
  }

  function register(h, ws) {
    const peerId = h.authId;
    if (links.has(peerId)) { ws.close(4009, 'duplicate'); return; }
    links.set(peerId, { ws, matchSeq: 0 });
    const info = peerInfo.get(peerId);
    if (h.publicUrl) info.publicUrl = h.publicUrl;
    notePeerLog(peerId, h);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    log(`conectado con ${peerId} (${links.size + 1} de ${clusterSize} nodos)`);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg && typeof msg === 'object') onMessage(peerId, msg);
    });
    ws.on('close', () => {
      if (!links.has(peerId) || links.get(peerId).ws !== ws) return;
      links.delete(peerId);
      log(`se fue ${peerId}${peerId === leaderId ? ' (era el líder)' : ''}`);
      if (role === 'leader') checkPending();
    });
    const peerTerm = Number(h.term) || 0;
    const peerLastTerm = Number(h.lastTerm) || 0;
    const peerLastSeq = Number(h.lastSeq) || 0;
    const peerBetterLeader = h.role === 'leader' && (
      peerTerm > currentTerm
      || (peerTerm === currentTerm && (!atLeastAsNew(last.term, last.seq, peerLastTerm, peerLastSeq)
        || (last.term === peerLastTerm && last.seq === peerLastSeq && peerId < authId)))
    );
    if (peerTerm > currentTerm || peerBetterLeader) {
      becomeFollower(Math.max(currentTerm, peerTerm), h.role === 'leader' ? peerId : null);
      if (h.role === 'leader') {
        lastHeartbeatAt = Date.now();
        resetElectionTimer();
        requestSync(true);
      }
    }
    // Un líder avisa enseguida al que acaba de conectarse
    if (role === 'leader') {
      send(peerId, { type: 'new_leader', leader: authId, term: currentTerm, publicUrl });
      sendHeartbeat();
    }
  }

  function onIncoming(ws) {
    ws.on('error', () => {});
    const timer = setTimeout(() => ws.close(4008, 'hello timeout'), HELLO_TIMEOUT_MS);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { msg = null; }
      const h = checkHello(msg);
      if (!h) { ws.close(4003, 'bad hello'); return; }
      if (links.has(h.authId)) { ws.close(4009, 'duplicate'); return; }
      ws.send(hello());
      register(h, ws);
    });
  }

  const connecting = new Set();
  function connectTo(peerId) {
    if (links.has(peerId) || connecting.has(peerId)) return;
    connecting.add(peerId);
    let ws;
    try {
      ws = new WebSocket(peers[peerId], { maxPayload: MAX_PEER_MESSAGE_BYTES, handshakeTimeout: HELLO_TIMEOUT_MS,
        headers: { 'ngrok-skip-browser-warning': 'true' } });
    } catch (err) {
      connecting.delete(peerId);
      log(`URL inválida para ${peerId}: ${peers[peerId]}`);
      return;
    }
    const done = () => connecting.delete(peerId);
    ws.on('error', done);
    ws.on('close', done);
    ws.on('open', () => {
      ws.send(hello());
      const timer = setTimeout(() => ws.close(4008, 'hello timeout'), HELLO_TIMEOUT_MS);
      ws.once('message', (raw) => {
        clearTimeout(timer);
        done();
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (_) { msg = null; }
        const h = checkHello(msg);
        if (!h || h.authId !== peerId) { ws.close(4003, 'bad hello'); return; }
        register(h, ws);
      });
    });
  }

  let server = null;
  let upgradeServer = null;
  const timers = [];
  if (!standalone) {
    upgradeServer = new WebSocketServer({ noServer: true, maxPayload: MAX_PEER_MESSAGE_BYTES });
    if (peerPort) {
      server = new WebSocketServer({ port: peerPort, maxPayload: MAX_PEER_MESSAGE_BYTES });
      server.on('connection', onIncoming);
      server.on('error', (err) => {
        console.error(`[auth ${authId}] no se pudo escuchar el cluster en el puerto ${peerPort}: ${err.message}`);
        process.exit(1);
      });
    }
    // El de authId menor inicia la conexión; se reintenta mientras no esté
    const dial = () => { for (const id of Object.keys(peers)) if (authId < id) connectTo(id); };
    dial();
    timers.push(setInterval(dial, heartbeatMs));
    timers.push(setInterval(() => { sendHeartbeat(); sendState(); }, heartbeatMs));
    // Reloj de elección: sin heartbeat del líder hasta electionDeadline -> elección
    timers.push(setInterval(() => {
      if (role === 'leader' || Date.now() < electionDeadline) return;
      if (canRunForLeader()) startElection();
      else resetElectionTimer();
    }, Math.min(200, heartbeatMs)));
    // Ping entre auths para detectar conexiones colgadas (p. ej. un túnel caído)
    timers.push(setInterval(() => {
      for (const l of links.values()) {
        if (l.ws.isAlive === false) { l.ws.terminate(); continue; }
        l.ws.isAlive = false;
        l.ws.ping();
      }
    }, heartbeatMs));
    log(`cluster de ${clusterSize} nodos: ${Object.entries(peers).map(([id, u]) => `${id}=${u}`).join(', ')}`);
  }

  // --- API para el auth-service ---
  function leaderPublicUrl() {
    if (!leaderId) return null;
    if (leaderId === authId) return publicUrl;
    return (peerInfo.get(leaderId) || {}).publicUrl || null;
  }
  const leaderAlive = () => standalone || role === 'leader'
    || (leaderId !== null && links.has(leaderId) && Date.now() - lastHeartbeatAt <= electionTimeoutMs);

  // ¿Puede este nodo responder una LECTURA (login, Google de un usuario existente)?
  // Sí, si es líder o si es una réplica con menos de readLagTolerance entradas de atraso.
  // Sin líder (elección en curso, o este auth quedó solo) también: tiene todo
  // lo que se confirmó hasta que perdió al líder, así que el login sigue
  // funcionando. Lo que NO se puede sin mayoría es escribir (ver writeCheck).
  function readCheck() {
    if (standalone || role === 'leader') return null;
    if (!leaderAlive()) return null;
    if (leaderLastSeq - last.seq >= readLagTolerance) {
      return { status: 503, body: { error: 'not_leader', leaderUrl: leaderPublicUrl(), reason: 'replica_lagging' } };
    }
    return null;
  }
  // Réplica con alguna entrada pendiente: un "no existe" podría ser atraso.
  // Sin líder vivo no hay a quién preguntarle: se contesta con lo que hay.
  const isBehind = () => !standalone && role !== 'leader' && leaderAlive() && leaderLastSeq > last.seq;

  function writeCheck() {
    if (standalone || role === 'leader') return null;
    if (!leaderAlive()) return { status: 503, body: { error: 'no_leader' } };
    return { status: 503, body: { error: 'not_leader', leaderUrl: leaderPublicUrl() } };
  }

  // Escritura en el líder. leaderApply() hace el INSERT y devuelve los datos de
  // la entrada (con el userId asignado). Opción B: resuelve recién cuando una
  // mayoría (el líder y al menos una réplica) la tiene.
  async function commit(op, leaderApply) {
    const blocked = writeCheck();
    if (blocked) throw new ReplicationError(blocked.body.error, { leaderUrl: blocked.body.leaderUrl });
    if (!standalone && links.size + 1 < activeMajority()) throw new ReplicationError('no_quorum');
    let data;
    let entry;
    db.exec('BEGIN');
    try {
      data = leaderApply();
      entry = { seq: last.seq + 1, term: currentTerm, hash: entryHash(last.hash, op, data) };
      q.insert.run(entry.seq, entry.term, op, JSON.stringify(data), entry.hash);
      db.exec('COMMIT');
      last = entry;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    if (standalone) return { seq: entry.seq, data };
    broadcast({ type: 'write_propagate', term: currentTerm, seq: entry.seq, op, data, hash: entry.hash });
    await new Promise((resolve, reject) => {
      const p = { seq: entry.seq, resolve, reject };
      p.timer = setTimeout(() => {
        const i = pendingAcks.indexOf(p);
        if (i >= 0) pendingAcks.splice(i, 1);
        reject(new ReplicationError('replication_timeout'));
      }, ackTimeoutMs);
      pendingAcks.push(p);
      checkPending();
    });
    return { seq: entry.seq, data };
  }

  function status() {
    return {
      authId, role, publicUrl, peerUrl,
      leaderUrl: leaderAlive() ? leaderPublicUrl() : null,
      knownPeers: Object.keys(peers).map((id) => ({ authId: id, peerUrl: peers[id], connected: links.has(id) })),
      lastAppliedSeq: last.seq,
      users: q.users.get().n,
      term: currentTerm,
      leaderId: leaderAlive() ? leaderId : null,
      clusterSize,
    };
  }

  function peerList() {
    return [...peerInfo.entries()].map(([id, info]) => ({
      authId: id, publicUrl: info.publicUrl, peerUrl: info.peerUrl,
      role: id === leaderId && leaderAlive() ? 'leader' : 'replica', connected: links.has(id),
    }));
  }

  function handleUpgrade(req, socket, head) {
    if (!upgradeServer) { socket.destroy(); return; }
    upgradeServer.handleUpgrade(req, socket, head, onIncoming);
  }

  function close() {
    for (const t of timers) clearInterval(t);
    for (const l of links.values()) l.ws.terminate();
    if (server) server.close();
    if (upgradeServer) upgradeServer.close();
    failPending('shutting_down');
  }

  return {
    standalone, commit, readCheck, writeCheck, isBehind, status, peerList, handleUpgrade, close,
    role: () => role,
    leaderId: () => (leaderAlive() ? leaderId : null),
    leaderUrl: () => (leaderAlive() ? leaderPublicUrl() : null),
    authId,
  };
}

module.exports = { createReplication, ReplicationError };
