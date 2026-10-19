// The performance timeline (High Resolution Time, Performance Timeline, User Timing, Resource Timing, Server Timing),
// generated from their IDL: the realm's `Performance` — its clock, mark / measure — the entries it records and the
// PerformanceObservers they are queued on, their state in slots; its entry buffers, its ids and its registered
// observers are the engine's (perf_timeline.rs), which names the entries and observers it holds by number, the objects
// kept here.
import { logThrew } from './console.js';
import { Event, EventTarget, installEventHandlerAttrs } from './events.js';
import { fireEvent } from './dispatch.js';
import { utf8Length } from './bytes.js';
import { responseHeader } from './header-rules.js';
import { cloneFor, documentOrigin } from './platform-globals.js';
import { platformDateNow } from './timers.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';
import {
  convertPerformanceMarkArguments,
  convertPerformanceObserverArguments,
  installPerformance,
  installPerformanceEntry,
  installPerformanceMark,
  installPerformanceMeasure,
  installPerformanceObserver,
  installPerformanceObserverEntryList,
  installPerformanceResourceTiming,
  installPerformanceServerTiming
} from './generated/bindings.js';
import { DOMException } from './dom-exception.js';

// `performance.now()` returns ms since the runtime started, measured on the SAME clock as
// `Date.now()` — so it advances with the virtual clock (`virtualNow`), not wall time. In this
// synchronous in-process environment "real elapsed wall time" between two reads is ~0, so the
// virtual clock is the only meaningful timeline; sharing it keeps `performance.now()` deltas
// (e.g. an rAF callback's timestamp) consistent with `Date.now()` and on real frame cadence.
//
// It is therefore INTEGER milliseconds, which is a real conformance gap: a DOMHighResTimeStamp
// is a sub-millisecond double, so app code computing a frame delta or an FPS reads 0. The
// obvious fix — a host monotonic clock — was built and REVERTED: `performance.now()` is called
// from `Event`'s constructor, so it runs at arbitrary points inside dispatch, and a JS→Ruby
// host call from there wedges the driver (`xhr/open-url-multi-window-4.htm` went from PASS to
// TIMEOUT; bisected to the CALL, not the value — the same test passes with fractional
// monotonic values produced without one). Any retry must push the clock the other way: Ruby
// hands the realm a monotonic base at a step boundary (`__runLoopStep`), the way
// `__csimSetTimeTravelOffsetMs` is pushed, and `now()` reads that. See the
// `performance_now_resolution` note.
//
// The time origin. Captured at module scope — which is WRONG, and the bug is bigger than it
// looks: this bundle is evaluated while the V8 SNAPSHOT is BUILT, the blob is cached on disk and
// replayed by `rebuild_ctx` on every visit, so this is the moment the bundle was last COMPILED.
// Measured 2026-08-20: a freshly-visited page reported `performance.now() === 2312947` and a
// `navigationStart` 38 minutes in the past, growing by ~86.4M ms for every day `js/src/` went
// untouched.
//
// A fix was attempted and withdrawn — stamping the origin per navigation is right, but WHERE is
// not obvious and both candidates regressed the gate: `__csimBootContext` misses navigations (a
// full-suite run measured 212,335 ms of residual skew where an isolated one showed 2 ms), and the
// `readyState = 'loading'` transition in `__csimLoadDocument` made `hr-time/timeOrigin.html`
// fail an identity that should hold by construction (`timeOrigin + now() === Date.now()`) — by
// 31.6 s, with the origin verifiably stamped only ONCE, which the current model does not explain.
// Getting this right needs the virtual-clock model in hand, not another guess at a call site.
// See the `performance_now_resolution` note.
const perfStart = platformDateNow();
const perfNow = () => platformDateNow() - perfStart;

// The driver's own reads of the clock (an event's timeStamp, a fetch's start), which no page's replacement of
// `performance` or `Performance.prototype.now` reaches.
globalThis.__csimPerformanceNow = perfNow;

