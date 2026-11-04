// Un users.db creado con el esquema del Taller 1 se migra al esquema con provider
// sin perder usuarios (se ejecuta en su propio proceso: node --test aísla archivos).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = path.join(os.tmpdir(), `auth-migration-${process.pid}.db`);

test('migra la tabla users del Taller 1 a provider = local', () => {
  const old = new DatabaseSync(DB_FILE);
  old.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users (username, password_hash) VALUES ('viejo', '$2b$10$abcdefghijklmnopqrstuv');
  `);
  old.close();

  Object.assign(process.env, {
    DB_FILE,
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  });
  const { db } = require('../index.js');
  try {
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get('viejo');
    assert.strictEqual(row.provider, 'local');
    assert.strictEqual(row.id, 1);
    assert.strictEqual(row.password_hash, '$2b$10$abcdefghijklmnopqrstuv');
    const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all().map((c) => c.name);
    assert.ok(cols.includes('provider') && cols.includes('google_sub'));
  } finally {
    db.close();
    fs.rmSync(DB_FILE, { force: true });
  }
});

// Esquema de la Parte II antes del cambio: username UNIQUE pero sensible a mayúsculas
function createOldPart2Db(file, rows) {
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('local','google')),
      password_hash TEXT,
      google_sub TEXT UNIQUE,
      email TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const ins = old.prepare("INSERT INTO users (username, provider, password_hash) VALUES (?, 'local', 'x')");
  for (const u of rows) ins.run(u);
  old.close();
}

test('migra usernames existentes a minúscula', () => {
  const file = path.join(os.tmpdir(), `auth-migration-case-${process.pid}.db`);
  createOldPart2Db(file, ['Pedro', 'maria']);
  const db = new DatabaseSync(file);
  try {
    // Se reutiliza la lógica del servicio en un proceso hijo para no compartir el require() de arriba
    const { execFileSync } = require('node:child_process');
    execFileSync(process.execPath, ['-e', "require('./index.js').db.close()"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DB_FILE: file },
    });
    const names = db.prepare('SELECT username FROM users ORDER BY id').all().map((r) => r.username);
    assert.deepStrictEqual(names, ['pedro', 'maria']);
    assert.throws(() => db.exec("INSERT INTO users (username, provider) VALUES ('PEDRO', 'local')"));
  } finally {
    db.close();
    fs.rmSync(file, { force: true });
  }
});

test('no migra (y no arranca) si hay usernames que solo difieren en mayúsculas', () => {
  const file = path.join(os.tmpdir(), `auth-migration-dup-${process.pid}.db`);
  createOldPart2Db(file, ['Ana', 'ana']);
  try {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, ['-e', "require('./index.js')"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DB_FILE: file },
      encoding: 'utf8',
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /Ana, ana|ana, Ana/);
    // La tabla queda intacta para resolverlo a mano
    const db = new DatabaseSync(file);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM users').get().n, 2);
    db.close();
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('agrega la columna vehicle a una tabla existente: los usuarios quedan como taxi', () => {
  const file = path.join(os.tmpdir(), `auth-migration-vehicle-${process.pid}.db`);
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE CHECK(username = lower(username) COLLATE BINARY),
      provider TEXT NOT NULL CHECK(provider IN ('local','google')),
      password_hash TEXT,
      google_sub TEXT UNIQUE,
      email TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users (username, provider, password_hash) VALUES ('antiguo', 'local', 'x');
  `);
  old.close();
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync(process.execPath, ['-e', "require('./index.js').db.close()"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DB_FILE: file },
    });
    const db = new DatabaseSync(file);
    assert.strictEqual(db.prepare('SELECT vehicle FROM users WHERE username = ?').get('antiguo').vehicle, 'taxi');
    assert.throws(() => db.exec("INSERT INTO users (username, provider, vehicle) VALUES ('nuevo', 'local', 'bus')"), /CHECK/);
    db.close();
  } finally {
    fs.rmSync(file, { force: true });
  }
});
