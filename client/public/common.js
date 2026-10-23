// Utilidades compartidas por las páginas del cliente.

// Banner de mensajes. textContent: nunca innerHTML con datos externos.
function show(text, kind) {
  const banner = document.getElementById('banner');
  if (!banner) return;
  banner.textContent = text;
  banner.className = 'msg ' + kind;
}

// Mensajes que una página deja a la siguiente (sesión terminada, usuario creado...)
function setFlash(text, kind = 'info') {
  try { sessionStorage.setItem('flash', JSON.stringify({ text, kind })); } catch (_) {}
}
(function showFlash() {
  try {
    const raw = sessionStorage.getItem('flash');
    if (!raw) return;
    sessionStorage.removeItem('flash');
    const { text, kind } = JSON.parse(raw);
    document.addEventListener('DOMContentLoaded', () => show(text, kind || 'info'));
  } catch (_) {}
})();

async function authPost(path, body) {
  const res = await fetch(`${window.APP_CONFIG.AUTH_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // ngrok free muestra una página intermedia a peticiones de navegador; este header la omite
      'ngrok-skip-browser-warning': 'true',
    },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}
