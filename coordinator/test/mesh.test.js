// Test de integración del mesh (Taller 6): levanta el auth-service REAL (como
// directorio) y TRES coordinadores reales, y recorre la sustentación:
// /peers, reparto de clientes, replicación entre coordinadores, sesión movida
// de coordinador y caída de un coordinador.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

// Los coordinadores de prueba no deben heredar la configuración de despliegue
// del .env de desarrollo (URLs de ngrok, id, puertos del mesh): vacías = valores
// por defecto (dotenv no pisa variables que ya existen, aunque estén vacías)
Object.assign(process.env, { PUBLIC_URL: '', PEER_URL: '', PUBLIC_HOST: '', COORDINATOR_ID: '', PEER_PORT: '' });
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const BASE = 7000 + Math.floor(Math.random() * 400) * 4;
const AUTH_PORT = BASE;
const TTL = 4500; // el directorio descarta a quien lleve 4,5 s sin heartbeat (heartbeat cada 2 s)
const AUTH = `http://127.0.0.1:${AUTH_PORT}`;
const DB_FILE = path.join(os.tmpdir(), `mesh-auth-${process.pid}.db`);
const COORDS = { 'coord-a': BASE + 1, 'coord-b': BASE + 2, 'coord-c': BASE + 3 };
const procs = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sign = (userId, username, vehicle = 'taxi') => jwt.sign({ userId, username, provider: 'local', vehicle }, JWT_SECRET, { expiresIn: '1h' });
const coordToken = () => jwt.sign({ role: 'coordinator', coordinatorId: 'test' }, JWT_SECRET, { expiresIn: '1m' });

function startProc(args, cwd, env, ready) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no arrancó: ${args.join(' ')}`)), 10000);
    child.stdout.on('data', (d) => { if (ready.test(d)) { clearTimeout(t); resolve(child); } });
  });
}

function startCoordinator(id) {
  const port = COORDS[id];
  return startProc(['index.js', '--id', id, '--port', String(port), '--peer-port', String(port + 2000)],
    path.join(__dirname, '..'), {
      JWT_SECRET, AUTH_URL: AUTH, PUBLIC_HOST: '127.0.0.1', SESSION_MAX_AGE: '', OBSTACLES: 'off',
      WORLD_WIDTH: '400', WORLD_HEIGHT: '300', MATCH_SECONDS: '600', TOKEN_POLICY_POLL_MS: '60000',
    }, /Coordinador en puerto/);
}

// Terminado = salió solo (exitCode) o por kill (signalCode; en ese caso
// exitCode queda en null)
const exited = (child) => child.exitCode !== null || child.signalCode !== null;
async function stopProc(child) {
  if (!child || exited(child)) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill();
  await done;
}

async function waitFor(fn, ms = 8000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout esperando condición');
    await sleep(step);
  }
}

const getJson = async (url, opts) => { const r = await fetch(url, opts); return { status: r.status, data: await r.json() }; };

function client(url, token) {
  const ws = new WebSocket(`${url}/connect?token=${encodeURIComponent(token)}`);
  ws.msgs = [];
  ws.closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  ws.on('message', (d) => ws.msgs.push(JSON.parse(d.toString())));
  ws.on('error', () => {});
  ws.waitFor = (pred, ms = 4000) => waitFor(() => ws.msgs.find(pred), ms, 20);
  ws.last = (type) => [...ws.msgs].reverse().find((m) => m.type === type);
  ws.sendJson = (o) => ws.send(JSON.stringify(o));
  return ws;
}
const find = (state, userId) => state && state.players.find((p) => p.userId === String(userId));

before(async () => {
  procs.auth = await startProc([path.join(__dirname, '..', '..', 'auth-service', 'index.js')], path.join(__dirname, '..', '..', 'auth-service'), {
    PORT: String(AUTH_PORT), JWT_SECRET, DB_FILE, GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
    JWT_EXPIRES_IN: '1h', DIRECTORY_TTL_MS: String(TTL),
  }, /Auth service en puerto/);
  for (const id of Object.keys(COORDS)) procs[id] = await startCoordinator(id);
});
after(async () => {
  for (const p of Object.values(procs)) await stopProc(p);
  fs.rmSync(DB_FILE, { force: true });
});

test('1. los tres coordinadores aparecen en /peers y forman un mesh completo', async () => {
  const ids = await waitFor(async () => {
    const r = await getJson(`${AUTH}/peers`, { headers: { Authorization: `Bearer ${coordToken()}` } });
    const list = r.data.peers.map((p) => p.coordinatorId).sort();
    return list.length === 3 ? list : null;
  });
  assert.deepStrictEqual(ids, ['coord-a', 'coord-b', 'coord-c']);
  // Cada uno está conectado a los otros dos (una sola conexión por par) y todos
  // eligen al mismo líder
  const healths = await waitFor(async () => {
    const hs = await Promise.all(Object.values(COORDS).map((port) => getJson(`http://127.0.0.1:${port}/health`)));
    return hs.every((h) => h.data.peers.length === 2) ? hs : null;
  });
  assert.strictEqual(new Set(healths.map((h) => h.data.leader)).size, 1);
});

