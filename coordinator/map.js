// Mapa de la ciudad: calles en cuadrícula y manzanas con casas, edificios y
// parques. Lo genera el coordinador (es la fuente de verdad de las colisiones)
// y lo manda al cliente en 'welcome' para dibujarlo.
//
// - obstacles: lo que choca. Cada manzana (con su andén) es un rectángulo
//   sólido: los autos van por la calle, no por el andén ni entre las casas.
//   Formato { kind: 'poly', points: [[x, y], ...] } o { kind: 'circle', x, y, r };
//   la colisión soporta ambos (y polígonos cóncavos), aunque la ciudad solo
//   use rectángulos.
// - blocks: solo decoración (qué hay dentro de cada manzana).

const CELL = 200;     // tamaño de cada manzana + la mitad de las calles que la rodean
const SIDEWALK = 8;   // ancho del andén dentro de la manzana
const GAP = 3;        // separación entre casas vecinas

// Barrios: qué tan probable es cada tipo de manzana según la distancia al
// centro de la ciudad (0 = centro, 1 = esquinas). El centro es de edificios
// altos (skyline) y las afueras, de casas. Los parques aparecen en todos.
const DISTRICTS = [
  { upTo: 0.3, weights: { edificio: 0.68, conjunto: 0.17, parque: 0.1, casas: 0.05 }, floors: [8, 14] },
  { upTo: 0.62, weights: { edificio: 0.25, casas: 0.35, conjunto: 0.25, parque: 0.15 }, floors: [4, 8] },
  { upTo: Infinity, weights: { casas: 0.5, conjunto: 0.3, parque: 0.15, edificio: 0.05 }, floors: [3, 5] },
];

function pickWeighted(weights, r) {
  let acc = 0;
  for (const [type, w] of Object.entries(weights)) {
    acc += w;
    if (r < acc) return type;
  }
  return Object.keys(weights)[0];
}

// Generador pseudoaleatorio con semilla (mulberry32): el mismo mundo da
// siempre la misma ciudad, en todas las máquinas y tras reiniciar.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reparte `total` px en `count` anchos parecidos pero no iguales
function splitWidths(total, count, rand) {
  const free = total - GAP * (count - 1);
  const weights = Array.from({ length: count }, () => 0.8 + rand() * 0.4);
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => Math.floor((w / sum) * free));
  widths[count - 1] += free - widths.reduce((a, b) => a + b, 0);
  return widths;
}

// Fila de casas pegadas a la calle (techo a dos aguas, cumbrera paralela a la calle)
function houseRow(x, y, w, h, count, ridge, rand) {
  const houses = [];
  let cx = x;
  for (const hw of splitWidths(w, count, rand)) {
    houses.push({ x: cx, y, w: hw, h, ridge, roof: Math.floor(rand() * 5), chimney: rand() < 0.4 });
    cx += hw + GAP;
  }
  return houses;
}

// Contenido de una manzana. (x, y, s) es el lote dentro del andén.
function blockContents(type, x, y, s, rand, floors) {
  if (type === 'casas') {
    // Dos filas de casas, una mirando a cada calle, con patios en el medio
    const h = Math.round(s * 0.42);
    return {
      houses: [
        ...houseRow(x, y, s, h, 3, 'h', rand),
        ...houseRow(x, y + s - h, s, h, 2 + Math.floor(rand() * 2), 'h', rand),
      ],
    };
  }
  if (type === 'conjunto') {
    // Cuatro casas en las esquinas, cumbreras alternadas
    const hs = (s - GAP) / 2;
    const houses = [];
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      houses.push({
        x: x + dx * (hs + GAP), y: y + dy * (hs + GAP), w: hs, h: hs,
        ridge: (dx + dy) % 2 ? 'v' : 'h', roof: Math.floor(rand() * 5), chimney: rand() < 0.5,
      });
    }
    return { houses };
  }
  if (type === 'edificio') {
    // floors: pisos (el cliente lo usa para la altura); units: equipos en la azotea
    const [minF, maxF] = floors;
    return { building: { x: x + 4, y: y + 4, w: s - 8, h: s - 8, units: 2 + Math.floor(rand() * 3),
      floors: minF + Math.floor(rand() * (maxF - minF + 1)) } };
  }
  // parque: árboles en posiciones con semilla alrededor de una fuente central
  const trees = [];
  for (let k = 0; k < 9; k++) {
    const a = rand() * Math.PI * 2;
    const d = s * (0.22 + rand() * 0.22);
    trees.push({ x: x + s / 2 + Math.cos(a) * d, y: y + s / 2 + Math.sin(a) * d, r: 6 + rand() * 4 });
  }
  return { trees };
}

