// The Geometry Interfaces (Geometry Interfaces 1), generated from their IDL: DOMPoint, DOMRect, DOMQuad, DOMMatrix,
// their read-only forms, and DOMRectList. A matrix's algebra — what each method post-multiplies it by, a CSS transform
// list parsed into one, a point transformed — is native's (dom_matrix.rs); the bindings convert the arguments and read
// the dictionaries. What is left here is each object's state, its internal slots': a point's four coordinates, a rect's
// four numbers, a quad's four points, a matrix's sixteen entries (column-major, m11, m12, …, m44) and whether it is 2D.

import {
  convertDOMMatrixArguments, convertDOMMatrixReadOnlyArguments, convertDOMPointArguments,
  convertDOMPointReadOnlyArguments, convertDOMQuadArguments, convertDOMRectArguments, convertDOMRectReadOnlyArguments,
  defineDOMRectList, installDOMMatrix, installDOMMatrixReadOnly, installDOMPoint, installDOMPointReadOnly, installDOMQuad,
  installDOMRect, installDOMRectReadOnly
} from './generated/bindings.js';
import { brandKey, makeSlots, registerInterface, slotsOf } from './webidl.js';

// ── DOMPoint ──
const pointOf = (o) => slotsOf(o, 'DOMPointReadOnly');
registerInterface('DOMPointReadOnly', (o) => pointOf(o) !== undefined);
registerInterface('DOMPoint', (o) => slotsOf(o, 'DOMPoint') !== undefined);
// (…a DOMPointInit's coordinates, its defaults the binding's)
const pointInit = (d) => [d.x, d.y, d.z, d.w];
// A point of `cls` (a DOMPoint's brand too where it is one) at `p`, made by the platform.
function makePoint(cls, p) {
  const o = Object.create(cls.prototype);
  makeSlots(o, 'DOMPointReadOnly', { p });
  if (cls === DOMPoint) makeSlots(o, 'DOMPoint');
  return o;
}

export class DOMPointReadOnly {
  constructor(x, y, z, w) {
    makeSlots(this, 'DOMPointReadOnly', { p: convertDOMPointReadOnlyArguments(arguments) });
  }
}
export class DOMPoint extends DOMPointReadOnly {
  constructor(x, y, z, w) {
    super(...convertDOMPointArguments(arguments));
    makeSlots(this, 'DOMPoint');
  }
}
installDOMPointReadOnly(DOMPointReadOnly, {
  fromPoint: (self, other) => makePoint(DOMPointReadOnly, pointInit(other)),
  get_x: (point) => pointOf(point).p[0],
  get_y: (point) => pointOf(point).p[1],
  get_z: (point) => pointOf(point).p[2],
  get_w: (point) => pointOf(point).p[3],
  // The point transformed by the matrix a DOMMatrixInit makes — always a new DOMPoint.
  matrixTransform: (point, matrix) => transformed(fixUp(matrix).m, pointOf(point).p)
});
installDOMPoint(DOMPoint, {
  fromPoint: (self, other) => makePoint(DOMPoint, pointInit(other)),
  get_x: (point) => pointOf(point).p[0],
  set_x: (point, v) => { pointOf(point).p[0] = v; },
  get_y: (point) => pointOf(point).p[1],
  set_y: (point, v) => { pointOf(point).p[1] = v; },
  get_z: (point) => pointOf(point).p[2],
  set_z: (point, v) => { pointOf(point).p[2] = v; },
  get_w: (point) => pointOf(point).p[3],
  set_w: (point, v) => { pointOf(point).p[3] = v; }
});
function transformed(m, p) {
  return makePoint(DOMPoint, Array.from(globalThis.__dom.matrixPoint(Float64Array.from(m), ...p)));
}

// ── DOMRect ──
const rectOf = (o) => slotsOf(o, 'DOMRectReadOnly');
registerInterface('DOMRectReadOnly', (o) => rectOf(o) !== undefined);
registerInterface('DOMRect', (o) => slotsOf(o, 'DOMRect') !== undefined);
const rectInit = (d) => [d.x, d.y, d.width, d.height];
function makeRect(cls, r) {
  const o = Object.create(cls.prototype);
  makeSlots(o, 'DOMRectReadOnly', { r });
  if (cls === DOMRect) makeSlots(o, 'DOMRect');
  return o;
}
// The minimum / maximum of two coordinates, NaN where either is (Geometry Interfaces 1 §3: "the minimum of", Infra).
const min = (a, b) => (a !== a || b !== b ? NaN : a < b ? a : b);
const max = (a, b) => (a !== a || b !== b ? NaN : a > b ? a : b);

