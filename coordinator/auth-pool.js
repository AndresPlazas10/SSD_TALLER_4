// Varios auth-service replicados (Taller 7): AUTH_URLS="http://a:4000,http://b:4001,..."
//
// - Se habla con uno a la vez (el preferido). Si no responde (caído, red) o
//   contesta 503 sin líder, se prueba el siguiente de la lista.
// - Las respuestas traen leaderUrl (heartbeat 200 de una réplica o 503
//   not_leader): el preferido pasa a ser el líder, así los heartbeats van al
//   líder como pide el enunciado.

function parseAuthUrls(raw) {
  return [...new Set((raw || '').split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean))];
}

function createAuthPool(urls, { timeoutMs = 4500, label = 'auth' } = {}) {
  const list = [...urls];
  let preferred = list[0] || null;

  function follow(leaderUrl) {
    if (typeof leaderUrl !== 'string' || !/^https?:\/\//.test(leaderUrl)) return;
    const url = leaderUrl.replace(/\/+$/, '');
    if (url === preferred) return;
    if (!list.includes(url)) list.push(url);
    console.log(`[${label}] líder de los auth: ${url}`);
    preferred = url;
  }

  // Orden de prueba: el preferido y después el resto
  const order = () => [preferred, ...list.filter((u) => u !== preferred)];

  // fetch con failover. Devuelve { res, body, url } de la primera respuesta
  // útil; lanza si ninguno respondió.
  async function request(path, opts = {}) {
    const errors = [];
    const tried = new Set();
    const queue = order();
    while (queue.length) {
      const url = queue.shift();
      if (tried.has(url)) continue;
      tried.add(url);
      let res;
      let body = null;
      try {
        res = await fetch(`${url}${path}`, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
        try { body = await res.json(); } catch (_) {}
      } catch (err) {
        errors.push(`${url}: ${err.cause ? err.cause.code || err.message : err.message}`);
        continue;
      }
      // El auth siempre contesta JSON: otra cosa es un intermediario (p. ej. la
      // página de "túnel offline" de ngrok), o sea, ese auth no está
      if (body === null) {
        errors.push(`${url}: HTTP ${res.status} sin JSON`);
        continue;
      }
      if (res.status === 503 && (body.error === 'not_leader' || body.error === 'no_leader')) {
        errors.push(`${url}: ${body.error}`);
        if (body.leaderUrl) { follow(body.leaderUrl); queue.unshift(preferred); }
        continue;
      }
      if (body.leaderUrl) follow(body.leaderUrl);
      else if (url !== preferred) { console.log(`[${label}] ${preferred} no responde: se usa ${url}`); preferred = url; }
      return { res, body, url };
    }
    throw new Error(errors.join('; ') || 'sin AUTH_URLS');
  }

  return { request, current: () => preferred, urls: () => [...list] };
}

module.exports = { parseAuthUrls, createAuthPool };
