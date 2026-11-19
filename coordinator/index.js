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
const { createMesh } = require('./mesh');
const { createStore } = require('./persistence');
const { createChat, createRateLimiter, sanitizeChatText, MAX_CHARS: CHAT_MAX_CHARS } = require('./chat');

// Varios coordinadores en un mismo equipo comparten el .env: el id y los
// puertos se pueden pasar por línea de comandos (ver los scripts de package.json):
//   node index.js --id coord-b --port 5002 --peer-port 5102
function cliArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const PORT = parseInt(cliArg('port') || process.env.PORT || '5000', 10);
// Identidad en el mesh (única): coord-a, coord-b...
const COORDINATOR_ID = cliArg('id') || process.env.COORDINATOR_ID || `coord-${PORT}`;
// Puerto del mesh (solo coordinadores), separado del de los jugadores
const PEER_PORT = parseInt(cliArg('peer-port') || process.env.PEER_PORT || String(PORT + 100), 10);
// URLs que se anuncian en el directorio. PUBLIC_HOST = IP/host por el que los
// navegadores llegan a este equipo; PUBLIC_URL / PEER_URL completas las
// reemplazan (p. ej. un túnel wss:// de ngrok). Si se pega https://... o con
// barra final /, se normaliza automáticamente a wss://... sin barra.
function normalizeWsUrl(raw) {
  const v = (raw || '').trim().replace(/\/+$/, '');
  if (!v || /TU-URL|PONER-AQUI|NGROK-DEL|NGROK-COORD|auto-(rojo|azul|verde)/i.test(v)) return '';
  return v.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
}
// Sufijo para permitir PUBLIC_URL_A / PUBLIC_URL_B / PUBLIC_URL_C en un mismo .env
const idSuffix = COORDINATOR_ID.replace(/^coord-/i, '').toUpperCase();
const PUBLIC_HOST = (process.env.PUBLIC_HOST || 'localhost').trim();
const explicitPublicUrl = normalizeWsUrl(
  cliArg('public-url')
  || process.env[`PUBLIC_URL_${idSuffix}`]
  || process.env.PUBLIC_URL
);
const explicitPeerUrl = normalizeWsUrl(
  cliArg('peer-url')
  || process.env[`PEER_URL_${idSuffix}`]
  || process.env.PEER_URL
);
// Mesh por el MISMO puerto que los jugadores (PEER_PORT = PORT): no se abre un
// puerto aparte para el mesh. Sirve con ngrok, donde cada cuenta gratis tiene
// un solo dominio/túnel.
const MESH_SHARED_PORT = PEER_PORT === PORT;
const PUBLIC_URL = explicitPublicUrl || `ws://${PUBLIC_HOST}:${PORT}`;
// Si hay túnel público (p. ej. wss:// de ngrok) o el mesh comparte el puerto, y
// no se dio PEER_URL aparte, el mesh usa la misma URL (el puerto PORT acepta
// conexiones del mesh en / y en /mesh).
const PEER_URL = explicitPeerUrl
  || (explicitPublicUrl.startsWith('wss://') || MESH_SHARED_PORT ? PUBLIC_URL : `ws://${PUBLIC_HOST}:${PEER_PORT}`);
const STARTED_AT = Date.now();

// Revisa las URLs que se anuncian en el directorio: un error ahí (p. ej.
// "wss://https://xxx.ngrok-free.dev") deja a los jugadores sin poder entrar.
function checkWsUrl(value, name, allowPath) {
  let u;
  try { u = new URL(value); } catch (_) { return `${name}=${value} no es una URL válida`; }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return `${name}=${value} debe empezar con ws:// o wss://`;
  if (!u.hostname || /^https?$/i.test(u.hostname) || value.indexOf('://') !== value.lastIndexOf('://')) {
    return `${name}=${value} tiene el protocolo repetido o no tiene host (ejemplo correcto: wss://xxx.ngrok-free.dev)`;
  }
  if (!allowPath && u.pathname !== '/' && u.pathname !== '') return `${name}=${value} no debe tener ruta (el cliente le agrega /connect)`;
  return null;
}
for (const problem of [checkWsUrl(PUBLIC_URL, 'PUBLIC_URL', false), checkWsUrl(PEER_URL, 'PEER_URL', true)]) {
  if (problem) { console.error(`Configuración inválida: ${problem}`); process.exit(1); }
}
// Taller 7: varios auth replicados. AUTH_URLS (lista) o, como antes, AUTH_URL.
const { parseAuthUrls, createAuthPool } = require('./auth-pool');
const AUTH_URLS = parseAuthUrls(cliArg('auth-urls') || process.env.AUTH_URLS || process.env.AUTH_URL);
const authPool = createAuthPool(AUTH_URLS);
if (AUTH_URLS.length && /localhost|127\.0\.0\.1/.test(PEER_URL) && !AUTH_URLS.some((u) => /localhost|127\.0\.0\.1/.test(u))) {
  console.warn(`Aviso: PEER_URL=${PEER_URL} apunta a localhost pero el directorio está en otro equipo: los coordinadores de otros equipos no podrán conectarse a este. Configurar PUBLIC_HOST (IP LAN) o PEER_URL.`);
}
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
// Sin AUTH_URLS / AUTH_URL = desactivado (solo cuentan el exp del token y SESSION_MAX_AGE).
const AUTH_URL = AUTH_URLS[0] || '';
const TOKEN_POLICY_POLL_MS = parseInt(process.env.TOKEN_POLICY_POLL_MS || '1000', 10);
let authExpiresInS = null; // último valor recibido del auth
// Momento (ms) en que se aplicó cada límite. Una sesión abierta antes de un
// cambio cuenta la nueva duración desde el cambio, no desde su login: si se
// pasa a 30s, se cierra 30 s después de guardar el .env, no al instante.
let authPolicyAt = 0;
let sessionMaxAgeAt = 0;

