require('dotenv').config();
const express = require('express');
const path = require('path');

const PORT = process.env.PORT || 3000;
const AUTH_URL = process.env.AUTH_URL || 'http://localhost:4000';
const COORDINATOR_WS = process.env.COORDINATOR_WS || 'ws://localhost:5000';
// URLs públicas (ngrok). Si faltan, se usan las locales.
const PUBLIC_AUTH_URL = process.env.PUBLIC_AUTH_URL || AUTH_URL;
const PUBLIC_COORDINATOR_WS = process.env.PUBLIC_COORDINATOR_WS || COORDINATOR_WS;

const app = express();

function isLocal(req) {
  const host = (req.headers.host || '').split(':')[0];
  return host === 'localhost' || host === '127.0.0.1';
}

// Las URLs no van hardcoded en el HTML: se sirven desde el .env como /config.js.
// Si el cliente se abre por localhost usa los servicios locales; si se abre por
// el túnel de ngrok usa las URLs públicas (https:// y wss://).
app.get('/config.js', (req, res) => {
  const config = isLocal(req)
    ? { AUTH_URL, COORDINATOR_WS }
    : { AUTH_URL: PUBLIC_AUTH_URL, COORDINATOR_WS: PUBLIC_COORDINATOR_WS };
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(`window.APP_CONFIG = ${JSON.stringify(config)};`);
});

// Dos páginas: login.html (login + registro) y lobby.html
app.get('/', (req, res) => res.redirect('/login.html'));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Cliente en puerto ${PORT}`);
  console.log(`  local:   AUTH_URL=${AUTH_URL}  COORDINATOR_WS=${COORDINATOR_WS}`);
  console.log(`  público: AUTH_URL=${PUBLIC_AUTH_URL}  COORDINATOR_WS=${PUBLIC_COORDINATOR_WS}`);
});
