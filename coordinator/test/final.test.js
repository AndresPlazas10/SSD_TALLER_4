// Tests del examen final con procesos reales: un auth (directorio) y tres
// coordinadores en mesh, cada uno con su SQLite de estado.
// - Track 2.1 persistencia: se matan los 3 coordinadores con alice en un lugar
//   y con pasajeros; al reiniciarlos alice aparece ahí, no en un spawn al azar.
//   Una copia vieja (coordinador muerto antes) no le gana a la nueva.
// - Track 2.6 chat: tres clientes en tres coordinadores ven el mismo orden;
//   rate limit; historial al conectarse; caracteres de control filtrados.
// - Track 2.5 espectador: sin login, recibe el state, no puede mover a nadie,
//   no cuenta como jugador en el directorio y tiene un máximo por coordinador.
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

Object.assign(process.env, { PUBLIC_URL: '', PEER_URL: '', PUBLIC_HOST: '', COORDINATOR_ID: '', PEER_PORT: '', AUTH_URL: '', AUTH_URLS: '', STATE_DB: '' });
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'final-'));
const IDS = ['coord-a', 'coord-b', 'coord-c'];
const ports = {};
const procs = {};
let AUTH;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const exited = (c) => c.exitCode !== null || c.signalCode !== null;
async function stopProc(c) {
  if (!c || exited(c)) return;
  const done = new Promise((r) => c.once('exit', r));
  c.kill();
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
    const v = await Promise.race([Promise.resolve().then(fn).catch(() => null), sleep(3000).then(() => null)]);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout esperando condición');
    await sleep(step);
  }
}
const getJson = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); return { status: r.status, data: await r.json() }; };
const sign = (userId, username, vehicle = 'taxi') => jwt.sign({ userId, username, provider: 'local', vehicle }, JWT_SECRET, { expiresIn: '1h' });

function startCoord(id, extra = {}) {
  return startProc(['index.js', '--id', id, '--port', String(ports[id]), '--state-db', path.join(TMP, `${id}.db`)],
    path.join(__dirname, '..'), {
      JWT_SECRET, AUTH_URL: AUTH, PUBLIC_HOST: '127.0.0.1', SESSION_MAX_AGE: '', OBSTACLES: 'off',
      WORLD_WIDTH: '600', WORLD_HEIGHT: '400', MATCH_SECONDS: '600', TOKEN_POLICY_POLL_MS: '60000',
      PERSIST_MS: '300', REBALANCE_MS: '600000', ...extra,
    }, /Coordinador en puerto/).then((c) => { procs[id] = c; return c; });
}
async function waitMesh(ids = IDS) {
  await waitFor(async () => {
    const hs = await Promise.all(ids.map((id) => getJson(`http://127.0.0.1:${ports[id]}/health`)));
    return hs.every((h) => h.data.peers.length === ids.length - 1);
  }, 12000, 200);
}

function client(url, token, spectator = false) {
  const ws = new WebSocket(spectator ? `${url}/spectate` : `${url}/connect?token=${encodeURIComponent(token)}`);
  ws.msgs = [];
  ws.closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  ws.on('message', (d) => ws.msgs.push(JSON.parse(d.toString())));
  ws.on('error', () => {});
  ws.waitFor = (pred, ms = 5000) => waitFor(() => ws.msgs.find(pred), ms, 20);
  ws.last = (type) => [...ws.msgs].reverse().find((m) => m.type === type);
  ws.sendJson = (o) => ws.send(JSON.stringify(o));
  return ws;
}
const coordUrl = (id) => `ws://127.0.0.1:${ports[id]}`;
const find = (state, userId) => state && state.players.find((p) => p.userId === String(userId));

// Maneja al jugador hasta el pasajero hasta tener `goal` puntos
async function drive(ws, id, goal = 1, ms = 8000) {
  const t0 = Date.now();
  let lastDir = '';
  while (Date.now() - t0 < ms) {
    const s = ws.last('state');
    const p = find(s, id);
    if (p && p.score >= goal) break;
    if (p && s.passenger) {
      const dir = { x: Math.sign(Math.round(s.passenger.x - p.x)), y: Math.sign(Math.round(s.passenger.y - p.y)) };
      if (JSON.stringify(dir) !== lastDir) { ws.sendJson({ type: 'intent', intent: { dir } }); lastDir = JSON.stringify(dir); }
    }
    await sleep(25);
  }
  ws.sendJson({ type: 'intent', intent: { dir: { x: 0, y: 0 } } });
}

