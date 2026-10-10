// HTML autofocus (§6.6.7): an element carrying `autofocus` inserted into a document is a candidate of its top-level
// document's; the rendering update focuses the first candidate that can take focus — once a document: then, or once
// anything has taken focus, or a dialog has run its focusing steps, the document's autofocus is processed and nothing
// more is. A candidate in a document scrolled to a fragment (its `:target`) is passed over.

import { styleEngineFocusable, styleEngineFocusableArea } from './cascade.js';
import { isConnected } from './walk.js';
import { selectAll } from './selectors.js';
import { NODE_ELEMENT } from './constants.js';

// Whether any element has ever carried `autofocus`: no insertion looks for a candidate before one has.
let autofocusSeen = false;
export function noteAutofocus() { autofocusSeen = true; }

// The top-level document of `doc`'s navigable — none where it has no navigable (a template's, a DOMParser's document).
function topDocumentOf(doc) {
  const view = doc && doc.defaultView;
  if (!view) return null;
  try { return view.top.document; } catch (_) { return null; }
}

// The autofocus insertion steps, for inserted nodes: each element carrying `autofocus` in them, in tree order, appended
// to its top-level document's candidates (moved to the end where it was one already).
export function autofocusInsertionSteps(nodes) {
  if (!autofocusSeen) return;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node || node._nodeType !== NODE_ELEMENT || !isConnected(node)) continue;
    if (node._attrs.autofocus != null) addCandidate(node);
    for (const el of selectAll(node, '[autofocus]')) addCandidate(el);
  }
}
// …and the parser's, for an element it inserts — before its children are there.
export function parserAutofocusStep(el) {
  if (autofocusSeen && el._nodeType === NODE_ELEMENT && el._attrs.autofocus != null && isConnected(el)) addCandidate(el);
}
function addCandidate(el) {
  const top = topDocumentOf(el.ownerDocument);
  if (!top || top._autofocusProcessed) return;
  const list = top._autofocusCandidates || (top._autofocusCandidates = []);
  const at = list.indexOf(el);
  if (at !== -1) list.splice(at, 1);
  list.push(el);
}

// The top-level document of `doc`'s autofocus is processed: its candidates emptied, and none taken after (the dialog
// focusing steps).
export function autofocusProcessed(doc) {
  const top = topDocumentOf(doc);
  if (!top) return;
  top._autofocusCandidates = null;
  top._autofocusProcessed = true;
}

// HTML "flush autofocus candidates" for the top-level document `doc`: with focus already taken, none is; else the
// first candidate still in a document of this one's that can take focus — itself, or the focusable area it stands for
// (a shadow host delegating focus) — is focused.
export function flushAutofocusCandidates(doc) {
  const list = doc._autofocusCandidates;
  if (doc._autofocusProcessed || !list || !list.length) return;
  if (doc._activeElement) return autofocusProcessed(doc);
  while (list.length) {
    const el = list.shift();
    if (!isConnected(el) || topDocumentOf(el.ownerDocument) !== doc) continue;
    if (targetsFragment(el.ownerDocument)) continue;
    const target = styleEngineFocusable(el) ? el : styleEngineFocusableArea(el);
    if (!target) continue;
    autofocusProcessed(doc);
    target._focus();
    return;
  }
}
// (…a document scrolled to a fragment, or one of its ancestor documents: its target element is where the user goes)
function targetsFragment(doc) {
  for (let d = doc; d; ) {
    if (d.location && d.location.hash && d.querySelector(':target')) return true;
    const frame = d.defaultView && d.defaultView.frameElement;
    d = frame ? frame.ownerDocument : null;
  }
  return false;
}
