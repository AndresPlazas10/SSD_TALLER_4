// Si JWT_EXPIRES_IN viene del entorno real (tests, shell) manda ese valor;
// si viene del .env se relee en caliente (ver currentExpiresIn).
const EXPIRES_IN_FROM_ENV = 'JWT_EXPIRES_IN' in process.env;
const dotenv = require('dotenv');
dotenv.config();
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');
const { createReplication, ReplicationError } = require('./replication');

// Varios auth en un mismo equipo comparten el .env: id, puertos, BD y pares se
// pueden pasar por línea de comandos (ver los scripts de package.json):
//   node index.js --id auth-b --port 4001 --peer-port 4101 --db users-b.db
function cliArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const PORT = parseInt(cliArg('port') || process.env.PORT || '4000', 10);
const JWT_SECRET = process.env.JWT_SECRET;
// '1h', '30s'... Un número sin unidad se toma como segundos (jsonwebtoken
// interpretaría el string "30" como 30 ms).
function parseExpiresIn(raw) {
  const v = (raw || '1h').trim();
  return /^\d+$/.test(v) ? Number(v) : v;
}
let JWT_EXPIRES_IN = parseExpiresIn(process.env.JWT_EXPIRES_IN);
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
// Si el .env viene del Taller 1 (sin GOOGLE_CLIENT_ID) se toma el del .env.example
function loadGoogleClientId() {
  const fromEnv = (process.env.GOOGLE_CLIENT_ID || '').trim();
  if (fromEnv && !fromEnv.startsWith('TU-CLIENT-ID')) return fromEnv;
  try {
    return (dotenv.parse(fs.readFileSync(path.join(__dirname, '.env.example'))).GOOGLE_CLIENT_ID || '').trim();
  } catch (_) {
    return fromEnv;
  }
}
const GOOGLE_CLIENT_ID = loadGoogleClientId();
const DB_FILE = cliArg('db') || process.env.DB_FILE || 'users.db';

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET debe existir en el .env y tener al menos 32 caracteres');
  process.exit(1);
}
if (!GOOGLE_CLIENT_ID) {
  console.error('Falta GOOGLE_CLIENT_ID en el .env (ver README, sección Google Cloud)');
  process.exit(1);
}
if (BCRYPT_ROUNDS < 10) {
  console.error('BCRYPT_ROUNDS debe ser >= 10');
  process.exit(1);
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const db = new DatabaseSync(DB_FILE);

// Migración desde el esquema del Taller 1 (users sin columna provider y con
// password_hash NOT NULL): se copian los usuarios existentes como 'local'.
function migrateFromTaller1() {
  const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all().map((c) => c.name);
  if (cols.length === 0 || cols.includes('provider')) return;
  console.log('[db] migrando tabla users del Taller 1 al esquema con provider');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE users RENAME TO users_taller1');
    createUsersTable();
    db.exec(`
      INSERT INTO users (id, username, provider, password_hash, created_at)
      SELECT id, lower(username), 'local', password_hash, created_at FROM users_taller1
    `);
    db.exec('DROP TABLE users_taller1');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Migración de tablas creadas antes de que el username fuera insensible a
// mayúsculas: se reconstruye la tabla guardando cada username en minúscula.
// Si ya hay dos usuarios que solo difieren en mayúsculas ("Alice" y "alice")
// no se puede decidir cuál conservar: el servicio no arranca y los lista.
function migrateCaseInsensitiveUsernames() {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!table || table.sql.includes('lower(username)')) return;
  const dups = db.prepare(`
    SELECT group_concat(username, ', ') AS names FROM users
    GROUP BY lower(username) HAVING count(*) > 1
  `).all();
  if (dups.length) {
    throw new Error('[db] usernames repetidos ignorando mayúsculas, resolver a mano antes de migrar: '
      + dups.map((d) => `(${d.names})`).join(' '));
  }
  console.log('[db] migrando usernames a minúscula (únicos sin importar mayúsculas)');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE users RENAME TO users_old');
    createUsersTable();
    db.exec(`
      INSERT INTO users (id, username, provider, password_hash, google_sub, email, created_at)
      SELECT id, lower(username), provider, password_hash, google_sub, email, created_at FROM users_old
    `);
    db.exec('DROP TABLE users_old');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Una sola tabla para ambos providers: el UNIQUE de username aplica entre
// 'local' y 'google', así un mismo nombre nunca tiene dos cuentas.
// El username se guarda siempre en minúscula (CHECK) y COLLATE NOCASE hace que
// el UNIQUE y las búsquedas ignoren mayúsculas: "Alice" y "alice" son el mismo.
// vehicle ('uber' o 'taxi') se elige al registrarse; va al final porque en
// tablas existentes se agrega con ALTER TABLE (ver migrateVehicle).
const VEHICLE_COLUMN = "vehicle TEXT NOT NULL DEFAULT 'taxi' CHECK(vehicle IN ('uber','taxi'))";
function createUsersTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE CHECK(username = lower(username) COLLATE BINARY),
      provider TEXT NOT NULL CHECK(provider IN ('local','google')),
      password_hash TEXT,
      google_sub TEXT UNIQUE,
      email TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      ${VEHICLE_COLUMN}
    )
  `);
}

// Tablas creadas antes de poder elegir vehículo: los usuarios existentes
// quedan como taxi (el DEFAULT de la columna).
function migrateVehicle() {
  const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all().map((c) => c.name);
  if (cols.length === 0 || cols.includes('vehicle')) return;
  console.log('[db] agregando la columna vehicle (usuarios existentes: taxi)');
  db.exec(`ALTER TABLE users ADD COLUMN ${VEHICLE_COLUMN}`);
}

migrateFromTaller1();
migrateCaseInsensitiveUsernames();
migrateVehicle();
createUsersTable();

// Literales SQL con comillas simples ('local'): con comillas dobles SQLite los
// toma como nombres de columna.
const stmts = {
  insertLocal:    db.prepare("INSERT INTO users (username, provider, password_hash, vehicle) VALUES (?, 'local', ?, ?)"),
  insertGoogle:   db.prepare("INSERT INTO users (username, provider, google_sub, email, vehicle) VALUES (?, 'google', ?, ?, ?)"),
  findByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  findByGoogle:   db.prepare('SELECT * FROM users WHERE google_sub = ?'),
  findById:       db.prepare('SELECT * FROM users WHERE id = ?'),
  // Réplicas: el usuario llega con el id que le dio el líder (mismo userId en todos)
  insertReplica:  db.prepare(`INSERT INTO users (id, username, provider, password_hash, google_sub, email, created_at, vehicle)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
};

