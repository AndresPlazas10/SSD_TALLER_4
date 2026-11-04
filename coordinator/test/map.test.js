// Tests de la geometría del mapa (sin levantar el coordinador)
const { test } = require('node:test');
const assert = require('node:assert');
const { pushOut, resolve, collides } = require('../map');

const square = { kind: 'poly', points: [[0, 0], [100, 0], [100, 100], [0, 100]] };
const L = { kind: 'poly', points: [[0, 0], [100, 0], [100, 45], [45, 45], [45, 100], [0, 100]] };
const park = { kind: 'circle', x: 0, y: 0, r: 50 };

test('círculo lejos de un polígono o de un círculo: no colisiona', () => {
  assert.strictEqual(pushOut(square, 150, 50, 20), null);
  assert.strictEqual(pushOut(park, 80, 0, 20), null);
});

test('círculo que penetra un lado: se lo empuja justo hasta tocarlo', () => {
  const [x, y] = resolve(110, 50, 20, [square]);
  assert.ok(Math.abs(x - 120) < 1e-9 && Math.abs(y - 50) < 1e-9);
});

test('centro dentro del polígono: sale por el lado más cercano', () => {
  const [x, y] = resolve(95, 50, 20, [square]);
  assert.ok(Math.abs(x - 120) < 1e-9 && Math.abs(y - 50) < 1e-9);
});

test('polígono cóncavo (L): el hueco de la L es libre, el cuerpo no', () => {
  assert.ok(!collides(80, 80, 10, [L]));
  assert.ok(collides(20, 80, 10, [L]));
  const [x, y] = resolve(80, 50, 10, [L]); // pegado al borde interior
  assert.ok(!collides(x, y, 10 - 1e-6, [L]));
});

test('círculo contra parque circular: queda a r1 + r2', () => {
  const [x, y] = resolve(60, 0, 20, [park]);
  assert.ok(Math.abs(Math.hypot(x, y) - 70) < 1e-9);
});
