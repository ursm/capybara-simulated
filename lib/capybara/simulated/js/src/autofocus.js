// HTML autofocus (§6.6.7) — the engine's (autofocus.rs: each top-level document's candidates, the processed flag, which
// candidate is next); here only the hooks that feed it, the rendering update's flush, which asks the style engine
// whether a candidate can take focus, and the wake-up a page with nothing else to render needs for one.

import { styleEngineFocusable, styleEngineFocusableArea } from './cascade.js';
import { isConnected } from './walk.js';
import { nodesAtPaths } from './native-query-shadow.js';
import { NODE_ELEMENT } from './constants.js';
import { wakeLoop } from './timers.js';

// Whether any element has ever carried `autofocus`: no insertion asks the engine before one has.
let autofocusSeen = false;
export function noteAutofocus() { autofocusSeen = true; }

// The top-level document of `doc`'s navigable — none where it has no navigable (a template's, a DOMParser's document).
function topDocumentOf(doc) {
  const view = doc && doc.defaultView;
  if (!view) return null;
  try { return view.top.document; } catch (_) { return null; }
}

// The autofocus insertion steps, for inserted nodes (`autofocus_insert`: the elements carrying `autofocus` among their
// shadow-including descendants), and the parser's for one it inserts.
export function autofocusInsertionSteps(nodes) {
  if (!autofocusSeen) return;
  for (let i = 0; i < nodes.length; i++) insertCandidates(nodes[i]);
}
export function parserAutofocusStep(el) {
  if (autofocusSeen && el._nodeType === NODE_ELEMENT && el._attrs.autofocus != null) insertCandidates(el);
}
function insertCandidates(node) {
  if (!node || node._nid == null || !isConnected(node)) return;
  const top = topDocumentOf(node.ownerDocument);
  if (!top || !globalThis.__dom.autofocusInsert(top._nid, node._nid)) return;
  // (…a rendering update to come: a page with nothing else pending runs one for it)
  top._autofocusPending = true;
  wakeLoop();
}

// The top-level document of `doc`'s autofocus is processed (the dialog focusing steps): no candidate takes focus after.
export function autofocusProcessed(doc) {
  const top = topDocumentOf(doc);
  if (!top) return;
  globalThis.__dom.autofocusProcessed(top._nid);
  top._autofocusPending = false;
}

// HTML "flush autofocus candidates" for the top-level document `doc`: the engine's next candidate, focused — itself,
// or the focusable area it stands for (a shadow host delegating focus) — where it can take focus, else the one after.
export function flushAutofocusCandidates(doc) {
  doc._autofocusPending = false;
  const focused = doc._activeElement != null;
  for (let answer; (answer = globalThis.__dom.autofocusNext(doc._nid, focused)) !== undefined;) {
    const el = nodesAtPaths(doc, answer)[0];
    const target = el && (styleEngineFocusable(el) ? el : styleEngineFocusableArea(el));
    if (!target) continue;
    autofocusProcessed(doc);
    target._focus();
    return;
  }
}
