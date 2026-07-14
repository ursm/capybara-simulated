// Display / visibility cascade.
//
// Scope: just `display` and `visibility`. selfHidden in
// bridge.entry.js is the only consumer of the resolution result,
// so the resolver can throw away every other CSS property at parse
// time.
//
// Pipeline:
//   1. cssTreeFlatten(text, vp)   — css-tree parses the stylesheet; we
//                                   eval @media/@supports/@container against
//                                   the viewport, compose `&` nesting, and
//                                   emit one {selectorText, decls} per rule.
//   2. collectCascadeRules(doc)   — flatten → one entry per (selector,
//                                   display, visibility, !important);
//                                   specificity + index terminal key from
//                                   css-tree, matching via css-select.
//   3. matchesAnyHideRule(el)     — for each matching rule, pick the
//                                   winning declaration. Element is
//                                   hidden iff the winning `display`
//                                   is `none` or `visibility` is
//                                   `hidden`.
//
// Layout side: `parseInlineLayout(el)` + `resolveLayoutProp(el, prop)`
// surface the inline `style="left:Npx; top:Npx; ..."` values for the
// `__csimElementRect` host fn (click-offset specs). Cascade-derived
// layout would need a real layout engine.

import { NODE_ELEMENT, NODE_TEXT, NODE_DOC, NODE_FRAGMENT } from './constants.js';

import { walk, classes, scriptText } from './walk.js';
import { mediaMatches, currentViewport, supportsMatches } from './media-query.js';
import { splitTopLevel, decodeDataUrlCss, resolveCssUrls, documentBaseUrl } from './css-utils.js';
import { matchesSelector, matchesSelectorNS } from './selectors.js';
import { normalizeColor } from './style-proxy.js';

// The cascade is parsed AND matched without the hand-rolled selector-parser.js:
//   - css-tree (vendored) parses stylesheets + selectors, and yields
//     specificity + the rule-index terminal key from its AST;
//   - css-select (via selectors.js `matchesSelector`) does the matching — the
//     mature Selectors-4 matcher, with the same `:focus`/etc. user-pseudos and
//     `:hover`/`:active`=false semantics the query path uses.
// `__csimVendor` is loaded (vendor bundle) before this module evaluates.
const CT = globalThis.__csimVendor.cssTree;
const CW = globalThis.__csimVendor.cssWhat;

// 3-component specificity compare: >0 if `a` wins over `b`.
function compareSpec(a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }

// Specificity of one complex selector STRING via css-tree's AST. Functional
// pseudos per Selectors-4 §16: `:where()`→0; `:is`/`:not`/`:has`/nth-of→the max
// specificity of their argument list (the pseudo itself adds nothing).
const SPEC_ZERO_PSEUDOS = new Set(['where']);
// `:is`/`:not`/`:has`/`matches`/`-webkit-any` contribute the MAX specificity of
// their argument and add nothing themselves. `:nth-child`/`:nth-last-child` are
// NOT here: they're an ordinary pseudo-class (a B-component, +1 to acc[1]) PLUS,
// for the `of S` form, the max of S — which falls out naturally by letting the
// default branch run `acc[1]++` and the walk descend into the `of S` children.
const SPEC_MAX_PSEUDOS  = new Set(['is', 'not', 'has', 'matches', '-webkit-any']);
function addSpec(a, s) { a[0] += s[0]; a[1] += s[1]; a[2] += s[2]; }
function selectorListMax(children) {
  let best = [0, 0, 0];
  if (!children) return best;
  children.forEach(ch => {
    if (ch.type === 'SelectorList') {
      ch.children.forEach(sel => { const s = selectorSpecificity(sel); if (compareSpec(s, best) > 0) best = s; });
    } else if (ch.type === 'Selector') {
      const s = selectorSpecificity(ch); if (compareSpec(s, best) > 0) best = s;
    } else if (ch.type === 'Raw') {
      try {
        CT.parse(ch.value, { context: 'selectorList' }).children.forEach(sel => {
          const s = selectorSpecificity(sel); if (compareSpec(s, best) > 0) best = s;
        });
      } catch (_) { /* leave best */ }
    }
  });
  return best;
}
function selectorSpecificity(selNode) {
  const acc = [0, 0, 0];
  CT.walk(selNode, {
    enter(node) {
      switch (node.type) {
        case 'IdSelector': acc[0]++; break;
        case 'ClassSelector':
        case 'AttributeSelector': acc[1]++; break;
        case 'TypeSelector': if (node.name !== '*') acc[2]++; break;
        case 'PseudoElementSelector': acc[2]++; break;
        case 'PseudoClassSelector': {
          const n = (node.name || '').toLowerCase();
          if (SPEC_ZERO_PSEUDOS.has(n)) return this.skip;
          if (SPEC_MAX_PSEUDOS.has(n)) { addSpec(acc, selectorListMax(node.children)); return this.skip; }
          acc[1]++; break;
        }
      }
    }
  });
  return acc;
}
function specificityOf(selText) {
  try { return selectorSpecificity(CT.parse(selText, { context: 'selector' })); }
  catch (_) { return [0, 0, 0]; }
}

// The rightmost compound's most-discriminating signal (class > id > tag >
// universal) — the rule-index bucket key. A necessary condition for the
// terminal to match, so it's a valid pre-filter (the full match still runs
// through css-select). Built from css-WHAT (the parser css-select matches
// with) — NOT css-tree, whose ClassSelector/IdSelector `.name` keeps the
// source escapes (`.lg\:flex` → `lg\:flex`), which would never match the
// element's unescaped class `lg:flex`. css-what unescapes, so the bucket key
// lines up with `classes(el)` / the matcher. Compounds are split by combinators.
const CW_COMBINATORS = new Set(['descendant', 'child', 'parent', 'sibling', 'adjacent', 'column-combinator']);
function terminalKey(selText) {
  let groups;
  try { groups = CW.parse(selText); }
  catch (_) { return { kind: 'universal' }; }
  let id = null, cls = null, tag = null;
  for (const t of (groups[0] || [])) {
    if (CW_COMBINATORS.has(t.type)) { id = cls = tag = null; continue; }   // new compound
    if (t.type === 'tag') { if (t.name !== '*') tag = t.name.toLowerCase(); }
    else if (t.type === 'attribute') {
      if (t.name === 'class' && t.action === 'element') { if (!cls) cls = t.value; }
      else if (t.name === 'id' && t.action === 'equals') { if (!id) id = t.value; }
    }
  }
  if (cls) return { kind: 'class', key: cls };
  if (id)  return { kind: 'id', key: id };
  if (tag) return { kind: 'tag', key: tag };
  return { kind: 'universal' };
}

// css-select match, guarded — an unparseable/unsupported selector never matches
// (the hand-rolled matcher likewise threw → caller skipped).
function safeMatches(el, selectorText, ns) {
  try { return ns ? matchesSelectorNS(el, selectorText, ns) : matchesSelector(el, selectorText); }
  catch (_) { return false; }
}

// Tags whose subtree never contributes to visible text or
// `__csimVisible`: head/script/style/template/noscript/title.
export const INVISIBLE_TAGS = new Set(['head','script','style','template','noscript','title']);


// Visibility predicate: walks the ancestor chain. Returns false if
// the element itself or any ancestor is INVISIBLE_TAGS / hidden /
// display:none / `<input type=hidden>`, otherwise true. Exposed as
// `globalThis.__isVisibleNode` so observers.js's IntersectionObserver
// fast-path can fire without importing — observers loads before the
// cascade state is wired up, so a globalThis getter is the seam.
export function isVisibleNode(el) { return isVisibleNodeImpl(el, false); }
// Layout-bounds visibility, for IntersectionObserver. Per spec IO
// doesn't consult `visibility` — `visibility: hidden` elements still
// reserve layout and intersect normally. Discourse's `DLoadMore`
// sentinel is `visibility: hidden` and must still fire its IO to
// drive infinite-scroll fetches.
export function isLaidOutNode(el) { return isVisibleNodeImpl(el, true); }
function isVisibleNodeImpl(el, ignoreVisibility) {
  if (!el || el.nodeType !== NODE_ELEMENT) return false;
  if (INVISIBLE_TAGS.has(el._tag)) return false;
  if (el._tag === 'input' && (el._attrs.type || '').toLowerCase() === 'hidden') return false;
  // Display-side hiding is UNCONDITIONAL: any ancestor-or-self that is
  // display:none / [hidden] / dialog:not([open]) / INVISIBLE_TAGS hides the
  // whole subtree. `visibility` is deliberately NOT checked in this walk —
  // it inherits AND a descendant can override it — so pass ignoreVisibility
  // to selfHidden and resolve visibility per-target below.
  let cur = el, connected = false;
  while (cur) {
    if (cur.nodeType === NODE_DOC) { connected = true; break; }
    if (cur.nodeType === NODE_ELEMENT) {
      if (INVISIBLE_TAGS.has(cur._tag)) return false;
      if (selfHidden(cur, true)) return false;
    }
    cur = cur._parent;
  }
  if (!connected) return false;
  if (!ignoreVisibility && visibilityHidden(el)) return false;
  return true;
}
globalThis.__isVisibleNode = isVisibleNode;
globalThis.__isLaidOutNode = isLaidOutNode;

export function selfHidden(el, ignoreVisibility = false) {
  // The `hidden` attribute is the UA `[hidden] { display: none }` rule, resolved
  // through the cascade below so an author `display` (e.g. make_visible's inline
  // override) can beat it — NOT an unconditional hide.
  const hidden = el._attrs.hidden != null;
  // `<dialog>` HTML spec UA stylesheet: `dialog:not([open]) { display: none }`.
  // Avo's confirm-dialog template (the "Close modal / Are you sure? /
  // Yes, I'm sure / No, cancel" block) is rendered into every page
  // and stays in the DOM without `open` until `data-turbo-confirm`
  // triggers `showModal()`. Without honouring the UA hide here,
  // Capybara's `click_on "Close modal"` matches both the dropdown
  // action item and the dialog's close button → ambiguous-match.
  if (el._tag === 'dialog' && el._attrs.open == null) return true;
  // Tentative combobox UA stylesheet: `option:filtered { display: none }` — an
  // option filtered out by its associated filter `<input>` is hidden.
  if (el._tag === 'option' && el._filtered === true) return true;
  // Inline `style=` participates in the cascade as an author declaration
  // that outranks EVERY selector at equal importance (modelled by the
  // `inline` flag winsCascade checks before specificity) — so a
  // non-`!important` inline value still loses to an `!important` author
  // stylesheet rule (`<div style="display:block">` with
  // `.d-none{display:none!important}` is hidden), while an `!important`
  // stylesheet rule can override a plain inline value. When the cascade
  // has no `!important` display/visibility rules (the common case) the
  // inline declaration can be settled by the cheap short-circuit below;
  // otherwise it's fed into the full winsCascade resolution.
  const inline = inlineHideDecl(el);
  // Constant-time fast path (CLAUDE.md rule 3): when the cascade has
  // NO `!important` display/visibility hide-rules, a non-`!important`
  // inline declaration can never be beaten by a stylesheet rule, so we
  // can settle the inline-covered properties without the bucket walk.
  // selfHidden runs for every ancestor of every find candidate, so the
  // common page (no `!important` hides) keeps the old cheap cost; only
  // pages that actually use `!important` display/visibility pay the
  // full winsCascade walk below.
  if (inline && !state.hasImportantHideRule) {
    // Inline hiding value wins outright — nothing (no important rule)
    // can override a plain inline declaration.
    if (inline.display === 'none') return true;
    if (!ignoreVisibility &&
        (inline.visibility === 'hidden' || inline.visibility === 'collapse')) return true;
    // Does inline already settle every property we'd otherwise have to
    // resolve from the cascade? Display is settled iff inline sets it
    // (to a non-none value, handled above). Visibility is settled iff
    // we're ignoring it or inline sets it (to a visible value here).
    const displaySettled    = inline.display != null;
    const visibilitySettled = ignoreVisibility || inline.visibility != null;
    if (displaySettled && visibilitySettled) return false;
    // Otherwise an inline value covers one property but the other must
    // still be resolved from stylesheet rules — fall through to the
    // full walk (which seeds with `inline`, so the inline-covered
    // property still wins for free).
  }
  return matchesAnyHideRule(el, ignoreVisibility, inline, hidden);
}