// Mundo del juego (el cliente lo recibe en 'welcome')
const WORLD_WIDTH = parseInt(process.env.WORLD_WIDTH || '2400', 10);
const WORLD_HEIGHT = parseInt(process.env.WORLD_HEIGHT || '1800', 10);
const PLAYER_RADIUS = parseInt(process.env.PLAYER_RADIUS || '20', 10);
const PLAYER_SPEED = parseInt(process.env.PLAYER_SPEED || '200', 10); // px/seg
const TICK_RATE = parseInt(process.env.TICK_RATE || '20', 10);        // Hz
const TICK_MS = 1000 / TICK_RATE;
// OBSTACLES=off deja el mundo vacío (lo usan los tests de movimiento)
const OBSTACLES = (process.env.OBSTACLES || 'on').trim().toLowerCase() !== 'off';
const PASSENGER_RADIUS = 10;
// En reversa el auto va más lento
const REVERSE_FACTOR = 0.6;
// Partida por rondas: cada ronda dura MATCH_SECONDS; al terminar gana el
// equipo con más pasajeros y, tras MATCH_BREAK_SECONDS, empieza otra
const MATCH_SECONDS = parseInt(process.env.MATCH_SECONDS || '180', 10);
const MATCH_BREAK_SECONDS = parseInt(process.env.MATCH_BREAK_SECONDS || '10', 10);
// Si se cae un coordinador, sus jugadores quedan "en espera" este tiempo (quietos,
// con su posición, extras y puntaje) para que al reconectarse a otro
// coordinador sigan exactamente donde estaban. Pasado el plazo, se borran.
const ORPHAN_GRACE_MS = parseInt(process.env.ORPHAN_GRACE_MS || '15000', 10);
// Balanceo: cada REBALANCE_MS, si este coordinador tiene 2 o más jugadores que el
// menos cargado del mesh, le pide a uno de sus clientes que se mude.
const REBALANCE_MS = parseInt(process.env.REBALANCE_MS || '3000', 10);
// Límite anti-abuso: ws corta (1009) cualquier mensaje más grande que esto
// antes de parsearlo, así nadie puede mandar 10 MB.
const MAX_MESSAGE_BYTES = 4096;
const MAX_EXTRAS_CHARS = 1024;
// --- Examen final ---
// Persistencia (track 2.1): cada PERSIST_MS se guarda el mundo en STATE_DB
// (una SQLite por coordinador). Lo guardado vale SAVED_TTL_MS: un jugador que
// vuelve después ya no recupera su lugar, y una ronda pausada más de
// MATCH_RESUME_MS no se reanuda (empieza otra).
const PERSIST_MS = parseInt(process.env.PERSIST_MS || '2000', 10);
const STATE_DB = cliArg('state-db') || process.env.STATE_DB || `state-${COORDINATOR_ID}.db`;
const SAVED_TTL_MS = parseInt(process.env.SAVED_TTL_MS || String(10 * 60 * 1000), 10);
const MATCH_RESUME_MS = parseInt(process.env.MATCH_RESUME_MS || String(10 * 60 * 1000), 10);
// Espectadores (track 2.5): máximo por coordinador y cada cuántos ticks
// reciben el state (2 = 10 Hz: la mitad del costo de un jugador)
const MAX_SPECTATORS = parseInt(process.env.MAX_SPECTATORS || '50', 10);
const SPECTATOR_EVERY = Math.max(1, parseInt(process.env.SPECTATOR_EVERY || '2', 10));
// Chat (track 2.6): últimos CHAT_HISTORY mensajes en memoria (y en STATE_DB)
const CHAT_HISTORY = parseInt(process.env.CHAT_HISTORY || '50', 10);

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET debe existir en el .env, tener al menos 32 caracteres y ser la misma que usa auth-service');
  process.exit(1);
}

const app = express();
app.get('/health', (req, res) => res.json({
  ok: true, coordinatorId: COORDINATOR_ID, players: players.size, localPlayers: localCount(), spectators: spectators.size,
  tickRate: TICK_RATE, peers: mesh ? mesh.peerIds() : [], leader: mesh ? mesh.leader() : COORDINATOR_ID,
  chatSeq: chat.lastSeq(), savedPlayers: saved.size, round: match.round, phase: match.phase,
}));
// Estado guardado de un jugador (demo de persistencia: ¿dónde quedó alice?)
app.get('/status', (req, res) => {
  const list = [];
  for (const [userId, p] of players) {
    list.push({ userId, username: p.username, x: Math.round(p.x), y: Math.round(p.y), score: p.score, ver: p.ver,
      owner: p.owner, state: p.socket ? 'conectado aquí' : p.owner ? 'en otro coordinador' : 'en espera' });
  }
  for (const [userId, r] of saved) {
    if (!players.has(userId)) list.push({ userId, username: r.username, x: Math.round(r.x || 0), y: Math.round(r.y || 0), score: r.score, ver: r.ver, state: r.deleted ? 'cerró sesión' : 'guardado' });
  }
  res.json({ coordinatorId: COORDINATOR_ID, leader: mesh ? mesh.leader() : COORDINATOR_ID, stateDb: STATE_DB,
    match: matchSnapshot(Date.now()), paused, spectators: spectators.size, players: list });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

// userId -> { username, provider, vehicle, owner, socket, connectedAt, x, y, angle, intent, extras, score }
// Tiene a TODOS los jugadores del mundo: los conectados a este coordinador
// (socket != null, owner = este) y los de los demás coordinadores (socket =
// null, owner = su coordinador), que llegan por el mesh.
const players = new Map();
// Espectadores (track 2.5): sockets sin login, solo lectura. No están en
// players: no tienen auto, no cuentan para el balanceo ni para el marcador.
const spectators = new Set();
// Track 2.1: lo último que se sabe de jugadores que NO están en el mundo ahora
// (se desconectaron, o vienen del disco tras un reinicio). userId -> registro
// { username, provider, vehicle, x, y, angle, score, round, extras, ver, deleted }
// Cuando el jugador vuelve a conectarse, aparece donde quedó.
const saved = new Map();
// Versión de un jugador: reloj lógico híbrido (ver persistence.js)
const bumpVer = (prev) => Math.max(Date.now(), (prev || 0) + 1);
const isLocal = (p) => p.socket !== null;
function localCount() {
  let n = 0;
  for (const p of players.values()) if (isLocal(p)) n++;
  return n;
}
// Se crea al final del archivo si hay AUTH_URL (sin directorio, coordinador solo)
let mesh = null;

// Ciudad: calles y estructuras. Fija mientras viva el proceso.
const city = buildCity(WORLD_WIDTH, WORLD_HEIGHT, PLAYER_RADIUS);
if (!OBSTACLES) { city.obstacles = []; city.blocks = []; }

// Marcador por equipo: la suma de los pasajeros de los conductores CONECTADOS.
// Se calcula en cada tick a partir del Map: cuando un conductor cierra sesión
// su puntaje deja de contar, y si vuelve a entrar arranca en 0 (score es del
// estado de la sesión, no se guarda en ningún lado).
function teamScores() {
  const teams = { uber: 0, taxi: 0 };
  for (const p of players.values()) teams[p.vehicle] += p.score;
  return teams;
}

// Choque entre autos: dos autos son círculos de PLAYER_RADIUS y no pueden
// superponerse. Si se tocan, cada uno retrocede la mitad de lo que se
// penetraron sobre la línea que une sus centros (un auto en movimiento
// empuja al otro). Después se los vuelve a sacar de las manzanas y a meter
// en el mundo. Hasta 8 pasadas: con un auto empujado contra el borde del
// mundo (que lo devuelve) cada pasada reduce a la mitad lo que se pisan, y
// así también quedan separados varios autos juntos.
function separateCars() {
  const cars = Array.from(players.entries());
  const min = 2 * PLAYER_RADIUS;
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i][1], b = cars[j][1];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= min) continue;
        if (d === 0) {
          // Misma posición exacta: separar en una dirección fija según el id
          dx = cars[i][0] < cars[j][0] ? 1 : -1; dy = 0; d = 1;
        }
        const push = (min - d) / 2;
        a.x -= (dx / d) * push; a.y -= (dy / d) * push;
        b.x += (dx / d) * push; b.y += (dy / d) * push;
        moved = true;
      }
    }
    for (const [, p] of cars) {
      [p.x, p.y] = resolve(p.x, p.y, PLAYER_RADIUS, city.obstacles);
      p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, p.x));
      p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y));
    }
    if (!moved) break;
  }
}

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

