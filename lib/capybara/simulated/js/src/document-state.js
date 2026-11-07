// A document's own state, the engine's (document_state.rs) — functions of the document, as a node's own steps are
// (dom-nodes.js): no member of Document.prototype's, which a page would see and could replace.
import { nidOf } from './node-identity.js';
import { STATE_XML_DOCUMENT, foreignRealmOf, setStateBit } from './native-query-shadow.js';
import { isXmlMimeType } from './mime.js';
import { dom } from './engine.js';

// Its mode, its readiness, its flags and its markup insertion counter, by field (its currently executing script, by
// its own ops) — the XMLDocument interface's brand among the flags, which is no content type's XML-ness
// (STATE_XML_DOCUMENT, `setContentType`).
const DOC_MODE = 0, DOC_READY = 1, DOC_FLAGS = 2, DOC_INSERTIONS = 3;
const DOC_NO_BROWSING_CONTEXT = 1, DOC_CE_INITIALIZED = 2, DOC_XML_DOCUMENT_BRAND = 4;
const DOCUMENT_MODES = ['no-quirks', 'limited-quirks', 'quirks'], READY_STATES = ['loading', 'interactive', 'complete'];
const docState = (doc, field) => dom.docState(nidOf(doc), field);
const setDocState = (doc, field, value) => dom.setDocState(nidOf(doc), field, value);
const docFlag = (doc, flag) => (docState(doc, DOC_FLAGS) & flag) !== 0;
const setDocFlag = (doc, flag, on) => setDocState(doc, DOC_FLAGS, on ? docState(doc, DOC_FLAGS) | flag : docState(doc, DOC_FLAGS) & ~flag);
// …and its texts: its URL (none: its realm's), its encoding (none: UTF-8), its content type, the base URL an about: one
// inherits from its creator, its referrer — null for one not set.
const DOC_TEXT_URL = 0, DOC_TEXT_ENCODING = 1, DOC_TEXT_CONTENT_TYPE = 2, DOC_TEXT_ABOUT_BASE = 3, DOC_TEXT_REFERRER = 4;
const docText = (doc, field) => dom.docText(nidOf(doc), field);
const setDocText = (doc, field, text) => dom.setDocText(nidOf(doc), field, text);

