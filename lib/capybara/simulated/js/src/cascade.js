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

import { walk, walkFind, classes, scriptText } from './walk.js';
import { bumpStyleState, takeStyleStateHints, FOCUS_KINDS, HOVER_KINDS, currentStyleStateGen, currentDirtySeq, markLayoutDirty } from './mutation-observer.js';
import { isStaticallyInvalidMath } from './calc.js';
import { mediaMatches, currentViewport, supportsMatches } from './media-query.js';
import { splitTopLevel, decodeDataUrlCss, resolveCssUrls, documentBaseUrl, parseStyleDeclList, isSupportedCssPropertyName, serializeCssValue } from './css-utils.js';
import { isRegularShorthand, shorthandExpand, shorthandLonghands, isCssWideKeyword, hasSubstitution,
         pendingSubstitution, FONT_SHORTHAND } from './shorthands.js';
import { matchesSelector, matchesSelectorNS } from './selectors.js';
import { normalizeColor, declaredValue, declaredValueIn, fontRelativeToPx, uaDefault, cssWideComputed } from './style-proxy.js';
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
// The index key of a rule's SUBJECT compound — the most discriminating thing it pins, in the
// order class > id > tag > attribute name > `:root` > universal. Two subjects never reach an
// element's walk at all: a pseudo-ELEMENT subject (`::before`, `::-webkit-*`, legacy `:before`)
// styles generated content this engine does not lay out, so it is `none`; and `:root` alone
// matches only the document element, so it is `root` and walked for that element only.
// Measured on Discourse before this split: 41% of all candidate visits came from the universal
// bucket — `:root { --vars }` (777k visits, matching one element), attribute-only subjects
// (`[type=checkbox]`, `[class*=metadata__]`), and `::-webkit-*` rules that can never match.
function terminalKey(selText, attrsOut) {
  let groups;
  try { groups = CW.parse(selText); }
  catch (_) { if (attrsOut) attrsOut.add('*'); return { kind: 'universal' }; }
  if (attrsOut) noteSelectorAttrs(groups, attrsOut);
  let id = null, cls = null, tag = null, attr = null, root = false, pseudoEl = false;
  for (const t of (groups[0] || [])) {
    if (CW_COMBINATORS.has(t.type)) { id = cls = tag = attr = null; root = pseudoEl = false; continue; }   // new compound
    if (t.type === 'tag') { if (t.name !== '*') tag = t.name.toLowerCase(); }
    else if (t.type === 'attribute') {
      if (t.name === 'class' && t.action === 'element') { if (!cls) cls = t.value; }
      else if (t.name === 'id' && t.action === 'equals') { if (!id) id = t.value; }
      // Any other POSITIVE attribute selector requires the attribute to be present; `[a!=v]`
      // (css-what `not`) matches its absence too, so it pins nothing — and a NAMESPACED one
      // (`[xlink|href]`, `[*|href]`) is stored under its qualified name and matched by local
      // name, which no attribute-name bucket can stand for, so it stays universal.
      else if (t.action !== 'not' && t.namespace == null) { if (!attr) attr = String(t.name).toLowerCase(); }
    }
    else if (t.type === 'pseudo-element') pseudoEl = true;
    else if (t.type === 'pseudo') {
      const name = String(t.name).toLowerCase();
      if (name === 'root') root = true;
      else if (LEGACY_PSEUDO_ELEMENTS.has(name)) pseudoEl = true;
    }
  }
  if (pseudoEl) return { kind: 'none' };
  if (cls)  return { kind: 'class', key: cls };
  if (id)   return { kind: 'id', key: id };
  if (tag)  return { kind: 'tag', key: tag };
  if (attr) return { kind: 'attr', key: attr };
  if (root) return { kind: 'root' };
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
  const out = [], tags = [];                     // classes / ids first: the index keys its ancestor groups on out[0]
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
    let h = 0, isTag = false;
    if (t.type === 'tag') { if (t.name && t.name !== '*') { h = ancBloomHash(3, t.name.toLowerCase()); isTag = true; } }
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
    if (!h) continue;
    const list = isTag ? tags : out;
    if (list.indexOf(h) < 0) list.push(h);
    if (out.length + tags.length >= ANC_MAX_HASHES) break;
  }
  for (const h of tags) { if (out.length >= ANC_MAX_HASHES) break; out.push(h); }
  return out.length ? out : null;
}
// The union of every ancestor's tag / id / classes, one bit each. Keyed on the SAME
// context epoch the declared-value memo uses: it is an ancestor-chain hash, so it moves
// exactly when this filter's answer could.
function ancestorBloom(el) {
  const ctx = ctxEpochOf(el);
  // …and on the rule set: the gate leaves a descendant's context alone when an ancestor gains
  // an identifier no CURRENT rule reads there, so a later rule that does must see a bloom built
  // after the gain.
  const epoch = cascadeStyleEpoch();
  if (el._abCtx === ctx && el._abEpoch === epoch && el._abVal) return el._abVal;
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
  el._abEpoch = epoch;
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
// are the flattened rule lists; `hideIdx` (the rule index: tag / id / class / attribute / root / universal buckets, each split by first ancestor hash) and
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
  dynLayoutReqs: [],
  dynLayoutNeeded: new Set(),
  dynLayoutNeededAttrs: [],
  dynLayoutCore: [],
  dynLayoutVarOnly: [],
  hasMinMaxRule: false,
  layoutTokenGate: null,
  dynStateSubjects: null,
  dynStateEpochFallback: false,
  sheets: [],
  // The structural-context gate (`CtxGate`, built lazily from `sheets`): null = no answer, every
  // write is conservative; undefined = not asked for yet since the last rebuild.
  ctxGate: null,
  ctxChildListDesc: true,
  ctxEmptySibling: 2,
  ctxChildListVarNames: null
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
  const { hide, layout, attrs, sheets } = collectCascadeRules(doc, selectedSet);
  state.hideRules   = hide;
  state.layoutRules = layout;
  state.sheets      = sheets;
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
  // Both derivations below ask the same question of the sheets; ask it once.
  const reachable = layoutReachableCustomProps(sheets);
  const dynLayout = collectDynamicLayoutRules(hide, layout, reachable);
  state.dynLayoutCore    = dynLayout.rules;
  state.dynLayoutVarOnly = dynLayout.varOnlyRules;
  deriveDynamicLayoutState();
  state.hasMinMaxRule = computeHasMinMaxRule(layout);
  state.layoutTokenGate = buildLayoutTokenGate(hide, layout, reachable);
  state.ctxGate = undefined;   // the next write that asks builds it from `state.sheets` (CtxGate)
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
  state.dynLayoutReqs = [];
  state.dynLayoutNeeded = new Set();
  state.dynLayoutNeededAttrs = [];
  state.dynLayoutCore = [];
  state.dynLayoutVarOnly = [];
  state.hasMinMaxRule = false;
  state.layoutTokenGate = null;   // no rule index = no answer: every class write marks the subtree
  state.dynStateSubjects = null;
  state.dynStateEpochFallback = false;
  state.sheets = [];
  CTX_SWEEPS.length = 0;
  state.ctxGate = null;
  state.ctxChildListDesc = true;
  state.ctxEmptySibling = 2;
  state.ctxChildListVarNames = null;
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
  'transition', 'transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay',
  'transition-behavior',
  // …and animations: this engine runs none, so an `animation` declaration never moves a box
  // either (Discourse's `[contenteditable=true]:focus-within { animation }` otherwise counted as
  // a dynamic LAYOUT rule — and a keyless one, which pushed every focus flip into the epoch).
  'animation', 'animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay',
  'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state',
  'animation-composition', 'animation-timeline',
  // `opacity` paints too: no stacking context, hit-test order, or visibility filter reads it
  // in this engine — only getComputedStyle reports it.
  'opacity',
  // `z-index` orders painting but moves nothing: a pass stamps boxes and `_lbOrder` (tree
  // order), neither of which reads it. Its direct consumers — `paintRank`,
  // `establishesStackingContext` — ask `declaredValue` LIVE at hit-test time, and the one memo
  // that bakes a rank in (layout.js `stackChain`, per-pass) carries a `dynamicReadSeq` taint
  // bracket so a chain that considered a dynamic rule is never cached. (Tailwind's
  // `.focus\:z-10:focus` otherwise armed the dynamic-layout gate on every page that uses the
  // utility.)
  'z-index'
]);
// Can a DYNAMIC-pseudo rule (`:hover`, `:checked`, `:placeholder-shown`, …) move a box on this
// page? Layout memos key on the style-state generation only when it can, because that generation
// moves for every keystroke, focus and hover — and keying on it unconditionally made one
// `setRangeText` cost a whole-document relayout (measured: 1 ms → 2.9 s for 100 type-and-measure
// rounds on a 300-row page). The overwhelmingly common dynamic rule paints and nothing more
// (`:hover { background: … }`), and that page now pays nothing.
//
// This asks the RULES, never the state writers: any dynamic rule declaring anything outside the
// paint-only set above is collected (the caller derives the page-level answer, and the presence
// gate below narrows it to "while the rule can match at all"); a page with a shadow tree (whose
// sheets are not in this index) answers yes unconditionally.
// Set the first time any element's inline style consumes a custom property in a non-paint
// position; see the note at the sighting site in `inlineDecls`.
let inlineVarLayoutSeen = false;

// The custom properties that can REACH layout: consumed by some non-paint declaration in the
// rule set, directly (`width: var(--w)`) or through another custom property (`--w: var(--v)`).
// Everything else — Tailwind's whole `--tw-*` family, consumed only by colors and shadows — is
// paint-only by the same argument as PAINT_ONLY_PROPS itself, and a `:hover` rule that only
// writes such properties cannot move a box. Inline styles are the one consumer this scan can't
// enumerate; once one is sighted (`inlineVarLayoutSeen`) the custom-property-only rules join the
// dynamic-layout working set (`deriveDynamicLayoutState`), scoped to their subjects like any other.
const VAR_REF_RE = /var\(\s*(--[^\s,)]+)/g;
// One sheet's half of the graph above, built while the sheet is parsed (`noteVarGraph`) so it
// rides the sheet cache: `seeds` = custom properties the sheet reads in a box-moving position,
// `edges` = [declared custom property, the ones its value reads]. A document merges the sheets'
// halves and closes the graph — O(distinct custom properties) instead of a scan of every rule's
// every declaration on every cascade rebuild (1.0 s of a 40 s Discourse run, 2.5 % of wall).
// Deduped as it is built: utility CSS declares the same `--x: var(--y)` in hundreds of rules, and
// unlike the transient scan this replaced, the result is serialised into the sheet cache and
// re-parsed per document.
function newVarGraph() { return { seeds: [], edgeMap: new Map() }; }
function noteVarGraph(graph, prop, value) {
  if (typeof value !== 'string' || value.indexOf('var(') === -1) return;
  const custom = prop.startsWith('--');
  if (!custom && PAINT_ONLY_PROPS.has(prop)) return;   // paint-only: reading it moves no box
  VAR_REF_RE.lastIndex = 0;
  let m;
  while ((m = VAR_REF_RE.exec(value))) {
    if (!custom) { if (graph.seeds.indexOf(m[1]) === -1) graph.seeds.push(m[1]); continue; }
    let refs = graph.edgeMap.get(prop);
    if (refs === undefined) graph.edgeMap.set(prop, refs = []);
    if (refs.indexOf(m[1]) === -1) refs.push(m[1]);
  }
}
// …to the wire form the sheet cache holds: [declared custom property, the ones its value reads].
function finishVarGraph(graph) { return { seeds: graph.seeds, edges: [...graph.edgeMap] }; }
// The custom properties whose value can reach a BOX — declared-and-read transitively from a
// box-moving declaration. Merged from the sheets' precomputed halves.
function layoutReachableCustomProps(sheets) {
  const seeds = new Set();
  const edges = new Map();                       // declared custom prop -> custom props its value reads
  for (const { sheet: sh } of sheets) {
    const g = sh.varGraph;
    if (g === undefined) continue;               // no graph = an empty one (a sheet that failed to parse)
    for (const n of g.seeds) seeds.add(n);
    for (const [prop, refs] of g.edges) {
      let list = edges.get(prop);
      if (!list) edges.set(prop, list = []);
      for (const r of refs) list.push(r);
    }
  }
  const reachable = new Set();
  const work = [...seeds];
  while (work.length) {
    const prop = work.pop();
    if (reachable.has(prop)) continue;
    reachable.add(prop);
    const next = edges.get(prop);
    if (next) for (const n of next) work.push(n);
  }
  return reachable;
}

// Does every selector group of this rule style only a pseudo-ELEMENT? This engine lays out no
// generated-content boxes at all — no `::before` / `::after`, no scrollbar parts — so such a rule
// cannot move an element box however its dynamic state flips. (The always-shipped
// `body.os-pc .mac-styled-scrollbar:hover::-webkit-scrollbar-thumb` UA-widget rule otherwise
// kept every Avo page relaying out per hover change on its own.)
function subjectIsPseudoElement(rule) {
  if (rule.__subjPE !== undefined) return rule.__subjPE;
  return (rule.__subjPE = computeSubjectIsPseudoElement(rule.selectorText || ''));
}
// A pseudo-ELEMENT subject needs a pseudo-element token to be there at all, and a page's rules
// overwhelmingly carry none — a string test answers those without css-what (which is otherwise a
// full selector parse per rule per cascade rebuild).
const PSEUDO_ELEMENT_HINT_RE = /::|:(?:before|after|first-line|first-letter)\b/i;
function computeSubjectIsPseudoElement(selText) {
  if (!PSEUDO_ELEMENT_HINT_RE.test(selText)) return false;
  let groups;
  try { groups = CW.parse(selText); }
  catch (_) { return false; }                    // unparseable: keep the rule (conservative)
  if (!groups.length) return false;
  return groups.every((g) => {
    let pe = false;
    for (const t of g) {
      if (CW_COMBINATORS.has(t.type)) pe = false;
      else if (t.type === 'pseudo-element') pe = true;
      else if (t.type === 'pseudo' && LEGACY_PSEUDO_ELEMENTS.has(String(t.name).toLowerCase())) pe = true;
    }
    return pe;
  });
}

