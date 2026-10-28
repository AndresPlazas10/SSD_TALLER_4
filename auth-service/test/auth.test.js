// Tests del auth service: npm test (dentro de auth-service/).
// No necesitan credenciales reales de Google: los ID tokens "fake:<json>" se
// resuelven con un stub de verifyIdToken; cualquier otro token pasa por la
// verificación REAL de google-auth-library (y debe ser rechazado).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const DB_FILE = path.join(os.tmpdir(), `auth-test-${process.pid}.db`);
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
Object.assign(process.env, { DB_FILE, JWT_SECRET, GOOGLE_CLIENT_ID, BCRYPT_ROUNDS: '10', JWT_EXPIRES_IN: '1h' });

const { app, db, googleClient } = require('../index.js');

const verifyCalls = [];
const realVerify = googleClient.verifyIdToken.bind(googleClient);
googleClient.verifyIdToken = async (opts) => {
  verifyCalls.push(opts);
  if (opts.idToken.startsWith('fake:')) {
    const payload = JSON.parse(opts.idToken.slice(5));
    if (payload.aud !== opts.audience) throw new Error('Wrong recipient, payload audience != requiredAudience');
    return { getPayload: () => payload };
  }
  return realVerify(opts);
};

const googleToken = (sub, extra = {}) =>
  'fake:' + JSON.stringify({ sub, email: `${sub}@gmail.com`, email_verified: true, aud: GOOGLE_CLIENT_ID, ...extra });

let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  db.close();
  fs.rmSync(DB_FILE, { force: true });
});

async function post(p, body) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

test('esquema: una sola tabla users con provider, google_sub y email', () => {
  const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all().map((c) => c.name);
  assert.deepStrictEqual(cols, ['id', 'username', 'provider', 'password_hash', 'google_sub', 'email', 'created_at']);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'users%'").all();
  assert.deepStrictEqual(tables.map((t) => t.name), ['users']);
  assert.throws(() => db.exec("INSERT INTO users (username, provider) VALUES ('x_bad', 'github')"), /CHECK/);
});

test('POST /register -> 201 { userId, username } y guarda provider local', async () => {
  const r = await post('/register', { username: 'alice', password: 'secret123' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.username, 'alice');
  assert.ok(r.data.userId);
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get('alice');
  assert.strictEqual(row.provider, 'local');
  assert.match(row.password_hash, /^\$2[aby]\$10\$/);
  assert.strictEqual(row.google_sub, null);
});

test('POST /register: duplicado 409, inválidos 400, JSON roto 400, body > 4kb 413', async () => {
  assert.strictEqual((await post('/register', { username: 'alice', password: 'otra123' })).status, 409);
  assert.strictEqual((await post('/register', { username: 'a', password: 'secret123' })).status, 400);
  assert.strictEqual((await post('/register', { username: 'a'.repeat(33), password: 'secret123' })).status, 400);
  assert.strictEqual((await post('/register', { username: 'b'.repeat(32), password: 'secret123' })).status, 201);
  assert.strictEqual((await post('/register', { username: 'bad-name', password: 'secret123' })).status, 400);
  assert.strictEqual((await post('/register', { username: 'bob', password: '123' })).status, 400);
  assert.strictEqual((await post('/register', '{malo')).status, 400);
  assert.strictEqual((await post('/register', { username: 'big', password: 'x'.repeat(5000) })).status, 413);
});

test('POST /login -> 200 { token, username } con JWT { userId, username, provider }', async () => {
  const r = await post('/login', { username: 'alice', password: 'secret123' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.username, 'alice');
  const payload = jwt.verify(r.data.token, JWT_SECRET);
  assert.strictEqual(payload.username, 'alice');
  assert.strictEqual(payload.provider, 'local');
  assert.ok(payload.userId && payload.exp);
  assert.strictEqual((await post('/login', { username: 'alice', password: 'mala123' })).status, 401);
  assert.strictEqual((await post('/login', { username: 'nadie', password: 'mala123' })).status, 401);
  assert.strictEqual((await post('/login', {})).status, 400);
});

test('POST /auth/google: sin idToken -> 400', async () => {
  assert.strictEqual((await post('/auth/google', {})).status, 400);
});

test('POST /auth/google: token falsificado (decodeable, firma inválida) -> 401 invalid_id_token', async () => {
  // JWT con formato de Google pero firmado por nosotros: verifyIdToken REAL lo rechaza.
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const forged = jwt.sign(
    { iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, sub: '999', email: 'x@gmail.com', email_verified: true },
    privateKey, { algorithm: 'RS256', keyid: 'forged', expiresIn: '1h' }
  );
  const r = await post('/auth/google', { idToken: forged });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error, 'invalid_id_token');
  assert.strictEqual((await post('/auth/google', { idToken: 'basura' })).data.error, 'invalid_id_token');
});

test('POST /auth/google: verifica con audience = GOOGLE_CLIENT_ID; otro aud -> 401', async () => {
  verifyCalls.length = 0;
  await post('/auth/google', { idToken: googleToken('g-aud') });
  assert.strictEqual(verifyCalls[0].audience, GOOGLE_CLIENT_ID);
  const r = await post('/auth/google', { idToken: googleToken('g-aud', { aud: 'otra-app.apps.googleusercontent.com' }) });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error, 'invalid_id_token');
});

test('POST /auth/google: email_verified false -> 401', async () => {
  const r = await post('/auth/google', { idToken: googleToken('g-unverified', { email_verified: false }) });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error, 'email_not_verified');
});

test('POST /auth/google: primer login sin username -> 409 username_required', async () => {
  const r = await post('/auth/google', { idToken: googleToken('g-bob') });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.error, 'username_required');
  assert.ok(r.data.hint);
});

test('POST /auth/google: username de un usuario local -> 409 username_taken (alice no entra por Google)', async () => {
  const r = await post('/auth/google', { idToken: googleToken('g-bob'), username: 'alice' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.error, 'username_taken');
});

test('POST /auth/google: username inválido -> 400', async () => {
  assert.strictEqual((await post('/auth/google', { idToken: googleToken('g-bob'), username: 'no válido' })).status, 400);
});

test('POST /auth/google: alta con username -> 200 { token, username } y fila google', async () => {
  const r = await post('/auth/google', { idToken: googleToken('g-bob'), username: 'bob_google' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.username, 'bob_google');
  const payload = jwt.verify(r.data.token, JWT_SECRET);
  assert.strictEqual(payload.provider, 'google');
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get('bob_google');
  assert.strictEqual(row.provider, 'google');
  assert.strictEqual(row.google_sub, 'g-bob');
  assert.strictEqual(row.email, 'g-bob@gmail.com');
  assert.strictEqual(row.password_hash, null);
});

test('POST /auth/google: login posterior por sub aunque cambie el email -> 200 mismo usuario', async () => {
  const r = await post('/auth/google', { idToken: googleToken('g-bob', { email: 'nuevo@gmail.com' }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.username, 'bob_google');
});

test('POST /auth/google: otra cuenta de Google con username ya usado por Google -> 409 username_taken', async () => {
  const r = await post('/auth/google', { idToken: googleToken('g-otro'), username: 'bob_google' });
  assert.strictEqual(r.data.error, 'username_taken');
});

test('POST /login con usuario de Google -> 401 use_google_login', async () => {
  const r = await post('/login', { username: 'bob_google', password: 'cualquiera' });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error, 'use_google_login');
});

test('POST /register con username de Google -> 409 (username único entre providers)', async () => {
  assert.strictEqual((await post('/register', { username: 'bob_google', password: 'secret123' })).status, 409);
});
