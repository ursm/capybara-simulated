// The Geometry Interfaces (Geometry Interfaces 1): DOMPoint, DOMRect, DOMQuad, DOMMatrix, their read-only forms, and
// DOMRectList. A matrix's algebra — what each method post-multiplies it by, a CSS transform list parsed into one, a
// point transformed — is native's (dom_matrix.rs); these are the bindings: argument conversion, the dictionaries'
// validation, and each object's state, kept under a symbol so that nothing of it shows as a property.

// Each object's state, out of the page's reach (no property shows it, freezing the object does not touch it) — and
// a method or an attribute asked of anything that has none is the TypeError WebIDL's brand check is.
const STATES = new globalThis.WeakMap();
function setSlot(o, state) {
  STATES.set(o, state);
}
function own(o) {
  const state = STATES.get(o);
  if (state === undefined) throw new globalThis.TypeError('Illegal invocation');
  return state;
}

// WebIDL: a dictionary argument (undefined / null are the empty one; a primitive is a TypeError), and an
// `unrestricted double` member or argument with its default.
function dict(v, what) {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' && typeof v !== 'function') throw new globalThis.TypeError(`${what} is not an object`);
  return v;
}
const num = (v, dflt) => (v === undefined ? dflt : +v);

// ── DOMPoint ──
// A DOMPointInit read: its members in the order WebIDL reads a dictionary (lexicographic).
function pointInit(v) {
  const d = dict(v, 'DOMPointInit');
  const w = num(d.w, 1), x = num(d.x, 0), y = num(d.y, 0), z = num(d.z, 0);
  return [x, y, z, w];
}
function makePoint(cls, p) {
  const o = globalThis.Object.create(cls.prototype);
  setSlot(o, p);
  return o;
}

export class DOMPointReadOnly {
  constructor(x = 0, y = 0, z = 0, w = 1) { setSlot(this, [+x, +y, +z, +w]); }
  static fromPoint(other = undefined) { return makePoint(DOMPointReadOnly, pointInit(other)); }
  get x() { return own(this)[0]; }
  get y() { return own(this)[1]; }
  get z() { return own(this)[2]; }
  get w() { return own(this)[3]; }
  // The point transformed by the matrix a DOMMatrixInit makes — always a new DOMPoint.
  matrixTransform(matrix = undefined) {
    const {m} = matrixInit(matrix);
    return makePoint(DOMPoint, globalThis.Array.from(globalThis.__dom.matrixPoint(globalThis.Float64Array.from(m), ...own(this))));
  }
  toJSON() { return {x: this.x, y: this.y, z: this.z, w: this.w}; }
}
export class DOMPoint extends DOMPointReadOnly {
  static fromPoint(other = undefined) { return makePoint(DOMPoint, pointInit(other)); }
  get x() { return own(this)[0]; }
  set x(v) { own(this)[0] = +v; }
  get y() { return own(this)[1]; }
  set y(v) { own(this)[1] = +v; }
  get z() { return own(this)[2]; }
  set z(v) { own(this)[2] = +v; }
  get w() { return own(this)[3]; }
  set w(v) { own(this)[3] = +v; }
}

// ── DOMRect ──
function rectInit(v) {
  const d = dict(v, 'DOMRectInit');
  const height = num(d.height, 0), width = num(d.width, 0), x = num(d.x, 0), y = num(d.y, 0);
  return [x, y, width, height];
}
function makeRect(cls, r) {
  const o = globalThis.Object.create(cls.prototype);
  setSlot(o, r);
  return o;
}
// The minimum / maximum of two coordinates, NaN where either is (Geometry Interfaces 1 §3: "the minimum of", Infra).
const min = (a, b) => (a !== a || b !== b ? NaN : a < b ? a : b);
const max = (a, b) => (a !== a || b !== b ? NaN : a > b ? a : b);

export class DOMRectReadOnly {
  constructor(x = 0, y = 0, width = 0, height = 0) { setSlot(this, [+x, +y, +width, +height]); }
  static fromRect(other = undefined) { return makeRect(DOMRectReadOnly, rectInit(other)); }
  get x() { return own(this)[0]; }
  get y() { return own(this)[1]; }
  get width() { return own(this)[2]; }
  get height() { return own(this)[3]; }
  get top() { const r = own(this); return min(r[1], r[1] + r[3]); }
  get right() { const r = own(this); return max(r[0], r[0] + r[2]); }
  get bottom() { const r = own(this); return max(r[1], r[1] + r[3]); }
  get left() { const r = own(this); return min(r[0], r[0] + r[2]); }
  toJSON() {
    return {x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, right: this.right, bottom: this.bottom, left: this.left};
  }
}
export class DOMRect extends DOMRectReadOnly {
  static fromRect(other = undefined) { return makeRect(DOMRect, rectInit(other)); }
  get x() { return own(this)[0]; }
  set x(v) { own(this)[0] = +v; }
  get y() { return own(this)[1]; }
  set y(v) { own(this)[1] = +v; }
  get width() { return own(this)[2]; }
  set width(v) { own(this)[2] = +v; }
  get height() { return own(this)[3]; }
  set height(v) { own(this)[3] = +v; }
}