// --- Partida Uber vs Taxi ---
// 'waiting' (nadie conectado) -> 'playing' (ronda en curso) -> 'ended'
// (ganador en pantalla, no se recogen pasajeros) -> 'playing' (ronda nueva).
// Todo lo decide el servidor; el cliente solo muestra match en cada state.
const match = { phase: 'waiting', round: 0, endsAt: 0, result: null };
// Ronda interrumpida (todos se fueron o se cayeron todos los coordinadores):
// { round, phase, remainingMs, result, pausedAt }. Al volver alguien se
// reanuda donde iba, si no pasó MATCH_RESUME_MS.
let paused = null;

function startRound(now) {
  match.round += 1;
  match.phase = 'playing';
  match.endsAt = now + MATCH_SECONDS * 1000;
  match.result = null;
  for (const p of players.values()) p.score = 0; // cada ronda arranca en 0
  passenger = spawnPassenger();
  console.log(`[partida] empieza la ronda ${match.round} (${MATCH_SECONDS} s)`);
  const event = { type: 'match_start', round: match.round, durationMs: MATCH_SECONDS * 1000 };
  broadcast(event);
  if (mesh) { mesh.send({ type: 'match_event', event }); sendWorldSync(); }
}

// Reanuda la ronda pausada: mismo número, el tiempo que le quedaba y los
// puntajes que traen los jugadores (no se ponen en 0)
function resumeRound(now) {
  match.round = paused.round;
  match.phase = paused.phase;
  match.endsAt = now + paused.remainingMs;
  match.result = paused.result || null;
  paused = null;
  console.log(`[partida] se reanuda la ronda ${match.round} (${match.phase}, quedan ${Math.round((match.endsAt - now) / 1000)} s)`);
  const event = { type: 'match_resume', round: match.round, remainingMs: match.endsAt - now };
  broadcast(event);
  if (mesh) { mesh.send({ type: 'match_event', event }); sendWorldSync(); }
}

function endRound(now) {
  const teams = teamScores();
  const winner = teams.uber > teams.taxi ? 'uber' : teams.taxi > teams.uber ? 'taxi' : 'empate';
  // Podio: los 3 conductores con más pasajeros en la ronda
  const top = Array.from(players.values())
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((p) => ({ username: p.username, vehicle: p.vehicle, score: p.score }));
  match.phase = 'ended';
  match.endsAt = now + MATCH_BREAK_SECONDS * 1000;
  match.result = { winner, teams, top };
  console.log(`[partida] fin de la ronda ${match.round}: ${winner} (uber ${teams.uber} - taxi ${teams.taxi})`);
  const event = { type: 'match_end', round: match.round, ...match.result };
  broadcast(event);
  if (mesh) { mesh.send({ type: 'match_event', event }); sendWorldSync(); }
}

function updateMatch(now) {
  if (players.size === 0) {
    // Sin jugadores no corre el reloj: la ronda queda en pausa y la próxima
    // conexión la reanuda (o arranca otra si pasó mucho tiempo)
    if (match.phase !== 'waiting') {
      paused = { round: match.round, phase: match.phase, remainingMs: Math.max(0, match.endsAt - now), result: match.result, pausedAt: now };
      match.phase = 'waiting';
    }
    return;
  }
  if (match.phase === 'waiting' && paused && now - paused.pausedAt < MATCH_RESUME_MS) resumeRound(now);
  else if (match.phase === 'waiting') startRound(now);
  else if (now >= match.endsAt) {
    if (match.phase === 'playing') endRound(now);
    else startRound(now);
  }
}

// Lo que va en cada state: tiempo RESTANTE (no la hora), así el reloj del
// equipo del cliente no importa
function matchSnapshot(now) {
  return {
    phase: match.phase,
    round: match.round,
    remainingMs: Math.max(0, match.endsAt - now),
    ...(match.phase === 'ended' ? { result: match.result } : {}),
  };
}

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
  // Se avisa al cliente cuánto le queda (cronómetro en pantalla). Va el tiempo
  // RESTANTE y no la hora de cierre: así no importa que el reloj del equipo
  // del cliente no coincida con el de este equipo.
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({
      type: 'session',
      expiresInMs: deadline === Infinity ? null : Math.max(deadline - Date.now(), 0),
      reason,
    }));
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
  for (const { socket } of players.values()) if (socket) scheduleExpiry(socket);
}
if (!MAX_AGE_FROM_ENV) fs.watchFile(ENV_FILE, { interval: 1000 }, reloadSessionMaxAge);

