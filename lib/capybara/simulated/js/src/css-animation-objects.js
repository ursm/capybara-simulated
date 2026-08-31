// A CSS animation or transition, as an object a page can hold — `CSSAnimation` / `CSSTransition`,
// what `getAnimations()` returns, and the events they fire.
//
// The VALUE those two produce is `animation.js`'s business and stays there: this layer is a MIRROR
// of what that model is running, kept in step at each rendering update. A browser has one object
// per running animation and derives the value from it; here the value came first and the object is
// derived from it, which is the same set of facts observed from the other end.
//
// Why it matters beyond conformance: a page waits for a transition by listening for
// `transitionend`, not by reading a computed value. Bootstrap's modal, Turbo's frame swaps and
// every "fade it out then remove it" helper are written that way, and until these events existed
// each of them waited for something that never came.
//
// The events are fired from the RENDERING UPDATE, where a browser fires them, so they arrive in
// frame order rather than at the moment a style is written — and transitions before animations,
// which is their composite order.
import { NODE_ELEMENT } from './constants.js';
import { animationNow, computedTimingAt, cssAnimationsOf, cssTransitionsOf,
         runningElements, forgetRunningElement, noteRunningElement, onCssObjects,
         longhandsOf } from './animation.js';
import { Animation, KeyframeEffect, registerCssAnimation, forgetCssAnimation,
         onGetAnimationsSync } from './web-animations.js';
import { AnimationEvent, TransitionEvent } from './events.js';
import { declaredValue } from './style-proxy.js';
import { elementsDeclaring, cascadeStyleEpoch, declaredPropertyNamesFor,
         documentMayTransition, documentHasKeyframes } from './cascade.js';
import { takeMutatedNodes } from './mutation-observer.js';

// ── The objects ──────────────────────────────────────────────────────────────────────────────
// A CSS-owned animation differs from a scripted one in exactly two ways: it names the rule that
// created it, and it does not APPLY its own value — the cascade layer that made it already did.
export class CSSAnimation extends Animation {
  get animationName() { return this._cssName || ''; }
}
export class CSSTransition extends Animation {
  get transitionProperty() { return this._cssName || ''; }
}

// One object per (element, animation name) and per (element, transitioned property), so the same
// `Animation` comes back from `getAnimations()` for as long as the thing it mirrors keeps running —
// a page that stores the object and later reads it must be holding the right one.
function objectsOn(el) {
  return el._csimCssAnims || (el._csimCssAnims = new globalThis.Map());
}

function mirror(el, kind, name, timing, startTime, keyframes) {
  const key = kind + ':' + name;
  const objects = objectsOn(el);
  let anim = objects.get(key);
  if (!anim) {
    // The keyframes are built ONLY here — a thunk, because this runs every frame for every animated
    // element and the list is needed once.
    const effect = new KeyframeEffect(el, typeof keyframes === 'function' ? keyframes() : keyframes, timing);
    anim = new (kind === 'animation' ? CSSAnimation : CSSTransition)(effect);
    anim._cssName = name;
    anim._cssOwned = true;            // the value is the cascade's; this object only reports it
    objects.set(key, anim);
    registerCssAnimation(anim);
  }
  // …and script may have taken the effect away (`anim.effect = null` is a thing a page can do to
  // one of these objects), in which case it gets a fresh one rather than a crash.
  if (!anim._effect) {
    anim._effect = new KeyframeEffect(el, typeof keyframes === 'function' ? keyframes() : keyframes, timing);
    anim._effect._animation = anim;
  }
  // The timing and the start time are the cascade's at every frame: a page can restyle an
  // animation mid-flight, and the object has to follow rather than keep what it was made with.
  //
  // Which is also the limit of what a page can do with one of these: it can HOLD a `CSSAnimation`
  // and read it, but pausing or seeking it is undone at the next rendering update, because the
  // cascade is still the thing that says where it is. A CSS animation that script has taken over
  // is its own piece of work (web-animations §"An animation's owning element").
  Object.assign(anim._effect._timing, timing);
  anim._startTime = startTime;
  anim._holdTime = null;
  anim._idle = false;
  anim._paused = false;
  return anim;
}

