// HTML autofocus (§6.6.7) — the engine's (autofocus.rs: each top-level document's candidates, the processed flag, which
// candidate is next); here only the hooks that feed it, the rendering update's flush, which asks the style engine
// whether a candidate can take focus, and the wake-up a page with nothing else to render needs for one.

import { styleEngineFocusable, styleEngineFocusableArea } from './cascade.js';
import { isConnected } from './walk.js';
import { NODE_ELEMENT } from './constants.js';
import { wakeLoop } from './timers.js';
import { attrsOf, nidOf, nodeTypeOf } from './node-identity.js';

// The top-level document of `doc`'s navigable — none where it has no navigable (a template's, a DOMParser's document).
function topDocumentOf(doc) {
  const view = doc && doc._window;
  if (!view) return null;
  try { return view.top.document; } catch (_) { return null; }
}

// The autofocus insertion steps, for inserted nodes (`autofocus_insert`: the elements carrying `autofocus` among their
// shadow-including descendants), and the parser's for one it inserts.
// (…none asked before any element has carried `autofocus`, in whichever realm: the engine's flag, `autofocusSeen`)
export function autofocusInsertionSteps(nodes) {
  if (globalThis.__dom.autofocusSeen[0] === 0) return;
  for (let i = 0; i < nodes.length; i++) insertCandidates(nodes[i]);
}
export function parserAutofocusStep(el) {
  if (globalThis.__dom.autofocusSeen[0] !== 0 && nodeTypeOf(el) === NODE_ELEMENT && attrsOf(el).autofocus != null) insertCandidates(el);
}
function insertCandidates(node) {
  if (!node || nidOf(node) == null || !isConnected(node)) return;
  const top = topDocumentOf(node._ownerDocument);
  // (…a rendering update to come, the engine's to remember — `autofocusPending` — and a page with nothing else pending
  // runs one for it)
  if (!top || !globalThis.__dom.autofocusInsert(nidOf(top), nidOf(node))) return;
  wakeLoop();
}

// The top-level document of `doc`'s autofocus is processed (the dialog focusing steps): no candidate takes focus after.
export function autofocusProcessed(doc) {
  const top = topDocumentOf(doc);
  if (!top) return;
  globalThis.__dom.autofocusProcessed(nidOf(top));
}

// HTML "flush autofocus candidates" for the top-level document `doc`: the engine's next candidate, focused — itself,
// or the focusable area it stands for (a shadow host delegating focus) — where its document is still a fully active one
// under `doc`, none of the documents of the navigables up to it is at a fragment, and it can take focus; else the one
// after.
export function flushAutofocusCandidates(doc) {
  const focused = doc._activeElement != null;
  for (let answer; (answer = globalThis.__dom.autofocusNext(nidOf(doc), focused)) !== undefined;) {
    const el = answer[0];
    const own = el && el._ownerDocument;
    if (!own || topDocumentOf(own) !== doc || globalThis.__dom.atFragment(...navigableDocuments(own))) continue;
    const target = styleEngineFocusable(el) ? el : styleEngineFocusableArea(el);
    if (!target) continue;
    autofocusProcessed(doc);
    target._focus();
    return;
  }
}
// The nids of `doc` and the documents of its ancestor navigables, up to the top-level one.
function navigableDocuments(doc) {
  const out = [];
  for (let d = doc; d; ) {
    if (nidOf(d) != null) out.push(nidOf(d));
    let frame = null;
    try { frame = d._window && d._window.frameElement; } catch (_) {}
    d = frame ? frame._ownerDocument : null;
  }
  return out;
}
