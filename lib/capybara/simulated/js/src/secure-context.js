// [SecureContext] (Web IDL "exposed"): a realm whose environment is no secure context has none of the constructs
// so marked — no interface object on its global, no member on the prototype or the global that has it: absent, not a getter
// answering undefined (`'serviceWorker' in navigator` is false). The realm's snapshot has them all, as a page in a secure
// context — the common one — wants them; another's takes them away as its document begins (bridge.entry.js), and a worker's
// as its scope is made (worker-globals.js).
//
// A realm is decided as its document commits, but one kept for the next document — an initial about:blank's, whose Window a
// navigation to its origin keeps (`reuse_window_realm`, `reuse_frame_realm`) — is decided again: what it took away it holds,
// to put back should the document's environment be a secure one, as the next document's may be where its about:blank's
// wasn't (its top-level creation URL is no longer its creator's: navigables.rs `secure_context`).

import { SECURE_CONTEXT_INTERFACES, SECURE_CONTEXT_MEMBERS } from './generated/bindings.js';
import { isSecure } from './platform-globals.js';
import { listPush, newList, protoless } from './engine.js';
import { objectKeys } from './intrinsics.js';

const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor, defineProperty = Object.defineProperty, deleteProperty = Reflect.deleteProperty;

// (…each object they are on, as the bundle made it, before a page has `Navigator` be anything else; a Window's own members
// its global's, as a [Global] interface's are, a worker's global scope's its interface's prototype: worker-globals.js)
function holdersNow() {
  const holders = [[globalThis, SECURE_CONTEXT_INTERFACES]];
  for (let i = 0, list = objectKeys(SECURE_CONTEXT_MEMBERS); i < list.length; i++) {
    const name = list[i];
    const holder = name === 'Window' ? globalThis : globalThis[name]?.prototype;
    if (holder) listPush(holders, [holder, SECURE_CONTEXT_MEMBERS[name]]);
  }
  return holders;
}
let holders = null;
export function captureSecureContextHolders() {
  holders = holdersNow();
}

// What was taken, [holder, name, descriptor] each; null while the constructs are there.
let withheld = null;
function withhold(from) {
  withheld = newList();
  for (let i = 0; i < from.length; i++) {
    const pair = from[i], holder = pair[0], names = pair[1];
    for (let j = 0; j < names.length; j++) {
      const descriptor = getOwnPropertyDescriptor(holder, names[j]);
      if (descriptor === undefined) continue;
      withheld[withheld.length] = [holder, names[j], protoless(descriptor)];
      deleteProperty(holder, names[j]);
    }
  }
}
function restore() {
  for (let i = 0; i < withheld.length; i++) defineProperty(withheld[i][0], withheld[i][1], withheld[i][2]);
  withheld = null;
}

// A document's realm, as the document's environment is a secure context or not.
export function exposeSecureContextConstructs() {
  const secure = isSecure();
  if (secure === (withheld === null)) return;
  if (secure) restore();
  else withhold(holders);
}
// …and a worker's, as its scope is made: decided once, a worker's global being its alone.
export function withholdSecureContextConstructs() {
  withhold(holdersNow());
}