// Parse the element's inline `style=` display / visibility declarations
// into the `{ display, displayImp, visibility, visibilityImp, spec,
// source }` shape the cascade resolver compares against stylesheet rules.
// Returns null when neither is declared inline (the common case — keeps
// the hot path cheap).
function inlineHideDecl(el) {
  const style = el._attrs && el._attrs.style;
  if (!style) return null;
  // Per-element parse cache (#3): the same `style=` string is otherwise re-parsed
  // several times per visible-text/visibility compute (selfHidden + ownVisibility
  // + the property resolvers all call through here). `===` on the style string is
  // a VALUE compare, so an identical re-write still hits; any change misses and
  // reparses. Keyed on the string itself — no version counter needed.
  if (el._isKey === style) return el._isCache;
  let display = null, displayImp = false;
  let visibility = null, visibilityImp = false;
  const dm = /(?:^|;)\s*display\s*:\s*([^;]+)/i.exec(style);
  if (dm) {
    let v = dm[1].trim();
    if (/!\s*important\s*$/i.test(v)) { displayImp = true; v = v.replace(/!\s*important\s*$/i, '').trim(); }
    display = v.toLowerCase();
  }
  const vm = /(?:^|;)\s*visibility\s*:\s*([^;]+)/i.exec(style);
  if (vm) {
    let v = vm[1].trim();
    if (/!\s*important\s*$/i.test(v)) { visibilityImp = true; v = v.replace(/!\s*important\s*$/i, '').trim(); }
    visibility = v.toLowerCase();
  }
  if (display == null && visibility == null) { el._isKey = style; el._isCache = null; return null; }
  // Inline declarations outrank EVERY author selector at equal
  // importance regardless of selector specificity (an inline
  // `display:block` beats `#a #b{display:none}`). That ordering is
  // modelled by the explicit `inline` flag the cascade comparators
  // check before specificity — not by an inflated spec tuple, which
  // would collapse to a single-id specificity through the 3-component
  // `compareSpec` and lose to multi-id selectors. `spec` stays a real
  // 3-component value so any compareSpec call on it is well-defined.
  const decl = { display, displayImp, visibility, visibilityImp,
                 inline: true, spec: [0, 0, 0], source: Number.MAX_SAFE_INTEGER };
  el._isKey = style; el._isCache = decl;
  return decl;
}

// Cascade state lives in one mutable object so the resolver
// invalidation helpers (`rebuildCascade` / `resetCascadeState`) can
// reset it with a single Object.assign. `hideRules` / `layoutRules`
// are the flattened rule lists; `hideIdx` / `layoutIdx` are lazy
// per-tag buckets built on first lookup after invalidation;
// `ruleSerial` is the monotonic source-order counter the cascade
// resolver uses for tie-breaking.
const state = {
  hideRules: [], layoutRules: [],
  hideIdx:   null, layoutIdx:   null,
  ruleSerial: 0,
  hasImportantHideRule: false,
  hasVisibilityRule: false
};

// Replace the cached rule-set + index. Bridge.entry.js calls this
// from `__csimLoadDocument` after the new document is parsed. Ruby's
// `set_viewport` host fn routes through the globalThis wrapper below
// to re-resolve @media against the new viewport without a full
// reload.
// FNV-1a 32-bit string hash — fast, allocation-free; good enough for a cache key.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}
// Key for the cross-visit cascade-rule cache. Captures the stylesheet SOURCES
// (inline <style> text + each linked sheet's href — fingerprinted asset URLs
// already encode their content) plus the viewport (@media is resolved against it
// at build time, and the media= filter selects which sheets apply). Link bodies
// are NOT hashed — the fingerprinted href stands in for the content — so a cache
// hit never re-fetches. Apps that serve changing CSS under a STABLE, unfingerprinted
// href within one process would need a body hash; none of the target apps do.
//
// The key is the STRUCTURED `acc` string itself, NOT a hash of it — collapsing the
// whole multi-sheet fingerprint to a 32-bit digest would let two distinct sheet-sets
// alias to one cache entry (silent wrong-rules → wrong visibility). With `acc`
// verbatim, the dominant link-CSS case (fingerprinted hrefs) is collision-proof; the
// only residual is the per-inline-<style> `fnv1a(t):length` (distinct texts of equal
// length and equal hash — astronomically unlikely), kept hashed so a huge inline sheet
// doesn't bloat the key compared per rebuild. Keys stay short (one href/style line each).
// HTML alternate / preferred stylesheet SET selection.
//
// A `<link rel="stylesheet">` / `<style>` with a non-empty `title` belongs to a
// named set; a `<link rel="alternate stylesheet">` is an ALTERNATE sheet,
// disabled by default. The active set is the "selected stylesheet set": the
// content of the last `<meta http-equiv="default-style">` (HTML "default style
// sheet set"), else the PREFERRED set — the title of the first non-alternate
// titled sheet. A sheet contributes to the cascade iff it's a persistent sheet
// (no title, not alternate) OR its title matches the selected set. A titleless
// alternate sheet is permanently disabled.
//
// The common page (only titleless non-alternate sheets) is unaffected — those
// are always enabled and the selected-set machinery is never consulted.

// Does this element select a stylesheet set? `<meta http-equiv=default-style>`.
export function isDefaultStyleMeta(el) {
  return el._tag === 'meta' && (el._attrs['http-equiv'] || '').toLowerCase() === 'default-style';
}

// Content of the last `<meta http-equiv=default-style>` with a non-empty content
// (document order, last wins), or null if none — the "default style sheet set".
function metaDefaultStyleSet(doc) {
  let sel = null;
  for (const m of doc.documentElement.getElementsByTagName('meta')) {
    if (isDefaultStyleMeta(m)) { const c = m._attrs.content; if (c) sel = c; }
  }
  return sel;
}

// Is a sheet with this title / alternate-ness enabled under `selectedSet`?
function sheetSetEnabled(title, alternate, selectedSet) {
  if (title === '') return !alternate;       // persistent (non-alt) on; titleless alternate permanently off
  return title === selectedSet;              // titled: on only when its set is selected
}

// Does a `<link rel=stylesheet>` contribute rules to the cascade? A `<link disabled>`
// never does (HTML disabled attribute). Otherwise its stylesheet-set membership decides,
// EXCEPT that an "explicitly enabled" link (the `disabled` attribute was removed at runtime)
// applies unconditionally — overriding the alternate-default-off — per the HTMLLinkElement.disabled
// model. Non-links (`<style>`) never carry this flag, so their gating stays `sheetSetEnabled`.
function linkSheetEnabled(l, title, alternate, selectedSet) {
  if (l._attrs.disabled != null) return false;
  if (l._explicitlyEnabled) return true;
  return sheetSetEnabled(title, alternate, selectedSet);
}

// The EFFECTIVE CSS text of a `<style>` for the cascade. Normally this is the
// element's own text node (`scriptText`) — the common, allocation-free path taken
// whenever no script has touched the element's CSSOM `.sheet`. But once `.sheet` is
// materialized and mutated via the CSSOM (`sheet.insertRule` / `deleteRule`), the
// element text no longer reflects the rules, so we use the sheet's serialized text
// instead. A change to the element's own children re-runs "update a style block":
// the sheet is reparsed from the element text, discarding prior insertRule edits —
// keyed on the `_styleTextDirty` flag (set on any child mutation) so a same-text
// change (an empty text node added/removed) still reparses, not just a differing
// string. `_sheetText` / the flag are shared with the `.sheet` getter, keeping them
// in step.
function effectiveStyleCss(s) {
  const sheet = s._sheet;
  if (!sheet) return scriptText(s);
  const text = scriptText(s);
  if (s._styleTextDirty || s._sheetText !== text) { sheet._reparse(text, false); s._sheetText = text; s._styleTextDirty = false; }
  return sheet._cssText;
}

// The cascade identity key AND the resolved selected stylesheet set, computed in
// one pass. The selected set is folded INTO the key (not just the default-style
// meta) because the resolved set — preferred = first non-alternate titled sheet,
// overridden by the default-style meta — decides which titled / alternate sheets
// contribute. Keying only the meta would let two documents with different enabled
// sheets but no meta collide and share the cross-visit rule cache. The selected
// set is resolved over the SAME media-filtered sheet view `collectCascadeRules`
// uses, so key and collected rules can't disagree. The whole machinery is gated
// on `anyTitledOrAlt`: the common page (only titleless non-alternate sheets) adds
// nothing to the key and never pays the `<meta>` scan.
function cascadeCacheKey(doc, vp) {
  const root = doc.documentElement;
  let acc = 'vp:' + vp.width + 'x' + vp.height;
  let anyTitledOrAlt = false, preferred = '';
  // getElementsByTagName (HTMLCollection), NOT querySelectorAll (a static
  // NodeList) — the cascade rebuild runs mid-parse under streaming, where a
  // parse-time script may have tampered NodeList.prototype.length (which a static
  // NodeList's length reads through); iterating one would then yield undefined
  // and throw. Parity with rebuildCascade's own style/link scan below.
  for (const s of root.getElementsByTagName('style')) {
    const media = s._attrs.media; if (media && !mediaMatches(media, vp)) continue;
    const t = effectiveStyleCss(s); if (!t) continue;
    const title = (s._attrs.title || '').trim();
    if (title) { anyTitledOrAlt = true; if (!preferred) preferred = title; }
    acc += '\nS:' + fnv1a(t) + ':' + t.length + (title ? '|t:' + title : '');
  }
  for (const l of root.getElementsByTagName('link')) {
    const tokens = (l._attrs.rel || '').toLowerCase().split(/\s+/); if (!tokens.includes('stylesheet')) continue;
    const href = l._attrs.href; if (!href) continue;
    // A `<link disabled>` contributes no rules and isn't a set member — keep it out of the key
    // entirely, so enabling it (attribute removed → this link re-enters the key) re-keys + rebuilds.
    if (l._attrs.disabled != null) continue;
    const media = l._attrs.media; if (media && !mediaMatches(media, vp)) continue;
    const title = (l._attrs.title || '').trim();
    const alternate = tokens.includes('alternate');
    if (title || alternate) anyTitledOrAlt = true;
    if (title && !alternate && !preferred) preferred = title;
    // `|ee` (explicitly enabled) distinguishes an applied alternate from an inert one — same
    // href/title/alt, different cascade — so toggling `disabled` on an alternate re-keys.
    acc += '\nL:' + href + (title ? '|t:' + title : '') + (alternate ? '|alt' : '') + (l._explicitlyEnabled ? '|ee' : '');
  }
  // `document.adoptedStyleSheets` contribute to the cascade; key on each sheet's
  // text fingerprint so reassigning / mutating them re-keys and rebuilds. A disabled
  // sheet, or one whose media doesn't match, contributes no rules — keyed as `A:off` so
  // toggling `disabled` / a media change still re-keys and rebuilds.
  const adopted = doc.adoptedStyleSheets;
  if (adopted) for (const sheet of adopted) {
    if (!adoptedSheetActive(sheet, vp)) { acc += '\nA:off'; continue; }
    const t = sheetCssText(sheet);
    if (t) acc += '\nA:' + fnv1a(t) + ':' + t.length;
  }
  // Only resolve the selected set (and scan `<meta>`) when a titled / alternate
  // sheet exists — otherwise it can't affect the cascade.
  let selectedSet = '';
  if (anyTitledOrAlt) {
    const ds = metaDefaultStyleSet(doc);
    selectedSet = ds != null ? ds : preferred;
    acc += '\nSS:' + selectedSet;
  }
  return { key: acc, selectedSet };
}

// Key of the most-recent build. A page graft fires rebuildCascade once (the main
// build) AND once per linked sheet's deferred load microtask — but those all see
// the SAME (sheet-set, viewport), so after the main build they're redundant. The
// gate below short-circuits them on an unchanged key, skipping even the cache
// round-trip. Reset by resetCascadeState so the next document always rebuilds.
let lastCascadeKey = null;
// Bumped whenever the resolved cascade actually changes (a real rebuild or a
// per-visit reset). A deferred `<link>` load / @media resize rebuilds the cascade
// — changing display / visibility / text-transform — WITHOUT any DOM mutation, so
// the settle generation is NOT a complete cache key for cascade-dependent reads
// (e.g. `__csimVisibleText`'s memo). Those key on this version too.
let cascadeVersion = 0;
// Set by a CSSOM edit (notifyCssomMutation); makes the next getComputedStyle read in the
// SAME task rebuild the cascade synchronously (CSSOM getComputedStyle flushes style),
// while stylesheet LOAD stays deferred. See ensureCascadeFresh.
let cascadeStale = false;
globalThis.__csimCascadeVersion = () => cascadeVersion;

export function rebuildCascade(doc) {
  doc = doc || globalThis.document;
  if (!doc || !doc.documentElement) return;
  // Cross-visit cache: the built {hide, layout} rules are deterministic per
  // (stylesheet-set, viewport). On a hit we JSON.parse the cached rules (~0.5 ms)
  // instead of re-running css-tree parse + per-rule specificity + terminalKey
  // (~12-15 ms). The Ruby-backed store survives the per-visit VM rebuild that
  // wipes the in-VM __sheetCache. Indexes (`hideIdx`/`layoutIdx`) are rebuilt
  // lazily from each rule's precomputed `term`, so they aren't cached.
  let hide, layout;
  const vp  = currentViewport();
  const { key, selectedSet } = cascadeCacheKey(doc, vp);
  // Sheets + viewport unchanged since the last build → the cascade is already
  // current (state + lazily-built index stay valid). Skips the redundant
  // per-linked-sheet rebuilds a page graft schedules.
  if (key === lastCascadeKey) return;
  lastCascadeKey = key;
  cascadeVersion = (cascadeVersion + 1) | 0;   // cascade actually changing → invalidate cascade-keyed memos
  const getFn = globalThis.__csimCascadeCacheGet;
  const cached = getFn ? getFn(key) : null;
  if (cached) {
    try { const obj = JSON.parse(cached); hide = obj.hide; layout = obj.layout; } catch (_) { hide = null; }
  }
  if (!hide) {
    ({ hide, layout } = collectCascadeRules(doc, selectedSet));
    const putFn = globalThis.__csimCascadeCachePut;
    if (putFn) { try { putFn(key, JSON.stringify({ hide, layout })); } catch (_) {} }
  }
  state.hideRules   = hide;
  state.layoutRules = layout;
  state.hideIdx = state.layoutIdx = null;
  state.propCache = null;
  // Precompute once per cascade build whether any hide-rule sets
  // display / visibility with `!important`. selfHidden uses this O(1)
  // boolean to decide whether a non-`!important` inline value can be
  // settled with the cheap short-circuit (no important rule can beat
  // it) or whether it must run the full winsCascade walk.
  state.hasImportantHideRule = computeHasImportantHideRule(hide);
  // Precompute whether ANY hide-rule sets `visibility`. When false (the common
  // page), `visibilityHidden`'s ancestor walk only needs to consult inline
  // `style=` — it can skip rule-matching entirely, keeping the visible-filter
  // hot path cheap.
  state.hasVisibilityRule = computeHasVisibilityRule(hide);
}

