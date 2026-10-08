// The performance timeline (High Resolution Time, Performance Timeline, User Timing, Resource Timing, Server Timing),
// generated from their IDL: the realm's `Performance` — its clock, its entry buffers, mark / measure — and the entries
// it records, their state in slots. A PerformanceObserver (observers.js) is handed each new entry.
import { Event, EventTarget, installEventHandlerAttrs } from './events.js';
import { fireEvent } from './dispatch.js';
import { utf8Length } from './bytes.js';
import { location } from './location.js';
import { structuredClone } from './platform-globals.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';
import {
  convertPerformanceMarkArguments,
  installPerformance,
  installPerformanceEntry,
  installPerformanceMark,
  installPerformanceMeasure,
  installPerformanceResourceTiming,
  installPerformanceServerTiming
} from './generated/bindings.js';

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
// `mark` / `measure` record entries and notify any active PerformanceObserver via
// `__csimDeliverPerfEntry`.
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
const perfStart = Date.now();
const perfNow = () => Date.now() - perfStart;

// The driver's own reads of the clock (an event's timeStamp, a fetch's start), which no page's replacement of
// `performance` or `Performance.prototype.now` reaches.
globalThis.__csimPerformanceNow = perfNow;

// "Generate an id" (Performance Timeline §5.7) on timeline `t`: its last performance entry id, starting at a random
// integer between 100 and 10000 and raised by one for each entry — drawn when the first is asked for, not where the
// snapshot this module is evaluated in is built, which every realm would share.
function generateId(t) {
  if (t.lastEntryId === null) t.lastEntryId = 100 + Math.floor(Math.random() * 9900);
  return ++t.lastEntryId;
}
// "Queue a PerformanceEntry": an entry not yet queued given its id, and its document's most recent navigation's id — the
// navigation's drawn first, so it is the smaller — as its `navigationId` (a worker has no document: the spec's null,
// which the attribute's `unsigned long long` makes 0, as Chrome reports); then every observer of its type handed it, in
// the timeline's realm.
function queueEntry(t, entry) {
  const e = entryOf(entry);
  if (e.id === 0) {
    e.navigationId = t.global.document ? (t.navigationId ??= generateId(t)) : 0;
    e.id = generateId(t);
  }
  if (typeof t.global.__csimDeliverPerfEntry === 'function') t.global.__csimDeliverPerfEntry(entry);
}

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
function cloneDetail(detail, prefix) {
  if (detail == null) return null;
  try {
    return structuredClone(detail);
  } catch (e) {
    if (e && e.name === 'DataCloneError') {
      throw new DOMException(prefix + String(e.message).replace(/^Failed to execute '[^']*' on '[^']*': /, ''), 'DataCloneError');
    }
    throw e;
  }
}

