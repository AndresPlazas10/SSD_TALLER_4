// Mesh entre coordinadores (Taller 6).
//
// - Directorio: cada HEARTBEAT_MS (2 s) el coordinador se anuncia en el auth
//   (POST /heartbeat) y pide la lista de pares vivos (GET /peers).
// - Conexiones: cada coordinador escucha a sus pares en su propio puerto
//   (PEER_PORT, separado del WS de los jugadores). Para que cada par tenga UNA
//   sola conexión, solo inicia la conexión el de coordinatorId menor; el otro
//   espera. Si aun así llega una duplicada, se cierra la nueva.
// - Handshake: el primer mensaje de cada lado es
//   { type: 'hello', coordinatorId, startedAt, auth } donde auth es un JWT
//   firmado con la JWT_SECRET compartida: un proceso cualquiera no puede
//   meterse al mesh a inyectar movimientos.
// - Sin bucles: todo mensaje lleva origin = el coordinador que lo originó. Se
//   descarta lo que tenga origin propio, y lo que no venga directo de su origen
//   (nadie retransmite: cada coordinador manda a todos sus pares).
// - Líder: el coordinador vivo que arrancó primero (startedAt menor; en empate,
//   el id menor). Decide lo que es de todo el mundo (pasajero, rondas,
//   puntajes). Un coordinador nuevo nunca le quita el puesto al que ya está.

const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');

const HEARTBEAT_MS = 2000;
const PEER_PING_MS = 2000;
const HELLO_TIMEOUT_MS = 5000;
const MAX_PEER_MESSAGE_BYTES = 256 * 1024;

