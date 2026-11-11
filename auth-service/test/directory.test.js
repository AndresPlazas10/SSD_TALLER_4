// Tests del directorio de coordinadores (POST /heartbeat, GET /coordinator,
// GET /peers). Corre en su propio proceso con un TTL corto (400 ms en vez de
// 6 s) para no esperar en los tests de "coordinador muerto".
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const DB_FILE = path.join(os.tmpdir(), `auth-directory-${process.pid}.db`);
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const TTL = 400;
Object.assign(process.env, {
  DB_FILE, JWT_SECRET, GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  JWT_EXPIRES_IN: '1h', DIRECTORY_TTL_MS: String(TTL),
});
const { app, db, coordinators } = require('../index.js');

let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  db.close();
  fs.rmSync(DB_FILE, { force: true });
});
beforeEach(() => coordinators.clear());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const coordToken = (coordinatorId, secret = JWT_SECRET) => jwt.sign({ role: 'coordinator', coordinatorId }, secret, { expiresIn: '1m' });

async function heartbeat(id, players = 0, overrides = {}, token = coordToken(id)) {
  const res = await fetch(`${base}/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      coordinatorId: id, publicUrl: `ws://localhost:${5000 + id.charCodeAt(id.length - 1) - 96}`,
      peerUrl: `ws://localhost:${5100 + id.charCodeAt(id.length - 1) - 96}`, connectedPlayers: players, uptime: 12, ...overrides,
    }),
  });
  return { status: res.status, data: await res.json() };
}
async function get(p, token) {
  const res = await fetch(base + p, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  return { status: res.status, data: await res.json() };
}

test('POST /heartbeat registra al coordinador -> 200 { ok: true }', async () => {
  const r = await heartbeat('coord-a', 7);
  assert.deepStrictEqual([r.status, r.data], [200, { ok: true }]);
  const c = coordinators.get('coord-a');
  assert.strictEqual(c.publicUrl, 'ws://localhost:5001');
  assert.strictEqual(c.peerUrl, 'ws://localhost:5101');
  assert.strictEqual(c.connectedPlayers, 7);
});

test('POST /heartbeat sin token de coordinador -> 401; token de otro coordinador -> 403', async () => {
  const res = await fetch(`${base}/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(res.status, 401);
  assert.strictEqual((await heartbeat('coord-a', 0, {}, coordToken('coord-a', 'otra-secret-de-32-caracteres-xxxxxxx'))).status, 401);
  // Un token de jugador (sin role: coordinator) tampoco sirve
  assert.strictEqual((await heartbeat('coord-a', 0, {}, jwt.sign({ userId: 1, username: 'alice' }, JWT_SECRET))).status, 401);
  assert.strictEqual((await heartbeat('coord-a', 0, {}, coordToken('coord-b'))).status, 403);
  assert.strictEqual(coordinators.size, 0);
});

test('POST /heartbeat valida el body -> 400', async () => {
  assert.strictEqual((await heartbeat('coord-a', 0, { publicUrl: 'http://x' })).status, 400);
  assert.strictEqual((await heartbeat('coord-a', 0, { peerUrl: 5101 })).status, 400);
  assert.strictEqual((await heartbeat('coord-a', -1)).status, 400);
  assert.strictEqual((await heartbeat('coord-a', 1.5)).status, 400);
  assert.strictEqual((await heartbeat('coord-a', 0, { uptime: 'mucho' })).status, 400);
  assert.strictEqual((await heartbeat('mal id!', 0, {}, coordToken('mal id!'))).status, 401);
  // Errores típicos de configuración con ngrok
  const dup = await heartbeat('coord-a', 0, { publicUrl: 'wss://https://spindle-overstep-pelt.ngrok-free.dev' });
  assert.strictEqual(dup.status, 400);
  assert.match(dup.data.error, /protocolo repetido/);
  const withPath = await heartbeat('coord-a', 0, { publicUrl: 'wss://x.ngrok-free.dev/task/capabilities' });
  assert.strictEqual(withPath.status, 400);
  assert.match(withPath.data.error, /no debe tener ruta/);
  // peerUrl sí puede tener ruta (mesh por el mismo puerto: /mesh)
  assert.strictEqual((await heartbeat('coord-a', 0, { publicUrl: 'wss://x.ngrok-free.dev', peerUrl: 'wss://x.ngrok-free.dev/mesh' })).status, 200);
});

test('GET /coordinator: el de menos connectedPlayers; en empate el primero', async () => {
  await heartbeat('coord-a', 5);
  await heartbeat('coord-b', 2);
  await heartbeat('coord-c', 2);
  const r = await get('/coordinator');
  assert.deepStrictEqual([r.status, r.data], [200, { coordinatorId: 'coord-b', publicUrl: 'ws://localhost:5002' }]);
});

test('GET /coordinator reparte clientes que llegan juntos (cuenta la asignación hasta el próximo heartbeat)', async () => {
  await heartbeat('coord-a', 0);
  await heartbeat('coord-b', 0);
  await heartbeat('coord-c', 0);
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await get('/coordinator')).data.coordinatorId);
  assert.deepStrictEqual(ids, ['coord-a', 'coord-b', 'coord-c', 'coord-a']);
  // El heartbeat trae la cifra real y reemplaza la estimación
  await heartbeat('coord-a', 0);
  assert.strictEqual((await get('/coordinator')).data.coordinatorId, 'coord-a');
});

test('GET /coordinator?exclude= evita ese coordinador', async () => {
  await heartbeat('coord-a', 0);
  await heartbeat('coord-b', 9);
  assert.strictEqual((await get('/coordinator?exclude=coord-a')).data.coordinatorId, 'coord-b');
});

test('GET /coordinator sin coordinadores vivos -> 503 no_coordinators_available', async () => {
  const r = await get('/coordinator');
  assert.deepStrictEqual([r.status, r.data], [503, { error: 'no_coordinators_available' }]);
});

test('un coordinador sin heartbeat por más del TTL se descarta (no se devuelve ni aparece en /peers)', async () => {
  await heartbeat('coord-a', 0);
  await heartbeat('coord-b', 3);
  await sleep(TTL / 2);
  await heartbeat('coord-b', 3); // b sigue vivo, a se calla
  await sleep(TTL / 2 + 100);
  assert.strictEqual((await get('/coordinator')).data.coordinatorId, 'coord-b');
  const peers = (await get('/peers', coordToken('coord-b'))).data.peers.map((p) => p.coordinatorId);
  assert.deepStrictEqual(peers, ['coord-b']);
  assert.ok(!coordinators.has('coord-a'));
});

test('GET /peers: lista los vivos con su peerUrl', async () => {
  await heartbeat('coord-a', 0);
  await heartbeat('coord-b', 0);
  await heartbeat('coord-c', 0);
  const r = await get('/peers');
  assert.deepStrictEqual(r.data, { peers: [
    { coordinatorId: 'coord-a', peerUrl: 'ws://localhost:5101' },
    { coordinatorId: 'coord-b', peerUrl: 'ws://localhost:5102' },
    { coordinatorId: 'coord-c', peerUrl: 'ws://localhost:5103' },
  ] });
});
