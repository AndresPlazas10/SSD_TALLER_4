# SSD Taller 4 — Proyecto Final Parte I: Identidad

Primera pieza del videojuego web multijugador del curso de Sistemas Distribuidos: **registro, login con JWT y lobby en tiempo real por WebSocket**.

El sistema está formado por tres procesos independientes que se comunican por red:

| Componente | Carpeta | Puerto | Tecnología | Responsabilidad |
|---|---|---|---|---|
| Servicio de Autenticación | `auth-service/` | 4000 | Express + SQLite + bcrypt + JWT | Registrar usuarios, validar credenciales, emitir tokens |
| Coordinador de Sesiones | `coordinator/` | 5000 | Express + `ws` + JWT | Validar el token en el upgrade, mantener jugadores en línea, hacer broadcast |
| Cliente Web | `client/` | 3000 | HTML + JS plano (servido con Express) | Formularios de login/registro y lobby en vivo |

---

## 1. Arquitectura

```
                         ┌──────────────────────────────┐
                         │        Navegador (x N)       │
                         │  login.html / lobby.html     │
                         │  token JWT en localStorage   │
                         └───┬──────────┬───────────┬───┘
       GET login.html,       │          │           │  WebSocket
       lobby.html, config.js │          │ HTTP POST │  wss://.../connect?token=JWT
                             │          │ /register │
                             ▼          │ /login    ▼
              ┌──────────────────┐      │     ┌──────────────────────────────┐
              │  Cliente Web     │      │     │  Coordinador (puerto 5000)   │
              │  (puerto 3000)   │      │     │  - verifica JWT en 'upgrade' │
              │  sirve HTML/JS   │      │     │  - Map userId → {username,   │
              │  y /config.js    │      │     │      socket, connectedAt}    │
              └──────────────────┘      │     │  - broadcast players_update  │
                                        ▼     └──────────────▲───────────────┘
                         ┌──────────────────────────────┐    │
                         │   Auth Service (puerto 4000) │    │ misma JWT_SECRET
                         │  - bcrypt (≥10 rounds)       │    │ (vía .env)
                         │  - firma JWT (1h)            │────┘
                         │  - SQLite: users.db          │
                         └──────────────────────────────┘

   Con ngrok, cada servicio tiene su propio túnel HTTPS:
   cliente → https://<cliente>.ngrok-free.app
   auth    → https://<auth>.ngrok-free.app
   coord.  → wss://<coordinador>.ngrok-free.app/connect?token=...
```

### Flujo

1. El usuario se registra: el cliente hace `POST /register` al auth service, que hashea la contraseña con bcrypt y la guarda en SQLite.
2. El usuario hace login: `POST /login` devuelve un JWT `{ userId, username, iat, exp }`. El cliente lo guarda en `localStorage` y redirige al lobby.
3. El lobby abre `WebSocket` a `/connect?token=JWT`. El coordinador **verifica el JWT durante el `upgrade`** con la misma `JWT_SECRET`.
   - Token inválido, vencido o firmado con otra clave → se cierra el socket con código **4001 `"invalid token"`**.
   - Token válido → el jugador entra al `Map` y se envía `players_update` a **todos** los conectados.
4. Cuando un socket se cierra, el coordinador lo elimina del `Map` y vuelve a hacer broadcast.

Mensaje de broadcast:

```json
{ "type": "players_update", "players": [{ "userId": "1", "username": "alice" }] }
```

---

## 2. Estructura del repositorio

```
SSD_TALLER_4/
├── auth-service/
│   ├── index.js          # POST /register, POST /login, GET /health
│   ├── package.json
│   └── .env.example
├── coordinator/
│   ├── index.js          # WS /connect, GET /health
│   ├── package.json
│   └── .env.example
├── client/
│   ├── server.js         # Express mínimo que sirve public/ y /config.js
│   ├── package.json
│   ├── .env.example
│   └── public/
│       ├── login.html    # dos formularios: iniciar sesión y registrarse
│       ├── lobby.html    # usuario actual + jugadores en línea (WebSocket)
│       └── style.css
├── .gitignore            # node_modules/, *.db, .env
└── README.md
```

---

## 3. Cómo correr el proyecto

### Requisitos

- Node.js 18 o superior
- npm
- ngrok (solo para el despliegue público) con su authtoken configurado

### Paso 1 — Clonar

```bash
git clone https://github.com/AndresPlazas10/SSD_TALLER_4.git
cd SSD_TALLER_4
```

### Paso 2 — Auth service (puerto 4000)

