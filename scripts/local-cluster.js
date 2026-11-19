#!/usr/bin/env node
// Levanta TODO el sistema en un solo equipo, para desarrollo o la demo:
//   3 auth replicados   http://localhost:4000-4002  (cluster 4100-4102)
//   3 coordinadores     ws://localhost:5001-5003    (mesh por el mismo puerto)
//   cliente web         http://localhost:3000
// Cada proceso usa su propia BD (auth: users*.db, coordinadores: state-*.db).
// Ctrl+C los detiene a todos (los coordinadores guardan su estado al salir).
//
// Uso (desde la raíz del repo):
//   node scripts/local-cluster.js            # 3 auth + 3 coordinadores + cliente
//   node scripts/local-cluster.js --auths 1  # un solo auth (menos RAM)
//   node scripts/local-cluster.js --coords 2
//
// La JWT_SECRET sale de auth-service/.env y se le pasa a todos (así coinciden
// aunque coordinator/.env tenga otra, p. ej. la del despliegue con ngrok). Las
// URLs públicas de los .env se ignoran: todo es localhost.
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : def; };
const AUTHS = Math.min(3, Math.max(1, arg('auths', 3)));
const COORDS = Math.min(3, Math.max(1, arg('coords', 3)));

function readSecret() {
  try {
    const m = /^\s*JWT_SECRET\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(root, 'auth-service', '.env'), 'utf8'));
    if (m && m[1].length >= 32) return m[1].replace(/^["']|["']$/g, '');
  } catch (_) {}
  console.error('Falta auth-service/.env con una JWT_SECRET de al menos 32 caracteres (copiar .env.example)');
  process.exit(1);
}
const JWT_SECRET = readSecret();

const ids = ['a', 'b', 'c'];
const authUrls = ids.slice(0, AUTHS).map((_, i) => `http://localhost:${4000 + i}`).join(',');
const peers = ids.slice(0, AUTHS).map((x, i) => `auth-${x}=ws://localhost:${4100 + i}`).join(',');
const COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m', '\x1b[31m', '\x1b[37m'];
const children = [];

function run(name, cwd, args, env) {
  const color = COLORS[children.length % COLORS.length];
  const child = spawn(process.execPath, args, { cwd: path.join(root, cwd), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (d) => { for (const line of String(d).split(/\r?\n/)) if (line.trim()) console.log(`${color}${name.padEnd(8)}\x1b[0m ${line}`); };
  child.stdout.on('data', out);
  child.stderr.on('data', out);
  child.on('exit', (code) => console.log(`${color}${name.padEnd(8)}\x1b[0m terminó (${code})`));
  children.push(child);
}

const blank = { PUBLIC_URL: '', PEER_URL: '', PEER_PORT: '', AUTH_PEERS: '', AUTH_ID: '', DB_FILE: '', STATE_DB: '', COORDINATOR_ID: '' };
ids.slice(0, AUTHS).forEach((x, i) => {
  const args = ['index.js', '--id', `auth-${x}`, '--port', String(4000 + i), '--db', i === 0 ? 'users.db' : `users-${x}.db`];
  if (AUTHS > 1) args.push('--peer-port', String(4100 + i), '--peers', peers);
  run(`auth-${x}`, 'auth-service', args, { ...blank, JWT_SECRET });
});
ids.slice(0, COORDS).forEach((x, i) => {
  run(`coord-${x}`, 'coordinator', ['index.js', '--id', `coord-${x}`, '--port', String(5001 + i), '--auth-urls', authUrls],
    { ...blank, JWT_SECRET, AUTH_URL: '', AUTH_URLS: '', PUBLIC_HOST: 'localhost' });
});
run('client', 'client', ['server.js'], { PORT: '3000', AUTH_URLS: authUrls, AUTH_URL: '', PUBLIC_AUTH_URLS: '', PUBLIC_AUTH_URL: '' });

console.log(`\nSistema local: ${AUTHS} auth, ${COORDS} coordinador(es). Jugar: http://localhost:3000 · Espectador: http://localhost:3000/lobby.html?spectate`);
console.log('Ctrl+C para detener todo.\n');

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGINT');
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