export function resetCascadeState() {
  lastCascadeKey = null;   // force the next rebuildCascade to run (state is now empty)
  cascadeVersion = (cascadeVersion + 1) | 0;
  state.hideRules = [];
  state.layoutRules = [];
  state.hideIdx = state.layoutIdx = null;
  state.propCache = null;
  state.hasImportantHideRule = false;
  state.hasVisibilityRule = false;
}

function computeHasImportantHideRule(hide) {
  for (const r of hide) {
    if (r.displayImp || r.visibilityImp) return true;
  }
  return false;
}

function computeHasVisibilityRule(hide) {
  for (const r of hide) {
    if (r.visibility != null) return true;
  }
  return false;
}

globalThis.__csimRebuildCascade = function () { rebuildCascade(); };

let cascadeRefreshScheduled = false;
// A connected `<style>` / `<link rel=stylesheet>` inserted, removed, or having its
// text edited changes the resolved cascade WITHOUT any per-element attr mutation —
// so `cascadeVersion` (and `state.hideRules`) would otherwise stay frozen and the
// selfHidden / __csimVisibleText memos serve stale visibility. The mutation path
// (recordChildList / recordCharacterData) calls this when a stylesheet node is
// involved. rebuildCascade early-returns on an unchanged content key and bumps
// cascadeVersion ONLY when the rules actually change, so a spurious schedule is
// cheap and the memos invalidate exactly when needed. Microtask-coalesced (mirrors
// the deferred <link>-load rebuild at maybeFireLinkLoad); a read in the SAME task
// as the insertion still sees the prior cascade, consistent with the existing
// async-stylesheet model.
export function scheduleCascadeRefresh() {
  // Mark the cascade stale so the NEXT getComputedStyle / visibility read in this same task
  // rebuilds synchronously (ensureCascadeFresh) — a `<style>`/`<link>` inserted or removed, or
  // a connected `<style>`'s text edited, must be reflected before a synchronous style read,
  // not only after the deferred microtask. rebuildCascade early-returns on an unchanged content
  // key, so a spurious mark is cheap.
  cascadeStale = true;
  if (cascadeRefreshScheduled) return;
  cascadeRefreshScheduled = true;
  Promise.resolve().then(() => {
    cascadeRefreshScheduled = false;
    try { rebuildCascade(globalThis.document); } catch (_) {}
  });
}
// A CSSOM mutation (cssom.js: replaceSync / insertRule / deleteRule on a constructed
// sheet) may affect a document-adopted sheet OR a shadow-root-adopted one. The former
// is picked up by the deferred document rebuild (its key re-fingerprints
// doc.adoptedStyleSheets); the latter is cached per shadow root keyed on
// `cascadeVersion` (scopedRulesFor) and is NOT in the document key, so we bump the
// version here so those scoped caches recompute and re-read the mutated sheet.
export function notifyCssomMutation() {
  cascadeVersion = (cascadeVersion + 1) | 0;
  cascadeStale = true;
  scheduleCascadeRefresh();
}

// Reflect a pending CSSOM edit before a cascade read in the same task. Only fires when
// cascadeStale is set (a CSSOM edit happened) — a read between edits pays nothing, and
// rebuildCascade early-returns when the content key is unchanged.
function ensureCascadeFresh() {
  if (!cascadeStale) return;
  cascadeStale = false;
  try { rebuildCascade(globalThis.document); } catch (_) {}
}
// Global hook so cssom.js can signal a mutation without importing cascade (avoiding a
// module cycle). rebuildCascade early-returns on an unchanged content key, so the
// document rebuild for a sheet not in the document cascade is cheap.
globalThis.__csimScheduleCascadeRefresh = notifyCssomMutation;