// Consulta periódica al auth. Si no responde (caído, red) se conserva el
// último valor: una falla del auth no debe tumbar sesiones ya validadas.
let authReachable = null;
let policyInFlight = false; // con varios auth un intento puede tardar más que el intervalo
async function pollTokenPolicy() {
  if (policyInFlight) return;
  policyInFlight = true;
  try {
    const { res, body } = await authPool.request('/token-policy', { headers: { 'ngrok-skip-browser-warning': 'true' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { expiresInSeconds } = body;
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) throw new Error('respuesta inválida');
    if (authReachable === false) console.log('[auth] /token-policy responde de nuevo');
    authReachable = true;
    if (expiresInSeconds === authExpiresInS) return;
    const fmt = (s) => (s === null ? 'desconocida' : `${s}s`);
    console.log(`[auth] JWT_EXPIRES_IN: ${fmt(authExpiresInS)} -> ${expiresInSeconds}s (se aplica a ${players.size} sesiones abiertas)`);
    authExpiresInS = expiresInSeconds;
    authPolicyAt = Date.now();
    for (const { socket } of players.values()) if (socket) scheduleExpiry(socket);
  } catch (err) {
    if (authReachable !== false) console.error(`[auth] no se pudo consultar /token-policy en ningún auth (${err.message}); se mantiene la duración anterior`);
    authReachable = false;
  } finally {
    policyInFlight = false;
  }
}
let policyTimer = null;
if (AUTH_URL) {
  pollTokenPolicy();
  policyTimer = setInterval(pollTokenPolicy, TOKEN_POLICY_POLL_MS);
}

// A los clientes de ESTE coordinador (nunca a los pares del mesh). Se
// serializa UNA vez y se manda el mismo texto a todos: con muchos
// espectadores el costo es enviar, no armar el JSON. toSpectators = false
// para lo que no les corresponde (o se les manda aparte, como el state).
function broadcast(obj, toSpectators = true) {
  const msg = JSON.stringify(obj);
  for (const { socket } of players.values()) {
    if (socket && socket.readyState === socket.OPEN) socket.send(msg);
  }
  if (toSpectators) sendToSpectators(msg);
}

function sendToSpectators(msg) {
  for (const ws of spectators) {
    // Un espectador lento (red mala) no acumula estados viejos en memoria:
    // si tiene más de 256 KB sin enviar, se salta este mensaje
    if (ws.readyState === ws.OPEN && ws.bufferedAmount < 256 * 1024) ws.send(msg);
  }
}

// Lista del lobby (solo cambia cuando alguien entra o sale)
function broadcastPlayers() {
  broadcast({ type: 'players_update', players: playerList() });
}

function playerList() {
  return Array.from(players.entries()).map(([userId, p]) => ({
    userId,
    username: p.username,
    provider: p.provider,
    vehicle: p.vehicle,
  }));
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
let tickCount = 0;

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
      // El auto mira hacia donde avanza; en reversa mira al lado contrario
      // (retrocede sin darse vuelta) y va más lento.
      p.angle = p.intent.reverse ? Math.atan2(-iy, -ix) : Math.atan2(iy, ix);
      // Substeps de como mucho medio radio: aunque dt sea grande el auto no
      // puede "saltar" a través de la punta de una estructura.
      const dist = PLAYER_SPEED * (p.intent.reverse ? REVERSE_FACTOR : 1) * dt;
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

  // Jugadores de un coordinador caído que no volvieron a tiempo
  if (mesh) expireOrphans(now);

  // Los autos chocan entre sí en vez de atravesarse
  separateCars();

  // Lo que es de todo el mundo (reloj de la partida, pasajero, puntajes) lo
  // decide UN coordinador, el líder del mesh; los demás lo reciben por
  // world_sync. Sin mesh, este coordinador es el líder.
  const leader = !mesh || mesh.isLeader();
  if (leader) updateMatch(now);

  // Recogida del pasajero: la decide el servidor, nunca el cliente. Solo
  // cuenta mientras la ronda está en juego.
  for (const [userId, p] of players) {
    if (!leader || match.phase !== 'playing') break;
    if (Math.hypot(p.x - passenger.x, p.y - passenger.y) < PLAYER_RADIUS + PASSENGER_RADIUS) {
      p.score += 1;
      const teams = teamScores();
      console.log(`[juego] ${p.username} (${p.vehicle}) recogió al pasajero (${p.score}) | uber ${teams.uber} - taxi ${teams.taxi}`);
      const event = { type: 'pickup', userId, username: p.username, vehicle: p.vehicle, score: p.score };
      broadcast(event);
      passenger = spawnPassenger();
      if (mesh) { mesh.send({ type: 'pickup_replicate', event, passenger }); sendWorldSync(); }
      break;
    }
  }

  // Mesh: posiciones de MIS jugadores a 10 Hz (el dueño manda sobre la
  // posición de sus jugadores) y, si soy el líder, el mundo cada 500 ms
  tickCount += 1;
  if (mesh && tickCount % Math.max(1, Math.round(TICK_RATE / 10)) === 0) sendPlayerSync();
  if (mesh && leader && tickCount % Math.max(1, Math.round(TICK_RATE / 2)) === 0) sendWorldSync();

  // Un solo broadcast por tick (nunca uno por cada intent). Los espectadores
  // lo reciben uno de cada SPECTATOR_EVERY ticks (10 Hz) y, si no hay nadie
  // jugando, igual cada segundo (ven la ciudad vacía y el chat)
  if (players.size > 0 || (spectators.size && tickCount % TICK_RATE === 0)) {
    const msg = JSON.stringify({
      type: 'state', t: now, players: snapshot(), passenger: roundPoint(passenger),
      teams: teamScores(), match: matchSnapshot(now),
    });
    for (const { socket } of players.values()) {
      if (socket && socket.readyState === socket.OPEN) socket.send(msg);
    }
    if (spectators.size && (tickCount % SPECTATOR_EVERY === 0 || players.size === 0)) sendToSpectators(msg);
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

  // Espectador (track 2.5): sin token, solo lectura
  if (pathname === '/spectate') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (spectators.size >= MAX_SPECTATORS) {
        // Lleno: el cliente pide otro coordinador al directorio
        ws.close(4013, 'spectators full');
        return;
      }
      onSpectator(ws);
    });
    return;
  }

  if (pathname !== '/connect') {
    // Mesh por el mismo puerto que los jugadores: los otros coordinadores
    // entran por la raíz o por /mesh (así sirve un peerUrl que sea solo el
    // dominio del túnel, p. ej. wss://xxx.ngrok-free.dev). Los jugadores
    // siempre usan /connect.
    if (mesh && (pathname === '/' || pathname === '/mesh')) {
      mesh.handleUpgrade(req, socket, head);
      return;
    }
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
  // (Si la sesión anterior está en OTRO coordinador, ese la cierra al recibir
  // el player_joined de esta.)
  let existing = players.get(userId);
  // Track 2.1: no está en el mundo, pero hay una copia guardada (se había ido
  // hace poco, o se reiniciaron los coordinadores): vuelve donde quedó
  const restored = !existing ? restoreFromSaved(userId) : null;
  if (restored) {
    existing = restored;
    console.log(`[persistencia] ${username} vuelve donde quedó: (${Math.round(restored.x)}, ${Math.round(restored.y)}), ${restored.score} pasajeros`);
  }
  if (existing && existing.socket) {
    console.log(`[ws] ${username} ya estaba conectado: se cierra la sesión anterior`);
    existing.socket.close(4002, 'session replaced');
  } else if (existing && !restored) {
    console.log(`[ws] ${username} venía de ${existing.owner || "un coordinador caído"}: sigue aquí donde estaba (posición y puntaje)`);
  }

  // Aparece en la calle, nunca dentro de una estructura
  // (y lejos de los otros autos, para no aparecer encima de nadie)
  const spawn = existing || randomFreePoint(PLAYER_RADIUS, Array.from(players.values()), 2 * PLAYER_RADIUS + 10);
  players.set(userId, {
    username,
    provider,
    vehicle,
    owner: COORDINATOR_ID,
    socket: ws,
    connectedAt: new Date().toISOString(),
    x: spawn.x,
    y: spawn.y,
    angle: existing ? existing.angle : 0,
    intent: { x: 0, y: 0 },
    extras: existing ? existing.extras : {},
    score: existing ? existing.score : 0,
    // Sube la versión: esta copia es más nueva que cualquier otra guardada
    ver: bumpVer(existing ? existing.ver : (saved.get(userId) || {}).ver),
    // De qué copia guardada salió (si un par trae una más nueva en los
    // próximos segundos, se corrige: ver mergeSnapshot)
    restoredFromVer: restored ? restored.ver : null,
    restoredAt: restored ? Date.now() : null,
  });
  saved.delete(userId);
  console.log(`[ws] + ${username} [${provider}, ${vehicle}] (${localCount()} aquí, ${players.size} en el mundo)`);
  if (mesh) mesh.send(playerJoinedMsg(userId, players.get(userId)));

  // El cliente necesita el world para dimensionar el canvas
  ws.send(JSON.stringify({
    type: 'welcome',
    you: { userId, username, provider, vehicle },
    // Track 2.1: volvió donde había quedado (posición y pasajeros guardados)
    restored: !!restored,
    // A qué coordinador está conectado (el cliente lo muestra)
    coordinator: { id: COORDINATOR_ID, peers: mesh ? mesh.peerIds() : [] },
    world: {
      width: WORLD_WIDTH, height: WORLD_HEIGHT, playerRadius: PLAYER_RADIUS, tickRate: TICK_RATE,
      passengerRadius: PASSENGER_RADIUS,
      // Solo para dibujar: las colisiones las resuelve el servidor
      cell: city.cell, sidewalk: city.sidewalk, obstacles: city.obstacles, blocks: city.blocks,
    },
  }));
  broadcastPlayers();
  // Track 2.6: el historial del chat (últimos CHAT_HISTORY)
  ws.send(JSON.stringify({ type: 'chat_history', messages: chat.history() }));

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
      // Sanitizar a -1, 0, 1 - NO confiar en lo que mande el cliente.
      // reverse es opcional y solo vale si es exactamente true.
      p.intent = { x: Math.sign(dir.x), y: Math.sign(dir.y), reverse: msg.intent.reverse === true };
      // Los demás coordinadores aplican el mismo intent a su copia del jugador
      if (mesh) mesh.send({ type: 'intent_replicate', userId, intent: { dir: { x: p.intent.x, y: p.intent.y }, reverse: p.intent.reverse } });
      return;
    }

    if (msg.type === 'extras_update') {
      if (!msg.extras || typeof msg.extras !== 'object' || Array.isArray(msg.extras)) return;
      if (JSON.stringify(msg.extras).length > MAX_EXTRAS_CHARS) return; // límite anti-abuso
      // Se guarda en el estado del jugador: se replica en cada tick mientras
      // dure la sesión (no es un evento puntual).
      p.extras = sanitizeExtras(msg.extras, p.vehicle);
      if (mesh) mesh.send({ type: 'extras_replicate', userId, extras: p.extras });
      return;
    }

    if (msg.type === 'chat') {
      onChatFromClient(ws, userId, p, msg.text);
      return;
    }
  });

  // Heartbeat para detectar conexiones muertas
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('close', (code, reason) => {
    clearTimeout(ws.expTimer);
    // Solo borrar si el Map todavía apunta a ESTE socket; si fue reemplazado
    // por una sesión nueva, no se debe eliminar la nueva.
    const current = players.get(userId);
    if (current && current.socket === ws) {
      players.delete(userId);
      // Cerrar sesión borra lo guardado (la próxima vez arranca de cero);
      // cerrar la pestaña o perder la red NO: vuelve donde quedó
      const logout = code === 1000 && ['logout', 'token removed'].includes(String(reason));
      const ver = bumpVer(current.ver);
      saved.set(userId, logout ? { userId, username, ver, deleted: true } : { ...toRecord(userId, current), ver });
      console.log(`[ws] - ${username} (${localCount()} aquí, ${players.size} en el mundo)${logout ? ' · cerró sesión' : ' · queda guardado'}`);
      broadcastPlayers();
      if (mesh) mesh.send({ type: 'player_left', userId, logout, ver });
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
  if (mesh) mesh.close();
  clearTimeout(gameLoop);
  fs.unwatchFile(ENV_FILE, reloadSessionMaxAge);
  clearInterval(policyTimer);
  clearInterval(rebalanceTimer);
  clearInterval(chatTimer);
  clearInterval(persistTimer);
});

// ===================== Mesh (Taller 6) =====================
// Cada coordinador simula a TODOS los jugadores con los intents que recibe
// (locales y replicados), pero:
// - el dueño de un jugador (el coordinador al que está conectado) manda sobre
//   su posición: la publica a 10 Hz (player_sync) y los demás corrigen su copia;
// - lo que es de todo el mundo (pasajero, ronda, puntajes) lo decide el líder
//   y lo publica cada 500 ms y en cada evento (world_sync).
// Así las copias no se desfasan aunque los ticks de cada proceso no coincidan.

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clampX = (x) => Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, x));
const clampY = (y) => Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, y));

