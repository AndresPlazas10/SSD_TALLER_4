// Test de integración del Taller 7 desde el lado de los coordinadores: TRES
// auth replicados y DOS coordinadores con AUTH_URLS. Se cae el auth líder: los
// coordinadores siguen en el directorio (se pasan al líder nuevo), el
// directorio sigue respondiendo y un jugador conectado sigue jugando sin corte.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
// Persistencia del examen final: en memoria, así un test no hereda el estado
// guardado por otro (ni por el coordinador de desarrollo)
process.env.STATE_DB = ':memory:';

Object.assign(process.env, { PUBLIC_URL: '', PEER_URL: '', PUBLIC_HOST: '', COORDINATOR_ID: '', PEER_PORT: '', AUTH_URL: '', AUTH_URLS: '' });
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const AUTH_IDS = ['auth-a', 'auth-b', 'auth-c'];
const auths = {};
const coords = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const exited = (child) => child.exitCode !== null || child.signalCode !== null;
async function stopProc(child) {
  if (!child || exited(child)) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill();
  await done;
}
function startProc(args, cwd, env, ready) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.out = '';
  child.stdout.on('data', (d) => { child.out += d; });
  child.stderr.on('data', (d) => { child.out += d; });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no arrancó: ${args.join(' ')}\n${child.out}`)), 10000);
    child.stdout.on('data', () => { if (ready.test(child.out)) { clearTimeout(t); resolve(child); } });
  });
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
const getJson = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); return { status: r.status, data: await r.json() }; };
const status = (id) => getJson(`${auths[id].url}/status`).then((r) => r.data);
const aliveAuths = () => AUTH_IDS.filter((id) => !exited(auths[id].proc));
async function leaderId() {
  const ss = await Promise.all(aliveAuths().map(status));
  const ls = ss.filter((s) => s.role === 'leader');
  return ls.length === 1 && ss.every((s) => s.leaderUrl === ls[0].publicUrl) ? ls[0].authId : null;
}

before(async () => {
  for (const id of AUTH_IDS) {
    auths[id] = { port: await freePort(), peerPort: await freePort(), db: path.join(os.tmpdir(), `authfo-${id}-${process.pid}.db`) };
    auths[id].url = `http://127.0.0.1:${auths[id].port}`;
  }
  const peers = AUTH_IDS.map((x) => `${x}=ws://127.0.0.1:${auths[x].peerPort}`).join(',');
  const authDir = path.join(__dirname, '..', '..', 'auth-service');
  await Promise.all(AUTH_IDS.map(async (id) => {
    const a = auths[id];
    a.proc = await startProc(['index.js', '--id', id, '--port', String(a.port), '--peer-port', String(a.peerPort), '--db', a.db, '--peers', peers],
      authDir, {
        JWT_SECRET, GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com', JWT_EXPIRES_IN: '1h', PUBLIC_URL: a.url, AUTH_PEERS: '', AUTH_ID: '',
        AUTH_HEARTBEAT_MS: '300', AUTH_ELECTION_TIMEOUT_MS: '1200', DIRECTORY_TTL_MS: '4500',
      }, /Auth service en puerto/);
  }));
  await waitFor(leaderId);
  const AUTH_URLS = AUTH_IDS.map((id) => auths[id].url).join(',');
  for (const id of ['coord-a', 'coord-b']) {
    const port = await freePort();
    coords[id] = { port, url: `ws://127.0.0.1:${port}` };
    coords[id].proc = await startProc(['index.js', '--id', id, '--port', String(port), '--peer-port', String(await freePort())],
      path.join(__dirname, '..'), {
        JWT_SECRET, AUTH_URLS, PUBLIC_HOST: '127.0.0.1', SESSION_MAX_AGE: '', OBSTACLES: 'off',
        WORLD_WIDTH: '400', WORLD_HEIGHT: '300', MATCH_SECONDS: '600', TOKEN_POLICY_POLL_MS: '60000',
      }, /Coordinador en puerto/);
  }
});

after(async () => {
  for (const c of Object.values(coords)) await stopProc(c.proc);
  for (const a of Object.values(auths)) await stopProc(a.proc);
  for (const a of Object.values(auths)) {
    for (const f of fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith(path.basename(a.db)))) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  }
});

const listed = async (id) => {
  const r = await getJson(`${auths[id].url}/coordinators`);
  return r.data.coordinators.map((c) => c.coordinatorId).sort();
};

test('los coordinadores se anuncian al líder y los tres auth los conocen', { timeout: 90000 }, async () => {
  for (const id of AUTH_IDS) {
    assert.deepStrictEqual(await waitFor(async () => { const l = await listed(id); return l.length === 2 ? l : null; }), ['coord-a', 'coord-b']);
  }
});

test('cae el auth líder: el jugador sigue jugando, el directorio no pierde coordinadores y sigue respondiendo', { timeout: 90000 }, async () => {
  const token = jwt.sign({ userId: 7, username: 'alice', provider: 'local', vehicle: 'taxi' }, JWT_SECRET, { expiresIn: '1h' });
  const ws = new WebSocket(`${coords['coord-a'].url}/connect?token=${encodeURIComponent(token)}`);
  let closed = null;
  let states = 0;
  ws.on('close', (code) => { closed = code; });
  ws.on('message', (d) => { if (JSON.parse(d).type === 'state') states++; });
  await waitFor(async () => states > 0);

  const old = await leaderId();
  await stopProc(auths[old].proc);
  // Durante la elección y después: /coordinator responde en los auth vivos
  const t0 = Date.now();
  let failures = 0;
  while (Date.now() - t0 < 5000) {
    for (const id of aliveAuths()) {
      const r = await getJson(`${auths[id].url}/coordinator`);
      if (r.status !== 200) failures++;
    }
    await sleep(200);
  }
  assert.strictEqual(failures, 0, 'GET /coordinator nunca devolvió error');
  const now = await waitFor(leaderId);
  assert.notStrictEqual(now, old);
  for (const id of aliveAuths()) assert.deepStrictEqual(await listed(id), ['coord-a', 'coord-b']);
  // Los coordinadores ya mandan su heartbeat al líder nuevo
  // (el líder no recibe copias del directorio: si sus entradas están frescas es
  // porque los heartbeats le llegan directo)
  await waitFor(async () => {
    const r = await getJson(`${auths[now].url}/coordinators`);
    return r.data.coordinators.length === 2 && r.data.coordinators.every((c) => c.lastSeenMsAgo < 2100);
  }, 6000, 300);
  // El jugador nunca se desconectó y siguió recibiendo estados
  const before = states;
  await sleep(500);
  assert.strictEqual(closed, null);
  assert.ok(states > before);
  ws.close();
});
