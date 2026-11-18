// What the engine's shared registries owe this realm (agents.rs): the notices its agent is told — IndexedDB's
// (idb.js) and Web Locks' (locks.js) — taken after each of their own calls and as each step of its event loop begins,
// and handed to the registry each names by its kind's range.
import { hostTask, setAgentPoll } from './timers.js';
import { dom, hostObject, hostSteps, newList } from './engine.js';

// The handlers, each `[first kind, last kind, handle(kind, later, a, b, c, d)]` — lists of no prototype, walked by index:
// a page's Array.prototype method or iterator is handed none of them, nor the handlers they hold.
const handlers = newList();
// This realm an agent of the session's — as a binding first uses a registry, and again at each later use: a realm whose
// page the engine began anew dropped the agent it was (`agentJoin` makes one only where there is none) — and `handle` the
// one its notices of kinds `first` to `last` go to.
export function joinAgent(first, last, handle) {
  dom.agentJoin(hostObject.sessionPartition());
  for (let i = 0; i < handlers.length; i++) if (handlers[i][2] === handle) return;
  if (handlers.length === 0) setAgentPoll(deliver);
  const entry = newList();
  entry[0] = first;
  entry[1] = last;
  entry[2] = handle;
  handlers[handlers.length] = entry;
}
// (…for the host: whether a realm of this isolate has notices to take, and this realm's taken — a task of its own)
hostSteps.agentsPending = () => dom.agentsPending();
hostSteps.agentDeliver = hostTask(() => deliver());

// The notices taken, in order — each its kind, whether it is a task of its own, and four numbers. One taken while
// another's handler runs (its listeners) waits for it, but one that is a task of its own, which it only queues.
let inbox = newList();
let delivering = false;
const take = (flat) => {
  if (flat !== null) for (let i = 0; i < flat.length; i++) inbox[inbox.length] = flat[i];
};
// …the notice at `at` taken out of the inbox and handed on
function noticeAt(at) {
  const n = inbox;
  const kind = n[at], later = n[at + 1], a = n[at + 2], b = n[at + 3], c = n[at + 4], d = n[at + 5];
  const rest = newList();
  for (let i = 0; i < n.length; i++) if (i < at || i >= at + 6) rest[rest.length] = n[i];
  inbox = rest;
  notice(kind, later, a, b, c, d);
}
export function deliver() {
  if (handlers.length === 0) return;
  take(dom.agentTake());
  if (delivering) {
    for (let i = 0; i < inbox.length;) {
      if (inbox[i + 1]) noticeAt(i);
      else i += 6;
    }
    return;
  }
  delivering = true;
  try {
    while (inbox.length) {
      noticeAt(0);
      take(dom.agentTake());
    }
  } finally {
    delivering = false;
  }
}
function notice(kind, later, a, b, c, d) {
  for (let i = 0; i < handlers.length; i++) {
    const h = handlers[i];
    if (kind >= h[0] && kind <= h[1]) return h[2](kind, later, a, b, c, d);
  }
}