before(async () => {
  const authPort = await freePort();
  for (const id of IDS) ports[id] = await freePort();
  AUTH = `http://127.0.0.1:${authPort}`;
  procs.auth = await startProc(['index.js'], path.join(__dirname, '..', '..', 'auth-service'), {
    PORT: String(authPort), JWT_SECRET, DB_FILE: path.join(TMP, 'auth.db'), GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
    JWT_EXPIRES_IN: '1h', DIRECTORY_TTL_MS: '4500', AUTH_PEERS: '', PEER_PORT: '',
  }, /Auth service en puerto/);
  for (const id of IDS) await startCoord(id);
  await waitMesh();
});
after(async () => {
  for (const p of Object.values(procs)) await stopProc(p);
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('2.6 chat: tres clientes en tres coordinadores ven los mensajes en el MISMO orden', async () => {
  const cs = IDS.map((id, i) => client(coordUrl(id), sign(101 + i, ['alice', 'bob', 'charlie'][i])));
  for (const c of cs) await c.waitFor((m) => m.type === 'chat_history');
  // Los tres escriben "a la vez", varias veces
  for (let round = 0; round < 3; round++) cs.forEach((c, i) => c.sendJson({ type: 'chat', text: `msg ${round} de ${i}` }));
  const orders = await Promise.all(cs.map((c) => waitFor(() => {
    const got = c.msgs.filter((m) => m.type === 'chat').map((m) => m.message);
    return got.length >= 9 ? got : null;
  }, 8000)));
  const texts = orders.map((o) => o.map((m) => `${m.seq}:${m.text}`).join('|'));
  assert.strictEqual(texts[0], texts[1], 'alice y bob ven el mismo orden');
  assert.strictEqual(texts[1], texts[2], 'bob y charlie ven el mismo orden');
  const seqs = orders[0].map((m) => m.seq);
  assert.deepStrictEqual(seqs, [...seqs].sort((a, b) => a - b), 'en orden de seq');
  assert.strictEqual(new Set(seqs).size, 9, 'sin repetidos');
  // Un cliente nuevo recibe el historial
  const late = client(coordUrl('coord-b'), sign(104, 'dave'));
  const h = await late.waitFor((m) => m.type === 'chat_history');
  assert.ok(h.messages.length >= 9);
  for (const c of [...cs, late]) { c.close(1000, 'logout'); await c.closed; }
});

test('2.6 chat: rate limit (ráfaga de 5, después rate_limited y luego silenciado) y texto filtrado', async () => {
  const c = client(coordUrl('coord-a'), sign(110, 'spammer'));
  await c.waitFor((m) => m.type === 'chat_history');
  for (let i = 0; i < 15; i++) c.sendJson({ type: 'chat', text: `spam ${i}` });
  await c.waitFor((m) => m.type === 'chat_error' && m.reason === 'muted', 4000);
  await sleep(500);
  const delivered = c.msgs.filter((m) => m.type === 'chat' && m.message.username === 'spammer').length;
  assert.ok(delivered <= 6, `pasaron ${delivered} de 15`);
  assert.ok(c.msgs.some((m) => m.type === 'chat_error' && m.reason === 'rate_limited'));
  // Texto con caracteres de control: se limpia; demasiado largo: se rechaza
  const d = client(coordUrl('coord-b'), sign(111, 'limpio'));
  await d.waitFor((m) => m.type === 'chat_history');
  d.sendJson({ type: 'chat', text: `hola${String.fromCharCode(7)}${String.fromCharCode(0x202e)} <img src=x onerror=alert(1)>` });
  const m = await d.waitFor((x) => x.type === 'chat' && x.message.username === 'limpio');
  assert.strictEqual(m.message.text, 'hola <img src=x onerror=alert(1)>', 'sin caracteres de control (el HTML lo escapa el cliente al mostrarlo)');
  d.sendJson({ type: 'chat', text: 'x'.repeat(201) });
  assert.strictEqual((await d.waitFor((x) => x.type === 'chat_error')).reason, 'too_long');
  for (const x of [c, d]) { x.close(1000, 'logout'); await x.closed; }
});

test('2.5 espectador: sin login ve moverse al jugador, no tiene controles y no cuenta como jugador', async () => {
  const player = client(coordUrl('coord-a'), sign(120, 'piloto'));
  await player.waitFor((m) => m.type === 'state' && find(m, 120));
  const spec = client(coordUrl('coord-a'), null, true);
  const w = await spec.waitFor((m) => m.type === 'welcome');
  assert.strictEqual(w.spectator, true);
  assert.strictEqual(w.you, null);
  // El jugador se mueve y el espectador lo ve
  const s0 = find(await spec.waitFor((m) => m.type === 'state' && find(m, 120)), 120);
  // Hacia el lado con más espacio (puede haber aparecido junto a un borde)
  const dirX = s0.x < 300 ? 1 : -1;
  player.sendJson({ type: 'intent', intent: { dir: { x: dirX, y: 0 } } });
  await sleep(600);
  player.sendJson({ type: 'intent', intent: { dir: { x: 0, y: 0 } } });
  await sleep(200);
  const s1 = find(spec.last('state'), 120);
  assert.ok(Math.abs(s1.x - s0.x) > 30, `el espectador ve el movimiento (${s0.x} -> ${s1.x})`);
  // "DevTools": el espectador fuerza intents y extras -> se ignoran, nada se rompe
  for (let i = 0; i < 5; i++) spec.sendJson({ type: 'intent', intent: { dir: { x: -dirX, y: 0 } } });
  spec.sendJson({ type: 'extras_update', extras: { mood: '😈' } });
  spec.sendJson({ type: 'chat', text: 'soy espectador' });
  spec.send('no es json');
  await spec.waitFor((m) => m.type === 'spectator_ignored');
  await sleep(500);
  const s2 = find(player.last('state'), 120);
  assert.ok(Math.abs(s2.x - s1.x) < 2, 'nadie se movió por el espectador');
  assert.ok(!player.msgs.some((m) => m.type === 'chat' && m.message.text === 'soy espectador'));
  // Recibe el state más espaciado (10 Hz en vez de 20)
  const n0 = spec.msgs.filter((m) => m.type === 'state').length;
  const p0 = player.msgs.filter((m) => m.type === 'state').length;
  await sleep(1000);
  const ns = spec.msgs.filter((m) => m.type === 'state').length - n0;
  const np = player.msgs.filter((m) => m.type === 'state').length - p0;
  assert.ok(ns < np * 0.75, `espectador ${ns}/s vs jugador ${np}/s`);
  // No cuenta como jugador: /health y el directorio lo ven aparte
  const hh = (await getJson(`http://127.0.0.1:${ports['coord-a']}/health`)).data;
  assert.deepStrictEqual([hh.localPlayers, hh.spectators], [1, 1]);
  await waitFor(async () => {
    const c = (await getJson(`${AUTH}/coordinators`)).data.coordinators.find((x) => x.coordinatorId === 'coord-a');
    return c && c.connectedPlayers === 1 && c.spectators === 1;
  }, 6000, 300);
  // El directorio manda los espectadores al que tiene menos espectadores
  const r = await getJson(`${AUTH}/coordinator?role=spectator`);
  assert.notStrictEqual(r.data.coordinatorId, 'coord-a');
  for (const x of [spec, player]) { x.close(1000, 'logout'); await x.closed; }
});

test('2.5 espectador: máximo por coordinador (el siguiente recibe 4013 y va a otro)', async () => {
  await stopProc(procs['coord-c']);
  await startCoord('coord-c', { MAX_SPECTATORS: '1' });
  await waitMesh();
  const a = client(coordUrl('coord-c'), null, true);
  await a.waitFor((m) => m.type === 'welcome');
  const b = client(coordUrl('coord-c'), null, true);
  assert.strictEqual((await b.closed).code, 4013);
  a.close(); await a.closed;
});

test('2.1 persistencia: se matan los 3 coordinadores; al volver, alice aparece donde estaba y con sus pasajeros', async () => {
  const alice = client(coordUrl('coord-a'), sign(130, 'alice'));
  const bob = client(coordUrl('coord-b'), sign(131, 'bob', 'uber'));
  await alice.waitFor((m) => m.type === 'state' && find(m, 130) && find(m, 131));
  await drive(alice, 130, 1);
  // Estacionada en un lugar concreto
  alice.sendJson({ type: 'intent', intent: { dir: { x: 1, y: 0 } } });
  await sleep(400);
  alice.sendJson({ type: 'intent', intent: { dir: { x: 0, y: 0 } } });
  await sleep(1200); // player_sync + al menos un guardado (PERSIST_MS = 300)
  const before = find(alice.last('state'), 130);
  const round = alice.last('state').match.round;
  assert.ok(before.score >= 1);

  // Se matan los tres a la vez
  await Promise.all(IDS.map((id) => stopProc(procs[id])));
  await alice.closed;
  await bob.closed;
  for (const id of IDS) await startCoord(id);
  await waitMesh();

  // alice vuelve (por el directorio, a cualquiera): mismo lugar, mismos pasajeros, misma ronda
  const { data } = await waitFor(async () => { const r = await getJson(`${AUTH}/coordinator`); return r.status === 200 ? r : null; });
  const back = client(data.publicUrl, sign(130, 'alice'));
  const w = await back.waitFor((m) => m.type === 'welcome');
  assert.strictEqual(w.restored, true, 'el coordinador la recupera de lo guardado');
  const s = await back.waitFor((m) => m.type === 'state' && find(m, 130));
  const after = find(s, 130);
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 3, `en x≈${before.x}: volvió en (${after.x}, ${after.y})`);
  assert.strictEqual(after.score, before.score, 'con sus pasajeros');
  assert.strictEqual(s.match.round, round, 'la ronda sigue');
  back.close(1000, 'logout');
  await back.closed;
});

test('2.1 persistencia: la copia de un coordinador que murió antes (vieja) no le gana a la más nueva', async () => {
  const alice = client(coordUrl('coord-a'), sign(140, 'alicia'));
  await alice.waitFor((m) => m.type === 'state' && find(m, 140));
  await sleep(800); // los tres guardan a alicia en su lugar inicial
  // coord-c muere: su copia de alicia queda vieja
  await stopProc(procs['coord-c']);
  const old = find(alice.last('state'), 140);
  // alicia se mueve lejos y quieta; coord-a y coord-b guardan la copia nueva
  alice.sendJson({ type: 'intent', intent: { dir: { x: old.x < 300 ? 1 : -1, y: old.y < 200 ? 1 : -1 } } });
  await sleep(700);
  alice.sendJson({ type: 'intent', intent: { dir: { x: 0, y: 0 } } });
  await sleep(1200);
  const now = find(alice.last('state'), 140);
  assert.ok(Math.hypot(now.x - old.x, now.y - old.y) > 60);
  await Promise.all(['coord-a', 'coord-b'].map((id) => stopProc(procs[id])));
  await alice.closed;
  // Vuelven los tres; alicia entra justo por coord-c (el de la copia vieja)
  for (const id of IDS) await startCoord(id);
  await waitMesh();
  const back = client(coordUrl('coord-c'), sign(140, 'alicia'));
  await back.waitFor((m) => m.type === 'welcome');
  const final = await waitFor(() => {
    const p = find(back.last('state'), 140);
    return p && Math.hypot(p.x - now.x, p.y - now.y) < 3 ? p : null;
  }, 6000);
  assert.ok(final, 'gana la copia más nueva (versión mayor), no la de coord-c');
  back.close(1000, 'logout');
  await back.closed;
});

test('2.1 persistencia: cerrar sesión borra lo guardado (una copia vieja no la "resucita")', async () => {
  const u = client(coordUrl('coord-b'), sign(150, 'temporal'));
  await u.waitFor((m) => m.type === 'state' && find(m, 150));
  u.sendJson({ type: 'intent', intent: { dir: { x: 1, y: 1 } } });
  await sleep(500);
  u.sendJson({ type: 'intent', intent: { dir: { x: 0, y: 0 } } });
  await sleep(800);
  u.close(1000, 'logout');
  await u.closed;
  await sleep(600);
  const st = (await getJson(`http://127.0.0.1:${ports['coord-a']}/status`)).data.players.find((p) => p.userId === '150');
  assert.strictEqual(st.state, 'cerró sesión');
  const again = client(coordUrl('coord-a'), sign(150, 'temporal'));
  const w = await again.waitFor((m) => m.type === 'welcome');
  assert.strictEqual(w.restored, false);
  again.close(1000, 'logout');
  await again.closed;
});
