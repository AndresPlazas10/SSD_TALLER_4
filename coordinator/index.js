require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || '30000', 10);
// Auth y coordinador corren en equipos distintos: sus relojes no son idénticos.
// Se toleran unos segundos de diferencia al validar exp/iat del JWT.
const JWT_CLOCK_TOLERANCE_S = parseInt(process.env.JWT_CLOCK_TOLERANCE_S || '5', 10);

// Mundo del juego (el cliente lo recibe en 'welcome')
const WORLD_WIDTH = parseInt(process.env.WORLD_WIDTH || '800', 10);
const WORLD_HEIGHT = parseInt(process.env.WORLD_HEIGHT || '600', 10);
const PLAYER_RADIUS = parseInt(process.env.PLAYER_RADIUS || '20', 10);
const PLAYER_SPEED = parseInt(process.env.PLAYER_SPEED || '200', 10); // px/seg
const TICK_RATE = parseInt(process.env.TICK_RATE || '20', 10);        // Hz
const TICK_MS = 1000 / TICK_RATE;
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

// userId -> { username, provider, socket, connectedAt, x, y, intent, extras }
// Este Map es la ÚNICA fuente de verdad de las posiciones.
const players = new Map();

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
  }));
  broadcast({ type: 'players_update', players: list });
}

// Estado público de cada jugador. Nunca se envía el socket ni el intent.
function snapshot() {
  return Array.from(players.entries()).map(([userId, p]) => ({
    userId,
    username: p.username,
    provider: p.provider,
    x: Math.round(p.x * 10) / 10,
    y: Math.round(p.y * 10) / 10,
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
      p.x += (ix / mag) * PLAYER_SPEED * dt;
      p.y += (iy / mag) * PLAYER_SPEED * dt;
    }

    // Mantener dentro del mundo
    p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y));
  }

  // Un solo broadcast por tick (nunca uno por cada intent)
  if (players.size > 0) broadcast({ type: 'state', t: now, players: snapshot() });
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

  // Decisión de diseño (ver README): si el usuario ya está conectado,
  // se desconecta la sesión anterior y gana la nueva. La nueva hereda la
  // posición y los extras: es el mismo jugador, no uno nuevo.
  const existing = players.get(userId);
  if (existing) {
    console.log(`[ws] ${username} ya estaba conectado: se cierra la sesión anterior`);
    existing.socket.close(4002, 'session replaced');
  }

  players.set(userId, {
    username,
    provider,
    socket: ws,
    connectedAt: new Date().toISOString(),
    x: existing ? existing.x : PLAYER_RADIUS + Math.random() * (WORLD_WIDTH - 2 * PLAYER_RADIUS),
    y: existing ? existing.y : PLAYER_RADIUS + Math.random() * (WORLD_HEIGHT - 2 * PLAYER_RADIUS),
    intent: { x: 0, y: 0 },
    extras: existing ? existing.extras : {},
  });
  console.log(`[ws] + ${username} [${provider}] (${players.size} en línea)`);

  // El cliente necesita el world para dimensionar el canvas
  ws.send(JSON.stringify({
    type: 'welcome',
    you: { userId, username, provider },
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT, playerRadius: PLAYER_RADIUS, tickRate: TICK_RATE },
  }));
  broadcastPlayers();

  // Cerrar el socket cuando el token expire (la sesión no dura más que el JWT)
  let expTimer = null;
  if (payload.exp) {
    const ms = payload.exp * 1000 - Date.now();
    expTimer = setTimeout(() => {
      if (ws.readyState === ws.OPEN) ws.close(4001, 'token expired');
    }, Math.max(ms, 0));
  }

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
      p.extras = msg.extras;
      return;
    }
  });

  // Heartbeat para detectar conexiones muertas
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('close', () => {
    clearTimeout(expTimer);
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
});

server.listen(PORT, () => {
  console.log(`Coordinador en puerto ${PORT} (game loop a ${TICK_RATE} Hz, mundo ${WORLD_WIDTH}x${WORLD_HEIGHT})`);
});