test('2. el auth reparte 4 clientes entre los tres (no van todos al mismo)', async () => {
  const assigned = [];
  const clients = [];
  for (let i = 0; i < 4; i++) {
    const { data } = await getJson(`${AUTH}/coordinator`);
    assigned.push(data.coordinatorId);
    const ws = client(data.publicUrl, sign(100 + i, `jugador${i}`));
    clients.push(ws);
    const w = await ws.waitFor((m) => m.type === 'welcome');
    assert.strictEqual(w.coordinator.id, data.coordinatorId, 'conectado al coordinador que dijo el auth');
  }
  assert.ok(new Set(assigned).size >= 2, `asignaciones: ${assigned}`);
  assert.ok(Object.values(assigned.reduce((c, id) => ({ ...c, [id]: (c[id] || 0) + 1 }), {})).every((n) => n <= 2), `asignaciones: ${assigned}`);
  for (const ws of clients) { ws.close(); await ws.closed; }
});

test('3. Alice en coord-a y Bob en coord-b se ven moverse en vivo (y los extras se replican)', async () => {
  const alice = client(`ws://127.0.0.1:${COORDS['coord-a']}`, sign(1, 'alice'));
  const bob = client(`ws://127.0.0.1:${COORDS['coord-b']}`, sign(2, 'bob', 'uber'));
  assert.strictEqual((await alice.waitFor((m) => m.type === 'welcome')).coordinator.id, 'coord-a');
  assert.strictEqual((await bob.waitFor((m) => m.type === 'welcome')).coordinator.id, 'coord-b');
  // Cada uno ve al otro en el state de SU coordinador
  await bob.waitFor((m) => m.type === 'state' && find(m, 1));
  await alice.waitFor((m) => m.type === 'state' && find(m, 2));

  // Alice se mueve: Bob la ve moverse
  const aliceAtBob0 = find(bob.last('state'), 1);
  alice.sendJson({ type: 'intent', intent: { dir: { x: aliceAtBob0.x < 200 ? 1 : -1, y: 0 } } });
  await sleep(600);
  alice.sendJson({ type: 'intent', intent: { dir: { x: 0, y: 0 } } });
  await sleep(300);
  const aliceAtBob1 = find(bob.last('state'), 1);
  const aliceAtAlice = find(alice.last('state'), 1);
  assert.ok(Math.abs(aliceAtBob1.x - aliceAtBob0.x) > 60, `Bob vio a Alice moverse de ${aliceAtBob0.x} a ${aliceAtBob1.x}`);
  assert.ok(Math.abs(aliceAtBob1.x - aliceAtAlice.x) < 1 && Math.abs(aliceAtBob1.y - aliceAtAlice.y) < 1,
    `misma posición en los dos coordinadores (${aliceAtBob1.x},${aliceAtBob1.y} vs ${aliceAtAlice.x},${aliceAtAlice.y})`);

  // Bob se mueve: Alice lo ve moverse
  const bobAtAlice0 = find(alice.last('state'), 2);
  bob.sendJson({ type: 'intent', intent: { dir: { x: 0, y: bobAtAlice0.y < 150 ? 1 : -1 } } });
  await sleep(500);
  bob.sendJson({ type: 'intent', intent: { dir: { x: 0, y: 0 } } });
  await sleep(300);
  assert.ok(Math.abs(find(alice.last('state'), 2).y - bobAtAlice0.y) > 50, 'Alice vio a Bob moverse');

  // Extras (mood) de Bob replicados a coord-a
  bob.sendJson({ type: 'extras_update', extras: { mood: '😎', color: '#2ee6a6' } });
  await alice.waitFor((m) => m.type === 'state' && find(m, 2) && find(m, 2).extras.mood === '😎');
  // El mundo (pasajero y ronda) es el mismo en los dos
  await sleep(700);
  const sa = alice.last('state'), sb = bob.last('state');
  assert.deepStrictEqual(sa.passenger, sb.passenger);
  assert.strictEqual(sa.match.round, sb.match.round);
  alice.close(); bob.close();
  await Promise.all([alice.closed, bob.closed]);
});