// Datos de un usuario tal como viajan en write_propagate
function userEntry(u) {
  return { userId: u.id, username: u.username, provider: u.provider, password_hash: u.password_hash,
    google_sub: u.google_sub, email: u.email, created_at: u.created_at, vehicle: u.vehicle };
}

// Aplica en una réplica una entrada del log del líder
function applyOp(op, d) {
  if (op !== 'register' && op !== 'register_google' && op !== 'import') throw new Error(`op desconocida: ${op}`);
  stmts.insertReplica.run(d.userId, d.username, d.provider, d.password_hash ?? null, d.google_sub ?? null,
    d.email ?? null, d.created_at ?? null, d.vehicle || 'taxi');
}

// SQLITE_CONSTRAINT_UNIQUE (2067) tal como lo reporta node:sqlite
function isUniqueViolation(err) {
  return err && err.code === 'ERR_SQLITE_ERROR' && err.errcode === 2067;
}

// Hash falso para igualar el tiempo de respuesta cuando el usuario no existe
// (evita enumeración de usuarios por timing).
const DUMMY_HASH = bcrypt.hashSync('dummy-password', BCRYPT_ROUNDS);

const app = express();
// X-Auth-Id / X-Auth-Role: el navegador muestra qué auth le respondió
app.use(cors({ exposedHeaders: ['X-Auth-Id', 'X-Auth-Role'] }));
app.use((req, res, next) => {
  res.set('X-Auth-Id', replication.authId);
  res.set('X-Auth-Role', replication.role());
  next();
});
app.use(express.json({ limit: '4kb' }));

