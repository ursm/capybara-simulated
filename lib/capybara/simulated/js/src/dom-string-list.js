// DOMStringList (HTML §2.6.4), generated from its IDL: a fixed list of strings — an IndexedDB database's or
// transaction's object store names, an object store's index names — its indices the Proxy its binding makes.

import { defineDOMStringList } from './generated/bindings.js';

const binding = defineDOMStringList({
  init(s, strings) { s.strings = strings; },
  get_length: (s) => s.strings.length,
  item: (s, index) => (index < s.strings.length ? s.strings[index] : null),
  contains: (s, string) => s.strings.includes(string)
});
globalThis.DOMStringList = binding.interface;

// A DOMStringList of `strings`, which nothing changes after.
export const domStringList = (strings) => binding.create(strings);