// ── PerformanceEntry and the entry interfaces ──
// An entry's slots: its name, type, start time and duration, set when it is made, and its id and navigation id, when it
// is queued (0 until then: a `new PerformanceMark` is never queued); a mark's and a measure's detail, a resource's fields
// (see `recordResourceTiming`), each in its own interface's slots.
const entryOf = (o) => slotsOf(o, 'PerformanceEntry');
registerInterface('PerformanceEntry', (o) => entryOf(o) !== undefined);
export class PerformanceEntry {
  constructor(token, name, entryType, startTime, duration) {
    constructedBy(PLATFORM, token, 'PerformanceEntry');
    makeSlots(this, 'PerformanceEntry', { name, entryType, startTime, duration, id: 0, navigationId: 0 });
  }
}
installPerformanceEntry(PerformanceEntry, {
  get_id: (e) => entryOf(e).id,
  get_name: (e) => entryOf(e).name,
  get_entryType: (e) => entryOf(e).entryType,
  get_startTime: (e) => entryOf(e).startTime,
  get_duration: (e) => entryOf(e).duration,
  get_navigationId: (e) => entryOf(e).navigationId
});

// A detail, structured-cloned into this realm — a DataCloneError in the words of the operation it was handed to — or
// null for none.
const cloneDetail = (detail, prefix) => (detail == null ? null : cloneFor(prefix, detail));

// The PerformanceMark constructor (User Timing §2.2.1): no PerformanceTiming name in a Window, no negative start time,
// the start time now otherwise, and its detail cloned — or, made by the platform (mark()), what `createMark` made.
const markOf = (o) => slotsOf(o, 'PerformanceMark');
registerInterface('PerformanceMark', (o) => markOf(o) !== undefined);
export class PerformanceMark extends PerformanceEntry {
  constructor(markName, markOptions) {
    const made = markName === PLATFORM ? markOptions
      : createMark(timeline, ...convertPerformanceMarkArguments(arguments), "Failed to construct 'PerformanceMark': ");
    super(PLATFORM, made.name, 'mark', made.startTime, 0);
    makeSlots(this, 'PerformanceMark', { detail: made.detail });
  }
}
function createMark(t, name, options, prefix) {
  // (…a PerformanceTiming attribute's name the engine's to know: perf_timeline.rs `PERFORMANCE_TIMING_NAMES`)
  if (t.global.document && t.global.__dom.perfTimingName(name)) {
    throw new DOMException(`${prefix}'${name}' is part of the PerformanceTiming interface, and cannot be used as a mark name.`, 'SyntaxError');
  }
  if (options.startTime !== undefined && options.startTime < 0) {
    throw new TypeError(`${prefix}'${name}' cannot have a negative start time.`);
  }
  const startTime = options.startTime !== undefined ? options.startTime : t.now();
  return { name, startTime, detail: cloneDetail(options.detail, prefix) };
}
installPerformanceMark(PerformanceMark, { get_detail: (m) => markOf(m).detail });

const measureOf = (o) => slotsOf(o, 'PerformanceMeasure');
registerInterface('PerformanceMeasure', (o) => measureOf(o) !== undefined);
export class PerformanceMeasure extends PerformanceEntry {
  constructor(token, name, startTime, duration, detail) {
    constructedBy(PLATFORM, token, 'PerformanceMeasure');
    super(PLATFORM, name, 'measure', startTime, duration);
    makeSlots(this, 'PerformanceMeasure', { detail });
  }
}
installPerformanceMeasure(PerformanceMeasure, { get_detail: (m) => measureOf(m).detail });

registerInterface('PerformanceServerTiming', (o) => slotsOf(o, 'PerformanceServerTiming') !== undefined);
export class PerformanceServerTiming {
  constructor(token, name, duration, description) {
    constructedBy(PLATFORM, token, 'PerformanceServerTiming');
    makeSlots(this, 'PerformanceServerTiming', { name, duration, description });
  }
}
const serverTimingOf = (o) => slotsOf(o, 'PerformanceServerTiming');
installPerformanceServerTiming(PerformanceServerTiming, {
  get_name: (t) => serverTimingOf(t).name,
  get_duration: (t) => serverTimingOf(t).duration,
  get_description: (t) => serverTimingOf(t).description
});