export class DOMRectReadOnly {
  constructor(x, y, width, height) {
    makeSlots(this, 'DOMRectReadOnly', { r: convertDOMRectReadOnlyArguments(arguments) });
  }
}
export class DOMRect extends DOMRectReadOnly {
  constructor(x, y, width, height) {
    super(...convertDOMRectArguments(arguments));
    makeSlots(this, 'DOMRect');
  }
}
// A DOMRectReadOnly of a converted DOMRectInit — `fromRect`'s, and the platform's own, which a page's `fromRect` is none of.
export const readOnlyRectFrom = (init) => makeRect(DOMRectReadOnly, rectInit(init));
installDOMRectReadOnly(DOMRectReadOnly, {
  fromRect: (self, other) => readOnlyRectFrom(other),
  get_x: (rect) => rectOf(rect).r[0],
  get_y: (rect) => rectOf(rect).r[1],
  get_width: (rect) => rectOf(rect).r[2],
  get_height: (rect) => rectOf(rect).r[3],
  get_top: (rect) => { const { r } = rectOf(rect); return min(r[1], r[1] + r[3]); },
  get_right: (rect) => { const { r } = rectOf(rect); return max(r[0], r[0] + r[2]); },
  get_bottom: (rect) => { const { r } = rectOf(rect); return max(r[1], r[1] + r[3]); },
  get_left: (rect) => { const { r } = rectOf(rect); return min(r[0], r[0] + r[2]); }
});
installDOMRect(DOMRect, {
  fromRect: (self, other) => makeRect(DOMRect, rectInit(other)),
  get_x: (rect) => rectOf(rect).r[0],
  set_x: (rect, v) => { rectOf(rect).r[0] = v; },
  get_y: (rect) => rectOf(rect).r[1],
  set_y: (rect, v) => { rectOf(rect).r[1] = v; },
  get_width: (rect) => rectOf(rect).r[2],
  set_width: (rect, v) => { rectOf(rect).r[2] = v; },
  get_height: (rect) => rectOf(rect).r[3],
  set_height: (rect, v) => { rectOf(rect).r[3] = v; }
});

// A list of rects (getClientRects): `length`, `item()` and its indices, which read the list it was made with.
const RectList = defineDOMRectList({
  init(list, rects) { list.rects = rects; },
  item: (list, index) => (index < list.rects.length ? list.rects[index] : null),
  get_length: (list) => list.rects.length
});
export const DOMRectList = RectList.interface;
export const rectList = (rects) => RectList.create(rects);

// ── DOMQuad ──
const quadOf = (o) => slotsOf(o, 'DOMQuad');
registerInterface('DOMQuad', (o) => quadOf(o) !== undefined);
function makeQuad(points) {
  const o = Object.create(DOMQuad.prototype);
  makeSlots(o, 'DOMQuad', { points: points.map((p) => makePoint(DOMPoint, p)) });
  return o;
}
export class DOMQuad {
  constructor(p1, p2, p3, p4) {
    makeSlots(this, 'DOMQuad', { points: convertDOMQuadArguments(arguments).map((p) => makePoint(DOMPoint, pointInit(p))) });
  }
}
installDOMQuad(DOMQuad, {
  fromRect(self, other) {
    const [x, y, w, h] = rectInit(other);
    return makeQuad([[x, y, 0, 1], [x + w, y, 0, 1], [x + w, y + h, 0, 1], [x, y + h, 0, 1]]);
  },
  fromQuad: (self, other) => makeQuad([other.p1, other.p2, other.p3, other.p4].map(pointInit)),
  get_p1: (quad) => quadOf(quad).points[0],
  get_p2: (quad) => quadOf(quad).points[1],
  get_p3: (quad) => quadOf(quad).points[2],
  get_p4: (quad) => quadOf(quad).points[3],
  // The smallest rect around the four points, NaN on an axis where one of them is.
  getBounds(quad) {
    const ps = quadOf(quad).points.map((p) => pointOf(p).p);
    const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
    const left = xs.reduce(min), top = ys.reduce(min);
    return makeRect(DOMRect, [left, top, xs.reduce(max) - left, ys.reduce(max) - top]);
  }
});

