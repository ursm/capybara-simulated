// The CSS animation and transition EVENTS: what the style engine's rendering update owes for the animations and
// transitions it runs, fired from the rendering update, where a browser fires them — so they arrive in frame order
// rather than at the moment a style is written. A page waits for a transition by listening for `transitionend`, not by
// reading a computed value: Bootstrap's modal, Turbo's frame swaps and every "fade it out then remove it" helper are
// written that way. (The objects — `CSSAnimation` / `CSSTransition` — are the engine's handles, web-animations-engine.js.)
import { onAnimationEvents } from './animation.js';
import { AnimationEvent, TransitionEvent, listensForAnimationEvent } from './events.js';
import { tickStyleEngine } from './cascade.js';
import { walkInclShadow } from './walk.js';
import { dispatchEngineAnimationEvents, engineAnimationHandle } from './web-animations-engine.js';

// The style engine's rendering update (`tickStyleEngine`): its animations move to the clock, the document is styled,
// and the events their state changes owe arrive as [type, nid, pseudo, name, elapsedTime, animation, scheduled, …] —
// each to be fired at its element (the originating one for a pseudo-element's), found by one walk of the document and
// its shadow trees, with the `CSSAnimation` / `CSSTransition` it is about (`event.animation`). They are not fired here:
// they join the Web Animations' playback events in the one queue the update dispatches (`dispatchEngineAnimationEvents`).
function styleEngineEvents() {
  return cssEventRecords(tickStyleEngine());
}
// …and those queued since, without moving anything: what the update's microtask checkpoint queued.
function queuedStyleEngineEvents() {
  return cssEventRecords(globalThis.__dom.styleTakeAnimationEvents());
}
function cssEventRecords(events) {
  const doc = globalThis.document;
  if (!doc || !events || !events.length) return [];
  const wanted = new globalThis.Set();
  for (let i = 1; i < events.length; i += 7) wanted.add(events[i]);
  const byNid = new globalThis.Map();
  walkInclShadow(doc, (node) => { if (wanted.has(node._nid)) byNid.set(node._nid, node); });
  const records = [];
  for (let i = 0; i < events.length; i += 7) {
    const [type, nid, pseudo, name, elapsed, id, scheduled] = events.slice(i, i + 7);
    const target = byNid.get(nid);
    if (!target) continue;
    records.push({
      scheduled,
      id,
      // (its animation's class in composite order as it was when the event was queued — a transition's 0, a CSS
      // animation's 1 — which places it where the engine no longer can: a completed transition nothing holds is gone)
      kind: type.startsWith('transition') ? 0 : 1,
      dispatch() {
        // (…its object made only where something listens for its type: a page that transitions a thousand elements at
        // once and hears none of it makes none.)
        const animation = listensForAnimationEvent(type) ? engineAnimationHandle(id, target) : null;
        const init = { elapsedTime: elapsed, pseudoElement: pseudo || '', bubbles: true, cancelable: false, animation };
        target.dispatchEvent(type.startsWith('transition')
          ? new TransitionEvent(type, { ...init, propertyName: name })
          : new AnimationEvent(type, { ...init, animationName: name }));
      }
    });
  }
  return records;
}

// Once per event-loop step (`flushAnimationFrame`) — in a document realm: a worker has no style engine.
onAnimationEvents(() => {
  if (globalThis.__csimStylo === true) dispatchEngineAnimationEvents(styleEngineEvents(), queuedStyleEngineEvents);
});
