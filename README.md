# SSD Taller 5 — Proyecto Final Parte II: Juego en vivo + Login con Google

Videojuego web multijugador **Uber vs Taxi** del curso de Sistemas Distribuidos. La Parte I (Taller 4) dejó registro, login con JWT y lobby en tiempo real. Esta Parte II agrega:

- **El juego en vivo**: los jugadores se mueven en un `<canvas>` y todos ven a todos en tiempo real. **El servidor es la autoridad**: el cliente solo manda intenciones de movimiento y dibuja lo que el coordinador le dice.
- **Login con Google** (Google Identity Services): convive con usuario/contraseña en **una sola tabla `users`** y ambos métodos producen **el mismo JWT**.
- **Feature extra replicado**: color del auto + mood (emoji), vía `extras`. Además, un badge del provider (local / Google).

El sistema son tres procesos independientes que corren en **tres equipos distintos** y se comunican por red:

| Componente | Carpeta | Equipo | Puerto | Tecnología | Responsabilidad |
|---|---|---|---|---|---|
| Servicio de Autenticación | `auth-service/` | **A** | 4000 | Express + `node:sqlite` + bcrypt + JWT + `google-auth-library` | Registro, login local, login con Google, emitir JWT |
| Coordinador | `coordinator/` | **B** | 5000 | Express + `ws` + JWT | Validar el JWT, estado autoritativo del juego, game loop a 20 Hz |
| Cliente Web | `client/` | **C** | 3000 | HTML + JS plano (servido con Express) | Login/registro/Google, canvas del juego, input |

---

## 1. Arquitectura

```
                            ┌─────────────────────────────────────┐
                            │           Navegador (x N)            │
                            │  login.html ─ botón oficial Google   │
                            │  lobby.html ─ canvas + lastState     │
                            └──┬───────────────┬────────────────┬──┘
         GET páginas y         │               │ HTTP           │ WebSocket
         /config.js            │               │ POST /register │ /connect?token=JWT
                               │               │ POST /login    │  ↑ intent, extras_update
                               ▼               │ POST /auth/google  ↓ welcome, state (20 Hz),
    ┌───────────────────────────────┐          │                │    players_update
    │ EQUIPO C · Cliente :3000      │          ▼                ▼
    │ sirve HTML/JS y /config.js    │  ┌──────────────────┐  ┌──────────────────────────────┐
    │ (URLs + GOOGLE_CLIENT_ID)     │  │ EQUIPO A · Auth  │  │ EQUIPO B · Coordinador :5000 │
    └───────────────────────────────┘  │ :4000            │  │ - verifica JWT en 'upgrade'  │
                                       │ - users (1 tabla)│  │ - Map userId → {x, y,        │
       ┌──────────────────────┐        │ - bcrypt         │  │     intent, extras, ...}     │
       │ Google (claves       │◄───────│ - verifyIdToken  │  │ - game loop 20 Hz: aplica    │
       │ públicas / JWKS)     │ firma  │ - firma JWT      │  │   intents y broadcast state  │
       └──────────────────────┘        └────────┬─────────┘  └──────────────▲───────────────┘
                                                │   misma JWT_SECRET         │
                                                └────────── (.env) ──────────┘
```

**Flujo**

1. **Login local**: `POST /login` → JWT `{ userId, username, provider: 'local' }`.
2. **Login con Google**: el botón oficial de Google entrega un **ID token** (JWT firmado por Google) → el cliente hace `POST /auth/google { idToken }` → el auth lo **verifica contra Google** (firma + `aud`) → si es la primera vez responde `409 username_required`, el cliente pide un username y reintenta con `{ idToken, username }` → JWT `{ userId, username, provider: 'google' }`.
3. Con cualquiera de los dos JWT el cliente abre `WebSocket /connect?token=JWT`. El coordinador **no sabe ni le importa** cómo se autenticó el usuario: solo valida la firma con la `JWT_SECRET` compartida.
4. El coordinador responde `welcome` con el tamaño del mundo, y desde ahí manda `state` 20 veces por segundo.
5. El cliente manda `intent` cuando cambia la dirección y `extras_update` cuando cambia su color/mood. **Nunca manda posiciones.**

---

## 2. Estructura del repositorio

```
SSD_TALLER_4/
├── auth-service/
│   ├── index.js            # /register, /login, /auth/google, /health
│   ├── test/               # npm test: endpoints, Google (stub + verificación real), migración
│   ├── package.json
│   └── .env.example
├── coordinator/
│   ├── index.js            # WS /connect, game loop, intent/extras_update, /health
│   ├── test/               # npm test: levanta el coordinador real y juega por WS
│   ├── package.json
│   └── .env.example
├── client/
│   ├── server.js           # sirve public/ y /config.js (URLs + GOOGLE_CLIENT_ID)
│   ├── package.json
│   ├── .env.example
│   └── public/
│       ├── login.html      # login, registro y "Entrar con Google" (+ elegir username)
│       ├── lobby.html      # canvas del juego, controles del feature extra, jugadores en línea
│       └── style.css
├── .gitignore              # node_modules/, *.db, .env
└── README.md
```

---

## 3. Configurar Google Cloud (una sola vez)

