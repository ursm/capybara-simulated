// The performance timeline (High Resolution Time, Performance Timeline, User Timing, Resource Timing, Server Timing),
// generated from their IDL: the realm's `Performance` — its clock, mark / measure — the entries it records and the
// PerformanceObservers they are queued on, their state in slots; its entry buffers, its ids and its registered
// observers are the engine's (perf_timeline.rs), which names the entries and observers it holds by number, the objects
// kept here.
import { logThrew } from './console.js';
import { Event, EventTarget, installEventHandlerAttrs } from './events.js';
import { fireEvent } from './dispatch.js';
import { cloneFor, isCrossOriginIsolated } from './platform-globals.js';
import { hrNow, timeOriginNow } from './timers.js';
import { PLATFORM, slotsOf } from './webidl.js';
import {
  definePerformance,
  definePerformanceObserver,
  definePerformanceObserverEntryList,
  definePerformanceEntry,
  definePerformanceMark,
  definePerformanceMeasure,
  definePerformanceResourceTiming,
  definePerformanceServerTiming
} from './generated/bindings.js';
import { DOMException } from './dom-exception.js';
import { dom, engineOf, listMap } from './engine.js';

// The realm's current high resolution time (HR-Time §5 "current high resolution time"): the time since its time origin on
// the clock `Date` reads too (timers.js `hrNow`, agent_clock.rs) — its virtual clock, and the time its agent's scripts
// have run for — coarsened as "coarsen time" has it: to 100 microseconds, or to 5 where the realm is cross-origin
// isolated (its `crossOriginIsolatedCapability`). Down, and with none of the jitter the algorithm allows: the same read
// gives the same value every run. Its time origin, `performance.timeOrigin`, on the same clock — so `timeOrigin + now()` is
// what `Date.now()` reads, to a millisecond — coarsened alike.
const coarsen = (t) => {
  const steps = isCrossOriginIsolated() ? 200 : 10;
  return Math.floor(t * steps) / steps;
};
const perfNow = () => coarsen(hrNow());
const perfOrigin = () => coarsen(timeOriginNow());

// The driver's own reads of the clock (an event's timeStamp, a fetch's start), which no page's replacement of
// `performance` or `Performance.prototype.now` reaches.
globalThis.__csimPerformanceNow = perfNow;

// ── PerformanceEntry and the entry interfaces ──
// An entry's slots: its name, type, start time and duration, set when it is made, and its id and navigation id, when it
// is queued (0 until then: a `new PerformanceMark` is never queued); a mark's and a measure's detail, a resource's fields
// (see `recordResourceTiming`), each in its own interface's slots.
const entryOf = (o) => slotsOf(o, 'PerformanceEntry');
function initEntry(s, name, entryType, startTime, duration) {
  s.name = name;
  s.entryType = entryType;
  s.startTime = startTime;
  s.duration = duration;
  s.id = 0;
  s.navigationId = 0;
}
export const PerformanceEntry = definePerformanceEntry({ init: initEntry });

// A detail, structured-cloned into this realm — a DataCloneError in the words of the operation it was handed to — or
// null for none.
const cloneDetail = (detail, prefix) => (detail == null ? null : cloneFor(prefix, detail));

// The PerformanceMark constructor (User Timing §2.2.1): no PerformanceTiming name in a Window, no negative start time,
// the start time now otherwise, and its detail cloned — or, made by the platform (mark()), what `createMark` made.
function initMark(s, made) {
  initEntry(s, made.name, 'mark', made.startTime, 0);
  s.detail = made.detail;
}
export const PerformanceMark = definePerformanceMark(PerformanceEntry, {
  init: initMark,
  construct: (s, markName, markOptions) => initMark(s, createMark(timeline, markName, markOptions, "Failed to construct 'PerformanceMark': "))
});
function createMark(t, name, options, prefix) {
  // (…a PerformanceTiming attribute's name the engine's to know: perf_timeline.rs `PERFORMANCE_TIMING_NAMES`)
  if (t.global.document && engineOf(t.global).perfTimingName(name)) {
    throw new DOMException(`${prefix}'${name}' is part of the PerformanceTiming interface, and cannot be used as a mark name.`, 'SyntaxError');
  }
  if (options.startTime !== undefined && options.startTime < 0) {
    throw new TypeError(`${prefix}'${name}' cannot have a negative start time.`);
  }
  const startTime = options.startTime !== undefined ? options.startTime : t.now();
  return { name, startTime, detail: cloneDetail(options.detail, prefix) };
}

