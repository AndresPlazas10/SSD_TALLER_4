// Chat distribuido (examen final, track 2.6).
//
// Orden: TOTAL, con un secuenciador. Cada mensaje lo recibe el coordinador del
// que lo escribe, que lo manda al LÍDER del mesh (chat_submit); el líder le da
// el siguiente número (seq) y lo reparte a todos (chat_ordered). Cada
// coordinador entrega a sus clientes en orden de seq, nunca en orden de
// llegada. Si Alice (coord-a) escribe "hola" y Bob (coord-b) "qué tal" a los
// pocos ms, Charlie (coord-c) los ve en el orden en que llegaron al líder,
// el mismo orden que ven Alice y Bob. No se usan los relojes de los equipos.
//
// Si el líder se cae con mensajes sin numerar, el coordinador de origen los
// reenvía al líder nuevo (cada mensaje tiene un id único: los repetidos se
// descartan). Un hueco en la numeración (el líder murió a mitad de un envío)
// se espera CHAT_GAP_MS y después se salta, para no trabar el chat.

const MAX_CHARS = 200;
// Caracteres de control (C0, DEL, C1) y de formato invisibles/bidi que sirven
// para disfrazar texto
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;

// Valida y limpia el texto. Devuelve { text } o { error }.
function sanitizeChatText(raw) {
  if (typeof raw !== 'string') return { error: 'invalid' };
  if (raw.length > MAX_CHARS * 4) return { error: 'too_long' };
  const text = raw.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return { error: 'empty' };
  if ([...text].length > MAX_CHARS) return { error: 'too_long' };
  return { text };
}

// Rate limit por usuario: cubeta de fichas (ráfaga de `burst`, después una
// ficha cada `refillMs`). Quien insiste con la cubeta vacía queda silenciado
// un rato: un script que manda 1000 mensajes/s no ensucia el chat de nadie.
function createRateLimiter({ burst = 5, refillMs = 1500, abuseLimit = 8, muteMs = 30000 } = {}) {
  const buckets = new Map(); // userId -> { tokens, at, rejected: [ts], mutedUntil }
  return function check(userId, now = Date.now()) {
    let b = buckets.get(userId);
    if (!b) { b = { tokens: burst, at: now, rejected: [], mutedUntil: 0 }; buckets.set(userId, b); }
    if (now < b.mutedUntil) return { ok: false, reason: 'muted', retryInMs: b.mutedUntil - now };
    b.tokens = Math.min(burst, b.tokens + (now - b.at) / refillMs);
    b.at = now;
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true }; }
    b.rejected = b.rejected.filter((t) => now - t < 10000);
    b.rejected.push(now);
    if (b.rejected.length >= abuseLimit) {
      b.mutedUntil = now + muteMs;
      b.rejected = [];
      return { ok: false, reason: 'muted', retryInMs: muteMs, justMuted: true };
    }
    return { ok: false, reason: 'rate_limited', retryInMs: Math.ceil((1 - b.tokens) * refillMs) };
  };
}