// A list of rects (getClientRects): `length`, `item()` and its indices, which read the list it was made with.
export class DOMRectList {
  constructor() { throw new globalThis.TypeError('Illegal constructor'); }
  get length() { return own(this).length; }
  item(index) {
    if (arguments.length < 1) throw new globalThis.TypeError('1 argument required, but only 0 present.');
    const r = own(this)[index >>> 0];
    return r === undefined ? null : r;
  }
}
DOMRectList.prototype[globalThis.Symbol.iterator] = globalThis.Array.prototype.values;
export function rectList(rects) {
  const o = globalThis.Object.create(DOMRectList.prototype);
  setSlot(o, rects);
  rects.forEach((r, i) => globalThis.Object.defineProperty(o, i, {value: r, enumerable: true, configurable: true}));
  return o;
}

// ── DOMQuad ──
export class DOMQuad {
  constructor(p1 = undefined, p2 = undefined, p3 = undefined, p4 = undefined) {
    setSlot(this, [p1, p2, p3, p4].map((p) => makePoint(DOMPoint, pointInit(p))));
  }
  static fromRect(other = undefined) {
    const [x, y, w, h] = rectInit(other);
    return makeQuad([[x, y, 0, 1], [x + w, y, 0, 1], [x + w, y + h, 0, 1], [x, y + h, 0, 1]]);
  }
  static fromQuad(other = undefined) {
    const d = dict(other, 'DOMQuadInit');
    const p1 = pointInit(d.p1), p2 = pointInit(d.p2), p3 = pointInit(d.p3), p4 = pointInit(d.p4);
    return makeQuad([p1, p2, p3, p4]);
  }
  get p1() { return own(this)[0]; }
  get p2() { return own(this)[1]; }
  get p3() { return own(this)[2]; }
  get p4() { return own(this)[3]; }
  // The smallest rect around the four points, NaN on an axis where one of them is.
  getBounds() {
    const ps = own(this);
    const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
    const left = xs.reduce(min), top = ys.reduce(min);
    return makeRect(DOMRect, [left, top, xs.reduce(max) - left, ys.reduce(max) - top]);
  }
  toJSON() { return {p1: this.p1, p2: this.p2, p3: this.p3, p4: this.p4}; }
}
function makeQuad(points) {
  const o = globalThis.Object.create(DOMQuad.prototype);
  setSlot(o, points.map((p) => makePoint(DOMPoint, p)));
  return o;
}

// ── DOMMatrix ──
// State: `{m, is2D}`, `m` the sixteen entries column-major (m11, m12, …, m44).
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const NAMES = ['m11', 'm12', 'm13', 'm14', 'm21', 'm22', 'm23', 'm24', 'm31', 'm32', 'm33', 'm34', 'm41', 'm42', 'm43', 'm44'];
const ALIASES = {a: 0, b: 1, c: 4, d: 5, e: 12, f: 13};
// The entries that are 0 in every 2D matrix, and the two that are 1.
const ZERO_IN_2D = [2, 3, 6, 7, 8, 9, 11, 14];
const ONE_IN_2D = [10, 15];

function makeMatrix(cls, m, is2D) {
  const o = globalThis.Object.create(cls.prototype);
  setSlot(o, {m: globalThis.Float64Array.from(m), is2D});
  return o;
}
// A native answer, `[…m, is2D]`, as a new DOMMatrix.
function answered(r) { return makeMatrix(DOMMatrix, r.subarray(0, 16), r[16] === 1); }