export const PerformanceMeasure = definePerformanceMeasure(PerformanceEntry, {
  init(s, name, startTime, duration, detail) {
    initEntry(s, name, 'measure', startTime, duration);
    s.detail = detail;
  }
});

export const PerformanceServerTiming = definePerformanceServerTiming({
  init(s, name, duration, description) {
    s.name = name;
    s.duration = duration;
    s.description = description;
  }
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
export const PerformanceResourceTiming = definePerformanceResourceTiming(PerformanceEntry, {
  init(s, f) {
    initEntry(s, f.name, 'resource', f.startTime, f.responseEnd - f.startTime);
    s.f = f;
  },
  ...Object.fromEntries(RESOURCE_TIMING_FIELDS.map((k) => [`get_${k}`, (r) => resourceOf(r).f[k]]))
});

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
const BUFFER_FULL_TASK = 1, OBSERVER_TASK = 2, OBSERVER_REGISTERED = 4;
function recordEntry(t, entry) {
  const e = entryOf(entry);
  const recorded = engineOf(t.global).perfRecord(e.entryType, e.name, e.startTime, !!t.global.document);
  e.navigationId = recorded[0];
  e.id = recorded[1];
  const tasks = recorded[2], serial = recorded[3];
  if (serial) t.buffered[serial] = entry;
  // (…the observers it goes to, after those)
  for (let i = 4; i < recorded.length; i++) {
    const queue = poOf(t.observers[recorded[i]]).queue;
    queue[queue.length] = entry;
  }
  if (tasks & OBSERVER_TASK) t.queueObserverTask();
  if (tasks & BUFFER_FULL_TASK) globalThis.__csimSetTimeout(() => fireResourceBufferFull(t), 0);
}
// The entries the engine answers with, by their serials; and those it let go of, no more kept.
// (…records of no prototype by serial, read by index: a page's `Map` or `Array` methods none of a fetch's entry's steps)
const entriesOf = (t, serials) => listMap(serials, (serial) => t.buffered[serial]);
const letGo = (t, serials) => { for (let i = 0; i < serials.length; i++) delete t.buffered[serials[i]]; };
// "Fire a buffer full event": give the page a chance to make room (raise the size, clear the
// buffer) for each batch of excess entries, and drop what it leaves no room for.
function fireResourceBufferFull(t) {
  for (let count, room; ([count, room] = engineOf(t.global).perfOverflow(), count > 0);) {
    if (!room) fireEvent(t.owner, new Event('resourcetimingbufferfull'));
    const dropped = engineOf(t.global).perfCopyOverflow(count);
    if (dropped.length) { letGo(t, dropped); break; }
  }
}

// A fetch's entry, filed: what the fetch tells of it (`desc` — its name, initiator, start, response and the facts it
// overrides: resource_timing.rs `entry_op`) made the entry's attributes by the engine — what its timing allows and its
// response exposes against the document's origin, its sizes, its content type and coding, its Server-Timing — or none
// for a URL of no network scheme (data:, blob:, about:, javascript:).
function recordResourceTiming(desc) {
  const f = dom.resourceTimingEntry(desc, perfNow());
  if (f === null) return null;
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
const MEASURE = "Failed to execute 'measure' on 'Performance': ";
// What "convert a mark to a timestamp" (User Timing §3.1, the engine's: perf_timeline.rs `mark_timestamp`) refused, as
// its error — the codes perf_timeline.rs `MARK_*`'s, MARK_NONE (-4) the one left.
const MARK_NEGATIVE = -1, MARK_TIMING_IN_WORKER = -2, MARK_TIMING_EMPTY = -3;
function markRefusal(at, mark, name) {
  if (at === MARK_NEGATIVE) return new TypeError(`${MEASURE}'${name}' cannot have a negative time stamp.`);
  if (at === MARK_TIMING_IN_WORKER) return new TypeError(`${MEASURE}'${mark}' is part of the PerformanceTiming interface, which is not available in a worker.`);
  if (at === MARK_TIMING_EMPTY) {
    return new DOMException(`${MEASURE}'${mark}' is empty: either the event hasn't happened yet, or it would provide cross-origin timing information.`, 'InvalidAccessError');
  }
  return new DOMException(`${MEASURE}The mark '${mark}' does not exist.`, 'SyntaxError');
}
// …and what measure()'s options refused (`MEASURE_*`).
const MEASURE_REFUSALS = [
  null,
  '|end_mark| must not be passed.',
  "at least one of its 'start' or 'end' properties must be present.",
  "it must not have all of its 'start', 'duration', and 'end' properties defined"
];
// (…a timeline's engine bindings, whose state its buffers are)
const timelineEngineOf = (p) => engineOf(timelineOf(p).global);
export const Performance = definePerformance(EventTarget, {
  init(slots) {
    slots.global = globalThis;
    slots.origin = perfOrigin;
    slots.now = perfNow;
    slots.newMeasure = newMeasure;
    slots.queueObserverTask = queueObserverTask;
    slots.buffered = { __proto__: null };
    slots.observers = { __proto__: null };
  },
  now: (p) => timelineOf(p).now(),
  get_timeOrigin: (p) => timelineOf(p).origin(),
  // (Performance Timeline §2.1: "filter buffer map by name and type", in startTime order)
  getEntries: (p) => entriesOf(timelineOf(p), timelineEngineOf(p).perfEntries(undefined, undefined)),
  getEntriesByType: (p, type) => entriesOf(timelineOf(p), timelineEngineOf(p).perfEntries(type, undefined)),
  getEntriesByName: (p, name, type) => entriesOf(timelineOf(p), timelineEngineOf(p).perfEntries(type, name)),
  mark(p, markName, markOptions) {
    const t = timelineOf(p);
    const entry = new PerformanceMark(PLATFORM, createMark(t, markName, markOptions, "Failed to execute 'mark' on 'Performance': "));
    recordEntry(t, entry);
    return entry;
  },
  clearMarks: (p, markName) => letGo(timelineOf(p), timelineEngineOf(p).perfClear('mark', markName)),
  // The measure() steps (User Timing §3.1.3), the engine's (perf_timeline.rs `perfMeasure`): options — any of start /
  // end / duration / detail present — take no end mark, need a start or an end, and not all three; the end time the end
  // mark's, the end's, the start plus the duration, or now; the start time the start's, the end less the duration, the
  // start mark's, or 0 — each refusal its TypeError, or its mark's (`markRefusal`).
  measure(p, measureName, startOrMeasureOptions, endMark) {
    const t = timelineOf(p);
    const options = typeof startOrMeasureOptions === 'string' ? null : startOrMeasureOptions;
    const has = (k) => options !== null && options[k] !== undefined;
    const kind = options === null ? 0 : Object.keys(options).length ? 2 : 1;
    // (…the marks it may convert, by the place the engine names a refused one with)
    const marks = [
      endMark,
      has('start') ? options.start : undefined,
      has('end') ? options.end : undefined,
      has('duration') ? options.duration : undefined,
      options === null ? startOrMeasureOptions : undefined
    ];
    const answer = engineOf(t.global).perfMeasure(!!t.global.document, t.now(), kind, ...marks);
    if (answer[0] > 0) {
      throw new TypeError(`${MEASURE}If a non-empty PerformanceMeasureOptions object was passed, ${MEASURE_REFUSALS[answer[0]]}`);
    }
    if (answer[0] < 0) throw markRefusal(answer[0], marks[answer[1] - 3], measureName);
    const [, startTime, endTime] = answer;
    const detail = has('detail') ? cloneDetail(options.detail, MEASURE) : null;
    const entry = t.newMeasure(measureName, startTime, endTime - startTime, detail);
    recordEntry(t, entry);
    return entry;
  },
  clearMeasures: (p, measureName) => letGo(timelineOf(p), timelineEngineOf(p).perfClear('measure', measureName)),
  // Resource Timing's buffer controls: the size takes effect at once (a raise during the
  // `resourcetimingbufferfull` handler makes room for the waiting entries).
  clearResourceTimings: (p) => { letGo(timelineOf(p), timelineEngineOf(p).perfClear('resource')); },
  setResourceTimingBufferSize: (p, maxSize) => { timelineEngineOf(p).perfSetResourceBufferSize(maxSize); },
  installEventHandlers: installEventHandlerAttrs
});
globalThis.Performance = Performance;
// …the realm's timeline (WindowOrWorkerGlobalScope's `performance`: window.js, and a worker's scope).
export const performance = new Performance(PLATFORM);
const timeline = timelineOf(performance);

// ── PerformanceObserver (Performance Timeline §6) ──
// Its slots: its realm's timeline (where it registers) and how its realm queues the observers' task, its callback, its
// number in the engine (`poCreate`), and the entries queued on it. Its type — 'multiple' (observe({entryTypes})) or
// 'single' (observe({type})), fixed by the first observe() — and its registration — the types it observes, whether the
// next callback reports dropped entries — are the engine's, in its realm's timeline, which keeps the observer by its
// number while it is registered; the callbacks run in a task (the performance timeline task source: a `Promise.then`
// queued after `mark()` runs before it, Chrome), once for everything queued.
// (…the entry types the engine's timeline supports, one frozen array for every read: perf_timeline.rs `perfEntryTypes`)
let supportedEntryTypes = null;
const poOf = (o) => slotsOf(o, 'PerformanceObserver');
// (…the engine's record of one let go of once it is collected: what it keeps past a disconnect(), its type)
const collectedObservers = new FinalizationRegistry((id) => { if (dom) dom.poForget(id); });
const PO_OBSERVE = "Failed to execute 'observe' on 'PerformanceObserver': ";
const MODIFIED = {
  multiple: 'This observer has performed observe({entryTypes:...}, therefore it cannot perform observe({type:...})',
  single: 'This PerformanceObserver has performed observe({type:...}, therefore it cannot perform observe({entryTypes:...})'
};
export const PerformanceObserver = definePerformanceObserver({
  construct(slots, callback) {
    const id = dom.poCreate();
    slots.timeline = timeline;
    slots.queueObserverTask = queueObserverTask;
    slots.callback = callback;
    slots.id = id;
    slots.queue = [];
    collectedObservers.register(slots.owner, id);
  },
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
    const multiple = options.entryTypes !== undefined;
    const types = multiple ? options.entryTypes : [options.type];
    const buffered = !multiple && options.buffered ? options.type : undefined;
    const t = s.timeline;
    const observed = engineOf(t.global).poObserve(s.id, types, multiple, buffered);
    // (…the other type its first observe() fixed: the engine's)
    if (observed === null) throw new DOMException(PO_OBSERVE + MODIFIED[multiple ? 'single' : 'multiple'], 'InvalidModificationError');
    const [tasks, ...serials] = observed;
    if (tasks & OBSERVER_REGISTERED) t.observers[s.id] = o;
    for (const entry of entriesOf(t, serials)) s.queue.push(entry);
    if (tasks & OBSERVER_TASK) s.queueObserverTask();
  },
  disconnect(o) {
    const s = poOf(o);
    engineOf(s.timeline.global).poDisconnect(s.id);
    delete s.timeline.observers[s.id];
    s.queue = [];
  },
  takeRecords(o) {
    const s = poOf(o);
    const queue = s.queue;
    s.queue = [];
    return queue;
  },
  get_supportedEntryTypes: () => (supportedEntryTypes ??= Object.freeze(dom.perfEntryTypes()))
});
// "Queue the PerformanceObserver task": one at a time, which calls back every registered observer with entries queued,
// in the order they registered — each with its entry list, the observer (and `this`) and, the first time since an
// observe(), the count of entries dropped from the full buffers of its types.
function queueObserverTask() {
  globalThis.__csimSetTimeout(() => {
    for (const id of dom.poTask()) {
      const o = timeline.observers[id];
      const s = o && poOf(o);
      if (!s || s.queue.length === 0) continue;
      const entries = s.queue;
      s.queue = [];
      const droppedEntriesCount = dom.poDroppedEntries(id);
      const callbackOptions = droppedEntriesCount !== null ? { droppedEntriesCount } : {};
      try { Reflect.apply(s.callback, o, [new PerformanceObserverEntryList(PLATFORM, entries), o, callbackOptions]); }
      catch (e) {
        try { globalThis.__csimReportCallbackError(s.callback, e); } catch (_) { logThrew('PerformanceObserver callback', e); }
      }
    }
  }, 0);
}

// A PerformanceObserverEntryList: the entries a callback was given, filtered by type / name — by their slots — in
// startTime order, as "filter buffer by name and type" sorts them.
const listOf = (o) => slotsOf(o, 'PerformanceObserverEntryList');
// (…by the slots, which a page's `startTime` getter is none of)
const byStartTime = (a, b) => entryOf(a).startTime - entryOf(b).startTime;
const filterEntries = (l, type, name) => listOf(l).entries.filter((entry) => {
  const e = entryOf(entry);
  return (type === undefined || e.entryType === type) && (name === undefined || e.name === name);
}).sort(byStartTime);
export const PerformanceObserverEntryList = definePerformanceObserverEntryList({
  init(slots, entries) {
    slots.entries = entries;
  },
  getEntries: (l) => filterEntries(l, undefined, undefined),
  getEntriesByType: (l, type) => filterEntries(l, type, undefined),
  getEntriesByName: (l, name, type) => filterEntries(l, type, name)
});

for (const [name, iface] of Object.entries({ PerformanceObserver, PerformanceObserverEntryList })) globalThis[name] = iface;