test('4. la misma cuenta abierta en otro coordinador cierra la sesión anterior (4002) y conserva la posición', async () => {
  const first = client(`ws://127.0.0.1:${COORDS['coord-a']}`, sign(5, 'eve'));
  const watcher = client(`ws://127.0.0.1:${COORDS['coord-b']}`, sign(6, 'walt'));
  await first.waitFor((m) => m.type === 'state' && find(m, 5));
  const pos = await watcher.waitFor((m) => m.type === 'state' && find(m, 5)).then((m) => find(m, 5));
  const second = client(`ws://127.0.0.1:${COORDS['coord-c']}`, sign(5, 'eve'));
  assert.strictEqual((await first.closed).code, 4002);
  const s = await second.waitFor((m) => m.type === 'state' && find(m, 5));
  assert.ok(Math.abs(find(s, 5).x - pos.x) < 1 && Math.abs(find(s, 5).y - pos.y) < 1, 'la sesión nueva sigue donde estaba');
  await sleep(400);
  assert.strictEqual(watcher.last('state').players.filter((p) => p.userId === '5').length, 1, 'un solo eve en el mundo');
  second.close(); watcher.close();
  await Promise.all([second.closed, watcher.closed]);
});

test('5. cae coord-b: sus clientes se desconectan, el auth deja de devolverlo y se reconectan a los vivos', async () => {
  const alice = client(`ws://127.0.0.1:${COORDS['coord-a']}`, sign(1, 'alice'));
  const bob = client(`ws://127.0.0.1:${COORDS['coord-b']}`, sign(2, 'bob', 'uber'));
  await alice.waitFor((m) => m.type === 'state' && find(m, 2));

  // "Ctrl+C" a coord-b
  await stopProc(procs['coord-b']);
  const closed = await bob.closed;
  assert.notStrictEqual(closed.code, 4001); // se cortó la conexión, no fue un rechazo de token
  // Alice deja de ver a Bob (coord-a se enteró de la caída por el mesh)
  await alice.waitFor((m) => m.type === 'state' && !find(m, 2), 5000);

  // Pasado el TTL sin heartbeat, el auth ya no devuelve a coord-b
  await sleep(TTL + 500);
  for (let i = 0; i < 6; i++) {
    const { status, data } = await getJson(`${AUTH}/coordinator`);
    assert.strictEqual(status, 200);
    assert.notStrictEqual(data.coordinatorId, 'coord-b');
  }
  const peers = (await getJson(`${AUTH}/peers`, { headers: { Authorization: `Bearer ${coordToken()}` } })).data.peers;
  assert.deepStrictEqual(peers.map((p) => p.coordinatorId).sort(), ['coord-a', 'coord-c']);

  // Bob pide coordinador de nuevo y se reconecta a uno vivo; Alice lo vuelve a ver
  const { data } = await getJson(`${AUTH}/coordinator`);
  const bob2 = client(data.publicUrl, sign(2, 'bob', 'uber'));
  const w = await bob2.waitFor((m) => m.type === 'welcome');
  assert.ok(['coord-a', 'coord-c'].includes(w.coordinator.id));
  await alice.waitFor((m) => m.type === 'state' && find(m, 2), 5000);
  alice.close(); bob2.close();
  await Promise.all([alice.closed, bob2.closed]);
});