// One fetched resource (Resource Timing Level 2). The driver's fetches are synchronous
// in-process Rack calls, so the network milestones are the fetch's start (a connection that
// exists already: DNS and connect take no time — CSS-Timing's "reused connection", every
// milestone equal to `fetchStart`) and its end; the sizes are the body's on the wire and
// decoded, `transferSize` the spec's body-plus-300 estimate, 0 for a fresh cache hit and the
// header estimate alone after a 304. A cross-origin response without a passing
// `Timing-Allow-Origin` exposes only `startTime` / `fetchStart` / `responseEnd` / `duration`
// (the timing-allow check), and an opaque one no status. No service worker routes a fetch: its router's milestones are
// 0, its sources empty.
const RESOURCE_TIMING_FIELDS = [
  'initiatorType', 'deliveryType', 'nextHopProtocol', 'workerStart', 'redirectStart', 'redirectEnd', 'fetchStart',
  'domainLookupStart', 'domainLookupEnd', 'connectStart', 'connectEnd', 'secureConnectionStart', 'requestStart',
  'finalResponseHeadersStart', 'firstInterimResponseStart', 'responseStart', 'responseEnd', 'workerRouterEvaluationStart',
  'workerCacheLookupStart', 'workerMatchedRouterSource', 'workerFinalRouterSource', 'transferSize', 'encodedBodySize',
  'decodedBodySize', 'responseStatus', 'renderBlockingStatus', 'contentType', 'contentEncoding', 'serverTiming'
];
const resourceOf = (o) => slotsOf(o, 'PerformanceResourceTiming');
registerInterface('PerformanceResourceTiming', (o) => resourceOf(o) !== undefined);
export class PerformanceResourceTiming extends PerformanceEntry {
  constructor(token, f) {
    constructedBy(PLATFORM, token, 'PerformanceResourceTiming');
    super(PLATFORM, f.name, 'resource', f.startTime, f.responseEnd - f.startTime);
    makeSlots(this, 'PerformanceResourceTiming', { f });
  }
}
installPerformanceResourceTiming(
  PerformanceResourceTiming,
  Object.fromEntries(RESOURCE_TIMING_FIELDS.map((k) => [`get_${k}`, (r) => resourceOf(r).f[k]]))
);

for (const [name, iface] of Object.entries({
  PerformanceEntry, PerformanceMark, PerformanceMeasure, PerformanceServerTiming, PerformanceResourceTiming
})) globalThis[name] = iface;

// ── the buffers ──
// A timeline's, the engine's (perf_timeline.rs): its marks and measures, and its resources in the spec's primary buffer
// with the secondary buffer that catches the overflow — each entry handed in with the facts it is filtered, ordered and
// looked up by, its slots' (which a page's `startTime` getter is none of), and kept here by the serial the engine gives
// it (`buffered`) until the engine lets it go. "Queue a PerformanceEntry" gives it its id and its document's most recent
// navigation's, and queues it on every observer of its type in the timeline's realm, buffer or no buffer (they are how a
// page reads a stream); what that leaves to queue, the realm's tasks.
const BUFFER_FULL_TASK = 1, OBSERVER_TASK = 2;
function recordEntry(t, entry) {
  const e = entryOf(entry);
  const [navigationId, id, tasks, serial, ...observers] = t.global.__dom.perfRecord(e.entryType, e.name, e.startTime, !!t.global.document);
  e.navigationId = navigationId;
  e.id = id;
  if (serial) t.buffered.set(serial, entry);
  for (const observer of observers) poOf(t.observers.get(observer)).queue.push(entry);
  if (tasks & OBSERVER_TASK) t.queueObserverTask();
  if (tasks & BUFFER_FULL_TASK) globalThis.__csimSetTimeout(() => fireResourceBufferFull(t), 0);
}
// The entries the engine answers with, by their serials; and those it let go of, no more kept.
const entriesOf = (t, serials) => serials.map((serial) => t.buffered.get(serial));
const letGo = (t, serials) => { for (const serial of serials) t.buffered.delete(serial); };
// "Fire a buffer full event": give the page a chance to make room (raise the size, clear the
// buffer) for each batch of excess entries, and drop what it leaves no room for.
function fireResourceBufferFull(t) {
  for (let count, room; ([count, room] = t.global.__dom.perfOverflow(), count > 0);) {
    if (!room) fireEvent(t.owner, new Event('resourcetimingbufferfull'));
    const dropped = t.global.__dom.perfCopyOverflow(count);
    if (dropped.length) { letGo(t, dropped); break; }
  }
}

