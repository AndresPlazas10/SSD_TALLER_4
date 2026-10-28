require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || '30000', 10);
const AUTH_URL = process.env.AUTH_URL || 'http://localhost:4000';
const POLICY_POLL_MS = parseInt(process.env.POLICY_POLL_MS || '5000', 10);

if (!JWT_SECRET) {
  console.error('Falta JWT_SECRET en el .env (debe ser la misma que usa auth-service)');
  process.exit(1);
}

// Duración vigente de los tokens según el auth (su JWT_EXPIRES_IN). Un token ya
// firmado no se puede cambiar, así que si el auth reduce la duración en caliente
// la sesión vence en iat + duración vigente, aunque el token diga una exp mayor.
let policySeconds = null;
async function refreshPolicy() {
  try {
    const res = await fetch(`${AUTH_URL}/token-policy`);
    const { expiresInSeconds } = await res.json();
    if (Number.isFinite(expiresInSeconds) && expiresInSeconds !== policySeconds) {
      policySeconds = expiresInSeconds;
      console.log(`[policy] duración de sesión: ${policySeconds} s`);
    }
  } catch (_) {
    // Auth caído: se mantiene la última duración conocida
  }
}
refreshPolicy();
setInterval(refreshPolicy, POLICY_POLL_MS);

function isExpired({ iat, exp }) {
  const limit = policySeconds === null ? exp : Math.min(exp, iat + policySeconds);
  return Date.now() / 1000 >= limit;
}

const app = express();
app.get('/health', (req, res) => res.json({ ok: true, players: players.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// userId -> { username, socket, connectedAt }
const players = new Map();

function broadcastPlayers() {
  const list = Array.from(players.entries()).map(([userId, p]) => ({
    userId,
    username: p.username,
  }));
  const msg = JSON.stringify({ type: 'players_update', players: list });
  for (const { socket } of players.values()) {
    if (socket.readyState === socket.OPEN) socket.send(msg);
  }
}

// La verificación del JWT se hace en el 'upgrade', ANTES de registrar al jugador.
// Un cliente con token inválido nunca llega a 'connection' ni entra al Map.
// Nota: para que el navegador pueda leer el código 4001 hay que completar el
// handshake y cerrar inmediatamente con ese código (con un 401 HTTP el navegador
// solo ve un cierre genérico 1006).
server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);

  if (pathname !== '/connect') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  let payload = null;
  try {
    if (typeof query.token !== 'string' || !query.token) throw new Error('missing token');
    payload = jwt.verify(query.token, JWT_SECRET, { algorithms: ['HS256'] });
    if (!payload.userId || !payload.username) throw new Error('bad payload');
    if (isExpired(payload)) throw new Error('vencido por la duración vigente');
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

  // Decisión de diseño (ver README): si el usuario ya está conectado,
  // se desconecta la sesión anterior y gana la nueva.
  const existing = players.get(userId);
  if (existing) {
    console.log(`[ws] ${username} ya estaba conectado: se cierra la sesión anterior`);
    existing.socket.close(4002, 'session replaced');
  }

  players.set(userId, { username, socket: ws, connectedAt: Date.now() });
  console.log(`[ws] + ${username} (${players.size} en línea)`);
  broadcastPlayers();

  // Para cerrar el socket cuando la sesión venza (ver expiryCheck)
  ws.token = { iat: payload.iat, exp: payload.exp };

  // Re-verificación: el cliente reenvía periódicamente el token que tiene en
  // localStorage. Si ya no es válido (corrupto, vencido o de otro usuario) se
  // cierra la conexión igual que en el upgrade.
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    if (msg.type !== 'token_check') return;
    try {
      const current = jwt.verify(msg.token, JWT_SECRET, { algorithms: ['HS256'] });
      if (String(current.userId) !== userId) throw new Error('token de otro usuario');
    } catch (err) {
      console.log(`[ws] ${username}: token rechazado en re-verificación (${err.message})`);
      ws.close(4001, err.name === 'TokenExpiredError' ? 'token expired' : 'invalid token');
    }
  });

  // Heartbeat para detectar conexiones muertas
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('close', () => {
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

// La sesión no dura más que el token: cada segundo se cierran las que ya
// vencieron (por su exp o por una duración reducida en caliente en el auth).
const expiryCheck = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.token && ws.readyState === ws.OPEN && isExpired(ws.token)) {
      ws.close(4001, 'token expired');
    }
  }
}, 1000);

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(expiryCheck);
});

server.listen(PORT, () => {
  console.log(`Coordinador en puerto ${PORT}`);
});