```bash
cd auth-service
npm install
cp .env.example .env        # en Windows: copy .env.example .env
# editar .env y poner una JWT_SECRET larga y aleatoria
npm start
# → Auth service en puerto 4000
```

### Paso 3 — Coordinador (puerto 5000)

En otra terminal:

```bash
cd coordinator
npm install
cp .env.example .env
# poner EXACTAMENTE la misma JWT_SECRET que en auth-service/.env
npm start
# → Coordinador en puerto 5000
```

### Paso 4 — Cliente (puerto 3000)

En otra terminal:

```bash
cd client
npm install
cp .env.example .env
npm start
# → Cliente en puerto 3000
```

Abrir `http://localhost:3000`, registrarse, iniciar sesión y entrar al lobby. Abrir un segundo navegador (o ventana privada) con otro usuario para ver la lista actualizarse en vivo.

### Variables de entorno

Ningún secreto, puerto ni URL está hardcoded; todo viene de `.env` (cargado con `dotenv`). Cada servicio tiene su `.env.example` versionado.

| Servicio | Variable | Ejemplo | Descripción |
|---|---|---|---|
| auth-service | `PORT` | `4000` | Puerto HTTP |
| auth-service | `JWT_SECRET` | `...` | Secret para firmar los JWT |
| auth-service | `JWT_EXPIRES_IN` | `1h` / `30s` | Expiración del token |
| auth-service | `BCRYPT_ROUNDS` | `10` | Rondas de bcrypt (el servicio no arranca con menos de 10) |
| auth-service | `DB_FILE` | `users.db` | Archivo SQLite |
| coordinator | `PORT` | `5000` | Puerto HTTP + WS |
| coordinator | `JWT_SECRET` | `...` | **La misma** que auth-service |
| coordinator | `HEARTBEAT_MS` | `30000` | Intervalo de ping/pong |
| client | `PORT` | `3000` | Puerto del servidor estático |
| client | `AUTH_URL` / `COORDINATOR_WS` | `http://localhost:4000` / `ws://localhost:5000` | URLs locales |
| client | `PUBLIC_AUTH_URL` / `PUBLIC_COORDINATOR_WS` | `https://...ngrok-free.app` / `wss://...ngrok-free.app` | URLs de ngrok |

---

## 4. Ejemplos con curl

### Registro

```bash
curl -X POST http://localhost:4000/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'
```

| Caso | Código | Respuesta |
|---|---|---|
| Usuario creado | `201` | `{ "userId": 1, "username": "alice" }` |
| Usuario ya existe | `409` | `{ "error": "El usuario ya existe" }` |
| Body inválido / JSON mal formado | `400` | `{ "error": "..." }` |

### Login

```bash
curl -X POST http://localhost:4000/login \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'
```

| Caso | Código | Respuesta |
|---|---|---|
| Credenciales válidas | `200` | `{ "token": "eyJhbGc...", "username": "alice" }` |
| Credenciales inválidas | `401` | `{ "error": "Credenciales inválidas" }` |
| Body inválido | `400` | `{ "error": "username y password son requeridos" }` |

> En Windows PowerShell usar `curl.exe` y escapar las comillas del JSON, o probar desde Postman / Thunder Client.

### Probar el coordinador con wscat

```bash
npm install -g wscat
wscat -c "ws://localhost:5000/connect?token=PEGA_AQUI_EL_TOKEN"
# En otra terminal conectar otro usuario: ambos reciben players_update
wscat -c "ws://localhost:5000/connect?token=token_invalido"
# → Disconnected (code: 4001, reason: "invalid token")
```

---

## 5. Despliegue con ngrok

Cada servicio en su propio túnel, en tres terminales:

```bash
# Terminal 1 — auth
ngrok http 4000

# Terminal 2 — coordinador
ngrok http 5000

# Terminal 3 — cliente
ngrok http 3000
```

Después copiar las URLs que entrega ngrok en `client/.env` y reiniciar el cliente:

```env
PUBLIC_AUTH_URL=https://<url-auth>.ngrok-free.app
PUBLIC_COORDINATOR_WS=wss://<url-coordinador>.ngrok-free.app
```

- Como ngrok sirve por **HTTPS**, el WebSocket debe ser **`wss://`** (si no, el navegador lo bloquea por contenido mixto).
- El cliente sirve sus URLs desde `/config.js`: si se abre por `localhost` usa las URLs locales y si se abre por el túnel de ngrok usa las públicas, sin tocar el HTML.
- Las peticiones del cliente al auth incluyen el header `ngrok-skip-browser-warning` para saltar la página intermedia del plan gratuito de ngrok.
- El auth service usa `cors()` porque cliente y auth están en orígenes distintos.

