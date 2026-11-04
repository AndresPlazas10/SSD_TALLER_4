// Tests del coordinador: npm test (dentro de coordinator/).
// Levanta el coordinador real como proceso hijo y se conecta por WebSocket
// con JWTs firmados con la misma secret (como haría el auth service).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const PORT = 5600 + Math.floor(Math.random() * 300);
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const WORLD = { width: 400, height: 300, radius: 20, speed: 200, tick: 20 };
let child;

before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT), JWT_SECRET, HEARTBEAT_MS: '30000',
      WORLD_WIDTH: String(WORLD.width), WORLD_HEIGHT: String(WORLD.height),
      PLAYER_RADIUS: String(WORLD.radius), PLAYER_SPEED: String(WORLD.speed), TICK_RATE: String(WORLD.tick),
      JWT_CLOCK_TOLERANCE_S: '5', SESSION_MAX_AGE: '', OBSTACLES: 'off', AUTH_URL: '',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => child.stdout.on('data', (d) => { if (/Coordinador en puerto/.test(d)) resolve(); }));
});
after(() => child.kill());

const sign = (userId, username, opts = {}, provider = 'local', vehicle) =>
  jwt.sign({ userId, username, provider, ...(vehicle ? { vehicle } : {}) }, JWT_SECRET, { expiresIn: '1h', ...opts });