// Keyword props captured through the cascade AND ASCII-lowercased (CSS keywords
// are case-insensitive). `direction` is here so a stylesheet rule (`.rtl{direction:
// rtl}`) and a mixed-case inline value (`direction:RTL`) both reach
// getComputedStyle().direction and win over the dir-attribute directionality
// (style-proxy readComputed); without capture the layout-rule loop drops it.
// Keyword-valued props whose captured value is folded to lowercase. NOT `cursor` /
// `pointer-events` — they can carry case-sensitive tokens (a `url()`, or SVG's camelCase
// `visiblePainted`), so they keep their original case.
const LOWERCASE_VALUE_PROPS = new Set(['display', 'visibility', 'text-transform', 'white-space', 'direction', 'appearance', 'text-align', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-content', 'align-self']);
// Properties resolved through the cascade. Besides the numeric geometry and
// colour props, `position` / `z-index` are layout-FREE computed values (their
// computed form needs no box layout), so getComputedStyle can report them from
// an `#id { z-index: … }` author rule. (id-attribute CSS association.)
const CAPTURED_PROPS = new Set(['top', 'left', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'color', 'background-color', 'background-image', 'background-position', 'background-size', 'background-repeat', 'background-attachment', 'background-origin', 'background-clip', 'position', 'z-index', 'border-width', 'border-style', 'border-color', 'outline-color', 'caret-color', 'font-size', 'font-weight', 'font-style', 'line-height', 'font-family', 'opacity', 'text-align', 'cursor', 'pointer-events', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-content', 'align-self', 'order']);

// `border: <width> || <style> || <color>` (any order/subset) → the three uniform
// longhands getComputedStyle reports as `borderWidth`/`borderStyle`/`borderColor`.
// Only the all-sides-equal `border` shorthand is expanded (per-side `border-top` etc.
// aren't modelled — no gated test needs them).
const BORDER_STYLE_KEYWORDS = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset']);
function expandBorderShorthand(value) {
  let width = null, style = null, color = null;
  for (const tok of splitTopLevel(value, ' ')) {
    const t = tok.trim(); if (!t) continue;
    const lt = t.toLowerCase();
    if (BORDER_STYLE_KEYWORDS.has(lt)) style = lt;
    else if (lt === 'thin' || lt === 'medium' || lt === 'thick' || /^[\d.]/.test(t)) width = t;
    else color = t;
  }
  // The shorthand sets ALL three longhands; an omitted component resets to its
  // initial (so a later `border:` overrides an earlier explicit longhand).
  return [
    { prop: 'border-width', value: width != null ? width : 'medium' },
    { prop: 'border-style', value: style != null ? style : 'none' },
    { prop: 'border-color', value: color != null ? color : 'currentcolor' },
  ];
}

// Is a single top-level token a CSS <color>? Canonical color functions and hex are matched
// by shape (so an already-serialized `rgb(0, 128, 0)` counts); everything else defers to the
// shared color parser, which folds a named color to `rgb(...)` (≠ the input) and leaves a
// non-color keyword (`no-repeat`, `center`, `cover`, `url(...)`) untouched.
function isCssColorToken(t) {
  const s = t.trim().toLowerCase();
  if (/^#[0-9a-f]{3,8}$/.test(s)) return true;
  if (/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/.test(s)) return true;
  if (s === 'transparent' || s === 'currentcolor') return true;
  return normalizeColor(s) !== s;
}

// Sub-property keyword sets of the `background` shorthand, used to classify each token when
// expanding it into longhands (the grammar is order-independent, so we bucket by kind).
const BG_REPEAT_KW = new Set(['repeat', 'repeat-x', 'repeat-y', 'no-repeat', 'space', 'round']);
const BG_ATTACH_KW = new Set(['scroll', 'fixed', 'local']);
const BG_BOX_KW    = new Set(['border-box', 'padding-box', 'content-box']);
// A <position> keyword → its computed percentage. left/top = 0%, right/bottom = 100%, center = 50%.
const BG_POS_PCT   = { left: '0%', right: '100%', top: '0%', bottom: '100%', center: '50%' };
// The longhands `background` sets that getComputedStyle reports, and their initial values (for a
// layer that omits the component). `background-image` keeps its `url(...)` in SPECIFIED form here
// (the parse cache is base-independent); the originating sheet's base URL is applied later, when
// rules are appended per-sheet (collectCascadeRules), so a constructable sheet's custom `baseURL`
// resolves correctly.
const BG_LONGHANDS = [
  ['background-image',      'none'],
  ['background-position',   '0% 0%'],
  ['background-size',       'auto'],
  ['background-repeat',     'repeat'],
  ['background-attachment', 'scroll'],
  ['background-origin',     'padding-box'],
  ['background-clip',       'border-box'],
];

// Compute the two-value `background-position` from its 1-4 tokens: map each keyword to its
// percentage, keep lengths/percentages, and fill the missing axis with center (`50%`).
// Keyword pairs may be given vertical-first (`top left`); normalise to `x y`. A 3-4 token
// offset form (`left 10px top`) is rare — best-effort: map keywords, keep the first two axes.
function computeBgPosition(tokens) {
  if (tokens.length === 1) {
    const lt = tokens[0].toLowerCase();
    if (lt === 'top' || lt === 'bottom') return '50% ' + BG_POS_PCT[lt];
    if (lt === 'left' || lt === 'right' || lt === 'center') return (BG_POS_PCT[lt] || tokens[0]) + ' 50%';
    return tokens[0] + ' 50%';
  }
  if (tokens.length === 2) {
    let [a, b] = tokens;
    // A vertical-first / horizontal-second keyword pair (`top left`) is written y x → swap to x y.
    if (a.toLowerCase() === 'top' || a.toLowerCase() === 'bottom' ||
        b.toLowerCase() === 'left' || b.toLowerCase() === 'right') { const t = a; a = b; b = t; }
    return (BG_POS_PCT[a.toLowerCase()] || a) + ' ' + (BG_POS_PCT[b.toLowerCase()] || b);
  }
  return tokens.map(t => BG_POS_PCT[t.toLowerCase()] || t).slice(0, 2).join(' ');
}

// A `background-image` value: `none`, a `url(...)`, or an image function (gradient / image-set / …).
const BG_IMAGE_RE = /^(url|(?:repeating-)?(?:linear|radial|conic)-gradient|image-set|cross-fade|element|paint)\(/i;
// A `background-size` component: the `auto`/`cover`/`contain` keywords or a <length-percentage>.
function isBgSizeToken(t) { return /^(auto|cover|contain)$/i.test(t) || /^[+-]?[\d.]/.test(t); }

// Expand ONE comma-separated `background` layer into its longhand components (the ones present;
// callers fill the rest with initials). `isFinal` gates the background-color, which per spec only
// the final layer may carry. The shorthand's grammar is order-independent EXCEPT that a `/`
// binds a (bounded, 1-2 token) `<bg-size>` to the preceding `<position>` — after those size
// tokens, remaining tokens are ordinary layer components again.
function parseBgLayer(layer, isFinal) {
  const out = { image: null, position: null, size: null, repeat: null, attachment: null, origin: null, clip: null, color: null };
  // Tokenise parens-safely (so a `url(a/b.png)` / gradient stays one token), then break out the
  // position/size separator `/` — whether spaced (`center / cover`) or not (`center/cover`) —
  // into its own token. A `/` inside a function is left intact (the token holds a `(`).
  const raw = [];
  for (const tok of splitTopLevel(layer, ' ')) {
    const t = tok.trim(); if (!t) continue;
    if (t !== '/' && t.indexOf('/') !== -1 && t.indexOf('(') === -1) {
      const parts = t.split('/');
      for (let k = 0; k < parts.length; k++) { if (k) raw.push('/'); if (parts[k]) raw.push(parts[k]); }
    } else raw.push(t);
  }
  const posTokens = [], repeats = [], boxes = [], sizeTokens = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i], lt = t.toLowerCase();
    if (t === '/') {
      // The `<bg-size>` (1-2 tokens) follows the slash; stop at the first non-size token.
      while (i + 1 < raw.length && sizeTokens.length < 2 && isBgSizeToken(raw[i + 1])) sizeTokens.push(raw[++i]);
      continue;
    }
    if (lt === 'none' || BG_IMAGE_RE.test(t)) out.image = t;
    else if (BG_REPEAT_KW.has(lt)) repeats.push(lt);
    else if (BG_ATTACH_KW.has(lt)) out.attachment = lt;
    else if (BG_BOX_KW.has(lt)) boxes.push(lt);
    else if (isFinal && isCssColorToken(t)) out.color = t;
    else posTokens.push(t);
  }
  if (repeats.length) out.repeat = repeats.join(' ');
  if (boxes.length) { out.origin = boxes[0]; out.clip = boxes[1] || boxes[0]; }   // one box value sets both
  if (posTokens.length) out.position = computeBgPosition(posTokens);
  // Keywords (cover / contain / auto) lowercase; a <length>/<percentage> passes through verbatim.
  if (sizeTokens.length) out.size = sizeTokens.map(s => /^(cover|contain|auto)$/i.test(s) ? s.toLowerCase() : s).join(' ');
  return out;
}

// Expand the `background` shorthand into every longhand getComputedStyle reports, in computed
// form (position keywords → %, one box → origin+clip, per-layer components comma-joined). A
// CSS-wide keyword applies to all longhands. The final layer's color (or `transparent` when it
// omits one — the shorthand RESETS background-color) becomes background-color.
function expandBackgroundShorthand(value) {
  const v = value.trim();
  if (/^(inherit|initial|unset|revert|revert-layer)$/i.test(v)) {
    const kw = v.toLowerCase();
    return BG_LONGHANDS.map(([prop]) => ({ prop, value: kw })).concat([{ prop: 'background-color', value: kw }]);
  }
  const layers = splitTopLevel(v, ',').map(s => s.trim());
  const parsed = layers.map((lyr, i) => parseBgLayer(lyr, i === layers.length - 1));
  const out = BG_LONGHANDS.map(([prop, initial]) => ({
    prop,
    value: parsed.map(p => p[prop.slice('background-'.length)] != null ? p[prop.slice('background-'.length)] : initial).join(', '),
  }));
  out.push({ prop: 'background-color', value: parsed[parsed.length - 1].color || 'transparent' });
  return out;
}

// `@container (max-width: 47em)` evaluator. Strips an optional
// container-name prefix (`@container my-card (min-width: …)`), then
// reuses `mediaMatches` against the viewport. Bare `@container <name>`
// blocks without a feature query always match.
function containerMatches(prelude, vp) {
  const featureQuery = (prelude || '').replace(/^[^\s(]*\s*/, '');
  if (!featureQuery.trim().startsWith('(')) return true;
  return mediaMatches(featureQuery, vp);
}

// CSS nesting: `&` in a nested selector substitutes the parent
// selector list. Without `&`, the nested selector is implicitly
// `& <descendant> child`. Multi-selector lists distribute.
function composeNestedSelector(child, parent) {
  if (!parent) return child;
  const childParts = splitTopLevel(child, ',').map(p => p.trim()).filter(Boolean);
  const parentParts = splitTopLevel(parent, ',').map(p => p.trim()).filter(Boolean);
  const out = [];
  for (const cp of childParts) {
    const hasAmpersand = /&/.test(cp);
    for (const pp of parentParts) {
      if (hasAmpersand) {
        // Parentheses around pp so that `& .foo` keeps `pp` as a
        // single compound chunk in the descendant join. Real CSS uses
        // `:is(pp)` for this; the in-house matcher supports `:is`.
        out.push(cp.replace(/&/g, ':is(' + pp + ')'));
      } else {
        out.push(pp + ' ' + cp);
      }
    }
  }
  return out.join(', ');
}

// css-tree-backed stylesheet flattener — the replacement for the hand-rolled
// parseCssTree + flattenCssTree pair. Returns the SAME shape the old flattener
// produced: `[{ selectorText, decls:[{prop,value,important}] }]`, with
// @media/@supports/@container resolved against `vp` (non-matching dropped),
// CSS nesting composed via `&` (composeNestedSelector), and only
// cascade-consulted properties retained. `parseValue:false` keeps decl values
// as raw text (we lowercase / trim the few we keep ourselves).
const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
function ruleDecls(block) {
  const decls = [];
  if (!block || !block.children) return decls;
  block.children.forEach(node => {
    if (node.type !== 'Declaration') return;
    // A custom property (`--…`) is case-SENSITIVE, so keep it verbatim (css-tree already
    // unescaped it); a regular property is ASCII case-insensitive → lowercased. Matches the
    // inline `parseStyleDecls` path, so `var(--Foo)` resolves against a `--Foo` definition
    // whether it came from a stylesheet or an inline style.
    const custom = node.property.startsWith('--');
    const prop = custom ? node.property : node.property.toLowerCase();
    // `parseValue:false` keeps the raw value text, which can still hold a
    // `/* … */` comment; strip it so exact compares (`display === 'none'`)
    // match — the old parser ran stripCssComments over the whole sheet first.
    let value = CT.generate(node.value).replace(CSS_COMMENT_RE, '').trim();
    // Expand the `border` shorthand to the captured longhands before the keep-filter
    // (the shorthand itself isn't a captured property).
    if (prop === 'border') {
      for (const d of expandBorderShorthand(value)) decls.push({ prop: d.prop, value: d.value, important: !!node.important });
      return;
    }
    // The `background` shorthand expands to its captured longhands (color / image / position /
    // size / repeat / attachment / origin / clip), each in computed form, so getComputedStyle
    // reports them. An omitted component resets to its initial (a later `background:` overrides an
    // earlier explicit longhand) — in particular a colorless shorthand resets background-color to
    // transparent. (background-image's `url(...)` is absolutized later, per originating sheet.)
    if (prop === 'background') {
      for (const d of expandBackgroundShorthand(value)) decls.push({ prop: d.prop, value: d.value, important: !!node.important });
      return;
    }
    if (!LOWERCASE_VALUE_PROPS.has(prop) && !CAPTURED_PROPS.has(prop) && !custom) return;
    if (LOWERCASE_VALUE_PROPS.has(prop) || prop === 'border-style') value = value.toLowerCase();
    decls.push({ prop, value, important: !!node.important });
  });
  return decls;
}

// The rule's selector text, sliced VERBATIM from the source between the rule
// start and its block's `{`. NOT `CT.generate(prelude)` nor the Raw `.value`:
// css-tree UNESCAPES identifiers (`.lg\:flex` → `.lg:flex`, which a matcher then
// reads as `.lg` + pseudo `:flex`) and its prelude offsets are unreliable across
// escapes — but the block `{` boundary offset is reliable. Tailwind ships
// escaped class names (`.lg\:flex`, `.w-1\/2`) everywhere, so the source escapes
// must survive to css-select. Strip comments (the old stripCssComments).
function preludeSource(ruleNode, src) {
  const end = ruleNode.block.loc.start.offset;
  return src.slice(ruleNode.loc.start.offset, end).replace(CSS_COMMENT_RE, '').trim();
}

// Extract an `@import` prelude into { url, media } (or null if no URL). Handles
// `url("a.css")` / `url(a.css)` / a bare `"a.css"` string, an optional trailing
// media query, and the newer `layer`/`layer(name)`/`supports(...)` tokens (which
// we don't gate on — treated as unconditional, media dropped).
function parseImportPrelude(prelude) {
  const s = String(prelude || '').trim();
  // A QUOTED url("…")/url('…') (the quoted body may contain `)` — e.g. a
  // `?pipe=trickle(d1)` query), an unquoted url(…), or a bare "…"/'…' string.
  let url = null, rest = '';
  let m = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/i.exec(s);
  if (m) { url = m[1] != null ? m[1] : (m[2] != null ? m[2] : (m[3] || '')); rest = s.slice(m[0].length); }
  else {
    m = /^(?:"([^"]*)"|'([^']*)')/.exec(s);
    if (!m) return null;
    url = m[1] != null ? m[1] : m[2]; rest = s.slice(m[0].length);
  }
  url = url.trim();
  if (!url) return null;
  let media = rest.trim();
  // layer / layer(name) / supports(...) prefixes precede the media query; we
  // don't model them, so don't try to media-gate when present.
  if (/^(layer\b|supports\s*\()/i.test(media)) media = '';
  return { url, media: media || null };
}
function parseNamespacePrelude(prelude) {
  const m = /^\s*([A-Za-z_][\w-]*)?\s*(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)|"([^"]*)"|'([^']*)')\s*$/.exec(String(prelude || ''));
  if (!m) return null;
  const uri = (m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : m[6] || '').trim();
  return { prefix: m[1] || '', uri };
}
function cssTreeFlatten(cssText, vp) {
  const out = [];
  const imports = [];
  // Layer names DECLARED in this sheet, in first-appearance order (from
  // `@layer a, b;` statements AND `@layer name { … }` blocks). collect() merges
  // these document-wide into ranks; each rule carries its layer NAME (cacheable
  // per sheet — the rank is document-position-dependent, resolved at collect).
  const layers = [];
  const seenLayers = new Set();
  let anon = 0;
  const addLayer = (full) => { if (!seenLayers.has(full)) { seenLayers.add(full); layers.push(full); } };
  let sheetNs = null;   // the sheet's @namespace map (null = none → plain fast matcher)
  const PARSE_OPTS = { parseValue: false, parseRulePrelude: false, positions: true };
  const emitRule = (ruleNode, src, parentSel, layer) => {
    const sel   = composeNestedSelector(preludeSource(ruleNode, src), parentSel);
    const decls = ruleDecls(ruleNode.block);
    if (decls.length) out.push({ selectorText: sel, decls, layer, ns: sheetNs });
    visit(ruleNode.block && ruleNode.block.children, src, sel, layer);
  };
  // `src` is the source string the current AST was parsed from — needed so
  // `preludeSource` can slice verbatim. The Raw-reparse below changes it to the
  // nested rule's own mini-source. `layer` is the enclosing @layer's full name
  // (null = unlayered).
  const visit = (children, src, parentSel, layer) => {
    if (!children) return;
    children.forEach(node => {
      if (node.type === 'Rule') {
        emitRule(node, src, parentSel, layer);
      } else if (node.type === 'Raw') {
        // css-tree leaves a NESTED rule whose selector doesn't start with `&`
        // (bare `.child {…}` or combinator-led `> .child {…}`) as a Raw node.
        // Per CSS Nesting these are `&`-relative, so slice its VERBATIM source,
        // prepend `& `, reparse, and emit (slicing the prelude from the mini-
        // source preserves escapes there too). (Non-rule Raw — no `{` — is
        // stray text the old parser also dropped.)
        if (parentSel && node.loc && node.value.indexOf('{') !== -1) {
          const mini = '& ' + src.slice(node.loc.start.offset, node.loc.end.offset);
          let r;
          try { r = CT.parse(mini, { context: 'rule', ...PARSE_OPTS }); }
          catch (_) { return; }
          if (r && r.type === 'Rule') emitRule(r, mini, parentSel, layer);
        }
      } else if (node.type === 'Atrule') {
        const name    = (node.name || '').toLowerCase();
        const prelude = node.prelude ? CT.generate(node.prelude).trim() : '';
        if (name === 'layer') {
          // `@layer a, b;` (statement: register order) or `@layer name { … }`
          // / `@layer { … }` (block: descend, tagging rules). Names nest under
          // the enclosing layer (`a` inside `@layer x` → `x.a`).
          const names = prelude ? prelude.split(',').map(s => s.trim()).filter(Boolean) : [];
          const qualify = (nm) => layer ? layer + '.' + nm : nm;
          if (node.block) {
            const full = qualify(names[0] || ('%anon' + (anon++)));
            addLayer(full);
            visit(node.block.children, src, parentSel, full);
          } else {
            for (const nm of names) addLayer(qualify(nm));
          }
          return;
        }
        if (name === 'namespace') {
          if (!parentSel) {
            const p = parseNamespacePrelude(prelude);
            if (p) {
              // A plain object (not a Map) for `prefixes` — this map is JSON-serialized
              // by the cross-visit cascade cache, and a Map would not survive the round-trip.
              if (!sheetNs) sheetNs = { default: null, prefixes: {} };
              if (p.prefix === '') sheetNs.default = p.uri;
              else sheetNs.prefixes[p.prefix] = p.uri;
            }
          }
          return;
        }
        if (name === 'import') {
          // `@import url(…) [media]` — collected here (URL + media) and resolved
          // (fetched + recursively parsed) at collect time, which has I/O; this
          // parser stays pure/cacheable. Only top-level imports are valid CSS.
          // Use the VERBATIM source prelude (not CT.generate, which mangles a
          // url() whose body contains `)` — e.g. a `?pipe=trickle(d1)` query).
          if (!parentSel && node.prelude && node.prelude.loc) {
            const raw = src.slice(node.prelude.loc.start.offset, node.prelude.loc.end.offset);
            const imp = parseImportPrelude(raw);
            if (imp) imports.push(imp);
          }
          return;
        }
        if      (name === 'media')     { if (!mediaMatches(prelude, vp)) return; }
        else if (name === 'supports')  { if (!supportsMatches(prelude)) return; }
        else if (name === 'container') { if (!containerMatches(prelude, vp)) return; }
        else                           { return; }  // keyframes/font-face/… skipped
        // Declarations directly inside the at-rule attach to the enclosing
        // rule's selector (e.g. `@media` nested inside a rule block).
        if (parentSel) {
          const decls = ruleDecls(node.block);
          if (decls.length) out.push({ selectorText: parentSel, decls, layer, ns: sheetNs });
        }
        visit(node.block && node.block.children, src, parentSel, layer);
      }
    });
  };
  let ast;
  try { ast = CT.parse(cssText, PARSE_OPTS); }
  catch (_) { return { rules: out, layers, imports }; }
  visit(ast.children, cssText, null, null);
  return { rules: out, layers, imports };
}

// Walk every `<style>` and `<link rel=stylesheet>` once and pull
// out the two slices of cascade state we care about — hide rules
// (display / visibility, for `visible?`) and layout rules
// (`top/left/width/height` + `text-transform`, for click-offset
// resolution and visible-text upper-casing). One Rack fetch per
// external stylesheet, one css-tree parse per blob.
// Process-wide cache of `parseSheet` results keyed by
// `(length:hash:viewport)`. CSS parse + selector tokenise dominates
// `__csimLoadDocument` on apps with large stylesheets (Discourse main
// CSS ~120-180 ms per visit before this cache landed). The output is
// content-addressable: same CSS text under the same viewport yields
// the same rule list. Per-rule `source` indices start at 0 so the
// caller can shift them by the running document-wide serial.
const __sheetCache = new Map();
// Discourse / Avo / Forem each ship 20-50 unique sheets per page;
// 256 covers a per-test universe with plenty of slack while bounding
// memory for the rare large-CSS app to ~256 × ~200 KB worst case.
const SHEET_CACHE_LIMIT = 256;
function __sheetCacheKey(text, vp) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  // `v2` tag: parseSheet now also returns `imports`; bump so a cross-visit cache
  // (Ruby-backed) populated by the pre-@import parser isn't reused without it.
  return 'v3:' + text.length + ':' + (h >>> 0).toString(16) + ':' + vp.width + 'x' + vp.height;
}

// Parse one stylesheet's text into the per-rule `{hide, layout}`
// shape `collectCascadeRules` wants. Pure: no read of `state`, no
// reference to surrounding document, so the result is safe to cache
// across visits.
function parseSheet(cssText, vp) {
  const hide   = [];
  const layout = [];
  let serial   = 0;
  let flat;
  // Empty result on parse failure is also cached — a malformed sheet
  // re-served on every visit shouldn't pay the parse cost each time.
  try { flat = cssTreeFlatten(cssText, vp); } catch (_) { return { hide, layout, count: 0, layers: [], imports: [] }; }
  for (const r of flat.rules) {
    if (!r.selectorText || !r.decls.length) continue;
    let display = null, displayImp = false;
    let visibility = null, visibilityImp = false;
    const captured = {};
    for (const d of r.decls) {
      if      (d.prop === 'display')    { display = d.value; displayImp = d.important; }
      else if (d.prop === 'visibility') { visibility = d.value; visibilityImp = d.important; }
      if (LAYOUT_PROPS.has(d.prop) || d.prop.startsWith('--')) {
        captured[d.prop] = { value: d.value, important: d.important };
      }
    }
    const hasHide   = display != null || visibility != null;
    const hasLayout = Object.keys(captured).length > 0;
    if (!hasHide && !hasLayout) continue;
    for (const sel of splitTopLevel(r.selectorText, ',')) {
      const trimmed = sel.trim();
      if (!trimmed) continue;
      // selectorText (matched via css-select), specificity + index terminal
      // key via css-tree — no hand-rolled selector AST.
      const spec   = specificityOf(trimmed);
      const term   = terminalKey(trimmed);
      const source = serial++;
      if (hasHide)   hide  .push({ selectorText: trimmed, term, spec, source, layer: r.layer, ns: r.ns, display, displayImp, visibility, visibilityImp });
      if (hasLayout) layout.push({ selectorText: trimmed, term, spec, source, layer: r.layer, ns: r.ns, captured });
    }
  }
  return { hide, layout, count: serial, layers: flat.layers, imports: flat.imports || [] };
}

function parseSheetCached(cssText, vp) {
  const key = __sheetCacheKey(cssText, vp);
  let hit = __sheetCache.get(key);
  if (hit) return hit;
  // Cross-visit (Ruby-backed) parse cache: `parseSheet` is pure, so its result
  // survives the per-visit VM rebuild that wipes the in-VM `__sheetCache` —
  // mirrors CASCADE_RULE_CACHE. On a whole-cascade miss (per-page inline
  // `<style>` changed), this skips the ~12-15ms css-tree parse for unchanged
  // linked sheets. Keyed by (cssText hash, viewport), so content change = new key.
  const getFn = globalThis.__csimSheetCacheGet;
  if (getFn) {
    const cached = getFn(key);
    if (cached) { try { hit = JSON.parse(cached); } catch (_) { hit = null; } }
  }
  if (!hit) {
    hit = parseSheet(cssText, vp);
    const putFn = globalThis.__csimSheetCachePut;
    if (putFn) { try { putFn(key, JSON.stringify(hit)); } catch (_) {} }
  }
  while (__sheetCache.size >= SHEET_CACHE_LIMIT) {
    __sheetCache.delete(__sheetCache.keys().next().value);
  }
  __sheetCache.set(key, hit);
  return hit;
}

// Resolve a parsed sheet's `@import`s (fetch + recursively parse) and push the
// imported sheets BEFORE the importer, so imported rules cascade earlier (CSS:
// @import precedes the sheet's own rules). `seen` guards import cycles/duplicates
// across the whole collection; `baseHref` resolves relative URLs (the importer's
// own URL for a linked/imported sheet, the document base for an inline <style>).
// Absolutize a rule's captured `background-image` url() against its originating sheet's base URL.
// The `captured` object comes from the text-keyed parse cache, so it is NEVER mutated in place — a
// rule that carries an image url gets a shallow-copied captured; every other rule (the common case)
// keeps sharing the cached object, so this allocates nothing on the hot path.
function resolveCapturedImageUrls(captured, base) {
  const bi = captured && captured['background-image'];
  if (!bi || typeof bi.value !== 'string' || bi.value.indexOf('url(') === -1) return captured;
  return { ...captured, 'background-image': { value: resolveCssUrls(bi.value, base), important: bi.important } };
}

function pushSheetWithImports(sheets, parsed, baseHref, vp, seen) {
  const imps = parsed && parsed.imports;
  if (imps && imps.length) {
    for (const imp of imps) {
      if (imp.media && !mediaMatches(imp.media, vp)) continue;
      let abs;
      try { abs = new URL(imp.url, baseHref || undefined).href; } catch (_) { continue; }
      if (seen.has(abs)) continue;
      seen.add(abs);
      let body = null;
      try { body = /^data:/i.test(abs) ? decodeDataUrlCss(abs) : globalThis.__csimExternalAsset(abs); } catch (_) {}
      // An imported sheet's own relative URLs resolve against ITS url, not the importer's.
      if (body) pushSheetWithImports(sheets, parseSheetCached(body, vp), abs, vp, seen);
    }
  }
  // Carry the sheet's base URL alongside the (text-cached, base-independent) parse, so the append
  // step can absolutize `background-image` url()s against the correct originating sheet.
  sheets.push({ sheet: parsed, base: baseHref });
}
function collectCascadeRules(doc, selectedSet) {
  const empty = { hide: [], layout: [] };
  if (!doc || !doc.documentElement) return empty;
  selectedSet = selectedSet || '';
  state.ruleSerial = 0;
  const vp = currentViewport();
  const hide   = [];
  const layout = [];
  // Two passes: gather every sheet (in document order) so the document-wide
  // @layer ranks can be computed from the complete set BEFORE rules resolve
  // their rank. (`<style>` before `<link>` matches the existing source-order
  // bias — both `source` and layer order inherit it consistently.)
  // getElementsByTagName (an HTMLCollection), NOT querySelectorAll (a static
  // NodeList whose length reads through the page-tamperable
  // `NodeList.prototype.length` — NodeList-static-length-getter-tampered-3.html
  // tampers it mid-parse under streaming, which would make this iteration yield
  // undefined and throw). The HTMLCollection's length is immune.
  const sheets = [];
  // @import resolution: `importSeen` guards cycles/dups across all sheets;
  // `docBase` is the base URL for relative @imports AND background-image url()s in inline
  // <style> elements — the document's BASE URL (respecting `<base href>`), not the raw location.
  const importSeen = new Set();
  const docBase = documentBaseUrl();
  // Stylesheet-set selection (alternate / preferred / default-style). `selectedSet`
  // is resolved once by cascadeCacheKey and threaded in, so it matches the key
  // exactly (no recompute, no cache collision). `sheetSetEnabled` returns true for
  // a persistent (titleless non-alternate) sheet, so the common page is unaffected.
  for (const s of doc.documentElement.getElementsByTagName('style')) {
    const media = s._attrs.media;
    if (media && !mediaMatches(media, vp)) continue;
    const title = (s._attrs.title || '').trim();
    if (!sheetSetEnabled(title, false, selectedSet)) continue;  // <style> can't be alternate
    const txt = effectiveStyleCss(s);
    if (txt) pushSheetWithImports(sheets, parseSheetCached(txt, vp), docBase, vp, importSeen);
  }
  for (const l of doc.documentElement.getElementsByTagName('link')) {
    const tokens = (l._attrs.rel || '').toLowerCase().split(/\s+/);
    if (!tokens.includes('stylesheet')) continue;
    const href = l._attrs.href;
    if (!href) continue;
    const media = l._attrs.media;
    if (media && !mediaMatches(media, vp)) continue;
    const title = (l._attrs.title || '').trim();
    const alternate = tokens.includes('alternate');
    if (!linkSheetEnabled(l, title, alternate, selectedSet)) continue;
    try {
      // `data:` CSS is decoded JS-side (the Rack asset fetcher only knows
      // http(s)); everything else is cross-visit cached (same as classic
      // <script src>): fingerprinted CSS is content-stable at content-hashed
      // URLs, so a fresh VM per visit shouldn't re-fetch it. `__csimExternalAsset`
      // serves from the survives-visit cache, returning null on 4xx / failure.
      const body = /^data:/i.test(href) ? decodeDataUrlCss(href) : globalThis.__csimExternalAsset(href);
      if (body) {
        // Base for this sheet's own @imports = its absolute URL (relative imports
        // resolve against the importing sheet, not the document).
        let linkAbs; try { linkAbs = new URL(href, docBase).href; } catch (_) { linkAbs = href; }
        pushSheetWithImports(sheets, parseSheetCached(body, vp), linkAbs, vp, importSeen);
      }
    } catch (_) {}
  }
  // `document.adoptedStyleSheets` (constructable stylesheets — Lit / component CSS)
  // apply AFTER the author <style>/<link> sheets, in array order. Their rules live
  // in the CSSOM object (sheetCssText → the raw replaceSync text / serialized rules).
  const adopted = doc.adoptedStyleSheets;
  if (adopted) for (const sheet of adopted) {
    if (!adoptedSheetActive(sheet, vp)) continue;   // disabled / media-mismatch → no rules
    const txt = sheetCssText(sheet);
    // A constructable sheet's url()s resolve against ITS base URL — the `baseURL` constructor
    // option (`sheet._href`), which defaults to the document base when unset.
    if (txt) pushSheetWithImports(sheets, parseSheetCached(txt, vp), sheet._href || docBase, vp, importSeen);
  }
  // Merge layer names (first-appearance across sheets) → post-order ranks.
  const ordered = [];
  const seen = new Set();
  for (const { sheet: sh } of sheets) for (const nm of (sh.layers || [])) if (!seen.has(nm)) { seen.add(nm); ordered.push(nm); }
  const layerRank = buildLayerRanks(ordered);
  // Append rules in document order; resolve each rule's cacheable layer NAME
  // to its rank. Shift `source` by the running serial so cross-sheet ties
  // break correctly (later sheets win at equal specificity).
  const rankOf = (r) => r.layer != null ? layerRank.get(r.layer) : null;
  for (const { sheet: sh, base: sheetBase } of sheets) {
    const serial = state.ruleSerial;
    for (const r of sh.hide)   hide  .push({ ...r, source: r.source + serial, layerRank: rankOf(r) });
    for (const r of sh.layout) layout.push({ ...r, captured: resolveCapturedImageUrls(r.captured, sheetBase), source: r.source + serial, layerRank: rankOf(r) });
    state.ruleSerial += sh.count;
  }
  return { hide, layout };
}

// Assign each @layer a cascade rank from `orderedNames` (dotted full names in
// first-appearance / declaration order). Ranks come from a POST-ORDER walk of
// the layer tree: a layer's named sublayers (in declaration order) rank BELOW
// its own un-sublayered content (CSS Cascade 5 §6.4.3 — a parent's direct
// content wins over its sublayers). Higher rank = higher normal priority.
function buildLayerRanks(orderedNames) {
  const root = { children: new Map(), order: [] };
  for (const name of orderedNames) {
    let node = root;
    for (const seg of name.split('.')) {
      let child = node.children.get(seg);
      if (!child) { child = { children: new Map(), order: [] }; node.children.set(seg, child); node.order.push(seg); }
      node = child;
    }
  }
  const ranks = new Map();
  const path = [];
  let next = 0;
  const visit = (node) => {
    for (const seg of node.order) { path.push(seg); visit(node.children.get(seg)); path.pop(); }
    if (path.length) ranks.set(path.join('.'), next++);   // self after children
  };
  visit(root);
  return ranks;
}

// Hide-rule index: bucket each rule by the terminal compound's
// most-discriminating signal (id > class > tag > universal). The
// resolver then only walks buckets the element can plausibly match,
// instead of scanning every rule on the page.
//
// Cost model: a Redmine-scale stylesheet has ~4000 rules, of which
// the vast majority pin a class or tag at the terminal. With the
// index, a visibility check for a `<div class="foo">` element
// typically inspects ~5–20 rules instead of all 4000. Cascade
// resolution (specificity + source order + !important) works the
// same — each rule already carries its `spec` / `source` /
// `displayImp` / `visibilityImp` so per-bucket order doesn't matter.
// Bucket rules by their terminal compound's most-discriminating
// signal (id > class > tag > universal). The resolver then only
// walks buckets the element can plausibly match — typically
// ~5–20 rules per element instead of the full 4000 on a
// Redmine/Tailwind page. Layout-rule cascade uses the same shape;
// we maintain a separate index per rule list because the records
// carry different decl shapes.
function buildRuleIndex(rules) {
  const idx = {
    byTag:     new Map(),
    byId:      new Map(),
    byClass:   new Map(),
    universal: []
  };
  for (const r of rules) {
    const term = r.term;
    let bucket;
    if (term.kind === 'class') {
      bucket = idx.byClass.get(term.key);
      if (!bucket) idx.byClass.set(term.key, bucket = []);
    } else if (term.kind === 'id') {
      bucket = idx.byId.get(term.key);
      if (!bucket) idx.byId.set(term.key, bucket = []);
    } else if (term.kind === 'tag') {
      bucket = idx.byTag.get(term.key);
      if (!bucket) idx.byTag.set(term.key, bucket = []);
    } else {
      bucket = idx.universal;
    }
    bucket.push(r);
  }
  return idx;
}
// Walk the rule buckets that could match `el`, calling `cb(rule)`
// for each candidate. Matches the bucket-selection logic that used
// to live inline in `matchesAnyHideRule`.
function forEachCandidateRule(idx, el, cb) {
  const tagBucket = idx.byTag.get(el._tag);
  if (tagBucket) for (const r of tagBucket) cb(r);
  const idAttr = el._attrs.id;
  if (idAttr) {
    const idBucket = idx.byId.get(idAttr);
    if (idBucket) for (const r of idBucket) cb(r);
  }
  for (const c of classes(el)) {
    const cb2 = idx.byClass.get(c);
    if (cb2) for (const r of cb2) cb(r);
  }
  if (idx.universal.length) for (const r of idx.universal) cb(r);
}

// Captured by `collectCascadeRules` into the `layout` slice.
// Union of `CAPTURED_PROPS` (numeric geometry top/left/width/height, color /
// background-color for `style("color")` reads, plus the layout-free
// position / z-index for getComputedStyle) and the lowercase-keyword props
// (`text-transform` / `white-space`) — the rule-capture filter in
// `collectCascadeRules` uses this single `includes()` test to keep the
// captured set tight.
const LAYOUT_PROPS = new Set([...CAPTURED_PROPS, 'text-transform', 'white-space', 'direction', 'appearance']);
// Inline `style="top: 100px; left: 100px"` parsing for one element.
// Split a CSS declaration value into its base value and `!important` flag.
// `!important` is only valid as a trailing token (CSSOM); a stray `!` elsewhere
// (inside `url()` / strings) is left intact. The cheap `indexOf` guard keeps the
// common (no-`!important`) value off the regex path. Shared by the inline-style
// readers so importance parsing can't drift between them.
const IMPORTANT_RE = /\s*!\s*important\s*$/i;
export function splitImportant(value) {
  if (typeof value !== 'string' || value.indexOf('!') < 0) return { value, important: false };
  return IMPORTANT_RE.test(value)
    ? { value: value.replace(IMPORTANT_RE, '').trim(), important: true }
    : { value, important: false };
}

export function parseInlineLayout (el) {
  const out = {};
  const s = el._attrs && el._attrs.style;
  if (!s) return out;
  for (const part of String(s).split(';')) {
    const m = /^\s*(top|left|width|height)\s*:\s*([^;]+?)\s*$/.exec(part);
    // Strip `!important` out of the VALUE (else `parsePx('100px !important')`
    // fails and the box collapses to 0); keep its importance for the cascade.
    if (m) { const d = splitImportant(m[2]); out[m[1]] = { value: d.value, important: d.important }; }
  }
  return out;
}
function parsePx (v) {
  if (v == null) return null;
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v).trim());
  return m ? parseFloat(m[1]) : (/^(-?\d+(?:\.\d+)?)$/.test(v) ? parseFloat(v) : null);
}
export function resolveLayoutProp (el, prop) {
  const inline = parseInlineLayout(el)[prop];
  let best = inline ? { spec: [0,0,0], source: Infinity, inline: true, ...inline } : null;
  if (state.layoutRules.length) {
    if (!state.layoutIdx) state.layoutIdx = buildRuleIndex(state.layoutRules);
    forEachCandidateRule(state.layoutIdx, el, (r) => {
      const cap = r.captured[prop];
      if (!cap) return;
      if (!safeMatches(el, r.selectorText, r.ns)) return;
      if (winsProp(best, r.spec, r.source, cap.important, r.layerRank)) {
        best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source, layerRank: r.layerRank };
      }
    });
  }
  return best ? parsePx(best.value) : parsePx(presentationalHint(el, prop));
}
// Property cascade comparator (the `winsProp` analogue of
// `winsCascade`): does a candidate stylesheet rule beat the current
// best? Importance first, then inline-ness (a non-`!important` inline
// value beats every author selector at equal importance), then
// specificity, then source order. `candidate` is always a stylesheet
// rule, so `candInline` is always false — the check exists so the
// seeded inline `best` holds against same-importance selectors.
function winsProp(current, candSpec, candSource, candImp, candLayerRank) {
  if (!current) return true;
  if (candImp && !current.important) return true;
  if (!candImp && current.important) return false;
  if (current.inline) return false; // candidate is a selector; inline best holds
  const candLP = layerPriority(candLayerRank, candImp);
  const curLP  = layerPriority(current.layerRank, current.important);
  if (candLP !== curLP) return candLP > curLP;
  if (compareSpec(candSpec, current.spec) !== 0) return compareSpec(candSpec, current.spec) > 0;
  return candSource >= current.source;
}
// Sum each ancestor's top/left to translate an element's CSS-declared
// box into an absolute "viewport" position. We don't run a layout
// engine; this is just "if a test declares position via px values,
// honour those values" — enough for the click-offset specs.

