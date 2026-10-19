// Web Locks (navigator.locks): LockManager and Lock, generated from their IDL. The lock managers are the engine's
// (web_locks.rs) — one per storage bucket, shared by every realm and worker of an origin in the session — and this
// realm an agent of theirs (agents.rs): what a manager grants or steals for another agent's call comes as a notice,
// a task of its own. Here are what a request's caller holds: its callback, the promise `request` returned and the
// promise the callback's answer settles, which releases the lock.

import { addAbortAlgorithm, removeAbortAlgorithm, DOMException } from './events.js';
import { signalOf } from './abort.js';
import { deliver, joinAgent } from './engine-notices.js';
import { installLock, installLockManager } from './generated/bindings.js';
import { clientId } from './sw-client.js';
import { queueTask } from './timers.js';
import {
  IntrinsicPromise,
  PLATFORM,
  constructedBy,
  makeSlots,
  promiseResolvedWith,
  promiseThen,
  registerInterface,
  rejectedPromise,
  slotsOf
} from './webidl.js';

const GRANTED = 16, STOLEN = 17;
const QUEUED = 0, IF_AVAILABLE = 1, STEAL = 2;

// This realm's requests, by the manager's number for each: `{ name, mode, callback, resolve, reject, signal, aborted,
// called, stolen }` — a granted one's until its lock is released.
const requests = new Map();

registerInterface('Lock', (o) => slotsOf(o, 'Lock') !== undefined);
class Lock {
  constructor(token, name, mode) {
    constructedBy(PLATFORM, token, 'Lock');
    makeSlots(this, 'Lock', { name, mode });
  }
}
installLock(Lock, {
  get_name: (lock) => slotsOf(lock, 'Lock').name,
  get_mode: (lock) => slotsOf(lock, 'Lock').mode
});

registerInterface('LockManager', (o) => slotsOf(o, 'LockManager') !== undefined);
class LockManager {
  constructor(token) {
    constructedBy(PLATFORM, token, 'LockManager');
    makeSlots(this, 'LockManager', {});
  }
}

const error = (name, message) => new DOMException(message, name);
// "Obtain a lock manager": none for an opaque origin (a sandboxed frame's, a data: worker's) — a SecurityError — and none
// for a document no longer fully active, whose `request` and `query` are an InvalidStateError before anything else.
function storageKey() {
  if (globalThis.__csimDocumentInactive === true) throw error('InvalidStateError', 'The document is not fully active.');
  const key = String(globalThis.__csimBcOriginKey());
  if (key.startsWith('opaque:')) throw error('SecurityError', 'Access to the Locks API is denied in this context.');
  joinAgent(GRANTED, STOLEN, notice);
  return key;
}

// §3.5 "request a lock", from the checks of `request()` (§4.1) on: the manager queues it, or answers that it is not
// available, or steals for it; its callback runs as it is granted.
function request(name, options, callback) {
  return new IntrinsicPromise((resolve, reject) => {
    const key = storageKey();
    const { mode, ifAvailable, steal, signal } = options;
    if (name.startsWith('-')) throw error('NotSupportedError', "Names starting with '-' are reserved.");
    if (steal && ifAvailable) throw error('NotSupportedError', "The 'steal' and 'ifAvailable' options cannot be used together.");
    if (steal && mode !== 'exclusive') throw error('NotSupportedError', "The 'steal' option may only be used with 'exclusive' locks.");
    if (signal !== undefined && (steal || ifAvailable)) {
      throw error('NotSupportedError', "The 'signal' option cannot be used with 'steal' or 'ifAvailable'.");
    }
    if (signal !== undefined && signalOf(signal).aborted) throw signalOf(signal).reason;
    const id = globalThis.__dom.locksRequest(key, name, mode === 'exclusive', steal ? STEAL : ifAvailable ? IF_AVAILABLE : QUEUED, clientId());
    if (id === null) {
      // (…not available: the callback called with null, a task later, and the promise resolved with its answer)
      queueTask(() => promiseThen.call(answer(callback, null), resolve, reject));
      return;
    }
    const r = { name, mode, callback, resolve, reject, signal, aborted: null, called: false, stolen: false };
    requests.set(id, r);
    // §3.8 "abort the request": out of its queue and the promise rejected — and a request granted whose callback is yet
    // to be called (its task queued) is aborted all the same, its lock let go (`signal.https.any.js`: "this abort should
    // be processed synchronously" though the lock was grantable). Once the callback runs, an abort is nothing to it.
    if (signal !== undefined) {
      r.aborted = () => {
        if (requests.get(id) !== r || r.called) return;
        if (!globalThis.__dom.locksAbort(id)) globalThis.__dom.locksRelease(id);
        requests.delete(id);
        reject(signalOf(signal).reason);
        deliver();
      };
      addAbortAlgorithm(signal, r.aborted);
    }
    deliver();
  });
}
// The callback invoked (Web IDL "invoke a callback function"): its answer, as a promise — what it threw a rejection.
function answer(callback, lock) {
  let r;
  try {
    r = callback.call(undefined, lock);
  } catch (e) {
    return rejectedPromise(e);
  }
  return promiseResolvedWith(r);
}
function notice(kind, later, id) {
  const r = requests.get(id);
  if (r === undefined) return;
  switch (kind) {
    case GRANTED:
      // §3.6: the callback called with the Lock, a task of its own; as the promise it answered settles the lock is
      // released and the promise `request` returned settles as it did — unless it was stolen meanwhile.
      queueTask(() => {
        if (requests.get(id) !== r) return;
        r.called = true;
        // (…§4.4: the abort algorithm removed from its signal as the callback is invoked)
        if (r.aborted !== null) removeAbortAlgorithm(r.signal, r.aborted);
        const waiting = answer(r.callback, new Lock(PLATFORM, r.name, r.mode));
        const settled = (ok) => (v) => {
          requests.delete(id);
          if (globalThis.__dom.locksRelease(id)) deliver();
          if (!r.stolen) (ok ? r.resolve : r.reject)(v);
        };
        promiseThen.call(waiting, settled(true), settled(false));
      });
      break;
    case STOLEN:
      // (…its holder's promise rejected at once: an AbortError — the lock is the thief's)
      queueTask(() => {
        r.stolen = true;
        r.reject(error('AbortError', 'The lock request was aborted.'));
      });
      break;
  }
}

installLockManager(LockManager, {
  request_name_callback: (_, name, callback) => request(name, LOCK_OPTION_DEFAULTS, callback),
  request_name_options_callback: (_, name, options, callback) => request(name, options, callback),
  // §4.2 "query": the manager's held locks and pending requests, a task later.
  query: () => new IntrinsicPromise((resolve) => {
    const key = storageKey();
    const flat = globalThis.__dom.locksQuery(key);
    const info = (at) => ({ name: flat[at], mode: flat[at + 1] ? 'exclusive' : 'shared', clientId: flat[at + 2] });
    const held = [], pending = [];
    for (let at = 1, n = 0; at < flat.length; at += 3, n++) (n < flat[0] ? held : pending).push(info(at));
    queueTask(() => resolve({ held, pending }));
  })
});
const LOCK_OPTION_DEFAULTS = Object.freeze({ mode: 'exclusive', ifAvailable: false, steal: false, signal: undefined });

globalThis.Lock = Lock;
globalThis.LockManager = LockManager;
// NavigatorLocks' `locks`: this realm's manager object — a window's Navigator and a worker's WorkerNavigator alike.
let manager = null;
export const lockManager = () => (manager ??= new LockManager(PLATFORM));
