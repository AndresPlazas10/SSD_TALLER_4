// Cliente de los auth-service replicados (Taller 7). Lo usan login.html y lobby.html.
//
// - AUTH_URLS (de /config.js) es la lista de auth. Se habla con uno (el
//   preferido, recordado en la pestaña); si no responde se prueba el siguiente.
// - Si una réplica contesta 503 { error: 'not_leader', leaderUrl } (escritura),
//   se reintenta en el líder y pasa a ser el preferido.
// - Si contestan 503 { error: 'no_leader' } (elección en curso, ~6-10 s), se
//   reintenta solo durante waitLeaderMs antes de rendirse.
// - Cada respuesta trae X-Auth-Id / X-Auth-Role: la página muestra a qué auth
//   está hablando (AuthClient.onChange).
(function () {
  const cfg = window.APP_CONFIG || {};
  const clean = (u) => String(u || '').trim().replace(/\/+$/, '');
  const urls = [...new Set((Array.isArray(cfg.AUTH_URLS) && cfg.AUTH_URLS.length ? cfg.AUTH_URLS : [cfg.AUTH_URL])
    .map(clean).filter(Boolean))];
  const KEY = 'authPreferred';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let preferred = null;
  try { preferred = sessionStorage.getItem(KEY); } catch (_) {}
  if (!urls.includes(preferred)) preferred = urls[0] || null;

  let info = { url: preferred, authId: null, role: null, state: 'idle' };
  const listeners = [];
  function update(patch) {
    info = { ...info, ...patch };
    for (const fn of listeners) { try { fn(info); } catch (_) {} }
  }
  function prefer(url) {
    if (!url || url === preferred) return;
    if (!urls.includes(url)) urls.push(url);
    preferred = url;
    try { sessionStorage.setItem(KEY, url); } catch (_) {}
  }

  // Un intento contra cada auth (preferido primero). Devuelve
  // { done: true, res, data, url } o { done: false, noLeader, last }.
  async function roundTrip(path, opts) {
    const queue = [preferred, ...urls.filter((u) => u !== preferred)];
    const tried = new Set();
    let last = null;
    let noLeader = false;
    while (queue.length) {
      const url = queue.shift();
      if (tried.has(url)) continue;
      tried.add(url);
      let res;
      let data = null;
      try {
        res = await fetch(`${url}${path}`, {
          ...opts,
          // ngrok free muestra una página intermedia a peticiones de navegador; este header la omite
          headers: { 'ngrok-skip-browser-warning': 'true', ...(opts.headers || {}) },
          signal: AbortSignal.timeout(opts.timeoutMs || 6000),
        });
        try { data = await res.json(); } catch (_) {}
      } catch (err) {
        console.log(`[auth] ${url} no responde (${err.name === 'TimeoutError' ? 'timeout' : err.message})`);
        continue;
      }
      const authId = res.headers.get('X-Auth-Id');
      const role = res.headers.get('X-Auth-Role');
      last = { res, data: data || {}, url, authId, role };
      // Sin JSON: no es el auth (p. ej. la página de "túnel offline" de ngrok)
      if (data === null) continue;
      if (res.status === 503 && data.error === 'not_leader') {
        console.log(`[auth] ${authId || url} es réplica: la escritura va al líder ${data.leaderUrl || '(desconocido)'}`);
        if (data.leaderUrl) queue.unshift(clean(data.leaderUrl));
        continue;
      }
      if (res.status === 503 && data.error === 'no_leader') { noLeader = true; continue; }
      if (url !== preferred) console.log(`[auth] ahora se usa ${authId || url}`);
      prefer(url);
      update({ url, authId, role, state: 'ok' });
      return { done: true, res, data: data || {}, url };
    }
    return { done: false, noLeader, last };
  }

  async function request(path, opts = {}) {
    const deadline = Date.now() + (opts.waitLeaderMs ?? 15000);
    for (;;) {
      const r = await roundTrip(path, opts);
      if (r.done) return { status: r.res.status, data: r.data, url: r.url };
      // Elección en curso (o todos caídos un instante): esperar y reintentar
      if (Date.now() < deadline) {
        update({ state: r.noLeader ? 'electing' : 'down' });
        await sleep(1500);
        continue;
      }
      update({ state: 'down' });
      if (r.last) return { status: r.last.res.status, data: r.last.data, url: r.last.url };
      throw new Error('ningún auth responde');
    }
  }

  window.AuthClient = {
    request,
    urls: () => [...urls],
    current: () => info,
    onChange(fn) { listeners.push(fn); fn(info); },
    // Texto corto para el indicador de la página
    label(i = info) {
      if (i.state === 'electing') return '🔐 Auth: eligiendo líder…';
      if (i.state === 'down') return '🔐 Auth: sin respuesta, reintentando…';
      if (!i.authId) return `🔐 Auth: ${i.url ? new URL(i.url).host : '—'}`;
      return `🔐 Auth: ${i.authId} (${i.role === 'leader' ? 'líder' : i.role === 'replica' ? 'réplica' : i.role})`;
    },
  };
})();
