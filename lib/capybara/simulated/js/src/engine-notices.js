// What the engine's shared registries owe this realm (agents.rs): the notices its agent is told — IndexedDB's
// (idb.js) and Web Locks' (locks.js) — taken after each of their own calls and as each step of its event loop begins,
// and handed to the registry each names by its kind's range.
import { hostTask, setAgentPoll } from './timers.js';

// The handlers, each `[first kind, last kind, handle(kind, later, a, b, c, d)]`.
const handlers = [];
// This realm an agent of the session's — as a binding first uses a registry, and again at each later use: a realm whose
// page the engine began anew dropped the agent it was (`agentJoin` makes one only where there is none) — and `handle` the
// one its notices of kinds `first` to `last` go to.
export function joinAgent(first, last, handle) {
  globalThis.__dom.agentJoin(globalThis.__csimSessionPartition());
  if (handlers.some((h) => h[2] === handle)) return;
  if (handlers.length === 0) setAgentPoll(deliver);
  handlers.push([first, last, handle]);
}
// (…for the host: whether a realm of this isolate has notices to take, and this realm's taken — a task of its own)
globalThis.__csimAgentsPending = () => globalThis.__dom.agentsPending();
globalThis.__csimAgentDeliver = hostTask(() => deliver());
globalThis.__csimAgentsDrop = () => globalThis.__dom.agentsDrop();

// The notices taken, in order — each its kind, whether it is a task of its own, and four numbers. One taken while
// another's handler runs (its listeners) waits for it, but one that is a task of its own, which it only queues.
const inbox = [];
let delivering = false;
export function deliver() {
  if (handlers.length === 0) return;
  const flat = globalThis.__dom.agentTake();
  if (flat !== null) inbox.push(...flat);
  if (delivering) {
    for (let i = 0; i < inbox.length;) {
      if (inbox[i + 1]) notice(...inbox.splice(i, 6));
      else i += 6;
    }
    return;
  }
  delivering = true;
  try {
    while (inbox.length) {
      notice(...inbox.splice(0, 6));
      const more = globalThis.__dom.agentTake();
      if (more !== null) inbox.push(...more);
    }
  } finally {
    delivering = false;
  }
}
function notice(kind, later, a, b, c, d) {
  for (const [first, last, handle] of handlers) {
    if (kind >= first && kind <= last) return handle(kind, later, a, b, c, d);
  }
}