// `hidden`: the element carries the `hidden` attribute, i.e. the UA rule
// `[hidden] { display: none }`. That rule is the LOWEST-priority display:none —
// any author `display` declaration (inline or stylesheet, even non-important)
// overrides it — so it only takes effect when no author rule sets `display`
// (`bestD == null`). Modelling it here (rather than an unconditional hide) is
// what lets Capybara's `attach_file ..., make_visible: true` un-hide a `hidden`
// file input by setting an inline `display`.
export function matchesAnyHideRule(el, ignoreVisibility = false, inline = null, hidden = false) {
  // Shadow-tree hide rules apply to elements inside the tree (gated so
  // shadow-free pages pay one truthy check). Resolved alongside document rules
  // through the same winsCascade ladder; the SHADOW_SOURCE_BASE bias on their
  // source lets a shadow rule beat a document rule at equal specificity.
  const shadowHide = shadowRulesForEl(el, 'hide');
  if (state.hideRules.length === 0 && !inline && !(shadowHide && shadowHide.length)) return hidden;
  let bestD = null, bestV = null;
  // Seed with the inline declaration (if any) so each stylesheet rule is
  // compared against it through the same winsCascade precedence ladder
  // (importance first, then specificity, then source order).
  if (inline) {
    if (inline.display != null) {
      bestD = { value: inline.display, important: inline.displayImp, spec: inline.spec, source: inline.source, inline: true };
    }
    if (!ignoreVisibility && inline.visibility != null) {
      bestV = { value: inline.visibility, important: inline.visibilityImp, spec: inline.spec, source: inline.source, inline: true };
    }
  }
  if (state.hideRules.length) {
    if (!state.hideIdx) state.hideIdx = buildRuleIndex(state.hideRules);
    forEachCandidateRule(state.hideIdx, el, (r) => {
      if (!safeMatches(el, r.selectorText, r.ns)) return;
      if (r.display != null && winsCascade(bestD, r, true)) {
        bestD = { value: r.display, important: r.displayImp, spec: r.spec, source: r.source, layerRank: r.layerRank };
      }
      if (!ignoreVisibility && r.visibility != null && winsCascade(bestV, r, false)) {
        bestV = { value: r.visibility, important: r.visibilityImp, spec: r.spec, source: r.source, layerRank: r.layerRank };
      }
    });
  }
  if (shadowHide && shadowHide.length) {
    for (const r of shadowHide) {
      if (!safeMatches(el, r.selectorText, r.ns)) continue;
      if (r.display != null && winsCascade(bestD, r, true)) {
        bestD = { value: r.display, important: r.displayImp, spec: r.spec, source: r.source, layerRank: r.layerRank };
      }
      if (!ignoreVisibility && r.visibility != null && winsCascade(bestV, r, false)) {
        bestV = { value: r.visibility, important: r.visibilityImp, spec: r.spec, source: r.source, layerRank: r.layerRank };
      }
    }
  }
  if (bestD && bestD.value === 'none') return true;
  if (hidden && bestD == null) return true;   // UA [hidden]{display:none}, no author override
  if (bestV && (bestV.value === 'hidden' || bestV.value === 'collapse')) return true;
  return false;
}

