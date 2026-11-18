// An empty list for the vendored code to grow: an Array whose prototype is one of its own — %Array.prototype%'s methods,
// as they were when the bundle loaded, before any page ran — and not %Array.prototype% itself, whose index a page may
// give a setter: an element `push`ed, or written, meets nothing of the page's, and is handed it as no argument
// (build_vendor.mjs puts it in place of each empty array literal of web-streams-polyfill's, whose queues are such lists).
const arrayPrototype = Array.prototype, setPrototypeOf = Object.setPrototypeOf;
const LIST_PROTOTYPE = Object.create(null);
for (const key of Reflect.ownKeys(arrayPrototype)) {
  if (key !== 'constructor' && typeof arrayPrototype[key] === 'function') LIST_PROTOTYPE[key] = arrayPrototype[key];
}
export const internalList = () => setPrototypeOf([], LIST_PROTOTYPE);