// ── DOMMatrix ──
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const NAMES = ['m11', 'm12', 'm13', 'm14', 'm21', 'm22', 'm23', 'm24', 'm31', 'm32', 'm33', 'm34', 'm41', 'm42', 'm43', 'm44'];
const ALIASES = { a: 0, b: 1, c: 4, d: 5, e: 12, f: 13 };
// The entries that are 0 in every 2D matrix, and the two that are 1.
const ZERO_IN_2D = [2, 3, 6, 7, 8, 9, 11, 14];
const ONE_IN_2D = [10, 15];

const matrixOf = (o) => slotsOf(o, 'DOMMatrixReadOnly');
registerInterface('DOMMatrixReadOnly', (o) => matrixOf(o) !== undefined);
registerInterface('DOMMatrix', (o) => slotsOf(o, 'DOMMatrix') !== undefined);
function makeMatrix(cls, m, is2D) {
  const o = Object.create(cls.prototype);
  makeSlots(o, 'DOMMatrixReadOnly', { m: Float64Array.from(m), is2D });
  if (cls === DOMMatrix) makeSlots(o, 'DOMMatrix');
  return o;
}
// A native answer, `[…m, is2D]`, as a new DOMMatrix.
const answered = (r) => makeMatrix(DOMMatrix, r.subarray(0, 16), r[16] === 1);

// "Create a DOMMatrix from a 2D sequence / a 3D sequence" (6 or 16 numbers).
function fromSequence(a) {
  if (a.length === 6) return { m: [a[0], a[1], 0, 0, a[2], a[3], 0, 0, 0, 0, 1, 0, a[4], a[5], 0, 1], is2D: true };
  if (a.length === 16) return { m: a, is2D: false };
  throw new TypeError('DOMMatrix: a sequence must have 6 or 16 elements');
}
// "Parse a string into an abstract matrix" (`__dom.matrixParse`): only where the global is a Window.
function fromString(text) {
  if (globalThis.__csim_isWorker) throw new TypeError('DOMMatrix: a string is parsed only in a Window');
  const r = globalThis.__dom.matrixParse(text);
  if (r === null) throw new DOMException(`DOMMatrix: ${JSON.stringify(text)} is not a transform list`, 'SyntaxError');
  return { m: Array.from(r.subarray(0, 16)), is2D: r[16] === 1 };
}
// The constructor's init (the binding's union): none the identity, a string parsed, a sequence of 6 or 16.
function fromInit(init) {
  if (init === undefined) return { m: IDENTITY, is2D: true };
  return typeof init === 'string' ? fromString(init) : fromSequence(init);
}
// "Validate and fix up" a DOMMatrixInit (§6.1) — its members the binding's, read in WebIDL's order — into `{m, is2D}`:
// an alias and its entry that disagree (SameValueZero), or a 2D one with a 3D entry set, are a TypeError.
function fixUp(d) {
  const sameValueZero = (x, y) => x === y || (x !== x && y !== y);
  const m = IDENTITY.slice();
  for (const [k, i] of Object.entries(ALIASES)) {
    const a = d[k], e = d[NAMES[i]];
    if (a !== undefined && e !== undefined && !sameValueZero(a, e)) throw new TypeError(`DOMMatrix: ${k} and ${NAMES[i]} disagree`);
    m[i] = e !== undefined ? e : a !== undefined ? a : IDENTITY[i];
  }
  let threeD = false;
  for (const i of [...ZERO_IN_2D, ...ONE_IN_2D]) {
    const e = d[NAMES[i]];
    if (e === undefined) continue;
    m[i] = e;
    if (e !== IDENTITY[i]) threeD = true;
  }
  if (d.is2D === true && threeD) throw new TypeError('DOMMatrix: is2D is true but a 3D entry is set');
  return { m, is2D: d.is2D === undefined ? !threeD : d.is2D };
}
// A method's answer (`__dom.matrixMethod`) on `matrix` with `args`.
function method(matrix, name, args) {
  const s = matrixOf(matrix);
  return answered(globalThis.__dom.matrixMethod(s.m, s.is2D, name, Float64Array.from(args)));
}
// …and a mutating one's end: `matrix` takes the state of the matrix the non-mutating one made.
function becomes(matrix, other) {
  const s = matrixOf(matrix), o = matrixOf(other);
  s.m = o.m;
  s.is2D = o.is2D;
  return matrix;
}
// The non-mutating methods' answers, which the mutating ones take.
const scaled = (matrix, scaleX, scaleY, scaleZ, originX, originY, originZ) =>
  method(matrix, 'scale', [scaleX, scaleY === undefined ? scaleX : scaleY, scaleZ, originX, originY, originZ]);   // (…an absent scaleY scaleX's)