1. Entrar a [Google Cloud Console](https://console.cloud.google.com/) y crear un proyecto (p. ej. `taller-distribuidos`).
2. **APIs & Services → OAuth consent screen**:
   - User Type: **External**.
   - App name y support email: cualquiera.
   - Scopes: **`openid`**, **`email`**, **`profile`** ("Add or Remove Scopes").
   - Mientras la app esté en modo *Testing*, agregar en **Test users** los correos de Google que se van a usar en la demo.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized JavaScript origins** (desde donde se abre el **cliente**, equipo C):
     - `http://localhost:3000`
     - `https://<url-del-cliente>.ngrok-free.app` (la del túnel del equipo C)
   - Authorized redirect URIs: **vacío** (usamos la opción A, no hay callback).
4. Copiar el **Client ID** (`xxxx.apps.googleusercontent.com`). Va en `GOOGLE_CLIENT_ID` de **`auth-service/.env` (equipo A)** y de **`client/.env` (equipo C)**. El Client Secret **no se usa** con la opción A.

> Google **no permite** orígenes `http://` que no sean `localhost` (por ejemplo `http://192.168.1.12:3000`). Por eso, en el despliegue en 3 equipos, el botón de Google funciona abriendo el cliente por **`http://localhost:3000` en el equipo C** o por **la URL HTTPS de ngrok** del cliente desde cualquier equipo. Los botones de usuario/contraseña funcionan en todos los casos.

---

## 4. Despliegue en tres equipos

### Requisitos (en los tres equipos)

- **Node.js 22.5 o superior** (el auth usa `node:sqlite`, que viene con Node; no hay que compilar nada). Probado con Node 24.
- npm.
- ngrok (cada equipo expone **su** servicio con **su propia cuenta** de ngrok: el plan gratuito permite una sesión de agente por cuenta).

### Paso 0 — Datos compartidos

Antes de empezar, el equipo acuerda:

| Dato | Dónde va | Cómo |
|---|---|---|
| `JWT_SECRET` | Equipo A **y** equipo B, **idéntica** | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (64 caracteres; el auth y el coordinador no arrancan con menos de 32) |
| `GOOGLE_CLIENT_ID` | Equipo A **y** equipo C | Google Cloud Console (sección 3) |
| IP LAN del equipo A y del B | `client/.env` del equipo C | `ipconfig` → "Dirección IPv4" |

Si la `JWT_SECRET` difiere entre A y B, todos los tokens son rechazados con `4001` (error típico #9).

### Paso 1 — Equipo A: auth-service (puerto 4000)

```bash
git clone https://github.com/AndresPlazas10/SSD_TALLER_4.git
cd SSD_TALLER_4/auth-service
npm install
copy .env.example .env      # Linux/Mac: cp .env.example .env
# editar .env: JWT_SECRET (la compartida) y GOOGLE_CLIENT_ID
npm start
# → Auth service en puerto 4000
```

### Paso 2 — Equipo B: coordinator (puerto 5000)

```bash
cd SSD_TALLER_4/coordinator
npm install
copy .env.example .env
# editar .env: EXACTAMENTE la misma JWT_SECRET del equipo A
#              AUTH_URL=http://<IP-equipo-A>:4000
npm start
# → Coordinador en puerto 5000 (game loop a 20 Hz, mundo 800x600)
```

### Paso 3 — Equipo C: client (puerto 3000)

```bash
cd SSD_TALLER_4/client
npm install
copy .env.example .env
# editar .env:
#   AUTH_URL=http://<IP-equipo-A>:4000
#   COORDINATOR_WS=ws://<IP-equipo-B>:5000
#   GOOGLE_CLIENT_ID=<el mismo del equipo A>
#   PUBLIC_AUTH_URL / PUBLIC_COORDINATOR_WS = URLs ngrok de A y B (paso 5)
npm start
```

### Paso 4 — Firewall de Windows (equipos A y B)

Windows bloquea por defecto las conexiones entrantes. En una PowerShell **como administrador**:

```powershell
# Equipo A
New-NetFirewallRule -DisplayName "SSD auth 4000" -Direction Inbound -Protocol TCP -LocalPort 4000 -Action Allow
# Equipo B
New-NetFirewallRule -DisplayName "SSD coordinador 5000" -Direction Inbound -Protocol TCP -LocalPort 5000 -Action Allow
```

Verificar desde el equipo C: `curl http://<IP-A>:4000/health` y `curl http://<IP-B>:5000/health`.

> Con ngrok el firewall no hace falta (ngrok abre una conexión **saliente**), pero sí para probar por la LAN.

### Paso 5 — Túneles ngrok (sustentación)

```bash
# Equipo A
ngrok http 4000
# Equipo B
ngrok http 5000
# Equipo C
ngrok http 3000
```

En `client/.env` (equipo C) poner las URLs que entregan A y B y reiniciar el cliente:

```env
PUBLIC_AUTH_URL=https://<url-auth>.ngrok-free.app
PUBLIC_COORDINATOR_WS=wss://<url-coordinador>.ngrok-free.app
```

Y agregar `https://<url-cliente>.ngrok-free.app` en **Authorized JavaScript origins** de Google Cloud (tarda unos minutos en aplicar).

- Página por **HTTPS** ⇒ WebSocket por **`wss://`** (si no, el navegador lo bloquea por contenido mixto).
- `/config.js` decide qué URLs darle al navegador: si el cliente se abre por `localhost` usa `AUTH_URL`/`COORDINATOR_WS` (IPs de la LAN); si se abre por el túnel usa las `PUBLIC_*`.
- Las peticiones al auth llevan `ngrok-skip-browser-warning` para saltar la página intermedia de ngrok.

### Paso 6 — Relojes sincronizados

El JWT lo firma el equipo A (`iat`, `exp`) y lo valida el equipo B con **su** reloj. Si los relojes difieren, un token recién emitido puede parecer vencido. El coordinador tolera `JWT_CLOCK_TOLERANCE_S=5` segundos; aun así conviene sincronizar los equipos (Windows: *Configuración → Hora → Sincronizar ahora*, o `w32tm /resync` como administrador).

### Variables de entorno

Ningún secreto, puerto ni URL está hardcodeado; todo viene de `.env` (`dotenv`). `.env` está en `.gitignore` desde el primer commit; cada servicio versiona su `.env.example`.

| Equipo | Servicio | Variable | Ejemplo | Descripción |
|---|---|---|---|---|
| A | auth-service | `PORT` | `4000` | Puerto HTTP |
| A | auth-service | `JWT_SECRET` | 64 hex | Secret del JWT (≥ 32 chars, **igual que B**) |
| A | auth-service | `JWT_EXPIRES_IN` | `1h` / `30s` | Expiración del token (se recarga en caliente, ver abajo) |
| A | auth-service | `BCRYPT_ROUNDS` | `10` | Rondas de bcrypt (no arranca con menos de 10) |
| A | auth-service | `GOOGLE_CLIENT_ID` | `xxx.apps.googleusercontent.com` | `aud` esperado de los ID tokens (no arranca sin él) |
| A | auth-service | `DB_FILE` | `users.db` | Archivo SQLite |
| B | coordinator | `PORT` | `5000` | Puerto HTTP + WS |
| B | coordinator | `JWT_SECRET` | 64 hex | **La misma** que A |
| B | coordinator | `JWT_CLOCK_TOLERANCE_S` | `5` | Diferencia de reloj tolerada con A |
| B | coordinator | `SESSION_MAX_AGE` | vacío / `30s` / `1h` | Duración máxima de la sesión desde el `iat`; afecta también a sesiones abiertas (se recarga en caliente, ver abajo) |
| B | coordinator | `AUTH_URL` | `http://192.168.1.10:4000` | URL del auth: el coordinador consulta su `/token-policy` para aplicar `JWT_EXPIRES_IN` a las sesiones abiertas (vacío = desactivado) |
| B | coordinator | `TOKEN_POLICY_POLL_MS` | `1000` | Cada cuánto se consulta `/token-policy` |
| B | coordinator | `HEARTBEAT_MS` | `30000` | Intervalo de ping/pong |
| B | coordinator | `WORLD_WIDTH` / `WORLD_HEIGHT` | `800` / `600` | Tamaño del mundo |
| B | coordinator | `PLAYER_RADIUS` | `20` | Radio del jugador |
| B | coordinator | `PLAYER_SPEED` | `200` | px/seg |
| B | coordinator | `TICK_RATE` | `20` | Hz del game loop |
| B | coordinator | `OBSTACLES` | `on` / `off` | Estructuras de la ciudad con colisión (`off` = mundo vacío, lo usan los tests) |
| C | client | `PORT` | `3000` | Puerto del servidor estático |
| C | client | `AUTH_URL` / `COORDINATOR_WS` | `http://192.168.1.10:4000` / `ws://192.168.1.11:5000` | URLs LAN (cliente abierto por localhost) |
| C | client | `PUBLIC_AUTH_URL` / `PUBLIC_COORDINATOR_WS` | `https://….ngrok-free.app` / `wss://….ngrok-free.app` | URLs de ngrok |
| C | client | `GOOGLE_CLIENT_ID` | `xxx.apps.googleusercontent.com` | El mismo que A (es público) |

Las variables se leen al arrancar, así que cambiarlas exige reiniciar el servicio. La excepción es **`JWT_EXPIRES_IN`**, que se puede cambiar sin reiniciar nada:

- En cada login (`/login` y `/auth/google`), el auth-service revisa si `auth-service/.env` cambió (por su fecha de modificación) y, si cambió, relee `JWT_EXPIRES_IN`. Si el archivo no cambió, no lo relee.
- Al aplicar un cambio, la consola muestra `[config] JWT_EXPIRES_IN: 1h -> 30s`.
- Un valor inválido (p. ej. `JWT_EXPIRES_IN=basura`) se ignora con un error en consola y se conserva el anterior: el login no se cae con un 500.
- **También afecta a las sesiones ya abiertas**, sin volver a iniciar sesión (ver el párrafo siguiente).
- Si `JWT_EXPIRES_IN` se define en la terminal antes de arrancar (`$env:JWT_EXPIRES_IN="30s"; npm start`), ese valor tiene prioridad y el `.env` no se relee (así los tests fijan el suyo).

**Sesiones ya abiertas: `GET /token-policy`.** El `exp` va firmado dentro del token y no se puede cambiar. Por eso el auth publica su duración vigente en `GET /token-policy` → `{ "expiresInSeconds": 5 }`, que relee el `.env` igual que el login. El coordinador la consulta cada `TOKEN_POLICY_POLL_MS` (1 s) en `AUTH_URL`:

- Si el valor cambia, vuelve a programar el cierre de **todas las sesiones abiertas**. Para una sesión abierta antes del cambio, la nueva duración **se cuenta desde el cambio**, no desde su login: con `5s` se cierra 5 s después de guardar el `.env`, no al instante. Al cumplirse cierra con `4001 "token expired"` y el cliente vuelve al login. Las sesiones que se abren después del cambio cuentan desde su login, como su token.
- La consola del coordinador muestra `[auth] JWT_EXPIRES_IN: 3600s -> 5s (se aplica a N sesiones abiertas)`.
- Ejemplo: tienes una sesión abierta hace 1 minuto con un token de 1 h. Cambias `JWT_EXPIRES_IN=30s` en `auth-service/.env` y guardas. La sesión se cierra unos 30 s después; el coordinador puede tardar hasta `TOKEN_POLICY_POLL_MS` en ver el cambio.
- Si el auth no responde, el coordinador conserva el último valor y avisa una vez en consola. Una caída del auth no cierra sesiones ya validadas.
- Subir el valor (de `5s` a `1h`) no alarga un token ya emitido: su `exp` sigue mandando.
- En los tres equipos, `AUTH_URL` apunta al equipo A, igual que en el cliente. El firewall del equipo A ya permite el puerto 4000 (paso 4).

**Límite propio del coordinador: `SESSION_MAX_AGE` (opcional, equipo B).** Sirve para limitar las sesiones desde el coordinador sin tocar el auth:

- El coordinador cierra cada sesión cuando ocurre lo primero: vence el `exp` del token, se cumple la duración del auth (los dos con `4001 "token expired"`) o se cumple `SESSION_MAX_AGE` (`4001 "session expired"`). Cada duración cuenta desde el login o desde que se aplicó el cambio, lo que sea más tarde. El cliente vuelve al login en todos los casos.
- El coordinador vigila su `.env` (lo revisa cada ~1 s). Al cambiar `SESSION_MAX_AGE`, vuelve a programar el cierre de **todas las sesiones abiertas**, contando el nuevo límite desde el cambio. La consola muestra `[config] SESSION_MAX_AGE: 3600s -> 5s (se aplica a N sesiones abiertas)`.
- Vacío (por defecto) = sin límite extra: solo cuenta el `exp`. Un valor inválido se ignora y se conserva el anterior. Al arrancar, en cambio, el servicio no inicia con un valor inválido.
- Al igual que con `JWT_EXPIRES_IN`, un valor definido en la terminal tiene prioridad y el `.env` no se vigila.

### Correr todo en un solo equipo (desarrollo)

Igual que arriba pero con `AUTH_URL=http://localhost:4000` y `COORDINATOR_WS=ws://localhost:5000` en `client/.env`.

---

## 5. Base de datos: una sola tabla `users`

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE
           CHECK(username = lower(username) COLLATE BINARY),  -- siempre en minúscula
  provider TEXT NOT NULL CHECK(provider IN ('local','google')),
  password_hash TEXT,          -- NULL para usuarios de Google
  google_sub TEXT UNIQUE,      -- NULL para usuarios locales
  email TEXT,                  -- opcional para local
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  vehicle TEXT NOT NULL DEFAULT 'taxi' CHECK(vehicle IN ('uber','taxi'))  -- bando elegido al registrarse
);
```

| provider | password_hash | google_sub | email |
|---|---|---|---|
| `local` | hash bcrypt | `NULL` | `NULL` |
| `google` | `NULL` | `sub` del ID token | email de Google |

- `username UNIQUE` aplica **entre ambos providers**: `alice` local y `alice` Google no pueden coexistir. Con dos tablas (`users_local`, `users_google`) un mismo nombre podría tener dos cuentas y el coordinador, el score y la replicación futura tendrían que duplicarse.
- **Username sin distinguir mayúsculas**: `Alice`, `ALICE` y `alice` son el mismo usuario. El auth convierte el username a minúscula antes de registrar, loguear o crear la cuenta de Google (el login acepta cualquier combinación y el JWT lleva el nombre en minúscula). La base de datos lo exige por su cuenta: el `CHECK` rechaza cualquier username con mayúsculas aunque se inserte sin pasar por la API, y `COLLATE NOCASE` hace que el `UNIQUE` ignore mayúsculas. En el `CHECK` va `COLLATE BINARY` porque, si no, la comparación hereda el `NOCASE` de la columna y `'Alice' = 'alice'` daría verdadero.
- **Migración a minúscula**: un `users.db` creado antes de este cambio se reconstruye al arrancar con cada username pasado a minúscula, conservando los `id`. Si ya hay dos usuarios que solo difieren en mayúsculas (`Ana` y `ana`), el auth **no arranca** y los lista en el error. Hay que resolverlo a mano (renombrar o borrar uno) porque no se puede saber cuál conservar.
- **Migración automática**: si el `users.db` viene del Taller 1 (sin columna `provider`), al arrancar el auth copia esos usuarios como `provider = 'local'` conservando sus `id` (así los JWT y el coordinador siguen funcionando).
- **Uber o Taxi (`vehicle`)**: se elige al registrarse (y en el primer ingreso con Google) y no se cambia después. La base solo acepta `'uber'` o `'taxi'` (`CHECK`). Un `users.db` anterior a esta columna la recibe al arrancar con `ALTER TABLE … ADD COLUMN` y sus usuarios quedan como `taxi`.
- Literales SQL con **comillas simples** (`'local'`); con comillas dobles SQLite los interpreta como nombres de columna (error típico #11).

---

## 6. API del auth service

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| POST | `/register` | `{ username, password, vehicle }` | `201 { userId, username, vehicle }` |
| POST | `/login` | `{ username, password }` | `200 { token, username, vehicle }` |
| POST | `/auth/google` | `{ idToken, username?, vehicle? }` | ver abajo |
| GET | `/health` | — | `200 { ok: true }` |
| GET | `/token-policy` | — | `200 { expiresInSeconds }` (duración vigente de `JWT_EXPIRES_IN`; la usa el coordinador) |

**`/register`**: `409` si el username ya existe (en cualquier provider), `400` si el body es inválido (username 3–32 `[A-Za-z0-9_]`, password 6–72, `vehicle` distinto de `"uber"` o `"taxi"`) o el JSON está mal formado, `413` si el body supera 4 KB.

**`/login`**: `401 { error: "Credenciales inválidas" }` si no coinciden; `401 { error: "use_google_login", hint }` si el usuario es de Google (no tiene contraseña); `400` si faltan campos.

**`/auth/google`**:

| Caso | Código | Respuesta |
|---|---|---|
| Ya existía (por `google_sub`) o se creó | `200` | `{ token, username, vehicle }` |
| Primer ingreso sin `username` | `409` | `{ error: "username_required", hint }` |
| `username` ya usado (local o Google) | `409` | `{ error: "username_taken" }` |
| ID token inválido (firma, `aud`, `iss`, vencido) | `401` | `{ error: "invalid_id_token" }` |
| `email_verified` distinto de `true` | `401` | `{ error: "email_not_verified" }` |
| Sin `idToken` / username con formato inválido / alta sin `vehicle` válido | `400` | `{ error }` |

El JWT (de `/login` y de `/auth/google`) lleva `{ userId, username, provider, vehicle }`. Al ir firmado, el cliente no puede cambiar su bando.

### Ejemplos con curl

```bash
curl -X POST http://localhost:4000/register -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123","vehicle":"taxi"}'

curl -X POST http://localhost:4000/login -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'

# Un usuario de Google no puede usar /login
curl -X POST http://localhost:4000/login -H "Content-Type: application/json" \
  -d '{"username":"bob_google","password":"loquesea"}'
# → 401 {"error":"use_google_login","hint":"Esta cuenta se creó con Google: ..."}

# Un ID token falso (o decodeable pero no firmado por Google) es rechazado
curl -X POST http://localhost:4000/auth/google -H "Content-Type: application/json" \
  -d '{"idToken":"eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.firma-falsa"}'
# → 401 {"error":"invalid_id_token"}
```

> En Windows PowerShell usar `curl.exe` y escapar las comillas del JSON, o probar desde Postman / Thunder Client.

---

## 7. Protocolo WebSocket (coordinador)

Conexión: `ws(s)://<coordinador>/connect?token=<JWT>`. El JWT se valida en el `upgrade`.

**Servidor → cliente**

| Mensaje | Cuándo | Contenido |
|---|---|---|
| `welcome` | Al conectar | `{ type, you: { userId, username, provider, vehicle }, world: { width, height, playerRadius, tickRate, passengerRadius, cell, sidewalk, obstacles, blocks } }` |
| `state` | Cada tick (20 Hz) | `{ type, t, players: [{ userId, username, provider, vehicle, x, y, angle, score, extras }], passenger: { x, y }, teams: { uber, taxi } }` |
| `players_update` | Alguien entra o sale | `{ type, players: [{ userId, username, provider, vehicle }] }` (lista del lobby) |
| `pickup` | Un auto recoge al pasajero | `{ type, userId, username, vehicle, score }` (para el aviso en pantalla) |

`obstacles` es la lista de lo que choca: un rectángulo `{ kind: "poly", name, points: [[x, y], …] }` por manzana (la colisión también soporta `{ kind: "circle", x, y, r }` y polígonos cóncavos). `blocks` describe qué hay dentro de cada manzana (`type`: `casas`, `conjunto`, `edificio` o `parque`, con sus `houses`, `building` o `trees`) y es **solo decoración**. Las colisiones las resuelve el coordinador.

**Cliente → servidor**

| Mensaje | Contenido | Qué hace el servidor |
|---|---|---|
| `intent` | `{ type: "intent", intent: { dir: { x: -1\|0\|1, y: -1\|0\|1 } } }` | Guarda `p.intent = { x: Math.sign(x), y: Math.sign(y) }`. **No mueve ni hace broadcast.** |
| `extras_update` | `{ type: "extras_update", extras: { color: "#ff5500", mood: "😎" } }` | Si es un objeto (no array) de ≤ 1024 caracteres serializado, lo guarda en `p.extras`. Se replica en el próximo `state`. |

**Códigos de cierre**: `4001 "invalid token"` / `4001 "token expired"` / `4001 "session expired"`, `4002 "session replaced"`, `1009` (mensaje > 4 KB).

---

## 8. El game loop (servidor autoritativo)

`coordinator/index.js` → función `tick()`:

```js
function tick() {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.25); // segundos reales desde el tick anterior
  lastTick = now;
  for (const p of players.values()) {
    const mag = Math.hypot(p.intent.x, p.intent.y);          // normalizar diagonales
    if (mag > 0) {
      p.x += (p.intent.x / mag) * PLAYER_SPEED * dt;
      p.y += (p.intent.y / mag) * PLAYER_SPEED * dt;
    }
    p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, p.x));   // dentro del mundo
    p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y));
  }
  if (players.size > 0) broadcast({ type: 'state', t: now, players: snapshot() }); // 1 broadcast por tick
}
```

Estado de cada jugador en el `Map`: `{ username, provider, vehicle, socket, connectedAt, x, y, angle, intent, extras, score }`. Al conectar, `x`/`y` son un punto aleatorio **en la calle** (nunca dentro de una estructura), `intent = {x:0,y:0}`, `extras = {}` y `score = 0`. Si la sesión se reemplaza (otra pestaña), la nueva hereda posición, orientación, extras y puntaje.

El código de arriba es la versión base. Con la ciudad, `tick()` además:

- **Divide el movimiento en substeps** de como mucho medio radio y, después de cada uno, saca al auto de cualquier estructura que toque (`resolve` en `coordinator/map.js`). Así el auto no puede atravesar la punta de un triángulo aunque `dt` sea grande.
- **Guarda `angle`** (`atan2` del intent) para que el cliente dibuje el auto mirando hacia donde avanza.
- **Revisa si algún auto llegó al pasajero**. Si es así, le suma 1 punto a ese jugador y a su equipo (`teams.uber` / `teams.taxi`), manda `pickup` a todos y ubica al pasajero en otro lugar.

---

## 8.1 La ciudad: manzanas, Uber vs Taxi y pasajero

**Mapa** (`coordinator/map.js`): el mundo es una cuadrícula de calles con manzanas de 200 × 200 px (12 en el mundo de 800 × 600). Cada calle lleva línea amarilla discontinua en el centro y pasos de cebra en los cruces. Entre dos manzanas la calle mide `2·(2·PLAYER_RADIUS + 5)` = 90 px y contra el borde del mundo 45 px: el auto siempre cabe. Cada manzana tiene un **andén** de 8 px y adentro uno de estos tipos:

| Tipo | Qué tiene |
|---|---|
| `casas` | Dos filas de casas de anchos distintos, una mirando a cada calle, con patios en el medio |
| `conjunto` | Cuatro casas en las esquinas, con los techos en direcciones alternadas |
| `edificio` | Un edificio de azotea plana con equipos de aire acondicionado y helipuerto |
| `parque` | Césped, senderos en cruz, fuente y árboles |

Las casas se ven desde arriba con **techo a dos aguas**: dos faldones de distinto tono, la cumbrera marcada y, en algunas, chimenea. Los tamaños y colores salen de un generador pseudoaleatorio **con semilla**, así que el mismo tamaño de mundo da siempre la misma ciudad, en los tres equipos y después de reiniciar. El coordinador manda el mapa en `welcome` y el cliente lo dibuja una sola vez en un canvas aparte.

**Colisiones (servidor autoritativo)**: cada manzana, con su andén, es un rectángulo **sólido**. Como en una ciudad real, los autos van por la calle: no pueden subirse al andén ni meterse entre las casas.
- El auto se trata como un círculo de radio `PLAYER_RADIUS`. Contra cada polígono se busca el punto del borde más cercano y se usa *ray casting* para saber si el centro quedó adentro.
- Al chocar, se empuja al auto solo lo que penetró, en la dirección de la pared. Por eso **se desliza** por el andén en vez de frenar en seco.
- El cliente nunca decide si chocó. Si alguien modifica su cliente, igual no atraviesa las manzanas.

**Uber o Taxi**: el jugador elige su bando al registrarse (`vehicle` en `/register`, o en el primer ingreso con Google). Queda guardado en la base y viaja **firmado en el JWT**: el coordinador lo lee del token validado, no de `extras`, así que nadie puede cambiarse de equipo desde DevTools. Los tokens anteriores a esta opción juegan como taxi.
- **Taxi**: amarillo, con franja de cuadros y letrero `TAXI` en el techo.
- **Uber**: negro, con la placa de la `U` en el techo.
- **Color según el bando**, validado por el coordinador (`sanitizeExtras`):
  - **Taxi**: todos los taxis son amarillos. El panel "Tu auto" no ofrece colores y, si un cliente modificado manda uno, el coordinador lo descarta.
  - **Uber**: puede elegir color, menos **amarillo**, para no confundirse con un taxi. Se considera amarillo un tono entre 40° y 70° en HSL, saturado (≥ 50 %) y con luminosidad entre 30 % y 85 %. Cubre `#ffc928`, `#ffff00` y sus variantes, pero no naranjas ni blancos. Las muestras no incluyen el amarillo, el selector libre lo rechaza con un aviso y el coordinador lo descarta si llega igual. El botón ↺ vuelve al negro Uber.
  - El cliente aplica la misma regla al dibujar: un taxi se ve amarillo y un Uber nunca amarillo, digan lo que digan los `extras`.

**Auto**: se dibuja visto desde arriba, con parabrisas, faros y luces traseras, rotado según `angle`. El ángulo se interpola por el camino más corto entre ticks. El dibujo cabe dentro del círculo de colisión.

**Pasajero** 🙋: hay **uno solo, compartido**. Espera en la calle **junto al andén** de una manzana, en un punto donde cabe un auto (así siempre es alcanzable) y, si se puede, a más de 150 px de todos los autos. Se ve como un punto amarillo que late, y una flecha amarilla junto a tu auto apunta hacia él. El primer auto que llega lo recoge: el servidor lo decide en el tick y suma 1 al jugador y a su equipo. El puntaje se ve junto al nombre en el mapa y en la lista "En línea", y el marcador **UBER · TAXI** en la esquina inferior derecha del mapa.

---

## 9. Feature extra: color del auto + mood

- En el panel **"Tu auto"** el jugador elige un **mood** (😎 🤑 😡 😴 🥳 🚀 o ninguno) y, si es **Uber**, un **color** (muestras sin amarillo + selector libre). Los taxis siempre son amarillos (ver 8.1).
- El cliente manda `extras_update` con el objeto completo `{ color, mood }`. El servidor quita el color si el bando no lo permite, lo guarda en `player.extras` y lo incluye en **cada** `state`. Todos los demás clientes lo dibujan: el auto toma el color y el emoji aparece junto al nombre.
- **Replicado**: lo que cambia un cliente lo ven todos en ≤ 50 ms.
- **Persistente durante la sesión**: vive en el estado del jugador en el servidor (no es un evento puntual). Quien entra después lo ve igual. Si la sesión se reemplaza (otra pestaña), los extras pasan a la nueva. Además el cliente guarda la elección en `localStorage` y la reenvía tras `welcome`, así sobrevive a una recarga.
- **Badge del provider**: cada jugador muestra una `G` (Google) o 🔑 (usuario y contraseña). Ese dato **no** viene de `extras` (lo podría falsear el cliente) sino del JWT validado por el coordinador.
- Como `extras` lo escribe cualquier cliente, el que dibuja **valida antes de usar**: color solo si cumple `^#[0-9a-fA-F]{6}$`, mood recortado a 2 caracteres, y todo se dibuja con `fillText` / `textContent` (sin `innerHTML`, sin XSS).

---

## 10. Decisiones de diseño

### Opción A (Google Identity Services) en vez de la B (Authorization Code)

- **Encaja con la arquitectura distribuida**: el auth sigue siendo una API JSON sin estado (`POST /auth/google`), igual que `/login`. Con la opción B el auth tendría que recibir el redirect de Google, guardar `state`/sesión entre la ida y la vuelta y luego devolver el JWT al cliente (que está en **otro equipo y otro origen**) por redirect o cookie.
- **Menos secretos**: la opción A solo necesita el **Client ID** (público). La B exige guardar el **Client Secret** en el auth.
- **Menos configuración con ngrok**: la B exige registrar en Google la `redirect_uri` exacta del auth, que cambia cada vez que cambia la URL del túnel. La A solo exige el origen del cliente.
- **El flujo "elige tu username" es natural**: el cliente conserva el ID token en memoria y simplemente reintenta `POST /auth/google { idToken, username }`. Con la B habría que mantener el ID token en una sesión del servidor mientras el usuario elige.
- La seguridad es equivalente: en ambos casos el servidor verifica el ID token con las claves públicas de Google.

### Verificación del ID token de Google

- `googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID })` valida la **firma** contra las claves públicas de Google, el **emisor**, la **expiración** y que el **`aud`** sea nuestro Client ID. Decodear el JWT no basta: cualquiera puede armar un JSON con el formato correcto (error típico #6). Hay un test que firma un token "de Google" con una clave propia y comprueba que se rechaza.
- Sin `audience` se aceptarían ID tokens emitidos para **otras** apps de Google (error típico #7).
- Se exige `email_verified === true`.
- La llave del usuario es **`sub`**, no el email: el email de una cuenta de Google puede cambiar; `sub` no (error típico #8). Hay un test que entra con el mismo `sub` y otro email y obtiene el mismo usuario.
- El cliente **no** valida el ID token: solo lo reenvía. La confianza está en el servidor.

### Un usuario de Google no puede usar `/login`, y alice no puede "entrar" por Google

- `/login` revisa `user.provider !== 'local'` y responde `401 use_google_login`: esa cuenta no tiene contraseña. Se eligió un mensaje explícito (en vez del genérico) porque el usuario necesita saber que debe usar el botón de Google; la existencia del username ya es pública vía `409` en `/register`.
- `/auth/google` busca **por `google_sub`**, nunca por username. Si alguien entra con Google y pide el username `alice` (cuenta local), el `UNIQUE` lo impide → `409 username_taken`. Las cuentas no se fusionan automáticamente: eso permitiría a quien controle un Google tomar una cuenta local ajena.
- Doble clic / dos pestañas creando la misma cuenta de Google a la vez: si el `UNIQUE` que salta es el de `google_sub`, se devuelve el token de la cuenta ya creada en vez de un falso `username_taken`.

### Mismo JWT para ambos providers

`{ userId, username, provider }` firmado con la misma `JWT_SECRET`. El coordinador no cambia según el provider; `provider` solo se usa para el badge.

### Servidor autoritativo

- El cliente manda **intenciones** `{x, y} ∈ {-1, 0, 1}`; el servidor decide la posición. El cliente nunca calcula ni envía `x`/`y`.
- `ws.on('message')` **solo guarda** `p.intent` / `p.extras`. Quien mueve es el game loop; si moviera el handler, la velocidad dependería de cuántos mensajes mande el cliente (error típico #2). Test: mandar ~5000 intents en 0,5 s no acelera al jugador.
- **Un broadcast por tick**, nunca uno por intent (error típico #4). Test: el spam de intents no aumenta la cantidad de `state` recibidos.
- **Sanitización**: `Math.sign` convierte `{x: 9999}` en `1` (error típico #5); un `dir` no numérico se ignora; `JSON.parse('null')` o `'5'` se descartan antes de leer `msg.type` (sin ese chequeo, un cliente podía tumbar el coordinador con un mensaje `null`).
- **Límites de tamaño**: `maxPayload` de 4 KB en el `WebSocketServer` (un mensaje de 10 MB se corta con `1009` **antes** de parsearlo) y `extras` ≤ 1024 caracteres serializados.
- Si un socket fue reemplazado (código 4002), sus mensajes ya no controlan al jugador.

### `dt`, diagonales y tick rate

- Se usa `dt` real (`Date.now()`) para que la velocidad sea `PLAYER_SPEED` px/s sin importar el `TICK_RATE` ni los retrasos del timer (error típico #3). Se acota a 250 ms para que una pausa del proceso no produzca un salto enorme.
- Diagonales normalizadas con `Math.hypot`; sin eso irían ~41 % más rápido (error típico #1). Test: en diagonal recorre ~100 px en 0,5 s, no ~141.
- **Tick rate real de 20 Hz en Windows**: medimos que `setInterval(tick, 50)` en Windows dispara cada ~60 ms (resolución del timer de ~15,6 ms) ⇒ **16,7 Hz**. El loop se agenda con `setTimeout` contra un horario fijo (`nextTickAt += TICK_MS`), así el promedio queda en 20 Hz. Test: entre 18 y 22 `state` por segundo.

### Cliente: dibujar, no simular

- `lastState` es una **variable global** con el último `state` del servidor; el canvas dibuja eso. Para que el movimiento a 20 Hz se vea fluido a 60 fps, se **interpola** entre el `state` anterior y el último (solo entre posiciones que ya mandó el servidor; no hay predicción).
- Si alguien modifica `lastState` en DevTools, solo cambia **su** pantalla y solo hasta el próximo tick: el servidor es la fuente de verdad.
- El intent se manda **solo cuando cambia la dirección** (keydown/keyup), no en cada frame. Al perder el foco (`blur`) se manda `{0,0}` para que el jugador no quede caminando solo.
- El canvas toma su tamaño de `welcome.world`, no de valores fijos en el HTML.

### Sesión del mismo usuario en otra pestaña

Igual que en la Parte I: gana la conexión nueva y la anterior se cierra con `4002`. Ahora además **la nueva hereda posición y extras**: es el mismo jugador, no debería reaparecer en otro lugar.

### Despliegue en tres equipos

- Cada servicio lee sus URLs/puertos/secretos de su `.env`; el cliente recibe las URLs del auth y del coordinador desde `/config.js`, así el mismo HTML sirve para LAN y para ngrok.
- `JWT_CLOCK_TOLERANCE_S` absorbe pequeñas diferencias de reloj entre el equipo que firma (A) y el que valida (B).
- `JWT_SECRET` y `GOOGLE_CLIENT_ID` se validan al arrancar: el servicio no inicia con un `.env` incompleto, en vez de fallar más tarde con errores confusos.

### Decisiones heredadas de la Parte I

- El JWT se verifica en el `upgrade` (un token inválido nunca entra al `Map`), cerrando con `4001` para que el navegador pueda leer el código.
- La sesión WS no dura más que el token (`4001 "token expired"`).
- **Cambio del token en tiempo real**: el lobby revisa `localStorage` cada segundo (`TOKEN_CHECK_MS` en `client/public/lobby.html`). Si el token cambió, abre un WebSocket nuevo con él y cierra el anterior, sin recargar la página; el coordinador lo vuelve a validar en el `upgrade`. Un token inválido termina en `4001` → login; uno válido de otro usuario actualiza el nombre del encabezado; si se borra, se cierra la sesión. Se usa un chequeo periódico y no el evento `storage` porque ese evento solo llega a las *otras* pestañas, no a la que hizo el cambio (p. ej. una edición desde DevTools).
- Heartbeat ping/pong para detectar conexiones muertas.
- bcrypt (≥ 10 rondas), hash falso para igualar tiempos cuando el usuario no existe, consultas preparadas, `textContent` en vez de `innerHTML`.
- **`node:sqlite`** reemplaza a `better-sqlite3` (como en el esqueleto del enunciado): viene con Node 22.5+, sin binarios nativos que compilar en cada equipo.

---

## 11. Checklist de "errores típicos" del enunciado

| # | Error típico | Dónde se evita |
|---|---|---|
| 1 | No normalizar diagonales | `tick()` usa `Math.hypot` |
| 2 | Mover al jugador en `ws.on('message')` | El handler solo asigna `p.intent` |
| 3 | No usar `dt` | `dt = (now - lastTick) / 1000` |
| 4 | Broadcast en cada intent | Un `broadcast` al final de `tick()` |
| 5 | Confiar en el cliente | `Math.sign`, `typeof`, `extras` ≤ 1024, `maxPayload` 4 KB |
| 6 | Decodear el ID token sin verificar | `verifyIdToken` (firma con claves de Google) |
| 7 | No setear el `audience` | `audience: GOOGLE_CLIENT_ID` |
| 8 | Usar el email como llave | `google_sub = payload.sub` |
| 9 | Secrets distintas en auth y coordinator | Misma `JWT_SECRET` en ambos `.env` (paso 0) |
| 10 | Subir el `.env` | `.env` en `.gitignore` |
| 11 | Comillas dobles en literales SQL | `'local'`, `'google'` con comillas simples |

---

## 12. Tests automáticos

```bash
cd auth-service && npm test     # 26 tests: esquema, /register, /login, /auth/google, migración
cd coordinator  && npm test     # 25 tests: geometría del mapa + coordinador real jugando por WebSocket
```

- **Auth**: los ID tokens de prueba (`fake:<json>`) se resuelven con un stub de `verifyIdToken` (no hace falta una cuenta de Google); cualquier otro token pasa por la verificación **real** de `google-auth-library` y debe ser rechazado (token falsificado con firma propia → `401`).
- **Coordinador**: `welcome`, 20 Hz, velocidad con `{x: 9999}`, diagonales, spam de intents, clamp a los bordes, mensajes inválidos (`null`, arrays, strings), replicación de extras, mensaje > 4 KB, `players_update`, `4002` conservando posición, `4001` por token vencido, `SESSION_MAX_AGE` en caliente, cambio de `JWT_EXPIRES_IN` en el auth (vía `/token-policy`) que cierra una sesión abierta al cumplirse la nueva duración contada desde el cambio (no al instante), pasajero (se recoge, suma 1 y reaparece), ciudad (12 manzanas con casas, conjuntos, edificios y parques; el auto no atraviesa ninguna en 8 direcciones; el pasajero nunca cae dentro de una), `vehicle` leído del JWT (sin `vehicle` = taxi; `extras` no lo cambia), color por bando (el taxi no puede cambiarlo, el Uber no puede usar amarillo) y marcador por equipo.
- **Mapa** (`test/map.test.js`): colisión círculo-polígono y círculo-círculo, salida por el lado más cercano, polígono cóncavo (L).

---

## 13. Guion de la sustentación

Usar **dos navegadores distintos** (o una ventana normal y otra de incógnito): `localStorage` se comparte entre pestañas del mismo navegador, así que dos usuarios en dos pestañas del mismo perfil se pisarían el token.

1. **Demo del juego (3 min)**: alice en una ventana y bob_google en la otra. Moverse con WASD/flechas en una y mostrar que la otra lo ve en vivo. Cambiar color y mood en "Tu auto" y mostrar que la otra ventana lo ve.
2. **Demo de los dos providers (3 min)**:
   - Registrar `alice` con contraseña → entrar.
   - En la otra ventana, "Acceder con Google" → aparece "Elige tu username" → `bob_google` → entra. Se ven entre sí (badge 🔑 vs `G`).
   - **alice no puede entrar por /auth/google**: con Google, en el paso de elegir username escribir `alice` → "Ese username ya está en uso" (`409 username_taken`). La cuenta local de alice no es accesible desde Google.
   - **Un usuario de Google no puede usar /login**: en el formulario de login poner `bob_google` y cualquier contraseña → "Esta cuenta se creó con Google…" (`401 use_google_login`).
3. **Demo de autoridad (2 min)**: en la ventana de alice abrir DevTools → Console:
   ```js
   // Teletransporte local: reescribe lastState continuamente
   const trampa = setInterval(() => {
     const yo = lastState.players.find(p => p.username === 'alice');
     yo.x = 700; yo.y = 500;
   }, 5);
   ```
   En la ventana de alice el auto "aparece" en (700, 500); en la de bob sigue en su posición real. Luego `clearInterval(trampa)` → en el siguiente tick el servidor la devuelve a su lugar. Variante: `lastState.players[0].x = 0` sin intervalo → se ve un parpadeo de un tick (50 ms) y vuelve.
4. **Tour del código (4 min)**:
   - Game loop: `coordinator/index.js` → `tick()` y `scheduleTick()`.
   - Validación de inputs: `coordinator/index.js` → `ws.on('message')` (intent, extras_update) y `maxPayload`.
   - Verificación del ID token de Google: `auth-service/index.js` → `app.post('/auth/google')` → `verifyIdToken`.
   - Dónde se guardan los extras: `coordinator/index.js` → `p.extras = msg.extras`, y se publican en `snapshot()`.
5. **Preguntas (3 min)**.

**Extras de la Parte I** (por si los piden): token inválido (editar `token` en Local Storage → en ~1 s, sin recargar, `4001`), token vencido (`JWT_EXPIRES_IN=30s` en el `.env`, sin reiniciar el auth, volver a iniciar sesión → a los 30 s `4001 "token expired"`), cerrar una sesión ya abierta (`JWT_EXPIRES_IN=10s` en `auth-service/.env` → unos 10 s después `4001 "token expired"`, o `SESSION_MAX_AGE=10s` en `coordinator/.env` → unos 10 s después `4001 "session expired"`), misma cuenta en otra pestaña → `4002`.