function playerJoinedMsg(userId, p) {
  return {
    type: 'player_joined', userId, username: p.username, provider: p.provider, vehicle: p.vehicle,
    x: p.x, y: p.y, angle: p.angle, extras: p.extras, score: p.score, ver: p.ver,
  };
}

function sendPlayerSync() {
  const list = [];
  for (const [userId, p] of players) {
    if (!isLocal(p)) continue;
    // El dueño sube la versión cada vez que publica la posición
    p.ver = bumpVer(p.ver);
    list.push({ userId, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, angle: p.angle, v: p.ver });
  }
  if (list.length) mesh.send({ type: 'player_sync', players: list });
}

function sendWorldSync() {
  const scores = {};
  for (const [userId, p] of players) scores[userId] = p.score;
  mesh.send({ type: 'world_sync', passenger, match: matchSnapshot(Date.now()), scores });
}

// Intent replicado: mismas reglas que el de un cliente (-1/0/1, reverse === true)
function sanitizeIntent(intent) {
  const dir = intent && intent.dir;
  if (!dir || !isFiniteNum(dir.x) || !isFiniteNum(dir.y)) return null;
  return { x: Math.sign(dir.x), y: Math.sign(dir.y), reverse: intent.reverse === true };
}

function onPeerMessage(msg, peerId) {
  const userId = typeof msg.userId === 'string' || typeof msg.userId === 'number' ? String(msg.userId) : null;
  const p = userId ? players.get(userId) : null;
  // Solo el dueño de un jugador puede moverlo o cambiar sus extras
  const ownedByPeer = p && p.owner === peerId;

  switch (msg.type) {
    case 'player_joined': {
      if (!userId || typeof msg.username !== 'string') return;
      const vehicle = msg.vehicle === 'uber' ? 'uber' : 'taxi';
      const prev = players.get(userId);
      players.set(userId, {
        username: msg.username.slice(0, 32),
        provider: msg.provider === 'google' ? 'google' : 'local',
        vehicle,
        owner: peerId,
        socket: null,
        connectedAt: new Date().toISOString(),
        x: isFiniteNum(msg.x) ? clampX(msg.x) : PLAYER_RADIUS,
        y: isFiniteNum(msg.y) ? clampY(msg.y) : PLAYER_RADIUS,
        angle: isFiniteNum(msg.angle) ? msg.angle : 0,
        intent: { x: 0, y: 0 },
        extras: msg.extras && typeof msg.extras === 'object' && !Array.isArray(msg.extras) && JSON.stringify(msg.extras).length <= MAX_EXTRAS_CHARS
          ? sanitizeExtras(msg.extras, vehicle) : {},
        score: Number.isInteger(msg.score) && msg.score >= 0 ? msg.score : 0,
        ver: isFiniteNum(msg.ver) ? msg.ver : 0,
      });
      saved.delete(userId);
      // La misma cuenta se abrió en otro coordinador: esta sesión se cierra
      // (gana la nueva, igual que con dos pestañas en el mismo coordinador)
      if (prev && prev.socket) {
        console.log(`[mesh] ${msg.username} abrió sesión en ${peerId}: se cierra la de aquí`);
        prev.socket.close(4002, 'session replaced');
      }
      broadcastPlayers();
      return;
    }
    case 'player_left':
      if (ownedByPeer) {
        const ver = isFiniteNum(msg.ver) ? msg.ver : bumpVer(p.ver);
        saved.set(userId, msg.logout === true ? { userId, username: p.username, ver, deleted: true } : { ...toRecord(userId, p), ver });
        players.delete(userId);
        broadcastPlayers();
      }
      return;
    case 'intent_replicate': {
      const intent = sanitizeIntent(msg.intent);
      if (ownedByPeer && intent) p.intent = intent;
      return;
    }
    case 'extras_replicate':
      if (!ownedByPeer || !msg.extras || typeof msg.extras !== 'object' || Array.isArray(msg.extras)) return;
      if (JSON.stringify(msg.extras).length > MAX_EXTRAS_CHARS) return;
      p.extras = sanitizeExtras(msg.extras, p.vehicle);
      return;
    case 'player_sync':
      if (!Array.isArray(msg.players)) return;
      for (const s of msg.players) {
        const q = s && players.get(String(s.userId));
        if (!q || q.owner !== peerId || !isFiniteNum(s.x) || !isFiniteNum(s.y)) continue;
        // Corrección suave: la copia ya viene avanzando con el intent replicado,
        // así que la diferencia suele ser de pocos px. Saltar de golpe a la
        // posición del dueño hacía que los autos remotos "tironearan"; se
        // acerca un 35 % por sync en movimiento (60 % si está quieto, para
        // que quede en el lugar exacto enseguida) y solo se salta si la
        // diferencia es grande.
        const tx = clampX(s.x), ty = clampY(s.y);
        const err = Math.hypot(tx - q.x, ty - q.y);
        const k = q.intent.x || q.intent.y ? 0.35 : 0.6;
        if (err > 3 * PLAYER_RADIUS) { q.x = tx; q.y = ty; } else { q.x += (tx - q.x) * k; q.y += (ty - q.y) * k; }
        if (isFiniteNum(s.angle)) q.angle = s.angle;
        if (isFiniteNum(s.v) && s.v > (q.ver || 0)) q.ver = s.v;
      }
      return;
    case 'world_sync':
      if (peerId !== mesh.leader()) return; // el mundo solo lo decide el líder
      applyWorld(msg);
      return;
    case 'pickup_replicate': {
      if (peerId !== mesh.leader() || !msg.event || msg.event.type !== 'pickup') return;
      const q = players.get(String(msg.event.userId));
      if (q && Number.isInteger(msg.event.score)) q.score = msg.event.score;
      if (msg.passenger && isFiniteNum(msg.passenger.x) && isFiniteNum(msg.passenger.y)) passenger = { x: msg.passenger.x, y: msg.passenger.y };
      broadcast(msg.event); // el aviso de "X recogió al pasajero" a mis clientes
      return;
    }
    case 'match_event':
      if (peerId !== mesh.leader() || !msg.event || !['match_start', 'match_end', 'match_resume'].includes(msg.event.type)) return;
      broadcast(msg.event);
      return;
    // Track 2.6: el líder numera; todos entregan en orden de número
    case 'chat_submit':
      chat.onSubmit(msg.msg, peerId);
      return;
    case 'chat_ordered':
      if (!msg.msg || msg.msg.orderedBy !== peerId) return;
      chat.onOrdered(msg.msg);
      return;
    // Track 2.1: lo que tiene guardado un par que acaba de conectarse
    case 'state_snapshot':
      mergeSnapshot(msg, peerId);
      return;
    default:
  }
}

