// The CSS animation and transition EVENTS: what the style engine's rendering update owes for the animations and
// transitions it runs, fired from the rendering update, where a browser fires them — so they arrive in frame order
// rather than at the moment a style is written. A page waits for a transition by listening for `transitionend`, not by
// reading a computed value: Bootstrap's modal, Turbo's frame swaps and every "fade it out then remove it" helper are
// written that way. (The objects — `CSSAnimation` / `CSSTransition` — are the engine's handles, web-animations-engine.js.)
import { onAnimationEvents } from './animation.js';
import { AnimationEvent, TransitionEvent, listensForAnimationEvent } from './events.js';
import { fireEvent } from './dispatch.js';
import { tickStyleEngine } from './cascade.js';
import { nodesByNid } from './native-query-shadow.js';
import { dispatchEngineAnimationEvents, engineAnimationHandle } from './web-animations-engine.js';

// The CSS events among the document's pending animation events `events` (`__dom.styleTakeAnimationEvents`: [type, nid,
// pseudo, name, elapsedTime, animation, …] — a playback event's nid -1), each fired, given its index, at its element
// (the originating one for a pseudo-element's), found by one walk of the document and its shadow trees, with the
// `CSSAnimation` / `CSSTransition` it is about (`event.animation`) — in the one queue the Web Animations' playback events
// are in, which the update dispatches (`dispatchEngineAnimationEvents`).
function cssEventFirer(events) {
  const doc = globalThis.document;
  const wanted = [];
  for (let i = 1; i < events.length; i += 7) if (events[i] >= 0) wanted.push(events[i]);
  const byNid = doc && wanted.length ? nodesByNid(doc, Float64Array.from(wanted)) : new Map();
  return (i) => {
    const [type, nid, pseudo, name, elapsed, id] = events.slice(i, i + 6);
    const target = byNid.get(nid);
    if (!target) return;
    // (…its object made only where something listens for its type: a page that transitions a thousand elements at
    // once and hears none of it makes none.)
    const animation = listensForAnimationEvent(type) ? engineAnimationHandle(id, target) : null;
    const init = { elapsedTime: elapsed, pseudoElement: pseudo || '', bubbles: true, cancelable: false, animation };
    fireEvent(target, type.startsWith('transition')
      ? new TransitionEvent(type, { ...init, propertyName: name })
      : new AnimationEvent(type, { ...init, animationName: name }));
  };
}

// Once per event-loop step (`flushAnimationFrame`) — in a document realm: a worker has no style engine — the style
// engine's rendering update (`tickStyleEngine`: its animations move to the clock, the document is styled), then the
// events it owes.
onAnimationEvents(() => {
  if (globalThis.__csimStylo !== true) return;
  tickStyleEngine();
  dispatchEngineAnimationEvents(cssEventFirer);
});
