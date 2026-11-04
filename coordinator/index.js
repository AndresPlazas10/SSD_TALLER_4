// Si SESSION_MAX_AGE viene del entorno real (tests, shell) manda ese valor;
// si viene del .env se relee en caliente (ver watchSessionMaxAge).
const MAX_AGE_FROM_ENV = 'SESSION_MAX_AGE' in process.env;
const dotenv = require('dotenv');
dotenv.config();
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { buildCity, resolve, collides } = require('./map');

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || '30000', 10);
// Auth y coordinador corren en equipos distintos: sus relojes no son idénticos.
// Se toleran unos segundos de diferencia al validar exp/iat del JWT.
const JWT_CLOCK_TOLERANCE_S = parseInt(process.env.JWT_CLOCK_TOLERANCE_S || '5', 10);

// Duración máxima de una sesión contada desde el iat del token ('30s', '5m',
// '1h', '1d'; un número sin unidad son segundos; vacío = sin límite extra).
// A diferencia del exp, que queda fijo en el token, este límite se aplica
// también a las sesiones ya abiertas cuando cambia.
const UNIT_S = { s: 1, m: 60, h: 3600, d: 86400 };
function parseMaxAge(raw) {
  const v = (raw || '').trim();
  if (!v) return null;
  const m = /^(\d+)\s*([smhd])?$/.exec(v);
  if (!m) throw new Error(`SESSION_MAX_AGE inválido: "${v}" (usar p. ej. 30s, 5m, 1h)`);
  return Number(m[1]) * UNIT_S[m[2] || 's'];
}
let SESSION_MAX_AGE_S;
try {
  SESSION_MAX_AGE_S = parseMaxAge(process.env.SESSION_MAX_AGE);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Política de tokens del auth (GET /token-policy): si se cambia JWT_EXPIRES_IN
// en el auth, el coordinador lo aplica también a las sesiones abiertas.
// AUTH_URL vacío = desactivado (solo cuentan el exp del token y SESSION_MAX_AGE).
const AUTH_URL = (process.env.AUTH_URL || '').trim().replace(/\/+$/, '');
const TOKEN_POLICY_POLL_MS = parseInt(process.env.TOKEN_POLICY_POLL_MS || '1000', 10);
let authExpiresInS = null; // último valor recibido del auth
// Momento (ms) en que se aplicó cada límite. Una sesión abierta antes de un
// cambio cuenta la nueva duración desde el cambio, no desde su login: si se
// pasa a 30s, se cierra 30 s después de guardar el .env, no al instante.
let authPolicyAt = 0;
let sessionMaxAgeAt = 0;

// Mundo del juego (el cliente lo recibe en 'welcome')
const WORLD_WIDTH = parseInt(process.env.WORLD_WIDTH || '800', 10);
const WORLD_HEIGHT = parseInt(process.env.WORLD_HEIGHT || '600', 10);
const PLAYER_RADIUS = parseInt(process.env.PLAYER_RADIUS || '20', 10);
const PLAYER_SPEED = parseInt(process.env.PLAYER_SPEED || '200', 10); // px/seg
const TICK_RATE = parseInt(process.env.TICK_RATE || '20', 10);        // Hz
const TICK_MS = 1000 / TICK_RATE;
// OBSTACLES=off deja el mundo vacío (lo usan los tests de movimiento)
const OBSTACLES = (process.env.OBSTACLES || 'on').trim().toLowerCase() !== 'off';
const PASSENGER_RADIUS = 10;
// Límite anti-abuso: ws corta (1009) cualquier mensaje más grande que esto
// antes de parsearlo, así nadie puede mandar 10 MB.
const MAX_MESSAGE_BYTES = 4096;
const MAX_EXTRAS_CHARS = 1024;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET debe existir en el .env, tener al menos 32 caracteres y ser la misma que usa auth-service');
  process.exit(1);
}