function applyWorld(msg) {
  if (msg.passenger && isFiniteNum(msg.passenger.x) && isFiniteNum(msg.passenger.y)) {
    passenger = { x: msg.passenger.x, y: msg.passenger.y };
  }
  const m = msg.match;
  if (m && ['waiting', 'playing', 'ended'].includes(m.phase) && Number.isInteger(m.round) && isFiniteNum(m.remainingMs)) {
    match.phase = m.phase;
    match.round = m.round;
    match.endsAt = Date.now() + m.remainingMs; // relativo: no depende del reloj del líder
    match.result = m.phase === 'ended' && m.result ? m.result : null;
    paused = null; // la partida la decide el líder
  }
  if (msg.scores && typeof msg.scores === 'object') {
    for (const [userId, score] of Object.entries(msg.scores)) {
      const q = players.get(userId);
      if (q && Number.isInteger(score) && score >= 0) q.score = score;
    }
  }
}

function onPeerUp(peerId) {
  // Al par nuevo le cuento quiénes están conectados aquí y, si soy el líder,
  // cómo está el mundo
  for (const [userId, p] of players) if (isLocal(p)) mesh.sendTo(peerId, playerJoinedMsg(userId, p));
  if (mesh.isLeader()) sendWorldSync();
  // Track 2.1: y todo lo que tengo guardado, para que reconcilie con lo suyo
  mesh.sendTo(peerId, { type: 'state_snapshot', ...snapshotForPeer() });
}

function onPeerDown(peerId) {
  // Se cayó un coordinador: sus jugadores NO se borran. Quedan en espera
  // (owner = null) con su posición, extras y puntaje durante ORPHAN_GRACE_MS:
  // sus clientes se reconectan solos a otro coordinador y ahí siguen donde
  // estaban (la conexión nueva hereda esta copia), sin teletransportarse ni
  // perder sus pasajeros. Si no vuelven en el plazo, expireOrphans los borra.
  let orphaned = 0;
  const now = Date.now();
  for (const p of players.values()) {
    if (p.owner === peerId) {
      p.owner = null;
      p.orphanSince = now;
      p.intent = { x: 0, y: 0 }; // quieto mientras se reconecta
      orphaned++;
    }
  }
  if (orphaned) console.log(`[mesh] ${orphaned} jugador(es) de ${peerId} en espera de reconexión (${ORPHAN_GRACE_MS / 1000} s)`);
}

function expireOrphans(now) {
  let removed = 0;
  for (const [userId, p] of players) {
    if (p.owner === null && now - p.orphanSince > ORPHAN_GRACE_MS) {
      // Sale del mundo pero queda guardado: si vuelve más tarde, aparece ahí
      saved.set(userId, toRecord(userId, p));
      players.delete(userId);
      removed++;
    }
  }
  if (removed) {
    console.log(`[mesh] ${removed} jugador(es) no volvieron a conectarse: se borran`);
    broadcastPlayers();
  }
}

// Balanceo de carga entre coordinadores. La carga de cada uno se sabe por el
// mesh (owner de cada jugador). Si este tiene 2 o más jugadores que el menos
// cargado, le pide a UNO de sus clientes que se mude ({ type: 'migrate' }). El
// cliente pide otro coordinador al directorio y se conecta ANTES de soltar
// este (la sesión nueva hereda posición y puntaje y este cierra la vieja con
// 4002): no hay corte. Uno por ciclo y nunca el mismo cliente dos veces en
// 15 s, para no rebotar jugadores de un lado a otro.
function rebalance() {
  if (!mesh) return;
  const peerIds = mesh.peerIds();
  if (!peerIds.length) return;
  const load = new Map([[COORDINATOR_ID, 0], ...peerIds.map((id) => [id, 0])]);
  for (const p of players.values()) if (load.has(p.owner)) load.set(p.owner, load.get(p.owner) + 1);
  const mine = load.get(COORDINATOR_ID);
  const min = Math.min(...load.values());
  if (mine - min < 2) return;
  const now = Date.now();
  const candidate = Array.from(players.values())
    .filter((p) => isLocal(p) && p.socket.readyState === p.socket.OPEN && !(now - (p.migrateAskedAt || 0) < 15000))
    .sort((a, b) => (a.connectedAt < b.connectedAt ? 1 : -1))[0]; // el que llegó último
  if (!candidate) return;
  candidate.migrateAskedAt = now;
  console.log(`[balanceo] ${COORDINATOR_ID} tiene ${mine} y el menos cargado ${min}: ${candidate.username} se muda`);
  candidate.socket.send(JSON.stringify({ type: 'migrate', reason: 'balance' }));
}

