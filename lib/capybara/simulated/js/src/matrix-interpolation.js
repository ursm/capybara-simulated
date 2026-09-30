// Matrix interpolation (CSS Transforms 1 §"Interpolation of Matrices", CSS Transforms 2 §"Interpolation of 3D
// matrices"): what a transform list interpolates as where two of its functions share no primitive — `translateX(0px)`
// against `scale(3)` is `matrix(2, 0, 0, 2, 0, 0)` half way in Chrome and Firefox alike, not a discrete flip. Each
// side is DECOMPOSED — translation, scale, skew, rotation, perspective — those parts are mixed, and the result
// RECOMPOSED. Two 2D matrices take the 2D algorithm (a rotation angle, mixed the short way round); anything else the
// 3D one (a quaternion, mixed by spherical interpolation).
//
// A matrix is 16 numbers in `matrix3d()` order — column-major, `m[c * 4 + r]` — as `transform4x4` composes one.

const IDENTITY = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const at = (m, c, r) => m[c * 4 + r];
const lerp = (a, b, p) => a + (b - a) * p;

export function is2DMatrix(m) {
  return m[2] === 0 && m[3] === 0 && m[6] === 0 && m[7] === 0 && m[8] === 0 && m[9] === 0 &&
         m[10] === 1 && m[11] === 0 && m[14] === 0 && m[15] === 1;
}

function multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += at(a, k, r) * at(b, c, k);
      out[c * 4 + r] = s;
    }
  }
  return out;
}

// ── 2D ──
// Null for a singular matrix, which has no rotation to take apart (Gecko's `Decompose2DMatrix`, Blink's
// decomposition alike): the caller flips discretely.
function decompose2D(m) {
  let row0x = m[0], row0y = m[1], row1x = m[4], row1y = m[5];
  if (row0x * row1y === row0y * row1x) return null;
  const translate = [m[12], m[13]];
  let sx = Math.hypot(row0x, row0y), sy = Math.hypot(row1x, row1y);
  // A negative determinant is one axis flipped: the one with the smaller unit-vector dot product.
  if (row0x * row1y - row0y * row1x < 0) {
    if (row0x < row1y) sx = -sx; else sy = -sy;
  }
  if (sx) { row0x /= sx; row0y /= sx; }
  if (sy) { row1x /= sy; row1y /= sy; }
  const angle = Math.atan2(row0y, row0x);
  if (angle) {
    const sn = -row0y, cs = row0x;
    const m11 = row0x, m12 = row0y, m21 = row1x, m22 = row1y;
    row0x = cs * m11 + sn * m21; row0y = cs * m12 + sn * m22;
    row1x = -sn * m11 + cs * m21; row1y = -sn * m12 + cs * m22;
  }
  return { translate, scale: [sx, sy], angle: angle * 180 / Math.PI, matrix: [row0x, row0y, row1x, row1y] };
}
function blend2D(a, b, p) {
  a = { ...a, scale: a.scale.slice() };
  b = { ...b };
  // Two opposite flips are a rotation by half a turn.
  if ((a.scale[0] < 0 && b.scale[1] < 0) || (a.scale[1] < 0 && b.scale[0] < 0)) {
    a.scale[0] = -a.scale[0];
    a.scale[1] = -a.scale[1];
    a.angle += a.angle < 0 ? 180 : -180;
  }
  // …and not the long way round.
  if (!a.angle) a.angle = 360;
  if (!b.angle) b.angle = 360;
  if (Math.abs(a.angle - b.angle) > 180) {
    if (a.angle > b.angle) a.angle -= 360; else b.angle -= 360;
  }
  return {
    translate: [lerp(a.translate[0], b.translate[0], p), lerp(a.translate[1], b.translate[1], p)],
    scale: [lerp(a.scale[0], b.scale[0], p), lerp(a.scale[1], b.scale[1], p)],
    angle: lerp(a.angle, b.angle, p),
    matrix: a.matrix.map((v, i) => lerp(v, b.matrix[i], p))
  };
}
function recompose2D(d) {
  let m = IDENTITY();
  m[0] = d.matrix[0]; m[1] = d.matrix[1]; m[4] = d.matrix[2]; m[5] = d.matrix[3];
  m[12] = d.translate[0]; m[13] = d.translate[1];
  const rad = d.angle * Math.PI / 180, cs = Math.cos(rad), sn = Math.sin(rad);
  const rotate = IDENTITY();
  rotate[0] = cs; rotate[1] = sn; rotate[4] = -sn; rotate[5] = cs;
  m = multiply(m, rotate);
  const scale = IDENTITY();
  scale[0] = d.scale[0]; scale[5] = d.scale[1];
  return multiply(m, scale);
}