// `desc`: { name, initiatorType, startTime, resp, renderBlocking, cached, encoded, decoded, status,
// headers, type } — `resp` a Rack response hash (status / headers / bytes / encoded / cached /
// redirected / type / url) from which the rest defaults; `null` for a network error (an entry
// with nothing but its times and a zero status). `body` (a text body from the asset cache)
// sizes an entry that has no response hash. What the entry's attributes are made of those facts
// — what its timing allows and its response exposes, against the document's origin (an
// about:srcdoc frame's its parent's, which its location does not carry; a redirect judged at its
// final URL too), its sizes, its content type and coding, its Server-Timing — is the engine's
// (resource_timing.rs `entry_fields`).
function recordResourceTiming(desc) {
  const resp = desc.resp || null;
  const now = perfNow(), start = desc.startTime != null ? desc.startTime : now;
  const name = String(desc.name || (resp && resp.url) || '');
  const failed = !resp && desc.status == null;
  const headers = desc.headers || (resp && resp.headers) || null;
  let encoded = 0, decoded = 0;
  if (!failed) {
    if (desc.body != null) {
      encoded = decoded = utf8Length(String(desc.body));
    } else if (resp) {
      decoded = resp.bytes | 0; encoded = resp.encoded != null ? resp.encoded | 0 : decoded;
    } else {
      decoded = desc.decoded | 0; encoded = desc.encoded != null ? desc.encoded | 0 : decoded;
    }
  }
  // (…the headers from the response hash's unfiltered copy, else the caller's)
  const f = globalThis.__dom.resourceTimingEntry({
    name,
    finalUrl:        resp && resp.redirected && resp.url ? String(resp.url) : name,
    documentOrigin:  documentOrigin(),
    tao:             resp && resp.tao != null ? resp.tao : responseHeader(headers, 'timing-allow-origin'),
    opaque:          (desc.type || (resp && resp.type) || 'basic') === 'opaque',
    document:        desc.initiatorType === 'iframe' || desc.initiatorType === 'frame',
    noCors:          !!desc.noCors,
    start,
    end:             now,
    cached:          desc.cached !== undefined ? desc.cached : (resp && resp.cached) || null,
    encoded,
    decoded,
    redirected:      !!(desc.redirected !== undefined ? desc.redirected : (resp && resp.redirected)),
    status:          desc.status != null ? desc.status : (resp ? resp.status | 0 : 0),
    contentType:     responseHeader(headers, 'content-type'),
    contentEncoding: resp && resp.contentEncoding != null ? resp.contentEncoding : responseHeader(headers, 'content-encoding'),
    serverTiming:    resp && resp.serverTiming != null ? resp.serverTiming : responseHeader(headers, 'server-timing'),
    renderBlocking:  !!desc.renderBlocking,
    failed
  });
  if (f === null) return null;   // (…no entry for a URL of no network scheme: data:, blob:, about:, javascript:)
  f.name = name;
  f.startTime = start;
  f.initiatorType = desc.initiatorType || 'other';
  const metrics = [];
  for (let i = 0; i < f.serverTiming.length; i += 3) metrics.push(new PerformanceServerTiming(PLATFORM, f.serverTiming[i], f.serverTiming[i + 1], f.serverTiming[i + 2]));
  f.serverTiming = Object.freeze(metrics);
  const entry = new PerformanceResourceTiming(PLATFORM, f);
  recordEntry(timeline, entry);
  return entry;
}
globalThis.__csimRecordResource = recordResourceTiming;

// Navigation Timing Level 1 (`performance.timing` / `performance.navigation`) and the
// `toJSON()` that serializes them are NOT here, deliberately (the generator omits Navigation Timing's partial). A first cut added them with every
// unmodelled milestone at 0 and `navigation.type` hardcoded to 0; adversarial review showed that
// is worse than their absence, which is this project's `partial_api_worse_than_missing` rule:
//   - `t.loadEventEnd - t.navigationStart` becomes a large NEGATIVE number where it was NaN, so
//     an `!isNaN(x)` guard passes garbage through instead of short-circuiting;
//   - `performance.navigation.type === performance.navigation.TYPE_BACK_FORWARD` is
//     `0 === undefined` without the interface's TYPE_* constants, so the branch silently never
//     runs — where before, the missing object threw and the author saw it;
//   - `type` is knowable and would be WRONG at 0: the driver has `go_back` / `go_forward` /
//     `refresh` (driver.rb), so a restored page must report TYPE_BACK_FORWARD;
//   - and `[Exposed=Window]` means none of it may appear in a Worker scope, which this bundle
//     also evaluates (the drop lists in workers.js are where that gating lives).
// Doing it properly means capturing the real milestones — `bridge.entry.js` already performs the
// `loading` → `interactive` → `complete` transitions and fires DOMContentLoaded / load, so each is
// one timestamp — plus the constants and the Window gating. That is an increment, not a field.