const rotated = (matrix, rotX, rotY, rotZ) => (rotY === undefined && rotZ === undefined
  ? method(matrix, 'rotate', [0, 0, rotX])   // (…a lone angle about Z)
  : method(matrix, 'rotate', [rotX, rotY === undefined ? 0 : rotY, rotZ === undefined ? 0 : rotZ]));
const rotatedTo = (matrix, x, y) => method(matrix, 'rotate', [0, 0, x === 0 && y === 0 ? 0 : Math.atan2(y, x) * 180 / Math.PI]);
function multiplied(matrix, other) {
  const o = fixUp(other), s = matrixOf(matrix);
  return makeMatrix(DOMMatrix, globalThis.__dom.matrixMultiply(s.m, Float64Array.from(o.m)), s.is2D && o.is2D);
}

export class DOMMatrixReadOnly {
  constructor(init) {
    const { m, is2D } = fromInit(...convertDOMMatrixReadOnlyArguments(arguments));
    makeSlots(this, 'DOMMatrixReadOnly', { m: Float64Array.from(m), is2D });
  }
}
export class DOMMatrix extends DOMMatrixReadOnly {
  constructor(init) {
    super(...convertDOMMatrixArguments(arguments));
    makeSlots(this, 'DOMMatrix');
  }
}
// Its entries and their aliases, as the read-only form reads them; the mutable one writes them too — setting one that
// is 0 (or 1) in every 2D matrix to anything else makes it 3D.
function entries(writable) {
  const impl = {};
  NAMES.forEach((k, i) => {
    impl[`get_${k}`] = (matrix) => matrixOf(matrix).m[i];
    if (!writable) return;
    impl[`set_${k}`] = (matrix, v) => {
      const s = matrixOf(matrix);
      s.m[i] = v;
      if ((ZERO_IN_2D.includes(i) && v !== 0) || (ONE_IN_2D.includes(i) && v !== 1)) s.is2D = false;
    };
  });
  for (const [k, i] of Object.entries(ALIASES)) {
    impl[`get_${k}`] = (matrix) => matrixOf(matrix).m[i];
    if (writable) impl[`set_${k}`] = (matrix, v) => { matrixOf(matrix).m[i] = v; };
  }
  return impl;
}
// (…`fromFloat32Array` / `fromFloat64Array`: a 6- or 16-element array's — the binding's buffer conversion)
const fromArray = (cls, array) => { const c = fromSequence(Array.from(array)); return makeMatrix(cls, c.m, c.is2D); };
const fromMatrix = (cls, other) => { const c = fixUp(other); return makeMatrix(cls, c.m, c.is2D); };
installDOMMatrixReadOnly(DOMMatrixReadOnly, {
  ...entries(false),
  fromMatrix: (self, other) => fromMatrix(DOMMatrixReadOnly, other),
  fromFloat32Array: (self, array) => fromArray(DOMMatrixReadOnly, array),
  fromFloat64Array: (self, array) => fromArray(DOMMatrixReadOnly, array),
  get_is2D: (matrix) => matrixOf(matrix).is2D,
  get_isIdentity: (matrix) => { const { m } = matrixOf(matrix); return IDENTITY.every((v, i) => m[i] === v); },
  translate: (matrix, tx, ty, tz) => method(matrix, 'translate', [tx, ty, tz]),
  scale: scaled,
  scaleNonUniform: (matrix, scaleX, scaleY) => method(matrix, 'scale', [scaleX, scaleY, 1, 0, 0, 0]),
  scale3d: (matrix, scale, originX, originY, originZ) => method(matrix, 'scale', [scale, scale, scale, originX, originY, originZ]),
  rotate: rotated,
  rotateFromVector: rotatedTo,
  rotateAxisAngle: (matrix, x, y, z, angle) => method(matrix, 'rotateAxisAngle', [x, y, z, angle]),
  skewX: (matrix, sx) => method(matrix, 'skewX', [sx]),
  skewY: (matrix, sy) => method(matrix, 'skewY', [sy]),
  multiply: multiplied,
  flipX: (matrix) => method(matrix, 'flipX', []),
  flipY: (matrix) => method(matrix, 'flipY', []),
  inverse: (matrix) => method(matrix, 'inverse', []),
  transformPoint: (matrix, point) => transformed(matrixOf(matrix).m, pointInit(point)),
  toFloat32Array: (matrix) => new Float32Array(matrixOf(matrix).m),
  toFloat64Array: (matrix) => new Float64Array(matrixOf(matrix).m),
  // The stringifier (a Window's): `matrix(a, b, c, d, e, f)`, or `matrix3d(…)` of all sixteen — an InvalidStateError
  // where one is not finite.
  stringify(matrix) {
    const { m, is2D } = matrixOf(matrix);
    if (!m.every(Number.isFinite)) throw new DOMException('DOMMatrix: cannot serialize a non-finite matrix', 'InvalidStateError');
    return is2D ? `matrix(${[m[0], m[1], m[4], m[5], m[12], m[13]].join(', ')})` : `matrix3d(${m.join(', ')})`;
  }
});
installDOMMatrix(DOMMatrix, {
  ...entries(true),
  fromMatrix: (self, other) => fromMatrix(DOMMatrix, other),
  fromFloat32Array: (self, array) => fromArray(DOMMatrix, array),
  fromFloat64Array: (self, array) => fromArray(DOMMatrix, array),
  multiplySelf: (matrix, other) => becomes(matrix, multiplied(matrix, other)),
  preMultiplySelf(matrix, other) {
    const o = fixUp(other), s = matrixOf(matrix);
    s.m = globalThis.__dom.matrixMultiply(Float64Array.from(o.m), s.m);
    s.is2D = s.is2D && o.is2D;
    return matrix;
  },
  translateSelf: (matrix, tx, ty, tz) => becomes(matrix, method(matrix, 'translate', [tx, ty, tz])),
  scaleSelf: (matrix, ...args) => becomes(matrix, scaled(matrix, ...args)),
  scale3dSelf: (matrix, scale, originX, originY, originZ) => becomes(matrix, method(matrix, 'scale', [scale, scale, scale, originX, originY, originZ])),
  rotateSelf: (matrix, ...args) => becomes(matrix, rotated(matrix, ...args)),
  rotateFromVectorSelf: (matrix, x, y) => becomes(matrix, rotatedTo(matrix, x, y)),
  rotateAxisAngleSelf: (matrix, x, y, z, angle) => becomes(matrix, method(matrix, 'rotateAxisAngle', [x, y, z, angle])),
  skewXSelf: (matrix, sx) => becomes(matrix, method(matrix, 'skewX', [sx])),
  skewYSelf: (matrix, sy) => becomes(matrix, method(matrix, 'skewY', [sy])),
  invertSelf: (matrix) => becomes(matrix, method(matrix, 'inverse', [])),
  setMatrixValue(matrix, transformList) {
    const c = fromString(transformList), s = matrixOf(matrix);
    s.m = Float64Array.from(c.m);
    s.is2D = c.is2D;
    return matrix;
  }
});