// ===================== Espectadores (track 2.5) =====================
// Reciben lo mismo que un jugador (state, eventos, chat) pero no tienen auto:
// todo lo que manden se ignora. No cuentan en connectedPlayers (el balanceo
// de jugadores no los ve); el directorio los reparte aparte (?role=spectator).
// Costo: el state se serializa una vez por tick y se les manda a 10 Hz, con
// un máximo de MAX_SPECTATORS por coordinador (ver README).
function onSpectator(ws) {
  spectators.add(ws);
  ws.spectator = true;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  console.log(`[espectador] + (${spectators.size}/${MAX_SPECTATORS} aquí)`);
  ws.send(JSON.stringify({
    type: 'welcome', spectator: true, you: null,
    coordinator: { id: COORDINATOR_ID, peers: mesh ? mesh.peerIds() : [] },
    world: {
      width: WORLD_WIDTH, height: WORLD_HEIGHT, playerRadius: PLAYER_RADIUS, tickRate: TICK_RATE,
      passengerRadius: PASSENGER_RADIUS, spectatorHz: TICK_RATE / SPECTATOR_EVERY,
      cell: city.cell, sidewalk: city.sidewalk, obstacles: city.obstacles, blocks: city.blocks,
    },
  }));
  ws.send(JSON.stringify({ type: 'players_update', players: playerList() }));
  ws.send(JSON.stringify({ type: 'chat_history', messages: chat.history() }));
  // Solo lectura: se ignora todo (sin parsear siquiera más de lo necesario).
  // Uno que inunda (más de 30 mensajes en 1 s) se desconecta.
  let windowStart = Date.now();
  let count = 0;
  let warnedAt = 0;
  ws.on('message', (raw) => {
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; count = 0; }
    if (++count > 30) { ws.close(4008, 'flood'); return; }
    let type = '?';
    try { type = String((JSON.parse(raw.toString()) || {}).type).slice(0, 20); } catch (_) {}
    if (now - warnedAt > 1000) {
      warnedAt = now;
      console.log(`[espectador] mensaje "${type}" ignorado: los espectadores son de solo lectura`);
      ws.send(JSON.stringify({ type: 'spectator_ignored', reason: 'read_only', ignored: type }));
    }
  });
  ws.on('close', () => {
    spectators.delete(ws);
    console.log(`[espectador] - (${spectators.size} aquí)`);
  });
  ws.on('error', () => {});
}

// ===================== Chat distribuido (track 2.6) =====================
const chatLimiter = createRateLimiter();
const chat = createChat({
  selfId: COORDINATOR_ID,
  historySize: CHAT_HISTORY,
  isLeader: () => !mesh || mesh.isLeader(),
  sendToLeader: (m) => { if (mesh) mesh.sendTo(mesh.leader(), m); },
  sendToPeers: (m) => { if (mesh) mesh.send(m); },
  deliver: (m) => broadcast({ type: 'chat', message: m }),
});
const chatTimer = setInterval(() => chat.maintain(), 1000);

function onChatFromClient(ws, userId, p, text) {
  const clean = sanitizeChatText(text);
  if (clean.error) {
    ws.send(JSON.stringify({ type: 'chat_error', reason: clean.error, maxChars: CHAT_MAX_CHARS }));
    return;
  }
  // Por usuario (no por socket): reconectar no reinicia el límite
  const limit = chatLimiter(userId);
  if (!limit.ok) {
    if (limit.justMuted) console.log(`[chat] ${p.username} silenciado ${limit.retryInMs / 1000} s por insistir con el límite`);
    ws.send(JSON.stringify({ type: 'chat_error', reason: limit.reason, retryInMs: limit.retryInMs }));
    return;
  }
  chat.submit({ userId, username: p.username, vehicle: p.vehicle, text: clean.text });
}

// ===================== Persistencia (track 2.1) =====================
// Registro de un jugador para guardar o mandar a un par
function toRecord(userId, p) {
  return {
    userId, username: p.username, provider: p.provider, vehicle: p.vehicle,
    x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, angle: p.angle,
    score: p.score, round: match.phase === 'waiting' && paused ? paused.round : match.round,
    extras: p.extras, ver: p.ver || 0,
  };
}

const isFresh = (ver, now = Date.now()) => isFiniteNum(ver) && now - ver < SAVED_TTL_MS;

// Copia guardada utilizable para un jugador que se conecta (o null)
function restoreFromSaved(userId) {
  const r = saved.get(userId);
  if (!r || r.deleted || !isFresh(r.ver) || !isFiniteNum(r.x) || !isFiniteNum(r.y)) return null;
  // Sus pasajeros solo cuentan si es la misma ronda (si no, ya se reinició)
  const round = match.phase === 'waiting' && paused ? paused.round : match.round;
  return {
    x: clampX(r.x), y: clampY(r.y), angle: isFiniteNum(r.angle) ? r.angle : 0,
    extras: r.extras && typeof r.extras === 'object' ? sanitizeExtras(r.extras, r.vehicle === 'uber' ? 'uber' : 'taxi') : {},
    score: r.round === round && Number.isInteger(r.score) && r.score >= 0 ? r.score : 0,
    ver: r.ver, socket: null,
  };
}

// La partida tal como se guarda o se manda a un par. savedAt: momento del dato.
function matchRecord(now = Date.now()) {
  if (match.phase !== 'waiting') {
    return { round: match.round, phase: match.phase, remainingMs: Math.max(0, match.endsAt - now), result: match.result, savedAt: now };
  }
  if (paused) return { ...paused, savedAt: paused.pausedAt };
  return { round: match.round, phase: 'waiting', remainingMs: 0, result: null, savedAt: now };
}

// Cuánto avanzó una partida: ronda, y dentro de la ronda, cuánto tiempo pasó.
// No depende de los relojes: sirve para decidir cuál de dos copias es la más
// reciente (una ronda más adelantada siempre es posterior).
function matchProgress(m) {
  if (!m || !Number.isInteger(m.round)) return -1;
  const phaseBase = m.phase === 'ended' ? MATCH_SECONDS * 1000 : 0;
  const total = m.phase === 'ended' ? MATCH_BREAK_SECONDS * 1000 : MATCH_SECONDS * 1000;
  const elapsed = m.phase === 'waiting' ? 0 : Math.max(0, total - (m.remainingMs || 0));
  return m.round * 1e9 + phaseBase + elapsed;
}

function snapshotForPeer() {
  const now = Date.now();
  const list = [];
  for (const [userId, p] of players) list.push(toRecord(userId, p));
  for (const [userId, r] of saved) if (!players.has(userId) && isFresh(r.ver, now)) list.push(r);
  return { players: list, match: matchRecord(now), passenger, chat: chat.history(), chatSeq: chat.lastSeq() };
}