// ── Performance ──
// A realm's timeline: one, made by the platform (`performance` below), its entry buffers and ids its realm's engine's
// (its global's `__dom`). Its slots: its realm's global and clock (its time origin and `now`), its buffered entries and
// registered observers by their numbers, and how its realm makes a measure and queues its observers' task — every
// method reading its own, so one called on a frame's `performance` answers with the frame's timeline, a measure() with
// one of the frame's PerformanceMeasures ("with this's relevant realm"; a mark is the current realm's, as the
// PerformanceMark constructor says, where Chrome makes the frame's).
const timelineOf = (o) => slotsOf(o, 'Performance');
const newMeasure = (name, startTime, duration, detail) => new PerformanceMeasure(PLATFORM, name, startTime, duration, detail);
export class Performance extends EventTarget {
  constructor(token) {
    constructedBy(PLATFORM, token, 'Performance');
    super();
    makeSlots(this, 'Performance', {
      global: globalThis, origin: perfStart, now: perfNow, newMeasure, queueObserverTask,
      buffered: new Map(), observers: new Map()
    });
  }
}
registerInterface('Performance', (o) => timelineOf(o) !== undefined);
const MEASURE = "Failed to execute 'measure' on 'Performance': ";
// "Convert a mark to a timestamp" (User Timing §3.1), the engine's (perf_timeline.rs `perfMarkTimestamp`): a number
// itself, a PerformanceTiming name navigation's (§3.2), any other name the start time of the most recent mark of it —
// each refusal its error here.
// (…the refusals' codes perf_timeline.rs `MARK_*`'s — MARK_NONE, -4, the one left)
const MARK_NEGATIVE = -1, MARK_TIMING_IN_WORKER = -2, MARK_TIMING_EMPTY = -3;
function markTimestamp(t, mark, name) {
  const at = t.global.__dom.perfMarkTimestamp(mark, !!t.global.document);
  if (at >= 0) return at;
  if (at === MARK_NEGATIVE) throw new TypeError(`${MEASURE}'${name}' cannot have a negative time stamp.`);
  if (at === MARK_TIMING_IN_WORKER) throw new TypeError(`${MEASURE}'${mark}' is part of the PerformanceTiming interface, which is not available in a worker.`);
  if (at === MARK_TIMING_EMPTY) {
    throw new DOMException(`${MEASURE}'${mark}' is empty: either the event hasn't happened yet, or it would provide cross-origin timing information.`, 'InvalidAccessError');
  }
  throw new DOMException(`${MEASURE}The mark '${mark}' does not exist.`, 'SyntaxError');
}
// (…a timeline's engine bindings, whose state its buffers are)
const engineOf = (p) => timelineOf(p).global.__dom;
installPerformance(Performance, {
  now: (p) => timelineOf(p).now(),
  get_timeOrigin: (p) => timelineOf(p).origin,
  // (Performance Timeline §2.1: "filter buffer map by name and type", in startTime order)
  getEntries: (p) => entriesOf(timelineOf(p), engineOf(p).perfEntries(undefined, undefined)),
  getEntriesByType: (p, type) => entriesOf(timelineOf(p), engineOf(p).perfEntries(type, undefined)),
  getEntriesByName: (p, name, type) => entriesOf(timelineOf(p), engineOf(p).perfEntries(type, name)),
  mark(p, markName, markOptions) {
    const t = timelineOf(p);
    const entry = new PerformanceMark(PLATFORM, createMark(t, markName, markOptions, "Failed to execute 'mark' on 'Performance': "));
    recordEntry(t, entry);
    return entry;
  },
  clearMarks: (p, markName) => letGo(timelineOf(p), engineOf(p).perfClear('mark', markName)),
  // The measure() steps (User Timing §2.1.3): options — any of start / end / duration / detail present — take no end
  // mark, need a start or an end, and not all three; the end time the end mark's, the end's, the start plus the
  // duration, or now; the start time the start's, the end less the duration, the start mark's, or 0.
  measure(p, measureName, startOrMeasureOptions, endMark) {
    const t = timelineOf(p);
    const options = typeof startOrMeasureOptions === 'string' ? null : startOrMeasureOptions;
    const has = (k) => options !== null && options[k] !== undefined;
    if (options !== null && Object.keys(options).length) {
      const nonEmpty = "If a non-empty PerformanceMeasureOptions object was passed, ";
      if (endMark !== undefined) throw new TypeError(`${MEASURE}${nonEmpty}|end_mark| must not be passed.`);
      if (!has('start') && !has('end')) throw new TypeError(`${MEASURE}${nonEmpty}at least one of its 'start' or 'end' properties must be present.`);
      if (has('start') && has('duration') && has('end')) {
        throw new TypeError(`${MEASURE}${nonEmpty}it must not have all of its 'start', 'duration', and 'end' properties defined`);
      }
    }
    const at = (mark) => markTimestamp(t, mark, measureName);
    const endTime = endMark !== undefined ? at(endMark)
      : has('end') ? at(options.end)
      : has('start') && has('duration') ? at(options.start) + at(options.duration)
      : t.now();
    const startTime = has('start') ? at(options.start)
      : has('duration') && has('end') ? at(options.end) - at(options.duration)
      : options === null ? at(startOrMeasureOptions)
      : 0;
    const detail = has('detail') ? cloneDetail(options.detail, MEASURE) : null;
    const entry = t.newMeasure(measureName, startTime, endTime - startTime, detail);
    recordEntry(t, entry);
    return entry;
  },
  clearMeasures: (p, measureName) => letGo(timelineOf(p), engineOf(p).perfClear('measure', measureName)),
  // Resource Timing's buffer controls: the size takes effect at once (a raise during the
  // `resourcetimingbufferfull` handler makes room for the waiting entries).
  clearResourceTimings: (p) => { letGo(timelineOf(p), engineOf(p).perfClear('resource')); },
  setResourceTimingBufferSize: (p, maxSize) => { engineOf(p).perfSetResourceBufferSize(maxSize); },
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});
globalThis.Performance = Performance;
// …the realm's timeline (WindowOrWorkerGlobalScope's `performance`: window.js, and a worker's scope).
export const performance = new Performance(PLATFORM);
const timeline = timelineOf(performance);

