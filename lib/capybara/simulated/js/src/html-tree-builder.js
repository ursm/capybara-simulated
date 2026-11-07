// The HTML parser's tree. The parser is html5ever, run natively (ext/csim_native/src/html_parse.rs), and the engine
// BUILDS what it parses into the arena itself — every parse, a page load's batch by batch between the scripts it stops
// for, a fragment's and a whole document's at once. What is left here is the page's side of it: the steps of the
// bindings' own for the elements a build names (`builtSteps`), the scripts a page load runs where the parser stops, the
// insertion point `document.write` writes at, and the hooks a build pauses for.
//
// Entry points:
//   - `parseHtmlDocument(html)` — one-shot, into a FRESH document. For DOMParser / standalone parses.
//   - `parseHtmlFragment(html, contextEl)` — `innerHTML` and the like, in the context element's own context.
//   - `parseHtmlIntoLive(liveDoc, html)` — parse directly into the LIVE `globalThis.document`, REUSING its `document` /
//     `<html>` / `<head>` / `<body>` identities (libraries capture `document.documentElement` etc. at load and reuse
//     them — replacing the skeleton strands those references). This is the document load path: the parse stops at
//     each `</script>` the page runs before it goes on, and `document.write` parses at the insertion point.
//   - `writeAtScript` — `document.write` at the insertion point of a script the parser is running.
//   - `writeScriptCreated` / `closeScriptCreated` — a script-created parser's (`document.open`, which the engine makes:
//     document_lifecycle.rs `docOpen`).

import { CE_FAILED, elementFlag } from './element-flags.js';
import { finalizeSelectOptions, enqueueAttributeChanged, hasAnyCEDefinitions, registryCodeOf } from './custom-elements.js';
import { queueToggleTask } from './form-helpers.js';
import { isHtml } from './constants.js';
import { hasObservers } from './mutation-observer.js';
import { syncTargetFragment } from './target.js';
import { clearEdges } from './tree.js';
import { ceEnter, ceLeave } from './webidl.js';
import { invalidateArena, rareDataOf } from './native-query-shadow.js';
import { documentElementOf } from './document-tree.js';
import { attrsOf, nidOf, nodeTypeOf } from './node-identity.js';
import { documentURL } from './base-url.js';

// The document modes, by number (`htmlParse`'s).
const QUIRKS_MODES = ['no-quirks', 'limited-quirks', 'quirks'];