// ── Events ───────────────────────────────────────────────────────────────────────────────────
// An animation's PHASE — before / active / after — is what its events are about: entering the
// active phase starts it, leaving it ends it, and an iteration boundary crossed inside it is an
// `animationiteration` (css-animations §4). Answered by the ONE timing ladder rather than a second
// copy of it here — a copy had already drifted (no `iterationStart`, and `0 * Infinity` for a
// zero-duration infinite animation left it permanently 'active').
function phaseOf(timing, localTime) {
  return computedTimingAt(timing, localTime).phase;
}

const elapsedSeconds = (ms) => Math.max(0, ms) / 1000;

// Where an object stands at `now` by its OWN timing — asked when the model has already dropped what
// it mirrored, to tell an animation that ran out from one that was taken away.
function finalPhaseOf(anim, now) {
  const timing = anim._effect && anim._effect._timing;
  if (!timing || anim._startTime == null) return 'idle';
  return phaseOf(timing, now - anim._startTime);
}
// How long a cancelled animation had been running — its `elapsedTime`, which is the ACTIVE time at
// the moment it was cancelled and not zero (Chrome-measured: an animation cancelled a frame into a
// 300ms run reports 0.127, not 0).
function activeElapsed(anim, now) {
  const timing = anim._effect && anim._effect._timing;
  if (!timing || anim._startTime == null) return 0;
  return Math.max(0, now - anim._startTime - (timing.delay || 0));
}
function activeDurationOf(anim) {
  const t = anim._effect && anim._effect._timing;
  if (!t) return 0;
  return t.duration * (t.iterations === Infinity ? 1 : t.iterations);
}

// The events one animation owes since the last rendering update, from the phase it was in then to
// the phase it is in now. `startElapsed` is what a NEGATIVE delay skipped past: `animationstart`
// says how far in the animation began (Chrome-measured: `grow 300ms linear -100ms` starts at 0.1).
function animationEvents(anim, timing, was, now, localTime, startElapsed) {
  const out = [];
  const active = timing.duration * (timing.iterations === Infinity ? Infinity : timing.iterations);
  if (was !== 'active' && now === 'active') out.push(['animationstart', startElapsed]);
  if (was === 'active' && now === 'active' && timing.duration > 0) {
    // ONE event per frame, at the iteration reached — not one per boundary crossed. The event is
    // dispatched for a phase/iteration CHANGE (css-animations-2 §4.4), so a frame that spanned
    // several iterations owes one (Chrome-measured: 19 boundaries over four frames fire four
    // events, at the iterations those frames landed on).
    const from = Math.floor(Math.max(0, anim._lastLocalTime - timing.delay) / timing.duration);
    const to   = Math.floor(Math.max(0, localTime - timing.delay) / timing.duration);
    if (to > from) out.push(['animationiteration', to * timing.duration]);
  }
  if (was !== 'after' && now === 'after') {
    if (was !== 'active') out.push(['animationstart', startElapsed]);   // a step over the whole run
    out.push(['animationend', active]);
  }
  return out;
}

// …and a transition's, which name one property rather than a rule (css-transitions §6).
function transitionEvents(was, now, run) {
  const out = [];
  // …bounded by its own duration, where an animation's is not.
  const skipped = Math.min(Math.max(0, -(run.delay || 0)), run.duration);
  if (was === 'idle' && now !== 'idle') out.push(['transitionrun', skipped]);
  if (was !== 'active' && now === 'active') out.push(['transitionstart', skipped]);
  if (was !== 'after' && now === 'after') {
    if (was === 'idle') out.push(['transitionrun', skipped]);
    if (was !== 'active') out.push(['transitionstart', skipped]);
    out.push(['transitionend', run.duration]);
  }
  return out;
}

