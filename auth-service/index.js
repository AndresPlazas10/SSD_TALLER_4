require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { DatabaseSync } = require('node:sqlite');

const PORT = parseInt(process.env.PORT || '4000', 10);
const JWT_SECRET = process.env.JWT_SECRET;
// '1h', '30s'... Un número sin unidad se toma como segundos (jsonwebtoken
// interpretaría el string "30" como 30 ms).
const RAW_EXPIRES_IN = (process.env.JWT_EXPIRES_IN || '1h').trim();
const JWT_EXPIRES_IN = /^\d+$/.test(RAW_EXPIRES_IN) ? Number(RAW_EXPIRES_IN) : RAW_EXPIRES_IN;
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const DB_FILE = process.env.DB_FILE || 'users.db';

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
      SELECT id, username, 'local', password_hash, created_at FROM users_taller1
    `);
    db.exec('DROP TABLE users_taller1');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Una sola tabla para ambos providers: el UNIQUE de username aplica entre
// 'local' y 'google', así un mismo nombre nunca tiene dos cuentas.
function createUsersTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('local','google')),
      password_hash TEXT,
      google_sub TEXT UNIQUE,
      email TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

migrateFromTaller1();
createUsersTable();

// Literales SQL con comillas simples ('local'): con comillas dobles SQLite los
// toma como nombres de columna.
const stmts = {
  insertLocal:    db.prepare("INSERT INTO users (username, provider, password_hash) VALUES (?, 'local', ?)"),
  insertGoogle:   db.prepare("INSERT INTO users (username, provider, google_sub, email) VALUES (?, 'google', ?, ?)"),
  findByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  findByGoogle:   db.prepare('SELECT * FROM users WHERE google_sub = ?'),
};

// SQLITE_CONSTRAINT_UNIQUE (2067) tal como lo reporta node:sqlite
function isUniqueViolation(err) {
  return err && err.code === 'ERR_SQLITE_ERROR' && err.errcode === 2067;
}

// Hash falso para igualar el tiempo de respuesta cuando el usuario no existe
// (evita enumeración de usuarios por timing).
const DUMMY_HASH = bcrypt.hashSync('dummy-password', BCRYPT_ROUNDS);

const app = express();
app.use(cors());
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

// Mismo JWT para ambos providers: el coordinador no necesita saber cómo entró
// el usuario, solo valida la firma. provider va en el payload para el badge.
function emitToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username, provider: user.provider },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function validateUsername(u) {
  if (typeof u !== 'string') return 'username debe ser string';
  if (u.length < 3 || u.length > 32) return 'username 3-32 chars';
  if (!/^[a-zA-Z0-9_]+$/.test(u)) return 'username solo letras, números, _';
  return null;
}

function validatePassword(p) {
  if (typeof p !== 'string') return 'password debe ser string';
  // bcrypt solo usa los primeros 72 bytes
  if (p.length < 6 || p.length > 72) return 'password debe tener entre 6 y 72 caracteres';
  return null;
}

// --- /register ---
app.post('/register', async (req, res) => {
  const { username, password } = req.body || {};
  const error = validateUsername(username) || validatePassword(password);
  if (error) return res.status(400).json({ error });

  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = stmts.insertLocal.run(username, hash);
    console.log(`[register] usuario creado: ${username} (id ${result.lastInsertRowid})`);
    return res.status(201).json({ userId: result.lastInsertRowid, username });
  } catch (err) {
    // El UNIQUE cubre ambos providers y también la carrera de dos registros simultáneos
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'El usuario ya existe' });
    }
    console.error('[register] error interno:', err.message);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// --- /login ---
app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'username y password son requeridos' });
  }

  try {
    const user = stmts.findByUsername.get(username);

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
    return res.status(200).json({ token: emitToken(user), username: user.username });
  } catch (err) {
    console.error('[login] error interno:', err.message);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// --- /auth/google (Opción A: Google Identity Services) ---
app.post('/auth/google', async (req, res) => {
  const { idToken, username } = req.body || {};

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
    console.log(`[google] login: ${existing.username}`);
    return res.json({ token: emitToken(existing), username: existing.username });
  }

  // 3. Es la primera vez. ¿Mandó username?
  if (!username) {
    return res.status(409).json({
      error: 'username_required',
      hint: 'Primer login con Google: elige un username.',
    });
  }

  const usernameError = validateUsername(username);
  if (usernameError) {
    return res.status(400).json({ error: usernameError });
  }

  // 4. Crear el usuario (puede fallar si el username está tomado)
  try {
    const result = stmts.insertGoogle.run(username, googleSub, email);
    const newUser = { id: result.lastInsertRowid, username, provider: 'google' };
    console.log(`[google] usuario creado: ${username} (id ${newUser.id})`);
    return res.json({ token: emitToken(newUser), username });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Si el UNIQUE que saltó fue google_sub (doble clic / dos pestañas a la
      // vez), la cuenta ya se creó: se devuelve su token.
      const raced = stmts.findByGoogle.get(googleSub);
      if (raced) return res.json({ token: emitToken(raced), username: raced.username });
      return res.status(409).json({ error: 'username_taken' });
    }
    console.error('[google] error interno:', err.message);
    return res.status(500).json({ error: 'internal' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Exportado para los tests (test/auth.test.js); al correr con `npm start` escucha.
module.exports = { app, db, googleClient };

if (require.main === module) {
  app.listen(PORT, () => console.log(`Auth service en puerto ${PORT}`));
}