// ── the class-token layout gate ──────────────────────────────────────────────────────────────
// A class write used to mark the writer's whole subtree layout-dirty unconditionally. The
// selectors say something far sharper: a flipped token can only change the boxes of elements
// matched by rules that MENTION it. Per box-moving rule and token position this reduces to
// three answers, precomputed at rebuild into one token map:
//
//   absent   — no box-moving rule mentions the token: the flipped element's own plain
//              `_lbDirty` mark is all the write needs (paint rules still apply through the
//              cascade side's `_selEpoch` invalidation).
//   SUBTREE  — the token appears in a SUBJECT compound of a box-moving rule, or anywhere the
//              map cannot place precisely (inside `:not()` / `:is()` nesting). Today's
//              behavior. (Subject-position box properties looked healable by the parent's own
//              relayout; an absolutely positioned descendant anchored to the subject's
//              containing block is not — see the note in `ruleMovesBoxes`.)
//   DESC     — the token appears in a NON-subject compound (`body.os-pc .os-host { … }`):
//              flipping it can restyle only elements matching the group's subject key within
//              the writer's scope. Those get subtree marks; the rest of the writer's subtree —
//              on `<body>`, the whole page — keeps its memos.
//
// The direction of every fallback is the expensive one: anything unplaceable is SUBTREE, and
// any selector whose identifiers are unknowable (`[class^=…]`, `:has()`, `:nth(… of S)`, a
// parse failure) makes the whole gate UNGATEABLE — every class write behaves as before. This
// is the inverse of `dynamicLayoutRuleReqs`, where SKIPPING identifiers is the safe direction;
// a shared walker would inevitably get one of the two wrong.


const TOKEN_SUBTREE = 2, TOKEN_VAR = 4;

function ruleMovesBoxes(r, reachable, isHide) {
  if (subjectIsPseudoElement(r)) return 0;
  if (isHide) return (r.display != null || r.visibility != null) ? TOKEN_SUBTREE : 0;
  let mode = 0;
  for (const prop in r.captured) {
    if (prop.startsWith('--')) {
      // A custom property flows to arbitrary var() consumers below — inherited-shaped. One
      // consumed by the SHEETS counts outright; one only an INLINE style could consume gets
      // the VAR bit, resolved against the sticky `inlineVarLayoutSeen` at WRITE time — the
      // sighting happens on first layout, always after this build runs.
      if (reachable.has(prop)) return TOKEN_SUBTREE;
      mode |= TOKEN_VAR;
      continue;
    }
    if (PAINT_ONLY_PROPS.has(prop)) continue;
    // SUBTREE even for pure box properties (width / display / margin …) — a subject-only flip
    // was meant to heal through the parent's relayout, but an ABSOLUTELY POSITIONED descendant
    // anchored to the subject's containing block does not: the intermediate auto-height
    // elements reuse, and `placeAbsolute` only runs inside a relayouted ancestor. Re-enabling
    // SELF needs reuseSubtree to refuse subtrees that contain an out-of-flow box anchored
    // OUTSIDE themselves (or a global abspos re-place at pass end).
    return TOKEN_SUBTREE;
  }
  return mode;
}