function createMesh({ id, peerPort, publicUrl, peerUrl, authUrl, secret, startedAt, getConnectedPlayers, onMessage, onPeerUp, onPeerDown }) {
  // peerId -> { ws, startedAt } (solo pares con handshake completo)
  const peers = new Map();
  const connecting = new Set();
  let directoryOk = null;

  const token = () => jwt.sign({ role: 'coordinator', coordinatorId: id }, secret, { expiresIn: '2m' });
  const hello = () => JSON.stringify({ type: 'hello', coordinatorId: id, startedAt, auth: token() });

  // Verifica el hello de un par: firma, rol y que el id coincida
  function checkHello(msg) {
    if (!msg || msg.type !== 'hello' || typeof msg.coordinatorId !== 'string') return null;
    try {
      const p = jwt.verify(msg.auth, secret, { algorithms: ['HS256'] });
      if (p.role !== 'coordinator' || p.coordinatorId !== msg.coordinatorId) return null;
    } catch (_) {
      return null;
    }
    if (msg.coordinatorId === id) return null;
    return { peerId: msg.coordinatorId, startedAt: Number(msg.startedAt) || Date.now() };
  }

  function register(peerId, peerStartedAt, ws) {
    if (peers.has(peerId)) { ws.close(4009, 'duplicate'); return; }
    peers.set(peerId, { ws, startedAt: peerStartedAt });
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    console.log(`[mesh] conectado con ${peerId} (${peers.size} pares; líder: ${leader()})`);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.origin === id) return;          // mío: descartar (evita bucles)
      if (msg.origin !== peerId) return;      // solo directo del origen (nadie retransmite)
      onMessage(msg, peerId);
    });
    ws.on('close', () => {
      const cur = peers.get(peerId);
      if (!cur || cur.ws !== ws) return;
      peers.delete(peerId);
      console.log(`[mesh] se fue ${peerId} (${peers.size} pares; líder: ${leader()})`);
      onPeerDown(peerId);
    });
    onPeerUp(peerId);
  }

  // Lado que recibe: espera el hello; contesta con el suyo.
  // Acepta conexiones tanto en PEER_PORT (local/LAN) como en el mismo PORT del
  // coordinador (handleUpgrade, útil cuando se expone un único túnel ngrok).
  function onIncoming(ws) {
    ws.on('error', () => {});
    const timer = setTimeout(() => ws.close(4008, 'hello timeout'), HELLO_TIMEOUT_MS);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { msg = null; }
      const ok = checkHello(msg);
      if (!ok) { ws.close(4003, 'bad hello'); return; }
      // Ya hay conexión con ese par (llegó una de cada lado a la vez): se cierra la nueva
      if (peers.has(ok.peerId)) { ws.close(4009, 'duplicate'); return; }
      ws.send(hello());
      register(ok.peerId, ok.startedAt, ws);
    });
  }
  // peerPort null = mesh por el mismo puerto que los jugadores (PEER_PORT =
  // PORT): no se abre un puerto aparte; solo entra por handleUpgrade.
  const server = peerPort ? new WebSocketServer({ port: peerPort, maxPayload: MAX_PEER_MESSAGE_BYTES }) : null;
  if (server) {
    server.on('connection', onIncoming);
    server.on('error', (err) => console.error(`[mesh] no se pudo escuchar en ${peerPort}: ${err.message}`));
  }
  const upgradeServer = new WebSocketServer({ noServer: true, maxPayload: MAX_PEER_MESSAGE_BYTES });
  function handleUpgrade(req, socket, head) {
    upgradeServer.handleUpgrade(req, socket, head, onIncoming);
  }

  // Lado que inicia: manda su hello y espera el del otro
  function connectTo(peer) {
    if (connecting.has(peer.coordinatorId) || peers.has(peer.coordinatorId)) return;
    connecting.add(peer.coordinatorId);
    const ws = new WebSocket(peer.peerUrl, {
      maxPayload: MAX_PEER_MESSAGE_BYTES,
      handshakeTimeout: HELLO_TIMEOUT_MS,
      headers: { 'ngrok-skip-browser-warning': 'true' },
    });
    const done = () => connecting.delete(peer.coordinatorId);
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
        const ok = checkHello(msg);
        if (!ok || ok.peerId !== peer.coordinatorId) { ws.close(4003, 'bad hello'); return; }
        register(ok.peerId, ok.startedAt, ws);
      });
    });
  }

  // Heartbeat al directorio + descubrimiento de pares
  async function directoryCycle() {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}`, 'ngrok-skip-browser-warning': 'true' };
    try {
      const hb = await fetch(`${authUrl}/heartbeat`, {
        method: 'POST', headers, signal: AbortSignal.timeout(4500),
        body: JSON.stringify({
          coordinatorId: id, publicUrl, peerUrl,
          connectedPlayers: getConnectedPlayers(),
          uptime: Math.round((Date.now() - startedAt) / 1000),
        }),
      });
      if (!hb.ok) {
        let detail = '';
        try { detail = (await hb.json()).error || ''; } catch (_) {}
        throw new Error(`heartbeat HTTP ${hb.status}${detail ? `: ${detail}` : ''}`);
      }
      const res = await fetch(`${authUrl}/peers`, { headers, signal: AbortSignal.timeout(4500) });
      if (!res.ok) throw new Error(`peers HTTP ${res.status}`);
      const body = await res.json();
      if (directoryOk === false) console.log('[mesh] el directorio responde de nuevo');
      directoryOk = true;
      for (const peer of Array.isArray(body.peers) ? body.peers : []) {
        if (!peer || typeof peer.coordinatorId !== 'string' || typeof peer.peerUrl !== 'string') continue;
        if (peer.coordinatorId === id) continue;          // me filtro a mí mismo
        if (peer.coordinatorId > id) connectTo(peer);     // solo inicia el de id menor
      }
    } catch (err) {
      if (directoryOk !== false) console.error(`[mesh] directorio ${authUrl} no disponible (${err.message}); reintentando cada ${HEARTBEAT_MS / 1000} s`);
      directoryOk = false;
    }
  }
  directoryCycle();
  const dirTimer = setInterval(directoryCycle, HEARTBEAT_MS);

  // Ping entre pares: si un coordinador se cuelga sin cerrar el socket (red
  // caída), se lo da por muerto en ~2 ciclos
  const pingTimer = setInterval(() => {
    for (const { ws } of peers.values()) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, PEER_PING_MS);

  function leader() {
    let best = { id, startedAt };
    for (const [peerId, p] of peers) {
      if (p.startedAt < best.startedAt || (p.startedAt === best.startedAt && peerId < best.id)) best = { id: peerId, startedAt: p.startedAt };
    }
    return best.id;
  }

  function send(obj) {
    const data = JSON.stringify({ ...obj, origin: id });
    for (const { ws } of peers.values()) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  function sendTo(peerId, obj) {
    const p = peers.get(peerId);
    if (p && p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify({ ...obj, origin: id }));
  }

  function close() {
    clearInterval(dirTimer);
    clearInterval(pingTimer);
    for (const { ws } of peers.values()) ws.terminate();
    if (server) server.close();
    upgradeServer.close();
  }

  return {
    send, sendTo, close, handleUpgrade,
    isLeader: () => leader() === id,
    leader,
    peerIds: () => Array.from(peers.keys()),
  };
}

module.exports = { createMesh };
