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
      JWT_CLOCK_TOLERANCE_S: '5',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => child.stdout.on('data', (d) => { if (/Coordinador en puerto/.test(d)) resolve(); }));
});
after(() => child.kill());

const sign = (userId, username, opts = {}, provider = 'local') =>
  jwt.sign({ userId, username, provider }, JWT_SECRET, { expiresIn: '1h', ...opts });

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
  assert.deepStrictEqual(w.you, { userId: '1', username: 'alice', provider: 'local' });
  assert.deepStrictEqual(w.world, { width: 400, height: 300, playerRadius: 20, tickRate: 20 });
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
  const a = connect(sign(10, 'ana'));
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
  const a = connect(sign(15, 'lu'));
  await a.waitFor((m) => m.type === 'state');
  a.send({ type: 'extras_update', extras: { color: '#123456' } });
  await sleep(150);
  const before = me(lastState(a), '15');
  const b = connect(sign(15, 'lu'));
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