// ── 3D ──
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.sqrt(dot(a, a));
const scaled = (a, s) => a.map((v) => v * s);
const combine = (a, b, sa, sb) => [a[0] * sa + b[0] * sb, a[1] * sa + b[1] * sb, a[2] * sa + b[2] * sb];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function determinant(m) {
  const det3 = (a, b, c, d, e, f, g, h, i) => a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const minor = (r, c) => {
    const rows = [0, 1, 2, 3].filter((x) => x !== r), cols = [0, 1, 2, 3].filter((x) => x !== c);
    return det3(...rows.flatMap((rr) => cols.map((cc) => at(m, cc, rr))));
  };
  return at(m, 0, 0) * minor(0, 0) - at(m, 1, 0) * minor(0, 1) + at(m, 2, 0) * minor(0, 2) - at(m, 3, 0) * minor(0, 3);
}
function inverse(m) {
  const det = determinant(m);
  if (!det) return null;
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      // The adjugate, transposed: the cofactor of (c, r) lands at (r, c).
      const rows = [0, 1, 2, 3].filter((x) => x !== c), cols = [0, 1, 2, 3].filter((x) => x !== r);
      const sub = rows.flatMap((rr) => cols.map((cc) => at(m, cc, rr)));
      const d3 = sub[0] * (sub[4] * sub[8] - sub[5] * sub[7]) - sub[1] * (sub[3] * sub[8] - sub[5] * sub[6]) +
                 sub[2] * (sub[3] * sub[7] - sub[4] * sub[6]);
      out[c * 4 + r] = ((r + c) % 2 ? -d3 : d3) / det;
    }
  }
  return out;
}