// The element's OWN cascaded value for a hide-cascade property (`display` or `visibility`),
// or null if neither inline `style=` nor any matching rule sets it. display / visibility live
// in the hide-rule cascade (not the captured-property map): the hide logic reads them only as
// none / hidden booleans, but getComputedStyle needs the actual keyword. Same precedence ladder
// as matchesAnyHideRule (winsCascade). Skips rule-matching when no rule sets it (common page).
function ownHideProp(el, prop) {
  const imp = prop + 'Imp', isDisplay = prop === 'display';
  const inline = inlineHideDecl(el);
  let best = (inline && inline[prop] != null)
    ? { value: inline[prop], important: inline[imp], spec: inline.spec, source: inline.source, inline: true }
    : null;
  // The `hasVisibilityRule` gate is visibility-only (display has no such fast-path flag).
  if (state.hideRules.length && (isDisplay || state.hasVisibilityRule)) {
    if (!state.hideIdx) state.hideIdx = buildRuleIndex(state.hideRules);
    forEachCandidateRule(state.hideIdx, el, (r) => {
      if (r[prop] == null) return;
      if (!safeMatches(el, r.selectorText, r.ns)) return;
      if (winsCascade(best, r, isDisplay)) {
        best = { value: r[prop], important: r[imp], spec: r.spec, source: r.source, layerRank: r.layerRank };
      }
    });
  }
  // Shadow-tree hide rules incl. :host / ::slotted (gated; see matchesAnyHideRule).
  const shadowHide = shadowRulesForEl(el, 'hide');
  if (shadowHide) {
    for (const r of shadowHide) {
      if (r[prop] == null) continue;
      if (!safeMatches(el, r.selectorText, r.ns)) continue;
      if (winsCascade(best, r, isDisplay)) {
        best = { value: r[prop], important: r[imp], spec: r.spec, source: r.source, layerRank: r.layerRank };
      }
    }
  }
  return best ? best.value : null;
}
function ownVisibility(el) { return ownHideProp(el, 'visibility'); }
// getComputedStyle needs the actual `display` keyword (flex / grid / inline-block / …), which
// the hide logic only reads as none / not-none.
export function ownDisplay(el) { return ownHideProp(el, 'display'); }

// Effective `visibility` for `el`, honouring BOTH inheritance and descendant
// override. `visibility` inherits, but a descendant's `visibility: visible`
// re-shows it under a `visibility: hidden` ancestor — so unlike `display`,
// visibility CANNOT be decided by "any hidden ancestor". Walk ancestor-or-self;
// the nearest element that sets `visibility` explicitly wins (default visible).
// The visible-filter therefore resolves visibility per-target, separately from
// the unconditional display-side ancestor walk.
// The resolved `visibility` keyword (visible / hidden / collapse). `visibility` inherits, and
// a descendant `visibility: visible` re-shows under a hidden ancestor, so the nearest
// ancestor-or-self that sets a CONCRETE value wins; `inherit` / `unset` keep walking up, and
// `initial` (and `revert`, having no UA visibility rule) resolve to `visible`. ownVisibility
// already returns a lowercase value (the hide cascade folds it). Default `visible`.
function resolveVisibility(el) {
  let cur = el;
  while (cur && cur.nodeType === NODE_ELEMENT) {
    const v = ownVisibility(cur);
    if (v != null && v !== 'inherit' && v !== 'unset') {
      return (v === 'initial' || v === 'revert' || v === 'revert-layer') ? 'visible' : v;
    }
    cur = cur._parent;
  }
  return 'visible';
}
export function visibilityHidden(el) { const v = resolveVisibility(el); return v === 'hidden' || v === 'collapse'; }
// The resolved keyword for getComputedStyle (visibility lives in the hide-rule cascade, not
// the captured-property map, so it can't be read via cascadedProperty).
export function computedVisibility(el) { return resolveVisibility(el); }