const app = express();
app.get('/health', (req, res) => res.json({ ok: true, players: players.size, tickRate: TICK_RATE }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

// userId -> { username, provider, socket, connectedAt, x, y, angle, intent, extras, score }
// Este Map es la ÚNICA fuente de verdad de las posiciones.
const players = new Map();

// Ciudad: calles y estructuras. Fija mientras viva el proceso.
const city = buildCity(WORLD_WIDTH, WORLD_HEIGHT, PLAYER_RADIUS);
if (!OBSTACLES) { city.obstacles = []; city.blocks = []; }

// Pasajeros recogidos por cada equipo mientras viva el proceso
const teams = { uber: 0, taxi: 0 };

// Punto aleatorio donde un círculo de radio r no toca ninguna estructura.
// avoid: puntos de los que conviene alejarse (p. ej. los autos), si se puede.
function randomFreePoint(r, avoid = [], minDist = 0) {
  let fallback = null;
  for (let i = 0; i < 300; i++) {
    const x = r + Math.random() * (WORLD_WIDTH - 2 * r);
    const y = r + Math.random() * (WORLD_HEIGHT - 2 * r);
    if (collides(x, y, r, city.obstacles)) continue;
    if (avoid.every((a) => Math.hypot(a.x - x, a.y - y) >= minDist)) return { x, y };
    fallback = fallback || { x, y };
  }
  // Siempre hay calle en la esquina superior izquierda (franja libre del borde)
  return fallback || { x: city.margin / 2, y: city.margin / 2 };
}

// Pasajero compartido: el primer auto que llega lo recoge (+1) y aparece otro.
// Espera en la calle junto al andén de una manzana, en un punto donde cabe
// un AUTO (no solo el pasajero), así siempre es alcanzable.
function spawnPassenger() {
  const cars = Array.from(players.values());
  const off = PLAYER_RADIUS + 2; // distancia del centro del auto al borde del andén
  for (let i = 0; i < 300 && city.blocks.length; i++) {
    const b = city.blocks[Math.floor(Math.random() * city.blocks.length)];
    const t = b.size * (0.15 + Math.random() * 0.7);
    const side = Math.floor(Math.random() * 4);
    const x = side === 0 ? b.x + t : side === 1 ? b.x + b.size + off : side === 2 ? b.x + t : b.x - off;
    const y = side === 0 ? b.y - off : side === 1 ? b.y + t : side === 2 ? b.y + b.size + off : b.y + t;
    if (x < PLAYER_RADIUS || y < PLAYER_RADIUS || x > WORLD_WIDTH - PLAYER_RADIUS || y > WORLD_HEIGHT - PLAYER_RADIUS) continue;
    if (collides(x, y, PLAYER_RADIUS, city.obstacles)) continue;
    if (cars.every((c) => Math.hypot(c.x - x, c.y - y) >= 150)) return { x, y };
  }
  const p = randomFreePoint(PLAYER_RADIUS, cars, 150);
  return { x: p.x, y: p.y };
}
let passenger = spawnPassenger();

// Cierra el socket en el primero de estos momentos:
// - vence el token (exp)                                  -> 'token expired'
// - duración vigente del auth (JWT_EXPIRES_IN) cumplida    -> 'token expired'
// - SESSION_MAX_AGE cumplido                               -> 'session expired'
// Cada duración se cuenta desde el login (iat) o desde que se aplicó el
// límite, lo que sea más tarde. Se vuelve a llamar para todas las sesiones
// abiertas cuando cambia alguno.
function scheduleExpiry(ws) {
  clearTimeout(ws.expTimer);
  const { iat, exp } = ws.tokenTimes;
  let deadline = exp ? exp * 1000 : Infinity;
  let reason = 'token expired';
  const limitEnd = (seconds, appliedAt) => Math.max(iat * 1000, appliedAt) + seconds * 1000;
  if (authExpiresInS !== null && iat && limitEnd(authExpiresInS, authPolicyAt) < deadline) {
    deadline = limitEnd(authExpiresInS, authPolicyAt);
  }
  if (SESSION_MAX_AGE_S !== null && iat && limitEnd(SESSION_MAX_AGE_S, sessionMaxAgeAt) < deadline) {
    deadline = limitEnd(SESSION_MAX_AGE_S, sessionMaxAgeAt);
    reason = 'session expired';
  }
  if (deadline === Infinity) return;
  ws.expTimer = setTimeout(() => {
    if (ws.readyState === ws.OPEN) ws.close(4001, reason);
  }, Math.max(deadline - Date.now(), 0));
}

// Relee SESSION_MAX_AGE del .env cuando el archivo cambia (sin reiniciar).
// Un valor inválido se ignora y se conserva el anterior.
const ENV_FILE = path.resolve('.env');
function reloadSessionMaxAge() {
  let next;
  try {
    next = parseMaxAge(dotenv.parse(fs.readFileSync(ENV_FILE)).SESSION_MAX_AGE);
  } catch (err) {
    console.error(`[config] SESSION_MAX_AGE no recargado, se mantiene el anterior: ${err.message}`);
    return;
  }
  if (next === SESSION_MAX_AGE_S) return;
  const fmt = (s) => (s === null ? 'sin límite' : `${s}s`);
  console.log(`[config] SESSION_MAX_AGE: ${fmt(SESSION_MAX_AGE_S)} -> ${fmt(next)} (se aplica a ${players.size} sesiones abiertas)`);
  SESSION_MAX_AGE_S = next;
  sessionMaxAgeAt = Date.now();
  for (const { socket } of players.values()) scheduleExpiry(socket);
}
if (!MAX_AGE_FROM_ENV) fs.watchFile(ENV_FILE, { interval: 1000 }, reloadSessionMaxAge);

// Consulta periódica al auth. Si no responde (caído, red) se conserva el
// último valor: una falla del auth no debe tumbar sesiones ya validadas.
let authReachable = null;
async function pollTokenPolicy() {
  try {
    const res = await fetch(`${AUTH_URL}/token-policy`, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { expiresInSeconds } = await res.json();
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) throw new Error('respuesta inválida');
    if (authReachable === false) console.log('[auth] /token-policy responde de nuevo');
    authReachable = true;
    if (expiresInSeconds === authExpiresInS) return;
    const fmt = (s) => (s === null ? 'desconocida' : `${s}s`);
    console.log(`[auth] JWT_EXPIRES_IN: ${fmt(authExpiresInS)} -> ${expiresInSeconds}s (se aplica a ${players.size} sesiones abiertas)`);
    authExpiresInS = expiresInSeconds;
    authPolicyAt = Date.now();
    for (const { socket } of players.values()) scheduleExpiry(socket);
  } catch (err) {
    if (authReachable !== false) console.error(`[auth] no se pudo consultar ${AUTH_URL}/token-policy (${err.message}); se mantiene la duración anterior`);
    authReachable = false;
  }
}
let policyTimer = null;
if (AUTH_URL) {
  pollTokenPolicy();
  policyTimer = setInterval(pollTokenPolicy, TOKEN_POLICY_POLL_MS);
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const { socket } of players.values()) {
    if (socket.readyState === socket.OPEN) socket.send(msg);
  }
}

// Lista del lobby (solo cambia cuando alguien entra o sale)
function broadcastPlayers() {
  const list = Array.from(players.entries()).map(([userId, p]) => ({
    userId,
    username: p.username,
    provider: p.provider,
    vehicle: p.vehicle,
  }));
  broadcast({ type: 'players_update', players: list });
}

// Estado público de cada jugador. Nunca se envía el socket ni el intent.
function snapshot() {
  return Array.from(players.entries()).map(([userId, p]) => ({
    userId,
    username: p.username,
    provider: p.provider,
    vehicle: p.vehicle,
    x: Math.round(p.x * 10) / 10,
    y: Math.round(p.y * 10) / 10,
    angle: Math.round(p.angle * 100) / 100,
    score: p.score,
    extras: p.extras,
  }));
}

// --- Game loop: el ÚNICO lugar donde se mueven los jugadores ---
let lastTick = Date.now();

function tick() {
  const now = Date.now();
  // dt real entre ticks: la velocidad no depende de TICK_RATE ni de cuántos
  // mensajes mande el cliente. Se acota a 250 ms para que una pausa del event
  // loop (GC, equipo suspendido) no produzca un salto enorme.
  const dt = Math.min((now - lastTick) / 1000, 0.25); // segundos
  lastTick = now;

  for (const p of players.values()) {
    // Normalizar diagonales:
    // Sin esto, los jugadores van ~41% más rápido en diagonal.
    const ix = p.intent.x;
    const iy = p.intent.y;
    const mag = Math.hypot(ix, iy);
    if (mag > 0) {
      p.angle = Math.atan2(iy, ix); // el auto mira hacia donde avanza
      // Substeps de como mucho medio radio: aunque dt sea grande el auto no
      // puede "saltar" a través de la punta de una estructura.
      const dist = PLAYER_SPEED * dt;
      const steps = Math.max(1, Math.ceil(dist / (PLAYER_RADIUS / 2)));
      for (let s = 0; s < steps; s++) {
        p.x += ((ix / mag) * dist) / steps;
        p.y += ((iy / mag) * dist) / steps;
        // Colisión: el auto es un círculo de PLAYER_RADIUS; se lo saca de la
        // estructura y conserva el movimiento paralelo a la pared (se desliza).
        [p.x, p.y] = resolve(p.x, p.y, PLAYER_RADIUS, city.obstacles);
        // Mantener dentro del mundo
        p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, p.x));
        p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y));
      }
    }
  }

  // Recogida del pasajero: la decide el servidor, nunca el cliente
  for (const [userId, p] of players) {
    if (Math.hypot(p.x - passenger.x, p.y - passenger.y) < PLAYER_RADIUS + PASSENGER_RADIUS) {
      p.score += 1;
      teams[p.vehicle] += 1;
      console.log(`[juego] ${p.username} (${p.vehicle}) recogió al pasajero (${p.score}) | uber ${teams.uber} - taxi ${teams.taxi}`);
      broadcast({ type: 'pickup', userId, username: p.username, vehicle: p.vehicle, score: p.score });
      passenger = spawnPassenger();
      break;
    }
  }

  // Un solo broadcast por tick (nunca uno por cada intent)
  if (players.size > 0) {
    broadcast({ type: 'state', t: now, players: snapshot(), passenger: roundPoint(passenger), teams });
  }
}

