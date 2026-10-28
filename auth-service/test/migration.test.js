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