function decompose3D(input) {
  if (at(input, 3, 3) === 0) return null;
  const m = input.map((v) => v / at(input, 3, 3));
  const persp = m.slice();
  persp[3] = persp[7] = persp[11] = 0;
  persp[15] = 1;
  if (!determinant(persp)) return null;
  let perspective = [0, 0, 0, 1];
  if (at(m, 0, 3) || at(m, 1, 3) || at(m, 2, 3)) {
    const rhs = [at(m, 0, 3), at(m, 1, 3), at(m, 2, 3), at(m, 3, 3)];
    const inv = inverse(persp);
    if (!inv) return null;
    // rhs times the TRANSPOSED inverse, i.e. the inverse applied to rhs as a row vector.
    perspective = [0, 1, 2, 3].map((r) => rhs[0] * at(inv, r, 0) + rhs[1] * at(inv, r, 1) + rhs[2] * at(inv, r, 2) + rhs[3] * at(inv, r, 3));
  }
  const translate = [at(m, 3, 0), at(m, 3, 1), at(m, 3, 2)];
  const row = [0, 1, 2].map((c) => [at(m, c, 0), at(m, c, 1), at(m, c, 2)]);
  const scale = [0, 0, 0], skew = [0, 0, 0];
  scale[0] = len(row[0]);
  row[0] = scaled(row[0], 1 / scale[0]);
  skew[0] = dot(row[0], row[1]);
  row[1] = combine(row[1], row[0], 1, -skew[0]);
  scale[1] = len(row[1]);
  row[1] = scaled(row[1], 1 / scale[1]);
  skew[0] /= scale[1];
  skew[1] = dot(row[0], row[2]);
  row[2] = combine(row[2], row[0], 1, -skew[1]);
  skew[2] = dot(row[1], row[2]);
  row[2] = combine(row[2], row[1], 1, -skew[2]);
  scale[2] = len(row[2]);
  row[2] = scaled(row[2], 1 / scale[2]);
  skew[1] /= scale[2];
  skew[2] /= scale[2];
  // A coordinate system flip is a negative scale on every axis.
  if (dot(row[0], cross(row[1], row[2])) < 0) {
    for (let i = 0; i < 3; i++) {
      scale[i] = -scale[i];
      row[i] = scaled(row[i], -1);
    }
  }
  const q = [
    0.5 * Math.sqrt(Math.max(1 + row[0][0] - row[1][1] - row[2][2], 0)),
    0.5 * Math.sqrt(Math.max(1 - row[0][0] + row[1][1] - row[2][2], 0)),
    0.5 * Math.sqrt(Math.max(1 - row[0][0] - row[1][1] + row[2][2], 0)),
    0.5 * Math.sqrt(Math.max(1 + row[0][0] + row[1][1] + row[2][2], 0))
  ];
  if (row[2][1] > row[1][2]) q[0] = -q[0];
  if (row[0][2] > row[2][0]) q[1] = -q[1];
  if (row[1][0] > row[0][1]) q[2] = -q[2];
  return { translate, scale, skew, perspective, quaternion: q };
}
export function slerp(qa, qb, p) {
  let product = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
  product = Math.min(Math.max(product, -1), 1);
  if (Math.abs(product) === 1) return qa.slice();
  const theta = Math.acos(product);
  const w = Math.sin(p * theta) / Math.sqrt(1 - product * product);
  const a = Math.cos(p * theta) - product * w;
  return qa.map((v, i) => v * a + qb[i] * w);
}
function recompose3D(d) {
  let m = IDENTITY();
  for (let i = 0; i < 4; i++) m[i * 4 + 3] = d.perspective[i];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) m[3 * 4 + i] += d.translate[j] * at(m, j, i);
  }
  const [x, y, z, w] = d.quaternion;
  const rotation = IDENTITY();
  rotation[0] = 1 - 2 * (y * y + z * z); rotation[4] = 2 * (x * y - z * w); rotation[8] = 2 * (x * z + y * w);
  rotation[1] = 2 * (x * y + z * w); rotation[5] = 1 - 2 * (x * x + z * z); rotation[9] = 2 * (y * z - x * w);
  rotation[2] = 2 * (x * z - y * w); rotation[6] = 2 * (y * z + x * w); rotation[10] = 1 - 2 * (x * x + y * y);
  m = multiply(m, rotation);
  const skewBy = (c, r, v) => {
    if (!v) return;
    const t = IDENTITY();
    t[c * 4 + r] = v;
    m = multiply(m, t);
  };
  skewBy(2, 1, d.skew[2]);
  skewBy(2, 0, d.skew[1]);
  skewBy(1, 0, d.skew[0]);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 4; r++) m[c * 4 + r] *= d.scale[c];
  }
  return m;
}

// The matrix `p` of the way from `a` to `b`, or null when either will not decompose (a singular matrix: the caller
// flips discretely, as a browser does).
export function interpolateMatrices(a, b, p) {
  if (is2DMatrix(a) && is2DMatrix(b)) {
    const da = decompose2D(a), db = decompose2D(b);
    return da && db ? recompose2D(blend2D(da, db, p)) : null;
  }
  const da = decompose3D(a), db = decompose3D(b);
  if (!da || !db) return null;
  const mix3 = (x, y) => x.map((v, i) => lerp(v, y[i], p));
  return recompose3D({
    translate: mix3(da.translate, db.translate),
    scale: mix3(da.scale, db.scale),
    skew: mix3(da.skew, db.skew),
    perspective: da.perspective.map((v, i) => lerp(v, db.perspective[i], p)),
    quaternion: slerp(da.quaternion, db.quaternion, p)
  });
}