// Cliente de prueba: guarda todos los mensajes y permite esperar uno concreto
function connect(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/connect?token=${encodeURIComponent(token)}`);
  ws.msgs = [];
  ws.closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  ws.on('message', (d) => ws.msgs.push(JSON.parse(d.toString())));
  ws.waitFor = (pred, ms = 2000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      const m = ws.msgs.find(pred);
      if (m) return resolve(m);
      if (Date.now() - t0 > ms) return reject(new Error('timeout esperando mensaje'));
      setTimeout(poll, 10);
    })();
  });
  ws.send = ((orig) => (obj) => orig.call(ws, typeof obj === 'string' ? obj : JSON.stringify(obj)))(ws.send);
  return ws;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const me = (state, userId) => state.players.find((p) => p.userId === userId);
const lastState = (ws) => [...ws.msgs].reverse().find((m) => m.type === 'state');
async function freshState(ws) {
  const n = ws.msgs.length;
  return ws.waitFor((m) => m.type === 'state' && ws.msgs.indexOf(m) >= n);
}

test('token inválido / firmado con otra secret / vencido -> cierre 4001', async () => {
  assert.strictEqual((await connect('basura').closed).code, 4001);
  const other = jwt.sign({ userId: 9, username: 'x' }, 'otra-secret-'.repeat(4));
  assert.strictEqual((await connect(other).closed).code, 4001);
  const expired = sign(9, 'x', { expiresIn: -60 }); // vencido hace 60 s (> tolerancia de 5 s)
  assert.strictEqual((await connect(expired).closed).code, 4001);
});

test('welcome enriquecido con you y world', async () => {
  const ws = connect(sign(1, 'alice'));
  const w = await ws.waitFor((m) => m.type === 'welcome');
  assert.deepStrictEqual(w.you, { userId: '1', username: 'alice', provider: 'local', vehicle: 'taxi' });
  assert.deepStrictEqual(w.world, {
    width: 400, height: 300, playerRadius: 20, tickRate: 20, passengerRadius: 10, cell: 200, sidewalk: 8,
    obstacles: [], blocks: [],
  });
  ws.close();
  await ws.closed;
});

test('estado inicial: posición aleatoria dentro del mundo, intent 0, extras {}', async () => {
  const ws = connect(sign(2, 'bob'));
  const s = await ws.waitFor((m) => m.type === 'state');
  const p = me(s, '2');
  assert.ok(p.x >= 20 && p.x <= 380 && p.y >= 20 && p.y <= 280);
  assert.deepStrictEqual(p.extras, {});
  assert.strictEqual(p.intent, undefined, 'el intent no se publica');
  await sleep(300);
  const p2 = me(lastState(ws), '2');
  assert.deepStrictEqual([p2.x, p2.y], [p.x, p.y], 'sin intent no se mueve');
  ws.close();
  await ws.closed;
});

test('game loop a ~20 Hz: un state por tick', async () => {
  const ws = connect(sign(3, 'carol'));
  await ws.waitFor((m) => m.type === 'state');
  const n0 = ws.msgs.filter((m) => m.type === 'state').length;
  await sleep(1000);
  const n = ws.msgs.filter((m) => m.type === 'state').length - n0;
  assert.ok(n >= 18 && n <= 22, `states en 1 s: ${n}`);
  ws.close();
  await ws.closed;
});

test('intent {x:9999} se sanitiza: se mueve a PLAYER_SPEED, no se teletransporta', async () => {
  const ws = connect(sign(4, 'dave'));
  await ws.waitFor((m) => m.type === 'state');
  // Llevarlo al borde izquierdo y medir hacia la derecha
  ws.send({ type: 'intent', intent: { dir: { x: -1, y: 0 } } });
  await sleep(2000);
  ws.send({ type: 'intent', intent: { dir: { x: 0, y: 0 } } });
  await sleep(100);
  const a = me(await freshState(ws), '4');
  ws.send({ type: 'intent', intent: { dir: { x: 9999, y: 0 } } });
  assert.strictEqual(a.x, 20, 'clamp en el borde izquierdo = PLAYER_RADIUS');
  await sleep(1000);
  const b = me(await freshState(ws), '4');
  const dx = b.x - a.x;
  assert.ok(dx > 160 && dx < 260, `en ~1 s avanzó ${dx}px (esperado ~200)`);
  ws.send({ type: 'intent', intent: { dir: { x: 0, y: 0 } } });
  ws.close();
  await ws.closed;
});

test('diagonales normalizadas: misma velocidad que en línea recta', async () => {
  const ws = connect(sign(5, 'erin'));
  await ws.waitFor((m) => m.type === 'state');
  ws.send({ type: 'intent', intent: { dir: { x: -1, y: -1 } } });
  await sleep(3000); // a la esquina superior izquierda (peor caso ~2.7 s)
  ws.send({ type: 'intent', intent: { dir: { x: 0, y: 0 } } });
  await sleep(100);
  const a = me(await freshState(ws), '5');
  ws.send({ type: 'intent', intent: { dir: { x: 1, y: 1 } } });
  assert.deepStrictEqual([a.x, a.y], [20, 20]);
  await sleep(500);
  const b = me(await freshState(ws), '5');
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  assert.ok(Math.abs(b.x - a.x - (b.y - a.y)) < 1, 'se mueve en diagonal');
  assert.ok(dist > 70 && dist < 130, `distancia en ~0.5 s: ${dist} (sin normalizar sería ~141)`);
  ws.close();
  await ws.closed;
});

test('spam de intents no acelera al jugador ni genera broadcasts extra', async () => {
  const ws = connect(sign(6, 'frank'));
  await ws.waitFor((m) => m.type === 'state');
  ws.send({ type: 'intent', intent: { dir: { x: -1, y: 0 } } });
  await sleep(2000);
  ws.send({ type: 'intent', intent: { dir: { x: 0, y: 0 } } });
  await sleep(100);
  const a = me(await freshState(ws), '6');
  const n0 = ws.msgs.filter((m) => m.type === 'state').length;
  const t0 = Date.now();
  while (Date.now() - t0 < 500) {
    for (let i = 0; i < 50; i++) ws.send({ type: 'intent', intent: { dir: { x: 1, y: 0 } } });
    await sleep(5);
  }
  const b = me(await freshState(ws), '6');
  const states = ws.msgs.filter((m) => m.type === 'state').length - n0;
  const elapsed = (Date.now() - t0) / 1000;
  assert.ok(b.x - a.x <= WORLD.speed * elapsed + 15, `avanzó ${b.x - a.x}px en ${elapsed}s`);
  assert.ok(states <= Math.ceil(elapsed * 20) + 3, `states recibidos: ${states}`);
  ws.close();
  await ws.closed;
});

test('se queda dentro del mundo (clamp en los 4 bordes)', async () => {
  const ws = connect(sign(7, 'gina'));
  await ws.waitFor((m) => m.type === 'state');
  ws.send({ type: 'intent', intent: { dir: { x: 1, y: 1 } } });
  await sleep(2500);
  const p = me(lastState(ws), '7');
  assert.deepStrictEqual([p.x, p.y], [380, 280]);
  ws.close();
  await ws.closed;
});

test('mensajes inválidos se ignoran sin tumbar el servidor', async () => {
  const ws = connect(sign(8, 'hank'));
  await ws.waitFor((m) => m.type === 'state');
  for (const bad of ['no-json', 'null', '5', '[]', '{"type":"intent"}', '{"type":"intent","intent":{"dir":{"x":"1","y":0}}}',
    '{"type":"extras_update","extras":[1,2]}', '{"type":"extras_update","extras":"rojo"}', '{"type":"desconocido"}']) {
    ws.send(bad);
  }
  await freshState(ws);
  await freshState(ws);
  assert.strictEqual(ws.readyState, WebSocket.OPEN);
  assert.deepStrictEqual(me(lastState(ws), '8').extras, {});
  ws.close();
  await ws.closed;
});

test('extras_update se replica a los demás y persiste en cada tick', async () => {
  // Uber: los taxis no pueden elegir color (ver el test de colores por bando)
  const a = connect(sign(10, 'ana', {}, 'local', 'uber'));
  const b = connect(sign(11, 'beto', {}, 'google'));
  await a.waitFor((m) => m.type === 'state' && m.players.length >= 2);
  a.send({ type: 'extras_update', extras: { color: '#ff5500', mood: '😎' } });
  const seen = await b.waitFor((m) => m.type === 'state' && me(m, '10') && me(m, '10').extras.color === '#ff5500');
  assert.strictEqual(me(seen, '10').extras.mood, '😎');
  assert.strictEqual(me(seen, '11').provider, 'google');
  await sleep(500);
  assert.strictEqual(me(lastState(b), '10').extras.color, '#ff5500', 'sigue en ticks posteriores');
  // > 1024 chars: se ignora y se conservan los extras anteriores
  a.send({ type: 'extras_update', extras: { color: 'x'.repeat(1100) } });
  await sleep(200);
  assert.strictEqual(me(lastState(b), '10').extras.color, '#ff5500');
  a.close(); b.close();
  await Promise.all([a.closed, b.closed]);
});

test('mensaje > 4 KB: el coordinador corta la conexión (1009)', async () => {
  const ws = connect(sign(12, 'ivan'));
  await ws.waitFor((m) => m.type === 'welcome');
  ws.send({ type: 'extras_update', extras: { basura: 'x'.repeat(10000) } });
  assert.strictEqual((await ws.closed).code, 1009);
});

test('players_update al entrar y salir (lista del lobby)', async () => {
  const a = connect(sign(13, 'juan'));
  await a.waitFor((m) => m.type === 'players_update' && m.players.some((p) => p.username === 'juan'));
  const b = connect(sign(14, 'kim'));
  await a.waitFor((m) => m.type === 'players_update' && m.players.some((p) => p.username === 'kim'));
  b.close();
  await b.closed;
  await a.waitFor((m) => m.type === 'players_update' && !m.players.some((p) => p.username === 'kim'));
  a.close();
  await a.closed;
});

test('misma cuenta en otra pestaña: 4002 a la anterior, la nueva conserva posición y extras', async () => {
  const a = connect(sign(15, 'lu', {}, 'local', 'uber'));
  await a.waitFor((m) => m.type === 'state');
  a.send({ type: 'extras_update', extras: { color: '#123456' } });
  await sleep(150);
  const before = me(lastState(a), '15');
  const b = connect(sign(15, 'lu', {}, 'local', 'uber'));
  assert.strictEqual((await a.closed).code, 4002);
  const s = await b.waitFor((m) => m.type === 'state');
  const after = me(s, '15');
  assert.deepStrictEqual([after.x, after.y, after.extras.color], [before.x, before.y, '#123456']);
  assert.strictEqual(s.players.filter((p) => p.userId === '15').length, 1);
  b.close();
  await b.closed;
});

test('el socket se cierra con 4001 "token expired" cuando vence el JWT', async () => {
  const ws = connect(sign(16, 'mia', { expiresIn: 1 }));
  await ws.waitFor((m) => m.type === 'welcome');
  const c = await ws.closed;
  assert.deepStrictEqual([c.code, c.reason], [4001, 'token expired']);
});

test('SESSION_MAX_AGE del .env se aplica en caliente a las sesiones abiertas', async () => {
  // Otro coordinador con su propio .env en un directorio temporal
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-'));
  const envFile = path.join(dir, '.env');
  const port = PORT + 1000;
  fs.writeFileSync(envFile, `PORT=${port}\nJWT_SECRET=${JWT_SECRET}\nSESSION_MAX_AGE=1h\n`);
  const env = { ...process.env };
  for (const k of ['PORT', 'JWT_SECRET', 'SESSION_MAX_AGE']) delete env[k];
  const other = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve) => other.stdout.on('data', (d) => { if (/Coordinador en puerto/.test(d)) resolve(); }));
    const token = sign(17, 'leo');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/connect?token=${encodeURIComponent(token)}`);
    const closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    await new Promise((r) => ws.once('message', r)); // welcome
    await sleep(2100); // la sesión ya tiene más de 2 s
    // Pasa a 2s: cuenta desde el cambio, así que NO se cierra al instante
    const t0 = Date.now();
    fs.writeFileSync(envFile, `PORT=${port}\nJWT_SECRET=${JWT_SECRET}\nSESSION_MAX_AGE=2s\n`);
    const c = await Promise.race([closed, sleep(5000).then(() => ({ code: 'timeout' }))]);
    assert.deepStrictEqual([c.code, c.reason], [4001, 'session expired']);
    // 2 s desde que el coordinador ve el cambio (lo revisa cada ~1 s)
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 1900 && elapsed <= 3800, `se cerró a los ${elapsed} ms del cambio`);
  } finally {
    other.kill();
    await new Promise((r) => (other.exitCode !== null ? r() : other.once('exit', r)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pasajero: está en el state y al llegar se suma 1 punto y aparece otro', async () => {
  const ws = connect(sign(18, 'pia'));
  await ws.waitFor((m) => m.type === 'welcome');
  const first = await freshState(ws);
  assert.ok(first.passenger && typeof first.passenger.x === 'number');
  assert.strictEqual(me(first, '18').score, 0);
  // Manejar hacia el pasajero hasta recogerlo (mundo sin estructuras)
  const t0 = Date.now();
  let lastDir = '';
  while (Date.now() - t0 < 6000) {
    const s = lastState(ws);
    if (me(s, '18').score >= 1) break;
    const p = me(s, '18');
    const dir = { x: Math.sign(Math.round(s.passenger.x - p.x)), y: Math.sign(Math.round(s.passenger.y - p.y)) };
    if (JSON.stringify(dir) !== lastDir) { ws.send({ type: 'intent', intent: { dir } }); lastDir = JSON.stringify(dir); }
    await sleep(20);
  }
  const pickup = await ws.waitFor((m) => m.type === 'pickup' && m.userId === '18');
  assert.strictEqual(pickup.score, 1);
  const after = await freshState(ws);
  assert.strictEqual(me(after, '18').score, 1);
  assert.notDeepStrictEqual(after.passenger, first.passenger);
  ws.close();
  await ws.closed;
});

test('ciudad: manzanas con casas, el auto no las atraviesa y el pasajero espera en la calle', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { collides } = require('../map');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-'));
  const port = PORT + 1001;
  const env = { ...process.env, PORT: String(port), JWT_SECRET, SESSION_MAX_AGE: '', OBSTACLES: 'on',
    WORLD_WIDTH: '800', WORLD_HEIGHT: '600', PLAYER_RADIUS: '20', PLAYER_SPEED: '400', TICK_RATE: '20' };
  const other = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve) => other.stdout.on('data', (d) => { if (/Coordinador en puerto/.test(d)) resolve(); }));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/connect?token=${encodeURIComponent(sign(19, 'ana'))}`);
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once('open', r));
    while (!msgs.some((m) => m.type === 'state')) await sleep(10);
    const { obstacles, blocks } = msgs.find((m) => m.type === 'welcome').world;

    // 12 manzanas sólidas; adentro casas, conjuntos, edificios y parques
    assert.strictEqual(obstacles.length, 12);
    assert.strictEqual(blocks.length, 12);
    assert.deepStrictEqual(new Set(blocks.map((b) => b.type)), new Set(['casas', 'conjunto', 'edificio', 'parque']));
    const houses = blocks.flatMap((b) => b.houses || []);
    assert.ok(houses.length >= 20);
    // Cada casa queda dentro de su manzana (no invade la calle)
    for (const b of blocks) {
      for (const h of b.houses || []) {
        assert.ok(h.x >= b.x && h.y >= b.y && h.x + h.w <= b.x + b.size + 1e-9 && h.y + h.h <= b.y + b.size + 1e-9);
      }
    }

    // Manejar en las 8 direcciones contra las estructuras
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
    for (const [x, y] of dirs) {
      ws.send(JSON.stringify({ type: 'intent', intent: { dir: { x, y } } }));
      await sleep(400);
    }
    const states = msgs.filter((m) => m.type === 'state');
    assert.ok(states.length > 50);
    for (const s of states) {
      const p = s.players.find((q) => q.userId === '19');
      // 0.5 px de tolerancia por el redondeo a 0.1 del snapshot
      assert.ok(!collides(p.x, p.y, 19.5, obstacles), `auto dentro de una estructura en (${p.x}, ${p.y})`);
      assert.ok(!collides(s.passenger.x, s.passenger.y, 19.5, obstacles), 'pasajero dentro de una manzana');
    }
    ws.close();
  } finally {
    other.kill();
    await new Promise((r) => (other.exitCode !== null ? r() : other.once('exit', r)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vehicle viene del JWT (uber/taxi; sin vehicle = taxi) y suma al marcador del equipo', async () => {
  const signV = (userId, username, vehicle) =>
    jwt.sign({ userId, username, provider: 'local', ...(vehicle ? { vehicle } : {}) }, JWT_SECRET, { expiresIn: '1h' });
  const u = connect(signV(20, 'ubi', 'uber'));
  const t = connect(signV(21, 'tax', 'taxi'));
  const v = connect(signV(22, 'viejo'));
  const raro = connect(signV(23, 'raro', 'helicoptero'));
  for (const ws of [u, t, v, raro]) await ws.waitFor((m) => m.type === 'welcome');
  assert.strictEqual(u.msgs.find((m) => m.type === 'welcome').you.vehicle, 'uber');
  const s = await freshState(u);
  assert.deepStrictEqual(['20', '21', '22', '23'].map((id) => me(s, id).vehicle), ['uber', 'taxi', 'taxi', 'taxi']);
  const list = await u.waitFor((m) => m.type === 'players_update' && m.players.length >= 4);
  assert.strictEqual(list.players.find((p) => p.userId === '20').vehicle, 'uber');
  assert.ok(typeof s.teams.uber === 'number' && typeof s.teams.taxi === 'number');
  // extras no puede cambiar el vehículo: se ignora lo que mande el cliente
  u.send({ type: 'extras_update', extras: { vehicle: 'taxi' } });
  const s2 = await freshState(u);
  assert.strictEqual(me(s2, '20').vehicle, 'uber');
  for (const ws of [u, t, v, raro]) { ws.close(); await ws.closed; }
});

test('JWT_EXPIRES_IN del auth (GET /token-policy) se aplica a las sesiones abiertas', async () => {
  // Auth falso: devuelve la duración que diga el test
  const http = require('node:http');
  let expiresInSeconds = 3600;
  const auth = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/token-policy' ? { expiresInSeconds } : {}));
  });
  await new Promise((r) => auth.listen(0, '127.0.0.1', r));
  const port = PORT + 1002;
  const env = { ...process.env, PORT: String(port), JWT_SECRET, SESSION_MAX_AGE: '', OBSTACLES: 'off',
    AUTH_URL: `http://127.0.0.1:${auth.address().port}`, TOKEN_POLICY_POLL_MS: '200' };
  const other = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve) => other.stdout.on('data', (d) => { if (/Coordinador en puerto/.test(d)) resolve(); }));
    // Token de 1 h: con la política en 1 h la sesión sigue abierta
    const ws = new WebSocket(`ws://127.0.0.1:${port}/connect?token=${encodeURIComponent(sign(24, 'eva'))}`);
    const closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    await new Promise((r) => ws.once('message', r)); // welcome
    await sleep(2200);
    assert.strictEqual(ws.readyState, WebSocket.OPEN);
    // El auth pasa a 2 s. La sesión ya tiene más de 2 s, pero la nueva duración
    // cuenta desde el cambio: se cierra ~2 s después, aunque su exp sea de 1 h
    const t0 = Date.now();
    expiresInSeconds = 2;
    await sleep(1000);
    assert.strictEqual(ws.readyState, WebSocket.OPEN, 'no debe cerrarse al instante');
    const c = await Promise.race([closed, sleep(3000).then(() => ({ code: 'timeout' }))]);
    assert.deepStrictEqual([c.code, c.reason], [4001, 'token expired']);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 1900 && elapsed <= 2900, `se cerró a los ${elapsed} ms del cambio`);
  } finally {
    other.kill();
    await new Promise((r) => (other.exitCode !== null ? r() : other.once('exit', r)));
    auth.close();
  }
});

