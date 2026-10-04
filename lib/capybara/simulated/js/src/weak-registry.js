// A registry the platform walks on every mutation — a document's live ranges, the live NodeIterators — holding its
// members WEAKLY: a range or an iterator a script dropped needs no updating, and a strong set kept every one ever made
// alive for the page's life, each walked on every removal (an Avo suite climbed 241 million parent edges doing so).

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
  // `fn(member)` for every member still alive (one collected leaves the registry here).
  forEach(fn) {
    for (const r of this.refs) {
      const member = r.deref();
      if (member === undefined) this.refs.delete(r);
      else fn(member);
    }
  }
  // The members still alive, in a list of their own (for a walk that changes the registry as it goes).
  live() {
    const out = [];
    this.forEach((m) => out.push(m));
    return out;
  }
}