---

## 6. Decisiones de diseño

### Mismo usuario en dos pestañas → se desconecta la sesión anterior

Si un usuario ya conectado abre una segunda conexión, el coordinador **cierra la conexión anterior con el código `4002 "session replaced"` y se queda con la nueva**.

Justificación:
- El `Map` está indexado por `userId`, así que solo puede haber un socket por jugador; en el juego final un jugador no puede tener dos posiciones a la vez.
- Rechazar la segunda conexión dejaría al usuario bloqueado si la primera quedó "colgada" (pestaña congelada, red caída sin `close`). Reemplazarla siempre permite recuperar la sesión.
- Es el comportamiento que espera el usuario: la pestaña que acaba de abrir es la que quiere usar.
- En el `close` del socket viejo solo se borra el jugador del `Map` si el `Map` todavía apunta a **ese** socket, para no eliminar la sesión nueva.
- El cliente, al recibir `4002`, muestra un aviso y vuelve al login **sin borrar el token**, porque `localStorage` es compartido y la otra pestaña lo sigue usando.

### El JWT se verifica en el `upgrade`, no en `connection`

Así un token inválido nunca llega a registrarse como jugador. Para que el navegador pueda leer el código **4001** se completa el handshake y se cierra de inmediato con `ws.close(4001, 'invalid token')`; si se respondiera con un `401` HTTP, el navegador solo vería un cierre genérico `1006`. Además se fija `algorithms: ['HS256']` y se exige que el payload tenga `userId` y `username`.

### La sesión WS no dura más que el token

Al aceptar la conexión se programa un temporizador hasta `exp`; al vencer, el coordinador cierra el socket con `4001 "token expired"` y el cliente vuelve al login. Con `JWT_EXPIRES_IN=30s` se reproduce el caso del token vencido en vivo.

### Heartbeat (ping/pong)

Cada `HEARTBEAT_MS` el coordinador envía `ping`; si un socket no respondió al anterior se termina. Así se detectan conexiones muertas que nunca disparan `close` (por ejemplo, el portátil se suspende) y el jugador no queda "en línea" para siempre.

### Seguridad del auth service

- Contraseñas con **bcrypt** (`BCRYPT_ROUNDS` ≥ 10; el servicio no arranca con menos). Se usa `bcryptjs` (implementación en JS puro, mismo formato de hash) para evitar compilar binarios nativos en Windows.
- La contraseña **nunca** se devuelve ni se escribe en los logs; los logs solo muestran el username.
- Login con mensaje genérico `"Credenciales inválidas"` y comparación contra un hash falso cuando el usuario no existe, para que no se pueda saber por tiempo de respuesta qué usuarios existen.
- Validación del body: `username` de 3–20 caracteres `[A-Za-z0-9_]`, `password` de 6–72 caracteres (bcrypt solo usa 72 bytes). JSON mal formado → `400`.
- Registro concurrente del mismo username: el `UNIQUE` de SQLite responde `409` en lugar de `500`.
- `better-sqlite3` con consultas preparadas (sin inyección SQL).

### Cliente

- HTML + JS plano, sin frameworks. Los datos de otros jugadores se pintan con `textContent` (nunca `innerHTML`) para evitar XSS con usernames.
- Dos páginas, siguiendo el esqueleto del enunciado: `login.html` (formularios de login y registro en la misma página) y `lobby.html`. `GET /` redirige a `login.html`.
- Login exitoso → token en `localStorage` → redirige a `lobby.html`.
- Botón **Cerrar sesión** → borra el token y cierra el WS.
- Si el WS se cierra inesperadamente (token inválido/vencido, coordinador caído) se muestra un `alert` con el motivo, se borra el token y se vuelve a `login.html`.
- El token se envía con `encodeURIComponent`: si se "ensucia" con caracteres como `#`, `new WebSocket()` fallaría en el navegador antes de llegar al coordinador y no se vería el rechazo `4001`.

---

## 7. Demostración (sustentación)

1. **Flujo completo**: registrar usuario, login, lobby. Dos navegadores distintos se ven entrar y salir en vivo.
2. **Token inválido**: en DevTools → Application → Local Storage, modificar `token`, recargar el lobby → el coordinador cierra con `4001` y el cliente vuelve al login.
3. **Token vencido**: poner `JWT_EXPIRES_IN=30s` en `auth-service/.env`, reiniciar el auth, iniciar sesión y esperar 30 s → el coordinador cierra con `4001 "token expired"` y el cliente vuelve al login.