// JSON mal formado -> 400, body demasiado grande -> 413
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Body demasiado grande' });
  }
  next(err);
});

// Relee JWT_EXPIRES_IN del .env (solo si cambió su mtime) para no tener que
// reiniciar el servicio al cambiarlo. Un valor inválido se ignora y se
// conserva el anterior.
const ENV_FILE = path.resolve('.env');
let envMtime = 0;
function currentExpiresIn() {
  if (EXPIRES_IN_FROM_ENV) return JWT_EXPIRES_IN;
  try {
    const { mtimeMs } = fs.statSync(ENV_FILE);
    if (mtimeMs === envMtime) return JWT_EXPIRES_IN;
    envMtime = mtimeMs;
    const next = parseExpiresIn(dotenv.parse(fs.readFileSync(ENV_FILE)).JWT_EXPIRES_IN);
    if (next === JWT_EXPIRES_IN) return JWT_EXPIRES_IN;
    jwt.sign({}, 'probe', { expiresIn: next }); // lanza si el formato no es válido
    console.log(`[config] JWT_EXPIRES_IN: ${JWT_EXPIRES_IN} -> ${next}`);
    JWT_EXPIRES_IN = next;
  } catch (err) {
    console.error(`[config] JWT_EXPIRES_IN no recargado, se mantiene ${JWT_EXPIRES_IN}: ${err.message}`);
  }
  return JWT_EXPIRES_IN;
}

// Mismo JWT para ambos providers: el coordinador no necesita saber cómo entró
// el usuario, solo valida la firma. provider va en el payload para el badge y
// vehicle para el auto: al ir firmados, el cliente no los puede cambiar.
function emitToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username, provider: user.provider, vehicle: user.vehicle },
    JWT_SECRET,
    { expiresIn: currentExpiresIn() }
  );
}

function validateUsername(u) {
  if (typeof u !== 'string') return 'username debe ser string';
  if (u.length < 3 || u.length > 32) return 'username 3-32 chars';
  if (!/^[a-zA-Z0-9_]+$/.test(u)) return 'username solo letras, números, _';
  return null;
}

// Se acepta "Alice" en el input, pero se guarda y se busca como "alice"
function normalizeUsername(u) {
  return typeof u === 'string' ? u.toLowerCase() : u;
}

function validateVehicle(v) {
  return v === 'uber' || v === 'taxi' ? null : 'vehicle debe ser "uber" o "taxi"';
}

// vehicle es opcional en la API: el contrato del enunciado es
// { username, password } y { idToken, username }, y así tiene que seguir
// funcionando. Sin vehicle se juega como taxi; un valor presente pero
// inválido ("bus") sí es un error. La página siempre obliga a elegir.
const DEFAULT_VEHICLE = 'taxi';
function vehicleOrDefault(v) {
  return v === undefined || v === null ? DEFAULT_VEHICLE : v;
}

function validatePassword(p) {
  if (typeof p !== 'string') return 'password debe ser string';
  // bcrypt solo usa los primeros 72 bytes
  if (p.length < 6 || p.length > 72) return 'password debe tener entre 6 y 72 caracteres';
  return null;
}

// --- /register ---
app.post('/register', async (req, res) => {
  const { password } = req.body || {};
  const vehicle = vehicleOrDefault((req.body || {}).vehicle);
  const username = normalizeUsername((req.body || {}).username);
  const error = validateUsername(username) || validatePassword(password) || validateVehicle(vehicle);
  if (error) return res.status(400).json({ error });
  // Escritura: solo el líder (una réplica contesta 503 not_leader + leaderUrl)
  const blocked = replication.writeCheck();
  if (blocked) return res.status(blocked.status).json(blocked.body);

  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { data } = await replication.commit('register', () => {
      const result = stmts.insertLocal.run(username, hash, vehicle);
      return userEntry(stmts.findById.get(result.lastInsertRowid));
    });
    console.log(`[register] usuario creado: ${username} (${vehicle}, id ${data.userId})`);
    return res.status(201).json({ userId: data.userId, username, vehicle });
  } catch (err) {
    // El UNIQUE cubre ambos providers y también la carrera de dos registros simultáneos
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'El usuario ya existe' });
    }
    if (err instanceof ReplicationError) return replicationFailed(res, 'register', err);
    console.error('[register] error interno:', err.message);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// --- /login ---
