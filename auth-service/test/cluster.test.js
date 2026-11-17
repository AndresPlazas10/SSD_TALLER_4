// Test de integración de la replicación (Taller 7): levanta TRES auth-service
// reales en procesos separados y recorre la sustentación: un solo líder, alta
// replicada en los tres, escrituras rechazadas en réplicas, caída del líder y
// elección, alta con el líder nuevo y vuelta del caído (se sincroniza y queda
// como réplica). Tiempos acortados: heartbeat 300 ms, elección a los 1,2 s.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const HEARTBEAT_MS = 300;
const ELECTION_MS = 1200;
const IDS = ['auth-a', 'auth-b', 'auth-c'];
const nodes = {}; // id -> { port, peerPort, db, url, proc, out }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

function start(id) {
  const n = nodes[id];
  const peers = IDS.map((x) => `${x}=ws://127.0.0.1:${nodes[x].peerPort}`).join(',');
  const child = spawn(process.execPath, ['index.js', '--id', id, '--port', String(n.port), '--peer-port', String(n.peerPort),
    '--db', n.db, '--peers', peers], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, JWT_SECRET, GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com', JWT_EXPIRES_IN: '1h',
      BCRYPT_ROUNDS: '10', PUBLIC_URL: `http://127.0.0.1:${n.port}`, PEER_URL: '', AUTH_PEERS: '', AUTH_ID: '', PEER_PORT: '',
      AUTH_HEARTBEAT_MS: String(HEARTBEAT_MS), AUTH_ELECTION_TIMEOUT_MS: String(ELECTION_MS) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  n.proc = child;
  n.out = '';
  child.stdout.on('data', (d) => { n.out += d; });
  child.stderr.on('data', (d) => { n.out += d; });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${id} no arrancó:\n${n.out}`)), 10000);
    child.stdout.on('data', () => { if (/Auth service en puerto/.test(n.out)) { clearTimeout(t); resolve(child); } });
  });
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null;
async function stop(id) {
  const child = nodes[id].proc;
  if (!child || exited(child)) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill();
  await done;
}

async function waitFor(fn, ms = 8000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    // Cada intento con su propio límite: un fetch colgado no traba la espera
    const v = await Promise.race([fn().catch(() => null), sleep(3000).then(() => null)]);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout esperando condición');
    await sleep(step);
  }
}

const getJson = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); return { status: r.status, data: await r.json(), headers: r.headers }; };
const postJson = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: r.status, data: await r.json() };
};
const status = (id) => getJson(`${nodes[id].url}/status`).then((r) => r.data);
const alive = () => IDS.filter((id) => nodes[id].proc && !exited(nodes[id].proc));

// Un único líder que todos los vivos reconocen
async function waitForLeader(ids = alive(), ms = 8000) {
  return waitFor(async () => {
    const ss = await Promise.all(ids.map(status));
    const leaders = ss.filter((s) => s.role === 'leader');
    if (leaders.length !== 1) return null;
    const l = leaders[0];
    return ss.every((s) => s.leaderUrl === l.publicUrl) ? l.authId : null;
  }, ms);
}

// Todos los vivos con el mismo número de usuarios y el mismo seq
async function waitForConvergence(users, ids = alive(), ms = 6000) {
  return waitFor(async () => {
    const ss = await Promise.all(ids.map(status));
    return ss.every((s) => s.users === users && s.lastAppliedSeq === ss[0].lastAppliedSeq) ? ss : null;
  }, ms);
}

let leader;

before(async () => {
  for (const id of IDS) {
    nodes[id] = { port: await freePort(), peerPort: await freePort(), db: path.join(os.tmpdir(), `cluster-${id}-${process.pid}.db`) };
    nodes[id].url = `http://127.0.0.1:${nodes[id].port}`;
    fs.rmSync(nodes[id].db, { force: true });
  }
  // auth-a arranca con usuarios de talleres anteriores (BD con el esquema del Taller 1)
  const old = new DatabaseSync(nodes['auth-a'].db);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO users (username, password_hash) VALUES ('viejo1', '$2b$10$abcdefghijklmnopqrstuv'), ('viejo2', '$2b$10$abcdefghijklmnopqrstuv');`);
  old.close();
  await Promise.all(IDS.map(start));
});

after(async () => {
  if (process.env.CLUSTER_DEBUG) for (const id of IDS) console.log(`----- ${id}
${nodes[id].out}`);
  for (const id of IDS) await stop(id);
  for (const id of IDS) {
    for (const f of fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith(path.basename(nodes[id].db)))) {
      fs.rmSync(path.join(os.tmpdir(), f), { force: true });
    }
  }
});

test('1. los tres arrancan, eligen UN líder (el que trae los usuarios existentes) y las réplicas copian su BD', { timeout: 90000 }, async () => {
  leader = await waitForLeader();
  assert.strictEqual(leader, 'auth-a', 'gana el que tiene el log más nuevo');
  const ss = await waitForConvergence(2);
  for (const s of ss) {
    assert.deepStrictEqual(Object.keys(s).filter((k) => ['authId', 'role', 'publicUrl', 'peerUrl', 'leaderUrl', 'knownPeers', 'lastAppliedSeq', 'users'].includes(k)).length, 8);
    assert.strictEqual(s.leaderUrl, nodes[leader].url);
  }
  assert.deepStrictEqual(ss.map((s) => s.role).sort(), ['leader', 'replica', 'replica']);
  // GET /peers: los otros dos auth, con su rol (una vez conectados todos con todos)
  const { data } = await waitFor(async () => {
    const r = await getJson(`${nodes['auth-b'].url}/peers`);
    return r.data.peers.every((p) => p.connected) ? r : null;
  });
  assert.deepStrictEqual(data.peers.map((p) => [p.authId, p.role]).sort(), [['auth-a', 'leader'], ['auth-c', 'replica']]);
  assert.ok(data.peers.every((p) => p.peerUrl && p.publicUrl));
});

test('2. alta de alice en el líder: 201 recién cuando una réplica la tiene; queda en los tres con el mismo userId', { timeout: 90000 }, async () => {
  const before = await status(leader);
  const r = await postJson(`${nodes[leader].url}/register`, { username: 'alice', password: 'secreta1' });
  assert.strictEqual(r.status, 201);
  // Opción B: al responder 201, al menos una réplica ya la aplicó
  const replicas = IDS.filter((id) => id !== leader);
  const now = await Promise.all(replicas.map(status));
  assert.ok(now.some((s) => s.users === before.users + 1), 'al menos una réplica la tiene al recibir el 201');
  await waitForConvergence(before.users + 1);
  // Login en una réplica (lectura): mismo userId que en el líder
  for (const id of IDS) {
    const l = await postJson(`${nodes[id].url}/login`, { username: 'alice', password: 'secreta1' });
    assert.strictEqual(l.status, 200, `login en ${id}`);
    const payload = JSON.parse(Buffer.from(l.data.token.split('.')[1], 'base64url'));
    assert.strictEqual(payload.userId, r.data.userId);
  }
});

test('3. una réplica rechaza escrituras con 503 not_leader + leaderUrl; con el username repetido el líder da 409', { timeout: 90000 }, async () => {
  const replica = IDS.find((id) => id !== leader);
  const r = await postJson(`${nodes[replica].url}/register`, { username: 'carol', password: 'secreta1' });
  assert.deepStrictEqual([r.status, r.data], [503, { error: 'not_leader', leaderUrl: nodes[leader].url }]);
  const h = await getJson(`${nodes[replica].url}/health`);
  assert.strictEqual(h.headers.get('x-auth-role'), 'replica');
  assert.strictEqual(h.headers.get('x-auth-id'), replica);
  assert.strictEqual((await postJson(`${nodes[leader].url}/register`, { username: 'ALICE', password: 'secreta1' })).status, 409);
});

test('4. cae el líder: las réplicas eligen uno nuevo y bob se registra con él', { timeout: 90000 }, async () => {
  const old = leader;
  const users = (await status(old)).users;
  const t0 = Date.now();
  await stop(old);
  // Mientras no hay líder, una escritura en una réplica no se acepta
  const survivor = IDS.find((id) => id !== old);
  const during = await postJson(`${nodes[survivor].url}/register`, { username: 'temprano', password: 'secreta1' });
  assert.strictEqual(during.status, 503);
  leader = await waitForLeader(alive(), ELECTION_MS * 6);
  assert.notStrictEqual(leader, old);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < ELECTION_MS * 4, `nuevo líder en ${elapsed} ms`);
  const st = await status(leader);
  assert.ok(st.term >= 2, 'el term subió');
  // Ningún usuario se perdió y bob entra con el líder nuevo
  assert.strictEqual(st.users, users);
  const r = await postJson(`${nodes[leader].url}/register`, { username: 'bob', password: 'secreta1', vehicle: 'uber' });
  assert.strictEqual(r.status, 201);
  await waitForConvergence(users + 1);
  // La réplica que queda ahora redirige al líder nuevo
  const replica = alive().find((id) => id !== leader);
  const w = await postJson(`${nodes[replica].url}/register`, { username: 'dave', password: 'secreta1' });
  assert.deepStrictEqual(w.data, { error: 'not_leader', leaderUrl: nodes[leader].url });
});

test('5. vuelve el auth caído: se sincroniza (tiene a bob) y queda como réplica del líder nuevo', { timeout: 90000 }, async () => {
  const back = IDS.find((id) => !alive().includes(id));
  const users = (await status(leader)).users;
  await start(back);
  const ss = await waitForConvergence(users, IDS);
  const s = ss.find((x) => x.authId === back);
  assert.strictEqual(s.role, 'replica');
  assert.strictEqual(s.leaderUrl, nodes[leader].url);
  assert.strictEqual(await waitForLeader(IDS), leader, 'el que vuelve no le quita el liderazgo a nadie');
  const l = await postJson(`${nodes[back].url}/login`, { username: 'bob', password: 'secreta1' });
  assert.strictEqual(l.status, 200);
  assert.strictEqual(l.data.vehicle, 'uber');
});

test('6. un líder sin mayoría no confirma escrituras (no_quorum) y una réplica sola no tiene líder (no_leader)', { timeout: 90000 }, async () => {
  const replicas = IDS.filter((id) => id !== leader);
  await stop(replicas[0]);
  await stop(replicas[1]);
  await waitFor(async () => (await status(leader)).knownPeers.every((p) => !p.connected), 4000);
  const r = await postJson(`${nodes[leader].url}/register`, { username: 'erin', password: 'secreta1' });
  assert.deepStrictEqual([r.status, r.data.error], [503, 'no_quorum']);
  // Vuelve una réplica: hay mayoría otra vez y se puede escribir
  await start(replicas[0]);
  await waitFor(async () => (await postJson(`${nodes[leader].url}/register`, { username: 'erin', password: 'secreta1' })).status === 201, 6000, 300);
  // Sin el líder, la réplica que queda sola no puede elegirse (no hay mayoría)
  await stop(leader);
  await sleep(ELECTION_MS * 2);
  const s = await status(replicas[0]);
  assert.notStrictEqual(s.role, 'leader');
  const w = await postJson(`${nodes[replicas[0]].url}/register`, { username: 'frank', password: 'secreta1' });
  assert.deepStrictEqual([w.status, w.data.error], [503, 'no_leader']);
  const l = await postJson(`${nodes[replicas[0]].url}/login`, { username: 'erin', password: 'secreta1' });
  assert.deepStrictEqual([l.status, l.data.error], [503, 'no_leader']);
});
