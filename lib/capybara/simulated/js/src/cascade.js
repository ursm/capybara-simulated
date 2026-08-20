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
// Layout side: `inlineDecls(el)` + `resolveLayoutProp(el, prop)`
// surface the declared `left` / `top` / `width` / `height` values the
// box-layout engine (layout.js) resolves boxes from.

import { NODE_ELEMENT, NODE_TEXT, NODE_DOC, NODE_FRAGMENT } from './constants.js';
import { LONGHANDS } from './css-property-data.js';

import { walk, classes, scriptText } from './walk.js';
import { bumpStyleState, currentStyleStateGen } from './mutation-observer.js';
import { isStaticallyInvalidMath } from './calc.js';
import { mediaMatches, currentViewport, supportsMatches } from './media-query.js';
import { splitTopLevel, decodeDataUrlCss, resolveCssUrls, documentBaseUrl, parseStyleDeclList, isSupportedCssPropertyName, serializeCssValue } from './css-utils.js';
import { isRegularShorthand, shorthandExpand, shorthandLonghands, isCssWideKeyword, hasSubstitution,
         pendingSubstitution, FONT_SHORTHAND } from './shorthands.js';
import { matchesSelector, matchesSelectorNS } from './selectors.js';
import { normalizeColor, declaredValue, fontRelativeToPx, uaDefault } from './style-proxy.js';
import { hasMathFunction, reduceMathFunctions, absoluteToPx } from './calc.js';

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
// Which ATTRIBUTES a layout- or visibility-affecting selector reads, collected from the parse the
// bucket key already needs. A write to an attribute outside this set cannot change what any box is
// measured from, so the layout keeps its per-element measurements across it (see
// `markLayoutDirty`). `*` stands for a selector we could not parse: assume everything.
function noteSelectorAttrs(groups, out) {
  for (const g of groups) {
    for (const t of g) {
      if (t.type === 'attribute') out.add(String(t.name).toLowerCase());
      // `:is()` / `:not()` / `:has()` carry nested selector groups; `:nth-child(2n)` carries none.
      else if (t.data && typeof t.data !== 'string' && t.data.length) noteSelectorAttrs(t.data, out);
    }
  }
}
function terminalKey(selText, attrsOut) {
  let groups;
  try { groups = CW.parse(selText); }
  catch (_) { if (attrsOut) attrsOut.add('*'); return { kind: 'universal' }; }
  if (attrsOut) noteSelectorAttrs(groups, attrsOut);
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

// ── ancestor reject filter ──────────────────────────────────────────────────
// 82% of the rules a bucket hands back carry a combinator, and 99.4% of THOSE fail the
// match (measured on Discourse: 172,704 candidates, 171,638 rejected). They fail on the
// ancestor side — the rightmost compound is what the bucket matched on, so it fits. This
// is the filter every engine puts in front of that walk: collect the identifiers an
// ancestor MUST carry, hash each into one bit, and refuse the rule when the element's
// ancestor chain has no such bit. A bloom answers "definitely absent" exactly, and
// "possibly present" is just the full match we would have run anyway — so a false
// positive costs nothing and a false negative is impossible.
//
// Only TOP-LEVEL tag / class / id tokens of an ancestor compound are collected. A
// functional pseudo (`:is()`, `:not()`, `:has()`) is skipped rather than descended into:
// `.x:is(.a,.b) .c` still requires `.x` of an ancestor, but requires neither `.a` nor
// `.b`, and collecting fewer identifiers only ever makes the filter more permissive.
// Collection also STOPS at a sibling combinator: in `.a ~ .b .c`, `.b` is an ancestor of
// `.c` but `.a` is only its sibling, so nothing left of `~` is guaranteed to be above us.
const ANC_BLOOM_WORDS = 8;                       // 256 bits — ~45 identifiers on a deep chain
const ANC_MAX_HASHES  = 4;                       // beyond this the extra bits stop paying
function ancBloomHash(kind, name) {
  let h = kind === 1 ? 0x811c9dc5 : kind === 2 ? 0x01000193 : 0x9e3779b9;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}
// The identifiers an ANCESTOR of a subject matching `selText` must carry, as hashes.
// `null` when the selector constrains no ancestor (no combinator, or nothing collectable).
function ancestorHashes(selText) {
  let groups;
  try { groups = CW.parse(selText); } catch (_) { return null; }
  const toks = groups[0] || [];
  const out = [];
  let inSubject = true;                          // walking right-to-left, start at the subject
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    // `<` (css-what `parent`) puts the SUBJECT on the left: `a < b` asks for a CHILD named b,
    // not an ancestor. Anything left of it constrains descendants, so stop, exactly as for the
    // sibling combinators. (css-tree rejects `<` and `||` today, so this arm is a guard against
    // the day it does not — not a live path.)
    if (t.type === 'sibling' || t.type === 'adjacent' || t.type === 'column-combinator' ||
        t.type === 'parent') break;
    if (t.type === 'descendant' || t.type === 'child') { inSubject = false; continue; }
    if (inSubject) continue;                     // the bucket already matched on this compound
    let h = 0;
    if (t.type === 'tag') { if (t.name && t.name !== '*') h = ancBloomHash(3, t.name.toLowerCase()); }
    else if (t.type === 'attribute') {
      // Both sides fold to lowercase. `[class~="FOO" i]` matches `class="foo"` — css-what marks
      // that with `ignoreCase`, and hashing the value verbatim made the required bit one the
      // element could never have, which is a false negative: the rule silently stopped applying.
      // Folding is the permissive direction (two names that differ only in case share a bit, so
      // at worst a rule survives to the full match it would have run anyway), and it also holds
      // if quirks mode ever turns `ignoreCase: 'quirks'` into real case-insensitivity.
      if (t.name === 'class' && t.action === 'element') h = ancBloomHash(1, t.value.toLowerCase());
      else if (t.name === 'id' && t.action === 'equals') h = ancBloomHash(2, t.value.toLowerCase());
    }
    if (h && out.indexOf(h) < 0) { out.push(h); if (out.length >= ANC_MAX_HASHES) break; }
  }
  return out.length ? out : null;
}
// The union of every ancestor's tag / id / classes, one bit each. Keyed on the SAME
// context epoch the declared-value memo uses: it is an ancestor-chain hash, so it moves
// exactly when this filter's answer could.
function ancestorBloom(el) {
  const ctx = ctxEpochOf(el);
  if (el._abCtx === ctx && el._abVal) return el._abVal;
  const bits = new Uint32Array(ANC_BLOOM_WORDS);
  const add = (h) => { bits[(h >>> 5) & (ANC_BLOOM_WORDS - 1)] |= (1 << (h & 31)); };
  for (let n = el._parent; n; n = n._parent) {
    if (!n._tag) continue;                       // a document / fragment carries no identifiers
    add(ancBloomHash(3, n._tag));
    const a = n._attrs;
    if (a) {
      if (a.id) add(ancBloomHash(2, a.id.toLowerCase()));
      const cls = a.class;
      if (cls) for (const c of cls.split(/\s+/)) if (c) add(ancBloomHash(1, c.toLowerCase()));
    }
  }
  el._abCtx = ctx;
  el._abVal = bits;
  return bits;
}
function ancestorAdmits(el, hashes) {
  const bits = ancestorBloom(el);
  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i];
    if ((bits[(h >>> 5) & (ANC_BLOOM_WORDS - 1)] & (1 << (h & 31))) === 0) return false;
  }
  return true;
}

