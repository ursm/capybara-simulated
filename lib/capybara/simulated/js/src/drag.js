// Capybara `drag_to` — the driver-side drag emulation.
//
// A synthetic mouse drag does NOT make a browser generate drag events: only a real user gesture
// does, so EVERY driver has to synthesize the HTML5 drag-and-drop sequence itself. This mirrors the
// model Capybara's own Selenium driver uses (`capybara/selenium/extensions/html5_drag.rb`) — that
// model, not the HTML spec's internal drag-and-drop loop, is the contract its shared specs encode,
// and it's what page code (Sortable, Dragula, jsTree, Trix) is written against.
//
// Two modes, decided the way Capybara decides:
//   - POINTER-DRIVEN (jQuery UI draggable, SortableJS, Dragula, …) when the source's press was
//     cancelled — the page has taken over the pointer — or when nothing in the ancestor chain is
//     `draggable`. Drives the move / release and lets the page do the rest.
//   - HTML5 otherwise: `dragstart` on the nearest draggable ancestor, then `dragenter`, a
//     `dragover` at the point where the drag enters the target's box, a second at its centre,
//     `dragleave`, `drop`, `dragend`. Cancelling `dragstart` aborts the drag, and the drop happens
//     only when the LAST `dragover` was cancelled — that is the "am I a drop target" contract.
//
// Every step fires the Pointer Event before its mouse compat event, exactly as a real browser does:
// a modern drag library binds `pointerdown` whenever `PointerEvent` exists (SortableJS does) and
// would never see a mouse-only gesture. The whole sequence is dispatched as a trusted user action
// (like the Ruby-driven click path), so `isTrusted` guards and per-listener microtask drains behave
// the way they do for a real gesture.

import { NODE_ELEMENT }               from './constants.js';
import { pointerRectOf, ensureInView } from './layout.js';
import { dispatchEventForUserAction } from './dispatch.js';
import { pointerEventInit }           from './events.js';

// The box a pointer coordinate is measured against: the element's FIRST client rect, which is
// what WebDriver measures its in-view centre point on. For anything but an inline that wrapped
// it is the bounding box; for one that did, the bounding box's centre is the text BETWEEN its
// two lines, and a drag would start on the paragraph rather than on the link.
function dragRect(el) { return pointerRectOf(el); }

function rectCenter(r) { return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }

// Where a straight line from `pt` to the centre of `rect` crosses the rect's border — the point at
// which a drag coming from `pt` first enters the box. Falls back to `pt` when the line degenerates
// (identical centres), which only happens for a self-drag.
function pointOnRect(pt, rect) {
  const c = rectCenter(rect);
  const left = rect.x, right = rect.x + rect.width, top = rect.y, bottom = rect.y + rect.height;
  const slope = (c.y - pt.y) / (c.x - pt.x);
  if (pt.x <= c.x) {
    const y = slope * (left - pt.x) + pt.y;
    if (top <= y && y <= bottom) return { x: left, y };
  }
  if (pt.x >= c.x) {
    const y = slope * (right - pt.x) + pt.y;
    if (top <= y && y <= bottom) return { x: right, y };
  }
  if (pt.y <= c.y) {
    const x = (top - pt.y) / slope + pt.x;
    if (left <= x && x <= right) return { x, y: top };
  }
  if (pt.y >= c.y) {
    const x = (bottom - pt.y) / slope + pt.x;
    if (left <= x && x <= right) return { x, y: bottom };
  }
  return { x: pt.x, y: pt.y };
}

// A pointer event's coordinate set. `clientX/Y` are viewport coords; `pageX/Y` add the document
// scroll, and `screenX/Y` mirror the viewport (no window chrome modelled).
function pointInit(pt) {
  const doc = globalThis.document;
  const root = doc && doc.documentElement;
  const sx = (root && root.scrollLeft) || 0, sy = (root && root.scrollTop) || 0;
  return {
    clientX: pt.x,      clientY: pt.y,
    pageX:   pt.x + sx, pageY:   pt.y + sy,
    screenX: pt.x,      screenY: pt.y
  };
}

// One step of the gesture: the Pointer Event, then its mouse compat event (the order a real browser
// fires them in). Returns the mouse event so callers can read its `defaultPrevented`.
const POINTER_TYPES = { mousedown: 'pointerdown', mousemove: 'pointermove', mouseup: 'pointerup' };
function firePointerStep(target, mouseType, pt, extra) {
  const init = Object.assign(
    { bubbles: true, cancelable: true, button: mouseType === 'mousemove' ? -1 : 0,
      buttons: mouseType === 'mouseup' ? 0 : 1 },
    pointInit(pt), extra || {}
  );
  dispatchEventForUserAction(target, new globalThis.PointerEvent(
    POINTER_TYPES[mouseType], pointerEventInit(init, mouseType === 'mouseup' ? 0 : 0.5)));
  // The compat mouse event carries the real button (a move has none pressed to report as `button`).
  const ev = new globalThis.MouseEvent(mouseType, Object.assign({}, init, { button: mouseType === 'mousemove' ? 0 : init.button }));
  dispatchEventForUserAction(target, ev);
  return ev;
}

