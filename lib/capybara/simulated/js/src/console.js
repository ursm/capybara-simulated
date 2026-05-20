// `console.{log,info,warn,error,debug}` → Ruby `log_console` host fn.
//
// Tracing is gated behind `__csim_traceActive` (Ruby flips this from
// `start_trace` / `clear_trace!`). When false, the wrapper short-
// circuits before doing any formatting work — Stimulus-heavy apps
// emit `console.debug` on every controller connect, and the V8 → Ruby
// round-trip is ~6μs per call. The fast-path return matters: without
// the gate the cost compounded across the find/dispatch hot path.

function consoleFmt(v, seen) {
  if (v && typeof v === 'object') {
    if (v instanceof Error) return v.stack || (v.name + ': ' + v.message);
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  }
  return v;
}

// Primitive-only fast path: most app logs are strings / numbers,
// skip the WeakSet + arg-array allocation when there's no object.
function consoleJoin(args) {
  let needsFormat = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a !== null && typeof a === 'object') { needsFormat = true; break; }
  }
  if (!needsFormat) return Array.prototype.join.call(args, ' ');
  const seen = new WeakSet();
  const out  = new Array(args.length);
  for (let i = 0; i < args.length; i++) out[i] = consoleFmt(args[i], seen);
  return out.join(' ');
}

// Module-local cache so the hot path skips a `globalThis` property
// load on every `console.debug`. `globalThis.__csim_traceActive` is
// kept in sync as a debug-inspectable mirror.
let traceActive = false;

const makeConsoleFn = (level) => function () {
  if (!traceActive) return undefined;
  try { globalThis.__csim_logConsole(level, consoleJoin(arguments)); } catch (_) {}
  return undefined;
};

globalThis.__csim_traceActive   = false;
globalThis.__csimSetTraceActive = function (v) {
  traceActive = !!v;
  globalThis.__csim_traceActive = traceActive;
};

globalThis.console = {
  log:   makeConsoleFn('log'),
  info:  makeConsoleFn('info'),
  warn:  makeConsoleFn('warn'),
  error: makeConsoleFn('error'),
  debug: makeConsoleFn('debug')
};

// Shared `[csim] <label> threw:` log helper — every module that
// catches inside a try/catch around app callbacks (timers, MO
// callbacks, event listeners, IO callbacks, …) uses this shape.
// Centralising standardises whether to log `.stack` vs `.message`
// (we prefer stack for diagnostics, fall back to message).
export function logThrew(label, e) {
  try {
    const detail = e && (e.stack || e.message) || String(e);
    console.error('[csim] ' + label + ' threw:', detail);
  } catch (_) {}
}
