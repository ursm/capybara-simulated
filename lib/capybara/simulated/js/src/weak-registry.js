// A registry the platform walks on every mutation — the live NodeIterators — holding its members WEAKLY: an iterator a
// script dropped needs no updating, and a strong set kept every one ever made alive for the page's life, each walked on
// every removal (the live ranges' did so: an Avo suite climbed 241 million parent edges).

export class WeakRegistry {
  constructor() {
    this.refs = new Set();
    this.ref  = new WeakMap();   // member → its WeakRef, so it can leave
  }
  get size() { return this.refs.size; }
  add(member) {
    let r = this.ref.get(member);
    if (!r) this.ref.set(member, (r = new WeakRef(member)));
    this.refs.add(r);
  }
  delete(member) {
    const r = this.ref.get(member);
    if (r) this.refs.delete(r);
  }
  // `fn(member, a, b, c, d, e)` for every member still alive (one collected leaves the registry here) — the arguments
  // passed through, so a walk on every mutation needs no closure over them.
  forEach(fn, a, b, c, d, e) {
    for (const r of this.refs) {
      const member = r.deref();
      if (member === undefined) this.refs.delete(r);
      else fn(member, a, b, c, d, e);
    }
  }
}
