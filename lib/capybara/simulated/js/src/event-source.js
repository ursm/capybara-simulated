// EventSource (SSE) — `new EventSource(url)` opens a TCP-backed
// stream on the Ruby side; events flow back through
// `__csim_deliverEventSourceEvents` which the settle path drains
// each tick. The actual TCP / chunked-parsing work lives in Ruby
// (Browser#event_source_open / #event_source_close) because Net::HTTP
// won't stream chunked bodies through WebMock and we need real
// socket access.

import { Event, MessageEvent, EventTarget, dispatchWithOnHandler } from './events.js';

const byId = new Map();
globalThis.__csim_eventSourceById = byId;

export class EventSource extends EventTarget {
  constructor(url, options) {
    super();
    this.url             = String(url);
    this.withCredentials = !!(options && options.withCredentials);
    this.readyState      = 0;            // CONNECTING
    this.onopen          = null;
    this.onmessage       = null;
    this.onerror         = null;
    this._id             = globalThis.__csim_eventSourceOpen(this.url) | 0;
    if (this._id > 0) byId.set(this._id, this);
  }
  close() {
    if (this.readyState === 2) return;
    this.readyState = 2;
    if (this._id > 0) {
      globalThis.__csim_eventSourceClose(this._id);
      byId.delete(this._id);
    }
  }
}
EventSource.CONNECTING = 0;
EventSource.OPEN       = 1;
EventSource.CLOSED     = 2;

// `events`: Array<{id, type, data?, lastEventId?, message?}> with
// sentinel types `__open` / `__error` for lifecycle transitions and
// any other `type` for an actual SSE event. Don't bump
// `__settleGen` from delivery — the React / Redux render chain
// triggered by the listener is what genuinely changes the DOM, and
// `drain_microtasks` in the next settle iter picks that up
// naturally. Bumping here would cut settle short before those
// microtasks land.
globalThis.__csim_deliverEventSourceEvents = function (events) {
  if (!events || !events.length) return 0;
  let delivered = 0;
  for (const e of events) {
    const src = byId.get(e.id | 0);
    if (!src) continue;
    if (e.type === '__open') {
      if (src.readyState === 0) {
        src.readyState = 1;
        dispatchWithOnHandler(src, new Event('open'));
        delivered++;
      }
      continue;
    }
    if (e.type === '__error') {
      src.readyState = 2;
      const evt = new Event('error');
      if (e.message) try { evt.message = String(e.message); } catch (_) {}
      dispatchWithOnHandler(src, evt);
      byId.delete(e.id | 0);
      delivered++;
      continue;
    }
    const type = e.type || 'message';
    dispatchWithOnHandler(src, new MessageEvent(type, {
      data:        e.data == null ? '' : String(e.data),
      lastEventId: e.lastEventId == null ? '' : String(e.lastEventId),
      origin:      src.url
    }));
    delivered++;
  }
  return delivered;
};
