// Matrix interpolation (CSS Transforms 2 §"Interpolation of 3D matrices"): what a transform list interpolates as
// where two of its functions share no primitive — `translateX(0px)` against `scale(3)` is `matrix(2, 0, 0, 2, 0, 0)`
// half way in Chrome and Firefox alike, not a discrete flip. Each side is DECOMPOSED — translation, scale, skew, a
// rotation as a quaternion, perspective — those parts are mixed (the rotation by spherical interpolation), and the
// result RECOMPOSED.
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

// A 2D matrix takes apart as the two engines do it (Gecko's `Decompose2DMatrix`, Blink's alike): an X scale, an XY
// shear, a Y scale and a rotation about Z — a flip carried by the X scale alone, so `scale(-1, 1)` is that and not
// the half turn about X the 3D decomposition makes of it (`scale(-1, 1)` to `rotate(90deg)` half way is
// `matrix(0, 0, -0.707107, 0.707107, 0, 0)` in Chrome and Firefox). In the 3D decomposition's terms, so the two mix
// and recompose alike. Null for a singular matrix.
function decompose2D(m) {
  let a = m[0], b = m[1], c = m[4], d = m[5];
  if (a * d === b * c) return null;
  let sx = Math.hypot(a, b);
  a /= sx; b /= sx;
  let shear = a * c + b * d;
  c -= a * shear; d -= b * shear;
  const sy = Math.hypot(c, d);
  c /= sy; d /= sy; shear /= sy;
  if (a * d < b * c) {
    a = -a; b = -b; shear = -shear; sx = -sx;
  }
  const half = Math.atan2(b, a) / 2;
  return {
    translate: [m[12], m[13], 0],
    scale: [sx, sy, 1],
    skew: [shear, 0, 0],
    perspective: [0, 0, 0, 1],
    quaternion: [0, 0, Math.sin(half), Math.cos(half)]
  };
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
// flips discretely, as a browser does). Two 2D matrices decompose as 2D ones and the result is 2D again, its third axis
// and projective row put back exactly; anything else takes the 3D decomposition.
export function interpolateMatrices(a, b, p) {
  const flat = is2DMatrix(a) && is2DMatrix(b);
  const da = flat ? decompose2D(a) : decompose3D(a), db = flat ? decompose2D(b) : decompose3D(b);
  if (!da || !db) return null;
  const mix3 = (x, y) => x.map((v, i) => lerp(v, y[i], p));
  const m = recompose3D({
    translate: mix3(da.translate, db.translate),
    scale: mix3(da.scale, db.scale),
    skew: mix3(da.skew, db.skew),
    perspective: da.perspective.map((v, i) => lerp(v, db.perspective[i], p)),
    quaternion: slerp(da.quaternion, db.quaternion, p)
  });
  if (flat) {
    for (const i of [2, 3, 6, 7, 8, 9, 11, 14]) m[i] = 0;
    m[10] = m[15] = 1;
  }
  return m;
}