// The events BUBBLE and are not COMPOSED: a document-level listener sees one from the document
// tree, and a shadow tree's stays inside it (Chrome-measured). Each carries the object it is about,
// so a listener can reach it without going back through `getAnimations()`.
function fireAnimationEvent(el, type, name, elapsed, anim) {
  el.dispatchEvent(new AnimationEvent(type, {
    animationName: name, elapsedTime: elapsedSeconds(elapsed), pseudoElement: '',
    animation: anim || null, bubbles: true, cancelable: false
  }));
}
function fireTransitionEvent(el, type, prop, elapsed, anim) {
  el.dispatchEvent(new TransitionEvent(type, {
    propertyName: prop, elapsedTime: elapsedSeconds(elapsed), pseudoElement: '',
    transition: anim || null, bubbles: true, cancelable: false
  }));
}

// ── Bringing the objects up to date ──────────────────────────────────────────────────────────
// Without firing anything — what `getAnimations()` needs, because a page that starts a transition
// and immediately asks for it must be told about it in the same task (the WPT transitions harness
// collects `document.getAnimations()` the moment it adds the class, and then waits on each one's
// `transitionend`; with an empty list it waits for nothing and reads the values too early).
export function syncCssObjectsFor(el) {
  if (!el || el.nodeType !== NODE_ELEMENT || el.isConnected === false || !isRendered(el)) return;
  const now = animationNow();
  reconcileTransitions(el, now, false);
  reconcileAnimations(el, now, false);
}

export function syncAllCssObjects() {
  // Discovery first, and unconditionally: an animation declared in THIS task — `el.style.animation
  // = 'spin 1s'` — is not in the running set yet, and `getAnimations()` has to report it (the page
  // that just declared it is asking for it).
  findDeclaredAnimations(null, true);
  for (const el of [...runningElements()]) syncCssObjectsFor(el);
}

// A STYLE FLUSH — the layout pass, which is what a forced `offsetWidth` runs — is a style change
// event like the rendering update: it discovers what the cascade declares and records the values a
// later change will be measured against. It fires NOTHING; the events belong to the rendering
// update, which is where a browser dispatches them.
export function seedStyleFlush() {
  if (!documentHasKeyframes() && !documentMayTransition()) return;
  const changed = takeMutatedNodes();
  findDeclaredAnimations(changed);
  lookForTransitions(changed);
}
globalThis.__csimSeedStyleFlush = seedStyleFlush;

// ── The rendering update ─────────────────────────────────────────────────────────────────────
// Once per event-loop step: bring every object in line with what the model is running, and fire
// what the phase changes since the last step owe.
export function reconcileCssAnimations() {
  const changed = takeMutatedNodes();
  findDeclaredAnimations(changed);
  lookForTransitions(changed);
  const els = runningElements();
  if (!els.size) return;
  const now = animationNow();
  const alive = [];
  for (const el of [...els]) {
    // An element that is NOT RENDERED runs nothing: `display: none` on it or on an ancestor
    // cancels its transitions rather than ending them, and no new one starts there
    // (css-transitions §3 — a non-rendered element has no computed style to change).
    if (!el || el.nodeType !== NODE_ELEMENT || el.isConnected === false || !isRendered(el)) {
      cancelAll(el, now);
      continue;
    }
    alive.push(el);
  }
  // TRANSITIONS across the whole document first, then animations: they sort before animations in
  // composite order and their events arrive in that order (Chrome-measured — `transitionrun` on one
  // element precedes the `animationstart` of another in the same frame).
  const live = new globalThis.Set();
  for (const el of alive) if (reconcileTransitions(el, now)) live.add(el);
  for (const el of alive) if (reconcileAnimations(el, now)) live.add(el);
  for (const el of alive) if (!live.has(el)) retire(el);
}