// Reconciliación con lo que trae un par: por jugador gana la versión mayor.
// Un jugador que está en el mundo (conectado a algún coordinador) no se toca:
// su dueño lo publica en vivo y siempre tiene la versión más nueva.
function mergeSnapshot(msg, peerId) {
  const now = Date.now();
  let adopted = 0;
  for (const r of Array.isArray(msg.players) ? msg.players : []) {
    if (!r || (typeof r.userId !== 'string' && typeof r.userId !== 'number') || !isFresh(r.ver, now)) continue;
    const userId = String(r.userId);
    const live = players.get(userId);
    // Carrera al arrancar: el jugador se reconectó aquí con una copia vieja
    // del disco ANTES de que llegara la del par, que es más nueva. Se lo
    // corrige a la más nueva (pocos segundos después de reconectarse).
    if (live && isLocal(live) && live.restoredAt && now - live.restoredAt < 15000 && !r.deleted
        && r.ver > live.restoredFromVer && isFiniteNum(r.x) && isFiniteNum(r.y)) {
      live.x = clampX(r.x); live.y = clampY(r.y);
      const round = match.phase === 'waiting' && paused ? paused.round : match.round;
      if (r.round === round && Number.isInteger(r.score)) live.score = r.score;
      live.restoredFromVer = r.ver;
      console.log(`[persistencia] ${live.username}: ${peerId} tenía una copia más nueva, se corrige a (${Math.round(live.x)}, ${Math.round(live.y)})`);
      adopted++;
      continue;
    }
    if (live && live.owner !== null) continue;
    const mine = live ? live.ver || 0 : (saved.get(userId) || {}).ver || 0;
    if (r.ver <= mine) continue;
    const rec = r.deleted ? { userId, username: String(r.username || ''), ver: r.ver, deleted: true }
      : { userId, username: String(r.username || '').slice(0, 32), provider: r.provider === 'google' ? 'google' : 'local',
        vehicle: r.vehicle === 'uber' ? 'uber' : 'taxi', x: Number(r.x), y: Number(r.y), angle: Number(r.angle) || 0,
        score: Number.isInteger(r.score) ? r.score : 0, round: Number.isInteger(r.round) ? r.round : 0,
        extras: r.extras && typeof r.extras === 'object' && !Array.isArray(r.extras) ? r.extras : {}, ver: r.ver };
    if (live) {
      // Jugador en espera (su coordinador se cayó): la copia del par es más nueva
      if (!rec.deleted && isFiniteNum(rec.x) && isFiniteNum(rec.y)) { live.x = clampX(rec.x); live.y = clampY(rec.y); live.ver = rec.ver; }
    } else {
      saved.set(userId, rec);
    }
    adopted++;
  }
  // Partida: gana la más avanzada, si es reciente
  const m = msg.match;
  if (m && ['waiting', 'playing', 'ended'].includes(m.phase) && isFiniteNum(m.savedAt) && now - m.savedAt < MATCH_RESUME_MS
      && matchProgress(m) > matchProgress(matchRecord(now)) && m.phase !== 'waiting') {
    if (match.phase === 'waiting') {
      paused = { round: m.round, phase: m.phase, remainingMs: Math.max(0, m.remainingMs || 0), result: m.result || null, pausedAt: m.savedAt };
      match.round = Math.max(match.round, m.round);
    } else if (!mesh || mesh.isLeader()) {
      match.round = m.round; match.phase = m.phase; match.endsAt = now + Math.max(0, m.remainingMs || 0); match.result = m.result || null;
      sendWorldSync();
    }
    if (msg.passenger && isFiniteNum(msg.passenger.x) && isFiniteNum(msg.passenger.y)) passenger = { x: msg.passenger.x, y: msg.passenger.y };
    console.log(`[persistencia] ${peerId} tenía la partida más avanzada (ronda ${m.round}, ${m.phase}): se adopta`);
  }
  chat.merge(msg.chat, msg.chatSeq);
  if (adopted) console.log(`[persistencia] ${adopted} jugador(es) más recientes en lo guardado de ${peerId}`);
}

let store = null;
let persistTimer = null;
function persist() {
  if (!store) return;
  const now = Date.now();
  const list = [];
  for (const [userId, p] of players) list.push(toRecord(userId, p));
  for (const [userId, r] of saved) if (!players.has(userId)) list.push(r);
  try {
    store.save({
      players: list,
      world: { match: matchRecord(now), passenger, chat: { messages: chat.history(), lastSeq: chat.lastSeq() } },
      minVer: now - SAVED_TTL_MS,
    });
  } catch (err) {
    console.error(`[persistencia] no se pudo guardar en ${STATE_DB}: ${err.message}`);
  }
}

// Al arrancar: recuperar lo último guardado
function restoreState() {
  try {
    store = createStore(STATE_DB);
  } catch (err) {
    console.error(`[persistencia] no se pudo abrir ${STATE_DB}: ${err.message} (sigue sin persistencia)`);
    return;
  }
  const now = Date.now();
  let n = 0;
  for (const r of store.loadPlayers()) {
    if (!isFresh(r.ver, now)) continue;
    saved.set(String(r.userId), r);
    n++;
  }
  const m = store.loadWorld('match');
  if (m && Number.isInteger(m.round)) {
    match.round = m.round;
    if (m.phase !== 'waiting' && isFiniteNum(m.savedAt) && now - m.savedAt < MATCH_RESUME_MS) {
      paused = { round: m.round, phase: m.phase, remainingMs: Math.max(0, m.remainingMs || 0), result: m.result || null, pausedAt: m.savedAt };
    }
  }
  const pas = store.loadWorld('passenger');
  if (pas && isFiniteNum(pas.x) && isFiniteNum(pas.y) && !collides(pas.x, pas.y, PASSENGER_RADIUS, city.obstacles)) passenger = pas;
  const c = store.loadWorld('chat');
  if (c) chat.merge(c.messages, c.lastSeq);
  if (n || paused) {
    console.log(`[persistencia] recuperado de ${STATE_DB}: ${n} jugador(es)`
      + (paused ? `, ronda ${paused.round} pausada (quedan ${Math.round(paused.remainingMs / 1000)} s)` : '')
      + `, ${chat.history().length} mensajes de chat`);
  }
  persistTimer = setInterval(persist, PERSIST_MS);
}
restoreState();

// Ctrl+C / kill: último guardado antes de salir (si el proceso muere de golpe
// se pierde a lo sumo PERSIST_MS)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    persist();
    process.exit(0);
  });
}

let rebalanceTimer = null;
if (AUTH_URL && (process.env.MESH || 'on').trim().toLowerCase() !== 'off') {
  rebalanceTimer = setInterval(rebalance, REBALANCE_MS);
  mesh = createMesh({
    id: COORDINATOR_ID, peerPort: MESH_SHARED_PORT ? null : PEER_PORT, publicUrl: PUBLIC_URL, peerUrl: PEER_URL,
    auth: authPool, secret: JWT_SECRET, startedAt: STARTED_AT,
    getConnectedPlayers: localCount, getSpectators: () => spectators.size,
    onMessage: onPeerMessage, onPeerUp, onPeerDown,
  });
}

server.listen(PORT, () => {
  console.log(`Coordinador en puerto ${PORT} (${COORDINATOR_ID}, game loop a ${TICK_RATE} Hz, mundo ${WORLD_WIDTH}x${WORLD_HEIGHT}, ${city.obstacles.length} estructuras)`);
  if (mesh) console.log(`  mesh: pares en ${PEER_URL}, clientes en ${PUBLIC_URL}, directorio ${AUTH_URLS.join(', ')}`);
  else console.log('  sin AUTH_URL: funciona solo (sin directorio ni mesh)');
});