// "Create a DOMMatrix from a 2D sequence / a 3D sequence" (6 or 16 numbers).
function fromSequence(seq) {
  const a = globalThis.Array.from(seq, (v) => +v);
  if (a.length === 6) return {m: [a[0], a[1], 0, 0, a[2], a[3], 0, 0, 0, 0, 1, 0, a[4], a[5], 0, 1], is2D: true};
  if (a.length === 16) return {m: a, is2D: false};
  throw new globalThis.TypeError('DOMMatrix: a sequence must have 6 or 16 elements');
}
// "Parse a string into an abstract matrix" (`__dom.matrixParse`): only where the global is a Window.
function fromString(text) {
  if (globalThis.__csim_isWorker) throw new globalThis.TypeError('DOMMatrix: a string is parsed only in a Window');
  const r = globalThis.__dom.matrixParse(String(text));
  if (r === null) throw new globalThis.DOMException(`DOMMatrix: ${JSON.stringify(String(text))} is not a transform list`, 'SyntaxError');
  return {m: globalThis.Array.from(r.subarray(0, 16)), is2D: r[16] === 1};
}
// "Validate and fix up" a DOMMatrixInit (§6.1), its members read lexicographically, into `{m, is2D}`: an alias and its
// entry that disagree (SameValueZero), or a 2D one with a 3D entry set, are a TypeError.
function matrixInit(v) {
  const d = dict(v, 'DOMMatrixInit');
  const read = (k) => (d[k] === undefined ? undefined : +d[k]);
  // (…in WebIDL's order: DOMMatrix2DInit's members first, then DOMMatrixInit's own, each lexicographically)
  const alias = {}, entry = {};
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) alias[k] = read(k);
  for (const k of ['m11', 'm12', 'm21', 'm22', 'm41', 'm42']) entry[k] = read(k);
  const is2DRaw = d.is2D;
  for (const k of ['m13', 'm14', 'm23', 'm24', 'm31', 'm32', 'm33', 'm34', 'm43', 'm44']) entry[k] = read(k);
  const sameValueZero = (x, y) => x === y || (x !== x && y !== y);
  const m = IDENTITY.slice();
  for (const [k, i] of globalThis.Object.entries(ALIASES)) {
    const a = alias[k], e = entry[NAMES[i]];
    if (a !== undefined && e !== undefined && !sameValueZero(a, e)) throw new globalThis.TypeError(`DOMMatrix: ${k} and ${NAMES[i]} disagree`);
    m[i] = e !== undefined ? e : a !== undefined ? a : IDENTITY[i];
  }
  let threeD = false;
  for (const i of [...ZERO_IN_2D, ...ONE_IN_2D]) {
    const e = entry[NAMES[i]];
    if (e === undefined) continue;
    m[i] = e;
    if (e !== IDENTITY[i]) threeD = true;
  }
  let is2D = is2DRaw === undefined ? undefined : !!is2DRaw;
  if (is2D === true && threeD) throw new globalThis.TypeError('DOMMatrix: is2D is true but a 3D entry is set');
  if (is2D === undefined) is2D = !threeD;
  return {m, is2D};
}
function float(a, Type) {
  if (!(a instanceof Type)) throw new globalThis.TypeError(`DOMMatrix: not a ${Type.name}`);
  return fromSequence(a);
}
// A method's answer (`__dom.matrixMethod`) on `self` with `args`.
function method(self, name, args) {
  const s = own(self);
  return answered(globalThis.__dom.matrixMethod(s.m, s.is2D, name, globalThis.Float64Array.from(args)));
}

export class DOMMatrixReadOnly {
  constructor(init = undefined) {
    let core;
    if (init === undefined) core = {m: IDENTITY, is2D: true};
    else if (init !== null && typeof init === 'object' && globalThis.Symbol.iterator in init) core = fromSequence(init);
    else core = fromString(init);
    setSlot(this, {m: globalThis.Float64Array.from(core.m), is2D: core.is2D});
  }
  static fromMatrix(other = undefined) { const c = matrixInit(other); return makeMatrix(this, c.m, c.is2D); }
  static fromFloat32Array(array32) { const c = float(array32, globalThis.Float32Array); return makeMatrix(this, c.m, c.is2D); }
  static fromFloat64Array(array64) { const c = float(array64, globalThis.Float64Array); return makeMatrix(this, c.m, c.is2D); }

  get is2D() { return own(this).is2D; }
  get isIdentity() { const m = own(this).m; return IDENTITY.every((v, i) => m[i] === v); }