// Which elements the cascade could be animating, asked once per cascade version — and again
// whenever something was mutated, because `el.classList.add('spin')` moves no epoch at all.
// Without it an animation only ever started for an element something had already read the style of,
// where a browser's style recalc finds it at the first frame.
let seenEpoch = null;
function findDeclaredAnimations(changed, force) {
  // No `@keyframes` anywhere, no animation to find — and this runs on every rendering update that
  // touched a node, so the gate is what keeps a page with none out of `querySelectorAll` entirely
  // (measured: +7.3% of a frame on a page with 4000 inline-styled elements and no keyframes).
  if (!documentHasKeyframes()) return;
  const epoch = cascadeStyleEpoch();
  if (!force && epoch === seenEpoch && !changed.nodes.length && !changed.overflow) return;
  seenEpoch = epoch;
  for (const el of elementsDeclaring('animation-name')) {
    const name = declaredValue(el, 'animation-name');
    if (name && String(name).trim().toLowerCase() !== 'none') noteRunningElement(el);
  }
}

// A transition is started by a CHANGE, and the model only sees a change where something reads the
// property. So the elements that were mutated since the last update have their transitionable
// properties READ here — a style recalc of exactly what changed, which is what a browser does to
// the same end. Without it a page that toggles a class and waits for `transitionend` waits forever.
let seenTransEpoch = null;
function lookForTransitions(changed) {
  if (!documentMayTransition()) return;
  // A change is only visible against a BEFORE, so the elements that declare a transition are read
  // once when the rule set settles — that reading is what records the value the next change will be
  // measured against.
  const epoch = cascadeStyleEpoch();
  const seeding = epoch !== seenTransEpoch;
  if (seeding) seenTransEpoch = epoch;
  const nodes = seeding || changed.overflow
              ? elementsDeclaring('transition-property').concat(changed.nodes)
              : changed.nodes;
  for (const node of nodes) {
    if (!node || node.nodeType !== NODE_ELEMENT || node.isConnected === false) continue;
    if (!isRendered(node)) continue;               // nothing transitions on an unrendered element
    const props = transitionedProperties(node);
    if (!props) continue;
    for (const prop of props) declaredValue(node, prop);      // the read IS the change detection
  }
}

// Which properties this element could transition: the ones its own `transition-property` names —
// expanded to LONGHANDS, since it is the longhands that transition — or, for `all`, the properties
// the document declares at all.
function transitionedProperties(el) {
  const declared = declaredValue(el, 'transition-property');
  if (!declared) return null;
  const names = String(declared).split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (!names.length || names.every((n) => n === 'none')) return null;
  if (names.includes('all')) return declaredPropertyNamesFor(el);
  const out = [];
  for (const name of names) {
    if (name === 'none' || name === 'all') continue;
    for (const lh of longhandsOf(name)) out.push(lh);
  }
  return out;
}

function isRendered(el) {
  return !globalThis.__isLaidOutNode || globalThis.__isLaidOutNode(el);
}

function retire(el) {
  forgetRunningElement(el);
  if (!el || !el._csimCssAnims) return;
  for (const anim of el._csimCssAnims.values()) { forgetCssAnimation(anim); anim._idle = true; }
  el._csimCssAnims = null;
}

// …and the same, but telling anything still running that it was CANCELLED — which is what stopping
// an element from being rendered does to it.
function cancelAll(el, now) {
  const objects = el && el._csimCssAnims;
  if (objects) for (const [key, anim] of objects) {
    const running = anim._cssPhase && anim._cssPhase !== 'after';
    if (running && el.isConnected !== false) {
      const elapsed = activeElapsed(anim, now);
      if (key.startsWith('transition:')) fireTransitionEvent(el, 'transitioncancel', anim._cssName, elapsed, anim);
      else fireAnimationEvent(el, 'animationcancel', anim._cssName, elapsed, anim);
    }
  }
  // The model's own runs go too, or the element resumes mid-transition when it is shown again.
  if (el && el._csimTrans) el._csimTrans.runs.clear();
  retire(el);
}