function createChat({ selfId, historySize = 50, gapMs = 1500, resubmitMs = 1500, isLeader, sendToLeader, sendToPeers, deliver }) {
  let counter = 0;      // para los id de los mensajes de este coordinador
  let seqCounter = 0;   // último seq asignado o visto (el líder nuevo sigue desde aquí)
  let lastDelivered = 0;
  const history = [];   // últimos historySize, en orden de seq
  const seenIds = new Set();
  const buffer = new Map(); // seq -> mensaje que llegó antes que alguno anterior
  const pending = new Map(); // id -> { msg, sentAt } mensajes propios aún sin numerar
  let gapSince = 0;

  function remember(msg) {
    history.push(msg);
    if (history.length > historySize) history.splice(0, history.length - historySize);
    seenIds.add(msg.id);
    if (seenIds.size > historySize * 20) {
      // Se conservan solo los ids recientes (los viejos ya no pueden repetirse)
      const keep = new Set(history.map((m) => m.id));
      for (const [, p] of pending) keep.add(p.msg.id);
      seenIds.clear();
      for (const id of keep) seenIds.add(id);
    }
  }

  function flush() {
    for (;;) {
      const next = buffer.get(lastDelivered + 1);
      if (!next) break;
      buffer.delete(lastDelivered + 1);
      lastDelivered += 1;
      if (seenIds.has(next.id)) continue; // ya entregado con otro seq (reenvío tras caída del líder)
      remember(next);
      pending.delete(next.id);
      deliver(next);
    }
    gapSince = buffer.size ? (gapSince || Date.now()) : 0;
  }

  // Mensaje ya numerado (del líder, o propio si este es el líder)
  function onOrdered(msg) {
    if (!msg || !Number.isInteger(msg.seq) || msg.seq < 1 || typeof msg.id !== 'string') return;
    seqCounter = Math.max(seqCounter, msg.seq);
    if (msg.seq <= lastDelivered) {
      // Numerado de nuevo por un líder nuevo y ya entregado: nada que hacer
      pending.delete(msg.id);
      return;
    }
    buffer.set(msg.seq, msg);
    flush();
  }

  // El líder numera
  function sequence(msg) {
    if (seenIds.has(msg.id) || [...buffer.values()].some((m) => m.id === msg.id)) return;
    seqCounter = Math.max(seqCounter, lastDelivered) + 1;
    const ordered = { ...msg, seq: seqCounter, orderedBy: selfId };
    sendToPeers({ type: 'chat_ordered', msg: ordered });
    onOrdered(ordered);
  }

  // Un cliente de este coordinador escribió algo (ya validado y con rate limit)
  function submit({ userId, username, vehicle, text }) {
    const msg = { id: `${selfId}:${Date.now().toString(36)}:${++counter}`, userId, username, vehicle, text, origin: selfId, sentAt: Date.now() };
    pending.set(msg.id, { msg, sentAt: Date.now() });
    if (isLeader()) sequence(msg);
    else sendToLeader({ type: 'chat_submit', msg });
    return msg;
  }

  // chat_submit de otro coordinador (solo lo atiende el líder)
  function onSubmit(msg, fromPeer) {
    if (!isLeader() || !msg || typeof msg.id !== 'string' || msg.origin !== fromPeer) return;
    const clean = sanitizeChatText(msg.text);
    if (clean.error) return;
    sequence({ id: msg.id, userId: String(msg.userId), username: String(msg.username).slice(0, 32),
      vehicle: msg.vehicle === 'uber' ? 'uber' : 'taxi', text: clean.text, origin: fromPeer, sentAt: Number(msg.sentAt) || Date.now() });
  }

  // Cada segundo: reenviar lo propio que el líder no numeró (se cayó, cambió)
  // y saltar huecos que no se llenan
  function maintain(now = Date.now()) {
    for (const p of pending.values()) {
      if (now - p.sentAt < resubmitMs) continue;
      p.sentAt = now;
      if (isLeader()) sequence(p.msg);
      else sendToLeader({ type: 'chat_submit', msg: p.msg });
    }
    if (gapSince && now - gapSince > gapMs && buffer.size) {
      const min = Math.min(...buffer.keys());
      lastDelivered = min - 1; // se da por perdido lo que falta antes de min
      flush();
    }
  }

  // Historial que trae un par (snapshot) o el disco: se adopta lo que no se tenía
  function merge(list, lastSeq) {
    if (!Array.isArray(list)) return;
    const byId = new Map(history.map((m) => [m.id, m]));
    for (const m of list) {
      if (m && typeof m.id === 'string' && Number.isInteger(m.seq) && typeof m.text === 'string' && !byId.has(m.id)) byId.set(m.id, m);
    }
    const merged = [...byId.values()].sort((a, b) => a.seq - b.seq).slice(-historySize);
    history.splice(0, history.length, ...merged);
    for (const m of merged) seenIds.add(m.id);
    const top = Math.max(lastSeq || 0, ...merged.map((m) => m.seq), 0);
    seqCounter = Math.max(seqCounter, top);
    if (top > lastDelivered && !buffer.size) lastDelivered = top;
  }

  return {
    submit, onOrdered, onSubmit, maintain, merge,
    history: () => history.slice(),
    lastSeq: () => Math.max(seqCounter, lastDelivered),
    pendingCount: () => pending.size,
  };
}

module.exports = { createChat, createRateLimiter, sanitizeChatText, MAX_CHARS };