// Cada manzana deja una franja libre de `margin` por lado: entre dos manzanas
// queda una calle de 2*margin y contra el borde del mundo una de `margin`.
// margin >= 2*radio + 5 garantiza que el auto quepa también en las calles del borde.
function buildCity(width, height, playerRadius) {
  const margin = 2 * playerRadius + 5;
  const size = CELL - 2 * margin;
  const city = { cell: CELL, margin, sidewalk: SIDEWALK, obstacles: [], blocks: [] };
  if (size < 40) return city;

  const cols = Math.floor(width / CELL);
  const rows = Math.floor(height / CELL);
  const cx = (cols * CELL) / 2, cy = (rows * CELL) / 2;
  const maxDist = Math.hypot(cx, cy) || 1;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      // Tipo según el barrio (distancia al centro) y un sorteo con semilla
      const d = Math.hypot(i * CELL + CELL / 2 - cx, j * CELL + CELL / 2 - cy) / maxDist;
      const district = DISTRICTS.find((z) => d <= z.upTo);
      const type = pickWeighted(district.weights, seeded(5000 + j * 97 + i)());
      const x0 = i * CELL + margin;
      const y0 = j * CELL + margin;
      city.obstacles.push({
        kind: 'poly',
        name: type,
        points: [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size]],
      });
      const rand = seeded(1000 + j * cols + i);
      const lot = size - 2 * SIDEWALK;
      city.blocks.push({
        type, x: x0, y: y0, size,
        ...blockContents(type, x0 + SIDEWALK, y0 + SIDEWALK, lot, rand, district.floors),
      });
    }
  }
  return city;
}

function closestOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return [ax + t * dx, ay + t * dy];
}

// Ray casting: sirve para polígonos cóncavos
function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Vector mínimo para sacar el círculo (x, y, r) del obstáculo, o null si no lo toca.
function pushOut(o, x, y, r) {
  if (o.kind === 'circle') {
    let dx = x - o.x, dy = y - o.y;
    let d = Math.hypot(dx, dy);
    const min = r + o.r;
    if (d >= min) return null;
    if (d === 0) { dx = 1; dy = 0; d = 1; }
    return [(dx / d) * (min - d), (dy / d) * (min - d)];
  }

  // Punto del borde más cercano al centro del círculo
  let best = Infinity, cx = 0, cy = 0;
  const pts = o.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [qx, qy] = closestOnSegment(x, y, pts[j][0], pts[j][1], pts[i][0], pts[i][1]);
    const d2 = (x - qx) ** 2 + (y - qy) ** 2;
    if (d2 < best) { best = d2; cx = qx; cy = qy; }
  }
  const d = Math.sqrt(best);
  const inside = pointInPoly(x, y, pts);
  if (!inside && d >= r) return null;
  if (d < 1e-9) {
    // Justo sobre el borde: salir en dirección opuesta al centro del polígono
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const m = Math.hypot(x - mx, y - my) || 1;
    return [((x - mx) / m) * r, ((y - my) / m) * r];
  }
  const nx = (x - cx) / d, ny = (y - cy) / d;
  // Fuera: alejarse hasta r. Dentro: cruzar el borde más cercano y quedar a r de él.
  return inside ? [-nx * (d + r), -ny * (d + r)] : [nx * (r - d), ny * (r - d)];
}

// Empuja el círculo fuera de todos los obstáculos. Empujar solo la parte
// penetrada hace que el auto se deslice por la pared en vez de frenar en seco.
function resolve(x, y, r, obstacles) {
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;
    for (const o of obstacles) {
      const v = pushOut(o, x, y, r);
      if (v) { x += v[0]; y += v[1]; moved = true; }
    }
    if (!moved) break;
  }
  return [x, y];
}

function collides(x, y, r, obstacles) {
  return obstacles.some((o) => pushOut(o, x, y, r) !== null);
}

module.exports = { buildCity, pushOut, resolve, collides };