// ── PerformanceObserver (Performance Timeline §6) ──
// Its slots: its realm's timeline (where it registers) and how its realm queues the observers' task, its callback, its
// number in the engine (`poCreate`), the entries queued on it, and its type — 'multiple' (observe({entryTypes})) or
// 'single' (observe({type})), fixed by the first observe(). Its registration — the types it observes, whether the next
// callback reports dropped entries — is the engine's, in its realm's timeline, which keeps the observer by its number
// while it is registered; the callbacks run in a task (the performance timeline task source: a `Promise.then` queued
// after `mark()` runs before it, Chrome), once for everything queued.
const SUPPORTED_ENTRY_TYPES = Object.freeze(['mark', 'measure', 'resource']);
const ENTRY_TYPE_BITS = new Map([['mark', 1], ['measure', 2], ['resource', 4]]);
const poOf = (o) => slotsOf(o, 'PerformanceObserver');
registerInterface('PerformanceObserver', (o) => poOf(o) !== undefined);
export class PerformanceObserver {
  constructor(callback) {
    [callback] = convertPerformanceObserverArguments(arguments);
    makeSlots(this, 'PerformanceObserver', {
      timeline, queueObserverTask, callback, id: globalThis.__dom.poCreate(), queue: [], observerType: null
    });
  }
}
const PO_OBSERVE = "Failed to execute 'observe' on 'PerformanceObserver': ";
const MODIFIED = {
  multiple: 'This observer has performed observe({entryTypes:...}, therefore it cannot perform observe({type:...})',
  single: 'This PerformanceObserver has performed observe({type:...}, therefore it cannot perform observe({entryTypes:...})'
};
const typeBits = (types) => types.reduce((bits, type) => bits | (ENTRY_TYPE_BITS.get(type) ?? 0), 0);
installPerformanceObserver(PerformanceObserver, {
  // The observe() steps: entryTypes or type, not both nor neither, nor entryTypes with anything else (TypeError); the
  // observer's type fixed by its first call (InvalidModificationError to change it); unsupported types ignored — none
  // left, no observation; `buffered` (with `type`) delivering the entries already in the buffer of that type — how a
  // page observes the resources it loaded before it subscribed.
  observe(o, options) {
    const s = poOf(o);
    if (options.entryTypes === undefined && options.type === undefined) {
      throw new TypeError(PO_OBSERVE + 'An observe() call must include either entryTypes or type arguments.');
    }
    if (options.entryTypes !== undefined && options.type !== undefined) {
      throw new TypeError(PO_OBSERVE + 'An observe() call must not include both entryTypes and type arguments.');
    }
    // (…nor entryTypes with any other member — `buffered`, Event Timing's `durationThreshold` — the spec's step, where
    // Chrome and Firefox take them)
    if (options.entryTypes !== undefined && Object.keys(options).length > 1) {
      throw new TypeError(PO_OBSERVE + 'An observe() call must not include both entryTypes and other arguments.');
    }
    const observerType = options.entryTypes !== undefined ? 'multiple' : 'single';
    if (s.observerType !== null && s.observerType !== observerType) {
      throw new DOMException(PO_OBSERVE + MODIFIED[s.observerType], 'InvalidModificationError');
    }
    s.observerType = observerType;
    const multiple = observerType === 'multiple';
    const types = typeBits(multiple ? options.entryTypes : [options.type]);
    const buffered = !multiple && options.buffered ? options.type : undefined;
    const t = s.timeline;
    const [tasks, ...serials] = t.global.__dom.poObserve(s.id, types, multiple, buffered);
    if (types) t.observers.set(s.id, o);
    for (const entry of entriesOf(t, serials)) s.queue.push(entry);
    if (tasks & OBSERVER_TASK) s.queueObserverTask();
  },
  disconnect(o) {
    const s = poOf(o);
    s.timeline.global.__dom.poDisconnect(s.id);
    s.timeline.observers.delete(s.id);
    s.queue = [];
  },
  takeRecords(o) {
    const s = poOf(o);
    const queue = s.queue;
    s.queue = [];
    return queue;
  },
  get_supportedEntryTypes: () => SUPPORTED_ENTRY_TYPES
});
// "Queue the PerformanceObserver task": one at a time, which calls back every registered observer with entries queued,
// in the order they registered — each with its entry list, the observer (and `this`) and, the first time since an
// observe(), the count of entries dropped from the full buffers of its types.
function queueObserverTask() {
  globalThis.__csimSetTimeout(() => {
    for (const id of globalThis.__dom.poTask()) {
      const o = timeline.observers.get(id);
      const s = o && poOf(o);
      if (!s || s.queue.length === 0) continue;
      const entries = s.queue;
      s.queue = [];
      const droppedEntriesCount = globalThis.__dom.poDroppedEntries(id);
      const callbackOptions = droppedEntriesCount !== null ? { droppedEntriesCount } : {};
      try { s.callback.call(o, new PerformanceObserverEntryList(PLATFORM, entries), o, callbackOptions); }
      catch (e) {
        try { globalThis.__csimReportCallbackError(s.callback, e); } catch (_) { logThrew('PerformanceObserver callback', e); }
      }
    }
  }, 0);
}