app.post('/login', async (req, res) => {
  const { password } = req.body || {};
  const username = normalizeUsername((req.body || {}).username);
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'username y password son requeridos' });
  }
  // Lectura: la responde cualquier réplica que no esté muy atrasada
  const blocked = replication.readCheck();
  if (blocked) return res.status(blocked.status).json(blocked.body);

  try {
    const user = stmts.findByUsername.get(username);
    // ¿No existe o solo no llegó todavía a esta réplica? Que conteste el líder
    if (!user && replication.isBehind()) {
      return res.status(503).json({ error: 'not_leader', leaderUrl: replication.leaderUrl(), reason: 'replica_lagging' });
    }

    // Un usuario de Google no tiene contraseña: debe entrar con Google.
    if (user && user.provider !== 'local') {
      console.log(`[login] rechazado (cuenta de Google): ${username}`);
      return res.status(401).json({
        error: 'use_google_login',
        hint: 'Esta cuenta se creó con Google: inicia sesión con el botón de Google.',
      });
    }

    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      console.log(`[login] fallido para: ${username}`);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    console.log(`[login] exitoso: ${user.username}`);
    return res.status(200).json({ token: emitToken(user), username: user.username, vehicle: user.vehicle });
  } catch (err) {
    console.error('[login] error interno:', err.message);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// --- /auth/google (Opción A: Google Identity Services) ---
app.post('/auth/google', async (req, res) => {
  const { idToken } = req.body || {};
  // Solo se usa en el alta; un usuario existente conserva su bando
  const vehicle = vehicleOrDefault((req.body || {}).vehicle);
  const username = normalizeUsername((req.body || {}).username);

  if (typeof idToken !== 'string') {
    return res.status(400).json({ error: 'idToken requerido' });
  }

  // 1. Verificar el ID token contra Google: firma (claves públicas de Google),
  //    emisor, expiración y que aud sea NUESTRO client id. Decodearlo no basta.
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    console.log(`[google] ID token rechazado: ${err.message}`);
    return res.status(401).json({ error: 'invalid_id_token' });
  }

  if (!payload || payload.email_verified !== true) {
    return res.status(401).json({ error: 'email_not_verified' });
  }

  // sub es el id estable de la cuenta de Google; el email puede cambiar.
  const googleSub = payload.sub;
  const email = payload.email;

  // 2. ¿Ya existe este usuario de Google?
  const existing = stmts.findByGoogle.get(googleSub);
  if (existing) {
    const blocked = replication.readCheck();
    if (blocked) return res.status(blocked.status).json(blocked.body);
    console.log(`[google] login: ${existing.username}`);
    return res.json({ token: emitToken(existing), username: existing.username, vehicle: existing.vehicle });
  }

  // En una réplica atrasada "no existe" puede ser falso: decide el líder
  if (replication.isBehind()) {
    return res.status(503).json({ error: 'not_leader', leaderUrl: replication.leaderUrl(), reason: 'replica_lagging' });
  }

  // 3. Es la primera vez (es su registro). ¿Mandó username?
  if (!username) {
    return res.status(409).json({
      error: 'username_required',
      hint: 'Primer login con Google: elige un username.',
    });
  }

  const usernameError = validateUsername(username) || validateVehicle(vehicle);
  if (usernameError) {
    return res.status(400).json({ error: usernameError });
  }

  // 4. Crear el usuario (puede fallar si el username está tomado). Es una
  //    escritura: solo el líder
  const blocked = replication.writeCheck();
  if (blocked) return res.status(blocked.status).json(blocked.body);
  try {
    const { data } = await replication.commit('register_google', () => {
      const result = stmts.insertGoogle.run(username, googleSub, email, vehicle);
      return userEntry(stmts.findById.get(result.lastInsertRowid));
    });
    const newUser = { id: data.userId, username, provider: 'google', vehicle };
    console.log(`[google] usuario creado: ${username} (${vehicle}, id ${newUser.id})`);
    return res.json({ token: emitToken(newUser), username, vehicle });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Si el UNIQUE que saltó fue google_sub (doble clic / dos pestañas a la
      // vez), la cuenta ya se creó: se devuelve su token.
      const raced = stmts.findByGoogle.get(googleSub);
      if (raced) return res.json({ token: emitToken(raced), username: raced.username, vehicle: raced.vehicle });
      return res.status(409).json({ error: 'username_taken' });
    }
    if (err instanceof ReplicationError) return replicationFailed(res, 'google', err);
    console.error('[google] error interno:', err.message);
    return res.status(500).json({ error: 'internal' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Duración vigente de los tokens, en segundos. La consulta el coordinador
// para aplicar un cambio de JWT_EXPIRES_IN también a las sesiones ya
// abiertas (el exp de un token emitido no se puede cambiar). Relee el .env,
// así el cambio se ve sin necesidad de un login. No es un secreto.
app.get('/token-policy', (req, res) => {
  const probe = jwt.decode(jwt.sign({}, 'probe', { expiresIn: currentExpiresIn() }));
  res.json({ expiresInSeconds: probe.exp - probe.iat });
});

// ===================== Directorio de coordinadores =====================
// El auth también es el "directory service" del mesh:
// - los coordinadores se anuncian cada 2 s con POST /heartbeat;
// - los clientes preguntan a cuál conectarse con GET /coordinator;
// - los coordinadores descubren a sus pares con GET /peers.
// Vive en memoria: si el auth se reinicia, los coordinadores se vuelven a
// anunciar en su siguiente heartbeat (2 s).
const DIRECTORY_TTL_MS = parseInt(process.env.DIRECTORY_TTL_MS || '6000', 10); // 3 ciclos de 2 s
const COORD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// URL ws:// o wss:// bien formada. Atrapa errores típicos de configuración,
// como "wss://https://xxx.ngrok-free.dev" (protocolo repetido). Para publicUrl
// no se admite ruta: el cliente le agrega /connect.
function wsUrlError(value, name, allowPath) {
  if (typeof value !== 'string' || value.length > 250) return `${name} debe ser un texto de hasta 250 caracteres`;
  let u;
  try { u = new URL(value); } catch (_) { return `${name} no es una URL válida: ${value}`; }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return `${name} debe empezar con ws:// o wss:// (llegó ${value})`;
  if (!u.hostname || /^https?$/i.test(u.hostname) || value.indexOf('://') !== value.lastIndexOf('://')) {
    return `${name} tiene el protocolo repetido o sin host (llegó ${value}; p. ej. wss://xxx.ngrok-free.dev)`;
  }
  if (!allowPath && u.pathname !== '/' && u.pathname !== '') return `${name} no debe tener ruta (llegó ${value}; el cliente agrega /connect)`;
  return null;
}

// coordinatorId -> { coordinatorId, publicUrl, peerUrl, connectedPlayers, uptime, lastSeen, assigned }
const coordinators = new Map();

function aliveCoordinators(now = Date.now()) {
  const alive = [];
  for (const [id, c] of coordinators) {
    if (now - c.lastSeen > DIRECTORY_TTL_MS) {
      coordinators.delete(id); // más de 6 s sin heartbeat: muerto
      console.log(`[directorio] ${id} sin heartbeat hace ${now - c.lastSeen} ms: descartado`);
    } else {
      alive.push(c);
    }
  }
  return alive;
}

// /heartbeat y /peers solo los usan coordinadores: exigen un token firmado con
// la JWT_SECRET compartida y { role: 'coordinator' }. Sin esto cualquiera podría
// registrar un "coordinador" falso y desviar a los jugadores, o leer las URLs
// internas del mesh. (GET /coordinator es público: lo llama el navegador.)
function requireCoordinator(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (payload.role !== 'coordinator' || !COORD_ID_RE.test(payload.coordinatorId || '')) throw new Error('rol');
    req.coordinatorId = payload.coordinatorId;
    return next();
  } catch (_) {
    return res.status(401).json({ error: 'coordinator_token_required' });
  }
}

app.post('/heartbeat', requireCoordinator, (req, res) => {
  const { coordinatorId, publicUrl, peerUrl, connectedPlayers, uptime } = req.body || {};
  // Espectadores (examen final): opcional, aparte de los jugadores
  const spectators = (req.body || {}).spectators === undefined ? 0 : (req.body || {}).spectators;
  if (typeof coordinatorId !== 'string' || !COORD_ID_RE.test(coordinatorId)) {
    return res.status(400).json({ error: 'coordinatorId inválido (1-64: letras, números, _ o -)' });
  }
  // Un coordinador solo puede anunciarse a sí mismo
  if (coordinatorId !== req.coordinatorId) return res.status(403).json({ error: 'coordinatorId no coincide con el token' });
  const urlError = wsUrlError(publicUrl, 'publicUrl', false) || wsUrlError(peerUrl, 'peerUrl', true);
  if (urlError) return res.status(400).json({ error: urlError });
  if (!Number.isInteger(connectedPlayers) || connectedPlayers < 0) return res.status(400).json({ error: 'connectedPlayers debe ser un entero >= 0' });
  if (typeof uptime !== 'number' || !(uptime >= 0)) return res.status(400).json({ error: 'uptime debe ser un número >= 0' });
  if (!Number.isInteger(spectators) || spectators < 0) return res.status(400).json({ error: 'spectators debe ser un entero >= 0' });

  if (!coordinators.has(coordinatorId)) console.log(`[directorio] + ${coordinatorId} (${publicUrl}, mesh ${peerUrl})`);
  // assigned: clientes que /coordinator mandó aquí desde el último heartbeat
  // (todavía no aparecen en connectedPlayers). El heartbeat trae la cifra real.
  coordinators.set(coordinatorId, { coordinatorId, publicUrl, peerUrl, connectedPlayers, spectators, uptime, lastSeen: Date.now(), assigned: 0 });
  if (replication.standalone) return res.json({ ok: true });
  // Taller 7: los coordinadores mandan el heartbeat al líder. Si llegó a una
  // réplica (el líder acaba de cambiar) se acepta igual (el directorio es
  // estado blando, no datos de usuarios) y se le dice quién es el líder para
  // que el próximo vaya allá. Así ningún coordinador desaparece del
  // directorio durante una elección.
  return res.json({ ok: true, authId: replication.authId, role: replication.role(), leaderUrl: replication.leaderUrl() });
});

// El líder copia el directorio a las réplicas en cada heartbeat del cluster:
// cualquier auth puede contestar GET /coordinator, y el líder nuevo ya conoce
// a los coordinadores sin esperar sus heartbeats.
function directorySnapshot() {
  const now = Date.now();
  return aliveCoordinators(now).map((c) => ({ coordinatorId: c.coordinatorId, publicUrl: c.publicUrl, peerUrl: c.peerUrl,
    connectedPlayers: c.connectedPlayers, spectators: c.spectators || 0, uptime: c.uptime, msAgo: now - c.lastSeen }));
}

function mergeDirectory(list) {
  const now = Date.now();
  for (const c of list) {
    if (!c || typeof c.coordinatorId !== 'string' || !COORD_ID_RE.test(c.coordinatorId)) continue;
    if (wsUrlError(c.publicUrl, 'publicUrl', false) || wsUrlError(c.peerUrl, 'peerUrl', true)) continue;
    const lastSeen = now - Math.max(0, Number(c.msAgo) || 0);
    const cur = coordinators.get(c.coordinatorId);
    if (cur && cur.lastSeen >= lastSeen) continue; // lo propio es más nuevo
    coordinators.set(c.coordinatorId, { coordinatorId: c.coordinatorId, publicUrl: c.publicUrl, peerUrl: c.peerUrl,
      connectedPlayers: Number(c.connectedPlayers) || 0, spectators: Number(c.spectators) || 0, uptime: Number(c.uptime) || 0, lastSeen, assigned: cur ? cur.assigned : 0 });
  }
}

// Client-side load balancing: el auth no reenvía tráfico, solo dice a qué
// coordinador conectarse. Elige el de menos jugadores entre los vivos (en
// empate, el primero). ?exclude=coord-x evita uno (el cliente lo usa para no
// volver al coordinador que se le acaba de caer).
// ?role=spectator (examen final): los espectadores se reparten por cantidad de
// espectadores, no de jugadores, y no suman a la carga de jugadores.
app.get('/coordinator', (req, res) => {
  const exclude = typeof req.query.exclude === 'string' ? req.query.exclude : null;
  const spectator = req.query.role === 'spectator';
  const loadOf = (c) => (spectator ? (c.spectators || 0) + (c.assignedSpectators || 0) : c.connectedPlayers + c.assigned);
  let best = null;
  for (const c of aliveCoordinators()) {
    if (c.coordinatorId === exclude) continue;
    if (!best || loadOf(c) < loadOf(best)) best = c;
  }
  if (!best) return res.status(503).json({ error: 'no_coordinators_available' });
  // Cuenta la asignación hasta el próximo heartbeat: si llegan 4 clientes en el
  // mismo segundo no van los 4 al mismo coordinador
  if (spectator) best.assignedSpectators = (best.assignedSpectators || 0) + 1;
  else best.assigned += 1;
  return res.json({ coordinatorId: best.coordinatorId, publicUrl: best.publicUrl });
});

// Taller 7: GET /peers lista los otros auth (authId, publicUrl, peerUrl, role).
// Los coordinadores siguen pidiendo aquí a sus pares: con su token de
// coordinador (o ?type=coordinators) se devuelve la lista de coordinadores vivos.
function isCoordinatorRequest(req) {
  if (req.query.type === 'coordinators') return true;
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return false;
  try {
    return jwt.verify(auth.slice(7), JWT_SECRET, { algorithms: ['HS256'] }).role === 'coordinator';
  } catch (_) {
    return false;
  }
}

app.get('/peers', (req, res) => {
  if (isCoordinatorRequest(req)) {
    return res.json({ peers: aliveCoordinators().map((c) => ({ coordinatorId: c.coordinatorId, peerUrl: c.peerUrl })) });
  }
  return res.json({ authId: replication.authId, peers: replication.peerList() });
});

// Vista de depuración del directorio (sin URLs internas del mesh)
app.get('/coordinators', (req, res) => {
  const now = Date.now();
  res.json({
    coordinators: aliveCoordinators(now).map((c) => ({
      coordinatorId: c.coordinatorId, publicUrl: c.publicUrl, connectedPlayers: c.connectedPlayers, spectators: c.spectators || 0,
      uptime: c.uptime, lastSeenMsAgo: now - c.lastSeen,
    })),
  });
});

// ===================== Replicación (Taller 7) =====================
// AUTH_PEERS="auth-a=ws://host:4100,auth-b=ws://host:4101,auth-c=ws://host:4102"
// (la misma lista en los tres; cada uno se salta a sí mismo). Vacío = un solo
// auth que siempre es líder: es como corren los tests y los talleres anteriores.
function parsePeers(raw) {
  const peers = {};
  for (const part of (raw || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    const id = i > 0 ? part.slice(0, i).trim() : '';
    const url = i > 0 ? part.slice(i + 1).trim() : '';
    const err = !COORD_ID_RE.test(id) ? `id inválido en "${part}"` : wsUrlError(url, `AUTH_PEERS (${id})`, true);
    if (err) {
      console.error(`AUTH_PEERS mal formado: ${err}. Formato: auth-a=ws://localhost:4100,auth-b=ws://localhost:4101`);
      process.exit(1);
    }
    peers[id] = url;
  }
  return peers;
}

const AUTH_ID = cliArg('id') || process.env.AUTH_ID || 'auth-a';
const AUTH_PEERS = parsePeers(cliArg('peers') || process.env.AUTH_PEERS);
const PEER_PORT = parseInt(cliArg('peer-port') || process.env.PEER_PORT || '0', 10) || null;
// URL HTTP con la que los navegadores llegan a este auth (la del túnel ngrok si hay)
const PUBLIC_URL = (cliArg('public-url') || process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
// URL WS con la que los otros auth llegan a este. Sin PEER_PORT, el cluster
// entra por /mesh del mismo puerto HTTP (un solo túnel ngrok por auth).
const PEER_URL = cliArg('peer-url') || process.env.PEER_URL
  || (PEER_PORT ? `ws://localhost:${PEER_PORT}` : `ws://localhost:${PORT}/mesh`);
if (!/^https?:\/\/[^/]+$/.test(PUBLIC_URL)) {
  console.error(`PUBLIC_URL debe ser http(s)://host[:puerto] sin ruta (llegó ${PUBLIC_URL})`);
  process.exit(1);
}
if (Object.keys(AUTH_PEERS).length && wsUrlError(PEER_URL, 'PEER_URL', true)) {
  console.error(wsUrlError(PEER_URL, 'PEER_URL', true));
  process.exit(1);
}

const replication = createReplication({
  db, dbFile: DB_FILE, authId: AUTH_ID, publicUrl: PUBLIC_URL, peerUrl: PEER_URL, peers: AUTH_PEERS, secret: JWT_SECRET,
  peerPort: PEER_PORT,
  heartbeatMs: parseInt(process.env.AUTH_HEARTBEAT_MS || '2000', 10),
  electionTimeoutMs: parseInt(process.env.AUTH_ELECTION_TIMEOUT_MS || '6000', 10),
  ackTimeoutMs: parseInt(process.env.AUTH_ACK_TIMEOUT_MS || '3000', 10),
  readLagTolerance: parseInt(process.env.READ_LAG_TOLERANCE || '10', 10),
  applyOp,
  clearData: () => db.exec('DELETE FROM users'),
  getDirectory: directorySnapshot,
  onDirectory: mergeDirectory,
});

// Una escritura que no se pudo replicar. not_leader / no_leader: el cliente
// reintenta en el líder (o en otro auth). no_quorum: el líder está solo.
// replication_timeout: ninguna réplica confirmó a tiempo; con la opción B no se
// le dice "creado" a alguien cuya cuenta podría perderse si el líder cae.
function replicationFailed(res, what, err) {
  console.log(`[${what}] no se pudo escribir: ${err.code}`);
  const body = { error: err.code };
  if (err.leaderUrl !== undefined) body.leaderUrl = err.leaderUrl;
  return res.status(503).json(body);
}

// Estado de este auth en el cluster (lo pide el enunciado; útil en la sustentación)
app.get('/status', (req, res) => res.json(replication.status()));

// Exportado para los tests (test/auth.test.js); al correr con `npm start` escucha.
module.exports = { app, db, googleClient, coordinators, replication };

if (require.main === module) {
  const server = http.createServer(app);
  // El cluster también entra por /mesh del puerto HTTP (para ngrok)
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/mesh') replication.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  server.on('error', (err) => {
    console.error(`No se pudo escuchar en el puerto ${PORT}: ${err.message}`);
    process.exit(1);
  });
  server.listen(PORT, () => console.log(`Auth service en puerto ${PORT} (${AUTH_ID})`
    + (replication.standalone ? ' (solo, sin réplicas)' : ` · cluster ${PEER_PORT ? `en el puerto ${PEER_PORT} y ` : ''}en /mesh`)));
}