function winsCascade(current, candidate, isDisplay) {
  const candImp = isDisplay ? candidate.displayImp : candidate.visibilityImp;
  if (!current) return true;
  if (candImp && !current.important) return true;
  if (!candImp && current.important) return false;
  // Importance is now equal. A non-`!important` inline declaration
  // beats every author selector regardless of specificity, and an
  // `!important` inline beats `!important` author rules — both fall
  // out of comparing inline-ness before specificity. `candidate` is
  // always a stylesheet rule here (the inline declaration is only ever
  // the seeded `current`), so in practice this just lets the seeded
  // inline `current` hold against same-importance selectors.
  const candInline = !!candidate.inline;
  const curInline  = !!current.inline;
  if (candInline && !curInline) return true;
  if (!candInline && curInline) return false;
  // Cascade layer (CSS Cascade 5 §6.4.3): among same-importance author rules,
  // unlayered beats layered, and later-declared layers beat earlier — but for
  // !important the whole order INVERTS. `layerPriority` folds both into one
  // comparable (higher wins). Above specificity, below inline.
  const candLP = layerPriority(candidate.layerRank, candImp);
  const curLP  = layerPriority(current.layerRank, current.important);
  if (candLP !== curLP) return candLP > curLP;
  const cmp = compareSpec(candidate.spec, current.spec);
  if (cmp !== 0) return cmp > 0;
  return candidate.source >= current.source;
}

// A single comparable for "which cascade layer wins" (higher = wins). Normal:
// unlayered highest (+∞), later layer (higher rank) above earlier. !important
// inverts: unlayered lowest (−∞), earlier layer (lower rank) above later.
function layerPriority(rank, important) {
  if (rank == null) return important ? -Infinity : Infinity;
  return important ? -rank : rank;
}
// Per innerText: collapse inline-whitespace runs (tab/newline/VT)
// to a single space in each text node.
const INLINE_WS_RE = /[\t\n\v\f\r]+/g;
// Block-shaped tags get a `\n` boundary before/after their content.
// Note: `td`/`th` are deliberately NOT block — W3C innerText §14.4
// inserts only `\t` between adjacent cells; the `\n` only appears
// when the cell's own *content* includes a block-level child (see
// `isCellWithInnerBlock` below). Real Chrome:
//   `<td>A</td><td>B</td>`       → `"A\tB"`
//   `<th><div>A</div></th>…`     → `"A\n\t\nB"`
export const BLOCK_TAGS = new Set([
  'address','article','aside','blockquote','dd','div','dl','dt',
  'figcaption','figure','footer','form','h1','h2','h3','h4','h5',
  'h6','header','hr','li','main','nav','ol','p','pre','section',
  'table','tbody','tfoot','thead','tr','ul'
]);
const TABLE_CELL_TAGS = new Set(['td','th']);
function hasNextCellSibling(node) {
  const siblings = node._parent && node._parent._children;
  if (!siblings) return false;
  const i = siblings.indexOf(node);
  for (let j = i + 1; j < siblings.length; j++) {
    const s = siblings[j];
    if (s.nodeType === NODE_ELEMENT && TABLE_CELL_TAGS.has(s._tag)) return true;
  }
  return false;
}
// CSS flex / grid containers blockify their children, so innerText
// joins them with `\n` even when the children are `<a>` / `<span>`
// (Avo's tab switcher: a `<div class="flex flex-wrap">` of `<a>`s).
// Detection covers the inline-style override and the Tailwind utility
// class — the two ways every observed real-world flex container in
// the test suites declares itself. Other CSS rules can flow in later
// via the cascade if a test needs it.
const FLEX_LIKE_DISPLAY = new Set(['flex','grid','inline-flex','inline-grid']);
const INLINE_DISPLAY_RE = /(?:^|;)\s*display\s*:\s*([^;!]+?)\s*(?:!important)?\s*(?:;|$)/i;
function isFlexLikeContainer(el) {
  const style = el._attrs && el._attrs.style;
  if (style) {
    const m = INLINE_DISPLAY_RE.exec(style);
    if (m) {
      const v = m[1].trim().toLowerCase();
      // Inline `display` wins over class-derived `flex`, either way.
      return FLEX_LIKE_DISPLAY.has(v);
    }
  }
  for (const tok of classes(el)) {
    if (FLEX_LIKE_DISPLAY.has(tok)) return true;
  }
  // Stylesheet-resolved `display`: Discourse user-menu uses `a > div
  // { display: flex; flex-direction: column }` to stack label/desc
  // spans on their own lines. Without this lookup, `collectVisibleText`
  // joins them inline and `find('.notification').text` returns
  // `"username topic"` instead of `"username\ntopic"`.
  return resolvedDisplayIsFlexLike(el);
}
function resolvedDisplayIsFlexLike(el) {
  const d = resolveCascadeDisplay(el);
  return d ? FLEX_LIKE_DISPLAY.has(d) : false;
}
// Returns the cascade-resolved `display` value (lowercased) or null
// when no matching rule sets the property. Doesn't fold in inline
// `style="display: …"` — callers needing that can read the attribute
// directly.
export function resolveCascadeDisplay(el) {
  if (state.hideRules.length === 0) return null;
  if (!state.hideIdx) state.hideIdx = buildRuleIndex(state.hideRules);
  let best = null;
  forEachCandidateRule(state.hideIdx, el, (r) => {
    if (r.display == null) return;
    if (!safeMatches(el, r.selectorText, r.ns)) return;
    if (winsCascade(best, r, true)) {
      best = { value: r.display, important: r.displayImp, spec: r.spec, source: r.source, layerRank: r.layerRank };
    }
  });
  return best ? String(best.value).trim().toLowerCase() : null;
}
// text-transform inherits per CSS — resolve once per element by
// walking inline style → cascade → parent. Capybara's case-insensitive
// assertion message ("found 1 time using a case insensitive search")
// hinges on visible_text being `TEXT HERE` for `text-transform:uppercase`,
// not the underlying `text here`.
// Generic single-property cascade lookup: walks inline `style=` first,
// then any captured stylesheet rule that matches and touches `prop`,
// returning the highest-precedence value (important > specificity >
// source order). Shared by `cascadedTextTransform` /
// `cascadedWhiteSpace` — every additional captured `LAYOUT_PROPS`
// entry rides on this without re-copying the cascade walk.
// HTML "presentational hints" — a handful of content attributes contribute to
// the cascade at an origin BELOW author rules, so getComputedStyle reports them
// only when no author/inline rule sets the property. `<canvas>` maps its
// width/height attributes to the CSS width/height (with the default 300x150
// canvas size when unset). Returns a CSS value string, or null for no hint.
function presentationalHint (el, prop) {
  if ((prop === 'width' || prop === 'height') && el._tag === 'canvas') {
    return (prop === 'width' ? el.width : el.height) + 'px';
  }
  return null;
}

export function cascadedProperty (el, prop) {
  ensureCascadeFresh();
  const style = el._attrs && el._attrs.style;
  const inline = style ? parseInlinePropertyValue(style, prop) : null;
  // Inline seed carries `inline: true`; like winsCascade, the property
  // comparator (`winsProp`) checks inline-ness before specificity so a
  // non-`!important` inline value beats every author selector at equal
  // importance. `spec` stays a real 3-component value.
  let best = inline ? { value: inline.value, important: inline.important, spec: [0,0,0], source: Infinity, inline: true } : null;
  // Shadow encapsulation: an element INSIDE a shadow tree is not matched by
  // document-scope author rules — only by its own tree's sheets (via
  // shadowRulesForEl below), plus inherited values that reach it through the
  // getComputedStyle parent walk. A host or slotted element lives in the OUTER
  // scope (enclosingShadowRootOf → null), so document rules still apply to it.
  const shadowRoot   = globalThis.__csimShadowHostCount ? enclosingShadowRootOf(el) : null;
  const encapsulated = !!shadowRoot;
  const rules = state.layoutRules;
  if (!encapsulated && rules.length && rulesIndexHas(prop)) {
    if (!state.layoutIdx) state.layoutIdx = buildRuleIndex(rules);
    forEachCandidateRule(state.layoutIdx, el, (r) => {
      const cap = r.captured[prop];
      if (!cap) return;
      if (!safeMatches(el, r.selectorText, r.ns)) return;
      if (winsProp(best, r.spec, r.source, cap.important, r.layerRank)) {
        best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source, layerRank: r.layerRank };
      }
    });
  }
  // Shadow-tree author rules: a `<style>` / `adoptedStyleSheets` sheet inside
  // an enclosing shadow root styles elements within that tree. Sources are
  // biased above any document serial (SHADOW_SOURCE_BASE) so a shadow rule wins
  // a source-order tie over a document rule (the shadow scope is "closer").
  // Additive: the document matching above is unchanged. The global host-count
  // gate skips the work entirely on shadow-free pages (the common case); on a
  // page that has any shadow host, a document-scope element still pays one
  // `enclosingShadowRootOf` ancestor walk that finds nothing.
  //
  // Deliberately partial (incremental — no app uses shadow DOM at runtime):
  // this resolves the captured layout props (color / geometry / custom props)
  // for elements INSIDE a shadow tree, which are now encapsulated from
  // document author rules (skipped above). Not yet modelled: shadow
  // `display`/`visibility` hide rules (matchesAnyHideRule doesn't consult
  // shadow sheets, and the hide path still lets document rules reach shadow
  // elements); in-place edits to a shadow `<style>`'s text (cache keys on the
  // document cascadeVersion, so a shadow restyle with no document change can
  // read stale until the next document-sheet change — reassigning
  // adoptedStyleSheets DOES invalidate).
  const shRules = shadowRulesForEl(el, 'layout', shadowRoot);
  if (shRules) {
    for (const r of shRules) {
      const cap = r.captured[prop];
      if (!cap) continue;
      if (!safeMatches(el, r.selectorText, r.ns)) continue;
      if (winsProp(best, r.spec, r.source, cap.important, r.layerRank)) {
        best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source, layerRank: r.layerRank };
      }
    }
  }
  return best ? best.value : presentationalHint(el, prop);
}

// Author serials for shadow-scoped rules start here so they exceed any
// document-sheet serial (per-page rule counts are far below this), letting a
// shadow rule beat a document rule at equal specificity/importance.
const SHADOW_SOURCE_BASE = 1e9;

// A constructed sheet's CSS text: the raw `replaceSync` text when present,
// else reconstructed from its rules (a sheet built via `insertRule` has no
// raw text but its cssRules carry each rule's cssText).
// An adopted stylesheet contributes rules only when it is enabled AND its media (if any)
// matches — a `disabled` constructed sheet, or one whose `{media}` excludes this viewport,
// is inert (constructable-stylesheets disabled / media subtests).
function adoptedSheetActive(sheet, vp) {
  if (!sheet || sheet.disabled) return false;
  const media = sheet.media && sheet.media.mediaText;
  return !media || mediaMatches(media, vp);
}
function sheetCssText(sheet) {
  if (!sheet) return '';
  if (sheet._cssText) return sheet._cssText;
  const rules = sheet.cssRules;
  if (!rules || !rules.length) return '';
  let out = '';
  for (let i = 0; i < rules.length; i++) out += (rules[i].cssText || '') + '\n';
  return out;
}

// Nearest enclosing shadow root of `el` (null if `el` is in the document
// scope). Walks `_parent` — which crosses the shadow boundary at a root's
// host, so the first `_isShadowRoot` hit is the tree `el` actually lives in.
function enclosingShadowRootOf(el) {
  for (let n = el && el._parent; n; n = n._parent) {
    if (n._isShadowRoot) return n;
  }
  return null;
}