  translate(tx = 0, ty = 0, tz = 0) { return method(this, 'translate', [+tx, +ty, +tz]); }
  scale(scaleX = 1, scaleY = undefined, scaleZ = 1, originX = 0, originY = 0, originZ = 0) {
    scaleX = +scaleX;
    return method(this, 'scale', [scaleX, scaleY === undefined ? scaleX : +scaleY, +scaleZ, +originX, +originY, +originZ]);
  }
  scaleNonUniform(scaleX = 1, scaleY = 1) { return method(this, 'scale', [+scaleX, +scaleY, 1, 0, 0, 0]); }
  scale3d(scale = 1, originX = 0, originY = 0, originZ = 0) {
    scale = +scale;
    return method(this, 'scale', [scale, scale, scale, +originX, +originY, +originZ]);
  }
  // rotate(rotX, rotY, rotZ): a lone angle is about Z.
  rotate(rotX = 0, rotY = undefined, rotZ = undefined) {
    rotX = +rotX;
    if (rotY === undefined && rotZ === undefined) return method(this, 'rotate', [0, 0, rotX]);
    return method(this, 'rotate', [rotX, rotY === undefined ? 0 : +rotY, rotZ === undefined ? 0 : +rotZ]);
  }
  rotateFromVector(x = 0, y = 0) {
    x = +x; y = +y;
    return method(this, 'rotate', [0, 0, x === 0 && y === 0 ? 0 : Math.atan2(y, x) * 180 / Math.PI]);
  }
  rotateAxisAngle(x = 0, y = 0, z = 0, angle = 0) { return method(this, 'rotateAxisAngle', [+x, +y, +z, +angle]); }
  skewX(sx = 0) { return method(this, 'skewX', [+sx]); }
  skewY(sy = 0) { return method(this, 'skewY', [+sy]); }
  multiply(other = undefined) {
    const o = matrixInit(other), s = own(this);
    return makeMatrix(DOMMatrix, globalThis.__dom.matrixMultiply(s.m, globalThis.Float64Array.from(o.m)), s.is2D && o.is2D);
  }
  flipX() { return method(this, 'flipX', []); }
  flipY() { return method(this, 'flipY', []); }
  inverse() { return method(this, 'inverse', []); }
  transformPoint(point = undefined) {
    return makePoint(DOMPoint, globalThis.Array.from(globalThis.__dom.matrixPoint(own(this).m, ...pointInit(point))));
  }
  toFloat32Array() { return new globalThis.Float32Array(own(this).m); }
  toFloat64Array() { return new globalThis.Float64Array(own(this).m); }
  toJSON() {
    const o = {};
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) o[k] = this[k];
    NAMES.forEach((k) => { o[k] = this[k]; });
    o.is2D = this.is2D;
    o.isIdentity = this.isIdentity;
    return o;
  }
  // The stringifier: `matrix(a, b, c, d, e, f)`, or `matrix3d(…)` of all sixteen — an InvalidStateError where one is
  // not finite.
  toString() {
    const {m, is2D} = own(this);
    if (!m.every(globalThis.isFinite)) throw new globalThis.DOMException('DOMMatrix: cannot serialize a non-finite matrix', 'InvalidStateError');
    return is2D ? `matrix(${[m[0], m[1], m[4], m[5], m[12], m[13]].join(', ')})` : `matrix3d(${m.join(', ')})`;
  }
}
NAMES.forEach((k, i) => globalThis.Object.defineProperty(DOMMatrixReadOnly.prototype, k, {
  get() { return own(this).m[i]; }, configurable: true, enumerable: true,
}));
for (const [k, i] of globalThis.Object.entries(ALIASES)) globalThis.Object.defineProperty(DOMMatrixReadOnly.prototype, k, {
  get() { return own(this).m[i]; }, configurable: true, enumerable: true,
});

export class DOMMatrix extends DOMMatrixReadOnly {
  static fromMatrix(other = undefined) { const c = matrixInit(other); return makeMatrix(DOMMatrix, c.m, c.is2D); }
  static fromFloat32Array(array32) { const c = float(array32, globalThis.Float32Array); return makeMatrix(DOMMatrix, c.m, c.is2D); }
  static fromFloat64Array(array64) { const c = float(array64, globalThis.Float64Array); return makeMatrix(DOMMatrix, c.m, c.is2D); }

