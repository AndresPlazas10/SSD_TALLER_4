require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || '30000', 10);

if (!JWT_SECRET) {
  console.error('Falta JWT_SECRET en el .env (debe ser la misma que usa auth-service)');
  process.exit(1);
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

  // Cerrar el socket cuando el token expire (la sesión no dura más que el JWT)
  let expTimer = null;
  if (payload.exp) {
    const ms = payload.exp * 1000 - Date.now();
    expTimer = setTimeout(() => {
      if (ws.readyState === ws.OPEN) ws.close(4001, 'token expired');
    }, Math.max(ms, 0));
  }

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
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Coordinador en puerto ${PORT}`);
});
