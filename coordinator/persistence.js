// Persistencia del estado del juego (examen final, track 2.1).
//
// Cada coordinador guarda cada PERSIST_MS (2 s) en SU PROPIA SQLite:
// - players: la última copia que conoce de cada jugador (los suyos y los de
//   los demás coordinadores, que le llegan por el mesh), con su versión;
// - tombstones: jugadores que cerraron sesión (deleted = 1), para que una
//   copia vieja no los "resucite";
// - world: la partida (ronda, fase, tiempo restante), el pasajero y el chat.
//
// Versión de cada jugador = reloj lógico híbrido (HLC simplificado):
//   ver = max(Date.now() del dueño, verAnterior + 1)
// Solo el coordinador dueño del jugador la sube (cuando publica su posición).
// Así, entre dos copias del mismo jugador gana la de versión mayor, que es a
// la vez la más reciente (por reloj) y la última en la cadena de dueños (por
// el +1, aunque los relojes estén un poco corridos). Ver el README.

const { DatabaseSync } = require('node:sqlite');

function createStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS players (
      user_id  TEXT PRIMARY KEY,
      ver      INTEGER NOT NULL,
      deleted  INTEGER NOT NULL DEFAULT 0,
      data     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS world (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const q = {
    upsert: db.prepare(`INSERT INTO players (user_id, ver, deleted, data) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET ver = excluded.ver, deleted = excluded.deleted, data = excluded.data
      WHERE excluded.ver >= players.ver`),
    all: db.prepare('SELECT user_id, ver, deleted, data FROM players'),
    prune: db.prepare('DELETE FROM players WHERE ver < ?'),
    setWorld: db.prepare('INSERT INTO world (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    getWorld: db.prepare('SELECT value FROM world WHERE key = ?'),
  };

  // Una sola transacción por guardado: o queda todo o nada (si el proceso
  // muere a mitad, la BD conserva el guardado anterior completo)
  function save({ players, world, minVer }) {
    db.exec('BEGIN');
    try {
      for (const p of players) q.upsert.run(p.userId, p.ver, p.deleted ? 1 : 0, JSON.stringify(p));
      for (const [key, value] of Object.entries(world)) q.setWorld.run(key, JSON.stringify(value));
      if (minVer) q.prune.run(minVer);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function loadPlayers() {
    return q.all.all().map((r) => ({ ...JSON.parse(r.data), userId: r.user_id, ver: r.ver, deleted: r.deleted === 1 }));
  }

  function loadWorld(key) {
    const row = q.getWorld.get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch (_) { return null; }
  }

  return { save, loadPlayers, loadWorld, close: () => db.close() };
}

module.exports = { createStore };