  multiplySelf(other = undefined) { return becomes(this, this.multiply(other)); }
  preMultiplySelf(other = undefined) {
    const o = matrixInit(other), s = own(this);
    s.m = globalThis.__dom.matrixMultiply(globalThis.Float64Array.from(o.m), s.m);
    s.is2D = s.is2D && o.is2D;
    return this;
  }
  translateSelf(tx = 0, ty = 0, tz = 0) { return becomes(this, this.translate(tx, ty, tz)); }
  scaleSelf(scaleX = 1, scaleY = undefined, scaleZ = 1, originX = 0, originY = 0, originZ = 0) {
    return becomes(this, this.scale(scaleX, scaleY, scaleZ, originX, originY, originZ));
  }
  scale3dSelf(scale = 1, originX = 0, originY = 0, originZ = 0) { return becomes(this, this.scale3d(scale, originX, originY, originZ)); }
  rotateSelf(rotX = 0, rotY = undefined, rotZ = undefined) { return becomes(this, this.rotate(rotX, rotY, rotZ)); }
  rotateFromVectorSelf(x = 0, y = 0) { return becomes(this, this.rotateFromVector(x, y)); }
  rotateAxisAngleSelf(x = 0, y = 0, z = 0, angle = 0) { return becomes(this, this.rotateAxisAngle(x, y, z, angle)); }
  skewXSelf(sx = 0) { return becomes(this, this.skewX(sx)); }
  skewYSelf(sy = 0) { return becomes(this, this.skewY(sy)); }
  invertSelf() { return becomes(this, this.inverse()); }
  setMatrixValue(transformList) {
    const c = fromString(transformList);
    const s = own(this);
    s.m = globalThis.Float64Array.from(c.m);
    s.is2D = c.is2D;
    return this;
  }
}
// A mutating method's end: `self` takes the state of the matrix the non-mutating one made.
function becomes(self, other) {
  const s = own(self), o = own(other);
  s.m = o.m;
  s.is2D = o.is2D;
  return self;
}
// Setting an entry that is 0 (or 1) in every 2D matrix to anything else makes the matrix 3D.
NAMES.forEach((k, i) => globalThis.Object.defineProperty(DOMMatrix.prototype, k, {
  get() { return own(this).m[i]; },
  set(v) {
    const s = own(this);
    s.m[i] = +v;
    if ((ZERO_IN_2D.includes(i) && s.m[i] !== 0) || (ONE_IN_2D.includes(i) && s.m[i] !== 1)) s.is2D = false;
  },
  configurable: true, enumerable: true,
}));
for (const [k, i] of globalThis.Object.entries(ALIASES)) globalThis.Object.defineProperty(DOMMatrix.prototype, k, {
  get() { return own(this).m[i]; }, set(v) { own(this).m[i] = +v; }, configurable: true, enumerable: true,
});

// ── structured clone (each is serializable) ──
// A geometry object's copy in this realm, by its brand and read off its slot (not its getters, which a page can
// shadow); undefined for anything else.
// A geometry object's copy in this realm, by its brand — read off its state, not its getters (which a page can
// shadow); another realm's (an iframe's, posted) off its attributes. Undefined for anything else.
export function cloneGeometry(v, tag) {
  const state = STATES.get(v);
  const point = (p) => (STATES.has(p) ? STATES.get(p).slice() : [p.x, p.y, p.z, p.w]);
  switch (tag) {
    case '[object DOMPointReadOnly]': return makePoint(DOMPointReadOnly, point(v));
    case '[object DOMPoint]': return makePoint(DOMPoint, point(v));
    case '[object DOMRectReadOnly]': return makeRect(DOMRectReadOnly, state ? state.slice() : [v.x, v.y, v.width, v.height]);
    case '[object DOMRect]': return makeRect(DOMRect, state ? state.slice() : [v.x, v.y, v.width, v.height]);
    case '[object DOMQuad]': return makeQuad((state || [v.p1, v.p2, v.p3, v.p4]).map(point));
    // (…a 2D one serialized as its six entries, so the others come back the 2D matrix's own +0 and 1)
    case '[object DOMMatrixReadOnly]':
    case '[object DOMMatrix]': {
      const m = state ? state.m : NAMES.map((k) => v[k]), is2D = state ? state.is2D : v.is2D;
      const c = is2D ? fromSequence([m[0], m[1], m[4], m[5], m[12], m[13]]) : {m, is2D: false};
      return makeMatrix(tag === '[object DOMMatrix]' ? DOMMatrix : DOMMatrixReadOnly, c.m, c.is2D);
    }
    // (…a DOMRectList is not serializable)
    case '[object DOMRectList]': throw new globalThis.DOMException('A DOMRectList could not be cloned.', 'DataCloneError');
    default: return undefined;
  }
}

for (const cls of [DOMPointReadOnly, DOMPoint, DOMRectReadOnly, DOMRect, DOMRectList, DOMQuad, DOMMatrixReadOnly, DOMMatrix]) {
  globalThis.Object.defineProperty(cls.prototype, globalThis.Symbol.toStringTag, {value: cls.name, configurable: true});
  globalThis.Object.defineProperty(globalThis, cls.name, {value: cls, writable: true, enumerable: false, configurable: true});
}
// DOMMatrix's legacy window aliases (§6: `[LegacyWindowAlias=(SVGMatrix, WebKitCSSMatrix)]`), which a worker's scope
// drops (workers.js).
for (const alias of ['SVGMatrix', 'WebKitCSSMatrix']) {
  globalThis.Object.defineProperty(globalThis, alias, {value: DOMMatrix, writable: true, enumerable: false, configurable: true});
}