function reconcileAnimations(el, now, fire = true) {
  const records = cssAnimationsOf(el, declaredValue);
  const objects = objectsOn(el);
  const seen = new globalThis.Set();
  if (records) for (const record of records) seen.add('animation:' + record.name);
  // The CANCELLATIONS first: replacing a running animation owes its `animationcancel` BEFORE the
  // replacement's `animationstart` (Chrome-measured, and `event-dispatch` says so by name).
  if (fire) for (const [key, anim] of [...objects]) {
    if (!key.startsWith('animation:') || seen.has(key)) continue;
    objects.delete(key);
    forgetCssAnimation(anim);
    const ended = finalPhaseOf(anim, now) === 'after';
    anim._idle = true;
    if (anim._cssPhase && anim._cssPhase !== 'idle' && anim._cssPhase !== 'after') {
      // One that RAN OUT ends; one the cascade stopped naming part way through is cancelled
      // (css-animations §4.4).
      if (ended) fireAnimationEvent(el, 'animationend', anim._cssName, activeDurationOf(anim), anim);
      else fireAnimationEvent(el, 'animationcancel', anim._cssName, activeElapsed(anim, now), anim);
    }
  }
  if (records) for (const record of records) {
    const timing = { duration: record.duration, delay: 0, endDelay: 0, iterationStart: 0,
                     iterations: record.iterations, direction: record.direction,
                     fill: record.fill, easing: record.easing };
    const anim = mirror(el, 'animation', record.name, timing, record.startTime, () => keyframesOf(record));
    const localTime = now - record.startTime;
    const skipped = Math.max(0, -record.delay);      // what a negative delay skipped past
    const was = anim._cssPhase || 'idle';
    const phase = phaseOf(timing, localTime);
    if (fire) {
      for (const [type, elapsed] of animationEvents(anim, timing, was, phase, localTime, skipped)) {
        fireAnimationEvent(el, type, record.name, elapsed, anim);
      }
      anim._cssPhase = phase;
      anim._lastLocalTime = localTime;
    }
    // An animation that has RUN OUT and holds no value is no longer one of the element's: a
    // finished `fill: none` animation is not reported by `getAnimations()` (Chrome-measured).
    anim._cssRelevant = phase !== 'after' || record.fill === 'forwards' || record.fill === 'both';
  }
  return !!(records && records.length);
}