// css-select match, guarded — an unparseable/unsupported selector never matches
// (the hand-rolled matcher likewise threw → caller skipped). A rule whose
// selector threw a SyntaxError is flagged unmatchable so the hot per-element
// loops skip it with one property read instead of a compile-and-throw per
// probe. SyntaxError only: it's deterministic per selector, while any other
// throw could be transient and must not disable the rule for good.
function safeMatches(el, r) {
  if (r.unmatchable) return false;
  // Every considered rule funnels through here, so this is where a `:has()`-bearing rule marks
  // the surrounding read uncacheable for the context-epoch memo (see ctxUnsafeReadSeq).
  if (ruleLooksDown(r)) ctxUnsafeSeq++;
  // …and this is where the ancestor filter sits: AFTER the taint (a rule considered is
  // considered however it is refused) and before the only expensive thing here.
  if (r.anc && !ancestorAdmits(el, r.anc)) return false;
  try { return r.ns ? matchesSelectorNS(el, r.selectorText, r.ns) : matchesSelector(el, r.selectorText); }
  catch (e) {
    if (e && e.name === 'SyntaxError') r.unmatchable = true;
    return false;
  }
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

// The display-side check for the ELEMENT ITSELF — no ancestor walk, no connectivity check. For a
// caller that has already established both (the layout walk descends only into rendered parents,
// starting from a connected <body>), `isLaidOutNode` re-walks every ancestor and re-matches hide
// rules at each level, making a whole-tree pass O(elements x depth x hide-rules) when
// O(elements x hide-rules) is enough. Same verdict, minus the work the caller already did.
export function selfNotRendered(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return true;
  if (INVISIBLE_TAGS.has(el._tag)) return true;
  if (el._tag === 'input' && (el._attrs.type || '').toLowerCase() === 'hidden') return true;
  return selfHidden(el, true);
}
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
// are the flattened rule lists; `hideIdx` (per-tag buckets) and
// `layoutPropIdx` (property-first) are built lazily on first lookup
// after invalidation;
// `ruleSerial` is the monotonic source-order counter the cascade
// resolver uses for tie-breaking.
const state = {
  hideRules: [], layoutRules: [],
  hideIdx:   null, layoutPropIdx: null,
  // The attribute names those rules' selectors read; `*` = a selector we could not parse.
  styledAttrs: new Set(['*']),
  ruleSerial: 0,
  hasImportantHideRule: false,
  hasVisibilityRule: false,
  hasDynamicLayoutRule: false,
  hasMinMaxRule: false
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
// Is the sheet this `<style>` / `<link>` owns DISABLED? `disabled` is a CSSOM flag on the SHEET,
// not a content attribute — `document.styleSheets[0].disabled = true` and `styleEl.disabled = true`
// (which HTMLStyleElement reflects onto its sheet) both set it with nothing in the DOM to see. It
// was invisible to the cascade key AND to the rule collection, so a disabled sheet kept applying.
// `<link disabled>` also has the attribute form, which the callers check separately; this covers
// the sheet-object route both elements share.
function sheetDisabled(el) {
  const sheet = el._sheet;
  return !!(sheet && sheet.disabled);
}

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
    if (sheetDisabled(s)) continue;      // contributes nothing; re-enabling re-keys and rebuilds
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
    if (l._attrs.disabled != null || sheetDisabled(l)) continue;
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
  // Cross-visit caching happens PER SHEET (parseSheetCached / parseUrlSheetCached),
  // not per sheet-SET: a progressive page load rebuilds the cascade several times
  // as sheets stream in (each with a distinct set key), so a whole-set cache would
  // deserialize the ENTIRE rule set on every one of those rebuilds — per-sheet
  // caching makes each rebuild reuse every already-parsed sheet and pay only for
  // the new one. Indexes (`hideIdx`/`layoutPropIdx`) are rebuilt lazily from
  // each rule's precomputed `term`, so they aren't cached.
  const vp  = currentViewport();
  const { key, selectedSet } = cascadeCacheKey(doc, vp);
  // Sheets + viewport unchanged since the last build → the cascade is already
  // current (state + lazily-built index stay valid). Skips the redundant
  // per-linked-sheet rebuilds a page graft schedules.
  if (key === lastCascadeKey) return;
  lastCascadeKey = key;
  cascadeVersion = (cascadeVersion + 1) | 0;   // cascade actually changing → invalidate cascade-keyed memos
  const { hide, layout, attrs } = collectCascadeRules(doc, selectedSet);
  state.hideRules   = hide;
  state.layoutRules = layout;
  state.styledAttrs = attrs;
  state.hideIdx = null;
  state.layoutPropIdx = null;
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
  state.hasDynamicLayoutRule = computeHasDynamicLayoutRule(hide, layout);
  state.hasMinMaxRule = computeHasMinMaxRule(layout);
}

export function resetCascadeState() {
  lastCascadeKey = null;   // force the next rebuildCascade to run (state is now empty)
  cascadeVersion = (cascadeVersion + 1) | 0;
  state.hideRules = [];
  state.layoutRules = [];
  state.styledAttrs = new Set(['*']);
  state.hideIdx = null;
  state.layoutPropIdx = null;
  state.hasImportantHideRule = false;
  state.hasVisibilityRule = false;
  state.hasDynamicLayoutRule = false;
  state.hasMinMaxRule = false;
}

function computeHasImportantHideRule(hide) {
  for (const r of hide) {
    if (r.displayImp || r.visibilityImp) return true;
  }
  return false;
}

// Properties that can only ever change how a box is PAINTED, never where it is or how big.
// Everything else counts as layout-affecting, so an unlisted property (a new one, a typo, a
// shorthand we don't recognise) is treated conservatively as moving boxes.
const PAINT_ONLY_PROPS = new Set([
  'color', 'background', 'background-color', 'background-image', 'background-repeat',
  'background-position', 'background-position-x', 'background-position-y', 'background-size',
  'background-attachment', 'background-clip', 'background-origin', 'background-blend-mode',
  'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color',
  'border-left-color', 'outline-color', 'box-shadow', 'text-shadow', 'text-decoration-color',
  'caret-color', 'accent-color', 'cursor', 'fill', 'stroke',
  // None of these move a box in THIS engine either: outlines draw outside the box model
  // (`outline` does not take space), text decorations paint on the text runs we already
  // measured, `text-overflow` clips painting without changing the box, and transitions only
  // interpolate toward a state whose properties are captured separately.
  'outline', 'outline-width', 'outline-style', 'outline-offset',
  'text-decoration', 'text-decoration-line', 'text-decoration-style', 'text-decoration-thickness',
  'text-underline-offset', 'text-overflow',
  'transition', 'transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'
]);
// Can a DYNAMIC-pseudo rule (`:hover`, `:checked`, `:placeholder-shown`, …) move a box on this
// page? Layout memos key on the style-state generation only when it can, because that generation
// moves for every keystroke, focus and hover — and keying on it unconditionally made one
// `setRangeText` cost a whole-document relayout (measured: 1 ms → 2.9 s for 100 type-and-measure
// rounds on a 300-row page). The overwhelmingly common dynamic rule paints and nothing more
// (`:hover { background: … }`), and that page now pays nothing.
//
// This asks the RULES, never the state writers: any dynamic rule declaring anything outside the
// paint-only set above answers yes, and a page with a shadow tree (whose sheets are not in this
// index) answers yes unconditionally.
function computeHasDynamicLayoutRule(hide, layout) {
  for (const r of hide) {
    // A hide rule carries `display` / `visibility` — both move boxes.
    if (ruleIsDynamic(r) && (r.display != null || r.visibility != null)) return true;
  }
  for (const r of layout) {
    if (!ruleIsDynamic(r)) continue;
    for (const prop in r.captured) {
      if (!PAINT_ONLY_PROPS.has(prop)) return true;
    }
  }
  return false;
}

// The four size CONSTRAINTS, plus their logical spellings — the properties `clampToMinMax` reads.
const MIN_MAX_PROPS = [
  'min-width', 'max-width', 'min-height', 'max-height',
  'min-inline-size', 'max-inline-size', 'min-block-size', 'max-block-size'
];
function computeHasMinMaxRule(layout) {
  for (const r of layout) {
    for (const prop of MIN_MAX_PROPS) if (own(r.captured, prop)) return true;
  }
  return false;
}
// "Could anything constrain this element's used size?" Layout asks before spending four cascade
// lookups per element per pass on `min-*` / `max-*`; on a page that declares none of them (the
// common one) the clamp costs a boolean. Rules are precomputed per cascade build, inline style is
// the element's own cached map, and the UA stylesheet declares no size constraint at all — so
// those three are the whole answer. A shadow tree's sheets aren't in the rule index, so a page
// with one answers yes unconditionally, exactly as `cascadeDeclaresProperty` does.
export function mayConstrainSize (el) {
  ensureCascadeFresh();
  if (state.hasMinMaxRule || globalThis.__csimShadowHostCount) return true;
  const inline = inlineDecls(el);
  for (const prop of MIN_MAX_PROPS) if (prop in inline) return true;
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
// A keyword-valued property's value is ASCII case-insensitive, so it normalises to lowercase —
// but only when it IS a keyword. A value containing a function is left alone: `var(--Foo)` names a
// case-SENSITIVE custom property, and folding it silently drops the reference.
function lowercaseKeywordValue (prop, value) {
  if (!LOWERCASE_VALUE_PROPS.has(prop) && prop !== 'border-style') return value;
  return value.indexOf('(') === -1 ? value.toLowerCase() : value;
}
const LOWERCASE_VALUE_PROPS = new Set(['display', 'visibility', 'text-transform', 'white-space', 'direction', 'appearance', 'text-align', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-content', 'align-self', 'overflow', 'overflow-x', 'overflow-y']);
// A rule's captured declarations are keyed by PROPERTY NAME, and every read below can be reached
// with a name that came from page script. The map can't simply be prototype-less — it round-trips
// through the JSON sheet cache — so each read takes an own-property check instead, or
// `captured['constructor']` answers with Object.prototype's and reads as a winning declaration
// whose value is `undefined`.
function own (map, prop) {
  return map != null && Object.prototype.hasOwnProperty.call(map, prop) ? map[prop] : undefined;
}

// EVERY declaration a rule carries is captured. The cascade used to keep only a hand-listed set,
// which made the resolver's answer for anything outside it a guess: a resolved-value read either
// reported '' — which page code takes as a real answer, and Floating UI reading `transform !==
// 'none'` concluded every element establishes a containing block — or, once we reported initial
// values, confidently said `box-shadow: none` for an element a stylesheet plainly gives a shadow.
// The list also had to grow every time a library read a property nobody had thought of.
//
// Capturing everything costs ~1% of app-suite wall time, measured on the two heaviest stylesheets
// we have: Discourse 89s → 90s over four system specs, Forem 172s → 175s. The work per declaration
// was already being done by the parse; only the keep-decision changed. A resolved value is now
// either something the page declares or the property's initial, never a guess.

// The CSS box shorthands (`margin` / `padding` / `inset`): 1–4 values map to top / right / bottom /
// left by the usual mirroring rules. A value count outside 1–4 is invalid and contributes nothing.
function expandBoxShorthand(prop, value) {
  const parts = splitTopLevel(value, ' ').map(t => t.trim()).filter(Boolean);
  if (!parts.length || parts.length > 4) return [];
  const [top, right = top, bottom = top, left = right] = parts;
  // `inset`'s longhands ARE the physical insets (`top` / `right` / …), not `inset-top` & co.
  const name = (side) => prop === 'inset' ? side : `${prop}-${side}`;
  return [
    { prop: name('top'),    value: top },
    { prop: name('right'),  value: right },
    { prop: name('bottom'), value: bottom },
    { prop: name('left'),   value: left }
  ];
}

// `overflow: <x> [<y>]` — one value sets both axes, two set them in order. The longhands are what
// everything reads: our own clip / scroll-container test, and page code deciding whether an
// ancestor scrolls (Floating UI's `isOverflowElement` tests `overflow + overflowY + overflowX`).
// The shorthand itself stays captured so getComputedStyle can report it directly.
function expandOverflowShorthand(value) {
  const parts = splitTopLevel(value, ' ').map(t => t.trim()).filter(Boolean);
  if (!parts.length || parts.length > 2) return [];
  const [x, y = x] = parts;
  return [{ prop: 'overflow', value }, { prop: 'overflow-x', value: x }, { prop: 'overflow-y', value: y }];
}

// The flow-relative BORDER shorthands (`border-block-end: 3px solid red`), which the CSSOM registry
// doesn't carry. They expand exactly like their physical twins — the width / style / colour
// classification is shared — into `border-<flow-side>-{width,style,color}`; turning those into a
// physical side is the reader's job, since it depends on the writing mode.
const LOGICAL_BORDER_RE = /^border-(block|inline)(-(start|end))?$/;
function expandLogicalBorder(prop, value) {
  const flow = prop.slice('border-'.length);
  const parts = expandBorderShorthand(value);          // border-{width,style,color}
  const sides = flow === 'block' ? ['block-start', 'block-end']
              : flow === 'inline' ? ['inline-start', 'inline-end']
              : [flow];
  const out = [];
  for (const side of sides) {
    for (const d of parts) out.push({ prop: `border-${side}-${d.prop.slice('border-'.length)}`, value: d.value });
  }
  // `border-block` also sets the AXIS-level names (`border-block-width`), which are shorthands over
  // the two sides in their own right. Chrome reports `border-block-width: 2px` for
  // `border-block: 2px solid red` (measured); emitting only the per-side longhands left the axis
  // names undeclared, and the resolved-value read then answered with their initial.
  if (sides.length === 2) {
    for (const d of parts) out.push({ prop: `border-${flow}-${d.prop.slice('border-'.length)}`, value: d.value });
  }
  return out;
}

// `font` — the cascade's own reading of it. The CSSOM registry deliberately doesn't carry `font`
// (its block serialization has a contract this parse doesn't model), but the cascade still wants
// the longhands, so it takes the shared parse and shapes it into the `{prop, value}` list the
// expander speaks.
function expandFontShorthand(value) {
  const vals = FONT_SHORTHAND.expand(value);
  return vals ? FONT_SHORTHAND.longhands.map((prop, i) => ({ prop, value: vals[i] })) : [];
}

// `text-decoration: <line> || <style> || <color> || <thickness>` — a free-order shorthand the CSSOM
// registry doesn't carry. The line keywords are a space-separated LIST (`underline overline`), the
// style is one of five keywords, and anything else is the colour. Expanding it is what lets a
// resolved-value read serialize the shorthand back from its longhands, and what makes an inherited
// `text-decoration-line` visible to a child.
const TEXT_DECORATION_LINES  = new Set(['none', 'underline', 'overline', 'line-through', 'blink', 'spelling-error', 'grammar-error']);
const TEXT_DECORATION_STYLES = new Set(['solid', 'double', 'dotted', 'dashed', 'wavy']);
function expandTextDecorationShorthand(value) {
  const parts = splitTopLevel(value, ' ').map(t => t.trim()).filter(Boolean);
  if (!parts.length) return [];
  const lines = [];
  let style = null, color = null, thickness = null;
  for (const tok of parts) {
    const low = tok.toLowerCase();
    if (TEXT_DECORATION_LINES.has(low)) lines.push(low);
    else if (TEXT_DECORATION_STYLES.has(low)) { if (style) return []; style = low; }
    else if (/^(auto|from-font)$/i.test(low) || /^-?\d/.test(tok)) { if (thickness) return []; thickness = tok; }
    else { if (color) return []; color = tok; }
  }
  // A shorthand RESETS every longhand it names, so an omitted component contributes its INITIAL
  // rather than nothing: `text-decoration: underline` computes a thickness of `auto` and a style of
  // `solid` in Chrome (measured), where emitting only the components present left them unknowable.
  return [
    { prop: 'text-decoration-line',      value: lines.length ? lines.join(' ') : 'none' },
    { prop: 'text-decoration-style',     value: style     || 'solid' },
    { prop: 'text-decoration-color',     value: color     || 'currentcolor' },
    { prop: 'text-decoration-thickness', value: thickness || 'auto' }
  ];
}

// `flex: <grow> <shrink> <basis>` with the spec's defaults for the shorthand: a single `<number>`
// is `<n> 1 0%` (which is what makes two `flex: 1` items split their row evenly), a single length is
// `1 1 <length>`, and the SECOND value is `flex-basis` unless it is a bare number. Expanding here
// rather than reading the shorthand at layout time is what makes the longhands obey cascade order —
// `.a { flex-grow: 0 } .a { flex: 1 }` has to end up with grow 1.
function expandFlexShorthand(value) {
  const s = String(value).trim().toLowerCase();
  const out = (grow, shrink, basis) => [
    { prop: 'flex-grow', value: String(grow) },
    { prop: 'flex-shrink', value: String(shrink) },
    { prop: 'flex-basis', value: basis }
  ];
  if (s === 'none')    return out(0, 0, 'auto');
  if (s === 'auto')    return out(1, 1, 'auto');
  if (s === 'initial') return out(0, 1, 'auto');
  const isNumber = (t) => /^-?\d+(\.\d+)?$/.test(t);
  const parts = splitTopLevel(s, ' ').map((t) => t.trim()).filter(Boolean);
  if (!parts.length || parts.length > 3) return [];
  if (parts.length === 1) {
    return isNumber(parts[0]) ? out(parts[0], 1, '0%') : out(1, 1, parts[0]);
  }
  if (parts.length === 2) {
    if (!isNumber(parts[0])) return [];
    return isNumber(parts[1]) ? out(parts[0], parts[1], '0%') : out(parts[0], 1, parts[1]);
  }
  return isNumber(parts[0]) && isNumber(parts[1]) ? out(parts[0], parts[1], parts[2]) : [];
}

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
  // Keep the position tokens raw; getComputedStyle canonicalizes them at read time (the same
  // path a direct `background-position` longhand takes), so both sources resolve identically.
  if (posTokens.length) out.position = posTokens.join(' ');
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
// Expand ONE declaration into everything the cascade should see for it — the longhands, then the
// shorthand itself — and hand each to `emit(prop, value, important)`. Both readers call this, which
// is what keeps `#r { margin: 1px }` and `style="margin: 1px"` producing the same cascade; they had
// drifted apart into a different visible bug in four separate rounds.
//
// The hand-written expanders run LAST where one exists, because they know things the generic
// registry doesn't (`flex: initial` is `0 1 auto`, `inset` and `background` aren't in the registry
// at all), so their values win. The shorthand's own name is emitted too: a resolved-value read asks
// for some by name, and the two name spaces never collide.
// The shorthands `expandDeclaration` can decompose — the CSSOM registry plus the hand-written
// expanders below. The resolved-value gate asks this to decide whether a declared shorthand leaves
// its longhands unknowable; asking "is it in the registry" instead missed every hand-expanded one.
const HAND_EXPANDED = new Set(['border', 'flex', 'background', 'overflow', 'margin', 'padding',
                               'inset', 'text-decoration', 'font']);
export function canExpandShorthand (prop) {
  return isRegularShorthand(prop) || HAND_EXPANDED.has(prop) || LOGICAL_BORDER_RE.test(prop);
}

// The longhands each HAND-written expander owns. Four of these shorthands the CSSOM registry
// doesn't carry at all (`inset`, `background`, `text-decoration`, `font`); `border` it carries with
// a per-side model where the cascade uses a uniform triple. A pending substitution has to fill
// every slot a reader might consult, so `shorthandSlots` fills the UNION of this and the registry's
// list. A slot this table forgets is caught by the literal-vs-`var()` equivalence sweep in
// `spec/shorthand_expansion_spec.rb`, which compares EVERY computed property between the two forms
// — so the table can't quietly drift from the expander beside it.
// Prototype-LESS: this is keyed by property name, and a plain literal answers `shorthandSlots
// ('constructor')` with a Function that the caller would then try to iterate.
const HAND_SLOTS = Object.assign(Object.create(null), {
  border:            ['border-width', 'border-style', 'border-color'],
  inset:             ['top', 'right', 'bottom', 'left'],
  background:        BG_LONGHANDS.map(([p]) => p).concat('background-color'),
  'text-decoration': ['text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness'],
  font:              FONT_SHORTHAND.longhands,
});
// The flow-relative border shorthands expand to `border-<flow-side>-{width,style,color}`, so their
// slots follow the same sides `expandLogicalBorder` writes.
function logicalBorderSlots(prop) {
  const flow  = prop.slice('border-'.length);
  const sides = flow === 'block' ? ['block-start', 'block-end']
              : flow === 'inline' ? ['inline-start', 'inline-end']
              : [flow];
  const out = [];
  for (const side of sides) for (const c of ['width', 'style', 'color']) out.push(`border-${side}-${c}`);
  // The axis-level names the two-sided form also sets — see `expandLogicalBorder`.
  if (sides.length === 2) for (const c of ['width', 'style', 'color']) out.push(`border-${flow}-${c}`);
  return out;
}
// Every longhand `prop` occupies when it is declared, or null when it isn't a shorthand we model.
// Memoised: the answer is a constant per property, and the union allocates.
const SLOTS_MEMO = new Map();
function shorthandSlots(prop) {
  if (SLOTS_MEMO.has(prop)) return SLOTS_MEMO.get(prop);
  const reg  = isRegularShorthand(prop) ? shorthandLonghands(prop) : null;
  const hand = LOGICAL_BORDER_RE.test(prop) ? logicalBorderSlots(prop) : HAND_SLOTS[prop];
  const slots = !reg ? (hand || null) : hand ? [...new Set([...reg, ...hand])] : reg;
  SLOTS_MEMO.set(prop, slots);
  return slots;
}

// Decompose `prop: value` into [longhand, value] pairs — the CSSOM registry's expansion with the
// hand-written one layered over it, or null when the value decomposes into nothing. This is the ONE
// decomposition: the cascade writes through it and the resolved-value read re-expands a pending
// substitution through it, so the two families can't answer differently.
export function expandShorthandValue(prop, value) {
  // A CSS-WIDE KEYWORD is decided here, once, for BOTH families. Only as the SOLE token is it
  // valid, and then it fills every slot the shorthand names (Chrome measured: a child with
  // `border: inherit` / `overflow: inherit` / `margin: inherit` takes the parent's computed value);
  // mixed with anything else the declaration is invalid and contributes nothing (`margin: inherit
  // 1px` computes `0px`). The registry expanders knew this, but each hand-written one classified
  // the keyword as some COMPONENT — `border: inherit` made it a colour, `text-decoration: inherit`
  // likewise, and the longhands came back at their initials instead of inheriting.
  const slots = shorthandSlots(prop);
  if (slots) {
    const toks = splitTopLevel(String(value).trim(), ' ').map(t => t.trim()).filter(Boolean);
    if (toks.some(isCssWideKeyword)) {
      return toks.length === 1 ? slots.map(lh => [lh, toks[0].toLowerCase()]) : null;
    }
  }
  const out = new Map();
  if (isRegularShorthand(prop)) {
    const pairs = shorthandExpand(prop, value);
    if (pairs) for (const [lh, v] of pairs) out.set(lh, v);
  }
  const hand = prop === 'border'     ? expandBorderShorthand(value)
             : prop === 'flex'       ? expandFlexShorthand(value)
             : prop === 'background' ? expandBackgroundShorthand(value)
             : prop === 'overflow'   ? expandOverflowShorthand(value)
             : prop === 'text-decoration' ? expandTextDecorationShorthand(value)
             : prop === 'font'       ? expandFontShorthand(value)
             : LOGICAL_BORDER_RE.test(prop) ? expandLogicalBorder(prop, value)
             : (prop === 'margin' || prop === 'padding' || prop === 'inset') ? expandBoxShorthand(prop, value)
             : null;
  // The hand-written expander runs LAST where one exists, because it knows things the generic
  // registry doesn't (`flex: initial` is `0 1 auto`), so its values win. An empty list (how those
  // expanders report a value they reject) contributes nothing — for a shorthand the registry ALSO
  // carries, the registry's pairs still stand, which is what keeps `margin: 1px 2px` working when
  // only one of the two expanders likes it.
  if (hand) for (const d of hand) out.set(d.prop, d.value);
  return out.size ? [...out] : null;
}

function expandDeclaration (prop, value, important, emit) {
  // An invalid math function is a PARSE error, so the declaration never enters the cascade and the
  // next-lowest one wins. Resolving it later and reporting the property's initial instead skipped
  // that loser entirely.
  if (!hasSubstitution(value) && isStaticallyInvalidMath(value)) return;
  // A SUBSTITUTION can't be decomposed until it RESOLVES, and that happens per element. The
  // shorthand still OCCUPIES its longhands' slots though — Chrome measured `margin-top: 9px;
  // margin: var(--m)` computing the top from `--m` — so each slot takes a pending substitution
  // naming its source, which the resolved-value read expands against the element. Recording only
  // the shorthand's own name instead let that earlier `margin-top` survive.
  const slots = hasSubstitution(value) ? shorthandSlots(prop) : null;
  if (slots) {
    const pending = pendingSubstitution(prop, value);
    for (const lh of slots) emit(lh, pending, important);
    emit(prop, value, important);
    return;
  }
  const pairs = expandShorthandValue(prop, value);
  if (pairs) {
    for (const [lh, v] of pairs) { const sub = splitImportant(v); emit(lh, sub.value, important || sub.important); }
  } else if (isRegularShorthand(prop)) {
    // A REGISTERED shorthand whose value decomposes into NOTHING is an invalid declaration, and a
    // browser drops it whole. Recording the name anyway made the resolved-value gate answer
    // "unknowable" for every longhand it could set — blanking `transition-duration` for
    // `transition: opacity 1s,` where a browser leaves `0s`.
    return;
  }
  // The shorthand's own name is emitted too: a resolved-value read asks for some by name, and the
  // two name spaces never collide.
  emit(prop, value, important);
}

function ruleDecls(block) {
  const decls = [];
  if (!block || !block.children) return decls;
  block.children.forEach(node => {
    if (node.type !== 'Declaration') return;
    // A custom property (`--…`) is case-SENSITIVE, so keep it verbatim (css-tree already
    // unescaped it); a regular property is ASCII case-insensitive → lowercased. Matches the
    // inline `parseStyleDeclList` path, so `var(--Foo)` resolves against a `--Foo` definition
    // whether it came from a stylesheet or an inline style.
    const custom = node.property.startsWith('--');
    const prop = custom ? node.property : node.property.toLowerCase();
    // `parseValue:false` keeps the raw value text, which can still hold a
    // `/* … */` comment; strip it so exact compares (`display === 'none'`)
    // match — the old parser ran stripCssComments over the whole sheet first.
    let value = CT.generate(node.value).replace(CSS_COMMENT_RE, '').trim();
    // A property name a browser doesn't support is not a declaration at all — it never reaches the
    // CSSOM, and letting one through now that EVERY declaration is captured would let a stylesheet
    // shadow the computed-style interface (`#a { constructor: red }`).
    if (!custom && !isSupportedCssPropertyName(prop)) return;
    if (!custom) value = lowercaseKeywordValue(prop, value);
    if (custom) { decls.push({ prop, value, important: !!node.important }); return; }
    // Canonical form is applied HERE, once per declaration per sheet parse (which the sheet cache
    // memoises), matching what the inline declaration block does on the way in — `.4s` is stored
    // as `0.4s`, `BLUR(2PX)` as `blur(2px)`. Doing it at read time instead meant a CSS parse per
    // property per element (rule 3).
    expandDeclaration(prop, value, !!node.important, (p2, v2, imp) => {
      decls.push({ prop: p2, value: serializeCssValue(lowercaseKeywordValue(p2, v2)), important: imp });
    });
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
  const fontSrcs = [];
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
        if (name === 'font-face') {
          // Collected pure (like @import below); the fetch — the OBSERVABLE, we
          // don't rasterize text — happens at collect time in controlled docs.
          if (node.block && node.loc) {
            const blockSrc = src.slice(node.loc.start.offset, node.loc.end.offset);
            const fm = /src\s*:[^;}]*url\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(blockSrc);
            if (fm) fontSrcs.push(fm[2]);
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
  catch (_) { return { rules: out, layers, imports, fontSrcs }; }
  visit(ast.children, cssText, null, null);
  return { rules: out, layers, imports, fontSrcs };
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
  // Bumped whenever parseSheet's OUTPUT SHAPE changes, so a cross-visit cache (Ruby-backed)
  // filled by an older parser isn't reused without the new fields. v2: `imports`.
  // v4: each rule carries `anc`, the ancestor-reject hashes.
  return 'v4:' + text.length + ':' + (h >>> 0).toString(16) + ':' + vp.width + 'x' + vp.height;
}

// Parse one stylesheet's text into the per-rule `{hide, layout}`
// shape `collectCascadeRules` wants. Pure: no read of `state`, no
// reference to surrounding document, so the result is safe to cache
// across visits.
function parseSheet(cssText, vp) {
  const hide   = [];
  const layout = [];
  const attrs  = new Set();
  let serial   = 0;
  let flat;
  // Empty result on parse failure is also cached — a malformed sheet
  // re-served on every visit shouldn't pay the parse cost each time.
  try { flat = cssTreeFlatten(cssText, vp); } catch (_) { return { hide, layout, attrs: [], count: 0, layers: [], imports: [], fontSrcs: [] }; }
  for (const r of flat.rules) {
    if (!r.selectorText || !r.decls.length) continue;
    let display = null, displayImp = false;
    let visibility = null, visibilityImp = false;
    const captured = Object.create(null);   // page-authored property names — see `own()` above
    let order = 0;
    for (const d of r.decls) {
      if      (d.prop === 'display')    { display = d.value; displayImp = d.important; }
      else if (d.prop === 'visibility') { visibility = d.value; visibilityImp = d.important; }
      // Within one block an `!important` declaration is never clobbered by a later normal one
      // (CSSOM "set a CSS declaration") — the inline reader has the same rule, and with every
      // declaration captured and every registry shorthand expanded, far more properties reach
      // this map than used to.
      const prev = captured[d.prop];
      if (prev && prev.important && !d.important) continue;
      // `order` is the position WITHIN this rule. Every declaration of a rule shares one `source`,
      // so without it a physical/logical tie (`margin-block-start` vs `margin-top`, both here)
      // would be broken by name rather than by which one the author wrote last.
      captured[d.prop] = { value: d.value, important: d.important, order: order++ };
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
      const term   = terminalKey(trimmed, attrs);
      // Computed at PARSE time so it rides the cross-visit sheet cache instead of being
      // re-derived per rule per navigation. (It parses the selector again rather than sharing
      // `terminalKey`s parse — cold cost, but see the note there.)
      const anc    = ancestorHashes(trimmed);
      const source = serial++;
      if (hasHide)   hide  .push({ selectorText: trimmed, term, anc, spec, source, layer: r.layer, ns: r.ns, display, displayImp, visibility, visibilityImp });
      if (hasLayout) layout.push({ selectorText: trimmed, term, anc, spec, source, layer: r.layer, ns: r.ns, captured });
    }
  }
  return { hide, layout, attrs: [...attrs], count: serial, layers: flat.layers, imports: flat.imports || [], fontSrcs: flat.fontSrcs || [] };
}

function parseSheetCached(cssText, vp) {
  const key = __sheetCacheKey(cssText, vp);
  let hit = __sheetCache.get(key);
  if (hit) return hit;
  // Cross-visit (Ruby-backed) parse cache: `parseSheet` is pure, so its result
  // survives the per-visit VM rebuild that wipes the in-VM `__sheetCache`. On a
  // cascade rebuild this skips the ~12-15ms css-tree parse for unchanged sheets.
  // Keyed by (cssText hash, viewport), so content change = new key.
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
  __sheetCacheSet(key, hit);
  return hit;
}
function __sheetCacheSet(key, hit) {
  while (__sheetCache.size >= SHEET_CACHE_LIMIT) {
    __sheetCache.delete(__sheetCache.keys().next().value);
  }
  __sheetCache.set(key, hit);
}

// Parsed rules for a sheet reached by URL — a `<link href>` or an `@import` —
// keyed by (ABSOLUTE url, viewport). The point of the url key (vs the text key
// above) is that a repeat rebuild in the same page's life never pulls the sheet
// BODY across the Ruby↔V8 boundary — the text-keyed cache alone still needs the
// full cssText per rebuild just to compute its key. And per-page-life is exactly
// a real browser's behaviour: one fetch per <link>, however many style recalcs
// follow. This layer is therefore in-VM ONLY (wiped with the per-visit VM
// rebuild), deliberately NOT in the Ruby store: across visits the freshness call
// belongs to the asset cache (`__csimExternalAsset` re-fetches what wasn't
// durably cacheable), and a url-keyed rule store would pin the first parse of a
// mutable-CSS url forever. The re-fetched body still hits the content-keyed
// `parseSheetCached` layers, so an unchanged sheet never re-parses.
// A failed fetch is NOT cached — the next rebuild retries it, exactly as the
// uncached path did.
function urlSheetCacheKey(url, vp) {
  // A `data:` url IS the content and can be huge — hash it like an inline <style>.
  const u = url.length > 256 ? 'h' + fnv1a(url) + ':' + url.length : url;
  return 'u1:' + vp.width + 'x' + vp.height + ':' + u;
}
function parseUrlSheetCached(url, vp) {
  const key = urlSheetCacheKey(url, vp);
  let hit = __sheetCache.get(key);
  if (hit) return hit;
  let body = null;
  try {
    if (/^data:/i.test(url)) {
      body = decodeDataUrlCss(url);
    } else {
      // A controlling service worker answers first (destination 'style'; memoized
      // per URL in bridge.entry so the load-event/.sheet consumers share the SAME
      // dispatch + body). blocked / bodyless → the sheet contributes nothing
      // (NOT cached, like a failed fetch — the memo already pins the verdict).
      const sw = (typeof globalThis.__csimSwFetchStyle === 'function') ? globalThis.__csimSwFetchStyle(url) : null;
      if (sw) {
        if (sw.blocked || sw.body == null) return null;
        hit = parseSheetCached(sw.body, vp);
        __sheetCacheSet(key, hit);
        return hit;
      }
      body = globalThis.__csimExternalAsset(url);
    }
  } catch (_) {}
  if (!body) return null;
  hit = parseSheetCached(body, vp);
  __sheetCacheSet(key, hit);
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
  return { ...captured, 'background-image': { value: resolveCssUrls(bi.value, base), important: bi.important, order: bi.order } };
}

const __swFontFetched = new Set();
function pushSheetWithImports(sheets, parsed, baseHref, vp, seen) {
  // A CONTROLLED document's @font-face src FETCHES through its service worker
  // (destination 'font', response discarded — glyph rendering isn't modeled, the
  // fetch is the observable). Once per URL per realm; uncontrolled documents pay
  // one array-length check.
  // The controller gate runs BEFORE the dedup Set (same rule as swFetchStyle /
  // swDiscardFetch): an UNCONTROLLED collect must not pin the URL as fetched, or
  // a later clients.claim() would never observe the font fetch.
  const fsrcs = parsed && parsed.fontSrcs;
  if (fsrcs && fsrcs.length && typeof globalThis.__csimSWControllerHandle === 'function' &&
      (globalThis.__csimSWControllerHandle() | 0) > 0) {
    for (const fs of fsrcs) {
      let fabs = fs;
      try { fabs = new URL(fs, baseHref || undefined).href; } catch (_) { continue; }
      if (!/^https?:/i.test(fabs) || __swFontFetched.has(fabs)) continue;
      __swFontFetched.add(fabs);
      try { globalThis.__csimSwFetchDest(fabs, 'font', 'cors', 'same-origin', true); } catch (_) {}
    }
  }
  const imps = parsed && parsed.imports;
  if (imps && imps.length) {
    for (const imp of imps) {
      if (imp.media && !mediaMatches(imp.media, vp)) continue;
      let abs;
      try { abs = new URL(imp.url, baseHref || undefined).href; } catch (_) { continue; }
      if (seen.has(abs)) continue;
      seen.add(abs);
      const parsed = parseUrlSheetCached(abs, vp);
      // An imported sheet's own relative URLs resolve against ITS url, not the importer's.
      if (parsed) pushSheetWithImports(sheets, parsed, abs, vp, seen);
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
    if (sheetDisabled(s)) continue;
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
    if (sheetDisabled(l)) continue;
    const media = l._attrs.media;
    if (media && !mediaMatches(media, vp)) continue;
    const title = (l._attrs.title || '').trim();
    const alternate = tokens.includes('alternate');
    if (!linkSheetEnabled(l, title, alternate, selectedSet)) continue;
    try {
      // `data:` CSS is decoded JS-side (the Rack asset fetcher only knows
      // http(s)); everything else is cross-visit cached (same as classic
      // <script src>): fingerprinted CSS is content-stable at content-hashed
      // URLs, so a fresh VM per visit shouldn't re-fetch it — and the url-keyed
      // parse cache shouldn't even re-transfer the body (parseUrlSheetCached
      // returns null on 4xx / fetch failure). Resolved against the document
      // base BEFORE the cache lookup: the raw href would alias two documents'
      // sheets under one relative-url key. The absolute URL also serves as the
      // base for this sheet's own @imports (relative imports resolve against
      // the importing sheet, not the document).
      let linkAbs; try { linkAbs = new URL(href, docBase).href; } catch (_) { linkAbs = href; }
      // Register the link's crossorigin params before the (memoized, once-per-URL)
      // service-worker style fetch this may trigger — the cascade is often the
      // FIRST consumer to fetch a dynamically inserted link's CSS, ahead of the
      // element-aware load-event path (fetch-request-resources' cors cases).
      try { if (typeof globalThis.__csimSwRegisterStyleCors === 'function') globalThis.__csimSwRegisterStyleCors(linkAbs, l); } catch (_) {}
      const parsed = parseUrlSheetCached(linkAbs, vp);
      if (parsed) pushSheetWithImports(sheets, parsed, linkAbs, vp, importSeen);
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
  const attrs = new Set();
  for (const { sheet: sh, base: sheetBase } of sheets) {
    const serial = state.ruleSerial;
    for (const r of sh.hide)   hide  .push({ ...r, source: r.source + serial, layerRank: rankOf(r) });
    for (const r of sh.layout) layout.push({ ...r, captured: resolveCapturedImageUrls(r.captured, sheetBase), source: r.source + serial, layerRank: rankOf(r) });
    for (const a of (sh.attrs || [])) attrs.add(a);
    state.ruleSerial += sh.count;
  }
  return { hide, layout, attrs };
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
// ── dynamic-selector taint ──────────────────────────────────────────────────
// A cascade result can only be CACHED if re-running it would give the same answer until some
// generation moves. That is false for any rule whose selector reads state the generations don't
// track — and three attempts at enumerating that state failed, because the axis that matters is not
// which pseudo-classes are dynamic but which code paths write the state behind them (`_value` has
// 19 writers, `_selectedness` 18, and every interaction path bypasses the IDL setter).
//
// So the question is asked of the SELECTOR instead, where it is decidable: a read that so much as
// CONSIDERED a rule with a dynamic pseudo-class is tainted and must not be cached. Considered, not
// matched — a rule that doesn't match now is exactly the one that starts matching on hover.
//
// The allowlist below is the maintained half. OMITTING an entry is safe — the rule merely loses
// caching for the properties it declares — but ADDING a wrong one is not: it makes a dynamic rule
// read as static and its properties cache stale. `:dir()` was listed on the strength of its name
// and shipped exactly that bug. So an entry earns its place by having its MATCHER read, not by
// looking structural. Everything not listed — including anything unrecognised — taints.
const STATIC_PSEUDOS = new Set([
  // structural — the tree moves settleGen
  'root', 'empty', 'first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type',
  'only-of-type', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type',
  // logical combinators: harmless in themselves, and a dynamic pseudo INSIDE one is still seen by
  // the scan below, which reads every name in the selector text.
  'not', 'is', 'where', 'has', 'matches', 'any', 'scope',
  // attribute-driven — attributes move settleGen. Each of these was checked against its matcher,
  // not assumed from its name: `:lang` reads only the attribute, `:read-only` / `:read-write` only
  // `readonly` / `disabled` / `contenteditable`. `:dir()` is NOT here — for `dir="auto"` on an
  // input it resolves through the control's VALUE, which is precisely the writer set this design
  // exists because it cannot enumerate.
  'disabled', 'enabled', 'required', 'optional', 'read-only', 'read-write', 'link', 'any-link',
  'visited', 'lang',
  // shadow structure
  'host', 'host-context', 'slotted', 'part',
]);
// Pseudo-CLASS names. The colon run is CAPTURED rather than a preceding character, for two reasons:
// a `[^:]` prefix CONSUMES that character, so the pseudo directly after a matched one is never
// scanned — `a:link:hover` read as just `link`, i.e. STATIC, and its properties cached through a
// hover. And the name pattern admits a leading `-`, so a VENDOR-prefixed state
// (`:-webkit-autofill`, `:-moz-ui-invalid`) matches at all; unmatched meant "no pseudo here", which
// is the opposite of the "anything unrecognised taints" invariant this design rests on.
// `::before` and friends are skipped: a pseudo-ELEMENT rule doesn't contribute to the element's own
// computed style.
const PSEUDO_NAME_RE = /(:{1,2})(-?[a-z][a-z0-9-]*)/gi;
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);
function ruleIsDynamic(rule) {
  if (rule.__dynamicSel !== undefined) return rule.__dynamicSel;
  let dynamic = false;
  // A CSS-ESCAPED colon is part of an identifier, not a pseudo-class: Tailwind's variant classes
  // (`.hover\:bg-red-500`, `.md\:flex`) keep the backslash in `selectorText`, and reading them as
  // `:bg-red-500` / `:flex` marked most of a utility-CSS page dynamic — safe, but it gave away much
  // of the win on exactly the app suites that measure it.
  const sel = (rule.selectorText || '').replace(/\\./g, '');
  if (sel.indexOf(':') !== -1) {
    PSEUDO_NAME_RE.lastIndex = 0;
    let m;
    while ((m = PSEUDO_NAME_RE.exec(sel))) {
      // A pseudo-ELEMENT is not a state: it styles generated content, not this element's own
      // computed value. Both spellings — CSS3 `::before` and the legacy single-colon `:before` that
      // Bootstrap-era CSS still ships — are skipped, or a `.clearfix:before` rule would cost every
      // element it matches the caching of the properties it declares.
      if (m[1] === '::' || LEGACY_PSEUDO_ELEMENTS.has(m[2].toLowerCase())) continue;
      if (!STATIC_PSEUDOS.has(m[2].toLowerCase())) { dynamic = true; break; }
    }
  }
  rule.__dynamicSel = dynamic;
  return dynamic;
}

// A monotonic counter, bumped whenever a read considers a dynamic rule. A caller brackets its read
// by comparing the value before and after — which, unlike a flag, survives RE-ENTRY: a nested read
// (a `var()` lookup, a font-size resolution) only pushes the counter further, and the outer caller
// still sees a difference. Nothing ever resets it.
let dynamicSeq = 0;
export function dynamicReadSeq() { return dynamicSeq; }
// Only the cache VERIFIER uses this: its recompute runs inside an outer read's bracket and must not
// be mistaken for that read's own taint.
export function restoreDynamicSeq(seq) { dynamicSeq = seq; }
// Diagnostic: the classifier's verdict for a selector, so a spec can assert it directly. Testing it
// through a colour only works when the state can actually be toggled — the vendor-prefixed case
// can't be, so its guard passed against the very regression it was written for.
globalThis.__csimSelectorIsDynamic = (selectorText) => ruleIsDynamic({ selectorText: String(selectorText) });
function noteDynamic(rule) { if (ruleIsDynamic(rule)) dynamicSeq++; }

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

// The property-filtered candidate walk, for `cascadedRecord`: it wants only the candidate
// rules that CAPTURE `prop`. The index is PROPERTY-FIRST — one eager pass at build time
// files each rule under every property it captures, bucketed by its terminal exactly like
// `buildRuleIndex` — because this walk runs ~30 times per element per layout pass and ~90%
// of those reads ask for a property with no candidate at all: property-first answers that
// dominant case with a single Map miss, where the bucket-first shape paid four to eight
// bucket lookups plus a lazily-filtered sub-list each (`bucketPropList`, since removed).
// Each entry carries the captured record alongside the rule so the hot loop re-reads
// nothing. Rules are filed in source order into the same terminal buckets, and the walk
// visits tag → id → the element's classes in order → universal, so considered-rule order
// and count are IDENTICAL to the bucket-first walk — the dynamic-selector taint
// (`noteDynamic` on every rule that captures the property) is exactly preserved.
function buildLayoutPropIndex(rules) {
  const idx = new Map();
  for (const r of rules) {
    const cap = r.captured;
    if (cap == null) continue;
    const term = r.term;
    for (const prop in cap) {
      const c = own(cap, prop);
      // Falsy-but-defined is skipped too — the exact contract the old lazy filter had; every
      // producer stores a truthy record today, so this is future-proofing, not behavior.
      if (!c) continue;
      let sub = idx.get(prop);
      if (sub === undefined) idx.set(prop, sub = { byTag: new Map(), byId: new Map(), byClass: new Map(), universal: [] });
      const pair = [r, c];
      if (term.kind === 'class') {
        let b = sub.byClass.get(term.key);
        if (b === undefined) sub.byClass.set(term.key, b = []);
        b.push(pair);
      } else if (term.kind === 'id') {
        let b = sub.byId.get(term.key);
        if (b === undefined) sub.byId.set(term.key, b = []);
        b.push(pair);
      } else if (term.kind === 'tag') {
        let b = sub.byTag.get(term.key);
        if (b === undefined) sub.byTag.set(term.key, b = []);
        b.push(pair);
      } else {
        sub.universal.push(pair);
      }
    }
  }
  return idx;
}
function layoutPropIndex() {
  let idx = state.layoutPropIdx;
  if (idx === null) idx = state.layoutPropIdx = buildLayoutPropIndex(state.layoutRules);
  return idx;
}
function forEachCandidatePropRule(el, prop, cb) {
  const sub = layoutPropIndex().get(prop);
  if (sub === undefined) return;
  const tagList = sub.byTag.get(el._tag);
  if (tagList) for (const p of tagList) cb(p[0], p[1]);
  const idAttr = el._attrs.id;
  if (idAttr) {
    const idList = sub.byId.get(idAttr);
    if (idList) for (const p of idList) cb(p[0], p[1]);
  }
  for (const c of classes(el)) {
    const l = sub.byClass.get(c);
    if (l) for (const p of l) cb(p[0], p[1]);
  }
  if (sub.universal.length) for (const p of sub.universal) cb(p[0], p[1]);
}

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

// ONE reading of an element's inline `style=` attribute, serving both the cascade
// (`cascadedProperty`, for any property) and the layout engine (`resolveLayoutProp`). Shorthands
// are EXPANDED — through `expandDeclaration`, the SAME function the stylesheet reader uses, so
// `style="flex: 1"` and `#r { flex: 1 }` produce the same cascade — and the shorthands themselves
// are kept, since a resolved-value read asks for some of them by name (`overflow`).
//
// The inline layer sits at the TOP of the cascade, so a property missing from this map doesn't
// just get ignored: it lets a stylesheet rule win where the inline value should have.
//
// Cached on the element and keyed by the raw attribute string, so it survives across layout passes
// and invalidates the moment the attribute changes. That memo is what makes this affordable —
// `resolveLayoutProp` asks several times per element per pass and `cascadedProperty` far more
// often, and this replaces a freshly-compiled per-property RegExp at each of those calls.
const EMPTY_INLINE_DECLS = Object.freeze(Object.create(null));
export function inlineDecls (el) {
  const s = el._attrs && el._attrs.style;
  if (!s) return EMPTY_INLINE_DECLS;
  if (el._ilSrc === s) return el._ilMap;
  const out = Object.create(null);
  let seq = 0;
  const put = (prop, value, important) => {
    // Within one block an `!important` declaration is never clobbered by a later normal one
    // (CSSOM "set a CSS declaration") — `style="margin: 1px !important; margin-top: 2px"` keeps
    // the important 1px, and losing that let an author `!important` rule beat it.
    const prev = out[prop];
    if (prev && prev.important && !important) return;
    const order = seq++;
    // Keyword-valued props normalise to lowercase (`cascadedTextTransform` / `cascadedWhiteSpace`
    // compare against lowercase tokens). A value carrying a FUNCTION keeps its case: a custom
    // property name is case-sensitive, so lowercasing `var(--Foo)` loses the reference. Canonical
    // form is applied here, once per style-attribute string (this map is cached on it), exactly as
    // the rule capture does — a CUSTOM property is a verbatim token stream and is left alone.
    const folded = lowercaseKeywordValue(prop, value);
    out[prop] = { value: prop.startsWith('--') ? folded : serializeCssValue(folded), important, order };
  };
  // Declaration by declaration, in SOURCE ORDER — the LIST, not the map: a map keeps a
  // re-declared property at its first position (which is how a declaration block serializes), so
  // iterating it feeds `margin-left; margin; margin-left` to the shorthand last and loses the 7px.
  for (const { prop, value } of parseStyleDeclList(String(s))) {
    const d = splitImportant(value);
    if (prop.startsWith('--')) { put(prop, d.value, d.important); continue; }
    // An unsupported name never becomes a declaration (the CSSOM drops it), and a shorthand that
    // DOESN'T parse is dropped whole — recording its name would make the resolved-value gate treat
    // every longhand it could set as unknowable, blanking `transition-duration` for
    // `style="transition: !!!"` instead of leaving `0s`.
    if (!isSupportedCssPropertyName(prop)) continue;
    // ONE expander for both origins: `expandDeclaration` owns the drop-vs-keep decision too, so a
    // declaration that fails to decompose reads the same whether a stylesheet or a style attribute
    // wrote it. Deciding it here as well meant a second `shorthandExpand` per inline declaration
    // AND a divergence — the inline reader dropped `transition: opacity 1s,` while the stylesheet
    // reader kept it and blanked the longhands.
    expandDeclaration(prop, d.value, d.important, put);
  }
  el._ilSrc = s;
  el._ilMap = out;
  return out;
}
// A length in px. Viewport units resolve against the current viewport — `height: 100vh` is how a
// page says "fill the screen", and the layout engine has to see it as a real height rather than
// `auto`. Percentages and font-relative units still return null (they need the containing block /
// computed font size, which the caller doesn't pass).
const VIEWPORT_UNIT_RE = /^(-?\d+(?:\.\d+)?)(vh|vw|vmin|vmax)$/i;
function parsePx (v) {
  if (v == null) return null;
  const s = String(v).trim();
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(s);
  if (m) return parseFloat(m[1]);
  const vu = VIEWPORT_UNIT_RE.exec(s);
  if (vu) {
    const vp = currentViewport();
    const n = parseFloat(vu[1]);
    switch (vu[2].toLowerCase()) {
      case 'vh':   return n * vp.height / 100;
      case 'vw':   return n * vp.width  / 100;
      case 'vmin': return n * Math.min(vp.width, vp.height) / 100;
      case 'vmax': return n * Math.max(vp.width, vp.height) / 100;
    }
  }
  return /^(-?\d+(?:\.\d+)?)$/.test(s) ? parseFloat(s) : null;
}

// A percentage, as a fraction — `null` when the value isn't one. Percentages resolve against the
// containing block, which only the layout pass knows, so `resolveLayoutProp` hands the fraction back
// through `basis` rather than guessing here.
const PERCENT_RE = /^(-?\d+(?:\.\d+)?)%$/;
function parsePercent (v) {
  const m = v == null ? null : PERCENT_RE.exec(String(v).trim());
  return m ? parseFloat(m[1]) / 100 : null;
}

// `basis` is the containing-block extent a percentage resolves against (width for horizontal props,
// height for vertical ones). Omit it and a percentage stays unresolved, as before.
// `info`, when given, reports back whether the value was a PERCENTAGE — i.e. whether
// this answer depends on `basis` at all. Callers that cache a resolved length (the
// box-edge memo) need that to know whether their cache survives a different basis,
// and this is the only place that can say so without re-reading the cascade.
export function resolveLayoutProp (el, prop, basis = null, info = null) {
  // The same logical/physical merge `cascadedProperty` does: a page that positions with
  // `inset-block` or sizes with `inline-size` has to lay out as the browser does, not as if
  // nothing were declared. Read through `declaredValue` so a `var()` — and the pending slot an
  // `inset: var(--i)` shorthand occupies — resolves here exactly as it does for getComputedStyle.
  // The UA STYLESHEET sits below the author cascade and above the initial value, and
  // it carries real geometry: a `<td>`'s 1px padding is in every column width a
  // browser reports. Reading it here (rather than only in getComputedStyle) is what
  // keeps the two answers the same value — ONE geometry means one value resolution.
  const raw = declaredValue(el, prop) ?? uaDefault(el, prop);
  const px = parsePx(raw);
  if (px != null) return px;
  // FONT-RELATIVE units (em / rem / ex / ch / pt …). Modern app CSS is written in
  // rem (Bootstrap, Tailwind) — resolving only px left every such padding, margin
  // and border at 0, so the box model didn't reach the stylesheets that matter.
  // The resolution is style-proxy's (the same one getComputedStyle uses); for
  // `font-size` itself the em basis is the PARENT's size, as the spec says.
  const fontPx = fontRelativeToPx(el, raw, prop === 'font-size');
  if (fontPx != null) return fontPx;
  const pct = parsePercent(raw);
  if (pct != null) {
    if (info) info.percent = true;
    return basis != null ? pct * basis : null;
  }
  // A math function is the last thing to try, and only when it IS one — the check is
  // a substring test and this is the hot path every box measurement runs through.
  // The computed stage already reduced whatever it could (`10em + 20px`); what's left
  // needs the basis only layout has, which is exactly `calc(50% + 10px)`.
  if (!hasMathFunction(raw)) return null;
  if (info) info.percent = true;
  if (basis == null) return null;
  const reduced = reduceMathFunctions(String(raw), (n, unit) => (
    unit === '%' ? (n / 100) * basis : lengthUnitToPx(el, n, unit)
  ));
  return parsePx(reduced);
}
// One length token → px for the math reducer: the absolute units, then the
// font-relative ones through the same resolver every other length uses.
function lengthUnitToPx(el, n, unit) {
  const abs = absoluteToPx(n, unit);
  if (abs != null) return abs;
  return fontRelativeToPx(el, `${n}${unit}`);
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
// Cross-mutation memo for the hide-cascade resolution below. This is the driver's hottest
// selector-matching loop — it runs for every ancestor of every find candidate AND per element
// per layout pass, and on an app-scale sheet each call matches dozens of candidate hide rules —
// so the resolved answer is cached per element under the same key discipline as the
// declaredValue memo: (rules + dynamic style state, the element's structural context), with the
// dynamic-pseudo and `:has()` brackets declining to cache a read that considered one. The four
// slots cover the callers' semantic variants: with/without the inline seed × ignoreVisibility.
// A realm-local WeakMap, like DV_MEMO: the memo must be exactly as wide as the rule set that
// filled it.
const HIDE_MEMO = new WeakMap();
// Does THIS realm's document own `el`? Only then may a cascade answer be memoised — a
// cross-realm read (the parent resolving a frame's element) resolves against the READING
// realm's rules, and the two realms' epoch counters are unrelated. Same contract (and same
// skeleton-node caveat) as style-proxy's declaredValue guard, exported for it to share.
export function ownedByThisRealm(el) {
  const owner = el._ownerDoc;
  if (owner != null) return owner === globalThis.document;
  let n = el;
  for (let hops = 0; n && hops < 64; hops++) {
    if (n._parent == null) break;
    n = n._parent;
  }
  return n === globalThis.document;
}
// The shared memo prologue: resolve (or refuse) the element's HIDE_MEMO entry. Returns null
// when the answer must not be memoised: a foreign-realm element (above), or a SLOTTABLE
// CANDIDATE — a light child of a shadow host, whose `::slotted()` applicability can change
// via shadow-side slot insertion/removal/renaming that bumps nothing on the light child's
// ancestor chain.
function hideMemoFor(el) {
  if (!ownedByThisRealm(el)) return null;
  const p = el._parent;
  if (p && p._shadowRoot) return null;
  const epoch = cascadeStyleEpoch();
  const ctx = ctxEpochOf(el);
  let m = HIDE_MEMO.get(el);
  if (m === undefined || m.epoch !== epoch || m.ctx !== ctx) {
    m = { epoch, ctx };
    HIDE_MEMO.set(el, m);
  }
  return m;
}
// Same build-time verification switch as style-proxy's declaredValue memo: every hit is
// recomputed and compared, with the taint brackets restored so the recompute can't perturb an
// enclosing read's caching decision. Folded away entirely in the shipped build.
const VERIFY_HIDE_CACHE = typeof __CSIM_VERIFY_STYLE_CACHE__ !== 'undefined' && __CSIM_VERIFY_STYLE_CACHE__;
function verifyHideHit(el, what, cached, recompute) {
  const d0 = dynamicSeq, u0 = ctxUnsafeSeq;
  const fresh = recompute();
  dynamicSeq = d0; ctxUnsafeSeq = u0;
  if (fresh !== cached) {
    const where = (el._tag || '?') + (el._attrs && el._attrs.id ? '#' + el._attrs.id : '');
    throw new Error(`[csim] hide cache STALE on ${where} ${what}: cached ${JSON.stringify(cached)}, fresh ${JSON.stringify(fresh)}`);
  }
}
export function matchesAnyHideRule(el, ignoreVisibility = false, inline = null, hidden = false) {
  const m = hideMemoFor(el);
  if (m === null) return computeMatchesAnyHideRule(el, ignoreVisibility, inline, hidden);
  const slot = 's' + ((ignoreVisibility ? 2 : 0) | (inline ? 1 : 0));
  if (m[slot] !== undefined) {
    if (VERIFY_HIDE_CACHE) verifyHideHit(el, 'anyHide/' + slot, m[slot], () => computeMatchesAnyHideRule(el, ignoreVisibility, inline, hidden));
    return m[slot];
  }
  const dyn0 = dynamicSeq, unsafe0 = ctxUnsafeSeq;
  const result = computeMatchesAnyHideRule(el, ignoreVisibility, inline, hidden);
  if (dynamicSeq === dyn0 && ctxUnsafeSeq === unsafe0) m[slot] = result;
  return result;
}
function computeMatchesAnyHideRule(el, ignoreVisibility, inline, hidden) {
  // Shadow-tree hide rules apply to elements inside the tree (gated so
  // shadow-free pages pay one truthy check). Resolved alongside document rules
  // through the same winsCascade ladder; the SHADOW_SOURCE_BASE bias on their
  // source lets a shadow rule beat a document rule at equal specificity.
  // Shadow ENCAPSULATION, the same gate cascadedProperty applies: an element inside a shadow tree
  // is not matched by document-scope author rules — only by its own tree's sheets. Without this a
  // page-level `.invis { display: none }` reaches into every shadow tree that happens to use the
  // class and hides content the browser renders. (A slotted light child lives in the OUTER scope —
  // enclosingShadowRootOf returns null for it — so document rules still reach it, as they should.)
  const enclosingRoot = globalThis.__csimShadowHostCount ? enclosingShadowRootOf(el) : null;
  const documentRules = enclosingRoot ? [] : state.hideRules;
  const shadowHide = shadowRulesForEl(el, 'hide', enclosingRoot);
  if (documentRules.length === 0 && !inline && !(shadowHide && shadowHide.length)) return hidden;
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
  if (documentRules.length) {
    if (!state.hideIdx) state.hideIdx = buildRuleIndex(state.hideRules);
    forEachCandidateRule(state.hideIdx, el, (r) => {
      noteDynamic(r);   // considered — the memo above must not cache through a dynamic rule
      if (!safeMatches(el, r)) return;
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
      noteDynamic(r);
      if (!safeMatches(el, r)) continue;
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
// `null` is a valid resolved answer ("nothing declares it"), so absence is a distinct sentinel.
const HIDE_UNSET = Symbol('unset');
function ownHideProp(el, prop) {
  // Same cross-mutation memo discipline as matchesAnyHideRule above; shares its entry (the key
  // is identical), in the `d`/`v` slots.
  const m = hideMemoFor(el);
  if (m === null) return computeOwnHideProp(el, prop);
  const slot = prop === 'display' ? 'd' : 'v';
  const memoised = m[slot];
  if (memoised !== undefined) {
    const cached = memoised === HIDE_UNSET ? null : memoised;
    if (VERIFY_HIDE_CACHE) verifyHideHit(el, prop, cached, () => computeOwnHideProp(el, prop));
    return cached;
  }
  const dyn0 = dynamicSeq, unsafe0 = ctxUnsafeSeq;
  const result = computeOwnHideProp(el, prop);
  if (dynamicSeq === dyn0 && ctxUnsafeSeq === unsafe0) m[slot] = result === null ? HIDE_UNSET : result;
  return result;
}
function computeOwnHideProp(el, prop) {
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
      noteDynamic(r);   // considered — ownHideProp's memo must not cache through a dynamic rule
      if (!safeMatches(el, r)) return;
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
      noteDynamic(r);
      if (!safeMatches(el, r)) continue;
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
export function isFlexLikeContainer(el) {
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
  // Cross-mutation memo (slot `rd` — rules-only display, no inline fold), same discipline as
  // matchesAnyHideRule: this runs per element under the visible-text walk's flex detection.
  const m = hideMemoFor(el);
  if (m === null) return computeResolveCascadeDisplay(el);
  const memoised = m.rd;
  if (memoised !== undefined) {
    const cached = memoised === HIDE_UNSET ? null : memoised;
    if (VERIFY_HIDE_CACHE) verifyHideHit(el, 'rd', cached, () => computeResolveCascadeDisplay(el));
    return cached;
  }
  const dyn0 = dynamicSeq, unsafe0 = ctxUnsafeSeq;
  const result = computeResolveCascadeDisplay(el);
  if (dynamicSeq === dyn0 && ctxUnsafeSeq === unsafe0) m.rd = result === null ? HIDE_UNSET : result;
  return result;
}
function computeResolveCascadeDisplay(el) {
  if (!state.hideIdx) state.hideIdx = buildRuleIndex(state.hideRules);
  let best = null;
  forEachCandidateRule(state.hideIdx, el, (r) => {
    if (r.display == null) return;
    noteDynamic(r);
    if (!safeMatches(el, r)) return;
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
// `cascadedWhiteSpace` — every property rides on this without
// re-copying the cascade walk.
// Published as a seam rather than an import: the mutation recorder sits below the cascade, and
// this is the one thing it needs from it (see `markLayoutDirty`).
globalThis.__csimAttrIsStyled = (name) => state.styledAttrs.has('*') || state.styledAttrs.has(name);

// HTML "presentational hints" — a handful of content attributes contribute to
// the cascade at an origin BELOW author rules, so getComputedStyle reports them
// only when no author/inline rule sets the property. `<canvas>` maps its
// width/height attributes to the CSS width/height (with the default 300x150
// canvas size when unset); embedded content (`<img>` / `<iframe>` / `<embed>` /
// `<object>` / `<video>`) maps its `width`/`height` content attributes the same
// way. Returns a CSS value string, or null for no hint.
const EMBEDDED_DIMENSION_TAGS = new Set(['img', 'iframe', 'embed', 'object', 'video']);
// HTML "rules for parsing dimension values": leading digits (optionally with a
// fraction), then an optional `%`; anything after is ignored — so `height="10px"`
// is 10 pixels, the way browsers read it.
const DIMENSION_ATTR_RE = /^\s*(\d+(?:\.\d+)?)\s*(%?)/;
function presentationalHint (el, prop) {
  if (prop !== 'width' && prop !== 'height') return null;
  if (el._tag === 'canvas') return (prop === 'width' ? el.width : el.height) + 'px';
  if (!EMBEDDED_DIMENSION_TAGS.has(el._tag)) return null;
  const attr = el._attrs && el._attrs[prop];
  const m = attr != null && DIMENSION_ATTR_RE.exec(String(attr));
  return m ? m[1] + (m[2] || 'px') : null;
}

// The winning DECLARATION for `prop` — value plus the precedence fields — so a caller can compare
// two property names and pick the one the cascade actually prefers. `cascadedProperty` is the
// value-only wrapper every existing reader uses.
function cascadedRecord (el, prop) {
  ensureCascadeFresh();
  const inline = inlineDecls(el)[prop] || null;
  // Inline seed carries `inline: true`; like winsCascade, the property
  // comparator (`winsProp`) checks inline-ness before specificity so a
  // non-`!important` inline value beats every author selector at equal
  // importance. `spec` stays a real 3-component value.
  let best = inline ? { value: inline.value, important: inline.important, spec: [0,0,0], source: Infinity, inline: true, order: inline.order } : null;
  // Shadow encapsulation: an element INSIDE a shadow tree is not matched by
  // document-scope author rules — only by its own tree's sheets (via
  // shadowRulesForEl below), plus inherited values that reach it through the
  // getComputedStyle parent walk. A host or slotted element lives in the OUTER
  // scope (enclosingShadowRootOf → null), so document rules still apply to it.
  const shadowRoot   = globalThis.__csimShadowHostCount ? enclosingShadowRootOf(el) : null;
  const encapsulated = !!shadowRoot;
  const rules = state.layoutRules;
  if (!encapsulated && rules.length && rulesIndexHas(prop)) {
    forEachCandidatePropRule(el, prop, (r, cap) => {
      noteDynamic(r);                       // considered — a rule that misses now can match on hover
      if (!safeMatches(el, r)) return;
      if (winsProp(best, r.spec, r.source, cap.important, r.layerRank)) {
        best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source, layerRank: r.layerRank, order: cap.order };
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
      const cap = own(r.captured, prop);
      if (!cap) continue;
      noteDynamic(r);
      if (!safeMatches(el, r)) continue;
      if (winsProp(best, r.spec, r.source, cap.important, r.layerRank)) {
        best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source, layerRank: r.layerRank, order: cap.order };
      }
    }
  }
  if (best) return best;
  const hint = presentationalHint(el, prop);
  // A presentational hint sits BELOW every author rule, which is what the sentinel precedence
  // records; a logical/physical comparison has to be able to see that.
  // `layerRank: -Infinity` is the sentinel that keeps a hint BELOW every author rule: an unset
  // rank reads as "unlayered", which `layerPriority` ranks HIGHEST, so an `@layer` rule lost to a
  // `width` attribute.
  return hint == null ? null : { value: hint, important: false, spec: [0, 0, 0], source: -1, hint: true, layerRank: -Infinity };
}

// The flow-relative (logical) longhands resolve to a PHYSICAL side that depends on the element's
// writing mode and direction — Chrome measured: `border-block-start` is the top edge in
// `horizontal-tb`, the RIGHT edge in `vertical-rl`; `border-inline-start` is the left edge in `ltr`
// and the RIGHT edge in `rtl`. So the mapping can't happen at parse time, where there is no
// element: both names are captured, and a read of either consults BOTH and lets the cascade decide.
const LOGICAL_SIDE_RE = /(^|-)(block|inline)-(start|end)(-|$)/;
const PHYSICAL_SIDES = { 'block-start': 'top', 'block-end': 'bottom', 'inline-start': 'left', 'inline-end': 'right' };
// [block-start, block-end, inline-start, inline-end] → physical sides, per writing mode.
const FLOW_SIDES = {
  'horizontal-tb': ['top', 'bottom', 'left', 'right'],
  'vertical-rl':   ['right', 'left', 'top', 'bottom'],
  'vertical-lr':   ['left', 'right', 'top', 'bottom'],
  'sideways-rl':   ['right', 'left', 'top', 'bottom'],
  'sideways-lr':   ['left', 'right', 'bottom', 'top'],
};
// NOT frozen: `twinName` memoises on it, and every element in the default configuration shares
// this one object, which is exactly what makes that memo worth having.
const DEFAULT_FLOW_SIDES = {
  'block-start': 'top', 'block-end': 'bottom', 'inline-start': 'left', 'inline-end': 'right',
  mode: 'horizontal-tb', rtl: false,
};
// The resolved MODE and direction travel with the sides: two writing modes can produce the same
// block sides (`vertical-lr` and `sideways-lr`) while differing on the inline axis, so recovering
// them from the map is guesswork that invents an `rtl` out of nothing.
function sidesFor (wm, rtl) {
  const s = (FLOW_SIDES[wm] || FLOW_SIDES['horizontal-tb']);
  return {
    'block-start': s[0], 'block-end': s[1],
    'inline-start': rtl ? s[3] : s[2], 'inline-end': rtl ? s[2] : s[3],
    mode: FLOW_SIDES[wm] ? wm : 'horizontal-tb', rtl,
  };
}
// `writing-mode` / `direction` INHERIT, so an element's flow sides are its PARENT's unless it
// declares one itself. Chained that way and memoised per cascade generation, each element costs
// one lookup instead of a walk to the root — this sits under `resolveLayoutProp`, which the layout
// pass calls several times per element, and the un-memoised walk hung an editor-shaped page (rule 3).
function flowSides (el) {
  const gen = cascadeGeneration();
  if (el._fsGen === gen) return el._fsVal;
  // Same rule as the resolved-value memo: an answer that depended on a DYNAMIC selector is not
  // cacheable, because nothing moves the generation when that state changes. This memo predates the
  // taint counter and had the bug the counter exists to prevent — `#t:placeholder-shown {
  // direction: rtl }` kept mapping `margin-inline-start` to the RIGHT edge after the value was
  // filled, even though `direction` itself (uncached) correctly read `ltr`.
  //
  // The price is paid only by a page that declares `direction` / `writing-mode` under a DYNAMIC
  // selector, and only for the elements those rules reach — an untainted ancestor still memoises, so
  // the recomputation is one level, not a walk to the root. Measured on 400 elements reading two
  // flow-relative longhands + gBCR: 1.5-2.1 ms with static direction rules only, 3.9-4.8 ms once a
  // `.b:hover { direction: rtl }` is in the sheet.
  const seqBefore = dynamicReadSeq();
  const val = computeFlowSides(el);
  if (dynamicReadSeq() === seqBefore) { el._fsGen = gen; el._fsVal = val; }
  return val;
}

function computeFlowSides (el) {
  const parent = el._parent;
  const base = (parent && parent.nodeType === NODE_ELEMENT) ? flowSides(parent) : DEFAULT_FLOW_SIDES;
  // Neither property declared ANYWHERE (the overwhelmingly common case)? Then nothing can differ
  // from the parent, and the two cascade lookups below are skipped entirely.
  // A `dir` ATTRIBUTE sets the computed direction without any declaration — `<html dir="rtl">` is
  // how essentially every RTL app does it, and reading only the CSS side put every
  // `*-inline-start` on the mirrored edge.
  const dirAttr = el._attrs && el._attrs.dir;
  const declared = cascadeDeclaresProperty('writing-mode') || cascadeDeclaresProperty('direction') ||
                   dirAttr != null ||
                   'writing-mode' in inlineDecls(el) || 'direction' in inlineDecls(el);
  if (!declared) return base;
  const wmRaw  = ownCascaded(el, 'writing-mode');
  // A CSS declaration wins over the attribute (CSS `direction` overrides `dir`), which is what
  // taking the cascaded value first and only then the attribute gives.
  const dirRaw = ownCascaded(el, 'direction') ??
                 (dirAttr != null && /^(ltr|rtl)$/i.test(String(dirAttr)) ? String(dirAttr) : null);
  if (wmRaw == null && dirRaw == null) return base;
  const wm  = wmRaw != null ? String(wmRaw).trim().toLowerCase() : base.mode;
  const rtl = dirRaw != null ? String(dirRaw).trim().toLowerCase() === 'rtl' : base.rtl;
  return sidesFor(wm, rtl);
}
function ownCascaded (el, prop) {
  const rec = cascadedRecord(el, prop);
  return rec && !isCssWideKeyword(rec.value) ? rec.value : null;
}
// The SAME dual key every other per-element memo uses (layout.js, the innerText memo): a CSSOM
// edit bumps the cascade version without touching the DOM or the rule count, and keying on the
// rule count alone would serve a stale writing mode after a `deleteRule` + `insertRule`.
// One monotonic number for THREE inputs, without packing them arithmetically: a long app-suite run
// pushes `settleGen` into the tens of thousands, and `gen * 1e12` would leave the exactly-integral
// range of a double. A counter that ticks whenever any input moves is exact for as long as any of
// them is, and every caller only ever compares it for equality.
const GEN = { gen: -1, cv: -1, ss: -1, value: 0 };
export function cascadeGeneration () {
  ensureCascadeFresh();
  const gen = globalThis.__settleGenGet ? globalThis.__settleGenGet() : 0;
  const cv  = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
  const ss  = styleStateGeneration();
  if (gen !== GEN.gen || cv !== GEN.cv || ss !== GEN.ss) {
    GEN.gen = gen; GEN.cv = cv; GEN.ss = ss;
    GEN.value = (GEN.value + 1) | 0;
  }
  return GEN.value;
}

// The declaredValue memo's generation, WITHOUT `settleGen`: (cascade rules, dynamic style state)
// only. An element's own declared value does not depend on "some DOM mutation happened somewhere"
// — it depends on the rule set (cascadeVersion), on focus/hover-class state (styleStateGeneration;
// dynamic pseudo-classes are additionally guarded per read by the taint counter), and on the
// element's structural CONTEXT (its own + its ancestors' attributes and child lists), which
// `ctxEpochOf` below tracks per element. Keying the memo on (this, ctxEpochOf) instead of
// `cascadeGeneration` is what lets it survive unrelated mutations — on an app page that mutates
// every frame, the settleGen-keyed cache was cold on every layout pass and bought nothing.
const STYLE_EPOCH = { cv: -1, ss: -1, value: 0 };
export function cascadeStyleEpoch () {
  ensureCascadeFresh();
  const cv = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
  const ss = styleStateGeneration();
  if (cv !== STYLE_EPOCH.cv || ss !== STYLE_EPOCH.ss) {
    STYLE_EPOCH.cv = cv; STYLE_EPOCH.ss = ss;
    STYLE_EPOCH.value = (STYLE_EPOCH.value + 1) | 0;
  }
  return STYLE_EPOCH.value;
}

// The epoch LAYOUT keys its memos on: the rule set, plus the dynamic style state only when a
// dynamic rule on this page can actually move a box (see `computeHasDynamicLayoutRule`). Keyed on
// the rule set alone it never invalidated at all — `#t:placeholder-shown { width: 300px }` kept its
// 300px box after the field was filled, through `getBoundingClientRect` as much as the CSSOM —
// and keyed on the state unconditionally every keystroke relaid out the document.
const LAYOUT_EPOCH = { cv: -1, ss: -1, value: 0 };
export function cascadeLayoutEpoch () {
  ensureCascadeFresh();
  const cv = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
  const ss = (state.hasDynamicLayoutRule || globalThis.__csimShadowHostCount)
    ? styleStateGeneration() : 0;
  if (cv !== LAYOUT_EPOCH.cv || ss !== LAYOUT_EPOCH.ss) {
    LAYOUT_EPOCH.cv = cv; LAYOUT_EPOCH.ss = ss;
    LAYOUT_EPOCH.value = (LAYOUT_EPOCH.value + 1) | 0;
  }
  return LAYOUT_EPOCH.value;
}

// The element's structural-context epoch: an order-sensitive integer hash of the `_selEpoch`
// mutation counters along its ancestor chain (attribute changes bump an element and its parent,
// child-list changes bump the parent and each added node — mutation-observer.js). Everything a
// static selector can read about this element lives on that chain or is covered elsewhere: own +
// ancestor attributes and child lists (the chain), preceding siblings via the shared parent's
// bump, rules via cascadeVersion, dynamic pseudo-classes via the taint counter, and the one
// DOWNWARD-looking pseudo (`:has()`) via `ctxUnsafeReadSeq` below. Inherited `var()` references
// are covered too: the ancestor that declares the custom property is on the chain. Memoised per
// (element, settleGen) so a read burst between mutations walks each chain once; the walk itself is
// integer adds over ~tree-depth nodes. The chain crosses shadow boundaries (ShadowRoot._parent is
// the host), so `:host-context` invalidates through the host's ancestors; shadow-SIDE slot
// mutations move nothing on a light child's chain, which is why the memos refuse slottable
// candidates outright (hideMemoFor).
// The stamp carries a realm token besides the generation: `_ctxGen` lives on the (cross-realm
// shared) element, but each realm counts its own settleGen from 0 — two realms' counters can
// collide numerically, and a parent-realm stamp must never satisfy a child-realm read.
const CTX_REALM_TOKEN = {};
export function ctxEpochOf (el) {
  const gen = globalThis.__settleGenGet ? globalThis.__settleGenGet() : 0;
  if (el._ctxTok === CTX_REALM_TOKEN && el._ctxGen === gen) return el._ctxVal;
  let h = 0;
  for (let n = el; n; n = n._parent) {
    h = (Math.imul(h, 31) + (n._selEpoch || 0) + 1) | 0;
  }
  el._ctxTok = CTX_REALM_TOKEN;
  el._ctxGen = gen;
  el._ctxVal = h;
  return h;
}

// `:has()` is the one pseudo-class that reads DESCENDANT state, which the ancestor-chain epoch
// above cannot see — a descendant mutation must not leave a cached `:has()`-dependent answer
// stale. Same shape as the dynamic-selector taint: a read that so much as CONSIDERED a
// `:has()`-bearing rule bumps this counter, and the declaredValue memo declines to cache it.
// Separate from `dynamicSeq` on purpose — widening the dynamic taint would also cold the memos
// that key on it (the regression signal the flow-sides work established).
let ctxUnsafeSeq = 0;
export function ctxUnsafeReadSeq () { return ctxUnsafeSeq; }
export function restoreCtxUnsafeSeq (seq) { ctxUnsafeSeq = seq; }
function ruleLooksDown (rule) {
  if (rule.__looksDown === undefined) {
    rule.__looksDown = (rule.selectorText || '').toLowerCase().indexOf(':has(') !== -1;
  }
  return rule.__looksDown;
}

// FOCUS and HOVER are derived, not signalled. `document._activeElement` is assigned from a dozen places
// (focus / blur / removal / navigation / dialog / shadow retarget), and a caching bug caused by
// missing ONE of them is invisible until a `:focus` rule stops updating — which is exactly how the
// first attempt at this cache went wrong. Comparing the value costs one property read and cannot
// miss a writer. `__csimFocusVisible` rides along: it distinguishes `:focus-visible` from `:focus`
// at the same instant, so a pointer-driven focus that leaves `_activeElement` unchanged still
// counts as a change. `_hoverElement` is the same shape — one global, many writers.
// Held as WeakRefs (with a plain fallback where WeakRef is absent): a strong module-level reference
// to the focused or hovered element would keep it — and its whole subtree — alive after removal,
// until the next focus/hover change. This module outlives every page.
const weak = (v) => (v && typeof globalThis.WeakRef === 'function' ? new globalThis.WeakRef(v) : v);
const deref = (r) => (r && typeof r === 'object' && typeof r.deref === 'function' ? r.deref() : r);
let lastActive = undefined, lastFocusVisible = undefined, lastHover = undefined;
function styleStateGeneration () {
  const doc = globalThis.document;
  const active = doc ? doc._activeElement : null;
  const hover  = doc ? doc._hoverElement  : null;
  const fv = globalThis.__csimFocusVisible;
  if (active !== deref(lastActive) || fv !== lastFocusVisible || hover !== deref(lastHover)) {
    lastActive = weak(active); lastFocusVisible = fv; lastHover = weak(hover);
    bumpStyleState();
  }
  return currentStyleStateGen();
}
// Is this element's inline axis HORIZONTAL? In a vertical writing mode the axes swap, so
// `inline-size` is the height and `block-size` the width.
export function inlineAxisIsHorizontal (el) {
  return flowSides(el)['inline-start'] === 'left' || flowSides(el)['inline-start'] === 'right';
}
const SIZE_PREFIXES = ['', 'min-', 'max-'];
// The logical name whose value would land on `physicalProp` for this element, or null.
export function logicalCounterpart (el, physicalProp) {
  const m = /^(.*?)(top|right|bottom|left)(.*)$/.exec(physicalProp);
  if (!m) {
    for (const pre of SIZE_PREFIXES) {
      if (physicalProp === `${pre}width`)  return `${pre}${inlineAxisIsHorizontal(el) ? 'inline' : 'block'}-size`;
      if (physicalProp === `${pre}height`) return `${pre}${inlineAxisIsHorizontal(el) ? 'block' : 'inline'}-size`;
      if (physicalProp === `${pre}inline-size`) return `${pre}${inlineAxisIsHorizontal(el) ? 'width' : 'height'}`;
      if (physicalProp === `${pre}block-size`)  return `${pre}${inlineAxisIsHorizontal(el) ? 'height' : 'width'}`;
    }
    return null;
  }
  const sides = flowSides(el);
  for (const flow of Object.keys(PHYSICAL_SIDES)) {
    if (sides[flow] !== m[2]) continue;
    // The two families are named asymmetrically: the physical insets are the BARE sides (`top`),
    // their flow-relative twins carry the family name (`inset-block-start`).
    return (m[1] === '' && m[3] === '') ? `inset-${flow}` : `${m[1]}${flow}${m[3]}`;
  }
  return null;
}
// The property names that HAVE a flow-relative twin in either direction. Every other read — the
// overwhelming majority: colour, display, font, … — takes one Set lookup and skips the merge.
// Derived from the property list rather than hand-listed: every longhand whose name carries a
// physical side has a flow-relative twin (and vice versa) as long as BOTH names are real
// properties. Hand-listing missed the `scroll-margin-*` / `scroll-padding-*` families entirely.
// Built on FIRST USE, not at module evaluation: cascade.js and style-proxy.js import each other,
// and inside that cycle a module-level read of another module's binding can land in its temporal
// dead zone — which broke the V8 snapshot build outright.
let HAS_FLOW_TWIN_SET = null;
function hasFlowTwin (prop) {
  if (!HAS_FLOW_TWIN_SET) HAS_FLOW_TWIN_SET = buildFlowTwinSet();
  return HAS_FLOW_TWIN_SET.has(prop);
}
const buildFlowTwinSet = () => {
  const set = new Set([
    'top', 'right', 'bottom', 'left',
    'inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end',
    ...['width', 'height'].flatMap(d => [d, `min-${d}`, `max-${d}`]),
    ...['inline-size', 'block-size'].flatMap(d => [d, `min-${d}`, `max-${d}`]),
  ]);
  const FLOW = ['block-start', 'block-end', 'inline-start', 'inline-end'];
  for (const name of LONGHANDS) {
    const m = /^(.*?)(top|right|bottom|left)(.*)$/.exec(name);
    if (m && LONGHANDS.has(`${m[1]}block-start${m[3]}`)) { set.add(name); for (const f of FLOW) set.add(`${m[1]}${f}${m[3]}`); }
  }
  return set;
};

export function cascadedProperty (el, prop) {
  // A PHYSICAL property may have been written flow-relatively (`margin-block-start` for
  // `margin-top`), and vice versa. Both names live in the cascade; the winner is whichever
  // declaration the cascade prefers, which is what comparing the two records answers.
  const own_ = cascadedRecord(el, prop);
  if (!hasFlowTwin(prop)) return own_ ? own_.value : null;
  // `logicalCounterpart` answers in BOTH directions for the sizes (they are named symmetrically);
  // only the SIDE families need the dedicated physical mapping.
  const other = twinName(el, prop);
  if (!other) return own_ ? own_.value : null;
  // The twin lookup is a SECOND full cascade walk, on exactly the properties the layout pass reads
  // several times per element — so it only runs when the twin could actually be declared. Both
  // questions are cached: the rule index per property, the inline map per style attribute.
  if (!cascadeDeclaresProperty(other) && !(other in inlineDecls(el))) return own_ ? own_.value : null;
  const alt = cascadedRecord(el, other);
  if (!alt) return own_ ? own_.value : null;
  if (!own_) return alt.value;
  // Same origin AND same block? Then neither specificity nor source order separates them — every
  // declaration of a rule shares one `source` — and the winner is simply the one written later.
  if (own_.important === alt.important && own_.source === alt.source &&
      own_.order != null && alt.order != null) {
    return alt.order > own_.order ? alt.value : own_.value;
  }
  // An INLINE declaration outranks every selector rule at equal importance. `winsProp` knows that
  // for the incumbent (`current.inline`) but has no parameter for the candidate — it assumes one
  // is always a rule — so an inline `margin-inline-start` was compared on specificity `[0,0,0]`
  // and lost to a class rule's `margin-left`.
  if (own_.important === alt.important && !!own_.inline !== !!alt.inline) {
    return alt.inline ? alt.value : own_.value;
  }
  return winsProp(own_, alt.spec, alt.source, alt.important, alt.layerRank) ? alt.value : own_.value;
}

// The twin's name, memoised per (property, flow configuration). The configuration object is shared
// by every element that inherits it, so a page in one writing mode computes each name once —
// running the two regexes on every property read was most of what the twin lookup cost.
export function twinName (el, prop) {
  const sides = flowSides(el);
  let memo = sides.twins;
  if (!memo) memo = sides.twins = new Map();
  if (memo.has(prop)) return memo.get(prop);
  const name = LOGICAL_SIDE_RE.test(prop) ? physicalCounterpart(el, prop) : logicalCounterpart(el, prop);
  memo.set(prop, name);
  return name;
}

// The physical name a logical one resolves to for this element.
function physicalCounterpart (el, logicalProp) {
  const sides = flowSides(el);
  const m = /^(.*?)(block-start|block-end|inline-start|inline-end)(.*)$/.exec(logicalProp);
  if (!m) return null;
  const side = sides[m[2]];
  // The inset longhands are the bare physical sides (`top`), not `inset-top`.
  const base = m[1] === 'inset-' ? '' : m[1];
  return `${base}${side}${m[3]}`;
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
    // `anc` describes the ORIGINAL selector, and this rewrites the text — so it is dropped rather
    // than carried. Every routed rule is a single whole-selector functional pseudo today, which
    // collects nothing anyway; making that explicit is what keeps a later rewrite from shipping an
    // ancestor requirement that belongs to a different selector.
    if (rule.__hideRule) bucketHide.push({ ...rule, selectorText: sel, anc: null, source: rule.source + serial });
    else                 bucketLayout.push({ ...rule, selectorText: sel, anc: null, source: rule.source + serial });
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
// "Does the captured rule-set contain at least one declaration for
// this property?" Answered by the property-first index. Without this
// guard the cascade walk fires per element on every render even when
// the stylesheet has zero rules touching the property — Discourse's
// ~2000-rule sheet would otherwise pay a per-element bucket walk for
// each property read on every visible_text call.
// "Could ANY stylesheet rule supply this property?" — the cached `rulesIndexHas` gate, exported so
// an inheritance walk can skip the per-ancestor cascade lookup entirely when the answer is no
// (then only an inline declaration can supply a value, and that's a cached-map lookup).
// SHADOW-TREE sheets are not in that index, and `cascadedProperty` does consult them, so a page
// with any shadow root answers yes unconditionally rather than skipping an ancestor whose own
// tree's `<style>` declares the property.
export function cascadeDeclaresProperty (prop) {
  ensureCascadeFresh();
  return rulesIndexHas(prop) || !!globalThis.__csimShadowHostCount;
}
// One structure answers both questions: the property-first index's key set IS "some rule
// captures this property", so the former per-property scan-and-cache (`propCache`) is gone.
function rulesIndexHas (prop) {
  return layoutPropIndex().has(prop);
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
