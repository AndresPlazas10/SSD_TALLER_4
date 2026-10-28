const dotenv = require('dotenv');
dotenv.config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const DB_FILE = process.env.DB_FILE || 'users.db';

// '1h', '30s'... Un número sin unidad se toma como segundos (jsonwebtoken
// interpretaría el string "30" como 30 ms). Firmar un token de prueba valida el
// formato y da la duración en segundos.
function parseExpiresIn(raw) {
  const text = String(raw || '1h').trim();
  const value = /^\d+$/.test(text) ? Number(text) : text;
  const { iat, exp } = jwt.decode(jwt.sign({}, 'probe', { expiresIn: value }));
  if (exp - iat <= 0) throw new Error('la duración debe ser mayor que 0');
  return { value, seconds: exp - iat };
}

if (!JWT_SECRET) {
  console.error('Falta JWT_SECRET en el .env');
  process.exit(1);
}
if (BCRYPT_ROUNDS < 10) {
  console.error('BCRYPT_ROUNDS debe ser >= 10');
  process.exit(1);
}
let expiresIn;
try {
  expiresIn = parseExpiresIn(process.env.JWT_EXPIRES_IN);
} catch (err) {
  console.error(`JWT_EXPIRES_IN inválido: ${err.message}`);
  process.exit(1);
}

// JWT_EXPIRES_IN se recarga en caliente al guardar el .env: los logins nuevos
// usan la nueva duración y el coordinador la aplica a las sesiones ya abiertas
// (la consulta en GET /token-policy). El resto de variables requiere reiniciar.
const ENV_FILE = path.resolve('.env');
fs.watchFile(ENV_FILE, { interval: 1000 }, () => {
  try {
    const next = parseExpiresIn(dotenv.parse(fs.readFileSync(ENV_FILE)).JWT_EXPIRES_IN);
    if (next.seconds !== expiresIn.seconds) {
      expiresIn = next;
      console.log(`[config] JWT_EXPIRES_IN ahora es ${next.value} (${next.seconds} s)`);
    }
  } catch (err) {
    console.error(`[config] JWT_EXPIRES_IN inválido en .env (${err.message}); se mantiene ${expiresIn.value}`);
  }
});

const db = new Database(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// Usernames sin distinguir mayúsculas: "oscar" y "OSCAR" son el mismo usuario.
// Se guardan en minúsculas y el índice NOCASE lo garantiza también en la base
// (incluido un registro concurrente).
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_username_nocase ON users (username COLLATE NOCASE)');
} catch (err) {
  console.error(`La base ${DB_FILE} ya tiene usernames repetidos con distintas mayúsculas; elimínalos o usa una base nueva.`);
  process.exit(1);
}

const findUser = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE');
const insertUser = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');

// Hash falso para igualar el tiempo de respuesta cuando el usuario no existe
// (evita enumeración de usuarios por timing).
const DUMMY_HASH = bcrypt.hashSync('dummy-password', BCRYPT_ROUNDS);

const app = express();
app.use(cors());
app.use(express.json());

// JSON mal formado -> 400
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido' });
  }
  next(err);
});

function validateCredentials(body) {
  if (!body || typeof body !== 'object') return 'Body inválido';
  const { username, password } = body;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return 'username y password deben ser strings';
  }
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return 'username debe tener 3-20 caracteres (letras, números o _)';
  }
  if (password.length < 6 || password.length > 72) {
    // bcrypt solo usa los primeros 72 bytes
    return 'password debe tener entre 6 y 72 caracteres';
  }
  return null;
}

app.post('/register', async (req, res) => {
  const error = validateCredentials(req.body);
  if (error) return res.status(400).json({ error });

  const username = req.body.username.toLowerCase();
  const { password } = req.body;
  try {
    if (findUser.get(username)) {
      return res.status(409).json({ error: 'El usuario ya existe' });
    }
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const info = insertUser.run(username, hash);
    console.log(`[register] usuario creado: ${username} (id ${info.lastInsertRowid})`);
    return res.status(201).json({ userId: info.lastInsertRowid, username });
  } catch (err) {
    // Carrera: dos registros simultáneos con el mismo username
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'El usuario ya existe' });
    }
    console.error('[register] error interno:', err.message);
    return res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/login', async (req, res) => {
  const body = req.body;
  if (
    !body || typeof body !== 'object' ||
    typeof body.username !== 'string' || typeof body.password !== 'string' ||
    !body.username || !body.password
  ) {
    return res.status(400).json({ error: 'username y password son requeridos' });
  }

  try {
    const username = body.username.toLowerCase();
    const { password } = body;
    const user = findUser.get(username);
    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      console.log(`[login] fallido para: ${username}`);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    // iat lo agrega jsonwebtoken automáticamente; exp viene de expiresIn
    const token = jwt.sign(
      { userId: String(user.id), username: user.username },
      JWT_SECRET,
      { expiresIn: expiresIn.value }
    );
    console.log(`[login] exitoso: ${user.username}`);
    return res.status(200).json({ token, username: user.username });
  } catch (err) {
    console.error('[login] error interno:', err.message);
    return res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Duración vigente de los tokens; el coordinador la consulta para aplicar un
// cambio de JWT_EXPIRES_IN a las sesiones que ya están abiertas.
app.get('/token-policy', (req, res) => {
  res.json({ expiresIn: expiresIn.value, expiresInSeconds: expiresIn.seconds });
});

app.listen(PORT, () => {
  console.log(`Auth service en puerto ${PORT}`);
});