// One selector-group walk, filling `map` (token → {mode, desc: Map(subjectKey → {sibling})}).
// Returns false when the gate must go ungateable.
function noteGroupIdents(map, g, ruleMode) {
  // Split into compounds; remember which is the subject (last) and whether a sibling
  // combinator appears anywhere (scope widens to the parent).
  const compounds = [[]];
  let sibling = false;
  for (const t of g) {
    if (CW_COMBINATORS.has(t.type)) {
      if (t.type === 'column-combinator') return false;   // `||`: neither descendant nor sibling scope fits
      if (t.type === 'sibling' || t.type === 'adjacent') sibling = true;
      compounds.push([]);
      continue;
    }
    compounds[compounds.length - 1].push(t);
  }
  const subject = compounds[compounds.length - 1];
  const subjectKey = compoundKey(subject);
  const note = (token, mode) => {
    const e = map[token] || (map[token] = { mode: 0, desc: null });
    e.mode |= mode;
  };
  for (let ci = 0; ci < compounds.length; ci++) {
    const isSubject = ci === compounds.length - 1;
    for (const t of compounds[ci]) {
      let token = null;
      if (t.type === 'attribute') {
        const name = String(t.name).toLowerCase();
        if (name === 'class') {
          if (t.action !== 'element') return false;
          token = '.' + t.value.toLowerCase();
        } else if (name === 'id') {
          if (t.action !== 'equals') return false;
          token = '#' + t.value.toLowerCase();
        }
      } else if (t.type === 'pseudo' && t.name === 'has') {
        return false;                              // upward invalidation: unrepresentable here
      } else if (t.data) {
        if (typeof t.data === 'string') {
          if (/[.#\[]/.test(t.data)) return false;
        } else {
          // Identifiers nested in `:not()` / `:is()` / `:where()`: position within the nest is
          // ambiguous (the nested list has its own combinators), so every one is SUBTREE.
          if (!noteNestedIdents(map, t.data)) return false;
        }
      }
      if (!token) continue;
      if (isSubject) {
        note(token, ruleMode);
      } else if (subjectKey) {
        const e = map[token] || (map[token] = { mode: 0, desc: null });
        (e.desc || (e.desc = new Map())).set(subjectKey, (e.desc.get(subjectKey) || false) || sibling);
      } else {
        note(token, TOKEN_SUBTREE);                // keyless subject: cannot scope the effect
      }
    }
  }
  return true;
}

function noteNestedIdents(map, groups) {
  for (const g of groups) {
    for (const t of g) {
      if (t.type === 'attribute') {
        const name = String(t.name).toLowerCase();
        if (name === 'class') {
          if (t.action !== 'element') return false;
          const e = map['.' + t.value.toLowerCase()] || (map['.' + t.value.toLowerCase()] = { mode: 0, desc: null });
          e.mode |= TOKEN_SUBTREE;
        } else if (name === 'id') {
          if (t.action !== 'equals') return false;
          const e = map['#' + t.value.toLowerCase()] || (map['#' + t.value.toLowerCase()] = { mode: 0, desc: null });
          e.mode |= TOKEN_SUBTREE;
        }
      } else if (t.type === 'pseudo' && t.name === 'has') {
        return false;
      } else if (t.data) {
        if (typeof t.data === 'string') {
          if (/[.#\[]/.test(t.data)) return false;
        } else if (!noteNestedIdents(map, t.data)) return false;
      }
    }
  }
  return true;
}

// The subject compound's query key: how DESC entries and the scoped state sweep find the
// affected elements. Class beats id beats tag (same preference as `terminalKey`). The key IS a
// selector — fed to querySelectorAll — so the identifier must be CSS-escaped: Tailwind class
// names carry literal colons and dots (`checked:block`, `w-1.5`), and the raw spelling parsed
// as a pseudo-class and threw from inside a class write.
function selectorEscape(v) {
  if (globalThis.CSS && globalThis.CSS.escape) return globalThis.CSS.escape(v);
  return String(v).replace(/[^a-zA-Z0-9_\u00a1-\uffff-]/g, (c) => '\\' + c);
}
function compoundKey(tokens) {
  let tag = null, id = null, cls = null;
  for (const t of tokens) {
    if (t.type === 'tag') { if (t.name !== '*') tag = t.name.toLowerCase(); }
    else if (t.type === 'attribute') {
      if (t.name === 'class' && t.action === 'element') { if (!cls) cls = t.value; }
      else if (t.name === 'id' && t.action === 'equals') { if (!id) id = t.value; }
    }
  }
  if (cls) return '.' + selectorEscape(cls);
  if (id) return '#' + selectorEscape(id);
  if (tag) return tag;
  return null;
}

function buildLayoutTokenGate(hide, layout, reachable) {
  const map = Object.create(null);
  for (const list of [hide, layout]) {
    const isHide = list === hide;
    for (const r of list) {
      const mode = ruleMovesBoxes(r, reachable, isHide);
      if (!mode) continue;
      let groups;
      try { groups = CW.parse(r.selectorText || ''); }
      catch (_) { return null; }
      for (const g of groups) {
        if (!noteGroupIdents(map, g, mode)) return null;
      }
    }
  }
  return map;
}

// Decide a class write's layout invalidation from the flipped tokens. Returns:
//   null           — nothing flipped that any box-moving rule mentions: plain self mark
//   true           — subtree mark, exactly as before
//   { desc: Map }  — plain self mark plus subtree marks on the DESC subjects in scope
// Called mid-write from `recordAttrMutation`; deliberately NO `ensureCascadeFresh` (a pending
// sheet change answers "unknown" → subtree, and the rebuild lands on the next read).
export function classWriteLayoutEffect(oldRaw, newRaw) {
  if (oldRaw === newRaw) return null;
  // Shadow sheets are not in this rule index (`mayConstrainSize` has the same rule): a shadow
  // tree's own `.open .panel { … }` would be invisible to the map, so a page hosting any shadow
  // root answers with today's subtree mark unconditionally.
  if (globalThis.__csimShadowHostCount) return true;
  const gate = cascadeRefreshScheduled ? null : state.layoutTokenGate;
  if (!gate) return true;
  const a = String(oldRaw || '').split(/\s+/).filter(Boolean);
  const b = String(newRaw || '').split(/\s+/).filter(Boolean);
  const sa = new Set(a), sb = new Set(b);
  let desc = null;
  const consider = (t) => {
    const e = gate['.' + t.toLowerCase()];
    if (!e) return false;
    if (e.mode & TOKEN_SUBTREE) return true;
    if ((e.mode & TOKEN_VAR) && inlineVarLayoutSeen) return true;
    if (e.desc) {
      if (!desc) desc = new Map();
      for (const [key, sibling] of e.desc) desc.set(key, (desc.get(key) || false) || sibling);
    }
    return false;
  };
  for (const t of sa) if (!sb.has(t) && consider(t)) return true;
  for (const t of sb) if (!sa.has(t) && consider(t)) return true;
  if (desc) return { desc };
  return null;                                     // no box-moving rule mentions any flipped token
}

function collectDynamicLayoutRules(hide, layout, reachable) {
  const rules = [], varOnlyRules = [];
  // A dynamic hide rule also reappears in `layout` (display / visibility are captured like any
  // declaration), so most rules land in `rules` twice — harmless: the requirements are a
  // disjunction, and a duplicate entry changes no answer.
  for (const r of hide) {
    // A hide rule carries `display` / `visibility` — both move boxes.
    if (ruleIsDynamic(r) && (r.display != null || r.visibility != null) &&
        !subjectIsPseudoElement(r)) rules.push(r);
  }
  for (const r of layout) {
    if (!ruleIsDynamic(r)) continue;
    // Classify by property FIRST — a string scan — so the CW.parse behind the pseudo-element
    // check only runs for the rules that would otherwise be kept (a handful), not for every
    // `:hover { background }` utility on the page.
    let core = false, hasVar = false;
    for (const prop in r.captured) {
      if (prop.startsWith('--')) {
        if (reachable.has(prop)) { core = true; break; }
        hasVar = true;
      } else if (!PAINT_ONLY_PROPS.has(prop)) { core = true; break; }
    }
    if (subjectIsPseudoElement(r)) continue;
    // A rule that writes ONLY custom properties no sheet rule reads in a box-moving position can
    // still reach layout through an inline `width: var(--x)` — kept aside, and folded into the
    // working set the moment such a consumer is sighted (`deriveDynamicLayoutState`).
    if (!core) { if (hasVar) varOnlyRules.push(r); continue; }
    rules.push(r);
  }
  return { rules, varOnlyRules };
}

// The dynamic-layout rule set the invalidation machinery works from: the core rules, plus the
// custom-property-only ones once an inline var() consumer exists on the page — until then nothing
// can read what they write in a box-moving position, and a utility sheet's thousand
// `:hover { --tw-bg-opacity }` rules would otherwise arm the gate on every page. Derived at every
// cascade rebuild and re-derived when `inlineVarLayoutSeen` flips, so the armed / scoped memos
// keyed on the cascade version are reset here too.
function deriveDynamicLayoutState() {
  const core = state.dynLayoutCore || [], varOnly = state.dynLayoutVarOnly || [];
  const rules = inlineVarLayoutSeen && varOnly.length ? core.concat(varOnly) : core;
  state.hasDynamicLayoutRule = rules.length > 0;
  state.dynLayoutReqs = rules.length ? dynamicLayoutRuleReqs(rules) : [];
  const scoped = dynamicStateSubjects(rules);
  state.dynStateSubjects = scoped && scoped.subjects;
  state.dynStateEpochFallback = !scoped;
  state.dynLayoutNeeded = new Set();
  if (state.dynLayoutReqs) {
    for (const rule of state.dynLayoutReqs) for (const group of rule) for (const k of group) state.dynLayoutNeeded.add(k);
  }
  // Attribute requirements probe BOTH spellings: attribute keys are case-preserved on non-HTML
  // elements (`viewBox`) and lowercase on HTML ones, and the gate must stay open if either
  // store spelling exists.
  state.dynLayoutNeededAttrs = [];
  for (const k of state.dynLayoutNeeded) {
    if (k[0] !== '@') continue;
    const name = k.slice(1);
    state.dynLayoutNeededAttrs.push([name, k]);
    if (name.toLowerCase() !== name) state.dynLayoutNeededAttrs.push([name.toLowerCase(), k]);
  }
  DYN_ARMED.cv = -1;
  SCOPED_STATE.cv = -1;
}

// Everything about a rule that the dynamic-layout machinery derives from its SELECTOR, computed
// once when the sheet is parsed so it rides the sheet cache: whether the selector is dynamic and
// whether its subject is a pseudo-element (both are memo fields the accessors read), and for a
// dynamic rule its gate requirements and its per-group scoped-state subjects. Re-deriving these
// per cascade rebuild cost 0.7 s of a 40 s Discourse run — the selectors are re-parsed by css-what
// every time, and a page rebuilds its cascade ~4.6 times.
// One selector yields up to two rules (the hide slots and the captured declarations); both get the
// answers, and the selector is parsed once for the pair.
function noteDynamicRuleData(selectorText, hideRule, layoutRule) {
  const dynamic = ruleIsDynamic({ selectorText });   // a string scan, memoised onto both below
  if (hideRule)   hideRule.__dynamicSel = dynamic;
  if (layoutRule) layoutRule.__dynamicSel = dynamic;
  if (!dynamic) return;
  // Only a rule that can MOVE A BOX ever reaches the machinery below, and a page's dynamic rules
  // are overwhelmingly paint-only (`:hover { color }`) — deciding that here is a property scan,
  // where the derivations are a css-what parse apiece. A hide rule always moves boxes; a rule
  // declaring custom properties is kept as a maybe (`reachable` is a document-level answer).
  const wanted = [];
  if (hideRule) wanted.push(hideRule);
  if (layoutRule && declaresBoxMovingProp(layoutRule.captured)) wanted.push(layoutRule);
  if (!wanted.length) return;
  // A pseudo-element subject counts as no box either.
  if (computeSubjectIsPseudoElement(selectorText)) {
    for (const rule of wanted) rule.__subjPE = true;
    return;
  }
  const parsed = parseSelectorGroups(selectorText);
  const reqs = ruleReqsFor(selectorText, parsed);
  const subs = ruleSubjectsFor(selectorText, parsed);
  for (const rule of wanted) { rule.__subjPE = false; rule.dynReqs = reqs; rule.dynSubs = subs; }
}
// The keep-condition `collectDynamicLayoutRules` applies to a layout rule, minus the part that
// needs the document (`reachable`): any custom property, or any property that is not paint-only.
function declaresBoxMovingProp(captured) {
  for (const prop in captured) if (prop.startsWith('--') || !PAINT_ONLY_PROPS.has(prop)) return true;
  return false;
}
// css-what groups, or null when the selector doesn't parse. Shared by the two derivations above so
// a rule is parsed once, not once each.
function parseSelectorGroups(selText) {
  try { return CW.parse(selText || ''); } catch (_) { return null; }
}

// A dynamic layout rule only matters while it CAN match — and its selector says when that is:
// every compound must land on some element, so every positive identifier a compound carries
// (`.easymde-dropdown:focus .easymde-dropdown-content` carries two classes) is an element the
// document must contain. The whole crop of such rules on the app suites is widget CSS shipped
// site-wide for widgets most pages never render; while the identifiers are absent, no focus /
// hover / checked change can move a box through the rule, so the layout epoch need not hear
// about dynamic state at all (`dynamicLayoutRulesArmed`, consulted by `cascadeLayoutEpoch`).
//
// Per rule: an array of selector GROUPS (comma alternatives), each the identifiers all of its
// compounds require, encoded `t:tag` / `#id` / `.class`. A group whose every compound lacks an
// identifier (`:hover > :focus`) constrains nothing — the rule can always match, the gate can never
// close, and the whole answer collapses to `null` (ungated, today's behavior). Case-insensitive
// identifier matches (quirks-mode classes, `[class=x i]`) fold BOTH sides to lowercase, the
// permissive direction the ancestor bloom uses: names differing only in case share a presence, so
// at worst the gate stays open — it is never wrongly closed.
function dynamicLayoutRuleReqs(rules) {
  const reqs = [];
  for (const r of rules) {
    // Precomputed with the sheet (`noteDynamicRuleData`) when it was parsed. The fallback is not
    // dead weight: it derives the answer for a rule that reached the working set without one — a
    // shadow-routed copy (its text was rewritten, so it re-derives) or a future parse-time gate
    // narrower than this set. Losing it would silently lose invalidation instead.
    const ruleReqs = r.dynReqs !== undefined ? r.dynReqs : ruleReqsFor(r.selectorText);
    if (ruleReqs === null) return null;
    reqs.push(ruleReqs);
  }
  return reqs;
}
// One rule's requirements, or null when it cannot be gated (unparseable, or a group that
// constrains nothing).
function ruleReqsFor(selectorText, parsed) {
  const groups = parsed !== undefined ? parsed : parseSelectorGroups(selectorText);
  {
    if (!groups) return null;                         // unparseable selector: cannot gate
    if (!groups.length) return null;                  // no groups = no requirements to stand on
    const ruleReqs = [];
    for (const g of groups) {
      const idents = [];
      let tag = null, id = null, cls = null, attr = null;
      const close = () => {
        if (cls) idents.push('.' + cls);
        else if (id) idents.push('#' + id);
        else if (attr) idents.push('@' + attr);
        else if (tag) idents.push('t:' + tag);
        tag = id = cls = attr = null;
      };
      for (const t of g) {
        if (CW_COMBINATORS.has(t.type)) { close(); continue; }
        if (t.type === 'tag') { if (t.name !== '*') tag = t.name.toLowerCase(); }
        else if (t.type === 'attribute') {
          if (t.name === 'class' && t.action === 'element') { if (!cls) cls = t.value.toLowerCase(); }
          else if (t.name === 'id' && t.action === 'equals') { if (!id) id = t.value.toLowerCase(); }
          // Any other POSITIVE attribute selector still requires the attribute to be present at
          // all — which is what the UA sheet's `[popover]` rules gate on. `action: 'not'`
          // (`[attr!=v]`) matches elements without the attribute, so it requires nothing.
          // The RAW spelling is kept too: attribute keys are case-preserved on non-HTML
          // elements (`viewBox`), and probing only the lowercase name would hold the gate
          // closed while the element exists — the one direction the fold must never err in.
          else if (t.action !== 'not') { if (!attr) attr = String(t.name); }
        }
        // pseudo-classes (`:not`, `:is`, state) and pseudo-elements constrain nothing here: a
        // nested selector's identifiers are NOT requirements (`:not(.x)` forbids, not requires).
      }
      close();
      if (idents.length === 0) return null;           // an unconstrained group: cannot gate
      ruleReqs.push(idents);
    }
    return ruleReqs;
  }
}

// The per-GROUP subjects of every dynamic layout rule, for the scoped state dirtying below. Each
// entry is the group's selector with its dynamic state taken out (`stateFreeQuery`) — every
// element the rule can touch whichever way the state flips — plus, per dynamic pseudo NAME the
// group uses (`kinds`), where in the selector that state sits: the state-free PREFIX up to and
// including its compound (the element whose state flips must match it), whether that compound
// is the subject, and whether a sibling combinator follows it. A hinted sweep narrows with
// those; an unhinted one queries the whole selector. `structural` says the rule can flip
// rendering itself (`display` / `visibility`): those marks must also be STRUCTURAL, or a table's
// grid memo (structFresh, keyed on the epoch this hook keeps still) survives a row disappearing.
// `null` = a selector we could not parse — that rule's effect cannot be scoped, so dynamic state
// must stay in the layout epoch.
function dynamicStateSubjects(rules) {
  const byKey = new Map();                         // rules appear in hide AND layout: dedupe
  for (const r of rules) {
    const structural = r.display != null || r.visibility != null ||
      (r.captured && ('display' in r.captured || 'visibility' in r.captured));
    // The per-group subjects come with the sheet (`noteDynamicRuleData`); only the QUERYABLE
    // probe stays here, because it asks this realm's selector engine (and warms the same compile
    // cache the sweep will use). The fallback covers the same cases as the one in
    // `dynamicLayoutRuleReqs` above.
    const subs = r.dynSubs !== undefined ? r.dynSubs : ruleSubjectsFor(r.selectorText);
    if (subs === null) return null;
    for (const sub of subs) {
      const subject = hydratedSubject(sub);
      if (!queryable(subject)) return null;
      const prev = byKey.get(sub.dedupe);
      if (prev) prev.structural = prev.structural || !!structural;
      else byKey.set(sub.dedupe, { key: subject.key, kinds: subject.kinds, structural: !!structural });
    }
  }
  return { subjects: [...byKey.values()] };
}
// One rule's per-group subjects in a form the sheet cache can hold (`kinds` as pairs), or null
// when any group cannot be scoped.
function ruleSubjectsFor(selectorText, parsed) {
  const groups = parsed !== undefined ? parsed : parseSelectorGroups(selectorText);
  if (!groups) return null;
  if (!groups.length) return null;
  const out = [];
  for (const g of groups) {
    const subject = stateSubject(g);
    if (!subject) return null;
    const kinds = [...subject.kinds];
    const dedupe = subject.key + '\u0000' + kinds.map(([k, v]) => k + (v.unscoped ? '*' : v.prefix + (v.subject ? 1 : 0) + (v.sibling ? 1 : 0))).sort().join('\u0001');
    out.push({ key: subject.key, kinds, dedupe });
  }
  return out;
}
// …and back to the `{ key, kinds: Map }` the sweep wants. Cached on the entry: the working set is
// re-derived on every cascade rebuild, the Map is the same one every time.
function hydratedSubject(sub) {
  if (sub.hydrated === undefined) sub.hydrated = { key: sub.key, kinds: new Map(sub.kinds) };
  return sub.hydrated;
}

// Can the selector engine run every query this subject will issue? The cascade tolerates a
// selector it cannot compile (`safeMatches` marks the rule unmatchable), but a sweep that threw
// from inside `ensureLayout` would take every geometry read on the page down with it — so a
// subject whose key or any prefix does not compile sends the rule set to the epoch fallback.
function queryable(subject) {
  const probe = globalThis.document && globalThis.document.documentElement;
  if (!probe || typeof probe.matches !== 'function') return true;
  try {
    probe.matches(subject.key);
    for (const where of subject.kinds.values()) if (where.prefix) probe.matches(where.prefix);
    return true;
  } catch (_) { return false; }
}

// One selector group → `{ key, kinds }` (see dynamicStateSubjects), or null when it can't be
// stringified back. The whole selector is kept, not just the subject compound, so a keyless
// subject (`.drdn-items>*:focus`, `[contenteditable=true]:focus-within`) is queryable — Redmine's
// and Discourse's one such rule each used to drop the entire page into the epoch fallback, every
// focus/hover flip relaying out ~400 elements instead of the handful the rule can reach.
function stateSubject(group) {
  // Split into compounds, noting each compound's dynamic pseudo names.
  const compounds = [];                            // [{ tokens, kinds: Set, relational: Set, sep: combinator token | null }]
  const fresh = (sep) => ({ tokens: [], kinds: new Set(), relational: new Set(), sep });
  let cur = fresh(null);
  for (const t of group) {
    if (CW_COMBINATORS.has(t.type)) { compounds.push(cur); cur = fresh(t); continue; }
    if (t.type === 'pseudo') collectDynamicPseudoNames(t, cur.kinds, cur.relational, false);
    cur.tokens.push(t);
  }
  compounds.push(cur);
  const key = stateFreeQuery(compounds);
  if (!key) return null;
  const kinds = new Map();
  for (let i = 0; i < compounds.length; i++) {
    for (const kind of compounds[i].relational) kinds.set(kind, { unscoped: true });   // wins over any prefix
    if (!compounds[i].kinds.size) continue;
    const prefix = stateFreeQuery(compounds.slice(0, i + 1));
    if (!prefix) return null;
    let sibling = false;
    for (let j = i + 1; j < compounds.length; j++) {
      const sep = compounds[j].sep;
      if (sep && (sep.type === 'sibling' || sep.type === 'adjacent')) sibling = true;
    }
    // The LAST compound a kind appears in wins: the flipping element has to match everything up
    // to there, which is the tightest prefix that is still sound. A kind read RELATIONALLY —
    // inside `:has()` — flips on some OTHER element (`.a:has(.b:focus)`: the focus lands on `.b`,
    // the compound is `.a`), so no prefix can be asked of the flipping element: that kind is
    // `unscoped`, and a hinted sweep queries its whole selector over the document.
    // …unless a later compound already reads the same kind relationally: unscoped stays unscoped.
    for (const kind of compounds[i].kinds) {
      const prev = kinds.get(kind);
      if (!(prev && prev.unscoped)) kinds.set(kind, { prefix, subject: i === compounds.length - 1, sibling });
    }
  }
  return { key, kinds };
}

// The dynamic pseudo names under `t` (a pseudo token), split by whether the state belongs to
// the compound's own element (`kinds`) or to a RELATED element (`relational`: inside `:has()`,
// or `:host-context()`, whose subject is an ancestor of the shadow host).
function collectDynamicPseudoNames(t, kinds, relational, viaRelation) {
  const name = String(t.name).toLowerCase();
  if (!STATIC_PSEUDOS.has(name)) {
    (viaRelation ? relational : kinds).add(name);
    // A vendor list pseudo css-what keeps as text (`:-webkit-any(.a:hover)`) still names real
    // state inside; whatever it names is relational (nothing can be asked of the element).
    if (typeof t.data === 'string' && t.data.indexOf(':') !== -1) collectDynamicNamesFromText(t.data, relational);
    return;
  }
  if (Array.isArray(t.data)) {
    // `:has()` / `:host-context()` read another element by definition; so does any nested
    // selector that has COMBINATORS in it (`:is(:where(.group):hover *)` — Tailwind v4's
    // `group-hover:` — puts the hover on an ancestor of the compound's element).
    let rel = viaRelation || name === 'has' || name === 'host-context';
    if (!rel) for (const g of t.data) for (const u of g) if (CW_COMBINATORS.has(u.type)) { rel = true; break; }
    for (const g of t.data) for (const u of g) if (u.type === 'pseudo') collectDynamicPseudoNames(u, kinds, relational, rel);
  } else if (typeof t.data === 'string' && t.data.indexOf(':') !== -1) {
    // `:nth-child(2n of .a:hover)`: css-what keeps the argument as text; whatever state it names
    // belongs to a sibling, which no prefix can be asked of.
    collectDynamicNamesFromText(t.data, relational);
  }
}

function collectDynamicNamesFromText(text, into) {
  PSEUDO_NAME_RE.lastIndex = 0;
  let m;
  while ((m = PSEUDO_NAME_RE.exec(text))) {
    if (m[1] === '::' || LEGACY_PSEUDO_ELEMENTS.has(m[2].toLowerCase())) continue;
    if (!STATIC_PSEUDOS.has(m[2].toLowerCase())) into.add(m[2].toLowerCase());
  }
}

// The compounds re-serialized with their dynamic state removed: the dynamic pseudo-classes go; a
// logical pseudo (`:not`, `:is`, `:has`…) with dynamic state INSIDE goes whole (`:not(:hover)`
// forbids, `:is(.a:hover)` and `:has(:focus)` restrict — dropping any of them widens the match,
// so the query stays a superset); pseudo-elements go (nothing is laid out for them); a compound
// left empty becomes `*`.
function stateFreeQuery(compounds) {
  const out = [];
  for (const c of compounds) {
    if (c.sep) out.push(c.sep);
    let empty = true;
    for (const t of c.tokens) {
      if (t.type === 'pseudo-element') continue;
      if (t.type === 'pseudo') {
        const name = String(t.name).toLowerCase();
        if (!STATIC_PSEUDOS.has(name)) continue;
        if (Array.isArray(t.data) && hasDynamicPseudo(t.data)) {
          // A selector LIST pseudo is monotone: taking the state out of its arguments keeps it
          // a superset (and a far tighter query than `*`); `:not()` / `:has()` are not — out whole.
          if (name === 'is' || name === 'where' || name === 'matches' || name === 'any') {
            const inner = stateFreeGroups(t.data);
            if (inner) { out.push({ ...t, data: inner }); empty = false; }
            continue;
          }
          continue;
        }
      }
      out.push(t);
      empty = false;
    }
    if (empty) out.push({ type: 'universal', namespace: null });
  }
  try { return CW.stringify([out]); }
  catch (_) { return null; }
}

// `:is()` arguments with their state taken out, as parsed groups (null when a group can't be).
function stateFreeGroups(groups) {
  const result = [];
  for (const g of groups) {
    const compounds = [];
    let cur = { tokens: [], sep: null };
    for (const t of g) {
      if (CW_COMBINATORS.has(t.type)) { compounds.push(cur); cur = { tokens: [], sep: t }; continue; }
      cur.tokens.push(t);
    }
    compounds.push(cur);
    const text = stateFreeQuery(compounds);
    if (!text) return null;
    let parsed;
    try { parsed = CW.parse(text); } catch (_) { return null; }
    for (const pg of parsed) result.push(pg);
  }
  return result;
}

function hasDynamicPseudo(groups) {
  for (const g of groups) {
    for (const t of g) {
      if (t.type !== 'pseudo') continue;
      if (!STATIC_PSEUDOS.has(String(t.name).toLowerCase())) return true;
      if (Array.isArray(t.data) && hasDynamicPseudo(t.data)) return true;
    }
  }
  return false;
}

// Dynamic state's scoped invalidation: instead of letting a focus / hover / checked flip move
// the LAYOUT epoch (killing every box memo on the page), dirty exactly the elements the armed
// rules' subjects can match. Runs at `ensureLayout` ENTRY — never from `cascadeLayoutEpoch`,
// which memoStamp calls MID-pass, where fresh marks are invisible to the per-pass
// inheritedDirty memo and stale boxes would be sealed under new stamps. The lazy focus/hover
// diff lives in styleStateGeneration, so the hook calls it to force detection; eager writers
// (checked, popover) bumped the generation already. Memoized per (state gen, cascadeVersion) —
// one sweep per actual flip. NOT per parser generation: a streaming-parser insertion is new
// nodes, which lay out fresh — not a state flip — and keying on it swept every dynamic rule's
// subjects over the document at each insertion burst (Discourse: 134 of 244 sweeps in one spec
// file, with no state change behind them).
const SCOPED_STATE = { gen: -1, cv: -1 };
// Pseudo-classes that match an element's ANCESTORS too (`:hover` up the chain, `:focus-within`,
// a control's validity on the form / fieldsets above it): a flip on E reaches rules keyed on
// those through E and every ancestor.
const ANCESTOR_KINDS = new Set(['hover', 'focus-within', 'valid', 'invalid', 'user-valid', 'user-invalid']);
globalThis.__csimApplyScopedStateDirty = function () {
  if (!state.hasDynamicLayoutRule) { takeStyleStateHints(); return; }
  // These arms keep dynamic state in the layout epoch itself (see cascadeLayoutEpoch): shadow
  // sheets aren't in the rule index, and an unparseable selector cannot be queried. The hook
  // only acts where the epoch no longer does.
  if (globalThis.__csimShadowHostCount) { takeStyleStateHints(); return; }
  if (state.dynStateEpochFallback || !state.dynStateSubjects) { takeStyleStateHints(); return; }
  const gen = styleStateGeneration();            // runs the lazy focus / hover diff (which hints)
  const cv = cascadeVersion;
  if (SCOPED_STATE.gen === gen && SCOPED_STATE.cv === cv) return;
  const doc = globalThis.document;
  if (!doc || !doc.querySelectorAll) return;
  const { full, hints } = takeStyleStateHints();
  // Conservative in both directions: every subject match is dirtied whether or not ITS match
  // actually changed, and matches that STOPPED existing are covered because they still match
  // the state-free query (the dynamic pseudo is what flipped, not the identifiers). A
  // cascade-version move (the memo's other key) needs no sweep of its own: it moved the layout
  // epoch, and every box memo is dead already — only a flip someone announced is swept.
  if (full) {
    // Unhinted: every subject, whole document.
    for (const { key, structural } of state.dynStateSubjects) {
      for (const el of doc.querySelectorAll(key)) markLayoutDirty(el, true, structural);
    }
  } else if (hints.length) {
    // Hinted: only the rules that read a kind that flipped, only where the flipping element (or,
    // for an ancestor-matching kind, one of its ancestors) matches the state-free prefix up to
    // that kind's compound — the subject itself when that compound IS the subject, else the
    // subjects under it (under its parent when a sibling combinator follows). Discourse fires
    // ~190 focus flips per spec file against ~190 dynamic rules, mostly `:hover` ones on buttons
    // and links; sweeping them all on every flip dirtied ~80 subtrees a time and cost MORE than
    // the whole-page pass it replaced.
    for (const { kinds, elements, root } of hints) {
      for (const subject of state.dynStateSubjects) {
        for (const [kind, where] of subject.kinds) {
          if (!kinds.has(kind)) continue;
          if (where.unscoped) {
            for (const el of doc.querySelectorAll(subject.key)) markLayoutDirty(el, true, subject.structural);
            continue;
          }
          // A removal hint: the element that carried the state is gone with its subtree, so every
          // subject under the parent it left is dirtied outright (siblings, their descendants);
          // the parent itself and its ancestors take the ordinary prefix walk below.
          if (root) {
            if (root.nodeType === NODE_ELEMENT && root.matches(subject.key)) markLayoutDirty(root, true, subject.structural);
            for (const el of root.querySelectorAll(subject.key)) markLayoutDirty(el, true, subject.structural);
          }
          const up = ANCESTOR_KINDS.has(kind);
          for (const e of elements) {
            // A subject-compound kind dirties each matching element on the chain; any other
            // kind queries ONCE, from the HIGHEST matching element (its subtree holds every
            // lower one's), under its parent when a sibling combinator follows.
            let highest = null;
            for (let x = e; x && x.nodeType === NODE_ELEMENT; x = up ? x._parent : null) {
              if (!x.matches(where.prefix)) continue;
              if (where.subject) markLayoutDirty(x, true, subject.structural);
              else highest = x;
            }
            if (highest) {
              const parent = highest._parent;
              const root = where.sibling && parent && parent.nodeType === NODE_ELEMENT ? parent : highest;
              for (const el of root.querySelectorAll(subject.key)) markLayoutDirty(el, true, subject.structural);
            }
          }
        }
      }
    }
  }
  // Stamped AFTER the sweep: an exception mid-loop must not record the flip as handled.
  SCOPED_STATE.gen = gen; SCOPED_STATE.cv = cv;
};

// Is any dynamic layout rule ARMED — i.e. does the document contain, for at least one of its
// selector groups, every identifier that group requires? Recomputed only when the answer can
// have moved: the rule set (cascadeVersion), the tree (dirtySeq — an element cannot gain or
// lose a tag, id or class without an attribute write or an insertion / removal, every one of
// which bumps it; see markLayoutDirty's callers), or a STREAMING-PARSER insertion (its own
// counter — the parser bypasses the dirtySeq funnel; see parse5-adapter's bumpParserTreeGen).
// The walk visits hidden elements too, which is the point: `display: none` content is exactly
// what a `:focus` reveal rule would show.
const DYN_ARMED = { cv: -1, seq: -1, pt: -1, value: true };
function dynamicLayoutRulesArmed() {
  const reqs = state.dynLayoutReqs;
  if (reqs === null) return true;
  if (reqs.length === 0) return false;           // no dynamic layout rules at all
  const cv = cascadeVersion;
  const seq = currentDirtySeq();
  // The parser gen is the third key: the streaming parser inserts elements WITHOUT moving
  // `dirtySeq` (recordChildList is observer-gated), and a mid-parse read must not freeze the
  // gate against everything the rest of the page brings (see parse5-adapter's bumpParserTreeGen).
  const pt = globalThis.__csimParserTreeGen ? globalThis.__csimParserTreeGen() : 0;
  if (DYN_ARMED.cv === cv && DYN_ARMED.seq === seq && DYN_ARMED.pt === pt) return DYN_ARMED.value;
  const present = new Set();
  const root = globalThis.document && globalThis.document.documentElement;
  if (root) {
    const needed = state.dynLayoutNeeded;
    const neededAttrs = state.dynLayoutNeededAttrs;
    // walkFind, for its early exit: once every needed identifier has been sighted the answer
    // cannot change, and on a page whose widgets sit near the top that skips most of the tree.
    // (The common all-absent page still pays the full walk — there is nothing to shortcut.)
    walkFind(root, (el) => {
      // `_tag` is lowercase for HTML but not for SVG (`foreignObject`); fold as the selector
      // side did, or an SVG-tag requirement could hold the gate closed while its element exists.
      const tag = 't:' + el._tag.toLowerCase();
      if (needed.has(tag)) present.add(tag);
      const id = el._attrs.id;
      if (id) {
        const k = '#' + id.toLowerCase();
        if (needed.has(k)) present.add(k);
      }
      if (el._attrs['class']) {
        const toks = classes(el);
        for (let i = 0; i < toks.length; i++) {
          const k = '.' + toks[i].toLowerCase();
          if (needed.has(k)) present.add(k);
        }
      }
      for (let i = 0; i < neededAttrs.length; i++) {
        if (el._attrs[neededAttrs[i][0]] !== undefined) present.add(neededAttrs[i][1]);
      }
      return present.size === needed.size;
    });
  }
  const value = reqs.some((rule) => rule.some((group) => group.every((k) => present.has(k))));
  DYN_ARMED.cv = cv; DYN_ARMED.seq = seq; DYN_ARMED.pt = pt; DYN_ARMED.value = value;
  return value;
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
// sheet) may affect a document-adopted sheet OR a shadow-root-adopted one — as may a
// shadow root's `adoptedStyleSheets` list itself changing. The former is picked up by
// the deferred document rebuild (its key re-fingerprints doc.adoptedStyleSheets); the
// latter is cached per shadow root keyed on `cascadeVersion` (scopedRulesFor) and is
// NOT in the document key, so we bump the version here so those scoped caches — and
// every rule-set-keyed memo — recompute and re-read the mutated sheet.
export function notifyCssomMutation() {
  bumpCascadeVersion();
  cascadeStale = true;
  scheduleCascadeRefresh();
}
// A rule-set change that the DOCUMENT cascade key cannot see — a shadow root's own
// `<style>` / `adoptedStyleSheets`, or a custom-element definition that flips what a STATIC
// pseudo-class matches (`:disabled` reads form-associatedness off the registry) — moves the
// version alone: that re-keys every rule-set-keyed memo (declared values, hide answers, the
// per-shadow-root scoped rules, layout) without marking the document cascade stale, which
// would only walk every `<style>`/`<link>` to find its key unchanged.
export function bumpCascadeVersion() {
  cascadeVersion = (cascadeVersion + 1) | 0;
}
// Global hook for the modules that can't import cascade.js without a cycle (custom-elements.js
// via selectors.js).
globalThis.__csimBumpCascadeVersion = bumpCascadeVersion;

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
  // v4: each rule carries `anc`, the ancestor-reject hashes. v5: `term` gained the attr / root /
  // none kinds and `anc` lists class / id hashes before tag hashes (the index groups on anc[0]).
  // v6: the sheet carries `cxIndex`, its structural-context index (ctxFeatures / noteCtxFeatures).
  // v7: …and `varGraph`, its half of the custom-property reachability graph, plus each rule's
  // dynamic-selector verdict (`__dynamicSel`) and — for the dynamic rules that can move a box —
  // their `__subjPE` / `dynReqs` / `dynSubs` (noteDynamicRuleData).
  return 'v7:' + text.length + ':' + (h >>> 0).toString(16) + ':' + vp.width + 'x' + vp.height;
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
  try { flat = cssTreeFlatten(cssText, vp); } catch (_) { return { hide, layout, attrs: [], count: 0, layers: [], imports: [], fontSrcs: [], cxIndex: newCtxIndex(), varGraph: finishVarGraph(newVarGraph()) }; }
  // This sheet's structural-context index (`noteCtxFeatures`): computed at PARSE time, so it
  // rides the sheet cache and a document merges per token on demand (`CtxGate`).
  const cxIndex = newCtxIndex();
  // …and the sheet's half of the custom-property reachability graph (`noteVarGraph`).
  const varGraph = newVarGraph();
  for (const r of flat.rules) {
    if (!r.selectorText || !r.decls.length) continue;
    let display = null, displayImp = false;
    let visibility = null, visibilityImp = false;
    const captured = Object.create(null);   // page-authored property names — see `own()` above
    let order = 0;
    for (const d of r.decls) {
      // Within one block an `!important` declaration is never clobbered by a later normal one
      // (CSSOM "set a CSS declaration") — the inline reader has the same rule, and with every
      // declaration captured and every registry shorthand expanded, far more properties reach
      // this map than used to. The `display` / `visibility` SLOTS obey it too: they used to be
      // assigned above this guard, so `display: none !important; display: block` was hidden by
      // the captured map and shown by the hide slot (Chrome: hidden).
      const prev = captured[d.prop];
      if (prev && prev.important && !d.important) continue;
      if      (d.prop === 'display')    { display = d.value; displayImp = d.important; }
      else if (d.prop === 'visibility') { visibility = d.value; visibilityImp = d.important; }
      // `order` is the position WITHIN this rule. Every declaration of a rule shares one `source`,
      // so without it a physical/logical tie (`margin-block-start` vs `margin-top`, both here)
      // would be broken by name rather than by which one the author wrote last.
      captured[d.prop] = { value: d.value, important: d.important, order: order++ };
      noteVarGraph(varGraph, d.prop, d.value);
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
      // Same parse-time placement: which identifiers of which compounds this selector reads, into
      // the sheet's structural-context index (`CtxGate`).
      noteCtxFeatures(cxIndex, ctxFeatures(trimmed, captured));
      const source = serial++;
      const hideRule   = hasHide   ? { selectorText: trimmed, term, anc, spec, source, layer: r.layer, ns: r.ns, display, displayImp, visibility, visibilityImp } : null;
      const layoutRule = hasLayout ? { selectorText: trimmed, term, anc, spec, source, layer: r.layer, ns: r.ns, captured } : null;
      noteDynamicRuleData(trimmed, hideRule, layoutRule);
      if (hideRule)   hide.push(hideRule);
      if (layoutRule) layout.push(layoutRule);
    }
  }
  return { hide, layout, attrs: [...attrs], count: serial, layers: flat.layers, imports: flat.imports || [], fontSrcs: flat.fontSrcs || [], cxIndex, varGraph: finishVarGraph(varGraph) };
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
  const empty = { hide: [], layout: [], attrs: new Set(), sheets: [] };
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
  return { hide, layout, attrs, sheets };
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
// ── the rule index ───────────────────────────────────────────────────────────────────────────
// One shape for both the hide index (items are rules) and the per-property layout index (items
// are `[rule, captured]` pairs): rules bucketed by their subject's key — tag / id / class /
// attribute name / `:root` / universal — and INSIDE each bucket split once more by the first
// ancestor-reject hash (`anc[0]`, a class or id an ancestor MUST carry): the walk tests that one
// bloom bit per group and skips the whole group when the element's chain lacks it, instead of
// handing every rule to the per-rule filter. A rule with no ancestor requirement sits in the
// bucket's `plain` list. Measured on Discourse: `.user-menu .quick-access-panel li a>div`-shaped
// rules were 30% of all candidate visits and 99.9% of them were bloom-rejected one at a time.
function newIndex() {
  return { byTag: new Map(), byId: new Map(), byClass: new Map(), byAttr: new Map(), root: newBucket(), universal: newBucket() };
}
function newBucket() { return { plain: [], byAnc: new Map() }; }
function bucketFor(idx, term) {
  let map;
  if (term.kind === 'class')     map = idx.byClass;
  else if (term.kind === 'id')   map = idx.byId;
  else if (term.kind === 'tag')  map = idx.byTag;
  else if (term.kind === 'attr') map = idx.byAttr;
  else if (term.kind === 'root') return idx.root;
  else if (term.kind === 'none') return null;               // a pseudo-element subject: no element matches
  else return idx.universal;
  let b = map.get(term.key);
  if (b === undefined) map.set(term.key, b = newBucket());
  return b;
}
function bucketPush(bucket, rule, item) {
  const anc = rule.anc;
  if (!anc) { bucket.plain.push(item); return; }
  let l = bucket.byAnc.get(anc[0]);
  if (l === undefined) bucket.byAnc.set(anc[0], l = []);
  l.push(item);
}
// Walk one bucket: the plain items, then each ancestor group whose bit the element's ancestor
// bloom has. The bloom is resolved lazily, once per `walkIndex` (WALK.bits) — most walks never
// need it. `pairs` says the items are `[rule, captured]` pairs (the per-property layout index)
// rather than rules: the callback is called with both, without an adapter closure — this is the
// hottest loop in the driver (a layout pass is mostly these reads).
const WALK = { el: null, bits: null };
function walkBucket(bucket, cb, pairs) {
  const plain = bucket.plain;
  if (pairs) for (let i = 0; i < plain.length; i++) cb(plain[i][0], plain[i][1]);
  else       for (let i = 0; i < plain.length; i++) cb(plain[i]);
  if (bucket.byAnc.size === 0) return;
  const bits = WALK.bits || (WALK.bits = ancestorBloom(WALK.el));
  for (const entry of bucket.byAnc) {
    const h = entry[0];
    if ((bits[(h >>> 5) & (ANC_BLOOM_WORDS - 1)] & (1 << (h & 31))) === 0) continue;
    const list = entry[1];
    if (pairs) for (let i = 0; i < list.length; i++) cb(list[i][0], list[i][1]);
    else       for (let i = 0; i < list.length; i++) cb(list[i]);
  }
}
// Every bucket of `idx` that `el`'s own identifiers select, in the order tag → id → classes →
// attributes → root (for the document element) → universal. Re-entrant reads (a `var()` lookup
// inside a callback) restart the walk state for the inner element, so it is saved and restored.
function walkIndex(idx, el, cb, pairs) {
  const outerEl = WALK.el, outerBits = WALK.bits;
  WALK.el = el; WALK.bits = null;
  try {
    const tagB = idx.byTag.get(el._tag);
    if (tagB) walkBucket(tagB, cb, pairs);
    const idAttr = el._attrs.id;
    if (idAttr) {
      const idB = idx.byId.get(idAttr);
      if (idB) walkBucket(idB, cb, pairs);
    }
    for (const c of classes(el)) {
      const cB = idx.byClass.get(c);
      if (cB) walkBucket(cB, cb, pairs);
    }
    if (idx.byAttr.size) {
      // Attribute keys are case-preserved on non-HTML elements (`viewBox`) and the bucket key is
      // lowercase, so a name that differs only in case is tried folded too.
      for (const name in el._attrs) {
        let aB = idx.byAttr.get(name);
        if (aB === undefined && /[A-Z]/.test(name)) aB = idx.byAttr.get(name.toLowerCase());
        if (aB) walkBucket(aB, cb, pairs);
      }
    }
    if ((idx.root.plain.length || idx.root.byAnc.size) && el._parent && el._parent.nodeType === NODE_DOC) walkBucket(idx.root, cb, pairs);
    walkBucket(idx.universal, cb, pairs);
  } finally {
    WALK.el = outerEl; WALK.bits = outerBits;
  }
}

function buildRuleIndex(rules) {
  const idx = newIndex();
  for (const r of rules) {
    const bucket = bucketFor(idx, r.term);
    if (bucket) bucketPush(bucket, r, r);
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
  // `:disabled` / `:enabled` also read form-associatedness off the custom-element REGISTRY
  // (`isFormAssociatedCustomElement`), which is why `customElements.define` of a
  // form-associated class moves the cascade version (custom-elements.js).
  'disabled', 'enabled', 'required', 'optional', 'read-only', 'read-write', 'link', 'any-link',
  'visited', 'lang',
  // matcher-CONSTANT: the driver has no pressed-state model, so `isActive` (selectors.js) is
  // `() => false` and an `:active` rule's match can never change — classifying it dynamic cost a
  // whole-document relayout per focus/hover change on any page shipping one such rule (EasyMDE's
  // `.easymde-dropdown:active …` put it on every Avo page). If a pressed model is ever added,
  // this entry must leave with it.
  'active',
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
  const raw = rule.selectorText || '';
  const sel = raw.indexOf('\\') === -1 ? raw : raw.replace(/\\./g, '');
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
  walkIndex(idx, el, cb, false);
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
    if (term.kind === 'none') continue;          // a pseudo-element subject: no element matches
    for (const prop in cap) {
      const c = own(cap, prop);
      // Falsy-but-defined is skipped too — the exact contract the old lazy filter had; every
      // producer stores a truthy record today, so this is future-proofing, not behavior.
      if (!c) continue;
      let sub = idx.get(prop);
      if (sub === undefined) idx.set(prop, sub = newIndex());
      bucketPush(bucketFor(sub, term), r, [r, c]);
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
  walkIndex(sub, el, cb, true);
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
    // An inline `width: var(--x)` consumes a custom property in a box-moving position, and an
    // inline `--x: var(--y)` adds a substitution EDGE — either way a reference the sheet-side
    // reachability scan (`layoutReachableCustomProps`) cannot see. One sighting permanently
    // widens the dynamic-layout classification back to "every custom property"
    // (`inlineVarLayoutSeen`); sticky, so the classification only ever widens and needs no
    // invalidation of its own. (Custom-prop declarations are included conservatively rather
    // than checked against the reachable set: this parse can run before the first cascade
    // rebuild, and its result is cached on the attribute string.)
    if (!inlineVarLayoutSeen && (prop.startsWith('--') || !PAINT_ONLY_PROPS.has(prop)) &&
        typeof folded === 'string' && folded.indexOf('var(') !== -1) {
      inlineVarLayoutSeen = true;
      deriveDynamicLayoutState();                  // the custom-property-only rules join the working set
    }
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
// `dv` (optional): an already-opened declared-value entry for `el` — the layout pass reads
// ~17 properties per element back-to-back, and opening the entry once per element instead of
// per property is the point (see declaredValueEntry). `undefined` = open per read, as ever;
// `null` (a refused entry) is valid too — those reads compute uncached.
export function resolveLayoutProp (el, prop, basis = null, info = null, dv = undefined) {
  // The same logical/physical merge `cascadedProperty` does: a page that positions with
  // `inset-block` or sizes with `inline-size` has to lay out as the browser does, not as if
  // nothing were declared. Read through `declaredValue` so a `var()` — and the pending slot an
  // `inset: var(--i)` shorthand occupies — resolves here exactly as it does for getComputedStyle.
  // The UA STYLESHEET sits below the author cascade and above the initial value, and
  // it carries real geometry: a `<td>`'s 1px padding is in every column width a
  // browser reports. Reading it here (rather than only in getComputedStyle) is what
  // keeps the two answers the same value — ONE geometry means one value resolution.
  const raw = (dv !== undefined ? declaredValueIn(dv, el, prop) : declaredValue(el, prop)) ?? uaDefault(el, prop);
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
  // A CSS-wide keyword is none of the above, and the cascade hands it through verbatim — so it has
  // to be resolved where computed values are resolved, or the two sides disagree about the same
  // box. Reached only for a value that parsed as no length at all, which a real one never is.
  if (raw != null && isCssWideKeyword(raw)) {
    const resolved = cssWideComputed(el, prop);
    const rpx = parsePx(resolved);
    if (rpx != null) return rpx;
    const rpct = parsePercent(resolved);
    if (rpct != null) {
      if (info) info.percent = true;
      return basis != null ? rpct * basis : null;
    }
    return null;
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
// declaredValue memo: (the rule set, the element's structural context), with the
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
  if (documentRules.length === 0 && !inline && !(shadowHide && shadowHide.length) &&
      !(enclosingRoot && el._attrs && el._attrs.part)) return hidden;
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
  // …and the OUTER tree's `::part()` rules, which reach in past the encapsulation gate above.
  // Already matched, so no `safeMatches` (see partRulesForEl).
  const partHide = enclosingRoot
    ? partRulesForEl(el, 'hide', (r) => r.display != null || (!ignoreVisibility && r.visibility != null))
    : null;
  if (partHide) {
    for (const { rule: r, outerness } of partHide) {
      // Through `partWins` like every other property: `display` and `visibility` sort on CONTEXT
      // too, and running them through the bare ladder gave them the OPPOSITE answer to everything
      // else — an outer `!important` beating an inner one, and an outer normal losing to the
      // part's inline style (both Chrome-verified backwards). This reaches Capybara's visibility
      // predicate, not just getComputedStyle.
      const pick = (best, value, important) => {
        const ctx = partWins(best, outerness, important);
        if (ctx === false) return best;
        if (ctx === null && !winsCascade(best, r, value === 'display')) return best;
        return { value: value === 'display' ? r.display : r.visibility,
                 important, spec: r.spec, source: r.source, layerRank: r.layerRank,
                 partOuterness: outerness };
      };
      if (r.display != null) bestD = pick(bestD, 'display', r.displayImp);
      if (!ignoreVisibility && r.visibility != null) bestV = pick(bestV, 'visibility', r.visibilityImp);
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
  // Shadow ENCAPSULATION, the same gate `computeMatchesAnyHideRule` applies: an element inside a
  // shadow tree is not matched by document-scope author rules. Without it a page-level
  // `.inv { display: none }` reached into every shadow tree using the class, and
  // `getComputedStyle(el).display` said `none` while the box was still laid out 18 tall — the two
  // halves of ONE geometry disagreeing (Chrome: `block`).
  const encapsulated = globalThis.__csimShadowHostCount ? !!enclosingShadowRootOf(el) : false;
  // The `hasVisibilityRule` gate is visibility-only (display has no such fast-path flag).
  if (!encapsulated && state.hideRules.length && (isDisplay || state.hasVisibilityRule)) {
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
  // …and the outer tree's `::part()` rules — already matched, so no `safeMatches` here, and
  // sorted on CONTEXT first (see the same branch in computeMatchesAnyHideRule).
  const partHide = partRulesForEl(el, 'hide', (r) => r[prop] != null);
  if (partHide) {
    for (const { rule: r, outerness } of partHide) {
      const ctx = partWins(best, outerness, r[imp]);
      if (ctx === false) continue;
      if (ctx === null && !winsCascade(best, r, isDisplay)) continue;
      best = { value: r[prop], important: r[imp], spec: r.spec, source: r.source,
               layerRank: r.layerRank, partOuterness: outerness };
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
function cascadedRecord(el, prop) {
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
  // `::part()` — the one way an OUTER tree's rule reaches INTO this one, so it is collected even
  // though the element is encapsulated from that tree's ordinary rules above. Already matched
  // (host and trailing pseudo-classes both), hence no `safeMatches` here. `partWins` sorts it on
  // CONTEXT before anything else: the outer tree wins a normal declaration outright, so the source
  // ladder below only decides ties WITHIN one tree.
  const partRules = encapsulated ? partRulesForEl(el, 'layout', (r) => !!own(r.captured, prop)) : null;
  if (partRules) {
    for (const { rule: r, outerness } of partRules) {
      const cap = own(r.captured, prop);
      const ctx = partWins(best, outerness, cap.important);
      if (ctx === false) continue;
      if (ctx === null && !winsProp(best, r.spec, r.source, cap.important, r.layerRank)) continue;
      best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source,
               layerRank: r.layerRank, order: cap.order, partOuterness: outerness };
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

// The declaredValue / hide memos' generation: the RULE SET only (cascadeVersion, which every
// stylesheet, CSSOM and adopted-sheet change moves). An element's own declared value does not
// depend on "some DOM mutation happened somewhere" — that is its structural CONTEXT (its own + its
// ancestors' attributes and child lists), which `ctxEpochOf` below tracks per element. Nor does a
// CACHED value depend on dynamic style state (focus / hover / checkedness / value / `:defined` …):
// a read that so much as considered a dynamic-pseudo rule is tainted and never memoised
// (`noteDynamic`), and the compute reads no such state outside a selector. So
// `styleStateGeneration` is deliberately NOT in this key — when it was, every keystroke and focus
// change cold-started the memo for every element on the page (31 % of all memo entries on a
// Discourse subset were re-creations for that reason alone), guarding nothing the taint doesn't.
const STYLE_EPOCH = { cv: -1, value: 0 };
export function cascadeStyleEpoch () {
  ensureCascadeFresh();
  const cv = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
  if (cv !== STYLE_EPOCH.cv) {
    STYLE_EPOCH.cv = cv;
    STYLE_EPOCH.value = (STYLE_EPOCH.value + 1) | 0;
  }
  return STYLE_EPOCH.value;
}

// The epoch LAYOUT keys its memos on: the rule set, plus the dynamic style state only when a
// dynamic rule on this page can actually move a box (see `collectDynamicLayoutRules`). Keyed on
// the rule set alone it never invalidated at all — `#t:placeholder-shown { width: 300px }` kept its
// 300px box after the field was filled, through `getBoundingClientRect` as much as the CSSOM —
// and keyed on the state unconditionally every keystroke relaid out the document.
const LAYOUT_EPOCH = { cv: -1, ss: -1, value: 0 };
export function cascadeLayoutEpoch () {
  ensureCascadeFresh();
  const cv = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
  // Dynamic state enters the epoch only where the scoped hook above cannot stand in for it:
  // shadow sheets (not indexed) and a selector we could not parse. Everything else — keyless
  // subjects and custom-property-only rules included — is handled per-element by
  // __csimApplyScopedStateDirty at ensureLayout entry.
  const ss = (globalThis.__csimShadowHostCount ||
              (state.hasDynamicLayoutRule && state.dynStateEpochFallback && dynamicLayoutRulesArmed()))
    ? styleStateGeneration() : 0;
  if (cv !== LAYOUT_EPOCH.cv || ss !== LAYOUT_EPOCH.ss) {
    LAYOUT_EPOCH.cv = cv; LAYOUT_EPOCH.ss = ss;
    LAYOUT_EPOCH.value = (LAYOUT_EPOCH.value + 1) | 0;
  }
  return LAYOUT_EPOCH.value;
}
// Diagnostic: the epoch value itself, so a spec can assert that dynamic state does (or does not)
// reach layout — a geometry read can't distinguish "memo survived" from "recomputed equal".
globalThis.__csimLayoutEpoch = () => cascadeLayoutEpoch();
// Same for the declared-value memo's key: a spec can pin that focus / typing leave it alone and
// a rule-set change moves it.
globalThis.__csimStyleEpoch = () => cascadeStyleEpoch();

// ── structural context ─────────────────────────────────────────────────────────────────────
// The element's structural-context epoch: an order-sensitive integer hash over three mutation
// counters (mutation-observer.js moves them):
//   - its OWN `_selEpoch`   — own attributes and child list / text (what its own compound, `:empty`
//                             and its positional pseudo-classes read);
//   - its PARENT's `_kidsEpoch` — the parent's child list and the siblings' attributes (what `:nth-*`,
//                             `+` / `~` read);
//   - every ANCESTOR's `_descEpoch` — the changes on that ancestor that can reach the declared
//                             values of its descendants.
// The third is the one that is GATED (`ctxAttrEffect`): an attribute write on an ancestor moves its
// `_descEpoch` only when some rule reads that identifier in a NON-subject compound with a subject
// it can't scope, or can change a custom property descendants substitute; a scopable ancestor rule
// instead re-keys exactly the elements matching its subject (`queueCtxSweep`), and custom-property
// substitutions carry per-name generations (`varGen`) the memo validates on hit. Before this the
// chain hashed `_selEpoch` alone, bumped on the element AND its parent for every attribute write —
// `<html style="--header-offset: …">` / `<html class>` toggles re-keyed every element on a Discourse
// page (91 % of all memo entry re-creations came from a child's attribute bumping its parent).
// Everything else a static selector can read is covered elsewhere: rules via cascadeVersion,
// dynamic pseudo-classes via the taint counter, and the one DOWNWARD-looking pseudo (`:has()`) via
// `ctxUnsafeReadSeq` below. Memoised per (element, settleGen) so a read burst between mutations
// walks each chain once. The chain crosses shadow boundaries (ShadowRoot._parent is the host) —
// and a page with a shadow host takes the ungated path throughout (`:host-context`, `::slotted`
// read across it); shadow-SIDE slot mutations move nothing on a light child's chain, which is why
// the memos refuse slottable candidates outright (hideMemoFor).
// The stamp carries a realm token besides the generation: `_ctxGen` lives on the (cross-realm
// shared) element, but each realm counts its own settleGen from 0 — two realms' counters can
// collide numerically, and a parent-realm stamp must never satisfy a child-realm read.
const CTX_REALM_TOKEN = {};
export function ctxEpochOf(el) {
  if (CTX_SWEEPS.length) flushCtxSweeps();
  // Memoised per (settleGen, parser tree generation): the parser moves the counters without
  // moving settleGen, and a mid-parse read must not keep a context the next parsed sibling moved.
  const gen = globalThis.__settleGenGet ? globalThis.__settleGenGet() : 0;
  const pgen = globalThis.__csimParserTreeGen ? globalThis.__csimParserTreeGen() : 0;
  if (el._ctxTok === CTX_REALM_TOKEN && el._ctxGen === gen && el._ctxPGen === pgen) return el._ctxVal;
  let h = (el._selEpoch || 0) + 1;
  const p = el._parent;
  if (p) h = (Math.imul(h, 31) + (p._kidsEpoch || 0) + 1) | 0;
  for (let n = p; n; n = n._parent) {
    h = (Math.imul(h, 31) + (n._descEpoch || 0) + 1) | 0;
  }
  el._ctxTok = CTX_REALM_TOKEN;
  el._ctxGen = gen;
  el._ctxPGen = pgen;
  el._ctxVal = h;
  return h;
}

// What a selector reads of which compound, computed at PARSE time (it rides the sheet cache):
//   sub        — identifier tokens in the SUBJECT compound ('.c' / '#i' / '[attr'), for the
//                custom-property gens;
//   anc        — tokens in the other compounds: [token, subjectKey-or-null];
//   sibling    — a sibling combinator appears (an `anc` sweep scopes to the parent);
//   kids       — tokens in a compound LEFT of a sibling combinator (the parent's `_kidsEpoch`);
//   kidsDeep   — …and that combinator's right side is not the subject (the siblings' SUBTREES);
//   positional — a positional / `:empty` pseudo-class in a NON-subject compound (a child-list
//                change under an ancestor reaches descendants), 'sub' for subject-only;
//   unsafe     — something this gate can't place (`:nth-child(… of S)`, a nested selector list
//                with combinators, the column combinator): the writer falls back to the subtree.
// A dynamic rule (focus / hover / …) or a `:has()` rule is in here like any other: no value that
// CONSIDERED it is ever memoised, but a rule the ancestor filter rejected (`ancestorAdmits`, whose
// bloom is keyed on this very context) was never considered — the arrival of its ancestor
// identifier must re-key the subject so the bloom is rebuilt and the rule starts tainting.
// Tokens are lowercased both here and at the write, which can only merge two distinct identifiers
// into one conservative entry.
const POSITIONAL_PSEUDOS = new Set(['first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type',
  'only-of-type', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'empty']);
// STATIC pseudo-classes whose matcher reads an attribute of an ANCESTOR (inherited editability /
// language, a disabled `<fieldset>`): that attribute's change on any element reaches its subtree.
const INHERITED_ATTR_PSEUDOS = { 'disabled': ['disabled'], 'enabled': ['disabled'], 'read-only': ['contenteditable', 'disabled', 'readonly'],
  'read-write': ['contenteditable', 'disabled', 'readonly'], 'lang': ['lang'] };
function ctxFeatures(selText, captured) {
  const out = { sub: [], anc: [], sibling: false, kids: [], kidsDeep: false, positional: null, positionalSibling: 0, inherited: [], unsafe: false, names: null, attrTests: null };
  // The inherited-input names this rule's declarations can move (`declaredNames`), once at parse.
  for (const p in captured) { if (out.names === null) out.names = []; declaredNames(p, out.names); }
  if (out.names !== null && out.names.length === 0) out.names = null;
  let groups;
  try { groups = CW.parse(selText); }
  catch (_) {
    // Unparseable for css-what: name every identifier the text carries, all conservative.
    out.unsafe = true;
    const re = /\.([\w\u00a0-\uffff-]+)|#([\w\u00a0-\uffff-]+)|\[\s*([\w\u00a0-\uffff:|-]+)/g;
    let m;
    while ((m = re.exec(selText))) out.sub.push(m[1] ? '.' + m[1].toLowerCase() : m[2] ? '#' + m[2].toLowerCase() : '[' + m[3].toLowerCase().replace(/^.*[|:]/, ''));
    return out;
  }
  for (const g of groups) {
    const compounds = [[]];
    const combinatorAfter = [];               // combinatorAfter[i] = the combinator following compound i
    for (const t of g) {
      if (CW_COMBINATORS.has(t.type)) {
        if (t.type === 'column-combinator') out.unsafe = true;
        combinatorAfter.push(t.type);
        compounds.push([]);
        continue;
      }
      compounds[compounds.length - 1].push(t);
    }
    const last = compounds.length - 1;
    const subjectKey = compoundKey(compounds[last]);
    for (let ci = 0; ci <= last; ci++) {
      const isSubject = ci === last;
      const comb = combinatorAfter[ci];
      const leftOfSibling = comb === 'sibling' || comb === 'adjacent';
      if (leftOfSibling) out.sibling = true;
      // Is the subject reachable from here through sibling combinators only? If a descendant
      // combinator follows, the siblings' SUBTREES are in play.
      let deep = false;
      for (let k = ci; k < last; k++) if (combinatorAfter[k] === 'descendant' || combinatorAfter[k] === 'child' || combinatorAfter[k] === 'parent') { deep = true; break; }
      const tokens = [];
      const role = { isSubject, leftOfSibling, deep };
      if (!collectCtxTokens(compounds[ci], tokens, out, role)) out.unsafe = true;   // keep going: the tokens still have to be named
      for (const tok of tokens) {
        if (isSubject) out.sub.push(tok);
        else out.anc.push([tok, subjectKey]);
        if (leftOfSibling) { out.kids.push(tok); if (deep) out.kidsDeep = true; }
      }
      for (const t of compounds[ci]) {
        if (t.type !== 'pseudo') continue;
        const name = String(t.name).toLowerCase();
        if (POSITIONAL_PSEUDOS.has(name)) {
          if (typeof t.data === 'string' && /[.#\[]/.test(t.data)) out.unsafe = true;   // `:nth-child(… of S)`: its tokens aren't collected
          notePositional(out, role);
        }
        const inh = INHERITED_ATTR_PSEUDOS[name];
        if (inh) for (const a of inh) out.inherited.push('[' + a);
      }
    }
  }
  return out;
}
// A positional / `:empty` pseudo-class in a compound with `role`: in a non-subject compound, or
// left of a sibling combinator, a child-list change under an ancestor reaches descendants; left of
// a sibling combinator, the element's OWN child list moves its later siblings' matching (1) — and
// their subtrees when the right side is deep (2).
function notePositional(out, role) {
  if (!role.isSubject || role.leftOfSibling) out.positional = 'anc';
  else if (!out.positional) out.positional = 'sub';
  if (role.leftOfSibling) out.positionalSibling = Math.max(out.positionalSibling, role.deep ? 2 : 1);
}
// Identifier tokens of one compound, nested selector lists included (`:not(.a)`, `:is(.a, .b)`),
// which take the compound's role (`li:not(:first-child)` in a subject is a subject-side position,
// `.e:not(:empty) + .x` a sibling-side emptiness). A nested list with a COMBINATOR has its own
// structure this flat view can't place → unsafe.
function collectCtxTokens(tokens, out, feat, role) {
  for (const t of tokens) {
    if (t.type === 'attribute') {
      const name = String(t.name).toLowerCase();
      if (name === 'class' && t.action === 'element') out.push('.' + String(t.value).toLowerCase());
      else if (name === 'id' && t.action === 'equals') out.push('#' + String(t.value).toLowerCase());
      else {
        out.push('[' + name);
        // The VALUE condition, so a write that satisfies it neither before nor after is no
        // write at all for this rule (`[style*="--aspect-ratio"] > :first-child` must not reach
        // every inline style write on the page). A bare `[name]` matches any value.
        (feat.attrTests || (feat.attrTests = [])).push(['[' + name, t.action, t.value == null ? '' : String(t.value), !!t.ignoreCase]);
      }
    } else if (t.type === 'pseudo' && t.data && typeof t.data !== 'string') {
      let ok = true;
      for (const g of t.data) {
        for (const n of g) if (CW_COMBINATORS.has(n.type)) ok = false;
        if (!collectCtxTokens(g.filter((n) => !CW_COMBINATORS.has(n.type)), out, feat, role)) ok = false;
        for (const n of g) {
          if (n.type === 'pseudo' && POSITIONAL_PSEUDOS.has(String(n.name).toLowerCase())) {
            if (ok) notePositional(feat, role);
            else feat.positional = 'anc';   // nested under a combinator: position unknown — conservative
          }
        }
      }
      if (!ok) return false;
    }
  }
  return true;
}

// ── the structural-context index ──
// Per SHEET, at parse time: token → entry, plus the sheet-wide flags a child-list change consults.
//   entry.s   (subtree)  — a write of this token re-keys the writer's subtree (unscopable);
//   entry.d   (desc)     — [subjectKey, sibling][]: sweep these subjects under the writer (or its
//                          parent);
//   entry.k / kd         — the writer's parent's `_kidsEpoch` (/ `_descEpoch`);
//   entry.n   (names)    — inherited-input names whose value can change with this token
//                          (subject-side declarations), bumped via `bumpVarGen`;
//   entry.dn             — names a swept subject declares (the sweep re-keys the subject; its
//                          descendants' substitutions need the gen);
//   entry.t / a          — the VALUE conditions an attribute-name token carries / `a`lways.
// Plain JSON: it is cached with the sheet. A document's gate (`CtxGate`) merges the entries of its
// sheets per token on first use — nothing is built per document.
function newCtxIndex() {
  return { map: Object.create(null), childListDesc: false, emptySibling: 0, names: [] };
}
function ctxIndexEntry(map, tok) {
  return map[tok] || (map[tok] = { s: false, d: null, k: false, kd: false, n: null, dn: null, t: null, a: false });
}
function pushUnique(arr, v) { if (arr.indexOf(v) === -1) arr.push(v); }
function noteCtxFeatures(index, cx) {
  const map = index.map;
  const names = cx.names;
  if (cx.unsafe) {
    // A selector this index can't place: every identifier it names is conservative (a write of it
    // re-keys the writer's subtree and its siblings'), and so are the sheet-wide flags. Only the
    // tokens it names — a selector naming none (`:is(div p) span`) can't be moved by an attribute
    // write at all.
    for (const tok of cx.sub) { const e = ctxIndexEntry(map, tok); e.s = true; e.kd = true; e.a = true; }
    for (const [tok] of cx.anc) { const e = ctxIndexEntry(map, tok); e.s = true; e.kd = true; e.a = true; }
    for (const tok of cx.kids) { const e = ctxIndexEntry(map, tok); e.s = true; e.kd = true; e.a = true; }
    index.childListDesc = true; index.emptySibling = 2;
    if (names) for (const n of names) pushUnique(index.names, n);
    return;
  }
  // Attribute-name entries remember every value condition the rules put on that attribute; a write
  // consults them with the old and new value (`attrWriteMatters`). `a` once any rule reads the
  // attribute with no condition (`[name]`, `[name!=v]`).
  if (cx.attrTests !== null) {
    for (const [tok, action, value, ic] of cx.attrTests) {
      const e = ctxIndexEntry(map, tok);
      if (action === 'exists' || action === 'not' || value === '') { e.a = true; continue; }
      (e.t || (e.t = [])).push([action, ic ? value.toLowerCase() : value, ic]);
    }
  }
  for (const tok of cx.sub) {
    if (names) { const e = ctxIndexEntry(map, tok); e.n || (e.n = []); for (const n of names) pushUnique(e.n, n); }
  }
  for (const [tok, subjectKey] of cx.anc) {
    const e = ctxIndexEntry(map, tok);
    if (subjectKey === null) { e.s = true; continue; }
    e.d || (e.d = []);
    let found = false;
    for (const pair of e.d) if (pair[0] === subjectKey) { pair[1] = pair[1] || cx.sibling; found = true; break; }
    if (!found) e.d.push([subjectKey, cx.sibling]);
    if (names) { e.dn || (e.dn = []); for (const n of names) pushUnique(e.dn, n); }
  }
  for (const tok of cx.kids) {
    const e = ctxIndexEntry(map, tok);
    e.k = true;
    if (cx.kidsDeep) e.kd = true;
    if (names) { e.n || (e.n = []); for (const n of names) pushUnique(e.n, n); }
  }
  for (const tok of cx.inherited) { const e = ctxIndexEntry(map, tok); e.s = true; e.a = true; }
  // A child-list change moves positions and sibling relations: it reaches descendants when a
  // positional pseudo sits in a non-subject compound, or a sibling combinator's right side is
  // deep (`.a ~ .d .e`: inserting the `.a` changes `.e`); and the names of any positional- or
  // sibling-keyed declaration.
  if (cx.positional === 'anc' || cx.kidsDeep) index.childListDesc = true;
  if ((cx.positional || cx.kids.length) && names) for (const n of names) pushUnique(index.names, n);
  // A sibling-keyed positional rule that DECLARES an inherited input (`.e:empty + .x { --c }`)
  // reaches the siblings' subtrees (`.x span { color: var(--c) }`): the writer's own desc bump
  // covers none of them, so the siblings' subtrees re-key.
  const sib = cx.positionalSibling === 1 && names ? 2 : cx.positionalSibling;
  if (sib > index.emptySibling) index.emptySibling = sib;
}
function attrValueMatches(action, value, ic, raw) {
  if (raw == null) return false;
  const v = ic ? String(raw).toLowerCase() : String(raw);
  switch (action) {
    case 'equals':  return v === value;
    case 'element': return (' ' + v.replace(/\s+/g, ' ') + ' ').indexOf(' ' + value + ' ') !== -1;
    case 'start':   return v.startsWith(value);
    case 'end':     return v.endsWith(value);
    case 'any':     return v.indexOf(value) !== -1;
    case 'hyphen':  return v === value || v.startsWith(value + '-');
    default:        return true;
  }
}
function attrWriteMatters(e, oldRaw, newRaw) {
  if (e.a || e.t === null) return true;
  for (const [action, value, ic] of e.t) {
    if (attrValueMatches(action, value, ic, oldRaw) || attrValueMatches(action, value, ic, newRaw)) return true;
  }
  return false;
}
// A document's gate: its sheets' indexes, merged per token on first lookup. Built at rebuild from
// the sheet list alone (O(sheets)); the merged entries accumulate as the page writes.
class CtxGate {
  constructor(sheets) {
    this.indexes = [];
    this.childListDesc = false; this.emptySibling = 0;
    const names = new Set();
    for (const { sheet: sh } of sheets) {
      const ix = sh.cxIndex;
      if (ix === undefined) { this.unsafe = true; continue; }   // a sheet parsed before this index existed
      if (this.indexes.indexOf(ix) === -1) this.indexes.push(ix);
      if (ix.childListDesc) this.childListDesc = true;
      if (ix.emptySibling > this.emptySibling) this.emptySibling = ix.emptySibling;
      for (const n of ix.names) names.add(n);
    }
    this.names = names.size ? names : null;
    this.merged = Object.create(null);
  }
  // The merged entry for `tok`, or undefined when no sheet names it.
  get(tok) {
    let e = this.merged[tok];
    if (e !== undefined) return e === null ? undefined : e;
    e = null;
    for (const ix of this.indexes) {
      const f = ix.map[tok];
      if (f === undefined) continue;
      if (e === null) e = { s: false, d: null, k: false, kd: false, n: null, dn: null, t: null, a: false };
      if (f.s) e.s = true;
      if (f.k) e.k = true;
      if (f.kd) e.kd = true;
      if (f.a) e.a = true;
      if (f.d) { e.d || (e.d = []); for (const [key, sib] of f.d) { let hit = false; for (const pair of e.d) if (pair[0] === key) { pair[1] = pair[1] || sib; hit = true; break; } if (!hit) e.d.push([key, sib]); } }
      if (f.n) { e.n || (e.n = []); for (const n of f.n) pushUnique(e.n, n); }
      if (f.dn) { e.dn || (e.dn = []); for (const n of f.dn) pushUnique(e.dn, n); }
      if (f.t) { e.t || (e.t = []); for (const t of f.t) e.t.push(t); }
    }
    this.merged[tok] = e;
    return e === null ? undefined : e;
  }
}
// The gate, or null when it cannot answer: no cascade yet / a pending rebuild (the next read
// builds it; a write in between must stay conservative), or a page with a shadow host (shadow
// sheets are not in this map, and `:host-context` / `::slotted` read across the boundary).
function ctxGateReady() {
  // A pending sheet change answers "unknown" until the next read rebuilds (deliberately NOT
  // rebuilt here: a page boot inserts sheets while the framework writes thousands of attributes,
  // and rebuilding at the write multiplied the rebuilds — while the conservative answer costs
  // nothing then, there being no memo entries yet to lose).
  if (cascadeStale) return null;
  if (globalThis.__csimShadowHostCount) return null;
  let gate = state.ctxGate;
  if (gate === undefined) {
    gate = new CtxGate(state.sheets);
    state.ctxGate = gate.unsafe ? null : gate;
    state.ctxChildListDesc = gate.unsafe || gate.childListDesc;
    state.ctxEmptySibling = gate.unsafe ? 2 : gate.emptySibling;
    state.ctxChildListVarNames = gate.names;
    gate = state.ctxGate;
  }
  return gate;
}

// ── inherited-input generations ──
// A memoised value that SUBSTITUTED `var(--x)` recorded `--x` (style-proxy `declaredValueIn`); the
// memo re-validates it against this generation on every hit. Moved by whatever can change an
// element's declared `--x` without moving the reader's own context: an inline style naming it, a
// write of an identifier a subject-side `--x` declaration reads, a swept ancestor rule declaring it,
// a child-list change under a positional `--x` rule.
// Three INHERITED inputs of a declared value that are not custom properties ride the same
// generations under reserved names: `@font-size` (a `calc()` `em` / `rem` / `ch` / `ex` basis),
// `@font-family` (`ch` / `ex` read the face), `@flow` (the flow-relative twin a physical property
// resolves through — `margin-top` vs `margin-block-start` — depends on inherited direction /
// writing-mode). `declaredNames` maps what a declaration SETS to the names it can move.
const VAR_GEN = new Map();
export function varGen(name) { const g = VAR_GEN.get(name); return g === undefined ? 0 : g; }
// …and one counter over all of them, so a memo hit pays for the per-name check only after SOME
// name moved since the entry last looked (style-proxy `declaredValueIn`).
let varGenTotal = 0;
export function varGenTotalNow() { return varGenTotal; }
export function bumpVarGen(name) { VAR_GEN.set(name, (varGen(name) + 1) | 0); varGenTotal = (varGenTotal + 1) | 0; }
function declaredNames(prop, into) {
  if (prop.startsWith('--')) into.push(prop);
  else if (prop === 'font') into.push('@font-size', '@font-family');
  else if (prop === 'font-size') into.push('@font-size');
  else if (prop === 'font-family' || prop === 'font-weight' || prop === 'font-style' || prop === 'font-stretch') into.push('@font-family');   // the FACE `ch`/`ex` measure
  else if (prop === 'direction' || prop === 'writing-mode') into.push('@flow');
}
const CUSTOM_PROP_NAME_RE = /--[\w\u00a0-\uffff-]+/g;
// The names an inline style TEXT can move (the declarations themselves are not parsed here — a
// `font` / `direction` substring is enough to be conservative).
function bumpVarGensIn(text) {
  if (!text) return;
  if (text.indexOf('--') !== -1) {
    CUSTOM_PROP_NAME_RE.lastIndex = 0;
    let m;
    while ((m = CUSTOM_PROP_NAME_RE.exec(text))) bumpVarGen(m[0]);
  }
  if (text.indexOf('font') !== -1) { bumpVarGen('@font-size'); bumpVarGen('@font-family'); }
  if (text.indexOf('direction') !== -1 || text.indexOf('writing-mode') !== -1) bumpVarGen('@flow');
}
// The dependency frame of the memoising compute in progress (style-proxy `declaredValueIn` opens
// one around `computeDeclaredValue`): `undefined` = no frame (a name read here is nobody's to
// record), `null` = open and empty, a Set = the names read so far — allocated only once a compute
// actually reads one. Nested frames hand their names up when they close, so `width: var(--a)` over
// `--a: var(--b)` depends on both.
// The frame records name → the generation AS READ, so a bump that landed after the read (inside
// the same compute) can never be snapshotted as current.
let DEP_FRAME;
export function noteDep(name) {
  if (DEP_FRAME === undefined) return;
  if (DEP_FRAME === null) DEP_FRAME = new Map();
  if (!DEP_FRAME.has(name)) DEP_FRAME.set(name, varGen(name));
}
export function depFrameOpen() { return DEP_FRAME !== undefined; }
export function openDepFrame() { const outer = DEP_FRAME; DEP_FRAME = null; return outer; }
// Closes the frame, returns its names (or null), restores — and merges — the outer one.
export function closeDepFrame(outer) {
  const mine = DEP_FRAME;
  if (mine !== null && outer != null) { for (const [n, g] of mine) if (!outer.has(n)) outer.set(n, g); DEP_FRAME = outer; }
  else if (mine !== null && outer === null) DEP_FRAME = mine;   // the outer frame was open and empty: it is these now
  else DEP_FRAME = outer;
  return mine;
}

// ── the writers ──
// Conservative: the whole subtree and the siblings' subtrees (what every write did before the gate).
export function bumpCtxAll(el) {
  el._selEpoch  = (el._selEpoch  || 0) + 1;
  el._kidsEpoch = (el._kidsEpoch || 0) + 1;
  el._descEpoch = (el._descEpoch || 0) + 1;
  const p = el._parent;
  if (p) { p._kidsEpoch = (p._kidsEpoch || 0) + 1; p._descEpoch = (p._descEpoch || 0) + 1; }
}
// An inserted node: its own chain is new (`_selEpoch`, so a moved element's entry can't collide
// with the one keyed under its old parent) and so is its descendants' (`_descEpoch`).
export function bumpCtxInserted(el) {
  el._selEpoch  = (el._selEpoch  || 0) + 1;
  el._descEpoch = (el._descEpoch || 0) + 1;
}
// A child-list change on `el`: its own `:empty`, its children's positions, and — only when some
// rule reads a position / emptiness in a non-subject compound — its descendants; its own siblings
// when `:empty` sits left of a sibling combinator somewhere.
export function ctxChildListEffect(el) {
  el._selEpoch  = (el._selEpoch  || 0) + 1;
  el._kidsEpoch = (el._kidsEpoch || 0) + 1;
  const gate = ctxGateReady();
  // A disabled `<fieldset>`'s FIRST `<legend>` is exempt from the disabling — which legend is
  // first is its child list.
  if (gate === null || state.ctxChildListDesc || (el._tag === 'fieldset' && gate.get('[disabled') !== undefined)) {
    el._descEpoch = (el._descEpoch || 0) + 1;
  } else {
    // Nothing under the children is re-keyed, so what a positional- or sibling-keyed declaration
    // (`li:first-child { --x }`, `.e:empty + .x { --x }`) can still reach — a descendant's
    // substitution — goes by name.
    // (Under a desc bump those descendants recompute anyway; bumping the names then would only
    // revalidate every dependent value on the page.)
    const names = state.ctxChildListVarNames;
    if (names) for (const n of names) bumpVarGen(n);
  }
  siblingsOfEmptiness(el, gate);
}
// `el`'s emptiness / child positions changed: its siblings (`.e:empty + .x`) and, when such a rule
// reaches past the sibling (`.e:empty ~ .d .x`), their subtrees.
function siblingsOfEmptiness(el, gate) {
  const p = el._parent;
  if (!p) return;
  const mode = gate === null ? 2 : state.ctxEmptySibling;
  if (mode === 2) { p._kidsEpoch = (p._kidsEpoch || 0) + 1; p._descEpoch = (p._descEpoch || 0) + 1; }
  else if (mode === 1) p._kidsEpoch = (p._kidsEpoch || 0) + 1;
}
// A character-data change under `el` (`:empty`): same as a child-list change minus the positions.
export function ctxCharDataEffect(el) {
  el._selEpoch = (el._selEpoch || 0) + 1;
  const gate = ctxGateReady();
  if (gate === null || state.ctxChildListDesc) el._descEpoch = (el._descEpoch || 0) + 1;
  siblingsOfEmptiness(el, gate);
}
// An attribute write on `el`: always its own context; the rest as the gate decides.
export function ctxAttrEffect(el, lkey, oldRaw, newRaw) {
  el._selEpoch = (el._selEpoch || 0) + 1;
  const gate = ctxGateReady();
  const p = el._parent;
  if (gate === null || el._shadowRoot) {
    el._descEpoch = (el._descEpoch || 0) + 1;
    if (p) { p._kidsEpoch = (p._kidsEpoch || 0) + 1; p._descEpoch = (p._descEpoch || 0) + 1; }
    return;
  }
  let desc = false, kids = false, kidsDeep = false, sweep = null, names = null;
  const consider = (tok, oldV, newV) => {
    const e = gate.get(tok);
    if (e === undefined) return;
    if (tok[0] === '[' && !attrWriteMatters(e, oldV, newV)) return;
    if (e.s) desc = true;
    if (e.k) kids = true;
    if (e.kd) kidsDeep = true;
    if (e.d) { if (!sweep) sweep = new Map(); for (const [key, sibling] of e.d) sweep.set(key, (sweep.get(key) || false) || sibling); }
    if (e.n) { if (!names) names = new Set(); for (const n of e.n) names.add(n); }
    if (e.dn) { if (!names) names = new Set(); for (const n of e.dn) names.add(n); }
  };
  // `[class*=…]` / `[id^=…]` / `[style]` read the attribute as a whole: the attribute-name token too.
  if (lkey === 'class') {
    const a = String(oldRaw || '').split(/\s+/), b = String(newRaw || '').split(/\s+/);
    const sa = new Set(a), sb = new Set(b);
    for (const t of sa) if (t && !sb.has(t)) consider('.' + t.toLowerCase());
    for (const t of sb) if (t && !sa.has(t)) consider('.' + t.toLowerCase());
    consider('[class', oldRaw, newRaw);
  } else if (lkey === 'id') {
    if (oldRaw) consider('#' + String(oldRaw).toLowerCase());
    if (newRaw) consider('#' + String(newRaw).toLowerCase());
    consider('[id', oldRaw, newRaw);
  } else if (lkey === 'style') {
    // Inline style is the element's own declaration; what can reach a descendant is an inherited
    // input — a custom property it substitutes, a font metric, the flow.
    bumpVarGensIn(oldRaw); bumpVarGensIn(newRaw);
    consider('[style', oldRaw, newRaw);
  } else if (lkey === 'dir') {
    bumpVarGen('@flow');                    // inherited directionality, read off the attribute directly
    consider('[dir', oldRaw, newRaw);
  } else {
    const local = lkey.indexOf(':') === -1 ? lkey : lkey.slice(lkey.lastIndexOf(':') + 1);
    consider('[' + local, oldRaw, newRaw);
  }
  if (desc) el._descEpoch = (el._descEpoch || 0) + 1;
  if (p) {
    if (kidsDeep) { p._kidsEpoch = (p._kidsEpoch || 0) + 1; p._descEpoch = (p._descEpoch || 0) + 1; }
    else if (kids) p._kidsEpoch = (p._kidsEpoch || 0) + 1;
  }
  // A sweep is a selector-list match over the subtree — cheap next to what re-keying it costs
  // (every descendant recomputing ~24 declared values), so only an absurd list falls back.
  // Discourse's `html.discourse-no-touch` toggle alone names 58 subjects.
  if (sweep && !desc && !kidsDeep) {
    if (sweep.size > CTX_SWEEP_MAX) el._descEpoch = (el._descEpoch || 0) + 1;
    else CTX_SWEEPS.push({ root: el, sweep });
  }
  if (names) for (const n of names) bumpVarGen(n);
}
const CTX_SWEEP_MAX = 256;
// Pending sweeps, applied at the next context read (`ctxEpochOf`) — a run of writes between
// reads costs one traversal per write, never per read, and the matched elements' `_selEpoch`
// moves before any of them is keyed.
const CTX_SWEEPS = [];
function flushCtxSweeps() {
  const pending = CTX_SWEEPS.splice(0);
  for (const { root, sweep } of pending) {
    let own = null, parent = null;
    for (const [key, sibling] of sweep) {
      if (sibling) (parent || (parent = [])).push(key); else (own || (own = [])).push(key);
    }
    if (own) sweepUnder(root, own);
    if (parent) sweepUnder(root._parent || root, parent);
  }
}
function sweepUnder(scope, keys) {
  if (!scope || typeof scope.querySelectorAll !== 'function') { if (scope) scope._descEpoch = (scope._descEpoch || 0) + 1; return; }
  let found;
  try { found = scope.querySelectorAll(keys.join(',')); }
  catch (_) { scope._descEpoch = (scope._descEpoch || 0) + 1; return; }
  ctxSweepCount++;
  for (const el of found) { el._selEpoch = (el._selEpoch || 0) + 1; el._ctxGen = -1; }
}
// Diagnostics for the specs: is the gate answering, how many sweeps ran, an element's context.
let ctxSweepCount = 0;
globalThis.__csimCtxGateActive = () => ctxGateReady() !== null;
globalThis.__csimCtxSweeps = () => ctxSweepCount;
globalThis.__csimCtxEpoch = (el) => ctxEpochOf(el);

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
  const prevActive = deref(lastActive), prevHover = deref(lastHover);
  if (active !== prevActive || fv !== lastFocusVisible) {
    lastActive = weak(active); lastFocusVisible = fv;
    // The hint names what moved: the focus family, on the element that lost focus and the one
    // that gained it (`:focus-within` and the ancestor scoping are the sweep's job).
    bumpStyleState({ kinds: FOCUS_KINDS, elements: [prevActive, active] });
  }
  if (hover !== prevHover) {
    lastHover = weak(hover);
    bumpStyleState({ kinds: HOVER_KINDS, elements: [prevHover, hover] });
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
  noteDep('@flow');   // which twin is even asked about depends on the INHERITED flow (structural-context gate)
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
    // `anc` describes the ORIGINAL selector, and this rewrites the text — so it, and every other
    // field derived from that text (the dynamic-selector verdict, the pseudo-element subject, the
    // dynamic-layout data), is dropped rather than carried; the accessors re-derive from `sel`.
    // Every routed rule is a single whole-selector functional pseudo today, which collects nothing
    // anyway; making that explicit is what keeps a later rewrite from shipping an ancestor
    // requirement — or a dynamic verdict — that belongs to a different selector.
    const rewritten = { ...rule, selectorText: sel, anc: null, source: rule.source + serial,
                        __dynamicSel: undefined, __subjPE: undefined, dynReqs: undefined, dynSubs: undefined };
    if (rule.__hideRule) bucketHide.push(rewritten);
    else                 bucketLayout.push(rewritten);
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

// ── CSS Shadow Parts (`::part()`) ────────────────────────────────────────────────────────────
// The mirror image of `::slotted()`: a `::part()` rule lives in the OUTER tree and styles an
// element INSIDE the shadow tree its subject hosts. `X::part(a b)` matches a shadow-tree element
// whose `part` attribute carries EVERY listed name — order irrelevant, like classes — when `X`
// matches that element's host.
//
// Parts are visible to the DIRECT parent tree only; a host's `exportparts` forwards names one
// level further out, optionally renaming them (`inner: outer`), which is what makes a part of a
// nested component stylable from the page. A name that is not forwarded stops there, and that
// scoping is the whole point of the feature.
//
// Trailing pseudo-CLASSES apply to the part (`X::part(tab):hover` is the tab hovered, not the
// host). A second `::part()` never matches — it would expose more structure than parts are meant
// to — and neither does a trailing pseudo-ELEMENT, which we do not model on parts.
const PART_RE = /::part\(/i;
// Rewrite the `:host` forms in a HOST-POSITION selector into something matchable against the host
// ELEMENT: `:host` → `*`, `:host(<sel>)` → `<sel>`. `null` when nothing referenced `:host` (an
// ordinary outer-tree rule), `undefined` when a `:host(` never closes. Done by rewrite rather than
// by a string test on the whole prefix, because `:host` is not always the whole of it —
// `:host:hover`, `:host(.x):hover`, and every nested `&::part()` (which `composeNestedSelector`
// turns into `:is(:host)::part()`) reference it from inside a larger compound.
function rewriteHostPseudo(sel) {
  const lower = sel.toLowerCase();
  let out = '', pos = 0, found = false;
  for (let k = lower.indexOf(':host'); k !== -1; k = lower.indexOf(':host', pos)) {
    const after = sel[k + 5];
    if (after === '-') { out += sel.slice(pos, k + 5); pos = k + 5; continue; }   // `:host-context(`
    out += sel.slice(pos, k);
    found = true;
    if (after !== '(') { out += '*'; pos = k + 5; continue; }
    let depth = 1, j = k + 6;
    for (; j < sel.length; j++) {
      const c = sel[j];
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    if (depth !== 0) return undefined;
    out += sel.slice(k + 6, j);
    pos = j + 1;
  }
  return found ? out + sel.slice(pos) : null;
}
function splitPartSelector(selectorText) {
  const m = PART_RE.exec(selectorText);
  if (!m) return null;
  const open = m.index + m[0].length;
  let depth = 1, i = open;
  for (; i < selectorText.length; i++) {
    const c = selectorText[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) break;
  }
  if (depth !== 0) return null;                                   // unbalanced: matches nothing
  const names = selectorText.slice(open, i).trim().split(/\s+/).filter(Boolean);
  if (!names.length) return null;
  const tail = selectorText.slice(i + 1).trim();
  if (tail.indexOf('::') !== -1 || PART_RE.test(tail)) return null;
  // The prefix as WRITTEN, so a combinator before the part survives: `#wrap ::part(p)` styles the
  // parts of a host INSIDE `#wrap`, not `#wrap`'s own — the host compound there is empty, which is
  // `*`. Trimming first read it as `#wrap` and styled the wrong element's parts (Chrome
  // measured), and `.inactive > ::part(p)` became the invalid selector `.inactive >`.
  const prefix = selectorText.slice(0, m.index);
  return { host: /(^|[\s>+~])$/.test(prefix) ? prefix + '*' : prefix, names, tail };
}
// …cached on the rule, like every other selector-derived verdict.
function partSplitOf(r) {
  if (r.__part !== undefined) return r.__part;
  return (r.__part = splitPartSelector(r.selectorText || ''));
}

// The tree a node LIVES in: its shadow root, else its document.
function treeOf(node) {
  return enclosingShadowRootOf(node) || node._ownerDoc || globalThis.document;
}

// One tree's `::part()` rules, with the two selectors each one really asks about split out ahead
// of time: `hostSel` (matched against the HOST) and `partSel` (the trailing pseudo-classes,
// matched against the PART). Derived from the rules the tree already carries — a `::part()` rule
// is inert everywhere else, its subject being a pseudo-element — and cached per tree on the
// cascade version, like the other per-tree derivations.
// Keyed in a module-local WeakMap rather than on the node: a DOCUMENT is shared across realms
// while `state.layoutRules` and `cascadeVersion` are per-realm, so stamping the bucket on the node
// let one realm's rules — and its version counter, which starts at the same small integer — answer
// the other realm's reads. (`ctxEpochOf` carries a realm token for the same reason.) A WeakMap in
// this module is per-realm by construction, so the collision cannot arise.
const PART_BUCKETS = new WeakMap();
function partRulesFor(scope, kind) {
  const key = kind === 'hide' ? 'hide' : 'layout';
  let entry = PART_BUCKETS.get(scope);
  if (!entry) PART_BUCKETS.set(scope, entry = {});
  const held = entry[key];
  if (held && held.ver === cascadeVersion) return held.rules;
  const src = scope._isShadowRoot ? scopedRulesFor(scope)[kind]
            : kind === 'hide'     ? state.hideRules
                                  : state.layoutRules;
  const out = [];
  for (const r of src) {
    const p = partSplitOf(r);
    if (!p) continue;
    // A rule REFERENCING `:host` stays inside its own tree — its subject is this tree's own host,
    // so the parts it reaches are this tree's. Everything else reaches one tree IN.
    const hostPseudo = rewriteHostPseudo(p.host);
    if (hostPseudo === undefined) continue;         // `:host(` never closed: matches nothing
    const selfHost = hostPseudo !== null;
    const hostSel = selfHost ? hostPseudo : p.host;
    // `unmatchable` is CLEARED on both: the original selector carries `::part()`, which the
    // selector engine rightly refuses, so the ordinary shadow-rule walk marks the rule the first
    // time it tries it — and a copy that inherited the flag would refuse a selector (`*`, `.x`,
    // `*:hover`) that is perfectly matchable. `anc` describes the ORIGINAL selector too.
    // Everything derived from the ORIGINAL selector text is dropped, exactly as `route()` does for
    // `:host` / `::slotted`: `anc` (an ancestor requirement of a different selector), the dynamic
    // verdict and its per-rule data, and `unmatchable` — which the ordinary shadow-rule walk sets
    // the first time it tries `::part()` as a plain selector, and which would then refuse the
    // perfectly matchable `*` / `.x` / `*:hover` this rewrites to.
    const rewrite = (selectorText) => ({
      ...r, selectorText, anc: null, unmatchable: false,
      __dynamicSel: undefined, __subjPE: undefined, __part: null, dynReqs: undefined, dynSubs: undefined
    });
    out.push({
      rule:     r,
      names:    p.names,
      selfHost,
      hostRule: rewrite(hostSel),
      partRule: p.tail ? rewrite('*' + p.tail) : null
    });
  }
  entry[key] = { ver: cascadeVersion, rules: out };
  return out;
}

// Cached against the raw attribute string (the `classes()` pattern): this is read per element per
// property, and a fresh Set per read is pure garbage on a page that uses parts at all (rule 3).
function partNamesOf(el) {
  const raw = el._attrs && el._attrs.part;
  if (!raw) return null;
  if (el._partNamesKey === raw) return el._partNames;
  const names = String(raw).trim().split(/\s+/).filter(Boolean);
  el._partNamesKey = raw;
  return (el._partNames = names.length ? new Set(names) : null);
}
// `exportparts="inner: outer, x"` → the names those parts continue under one tree further out.
function forwardParts(host, names) {
  const raw = host._attrs && host._attrs.exportparts;
  if (!raw) return null;
  const out = new Set();
  // (not cached: the mapping depends on `names` as well as the attribute, and a host carrying
  // `exportparts` is rare enough that the parse is not worth a two-key memo)
  for (const entry of String(raw).split(',')) {
    const colon = entry.indexOf(':');
    const from  = (colon === -1 ? entry : entry.slice(0, colon)).trim();
    const to    = (colon === -1 ? entry : entry.slice(colon + 1)).trim();
    if (from && names.has(from) && to) out.add(to);
  }
  return out.size ? out : null;
}

// Every (host, tree, visible names) `el` is exposed through, outward from its own shadow root:
// one step for its own `part`, and one more for each `exportparts` that forwards them.
function partExposures(el) {
  let names = partNamesOf(el);
  if (!names) return null;
  let sr = enclosingShadowRootOf(el);
  const out = [];
  while (sr && names) {
    const host = sr._parent;
    if (!host || host.nodeType !== NODE_ELEMENT) break;
    out.push({ host, tree: treeOf(host), names });
    names = forwardParts(host, names);
    sr = enclosingShadowRootOf(host);
  }
  return out.length ? out : null;
}

// The `::part()` rules of the trees OUTSIDE `el`'s that actually match it — host and trailing
// pseudo-classes both checked here, so the caller must NOT re-match the (pseudo-element) selector.
// Returns the ORIGINAL rules, so their captured declarations, specificity and source order are the
// ones the cascade compares.
// `declares(rule)` is asked BEFORE any selector is matched: a tree's `::part()` rules mostly say
// nothing about the property being read, and matching them anyway cost ~2.5 us per property read
// per part element (measured, 40 rules x 10 properties — a 2x on the read) for answers that were
// then thrown away (rule 3).
function partRulesForEl(el, kind, declares) {
  // Two O(1) reads before anything is allocated: this runs per ELEMENT per PROPERTY inside a
  // shadow tree, and almost nothing carries a `part` (rule 3).
  if (!globalThis.__csimShadowHostCount) return null;
  if (!el._attrs || !el._attrs.part) return null;
  const exposures = partExposures(el);
  if (!exposures) return null;
  let out = null;
  const take = (tree, host, names, selfHost, outerness) => {
    for (const c of partRulesFor(tree, kind)) {
      if (c.selfHost !== selfHost) continue;
      let wanted = true;
      for (const n of c.names) if (!names.has(n)) { wanted = false; break; }
      if (!wanted) continue;
      if (!declares(c.rule)) continue;
      // CONSIDERED, so noted — a rule that misses now can match on hover, and the declared-value
      // memo must not cache through it. Every other cascade path notes before it matches; noting
      // here (after the NAME check, so only rules that target this part taint the read) is the
      // same contract. Without it a `::part(x):hover` rule that missed on the first read was
      // memoised away and the hover never took (Chrome-verified divergence).
      noteDynamic(c.rule);
      if (!safeMatches(host, c.hostRule)) continue;
      if (c.partRule && !safeMatches(el, c.partRule)) continue;
      // `outerness` — how many shadow boundaries out the rule lives — is the CONTEXT the cascade
      // sorts on (see partWins).
      (out || (out = [])).push({ rule: c.rule, outerness });
    }
  };
  // This tree's own `:host::part()` rules reach its own parts…
  const own = exposures[0];
  take(enclosingShadowRootOf(el), own.host, own.names, true, 0);
  // …and every tree outward sees them through its host, by the ordinary form.
  for (let i = 0; i < exposures.length; i++) {
    const e = exposures[i];
    take(e.tree, e.host, e.names, false, i + 1);
  }
  return out;
}

// CONTEXT, the cascade step css-cascade-5 puts between importance and the STYLE ATTRIBUTE: with
// declarations from different shadow trees in play, a NORMAL declaration from the OUTER tree wins
// and an `!important` one from the INNER tree does. `outerness` counts the boundaries out (0 = the
// element's own tree, which is where an inline style and the tree's own rules sit), so:
//
//   `#host::part(p) { color: green }`   beats  `style="color: red"` on the part      (outer, normal)
//   `#host::part(p) { color: green !important }`  loses to the tree's own `!important` (inner)
//
// Only when the context is EQUAL does the ordinary ladder (inline, specificity, source) decide.
function partWins(best, outerness, important) {
  if (!best) return true;
  const bo = best.partOuterness || 0;
  if (!!best.important !== !!important) return !!important;      // importance first, as ever
  if (outerness !== bo) return important ? outerness < bo : outerness > bo;
  return null;                                                   // same context: ask winsProp
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