// The PerformanceTiming interface's attribute names, which a mark may not take in a Window and a measure reads as
// navigation timestamps (User Timing §3.2) — Navigation Timing is not modelled, so every one but navigationStart is
// an event that "hasn't happened yet".
const PERFORMANCE_TIMING_NAMES = new Set([
  'navigationStart', 'unloadEventStart', 'unloadEventEnd', 'redirectStart', 'redirectEnd', 'fetchStart',
  'domainLookupStart', 'domainLookupEnd', 'connectStart', 'connectEnd', 'secureConnectionStart', 'requestStart',
  'responseStart', 'responseEnd', 'domLoading', 'domInteractive', 'domContentLoadedEventStart',
  'domContentLoadedEventEnd', 'domComplete', 'loadEventStart', 'loadEventEnd'
]);

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
  if (t.global.document && PERFORMANCE_TIMING_NAMES.has(name)) {
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
// A timeline's (a Performance's slots, below): marks and measures in one list; resources in the spec's primary buffer
// (bounded by `resourceTimingBufferSize`, 250 by default) with the secondary buffer that catches the overflow until
// `resourcetimingbufferfull` has fired and the page has made room, or not.
function recordEntry(t, entry) {
  queueEntry(t, entry);
  t.entries.push(entry);
}
const canAddResource = (r) => r.primary.length < r.size;
function copySecondaryBuffer(r) {
  while (r.secondary.length && canAddResource(r)) r.primary.push(r.secondary.shift());
}
// "Fire a buffer full event": give the page a chance to make room (raise the size, clear the
// buffer) for each batch of excess entries, and drop what it leaves no room for.
function fireResourceBufferFull(t) {
  const r = t.resources;
  while (r.secondary.length) {
    const before = r.secondary.length;
    if (!canAddResource(r)) {
      fireEvent(t.owner, new Event('resourcetimingbufferfull'));
    }
    copySecondaryBuffer(r);
    if (before <= r.secondary.length) { r.secondary.length = 0; break; }
  }
  r.fullPending = false;
}
function addResourceEntry(t, entry) {
  // Observers see every entry, buffer or no buffer (they are how a page reads a stream).
  queueEntry(t, entry);
  const r = t.resources;
  if (canAddResource(r) && !r.fullPending) { r.primary.push(entry); return; }
  if (!r.fullPending) {
    r.fullPending = true;
    globalThis.__csimSetTimeout(() => fireResourceBufferFull(t), 0);
  }
  r.secondary.push(entry);
}
// (…by the slots, which a page's `startTime` getter is none of)
const byStartTime = (a, b) => entryOf(a).startTime - entryOf(b).startTime;
function allPerfEntries(t) { return t.entries.concat(t.resources.primary).sort(byStartTime); }
globalThis.__csimBufferedPerfEntries = (type) => allPerfEntries(timeline).filter((e) => entryOf(e).entryType === type);

function originOf(url) {
  try { return new globalThis.URL(String(url)).origin; } catch (_) { return null; }
}
function headerOf(headers, name) {
  if (!headers) return null;
  for (const k in headers) if (k.toLowerCase() === name) { const v = headers[k]; return v == null ? null : Array.isArray(v) ? v.join(', ') : String(v); }
  return null;
}
// The timing-allow check (Resource Timing §4.7 / Fetch): same origin passes; a cross-origin
// response passes on a `Timing-Allow-Origin` of `*` or of the requesting origin.
function timingAllowed(name, tao, type) {
  if (type === 'opaque') return false;
  const here = location.origin || null, there = originOf(name);
  if (!there || there === here) return true;
  if (tao == null) return false;
  return String(tao).split(',').some((v) => { v = v.trim(); return v === '*' || v === here; });
}
// The spec's "minimize a supported mime type" for `contentType`: every JavaScript type is
// `text/javascript`, every JSON type `application/json`, SVG and XML their canonical essence.
const JS_MIME_RE = /^(?:application\/(?:x-)?(?:ecma|java)script|text\/(?:x-)?(?:ecma|java)script(?:1\.[0-5])?|text\/(?:jscript|livescript|x-javascript))$/;
function minimizeMimeType(contentType) {
  if (!contentType) return '';
  const essence = contentType.split(';')[0].trim().toLowerCase();
  if (!/^[^\s/]+\/[^\s;/]+$/.test(essence)) return '';
  if (JS_MIME_RE.test(essence)) return 'text/javascript';
  if (essence === 'application/json' || essence === 'text/json' || essence.endsWith('+json')) return 'application/json';
  if (essence === 'image/svg+xml') return essence;
  if (essence === 'application/xml' || essence === 'text/xml' || essence.endsWith('+xml')) return 'application/xml';
  return essence;
}
// `contentEncoding` (Resource Timing): one recognised coding as written (case-folded); a list
// is "multiple"; a coding the UA does not recognise — `identity` is not valid on the wire —
// is "@unknown"; no header, or an empty one, is the empty string.
const KNOWN_CONTENT_ENCODINGS = new Set(['br', 'dcb', 'dcz', 'deflate', 'gzip', 'zstd']);
function contentEncodingOf(header) {
  if (header == null) return '';
  const raw = String(header).trim();
  if (raw === '') return '';
  if (raw.indexOf(',') !== -1) return 'multiple';
  const enc = raw.toLowerCase();
  return KNOWN_CONTENT_ENCODINGS.has(enc) ? enc : '@unknown';
}
function parseServerTiming(value) {
  const out = [];
  if (!value) return out;
  for (const item of value.split(',')) {
    const parts = item.split(';').map((x) => x.trim());
    if (!parts[0]) continue;
    let duration = 0, description = '';
    for (const param of parts.slice(1)) {
      const eq = param.indexOf('='), key = (eq < 0 ? param : param.slice(0, eq)).trim().toLowerCase();
      let val = eq < 0 ? '' : param.slice(eq + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (key === 'dur') duration = parseFloat(val) || 0;
      else if (key === 'desc') description = val;
    }
    out.push(new PerformanceServerTiming(PLATFORM, parts[0], duration, description));
  }
  return out;
}
// `desc`: { name, initiatorType, startTime, resp, renderBlocking, cached, encoded, decoded, status,
// headers, type } — `resp` a Rack response hash (status / headers / bytes / encoded / cached /
// redirected / type / url) from which the rest defaults; `null` for a network error (an entry
// with nothing but its times and a zero status). `body` (a text body from the asset cache)
// sizes an entry that has no response hash.
function recordResourceTiming(desc) {
  const resp = desc.resp || null;
  const now = perfNow(), start = desc.startTime != null ? desc.startTime : now;
  const name = String(desc.name || (resp && resp.url) || '');
  if (/^(?:data|blob|about|javascript):/i.test(name)) return null;      // no entry for a data: URL (spec)
  const failed = !resp && desc.status == null;
  const headers = desc.headers || (resp && resp.headers) || null;
  const type = desc.type || (resp && resp.type) || 'basic';
  // The headers the checks read: from the response hash's unfiltered copy, else the caller's.
  const tao = resp && resp.tao != null ? resp.tao : headerOf(headers, 'timing-allow-origin');
  const serverTiming = resp && resp.serverTiming != null ? resp.serverTiming : headerOf(headers, 'server-timing');
  const contentEncoding = resp && resp.contentEncoding != null ? resp.contentEncoding : headerOf(headers, 'content-encoding');
  // A redirect that crossed an origin boundary exposes its timings only when the FINAL
  // response's Timing-Allow-Origin admits the document (every hop has to; the hops in between
  // are not in the response hash — an accepted approximation).
  const finalUrl = resp && resp.redirected && resp.url ? String(resp.url) : name;
  const crossOriginChain = finalUrl !== name && originOf(finalUrl) !== originOf(name);
  const allowed = !failed && timingAllowed(name, tao, type) && (!crossOriginChain || timingAllowed(finalUrl, tao, type));
  // The status and content type are the RESPONSE's to expose: an opaque (no-cors cross-origin)
  // response and a cross-origin document hide them; a CORS-approved one shows them without a
  // Timing-Allow-Origin.
  const crossOrigin = originOf(name) !== (location.origin || null);
  const crossOriginDocument = (desc.initiatorType === 'iframe' || desc.initiatorType === 'frame') && crossOrigin;
  // A no-cors element load (`<script>`, `<link>`, `<img>` without `crossorigin`) of a
  // cross-origin resource is opaque to the page whatever the server said.
  const exposed = !failed && type !== 'opaque' && !crossOriginDocument && !(desc.noCors && crossOrigin);
  const cached = desc.cached !== undefined ? desc.cached : (resp && resp.cached) || null;
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
  const secure = /^https:/i.test(name);
  const redirected = !!(desc.redirected !== undefined ? desc.redirected : (resp && resp.redirected));
  const f = {
    name, startTime: start, fetchStart: start, responseEnd: now,
    initiatorType: desc.initiatorType || 'other',
    deliveryType: allowed && cached === 'cache' ? 'cache' : '',
    nextHopProtocol: allowed ? 'http/1.1' : '',
    workerStart: 0,
    redirectStart: allowed && redirected ? start : 0, redirectEnd: allowed && redirected ? start : 0,
    domainLookupStart: allowed ? start : 0, domainLookupEnd: allowed ? start : 0,
    connectStart: allowed ? start : 0, connectEnd: allowed ? start : 0,
    secureConnectionStart: allowed && secure ? start : 0,
    requestStart: allowed ? start : 0,
    firstInterimResponseStart: 0,
    finalResponseHeadersStart: allowed ? start : 0,
    responseStart: allowed ? start : 0,
    transferSize: !allowed ? 0 : cached === 'cache' ? 0 : cached === 'validated' ? 300 : encoded + 300,
    encodedBodySize: allowed ? encoded : 0,
    decodedBodySize: allowed ? decoded : 0,
    responseStatus: exposed ? (desc.status != null ? desc.status : (resp ? resp.status | 0 : 0)) : 0,
    renderBlockingStatus: desc.renderBlocking ? 'blocking' : 'non-blocking',
    contentType: exposed ? minimizeMimeType(headerOf(headers, 'content-type')) : '',
    contentEncoding: '',
    workerRouterEvaluationStart: 0, workerCacheLookupStart: 0, workerMatchedRouterSource: '', workerFinalRouterSource: '',
    serverTiming: Object.freeze(allowed ? parseServerTiming(serverTiming) : [])
  };
  if (allowed) f.contentEncoding = contentEncodingOf(contentEncoding);
  const entry = new PerformanceResourceTiming(PLATFORM, f);
  addResourceEntry(timeline, entry);
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
// A realm's timeline: one, made by the platform (`performance` below). Its slots: its realm's global and clock (its
// time origin and `now`), its entry buffers, its last entry id and its document's navigation id — every method reading
// its own, so one called on a frame's `performance` answers with the frame's timeline.
const timelineOf = (o) => slotsOf(o, 'Performance');
export class Performance extends EventTarget {
  constructor(token) {
    constructedBy(PLATFORM, token, 'Performance');
    super();
    makeSlots(this, 'Performance', {
      global: globalThis, origin: perfStart, now: perfNow, entries: [],
      resources: { primary: [], secondary: [], size: 250, fullPending: false },
      lastEntryId: null, navigationId: null
    });
  }
}
registerInterface('Performance', (o) => timelineOf(o) !== undefined);
const MEASURE = "Failed to execute 'measure' on 'Performance': ";
// "Convert a mark to a timestamp" (User Timing §3.1): a PerformanceTiming name navigation's (§3.2), any other name the
// start time of the most recent mark of it, a number itself — none negative.
function markTimestamp(t, mark, name) {
  if (typeof mark === 'number') {
    if (mark < 0) throw new TypeError(`${MEASURE}'${name}' cannot have a negative time stamp.`);
    return mark;
  }
  if (PERFORMANCE_TIMING_NAMES.has(mark)) {
    if (!t.global.document) throw new TypeError(`${MEASURE}'${mark}' is part of the PerformanceTiming interface, which is not available in a worker.`);
    if (mark === 'navigationStart') return 0;
    throw new DOMException(`${MEASURE}'${mark}' is empty: either the event hasn't happened yet, or it would provide cross-origin timing information.`, 'InvalidAccessError');
  }
  for (let i = t.entries.length - 1; i >= 0; i--) {
    const e = entryOf(t.entries[i]);
    if (e.entryType === 'mark' && e.name === mark) return e.startTime;
  }
  throw new DOMException(`${MEASURE}The mark '${mark}' does not exist.`, 'SyntaxError');
}
const clearEntries = (t, type, name) => {
  for (let i = t.entries.length - 1; i >= 0; i--) {
    const s = entryOf(t.entries[i]);
    if (s.entryType === type && (name === undefined || s.name === name)) t.entries.splice(i, 1);
  }
};
installPerformance(Performance, {
  now: (p) => timelineOf(p).now(),
  get_timeOrigin: (p) => timelineOf(p).origin,
  // (Performance Timeline §2.1: "filter buffer map by name and type", in startTime order)
  getEntries: (p) => allPerfEntries(timelineOf(p)),
  getEntriesByType: (p, type) => allPerfEntries(timelineOf(p)).filter((e) => entryOf(e).entryType === type),
  getEntriesByName: (p, name, type) => allPerfEntries(timelineOf(p)).filter((e) => entryOf(e).name === name && (type === undefined || entryOf(e).entryType === type)),
  mark(p, markName, markOptions) {
    const t = timelineOf(p);
    const entry = new PerformanceMark(PLATFORM, createMark(t, markName, markOptions, "Failed to execute 'mark' on 'Performance': "));
    recordEntry(t, entry);
    return entry;
  },
  clearMarks: (p, markName) => clearEntries(timelineOf(p), 'mark', markName),
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
    const entry = new PerformanceMeasure(PLATFORM, measureName, startTime, endTime - startTime, detail);
    recordEntry(t, entry);
    return entry;
  },
  clearMeasures: (p, measureName) => clearEntries(timelineOf(p), 'measure', measureName),
  // Resource Timing's buffer controls: the size takes effect at once (a raise during the
  // `resourcetimingbufferfull` handler makes room for the waiting entries).
  clearResourceTimings: (p) => { timelineOf(p).resources.primary.length = 0; },
  setResourceTimingBufferSize: (p, maxSize) => { timelineOf(p).resources.size = maxSize; },
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});
globalThis.Performance = Performance;
// …the realm's timeline (WindowOrWorkerGlobalScope's `performance`: window.js, and a worker's scope).
export const performance = new Performance(PLATFORM);
const timeline = timelineOf(performance);
