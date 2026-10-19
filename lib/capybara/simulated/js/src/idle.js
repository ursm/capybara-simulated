// requestIdleCallback (Cooperative Scheduling of Background Tasks §5): the window's idle request callbacks are the
// engine's (timers.rs `idle*`) — requested, cancelled, made runnable as an idle period begins and taken as it runs them,
// which the event loop does as a step has nothing due (timers.js `runIdlePeriod`) — and IdleDeadline, generated from its
// IDL, the deadline a callback is handed.

import { installIdleDeadline } from './generated/bindings.js';
import { setIdleInvoke } from './timers.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';

registerInterface('IdleDeadline', (o) => slotsOf(o, 'IdleDeadline') !== undefined);
class IdleDeadline {
  // (…its realm's engine with it: `timeRemaining` reads the idle period and the clock of the realm it was made in,
  // whichever realm's method is called on it — a frame's `IdleDeadline.prototype.timeRemaining` on the window's deadline)
  constructor(token, didTimeout) {
    constructedBy(PLATFORM, token, 'IdleDeadline');
    makeSlots(this, 'IdleDeadline', { didTimeout, dom: globalThis.__dom });
  }
}
installIdleDeadline(IdleDeadline, {
  // §5.1: what is left of the idle period — none for a callback its timeout ran, nor once the deadline passed.
  timeRemaining(deadline) {
    const s = slotsOf(deadline, 'IdleDeadline');
    if (s.didTimeout) return 0;
    return s.dom.idleRemaining();
  },
  get_didTimeout: (deadline) => slotsOf(deadline, 'IdleDeadline').didTimeout
});
globalThis.IdleDeadline = IdleDeadline;

// §5.2: the callback appended to the window's list, and with a timeout a task queued to run it that long after, its
// deadline timed out, if no idle period has by then.
export const requestIdleCallback = (callback, options) =>
  globalThis.__dom.idleAdd(callback, options.timeout ?? 0, timedOut);
export function cancelIdleCallback(handle) {
  globalThis.__dom.idleTake(handle);
}
// §5.6 "invoke idle callback timeout algorithm".
function timedOut(handle) {
  const callback = globalThis.__dom.idleTake(handle);
  if (callback !== undefined) invoke(callback, true);
}
// The callback invoked with its deadline, what it throws reported (Web IDL "invoke a callback function").
function invoke(callback, didTimeout) {
  try {
    callback.call(undefined, new IdleDeadline(PLATFORM, didTimeout));
  } catch (e) {
    globalThis.__csimReportCallbackError(callback, e);
  }
}
setIdleInvoke(invoke);