test('6. coordinador con el mesh por el MISMO puerto (/mesh, como con un solo túnel de ngrok) se une al mesh', async () => {
  const port = BASE + 3 + 1; // libre: el de coord-c + 1
  procs['coord-d'] = await startProc(['index.js', '--id', 'coord-d', '--port', String(port), '--peer-port', String(port)],
    path.join(__dirname, '..'), {
      JWT_SECRET, AUTH_URL: AUTH, PUBLIC_HOST: '127.0.0.1', SESSION_MAX_AGE: '', OBSTACLES: 'off',
      WORLD_WIDTH: '400', WORLD_HEIGHT: '300', MATCH_SECONDS: '600', TOKEN_POLICY_POLL_MS: '60000',
    }, /Coordinador en puerto/);
  const peers = await waitFor(async () => {
    const h = await getJson(`http://127.0.0.1:${port}/health`);
    return h.data.peers.length === 2 ? h.data.peers.sort() : null;
  });
  assert.deepStrictEqual(peers, ['coord-a', 'coord-c']);
  const listed = (await getJson(`${AUTH}/peers`, { headers: { Authorization: `Bearer ${coordToken()}` } })).data.peers;
  assert.strictEqual(listed.find((p) => p.coordinatorId === 'coord-d').peerUrl, `ws://127.0.0.1:${port}`); // misma URL que los jugadores (el mesh entra por la raíz o /mesh)
  // Y replica: Dana en coord-d ve a Alice (coord-a) moverse
  const dana = client(`ws://127.0.0.1:${port}`, sign(7, 'dana'));
  const alice = client(`ws://127.0.0.1:${COORDS['coord-a']}`, sign(1, 'alice'));
  const a0 = await dana.waitFor((m) => m.type === 'state' && find(m, 1)).then((m) => find(m, 1));
  alice.sendJson({ type: 'intent', intent: { dir: { x: a0.x < 200 ? 1 : -1, y: 0 } } });
  await sleep(500);
  assert.ok(Math.abs(find(dana.last('state'), 1).x - a0.x) > 50, 'Dana vio a Alice moverse');
  dana.close(); alice.close();
  await Promise.all([dana.closed, alice.closed]);
});

test('7. un coordinador con PUBLIC_URL mal escrita no arranca y explica el error', async () => {
  const child = spawn(process.execPath, ['index.js', '--id', 'coord-x', '--port', String(BASE + 9)], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, JWT_SECRET, AUTH_URL: AUTH, PUBLIC_URL: 'wss://https://spindle-overstep-pelt.ngrok-free.dev' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((r) => child.once('exit', r));
  assert.strictEqual(code, 1);
  assert.match(stderr, /protocolo repetido/);
});

test('8. el mesh también acepta conexiones en la raíz del puerto de jugadores (peerUrl = solo el dominio del túnel)', async () => {
  // coord-a (puerto de jugadores) recibe un hello en "/" como si fuera un par
  const ws = new WebSocket(`ws://127.0.0.1:${COORDS['coord-a']}/`);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.send(JSON.stringify({ type: 'hello', coordinatorId: 'coord-z', startedAt: Date.now(), auth: jwt.sign({ role: 'coordinator', coordinatorId: 'coord-z' }, JWT_SECRET, { expiresIn: '1m' }) }));
  const reply = await new Promise((r) => ws.once('message', (d) => r(JSON.parse(d.toString()))));
  assert.strictEqual(reply.type, 'hello');
  assert.strictEqual(reply.coordinatorId, 'coord-a');
  ws.close();
});