export function installHtmlTreeBuilder({
  createHtmlPageDocument, subtreeRemoved,
  syncInlineEventHandler, inertTemplateDocFor, constructParsedCustomElement, appendedAttributeSteps,
  parserInsertionSteps
}) {
  // Per-parse binding, saved and restored around every parse: a parse-time script can start another (DOMParser,
  // `innerHTML`, `document.open`), which must build into its own document and leave this one's binding intact.
  //   curDoc — the Document the parse builds.
  //   live   — the reused skeleton nodes plus per-tag "already taken" flags.
  //   stream — the page's hooks (`parseHtmlIntoLive(doc, html, streamHooks)`): what a build leaves the page — its
  //            elements connected and upgraded incrementally, a customizable select mirrored, each parser-blocking
  //            <script> run at its `</script>`. Null for a document with no browsing context.
  //   cur    — the parse in progress (`startParse`): its id in html_parse.rs and its document — the engine keeps how
  //            many scripts it is running, the parsing-blocking script a `document.write` left pending
  //            (`parserState`), and that it is its document's active parser (`docParser`).
  let curDoc = null;
  let live = null;
  let stream = null;
  let cur = null;

  // Whether `node` is in template contents — its node document an inert template document (`inertTemplateDocFor`'s,
  // which links itself).
  function inTemplateContents(node) {
    const od = node._ownerDoc;
    return !!od && od._inertTemplateDoc === od;
  }

  // (…a reused element's cached Attr nodes dropped, which snapshot its previous attributes)
  function dropAttrNodes(el) {
    const rare = rareDataOf(el);
    if (rare !== undefined) rare.attrNodes = undefined;
  }

  // A parsed image element with a resource URL (an <img src>, or an SVG <image> href/xlink:href) in
  // the LIVE document starts fetching + decoding as soon as it is INSERTED, so naturalWidth/complete
  // and the load event are populated for later script. Run on insertion, not creation: an <img> in a
  // <picture> resolves its parent's matching <source> ("update the image data"), which needs the
  // picture parent and the <source> siblings that only exist once the element is in the tree. Gated
  // on `live`: a DOMParser document, an innerHTML/<template> fragment, and other non-browsing-context
  // parses are inert per spec (they load no resources), and the per-(src, mode) idempotence in
  // `_loadImageResource` keeps a re-append from re-fetching.
  // (…an image in template contents none: its node document, the inert template document, is not fully active)
  // (…its stable state, which "update the image data" awaits, come by the time a script runs next (HTML: the parser
  // performs a microtask checkpoint before it does) — but for one a running script's `document.write` inserted)
  function loadParsedImage(node) {
    if (live && nodeTypeOf(node) === 1 && node._ownerDoc === curDoc && typeof node._imageResourceSrc === 'function' && node._imageResourceSrc()) {
      node._loadImageResource((parserState(cur) & PARSER_NESTED) === 0);
    }
  }

  // Detach the live document's current tree in preparation for a fresh parse,
  // preserving the document / <html> / <head> / <body> element identities:
  //   - Detach the prolog (doctype / comments before <html>), its removing steps run.
  //   - Detach <html> from the document (the parser re-appends it, so the prolog
  //     it emits first lands in the correct order — before <html>).
  //   - Detach <html>'s children, <head> / <body> included (the parser re-appends
  //     them where the new markup puts them).
  //   - Empty <head> / <body> (their subtrees' removing steps run).
  // Their attributes are reset by the build when the parser reuses them (html_parse.rs `Build::reset`).
  function resetLiveDocument(liveDoc, liveHtml, liveHead, liveBody) {
    for (const c of clearEdges(liveDoc)) if (c !== liveHtml) subtreeRemoved(c);
    // …and the root's own children, the reused `<head>` / `<body>` included: they go back in where the parser puts them.
    // Left in place, a head script saw a connected `<body>` (Chrome and Firefox: `document.body` is null until the
    // parser reaches it) and the root's other children landed after both (`<html><!--c--><head>` read HEAD, BODY,
    // #comment where the tree is #comment, HEAD, #text, BODY).
    if (liveHtml) {
      for (const c of clearEdges(liveHtml)) if (c !== liveHead && c !== liveBody) subtreeRemoved(c);
    }
    if (liveHead) {
      for (const c of clearEdges(liveHead)) subtreeRemoved(c);
    }
    if (liveBody) {
      for (const c of clearEdges(liveBody)) subtreeRemoved(c);
    }
  }

  // Start a parse of `html` (html_parse.rs `htmlParse`) whose document is `doc` — its active parser — its batches built
  // as `nextBatch` asks for them; an iframe srcdoc document with `srcdoc`, which HTML parses in no-quirks mode whatever
  // its doctype.
  function startParse(doc, html, scripting, srcdoc, declarative) {
    const text = String(html == null ? '' : html);
    const [id] = globalThis.__dom.htmlParse(text, text.isWellFormed(), scripting, srcdoc, declarative, nidOf(doc));
    return { id, doc, stepped: null };
  }
  // Whether a parse has a script running with an insertion point — its script nesting level above zero — a pending
  // parsing-blocking script waiting, and its input run out at its end: the engine's (html_parse.rs `htmlParserState`).
  const PARSER_NESTED = 1, PARSER_BLOCKED = 2, PARSER_ENDED = 4;
  const parserState = (p) => globalThis.__dom.htmlParserState(p.id);
  // The node a parse's handle names — the script it stopped for.
  const handleOf = (p, k) => globalThis.__dom.htmlHandle(p.id, k);

  // Run the parse to its end: each script it stops for runs, then it goes on.
  function runParse(p) {
    for (let status = nextBatch(p); status >= 0; status = nextBatch(p)) scriptStopped(p, handleOf(p, status));
  }
  // The parse run on to where it stops — a script to run first (its handle), or the input run out (-1) — and the batch
  // it took to get there built by the engine (html_parse.rs `htmlRunBuilt`: none of the page's code runs as its nodes
  // are made and inserted, but for the constructors of the custom elements it makes, and no steps of the bindings' own
  // with them, but those `takeBuilt` runs after it). A build PAUSES where the page acts before it goes on: after a
  // custom element it constructed went in — it, and what came before it, connected as they stand, its connectedCallback
  // before the next start tag's constructor, as the parser's insertion of it pops the element queue it pushed — and at a
  // customizable select's node, inserted or closed, which the page mirrors into its `<selectedcontent>` as the parser
  // goes (`stream.onSelectNode`).
  // (…no further than what aborted it — HTML "abort a parser": "Throw away any pending content in the input stream, and
  // discard any future content" — a script, a constructor, a frame's load fired at once: as the input run out, no script
  // run of what it had got to)
  // (…a document with no browsing context — a script-created parser's in `createHTMLDocument`'s — has no stream: no
  // constructor runs and no connection step, and its selects' options are set up as they close, as a fragment's are)
  const CE_DEFINED = 2, OBSERVED = 4, IN_BROWSING_CONTEXT = 8;
  const CUSTOM_ELEMENT_INSERTED = -2, SELECT_NODE_INSERTED = -3, SELECT_NODE_POPPED = -4, FRAME_INSERTED = -5;
  function nextBatch(p) {
    while (!parserAborted(p)) {
      const status = runBatch(p);
      if (status === CUSTOM_ELEMENT_INSERTED) stream.onCustomElementInserted();
      else if (status === FRAME_INSERTED) stream.onFrameInserted();
      else if (status === SELECT_NODE_INSERTED || status === SELECT_NODE_POPPED) stream.onSelectNode(p.stepped, status === SELECT_NODE_POPPED);
      else return parserAborted(p) ? -1 : status;
    }
    return -1;
  }
  const parserAborted = (p) => globalThis.__dom.docParserAborted(nidOf(p.doc));
  function runBatch(p) {
    const flags = (stream ? (hasAnyCEDefinitions() ? CE_DEFINED : 0) | IN_BROWSING_CONTEXT : 0) | (hasObservers() ? OBSERVED : 0);
    const made = globalThis.__dom.htmlRunBuilt(p.id, flags, p.doc, inertTemplateDocFor(p.doc),
                                               live.usedHtml ? null : live.html, live.usedHead ? null : live.head, live.usedBody ? null : live.body);
    // (…none where the engine failed partway — a node factory's exception what the page sees — or a panic wound the
    // parse down, and it goes no further)
    if (made === undefined || made.length === 1) return -1;
    return takeBuilt(p, made);
  }
  // A batch the engine built (`htmlRunBuilt`'s answer): the document's mode it set; the skeleton elements it reused —
  // their bindings' state of their old attributes dropped — then the steps of the bindings' own for the elements it
  // names (`builtSteps`); and what the page's insertions feed the stream: the elements with a connection step, a style
  // sheet coming in; then the images that fetch on insertion; and the node it paused at, the last it names. The status
  // it stopped with.
  function takeBuilt(p, made) {
    const [status, quirks, sheets, connect, images, reused, count] = made;
    const at = 7, imagesAt = at + connect, reusedAt = imagesAt + images, end = reusedAt + reused;
    if (quirks >= 0) p.doc._compatMode = QUIRKS_MODES[quirks];
    for (let k = reusedAt; k < end; k++) {
      const el = made[k];
      dropAttrNodes(el);
      if (el === live.html) live.usedHtml = true;
      else if (el === live.head) live.usedHead = true;
      else if (el === live.body) live.usedBody = true;
    }
    p.stepped = count > 0 ? made[at + count - 1] : null;
    builtSteps(made, at + count);
    if (stream) stream.onBuilt(made.slice(at, imagesAt), sheets !== 0);
    for (let k = imagesAt; k < reusedAt; k++) loadParsedImage(made[k]);
    return status;
  }
  // The parser stopped at `el`'s `</script>` (with no script running): run it — then the pending parsing-blocking
  // script its markup wrote, once the nesting level is back to zero, before anything after it is tokenized — and parse
  // on. A parse into a document with no browsing context runs none.
  // A parser-blocking script runs AFTER its end tag is processed (HTML's "text" insertion mode pops the `<script>`
  // and restores the insertion mode first), which the parser has done by the time it stops.
  function scriptStopped(p, el) {
    if (stream && runsHere(el)) {
      runWithInsertionPoint(p, el);
      runPendingScript(p);
    }
  }
  // The pending parsing-blocking script a parser-run script's markup wrote runs once the nesting level is back to zero
  // — and before anything after it is tokenized (html_parse.rs `htmlTakeBlockingScript`).
  function runPendingScript(p) {
    for (let el; !parserAborted(p) && (el = globalThis.__dom.htmlTakeBlockingScript(p.id)) !== null;) runWithInsertionPoint(p, el);
  }
  // Whether the parser runs `el` where it stopped for it: not a script in template contents, which is never prepared
  // (inert).
  function runsHere(el) {
    return !inTemplateContents(el);
  }
  // Run `el` with an INSERTION POINT (HTML §8.4.3): just past its `</script>` — or, the pending parsing-blocking
  // script, just before the next input character: the same place by the time it runs. What it writes goes in there.
  // (…the script nesting level one more while it runs: the engine's, html_parse.rs `htmlScriptBegin`)
  function runWithInsertionPoint(p, el) {
    globalThis.__dom.htmlScriptBegin(p.id);
    try { stream.onScript(el); } finally { globalThis.__dom.htmlScriptEnd(p.id); }
  }

  // `document.write` from a script the parser is running: its markup goes into the input stream at the insertion
  // point and is tokenized THERE, before `write` returns, up to the insertion point. Appended to `<body>` instead,
  // `<div>one<script>document.write("two")</script> four</div>` read "one four two" (Chrome and Firefox: "one two
  // four"). A `<script>` in the written markup runs right there, inside `write`, with an insertion point of its own —
  // unless it is an EXTERNAL parser-blocking one: that is the pending parsing-blocking script, it runs once the writer
  // (and every script it is nested in) has returned, and until it has, a further `write` only inserts (nothing is
  // tokenized past a pending script). What it inserted is connected before `write` returns, as the parser's insertion of
  // each runs its post-connection steps (a written `<meta name=referrer>` sets the policy a fetch after it is sent
  // under, a written `<select>` selects its first option: Chrome).
  // (…the parse running that script `cur`: the document's active parser, whose script runs inside its own parse's
  // binding — the engine's to say it is running one: document_lifecycle.rs `docMarkupSteps`. None where this realm's
  // bindings run no parse of the document — another realm's `write` called on it — which writes nothing, as an open
  // from a script its parser runs does nothing.)
  function writeAtScript(doc, html) {
    const p = cur, text = String(html);
    if (p === null || p.doc !== doc) return;
    if (globalThis.__dom.htmlWrite(p.id, text, text.isWellFormed()) !== true || parserState(p) & PARSER_BLOCKED) return;
    parseWritten(p);
    stream.onWritten();
  }
  // …tokenized up to the insertion point, or to the pending parsing-blocking script it wrote.
  function parseWritten(p) {
    for (;;) {
      const status = nextBatch(p);
      if (status < 0) return;                      // the insertion point: everything written is parsed
      const el = handleOf(p, status);
      if (runsHere(el)) {
        if (globalThis.__dom.htmlScriptStopped(p.id, el)) return;   // (…the pending parsing-blocking script)
        runWithInsertionPoint(p, el);
        if (parserState(p) & PARSER_BLOCKED) return;               // (…it wrote one: nothing more is tokenized until it has run)
      }
    }
  }
  // Run `fn` with this module's per-parse binding set to the given one, restoring the previous after.
  function withBinding(doc, liveSkeleton, streamHooks, fn) {
    const prevDoc = curDoc, prevLive = live, prevStream = stream, prevCur = cur;
    curDoc = doc; live = liveSkeleton; stream = streamHooks;
    try { return fn(); } finally {
      curDoc = prevDoc; live = prevLive; stream = prevStream; cur = prevCur;
    }
  }

  // One-shot document parse (into a fresh document), built by the engine (html_parse.rs `htmlParseDocument`), its mode
  // set as the parse set it. Scripting DISABLED: `<noscript>` content is parsed as elements
  // (DOMParser-parseFromString-html.html "noscript works"), and no script runs. With `declarative`, a document that
  // allows declarative shadow roots (DOMParser's does not).
  function parseHtmlDocument(html, declarative = false) {
    const doc = createHtmlPageDocument(false), text = String(html == null ? '' : html);
    const made = globalThis.__dom.htmlParseDocument(text, text.isWellFormed(), doc, inertTemplateDocFor(doc), declarative);
    if (made === undefined) return doc;
    if (made[0] >= 0) doc._compatMode = QUIRKS_MODES[made[0]];
    builtSteps(made, 1);
    return doc;
  }

  // Parse `html` as an HTML fragment in `contextEl`'s context (the element whose innerHTML/insertAdjacentHTML/etc. is
  // being parsed), built by the engine (html_parse.rs `htmlParseFragment`): the fragment insertion mode for the context
  // (table / select / raw-text `<textarea>`/`<script>`/`<style>`, foreign content in an `<svg>`, an `<html>`'s "before
  // head", …), the form element pointer its nearest form, the mode of its document — a context that is no element (a
  // document, a fragment) parsing "in body". Returns an array of the parsed top-level nodes,
  // detached, for the caller to adopt, owned by `contextEl`'s document (or the main document), each element taking the
  // context's registry association (a shadow root's or an element's in a scoped tree). NOT streaming: fragment scripts
  // never run. With `declarative` (setHTMLUnsafe's), the declarative shadow roots the markup makes are attached. Then the
  // bindings' steps for the elements the build names (`builtSteps`).
  // (…`registryOf` the node whose registry association its elements take: the context's, a shadow root's for its host's)
  function parseHtmlFragment(html, contextEl, declarative = false, registryOf = contextEl) {
    const ownerDoc = contextEl ? contextEl._ownerDocument : globalThis.document;
    const registry = registryOf ? registryOf._ceRegistry : undefined;
    const text = String(html == null ? '' : html);
    const made = globalThis.__dom.htmlParseFragment(text, text.isWellFormed(), contextEl ? nidOf(contextEl) : null, ownerDoc,
                                                   inertTemplateDocFor(ownerDoc), declarative, registryCodeOf(registry), registry);
    // (…none for a parse a panic wound down)
    if (made === undefined || made[0] < 0) return [];
    const count = made[0];
    builtSteps(made, 1 + count);
    return made.slice(1, 1 + count);
  }
  // …and the bindings' steps for the elements a build names, from `made[at]` on (html_parse.rs `Build::answer`): an
  // attribute's (an event handler, a named property, a details' `open`), an element's insertion steps, a select's
  // options set up, a details' closing where its name group has another open one.
  const BUILT_SELECT = 1, BUILT_INSERTED = 4, BUILT_CLOSED = 8;
  function builtSteps(made, at) {
    for (let i = at; i < made.length; i += 3) {
      const el = made[i], names = made[i + 1], flags = made[i + 2];
      if (names) {
        for (const name of names) {
          syncInlineEventHandler(el, name, attrsOf(el)[name]);
          appendedAttributeSteps(el, name, attrsOf(el)[name]);
        }
      }
      // (…a details' exclusivity the engine's: one it closed as it inserted it — its `open` removed then — has its toggle
      // queued from the open it was made with to closed)
      if (flags & BUILT_CLOSED) queueToggleTask(el, 'open', 'closed');
      if (flags & BUILT_INSERTED) parserInsertionSteps(el, false);
      if (flags & BUILT_SELECT) finalizeSelectOptions(el);
    }
  }
  // Parse `html` directly into the live document, reusing its skeleton. The caller owns everything after tree
  // construction: custom-element upgrades, cascade rebuild, and running the deferred scripts — "the end" of its parse,
  // where that parse is still the document's active parser as it is done: whether it is (none of an aborted one's,
  // which a `document.open()` from no script of its own replaced: the document written is that one's).
  function parseHtmlIntoLive(liveDoc, html, streamHooks) {
    const liveHtml = documentElementOf(liveDoc) || null;
    const liveHead = liveHtml ? liveHtml._children.find((c) => isHtml(c, 'head')) : null;
    const liveBody = liveHtml ? liveHtml._children.find((c) => isHtml(c, 'body')) : null;
    // A new page: a fresh arena, which the new tree fills as it is parsed (see invalidateArena).
    invalidateArena();
    syncTargetFragment();
    resetLiveDocument(liveDoc, liveHtml, liveHead, liveBody);
    const skeleton = { html: liveHtml, head: liveHead, body: liveBody, usedHtml: false, usedHead: false, usedBody: false };
    // (…an iframe srcdoc document's — its URL `about:srcdoc`, its location's where it carries none of its own — which no
    // missing or legacy doctype puts in quirks mode)
    return withBinding(liveDoc, skeleton, streamHooks || null, () => {
      const p = startParse(liveDoc, html, true, documentURL(liveDoc) === 'about:srcdoc', true);
      cur = p;
      try {
        runParse(p);
        return globalThis.__dom.docParser(nidOf(liveDoc)) === p.id;
      } finally {
        globalThis.__dom.htmlDone(p.id);
      }
    });
  }

  // A SCRIPT-CREATED parser (HTML "document open steps" 16-17, the engine's: html_parse.rs `begin_script_created`): a
  // parse of the document `open` emptied, from no input, its insertion point at the end of its input stream, which
  // `document.write` feeds and only `document.close` ends (`htmlClose`). `open` set the document's mode no-quirks, which
  // the parser sets again from the doctype written — or none, its input ended: quirks (WPT
  // opening-the-input-stream/quirks.window.js; Chrome and Firefox, a `createHTMLDocument`'s too) — but an iframe srcdoc
  // document's, which stays no-quirks. With `streamHooks` (the realm's own document, which has a browsing context) its
  // scripts run at their end tags, as a page load's do; without, none. It builds into no skeleton of the document's.
  // `html` inserted at its insertion point and parsed up to it — its scripts run as their end tags come — unless a
  // parsing-blocking script is pending (then it waits for that): whether that ended the parse. (`id` the parse, the
  // document's active parser the engine named: document_lifecycle.rs `docMarkupSteps`)
  const NO_SKELETON = { html: null, head: null, body: null, usedHtml: true, usedHead: true, usedBody: true };
  function writeScriptCreated(doc, id, html, streamHooks) {
    const p = { id, doc, stepped: null }, text = String(html);
    if (globalThis.__dom.htmlWrite(p.id, text, text.isWellFormed()) !== true || parserState(p) & PARSER_BLOCKED) return false;
    return parseScriptCreated(p, streamHooks);
  }
  // …and its input stream ended (`document.close`, an explicit end inserted after what was written): parsed to its
  // end, the parse gone — true where it ended now. From a script it is running, or past a pending script, the parse
  // goes on with what it has first, and ends as the write that ran it is done.
  function closeScriptCreated(doc, id, streamHooks) {
    const p = { id, doc, stepped: null };
    globalThis.__dom.htmlClose(p.id);
    if (parserState(p) !== 0) return false;
    return parseScriptCreated(p, streamHooks);
  }
  function parseScriptCreated(p, streamHooks) {
    withBinding(p.doc, NO_SKELETON, streamHooks, () => {
      cur = p;
      runParse(p);
    });
    if (!(parserState(p) & PARSER_ENDED)) return false;
    globalThis.__dom.htmlDone(p.id);
    return true;
  }

  // HTML "create an element for the token" where it will execute script, for a live batch the engine builds
  // (html_parse.rs `construct`): the custom element's constructor run with the document's throw-on-dynamic-markup-
  // insertion counter held (a `document.write` in it throws, as in Chrome) — and what it queued run as its construct
  // callback is cleaned up after, the counter held still (HTML "clean up after running script": a microtask checkpoint
  // where no script runs beneath the parser — `stream.onConstructed`) — the element, and whether it is custom (a
  // constructor that failed leaves an HTMLUnknownElement), or null where none is made — …
  globalThis.__csimConstructParsedElement = (name, doc) => {
    doc._markupInsertionCounter = (doc._markupInsertionCounter || 0) + 1;
    let el;
    try {
      el = constructParsedCustomElement(name, doc, null);
      if (el && stream) stream.onConstructed();
    } finally {
      doc._markupInsertionCounter--;
    }
    if (!el) return null;
    el._ownerDoc = doc;
    return [el, !elementFlag(el, CE_FAILED)];
  };
  // …and the attributeChanged reactions of the attributes the parser appended to a custom one, in attribute-list order,
  // run as it is made (an element queue pushed around it) — with the document's throw-on-dynamic-markup-insertion counter
  // still held, as the element's creation holds it until its reactions have run ("create an element for the token" step
  // 10): a `document.write` in one throws.
  function parsedElementReactions(el) {
    const doc = el._ownerDoc;
    doc._markupInsertionCounter = (doc._markupInsertionCounter || 0) + 1;
    const ce = ceEnter();
    try {
      for (const key of Object.keys(attrsOf(el))) {
        const [ns, , localName] = globalThis.__dom.attrName(el, key);
        enqueueAttributeChanged(el, localName, null, attrsOf(el)[key], ns);
      }
    } finally {
      ceLeave(ce);
      doc._markupInsertionCounter--;
    }
  }
  globalThis.__csimParsedElementReactions = parsedElementReactions;

  return { builtSteps, parseHtmlDocument, parseHtmlFragment, parseHtmlIntoLive, writeAtScript, writeScriptCreated, closeScriptCreated };
}