function reconcileTransitions(el, now, fire = true) {
  const runs = cssTransitionsOf(el);
  const objects = objectsOn(el);
  const seen = new globalThis.Set();
  // A run REPLACED by another under the same property — a reversal, or a redirection to a third
  // value — is a new transition, and the one it replaced was cancelled. The model gives each run an
  // id; a mirror holding a different one is retired first, so the page is told (Chrome-measured:
  // `transitioncancel` then a fresh `transitionrun` / `transitionstart`).
  if (runs && fire) for (const { property, run } of runs) {
    const existing = objects.get('transition:' + property);
    if (!existing || existing._runId === run.id) continue;
    objects.delete('transition:' + property);
    forgetCssAnimation(existing);
    existing._idle = true;
    if (existing._cssPhase && existing._cssPhase !== 'after') {
      fireTransitionEvent(el, 'transitioncancel', existing._cssName, activeElapsed(existing, now), existing);
    }
  }
  if (runs) for (const { property, run } of runs) {
    const key = 'transition:' + property;
    seen.add(key);
    const timing = { duration: run.duration, delay: run.delay, endDelay: 0, iterationStart: 0,
                     iterations: 1, direction: 'normal', fill: 'backwards', easing: run.easing };
    const anim = mirror(el, 'transition', property, timing, run.start, null);
    anim._runId = run.id;
    const localTime = now - run.start;
    const was = anim._cssPhase || 'idle';
    const phase = phaseOf(timing, localTime);
    if (fire) {
      for (const [type, elapsed] of transitionEvents(was, phase, run)) {
        fireTransitionEvent(el, type, property, elapsed, anim);
      }
      anim._cssPhase = phase;
      anim._lastLocalTime = localTime;
    }
  }
  if (!fire) return !!(runs && runs.length);
  // A run the model has retired either ARRIVED or was replaced, and the two owe different events.
  // The model drops an arrived run as soon as a read passes its end, so the reconciler may never
  // see it in the after phase — the object's own timing says which happened.
  for (const [key, anim] of [...objects]) {
    if (!key.startsWith('transition:') || seen.has(key)) continue;
    objects.delete(key);
    forgetCssAnimation(anim);
    const ended = finalPhaseOf(anim, now) === 'after';
    anim._idle = true;
    if (anim._cssPhase !== 'after') {
      if (ended) {
        if (anim._cssPhase !== 'active') {
          if (!anim._cssPhase || anim._cssPhase === 'idle') fireTransitionEvent(el, 'transitionrun', anim._cssName, 0, anim);
          fireTransitionEvent(el, 'transitionstart', anim._cssName, 0, anim);
        }
        fireTransitionEvent(el, 'transitionend', anim._cssName, activeDurationOf(anim), anim);
      } else {
        fireTransitionEvent(el, 'transitioncancel', anim._cssName, activeElapsed(anim, now), anim);
      }
    }
  }
  return !!(runs && runs.length);
}

// The keyframes an animation's object reports — the offsets and the properties, without the values
// the cascade resolves per element (`getKeyframes()` on a CSS animation reports computed values,
// which this layer does not collect; the offsets and property names are what a page reads).
function keyframesOf(record) {
  const frames = [];
  for (const block of record.blocks) {
    for (const offset of block.offsets) {
      const frame = { offset };
      for (const d of block.decls) if (!d.important) frame[d.prop] = d.value;
      frames.push(frame);
    }
  }
  return frames.sort((a, b) => a.offset - b.offset);
}

// ── Telling the event loop there is something to wait for ────────────────────────────────────
// A page waiting on a running transition has no timer and no rAF, so to the event loop it looks
// exactly like a dead one — and the runner, seeing an idle page, force-jumps the clock to its
// timeout horizon. The transition's end then lands wherever that jump happens to put it, which is
// how a 2s transition's `transitionend` arrived at t=12392 and at t=60000 (measured).
//
// So the loop is told when the next animation event is DUE, the same way a pending timer tells it.
// Only finite ones: an infinite animation's next iteration boundary would keep the page
// permanently non-idle, which is a different lie.
export function nextCssEventDelay() {
  const now = animationNow();
  let best = -1;
  for (const el of runningElements()) {
    const objects = el && el._csimCssAnims;
    if (!objects) continue;
    for (const anim of objects.values()) {
      const timing = anim._effect && anim._effect._timing;
      if (!timing || anim._startTime == null) continue;
      if (!Number.isFinite(timing.iterations)) continue;
      const local = now - anim._startTime;
      const delay = Number(timing.delay) || 0;
      const active = timing.duration * timing.iterations;
      for (const at of [delay, delay + active]) {
        const until = at - local;
        if (until >= 0 && (best < 0 || until < best)) best = until;
      }
      // …and the next iteration boundary, which owes an `animationiteration`.
      if (timing.duration > 0 && local >= delay && local < delay + active) {
        const done = Math.floor((local - delay) / timing.duration);
        const until = delay + (done + 1) * timing.duration - local;
        if (until >= 0 && (best < 0 || until < best)) best = until;
      }
    }
  }
  return best;
}
globalThis.__csimNextCssEventDelay = nextCssEventDelay;

onCssObjects(reconcileCssAnimations);
onGetAnimationsSync(syncAllCssObjects);