// Captured hide (display/visibility) + layout (color/geometry/custom-prop)
// rules from a shadow root's own stylesheets — its `<style>` descendants plus
// `adoptedStyleSheets`. Cached as `{ hide, layout }` on the root keyed on the
// global cascade version (rebuilt on page load / a document sheet mutation; the
// adoptedStyleSheets setter clears the cache, so dynamic reassignment is fresh).
// Rule `source` is biased by SHADOW_SOURCE_BASE so a shadow rule beats a
// document rule at equal specificity (the shadow scope is "closer").
function scopedRulesFor(sr) {
  if (sr._scopedRulesVer === cascadeVersion && sr._scopedRules) return sr._scopedRules;
  const vp = currentViewport();
  const docBase = documentBaseUrl();
  const out = { hide: [], layout: [], hostHide: [], hostLayout: [], slottedHide: [], slottedLayout: [] };
  let serial = SHADOW_SOURCE_BASE;
  // Route a rule to its scope bucket: `:host` / `:host(<inner>)` style the host
  // element (parent scope); `::slotted(<inner>)` styles light-DOM nodes assigned
  // to this tree's slots; everything else styles in-tree descendants. The
  // selectorText is rewritten to the part that matches the cross-scope target
  // (`*` for a bare `:host`). Only the standalone forms are handled — a
  // combinator-bearing `:host .x` / `:host-context(...)` stays an in-tree rule
  // (where it harmlessly fails to match, as before).
  const route = (bucketHide, bucketLayout, rule, sel) => {
    if (rule.__hideRule) bucketHide.push({ ...rule, selectorText: sel, source: rule.source + serial });
    else                 bucketLayout.push({ ...rule, selectorText: sel, source: rule.source + serial });
  };
  const addSheet = (cssText, base) => {
    if (!cssText) return;
    const parsed = parseSheetCached(cssText, vp);
    const place = (rule) => {
      const st = rule.selectorText;
      const stl = st.toLowerCase();   // CSS pseudo names are case-insensitive
      let m;
      if ((m = matchStandalonePseudo(st, stl, '::slotted('))) route(out.slottedHide, out.slottedLayout, rule, m);
      else if (stl === ':host')                               route(out.hostHide, out.hostLayout, rule, '*');
      else if ((m = matchStandalonePseudo(st, stl, ':host('))) route(out.hostHide, out.hostLayout, rule, m);
      else if (rule.__hideRule) out.hide.push({ ...rule, source: rule.source + serial });
      else                      out.layout.push({ ...rule, source: rule.source + serial });
    };
    for (const r of parsed.hide)   place({ ...r, __hideRule: true });
    // Absolutize background-image url()s against the sheet's base (a shadow adoptedStyleSheet can
    // carry a custom baseURL), same as the document cascade's per-sheet append.
    for (const r of parsed.layout) place({ ...r, captured: resolveCapturedImageUrls(r.captured, base) });
    serial += parsed.count;
  };
  for (const s of sr.querySelectorAll('style')) {
    const media = s._attrs.media;
    if (media && !mediaMatches(media, vp)) continue;
    addSheet(scriptText(s), docBase);
  }
  const adopted = sr.adoptedStyleSheets;
  if (adopted) for (const sheet of adopted) if (adoptedSheetActive(sheet, vp)) addSheet(sheetCssText(sheet), sheet._href || docBase);
  sr._scopedRules = out;
  sr._scopedRulesVer = cascadeVersion;
  return out;
}

// All shadow-author rules of the given kind ('hide'|'layout') that target `el`:
//   - in-tree rules of the shadow root `el` lives in (`enclosingShadowRootOf`);
//   - `:host` rules of a shadow root `el` itself hosts;
//   - `::slotted` rules of the shadow tree `el` is slotted into (its host's,
//     when `el` is a light child assigned to a slot).
// Gated on the global host count so shadow-free pages return null immediately.
// `enclosingRoot` is the tree `el` lives in; a caller that already computed it
// (cascadedProperty's encapsulation gate) passes it in to save a second ancestor walk.
function shadowRulesForEl(el, kind, enclosingRoot) {
  if (!globalThis.__csimShadowHostCount) return null;
  const hostKey = kind === 'hide' ? 'hostHide' : 'hostLayout';
  const slotKey = kind === 'hide' ? 'slottedHide' : 'slottedLayout';
  // The first source assigns the cached bucket array by reference; a second
  // source concats into a fresh array. Callers iterate read-only, so never
  // mutate the returned array (it may be a shared cached bucket).
  let out = null;
  const add = (arr) => { if (arr && arr.length) out = out ? out.concat(arr) : arr; };
  const sr = enclosingRoot === undefined ? enclosingShadowRootOf(el) : enclosingRoot;
  if (sr) add(scopedRulesFor(sr)[kind]);
  if (el._shadowRoot) add(scopedRulesFor(el._shadowRoot)[hostKey]);
  // `::slotted`: only resolve the slot (a shadow-tree walk) when the host tree
  // actually has slotted rules — the cached bucket-length check is O(1), so a
  // shadow tree with no `::slotted` rules pays nothing on the hot path. Uses a
  // mode-agnostic slot lookup so styling works for closed roots too.
  if (el._parent && el._parent._shadowRoot) {
    const slotted = scopedRulesFor(el._parent._shadowRoot)[slotKey];
    if (slotted.length && globalThis.__csimSlotForStyling && globalThis.__csimSlotForStyling(el)) add(slotted);
  }
  return out;
}

// If `selectorText` is exactly `<prefix><inner>)` (a standalone functional
// pseudo like `:host(.x)` / `::slotted(span)` with nothing after the closing
// paren), return `<inner>` (original case, so a class like `.Foo` is preserved);
// else null. `lower` is `selectorText` lower-cased for the case-insensitive
// pseudo-name prefix test (`prefix` is lower-case). Balanced-paren aware.
function matchStandalonePseudo(selectorText, lower, prefix) {
  if (!lower.startsWith(prefix)) return null;
  let depth = 1;
  for (let i = prefix.length; i < selectorText.length; i++) {
    const c = selectorText[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i === selectorText.length - 1 ? selectorText.slice(prefix.length, i) : null; }
  }
  return null;
}
function parseInlinePropertyValue (style, prop) {
  // Capture this declaration's OWN trailing `!important` (group 2) — testing the
  // whole style string would mark every property important whenever any one of
  // them is `!important` (e.g. `color: red; display: none !important`).
  const re = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;!]+?)\\s*(!\\s*important)?\\s*(?:;|$)', 'i');
  const m = re.exec(String(style));
  if (!m) return null;
  // Keyword-valued props normalise to lowercase (`cascadedTextTransform`
  // and `cascadedWhiteSpace` compare against lowercase tokens).
  // Non-keyword props — `color: #AABBCC`, custom properties carrying
  // `url(/Foo.png)` etc. — must keep their case.
  const lower = LOWERCASE_VALUE_PROPS.has(prop);
  return { value: lower ? m[1].toLowerCase() : m[1], important: m[2] != null };
}
// "Does the captured rule-set contain at least one declaration for
// this property?" Cached lazily alongside `layoutIdx`. Without this
// guard the cascade walk fires per element on every render even when
// the stylesheet has zero rules touching the property — Discourse's
// ~2000-rule sheet would otherwise pay a per-element bucket walk for
// each `LAYOUT_PROPS` entry on every visible_text call.
function rulesIndexHas (prop) {
  let cache = state.propCache;
  if (!cache) cache = state.propCache = Object.create(null);
  if (prop in cache) return cache[prop];
  let found = false;
  for (const r of state.layoutRules) {
    if (r.captured && r.captured[prop]) { found = true; break; }
  }
  return cache[prop] = found;
}
function cascadedTextTransform (el) {
  // Resolve text-transform purely through the cascade (inline style +
  // matching stylesheet rules, honouring !important / specificity /
  // source order). Real browsers compute text-transform from the
  // actually-applied declaration, never from a class name — e.g.
  // `.uppercase { color: red }` must NOT uppercase the element's text.
  return cascadedProperty(el, 'text-transform');
}
export function resolveTextTransform (el) {
  for (let cur = el; cur && cur.nodeType === NODE_ELEMENT; cur = cur._parent) {
    const v = cascadedTextTransform(cur);
    if (v && v !== 'inherit') return v;
  }
  return 'none';
}
function applyTextTransform (text, mode) {
  if (!text || mode === 'none' || mode === 'initial' || mode === 'unset' || !mode) return text;
  if (mode === 'uppercase') return text.toUpperCase();
  if (mode === 'lowercase') return text.toLowerCase();
  if (mode === 'capitalize') {
    return text.replace(/(^|\s)(\S)/g, (_, ws, ch) => ws + ch.toUpperCase());
  }
  return text;
}
// `white-space: pre*` (and `break-spaces`) preserves whitespace runs
// and trailing whitespace adjacent to `<br>`. Resolved via the shared
// `cascadedProperty` walk; `<pre>` short-circuits below because its
// UA-stylesheet `white-space: pre` isn't expressible as a captured
// author-stylesheet rule.
const WS_PRESERVING_VALUES = new Set(['pre', 'pre-wrap', 'pre-line', 'break-spaces']);
export function elementPreservesWhitespace(node) {
  // `<pre>` is the UA-stylesheet `white-space: pre` shorthand; everything
  // else goes through cascade resolution. Inheritance is honoured at
  // `collectVisibleText`'s ancestor walk — an ancestor's `pre-wrap`
  // (PM editor base CSS sets `.ProseMirror { white-space: pre-wrap }`)
  // propagates down without each descendant needing its own rule.
  if (node._tag === 'pre') return true;
  const v = cascadedProperty(node, 'white-space');
  return v != null && WS_PRESERVING_VALUES.has(v);
}
export function collectVisibleText(node, transform, preserveWs) {
  if (node.nodeType === NODE_TEXT) {
    const data = String(node.data || '');
    // Recursion threads `preserveWs` from the entering element, but
    // a direct text-node entry (rare) has no flag — fall back to the
    // ancestor walk in that case.
    if (preserveWs === undefined) {
      for (let cur = node._parent; cur; cur = cur._parent) {
        if (cur.nodeType !== NODE_ELEMENT) continue;
        if (elementPreservesWhitespace(cur)) { preserveWs = true; break; }
      }
    }
    let raw = preserveWs ? data : data.replace(INLINE_WS_RE, ' ');
    // Under `white-space: pre*`, runs of trailing whitespace adjacent
    // to a `<br>` (next sibling) must survive Capybara's
    // `normalize_visible_spacing`, whose `/[ \n]*\n[\ \n]*/` strip
    // would eat them once `<br>` is materialised as `\n` by the parent
    // walk. NBSP isn't in the strip class, and the final
    // `tr(NBSP, ' ')` converts back to a regular space — so trade the
    // trailing run to NBSPs here. Mirrors what real browsers' typing-
    // time ` ` substitution does at the DOM level, but limited to
    // the preserveWs boundary so tests in `white-space: normal`
    // contexts keep the standard collapsed output.
    if (preserveWs && raw.length) {
      // Spaces flanking a literal `\n` in the text node itself
      // (`<pre>X  \nY</pre>`).
      raw = raw.replace(/ +(?=\n)|(?<=\n) +/g, m => '\u00A0'.repeat(m.length));
      // Trailing spaces immediately before a `<br>` sibling \u2014 the
      // parent walk emits the `<br>` as `\n`, so Capybara's normalize
      // would still strip the run without this substitution.
      if (raw.endsWith(' ')) {
        const next = node.nextSibling;
        if (next && next.nodeType === NODE_ELEMENT && next._tag === 'br') {
          raw = raw.replace(/ +$/, m => '\u00A0'.repeat(m.length));
        }
      }
    }
    return applyTextTransform(raw, transform || 'none');
  }
  if (node.nodeType !== NODE_ELEMENT && node.nodeType !== NODE_DOC && node.nodeType !== NODE_FRAGMENT) return '';
  if (node.nodeType === NODE_ELEMENT) {
    if (INVISIBLE_TAGS.has(node._tag)) return '';
    if (node._tag === 'input' && (node._attrs.type || '').toLowerCase() === 'hidden') return '';
    if (selfHidden(node)) return '';
    if (node._tag === 'br') return '\n';
    const ownTransform = cascadedTextTransform(node);
    const effTransform = (ownTransform && ownTransform !== 'inherit') ? ownTransform : (transform || 'none');
    // `preserveWs` is sticky: once an ancestor has `white-space: pre*`
    // (or is `<pre>`), every descendant text node preserves whitespace,
    // so threading the flag down beats walking ancestors per text node.
    if (!preserveWs && elementPreservesWhitespace(node)) preserveWs = true;
    if (node._tag === 'details' && node._attrs.open == null) {
      // Closed details: only emit text inside <summary>.
      let s = '';
      for (const c of node._children) {
        if (c.nodeType === NODE_ELEMENT && c._tag === 'summary') s += collectVisibleText(c, effTransform, preserveWs);
      }
      return s;
    }
    transform = effTransform;
  }
  const flexContext = node.nodeType === NODE_ELEMENT && isFlexLikeContainer(node);
  let out = '';
  for (const c of node._children) {
    // Whitespace-only text nodes between flex/grid items don't
    // produce visible runs (no anonymous flex item is generated
    // for whitespace).
    if (flexContext && c.nodeType === NODE_TEXT && !/\S/.test(String(c.data || ''))) continue;
    const part = collectVisibleText(c, transform, preserveWs);
    if (!part) continue;
    // A td/th whose collected content carries a `\n` (i.e., its own
    // walk included a block-level child) acts like a block at the
    // tr-level: \n before AND after to produce `"A\n\t\nB"` between
    // adjacent cells, matching W3C innerText §14.4. A cell whose
    // content is pure inline text emits only the `\t` separator —
    // Chrome `tr.innerText` for `<td>A</td><td>B</td>` is `"A\tB"`.
    const isCellWithInnerBlock =
      c.nodeType === NODE_ELEMENT &&
      TABLE_CELL_TAGS.has(c._tag) &&
      part.indexOf('\n') !== -1;
    const isBlock = c.nodeType === NODE_ELEMENT &&
                    (BLOCK_TAGS.has(c._tag) || flexContext || isCellWithInnerBlock);
    if (isBlock && out && !out.endsWith('\n')) out += '\n';
    out += part;
    if (isBlock && !part.endsWith('\n')) out += '\n';
    if (c.nodeType === NODE_ELEMENT && TABLE_CELL_TAGS.has(c._tag) && hasNextCellSibling(c)) {
      out += '\t';
    }
  }
  return out;
}