test('color por bando: el taxi siempre es amarillo y el Uber no puede usar amarillo', async () => {
  const taxi = connect(sign(25, 'tito', {}, 'local', 'taxi'));
  const uber = connect(sign(26, 'ulises', {}, 'local', 'uber'));
  await taxi.waitFor((m) => m.type === 'state' && m.players.length >= 2);
  const extrasOf = async (id) => me(await freshState(taxi), id).extras;

  // Taxi: el color se descarta, el mood sí se guarda
  taxi.send({ type: 'extras_update', extras: { color: '#ff0000', mood: '😎' } });
  await sleep(150);
  assert.deepStrictEqual(await extrasOf('25'), { mood: '😎' });

  // Uber: amarillos rechazados (el del taxi, otros tonos), el resto se acepta
  for (const yellow of ['#ffc928', '#FFFF00', '#f5d000', '#e6c200']) {
    uber.send({ type: 'extras_update', extras: { color: '#2ee6a6' } });
    await sleep(120);
    uber.send({ type: 'extras_update', extras: { color: yellow, mood: '🚀' } });
    await sleep(150);
    assert.deepStrictEqual(await extrasOf('26'), { mood: '🚀' }, `${yellow} debería rechazarse`);
  }
  for (const ok of ['#ff8a5c', '#2ee6a6', '#6aa8ff', '#23262e', '#f4f5f7']) {
    uber.send({ type: 'extras_update', extras: { color: ok } });
    await sleep(150);
    assert.strictEqual((await extrasOf('26')).color, ok, `${ok} debería aceptarse`);
  }
  for (const ws of [taxi, uber]) { ws.close(); await ws.closed; }
});