// ¿El color es un amarillo? Tono 40°-70° en HSL, suficientemente saturado y
// ni muy oscuro ni casi blanco. Cubre el amarillo taxi (#ffc928, 45°) y sus
// variantes, pero no naranjas (#ff8a5c, 17°) ni verdes.
function isYellow(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return false;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return false; // gris
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return h >= 40 && h <= 70 && s >= 0.5 && l >= 0.3 && l <= 0.85;
}

// El color del auto depende del bando y lo valida el servidor (el cliente se
// puede modificar desde DevTools):
// - taxi: todos los taxis son amarillos, se descarta cualquier color.
// - uber: no puede usar amarillo (se confundiría con un taxi).
// El resto de extras (mood) pasa igual.
function sanitizeExtras(extras, vehicle) {
  const clean = { ...extras };
  if (vehicle === 'taxi' || (typeof clean.color === 'string' && isYellow(clean.color))) delete clean.color;
  return clean;
}

function roundPoint({ x, y }) {
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

// Equivale a setInterval(tick, TICK_MS) pero sin deriva: en Windows los timers
// tienen ~15.6 ms de resolución y setInterval(…, 50) dispara cada ~62 ms
// (16 Hz en vez de 20). Cada tick se agenda contra un horario fijo, así el
// promedio se mantiene en TICK_RATE aunque un tick individual se atrase.
let gameLoop = null;
let nextTickAt = Date.now() + TICK_MS;
function scheduleTick() {
  gameLoop = setTimeout(() => {
    tick();
    nextTickAt += TICK_MS;
    // Si el proceso estuvo congelado mucho tiempo, no recuperar ticks en ráfaga
    if (Date.now() - nextTickAt > 1000) nextTickAt = Date.now() + TICK_MS;
    scheduleTick();
  }, Math.max(0, nextTickAt - Date.now()));
}
scheduleTick();

// La verificación del JWT se hace en el 'upgrade', ANTES de registrar al jugador.
// Un cliente con token inválido nunca llega a 'connection' ni entra al Map.
// Nota: para que el navegador pueda leer el código 4001 hay que completar el
// handshake y cerrar inmediatamente con ese código (con un 401 HTTP el navegador
// solo ve un cierre genérico 1006).
server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, 'http://coordinator');
  const token = searchParams.get('token');

  if (pathname !== '/connect') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  let payload = null;
  try {
    if (!token) throw new Error('missing token');
    payload = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      clockTolerance: JWT_CLOCK_TOLERANCE_S,
    });
    if (!payload.userId || !payload.username) throw new Error('bad payload');
  } catch (err) {
    console.log(`[ws] token rechazado: ${err.message}`);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close(4001, 'invalid token');
    });
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, payload);
  });
});

