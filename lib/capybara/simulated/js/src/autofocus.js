// HTML autofocus (§6.6.7) — the engine's (autofocus.rs: each top-level document's candidates and its processed flag;
// focus_update.rs: the rendering update's flush); here only the insertion steps' hooks that feed it, and the wake-up a
// page with nothing else to render needs for one.

import { NODE_ELEMENT } from './constants.js';
import { wakeLoop } from './timers.js';
import { attrsOf, nidOf, nodeTypeOf } from './node-identity.js';
import { dom } from './engine.js';

// The autofocus insertion steps, for inserted nodes (`autofocus_insert`: the elements carrying `autofocus` among their
// shadow-including descendants), and the parser's for one it inserts.
// (…none asked before any element has carried `autofocus`, in whichever realm: the engine's flag, `autofocusSeen`)
export function autofocusInsertionSteps(nodes) {
  if (dom.autofocusSeen[0] === 0) return;
  for (let i = 0; i < nodes.length; i++) insertCandidates(nodes[i]);
}
export function parserAutofocusStep(el) {
  if (dom.autofocusSeen[0] !== 0 && nodeTypeOf(el) === NODE_ELEMENT && attrsOf(el).autofocus != null) insertCandidates(el);
}
// (…a rendering update to come, the engine's to remember, and a page with nothing else pending runs one for it)
function insertCandidates(node) {
  const nid = nidOf(node);
  if (nid != null && dom.autofocusInsert(nid)) wakeLoop();
}