// ── structured clone (each is serializable but the list) ──
// A geometry object's copy in this realm — any realm's, by its slots, read off them rather than its getters (which a
// page can shadow); undefined for anything else.
export function cloneGeometry(v) {
  const point = pointOf(v), rect = rectOf(v), quad = quadOf(v), matrix = matrixOf(v);
  if (point) return makePoint(slotsOf(v, 'DOMPoint') ? DOMPoint : DOMPointReadOnly, point.p.slice());
  if (rect) return makeRect(slotsOf(v, 'DOMRect') ? DOMRect : DOMRectReadOnly, rect.r.slice());
  if (quad) return makeQuad(quad.points.map((p) => pointOf(p).p.slice()));
  if (matrix) {
    // (…a 2D one serialized as its six entries, so the others come back the 2D matrix's own +0 and 1)
    const { m, is2D } = matrix;
    const c = is2D ? fromSequence([m[0], m[1], m[4], m[5], m[12], m[13]]) : { m: Array.from(m), is2D: false };
    return makeMatrix(slotsOf(v, 'DOMMatrix') ? DOMMatrix : DOMMatrixReadOnly, c.m, c.is2D);
  }
  if (slotsOf(v, brandKey('DOMRectList'))) throw new DOMException('A DOMRectList could not be cloned.', 'DataCloneError');
  return undefined;
}

for (const cls of [DOMPointReadOnly, DOMPoint, DOMRectReadOnly, DOMRect, DOMRectList, DOMQuad, DOMMatrixReadOnly, DOMMatrix]) {
  Object.defineProperty(globalThis, cls.name, { value: cls, writable: true, enumerable: false, configurable: true });
}