wss.on('connection', (ws, payload) => {
  const userId = String(payload.userId);
  const { username } = payload;
  // Tokens del Taller 1 no traían provider: eran todos locales.
  const provider = payload.provider === 'google' ? 'google' : 'local';
  // Uber o Taxi se eligió al registrarse y viaja firmado en el JWT: el cliente
  // no lo puede cambiar. Tokens anteriores a esta opción juegan como taxi.
  const vehicle = payload.vehicle === 'uber' ? 'uber' : 'taxi';

  // Decisión de diseño (ver README): si el usuario ya está conectado,
  // se desconecta la sesión anterior y gana la nueva. La nueva hereda la
  // posición y los extras: es el mismo jugador, no uno nuevo.
  const existing = players.get(userId);
  if (existing) {
    console.log(`[ws] ${username} ya estaba conectado: se cierra la sesión anterior`);
    existing.socket.close(4002, 'session replaced');
  }

  // Aparece en la calle, nunca dentro de una estructura
  const spawn = existing || randomFreePoint(PLAYER_RADIUS);
  players.set(userId, {
    username,
    provider,
    vehicle,
    socket: ws,
    connectedAt: new Date().toISOString(),
    x: spawn.x,
    y: spawn.y,
    angle: existing ? existing.angle : 0,
    intent: { x: 0, y: 0 },
    extras: existing ? existing.extras : {},
    score: existing ? existing.score : 0,
  });
  console.log(`[ws] + ${username} [${provider}, ${vehicle}] (${players.size} en línea)`);

  // El cliente necesita el world para dimensionar el canvas
  ws.send(JSON.stringify({
    type: 'welcome',
    you: { userId, username, provider, vehicle },
    world: {
      width: WORLD_WIDTH, height: WORLD_HEIGHT, playerRadius: PLAYER_RADIUS, tickRate: TICK_RATE,
      passengerRadius: PASSENGER_RADIUS,
      // Solo para dibujar: las colisiones las resuelve el servidor
      cell: city.cell, sidewalk: city.sidewalk, obstacles: city.obstacles, blocks: city.blocks,
    },
  }));
  broadcastPlayers();

  // Cerrar el socket cuando el token expire o se cumpla el límite vigente
  ws.tokenTimes = { iat: payload.iat, exp: payload.exp };
  scheduleExpiry(ws);

  // Los mensajes SOLO guardan intenciones/extras. Nunca mueven al jugador ni
  // hacen broadcast: eso lo hace el game loop una vez por tick.
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    // JSON.parse('null') o '5' son JSON válido: sin esto msg.type lanzaría.
    if (!msg || typeof msg !== 'object') return;

    const p = players.get(userId);
    // Si este socket fue reemplazado, sus mensajes ya no controlan al jugador
    if (!p || p.socket !== ws) return;

    if (msg.type === 'intent') {
      const dir = msg.intent && msg.intent.dir;
      if (!dir || typeof dir.x !== 'number' || typeof dir.y !== 'number') return;
      // Sanitizar a -1, 0, 1 - NO confiar en lo que mande el cliente
      p.intent = { x: Math.sign(dir.x), y: Math.sign(dir.y) };
      return;
    }

    if (msg.type === 'extras_update') {
      if (!msg.extras || typeof msg.extras !== 'object' || Array.isArray(msg.extras)) return;
      if (JSON.stringify(msg.extras).length > MAX_EXTRAS_CHARS) return; // límite anti-abuso
      // Se guarda en el estado del jugador: se replica en cada tick mientras
      // dure la sesión (no es un evento puntual).
      p.extras = sanitizeExtras(msg.extras, p.vehicle);
      return;
    }
  });

  // Heartbeat para detectar conexiones muertas
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('close', () => {
    clearTimeout(ws.expTimer);
    // Solo borrar si el Map todavía apunta a ESTE socket; si fue reemplazado
    // por una sesión nueva, no se debe eliminar la nueva.
    const current = players.get(userId);
    if (current && current.socket === ws) {
      players.delete(userId);
      console.log(`[ws] - ${username} (${players.size} en línea)`);
      broadcastPlayers();
    }
  });

  ws.on('error', (err) => console.error(`[ws] error de ${username}:`, err.message));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => {
  clearInterval(heartbeat);
  clearTimeout(gameLoop);
  fs.unwatchFile(ENV_FILE, reloadSessionMaxAge);
  clearInterval(policyTimer);
});

server.listen(PORT, () => {
  console.log(`Coordinador en puerto ${PORT} (game loop a ${TICK_RATE} Hz, mundo ${WORLD_WIDTH}x${WORLD_HEIGHT}, ${city.obstacles.length} estructuras)`);
});
