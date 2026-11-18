// An empty list for the vendored code to grow: an Array whose prototype is one of its own — %Array.prototype%'s methods,
// as they were when the bundle loaded, before any page ran — and not %Array.prototype% itself, whose index a page may
// give a setter: an element `push`ed, or written, meets nothing of the page's, and is handed it as no argument
// (build_vendor.mjs puts it in place of each empty array literal of web-streams-polyfill's, whose queues are such lists).
// What a method of it makes (`map`, `slice`, `filter`) is another such list, and what iterates one (`Promise.all` over
// a pipe's abort actions) walks it with an iterator of its own, not %ArrayIteratorPrototype%'s `next`, which a page may
// replace.
const arrayPrototype = Array.prototype, setPrototypeOf = Object.setPrototypeOf;
const LIST_PROTOTYPE = Object.create(null);
for (const key of Reflect.ownKeys(arrayPrototype)) {
  if (key !== 'constructor' && typeof arrayPrototype[key] === 'function') LIST_PROTOTYPE[key] = arrayPrototype[key];
}
export const internalList = () => setPrototypeOf([], LIST_PROTOTYPE);
// (…the species `ArraySpeciesCreate` finds through the `constructor` it reads: a constructor of a list `length` long)
function InternalList(length) {
  return setPrototypeOf(new Array(length), LIST_PROTOTYPE);
}
LIST_PROTOTYPE.constructor = setPrototypeOf({ [Symbol.species]: InternalList }, null);
LIST_PROTOTYPE[Symbol.iterator] = function () {
  const list = this;
  let i = 0;
  return setPrototypeOf({
    next: () => (i < list.length ? { value: list[i++], done: false } : { value: undefined, done: true }),
    [Symbol.iterator]() { return this; }
  }, null);
};