// Its mode (DOM "document mode"), which the parser sets — quirks the one mode that is BackCompat; limited-quirks reports
// CSS1Compat as no-quirks does. (The rest of its load lifecycle is the engine's alone: document_lifecycle.rs.)
export function compatModeOf(doc) {
  return DOCUMENT_MODES[docState(doc, DOC_MODE)];
}
export function setCompatMode(doc, mode) {
  setDocState(doc, DOC_MODE, Math.max(0, DOCUMENT_MODES.indexOf(mode)));
}
export function isQuirksDocument(doc) {
  return docState(doc, DOC_MODE) === 2;
}
// …its readiness…
export function readyStateOf(doc) {
  return READY_STATES[docState(doc, DOC_READY)];
}
export function setReadyState(doc, state) {
  setDocState(doc, DOC_READY, Math.max(0, READY_STATES.indexOf(state)));
}
// …whether it has no browsing context, a scoped custom element registry's initialize() of it, an XMLDocument's brand…
export function hasNoBrowsingContext(doc) {
  return docFlag(doc, DOC_NO_BROWSING_CONTEXT);
}
export function setNoBrowsingContext(doc, on) {
  setDocFlag(doc, DOC_NO_BROWSING_CONTEXT, !!on);
}
export function ceInitializedOf(doc) {
  return docFlag(doc, DOC_CE_INITIALIZED);
}
export function setCeInitialized(doc, on) {
  setDocFlag(doc, DOC_CE_INITIALIZED, !!on);
}
export function isXMLDocumentObject(doc) {
  return docFlag(doc, DOC_XML_DOCUMENT_BRAND);
}
export function setXMLDocumentObject(doc, on) {
  setDocFlag(doc, DOC_XML_DOCUMENT_BRAND, !!on);
}
// …its throw-on-dynamic-markup-insertion counter (HTML §8.4.1)…
export function markupInsertionCounterOf(doc) {
  return docState(doc, DOC_INSERTIONS);
}
export function setMarkupInsertionCounter(doc, n) {
  setDocState(doc, DOC_INSERTIONS, n);
}
// …and its currently executing script, null for none.
export function currentScriptOf(doc) {
  return dom.currentScript(nidOf(doc));
}
export function setCurrentScript(doc, script) {
  dom.setCurrentScript(nidOf(doc), script ? nidOf(script) : null);
}
// Its content type — and whether that makes it an XML document, which the engine knows too (STATE_XML_DOCUMENT): the
// names given its HTML elements' attributes are ASCII-lowercased only in an HTML one (attributes.rs), and its
// selectors, class collections and style engine match in its kind (document_state.rs `document_mode`).
export function contentTypeOf(doc) {
  return docText(doc, DOC_TEXT_CONTENT_TYPE);
}
export function setContentType(doc, type) {
  setDocText(doc, DOC_TEXT_CONTENT_TYPE, type);
  setStateBit(doc, STATE_XML_DOCUMENT, isXmlMimeType(type));
}
// Its URL, encoding, referrer and an about: one's base URL, and when it was last modified — what a load or its
// creation sets.
export function urlOf(doc) {
  return docText(doc, DOC_TEXT_URL);
}
export function setURL(doc, url) {
  setDocText(doc, DOC_TEXT_URL, url);
}
export function encodingOf(doc) {
  return docText(doc, DOC_TEXT_ENCODING);
}
export function setEncoding(doc, encoding) {
  setDocText(doc, DOC_TEXT_ENCODING, encoding);
}
export function referrerOf(doc) {
  return docText(doc, DOC_TEXT_REFERRER);
}
export function setReferrer(doc, referrer) {
  setDocText(doc, DOC_TEXT_REFERRER, referrer);
}
export function aboutBaseURLOf(doc) {
  return docText(doc, DOC_TEXT_ABOUT_BASE);
}
export function setAboutBaseURL(doc, base) {
  setDocText(doc, DOC_TEXT_ABOUT_BASE, base);
}
export function lastModifiedOf(doc) {
  return dom.docLastModified(nidOf(doc));
}
export function setLastModified(doc, time) {
  dom.docLastModified(nidOf(doc), time);
}

// The window of a document with a browsing context — its realm's global, as `defaultView` answers, which a page's
// `defaultView` member is not; none for one without (`new Document()`, createHTMLDocument, a DOMParser's: returning
// the global spliced the live window into a detached document's event path), nor for one whose frame was removed. A
// document of another realm's arena — a frame's, asked by its parent's code — answers by its own (`REALM`).
export function defaultViewOf(doc) {
  const realm = doc === globalThis.document ? null : foreignRealmOf(doc);
  if (realm !== null) return realm.defaultViewOf(doc);
  if (hasNoBrowsingContext(doc)) return null;
  // (…asked of the engine only where some realm is discarded: none is the common page's)
  const discarded = dom.discardedRealms[0] !== 0 && dom.browsingContextDiscarded();
  return discarded ? null : globalThis;
}
// Its focused and hovered element: the engine's — the element carrying STATE_FOCUSED / STATE_HOVERED in the realm whose
// document this is (`documentFocus`), which answers for it — none for a document no realm shows (a DOMParser's). Their
// setting is dom-nodes.js's (`setFocusedElement`, `setHoveredElement`).
export function focusedElementOf(doc) {
  if (doc === globalThis.document) return dom.documentFocus(nidOf(doc), false);
  return foreignRealmOf(doc)?.focusedElementOf(doc) ?? null;
}
export function hoveredElementOf(doc) {
  if (doc === globalThis.document) return dom.documentFocus(nidOf(doc), true);
  return foreignRealmOf(doc)?.hoveredElementOf(doc) ?? null;
}