// A PerformanceObserverEntryList: the entries a callback was given, filtered by type / name — by their slots — in
// startTime order, as "filter buffer by name and type" sorts them.
const listOf = (o) => slotsOf(o, 'PerformanceObserverEntryList');
registerInterface('PerformanceObserverEntryList', (o) => listOf(o) !== undefined);
export class PerformanceObserverEntryList {
  constructor(token, entries) {
    constructedBy(PLATFORM, token, 'PerformanceObserverEntryList');
    makeSlots(this, 'PerformanceObserverEntryList', { entries });
  }
}
// (…by the slots, which a page's `startTime` getter is none of)
const byStartTime = (a, b) => entryOf(a).startTime - entryOf(b).startTime;
const filterEntries = (l, type, name) => listOf(l).entries.filter((entry) => {
  const e = entryOf(entry);
  return (type === undefined || e.entryType === type) && (name === undefined || e.name === name);
}).sort(byStartTime);
installPerformanceObserverEntryList(PerformanceObserverEntryList, {
  getEntries: (l) => filterEntries(l, undefined, undefined),
  getEntriesByType: (l, type) => filterEntries(l, type, undefined),
  getEntriesByName: (l, name, type) => filterEntries(l, type, name)
});

for (const [name, iface] of Object.entries({ PerformanceObserver, PerformanceObserverEntryList })) globalThis[name] = iface;