function fireDrag(target, type, pt, dt, extra) {
  const ev = new globalThis.DragEvent(type, Object.assign(
    { bubbles: true, cancelable: true }, pointInit(pt), extra || {}
  ));
  ev.dataTransfer = dt;
  dispatchEventForUserAction(target, ev);
  return ev;
}

// The nearest ancestor-or-self that is `draggable` — the element a browser would actually drag
// (`draggable` defaults to true for `<img>` and for `<a href>`, so a link drags itself).
function draggableAncestor(el) {
  for (let n = el; n && n.nodeType === NODE_ELEMENT; n = n._parent) if (n.draggable) return n;
  return null;
}

// A drag takes TIME. Between the press and the drop a real browser runs the page's timers and
// microtasks, and libraries use that gap: SortableJS applies its ghost class from a `setTimeout`
// scheduled in `dragstart`, and never reaches its reorder logic if `dragover` arrives in the same
// synchronous turn. So the gesture is staged — the driver settles between stages, which is what the
// reference model's `delay` between steps buys.
let pending = null;

// Stage 1: press the pointer on the source and decide the mode. The press doubles as the sniff — a
// page that cancels it (jQuery UI draggable does) has taken over the pointer, so a drag-event
// sequence would be wrong, and a source with no draggable ancestor can't produce one at all.
// `opts.modifiers` is a `{altKey: true, …}` map held down for the drop (Capybara's
// `drop_modifiers:`); `opts.html5` forces a mode when the caller knows better.
export function dragBegin(source, target, opts) {
  pending = null;
  if (!source || !target || source.nodeType !== NODE_ELEMENT || target.nodeType !== NODE_ELEMENT) return false;
  const modifiers = (opts && opts.modifiers) || {};
  ensureInView(source);
  const sourcePt = rectCenter(dragRect(source));

  const down = firePointerStep(source, 'mousedown', sourcePt);
  const dragSource = draggableAncestor(source);
  const html5 = (opts && opts.html5 != null) ? !!opts.html5 : (!down.defaultPrevented && !!dragSource);
  pending = { source: html5 ? (dragSource || source) : source, target, sourcePt, modifiers, html5, dt: null, accepted: false };

  if (!html5) return true;
  const dt = pending.dt = new globalThis.DataTransfer();
  // A link / image drag seeds the data store with its URL, like the UA does.
  const src = pending.source;
  if (src._tag === 'a' && src.href)  { dt.setData('text/uri-list', src.href); dt.setData('text', src.href); }
  if (src._tag === 'img' && src.src) { dt.setData('text/uri-list', src.src);  dt.setData('text', src.src); }
  // Cancelling `dragstart` aborts the drag: no drag events follow, and the press is released.
  if (fireDrag(src, 'dragstart', sourcePt, dt).defaultPrevented) {
    firePointerStep(src, 'mouseup', sourcePt, modifiers);
    pending = null;
  }
  return true;
}

// Stage 2: move onto the target. Two positions — entering its box, then its centre — so a handler
// that reacts to direction (and any start threshold, jQuery UI's default is 1px) sees real movement.
export function dragMove() {
  if (!pending) return false;
  const { target, sourcePt, modifiers, html5, dt } = pending;
  ensureInView(target);
  const targetRect = dragRect(target);
  const entry  = pointOnRect(sourcePt, targetRect);
  const centre = pending.centre = rectCenter(targetRect);
  if (!html5) {
    firePointerStep(target, 'mousemove', entry,  modifiers);
    firePointerStep(target, 'mousemove', centre, modifiers);
    return true;
  }
  fireDrag(target, 'dragenter', entry, dt, modifiers);
  fireDrag(target, 'dragover',  entry, dt, modifiers);
  // The second dragover is the one that counts: HTML re-evaluates the drag operation on EVERY
  // dragover (an uncancelled one resets it to "none"), so the last answer decides the drop — and its
  // coordinates are the ones dragleave / drop / dragend carry.
  pending.accepted = fireDrag(target, 'dragover', centre, dt, modifiers).defaultPrevented;
  return true;
}

// Stage 3: release. The gesture that began with a press has to finish with one, either mode.
export function dragFinish() {
  if (!pending) return false;
  const { source, target, modifiers, html5, dt, accepted } = pending;
  const centre = pending.centre || rectCenter(dragRect(target));
  pending = null;
  if (!html5) { firePointerStep(target, 'mouseup', centre, modifiers); return true; }
  fireDrag(target, 'dragleave', centre, dt, modifiers);
  if (accepted) fireDrag(target, 'drop', centre, dt, modifiers);
  fireDrag(source, 'dragend', centre, dt, modifiers);
  firePointerStep(target, 'mouseup', centre, modifiers);
  return true;
}
