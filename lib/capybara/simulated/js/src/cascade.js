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
//   2. cascadeRulesOf(sheets)     — flatten → one entry per (selector,
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

import { teachStyleFaces } from './font-metrics.js';
import { NODE_ELEMENT, NODE_TEXT, NODE_DOC, NODE_FRAGMENT, HTML_NS, SVG_NS } from './constants.js';
import { LONGHANDS, INHERITED_PROPERTIES } from './css-property-data.js';

import { walk, walkSubtree, classes, scriptText, pictureSourceFor, flatTreeParent, assignedSlotFor } from './walk.js';
import { bumpStyleState, currentStyleStateGen, currentDirtySeq, currentTreeGen, bumpTreeGen } from './mutation-observer.js';
import { isStaticallyInvalidMath } from './calc.js';
import { mediaMatches, currentViewport, supportsMatches } from './media-query.js';
import { asciiLower, asciiTokens } from './ascii.js';
import { splitTopLevel, stripCssComments, decodeDataUrlCss, networkStyleSheetText, resolveCssUrls, documentBaseUrl, parseStyleDeclList, cssPropertyName, isSupportedCssPropertyName, serializeCssValue, htmlDimensionValue, htmlPixelLength, htmlInteger } from './css-utils.js';
import { declarationIsValid, isRegularShorthand, shorthandExpand, shorthandLonghands, isCssWideKeyword, hasSubstitution,
         pendingSubstitution, isCoveredByAll, isLineWidth, isLineStyle, FONT_SHORTHAND } from './shorthands.js';
import { matchesSelector, matchesSelectorNS, cssMatches } from './selectors.js';
import { maybeVerifyArena, arenaNid, hasState, STATE_FILTERED } from './native-query-shadow.js';   // native-authoritative cascade matching over the mirrored arena
import { normalizeColor, declaredValue, declaredValueIn, fontRelativeToPx, uaDefault, uaHidden, uaDisplay, inputType, uaMayConstrainSize, canonicalDisplay } from './style-proxy.js';
import { hasMathFunction, reduceMathFunctions, absoluteToPx } from './calc.js';

// The cascade is parsed AND matched without the hand-rolled selector-parser.js:
//   - css-tree (vendored) parses stylesheets + selectors, and yields
//     specificity + the rule-index terminal key from its AST;
//   - selectors.js `matchesSelector` does the matching — native first (selector.rs,
//     Servo's matcher over the arena), css-select for what native declines; the
//     timing instrument holds native against css-select alone (`cssMatches`).
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
// The index key of a rule's SUBJECT compound — the most discriminating thing it pins, in the
// order class > id > tag > attribute name > `:root` > universal. Two subjects never reach an
// element's walk at all: a pseudo-ELEMENT subject (`::before`, `::-webkit-*`, legacy `:before`)
// styles generated content this engine does not lay out, so it is `none`; and `:root` alone
// matches only the document element, so it is `root` and walked for that element only.
// Measured on Discourse before this split: 41% of all candidate visits came from the universal
// bucket — `:root { --vars }` (777k visits, matching one element), attribute-only subjects
// (`[type=checkbox]`, `[class*=metadata__]`), and `::-webkit-*` rules that can never match.
function terminalKey(selText) {
  let groups;
  try { groups = CW.parse(selText); }
  catch (_) { return { kind: 'universal' }; }
  let id = null, cls = null, tag = null, attr = null, root = false, pseudoEl = false;
  for (const t of (groups[0] || [])) {
    if (CW_COMBINATORS.has(t.type)) { id = cls = tag = attr = null; root = pseudoEl = false; continue; }   // new compound
    if (t.type === 'tag') { if (t.name !== '*') tag = asciiLower(t.name); }
    else if (t.type === 'attribute') {
      if (t.name === 'class' && t.action === 'element') { if (!cls) cls = t.value; }
      else if (t.name === 'id' && t.action === 'equals') { if (!id) id = t.value; }
      // Any other POSITIVE attribute selector requires the attribute to be present; `[a!=v]`
      // (css-what `not`) matches its absence too, so it pins nothing — and a NAMESPACED one
      // (`[xlink|href]`, `[*|href]`) is stored under its qualified name and matched by local
      // name, which no attribute-name bucket can stand for, so it stays universal.
      else if (t.action !== 'not' && t.namespace == null) { if (!attr) attr = asciiLower(String(t.name)); }
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
    if (t.type === 'tag') { if (t.name && t.name !== '*') { h = ancBloomHash(3, asciiLower(t.name)); isTag = true; } }
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
// (A plain function, as every per-read helper here is: a closure made per call costs its allocation and, in the
// bundle, a `name` definition — `--keep-names` — on every call.)
function ancBloomAdd(bits, h) { bits[(h >>> 5) & (ANC_BLOOM_WORDS - 1)] |= (1 << (h & 31)); }
function ancestorBloom(el) {
  const ctx = ctxEpochOf(el);
  // …and on the rule set: the gate leaves a descendant's context alone when an ancestor gains
  // an identifier no CURRENT rule reads there, so a later rule that does must see a bloom built
  // after the gain.
  const epoch = cascadeStyleEpoch();
  if (el._abCtx === ctx && el._abEpoch === epoch && el._abVal) return el._abVal;
  const bits = new Uint32Array(ANC_BLOOM_WORDS);
  for (let n = el._parent; n; n = n._parent) {
    if (!n._tag) continue;                       // a document / fragment carries no identifiers
    ancBloomAdd(bits, ancBloomHash(3, n._tag));
    const a = n._attrs;
    if (a) {
      if (a.id) ancBloomAdd(bits, ancBloomHash(2, a.id.toLowerCase()));
      const cls = a.class;
      if (cls) for (const c of asciiTokens(cls)) ancBloomAdd(bits, ancBloomHash(1, c.toLowerCase()));
    }
  }
  el._abCtx = ctx;
  el._abEpoch = epoch;
  el._abVal = bits;
  return bits;
}
function ancestorAdmits(el, hashes, count = hashes.length) {
  const bits = ancestorBloom(el);
  for (let i = 0; i < count; i++) {
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
// ── cascade selector-matching COST measurement (CSIM_NATIVE_QUERY_SHADOW) ──
// The store-migration decision hinges on how much of the cascade is selector MATCHING
// (the part a native matcher over the arena would accelerate), since the Capybara find
// path proved to be a rounding error of app time. This times the css-select work inside
// the cascade — the bloom-admitted matchesSelector calls, and the full rebuildCascade
// around them — so the match fraction is measurable. `cascadeTiming` is re-resolved from the
// shadow flag at each rebuildCascade entry (a boot-time rebuild runs BEFORE the flag is set, so
// caching-once would latch it off); safeMatches then reads the plain module boolean — no per-call
// global read. Inert (one boolean branch per match) otherwise. Reported via __csimCascadeTimingStats.
let cascadeTiming = false;
// Native-AUTHORITATIVE cascade matching (store-flip reader-first foundation): a rule the arena matcher
// answers with a boolean (matchesCompiled) is trusted — css-select is no longer run for it; a selector
// native can't compile (live-state / unsupported / invalid → handle -1) falls through to css-select,
// which stays the authority for those. ON BY DEFAULT, gated by `__csimNativeCascadeAuthoritative`, which
// the runtime seeds on the MAIN context only (v8_runtime.rb; CSIM_NO_NATIVE_CASCADE opts out) — a frame
// realm never gets it and every match there takes the css path. Re-resolved per rebuildCascade entry (a
// boot-time rebuild precedes the seed — caching-once would latch it off).
let cascadeAuthoritative = false;
let cascMatchNs = 0, cascMatchCalls = 0, cascTotalNs = 0, cascRuns = 0;
// Native-match counters, shared by two modes. SHADOW sizing (`__csimNativeShadow`) runs native
// ALONGSIDE css-select — css authoritative — to measure the speedup: `cascNatNs` (native time on
// rules it answered), `cascNatCalls` (those), `cascNatFallback` (rules it deferred: state pseudo /
// pseudo-element / namespaced), `cascNatMismatch` (disagreements with css — must be 0). In
// AUTHORITATIVE mode (`__csimNativeCascadeAuthoritative`) native IS the answer: `cascNatCalls` counts
// rules it decided, `cascNatFallback` those it declined (→ css), and `cascNatUnmirrored` the DISTINCT
// case of an element not in the arena (→ css) — a coverage gap that should read ~0 once the post-parse
// build + readyState-gating hold, so it must not be conflated with a healthy selector deferral.
// `cascNatNs` / `cascNatMismatch` stay shadow-only (unused in authoritative mode).
let cascNatNs = 0, cascNatCalls = 0, cascNatFallback = 0, cascNatMismatch = 0, cascNatUnmirrored = 0;
// …and the elements the native cascade answered (`nativeAnswer`), which the parity spec needs to be non-zero.
let cascNatAnswers = 0;

function safeMatches(el, r) {
  if (r.unmatchable) return false;
  // …a shadow-tree rule behind `:host(<compound>)` (`hostPrefix`): its host has to match first — asked through this
  // same matcher, whose guards know when the arena can answer (a host's class written mid-parse is not in it yet).
  if (r.hostRule !== undefined && !hostAdmits(el, r.hostRule)) return false;
  // Every considered rule funnels through here, so this is where a `:has()`-bearing rule marks
  // the surrounding read uncacheable for the context-epoch memo (see ctxUnsafeReadSeq).
  if (ruleLooksDown(r)) ctxUnsafeSeq++;
  // …and this is where the ancestor filter sits: AFTER the taint (a rule considered is
  // considered however it is refused) and before the only expensive thing here.
  if (r.anc && !ancestorAdmits(el, r.anc)) return false;
  // Native-authoritative fast path: trust a boolean from the arena matcher; only a non-namespaced rule
  // on an element that HAS been mirrored (`_nid` set) qualifies, so a frame-realm element (never
  // mirrored) and a namespaced rule both fall straight through to css-select below.
  if (cascadeAuthoritative && !r.ns) {
    // Compile the rule's selector to an integer handle ONCE (cached on the rule), then match by handle
    // — no per-match string marshalling / hashing across the V8→Rust boundary. `-1` = native can't
    // answer this selector (invalid / live-state), cached so we never re-ask and go straight to css.
    let h = r._natSel;
    if (h === undefined) h = r._natSel = globalThis.__dom.compileSelector(r.selectorText);
    if (h >= 0) {
      // The arena mirrors every tree, so any element is answered — except one in a SHADOW tree, whose selectors
      // scope to that tree (`:host`, the boundary a combinator stops at), which css-select owns.
      const nid = arenaNid(el);
      if (nid >= 0 && !(globalThis.__csimShadowHostCount && enclosingShadowRootOf(el))) {
        const nm = globalThis.__dom.matchesCompiled(nid, h, state.quirks);
        if (nm === true || nm === false) { cascNatCalls++; return nm; }
        cascNatUnmirrored++;   // node stale in the arena → css-select.
      } else {
        cascNatUnmirrored++;   // a shadow-tree element, or one not (yet) in this realm's arena → css-select.
      }
    } else {
      cascNatFallback++;       // native declined this selector (live-state / unsupported / invalid) → css-select.
    }
  }
  try {
    if (cascadeTiming) {
      const t = globalThis.__dom.nowNanos();
      const res = r.ns ? matchesSelectorNS(el, r.selectorText, r.ns) : cssMatches(el, r.selectorText);
      cascMatchNs += globalThis.__dom.nowNanos() - t;
      cascMatchCalls++;
      // Native match beside css — only for a non-namespaced rule on an element already in the arena
      // (post first-build; before that el._nid is unset and this initial cascade is not measured).
      const nid = el._nid;
      if (nid != null && !r.ns) {
        const nt = globalThis.__dom.nowNanos();
        const nm = globalThis.__dom.matchesId(nid, r.selectorText, state.quirks);
        cascNatNs += globalThis.__dom.nowNanos() - nt;
        if (nm === undefined || nm === null) {
          cascNatFallback++;
        } else {
          cascNatCalls++;
          if (nm !== res) cascNatMismatch++;
        }
      }
      return res;
    }
    return r.ns ? matchesSelectorNS(el, r.selectorText, r.ns) : matchesSelector(el, r.selectorText);
  } catch (e) {
    if (e && e.name === 'SyntaxError') r.unmatchable = true;
    return false;
  }
}

// Read (+ optionally reset) the cascade-matching cost counters. The harness harvests these
// alongside __csimNativeShadowStats to report the match fraction of cascade time and the native win.
globalThis.__csimCascadeTimingStats = function (reset) {
  const snap = { cascMatchNs, cascMatchCalls, cascTotalNs, cascRuns, cascNatNs, cascNatCalls, cascNatFallback, cascNatMismatch, cascNatUnmirrored, cascNatAnswers };
  if (reset) {
    cascMatchNs = 0; cascMatchCalls = 0; cascTotalNs = 0; cascRuns = 0;
    cascNatNs = 0; cascNatCalls = 0; cascNatFallback = 0; cascNatMismatch = 0; cascNatUnmirrored = 0; cascNatAnswers = 0;
  }
  return snap;
};

// Tags whose subtree never contributes to visible text or
// `__csimVisible`: head/script/style/template/noscript/title.
export const INVISIBLE_TAGS = new Set(['head','script','style','template','noscript','title']);

// Elements whose child content is FALLBACK: shown only by a browser that can't render the element
// itself, which this one can. Their children generate no boxes, contribute no text, and are not
// visible — the ELEMENT is all three, since it renders its own bitmap or widget. Chrome-measured
// per tag; `<object>` is deliberately absent, because ITS fallback content does render when the
// resource fails to load. Read by the layout walk (layout.js `flatTreeChildren`), the visibility
// walk and the visible-text walk below, so the three cannot drift apart.
export const FALLBACK_ONLY_TAGS = new Set(['canvas','iframe','frame','embed','video','audio','progress','meter']);
// …and `<object>` joins them only while it is not showing its fallback: see `rendersObjectFallback`.
export function hasFallbackOnlyContent(el) {
  return FALLBACK_ONLY_TAGS.has(el._tag) || (el._tag === 'object' && !rendersObjectFallback(el));
}

// An `<object>` with no resource of its own renders its CHILDREN — and is then not a replaced
// element at all, but an ordinary inline box around them that `width` / `height` do not apply to
// (Chrome: `<object style="width: 20px">hello</object>` is as wide as the word). With no resource
// AND no fallback content it stays a replaced box at the default object size, which is what an
// empty `<object>` on a page is (Chrome: 300x150). A resource this driver never fetches is taken
// to have loaded, exactly as `<embed src>` is.
export function rendersObjectFallback(el) {
  if (el._attrs.data != null) return false;
  return el._children.some((c) => c.nodeType === NODE_ELEMENT ||
                                  (c.nodeType === NODE_TEXT && /\S/.test(String(c.data || ''))));
}

// Elements no UA renders, whatever the page declares: the `!important` UA hides (`uaHidden`), and
// an `<embed>` with no resource — which Chrome gives no layout box at all while its computed
// `display` stays `inline`, so this is a missing box rather than a hide.
export function uaNotRendered(el) {
  return uaHidden(el) || (el._tag === 'embed' && el._attrs.src == null);
}


// Visibility predicate: walks the ancestor chain. Returns false if
// the element itself or any ancestor is INVISIBLE_TAGS / hidden /
// display:none / `<input type=hidden>`, otherwise true. Exposed as
// `globalThis.__isVisibleNode` so observers.js's IntersectionObserver
// fast-path can fire without importing — observers loads before the
// cascade state is wired up, so a globalThis getter is the seam.
export function isVisibleNode(el) { return isVisibleNodeImpl(el, false, true); }
// Layout-bounds visibility, for IntersectionObserver. Per spec IO
// doesn't consult `visibility` — `visibility: hidden` elements still
// reserve layout and intersect normally. Discourse's `DLoadMore`
// sentinel is `visibility: hidden` and must still fire its IO to
// drive infinite-scroll fetches.
export function isLaidOutNode(el) { return isVisibleNodeImpl(el, true, false); }
// …and `checkVisibility()`'s base answer: laid out AND not SKIPPED — a closed `<details>`'s content has its boxes
// (Chrome: a rect 17 tall) but is skipped content, and `checkVisibility()` says false there. `visibility` is left to
// its options.
export function isUnskippedNode(el) { return isVisibleNodeImpl(el, true, true); }

// The display-side check for the ELEMENT ITSELF — no ancestor walk, no connectivity check. For a
// caller that has already established both (the layout walk descends only into rendered parents,
// starting from a connected <body>), `isLaidOutNode` re-walks every ancestor and re-matches hide
// rules at each level, making a whole-tree pass O(elements x depth x hide-rules) when
// O(elements x hide-rules) is enough. Same verdict, minus the work the caller already did.
export function selfNotRendered(el) {
  if (!el || el.nodeType !== NODE_ELEMENT) return true;
  if (el._pseudo) return ownHideProp(el, 'display') === 'none';   // a generated box: only its own display hides it
  if (el._anonCell || el._anonItem) return false;                  // an anonymous box: a box by construction
  if (INVISIBLE_TAGS.has(el._tag)) return true;
  if (uaNotRendered(el)) return true;
  return selfHidden(el);
}
// …memoised per element for as long as nothing it reads can have moved: the cascade generation (a mutation, the rule
// set, a tracked dynamic state), the parser's tree generation and the layout dirty sequence — a read that considered
// a rule naming an UNTRACKED state is not kept. Every used-value `getComputedStyle` read and every geometry read asks
// it, and the ancestor walk was half of a warm `borderTopWidth` read.
function isVisibleNodeImpl(el, ignoreVisibility, honourSkips, renderedAt = null) {
  // (…an element this realm's document owns: another realm counts its generations from 0 too, as the declared-value
  // memo's own guard says.)
  if (renderedAt !== null || !el || el.nodeType !== NODE_ELEMENT || !ownedByThisRealm(el)) {
    return visibleNodeWalk(el, ignoreVisibility, honourSkips, renderedAt);
  }
  const gen = cascadeGeneration(), tree = currentTreeGen(), dirty = currentDirtySeq();
  let m = el._visMemo;
  if (m === undefined || m.gen !== gen || m.tree !== tree || m.dirty !== dirty) {
    if (el._styled === false) declareStyledMemos(el);
    m = el._visMemo = { gen, tree, dirty, v: [undefined, undefined, undefined, undefined] };
  }
  const i = (ignoreVisibility ? 1 : 0) | (honourSkips ? 2 : 0);
  let v = m.v[i];
  if (v === undefined) {
    const untracked = untrackedSeq;
    v = visibleNodeWalk(el, ignoreVisibility, honourSkips, null, globalThis.__csimStylo === true ? styleEngineShown(el) : undefined);
    if (untrackedSeq === untracked) m.v[i] = v;
  }
  return v;
}
// …`shown` being the style engine's answer where it styles `el` (`styleEngineShown`): whether a `display: none` hides
// it anywhere up its flat tree, and whether its `visibility` does — the two questions the walk otherwise asks the JS
// cascade's hide rules of every ancestor. The walk's structural questions (fallback content, a closed `<details>`, a
// slot's fallback, connectedness) are its own either way.
function visibleNodeWalk(el, ignoreVisibility, honourSkips, renderedAt, shown = undefined) {
  if (!el || el.nodeType !== NODE_ELEMENT) return false;
  if (INVISIBLE_TAGS.has(el._tag)) return false;
  if (uaNotRendered(el)) return false;
  // Display-side hiding is UNCONDITIONAL: any ancestor-or-self that is
  // display:none / [hidden] / dialog:not([open]) / INVISIBLE_TAGS hides the
  // whole subtree. `visibility` is deliberately NOT checked in this walk —
  // it inherits AND a descendant can override it — so pass ignoreVisibility
  // to selfHidden and resolve visibility per-target below.
  let cur = el, connected = false, summarySeen = false;
  while (cur) {
    // (`renderedAt`: a node the caller has already reached through rendered ancestors — the walk stops there.)
    if (cur === renderedAt) return true;
    if (cur.nodeType === NODE_DOC) { connected = true; break; }
    if (cur.nodeType === NODE_ELEMENT) {
      if (INVISIBLE_TAGS.has(cur._tag)) return false;
      // An ANCESTOR whose content is fallback hides everything below it; the element itself is
      // rendered (it draws its own bitmap / widget), so this one is skipped for `el`.
      if (cur !== el && hasFallbackOnlyContent(cur)) return false;
      if (shown === undefined ? selfHidden(cur) : shown === 0) return false;
      // A CLOSED `<details>` SKIPS all but its `<summary>` — its content slot is `content-visibility: hidden` (HTML
      // §15.3.x), laid out but not shown: Chrome gives the content a rect and says `checkVisibility()` false, and a
      // user sees none of it, whatever `display` an author gives it (Chrome and Firefox). A widget built on one opens it
      // to show its body — Discourse's select-kit sets `open` as it expands.
      if (honourSkips && cur !== el && cur._tag === 'details' && cur._attrs.open == null && !summarySeen) return false;
      if (cur._tag === 'summary') summarySeen = true;
    }
    const p = cur._parent;
    // …up the FLAT tree where it leaves the node tree: a shadow host's light child renders through the slot it is
    // assigned to, under whatever hides that slot — and with no slot it renders nowhere. Walked to the host instead, a
    // span whose `slot` attribute went away stayed "rendered": its old box answered rects, offsetHeight and hit tests,
    // and `checkVisibility()` said true (Chrome: an empty rect, 0, no hit, false).
    if (p && p._shadowRoot && cur.nodeType === NODE_ELEMENT && !cur._pseudo) {
      cur = assignedSlotFor(cur);
      if (!cur) return false;
      continue;
    }
    // …and a slot's own children are its FALLBACK, rendered only while nothing is assigned to it (the same choice
    // layout's `flatTreeChildren` makes). Chrome: `checkVisibility()` false for a fallback `<em>` beside a slotted
    // title, where Capybara's visible filter found it.
    // (The slot's assigned set is its slotchange SNAPSHOT where one has been taken — kept current by every assignment
    // change, and free to read; `assignedNodes()` allocates and scans the host, +50% on 16k fallback reads.)
    if (p && p._tag === 'slot' && typeof p.assignedNodes === 'function' &&
        (p._assignedSnapshot !== undefined ? p._assignedSnapshot : p.assignedNodes()).length) return false;
    cur = p;
  }
  if (!connected) return false;
  if (!ignoreVisibility && (shown === undefined ? visibilityHidden(el) : shown === 2)) return false;
  return true;
}
globalThis.__isVisibleNode = isVisibleNode;
globalThis.__isLaidOutNode = isLaidOutNode;

export function selfHidden(el) {
  // Under the style engine, its computed `display`: every origin, `!important` and UA rule already folded in.
  // (…and one it has no style for and not in the document hides nothing of its own: whatever asks about it finds it
  // unrendered by its connectedness)
  if (engineAnswers()) {
    const display = engineValue(el, 'display');
    if (display !== undefined) return display === 'none';
    if (outsideEngine(el)) return false;
  }
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
  if (el._tag === 'option' && hasState(el, STATE_FILTERED)) return true;
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
    // can override a plain inline declaration — and any other inline
    // display settles it the same way.
    if (inline.display != null) return inline.display === 'none';
  }
  return matchesAnyHideRule(el, true, inline, hidden);
}

// Parse the element's inline `style=` display / visibility declarations
// into the `{ display, displayImp, visibility, visibilityImp, spec,
// source }` shape the cascade resolver compares against stylesheet rules.
// Returns null when neither is declared inline (the common case — keeps
// the hot path cheap).
// The declaration of one property a `style=` string ends up with: the LAST one written, unless an earlier one is
// `!important` and it is not (Chrome and Firefox: `display:flex;display:none` is `none`, where the first match won and
// laid the element out 18 tall) — as `[value, important]`, `[null, false]` for none.
const INLINE_DISPLAY_RE = /(?:^|;)\s*display\s*:\s*([^;]+)/gi;
const INLINE_VISIBILITY_RE = /(?:^|;)\s*visibility\s*:\s*([^;]+)/gi;
function lastInlineDecl(style, re) {
  let value = null, important = false;
  re.lastIndex = 0;
  for (const m of style.matchAll(re)) {
    let v = m[1].trim();
    const imp = /!\s*important\s*$/i.test(v);
    if (imp) v = v.replace(/!\s*important\s*$/i, '').trim();
    if (important && !imp) continue;
    value = v.toLowerCase();
    important = imp;
  }
  return [value, important];
}
function inlineHideDecl(el) {
  const style = el._attrs && el._attrs.style;
  if (!style) return null;
  // Per-element parse cache (#3): the same `style=` string is otherwise re-parsed
  // several times per visible-text/visibility compute (selfHidden + ownVisibility
  // + the property resolvers all call through here). `===` on the style string is
  // a VALUE compare, so an identical re-write still hits; any change misses and
  // reparses. Keyed on the string itself — no version counter needed.
  if (el._isKey === style) return el._isCache;
  const [display, displayImp] = lastInlineDecl(style, INLINE_DISPLAY_RE);
  const [visibility, visibilityImp] = lastInlineDecl(style, INLINE_VISIBILITY_RE);
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
// after invalidation.
const stateSlots = {
  hideRules: [], layoutRules: [], nativeCascade: null, quirks: false,
  hideIdx:   null, layoutPropIdx: null,
  // `@keyframes` by animation name (last declaration of a name wins — see `cascadeRulesOf`).
  keyframes: new Map(),
  // …and the property names any of those blocks declares, built lazily like `layoutPropIdx` —
  // the animation origin's answer to `cascadeDeclaresProperty` — plus the `@keyframes` NAMES
  // anything actually references, which is what keeps an unused block out of that index.
  keyframePropIdx: null,
  pseudoIdx: null,
  animNameIdx: null,
  hasImportantHideRule: false,
  hasVisibilityRule: false,
  hasMinMaxRule: false,
  sheets: []
};
// …read through `state`, whose every field is the rule set's: under the style engine one read of any of them builds the
// rule set a rebuild left owed first (`ensureJsCascade`) — so no reader, however it reaches it, can see the rules of a
// sheet set that has since changed. (Nothing owed: one test.)
const state = {};
for (const key of Object.keys(stateSlots)) {
  Object.defineProperty(state, key, {
    get() { if (jsCascadeOwed !== null) ensureJsCascade(); return stateSlots[key]; },
    set(v) { stateSlots[key] = v; },
    enumerable: true,
    configurable: true
  });
}
// …and an instrument: every read of the rule set from here on counted by the reader's frames (`__csimJsCascadeReads()`),
// the readers the style engine still has to answer before the rule set can go unbuilt. The accessors are swapped for
// counting ones, so a page that never asks pays nothing.
const JS_CASCADE_READS = {};
globalThis.__csimJsCascadeReads = () => JS_CASCADE_READS;
globalThis.__csimCountJsCascadeReads = () => {
  for (const key of Object.keys(stateSlots)) {
    Object.defineProperty(state, key, {
      get() {
        const limit = Error.stackTraceLimit;
        Error.stackTraceLimit = 40;
        const stack = new Error().stack;
        Error.stackTraceLimit = limit;
        const frames = String(stack).split('\n').slice(2).map((l) => l.trim().replace(/^at /, '').replace(/ \(.*$/, ''));
        const where = key + ' @ ' + frames.join(' < ');
        JS_CASCADE_READS[where] = (JS_CASCADE_READS[where] || 0) + 1;
        if (jsCascadeOwed !== null) ensureJsCascade();
        return stateSlots[key];
      },
      set(v) { stateSlots[key] = v; },
      enumerable: true,
      configurable: true
    });
  }
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
// Whether a `<style>` holds a style sheet at all. HTML's "update a style block" makes one only when the element's `type`
// is absent, empty or an ASCII case-insensitive `text/css`, and runs again when `type` changes — Chrome and Firefox both
// drop the sheet's rules on a switch to `text/plain`. The `.sheet` getter and the `load` event asked this; the cascade
// did not, so a `<style type="text/plain">` applied its rules from the start.
export function styleElementIsCss(el) {
  const type = el._attrs.type;
  return type == null || type === '' || type.toLowerCase() === 'text/css';
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
// set is resolved over the SAME media-filtered sheet view `collectSheets`
// uses, so key and collected rules can't disagree. The whole machinery is gated
// on `anyTitledOrAlt`: the common page (only titleless non-alternate sheets) adds
// nothing to the key and never pays the `<meta>` scan.
// A shadow `<link>`'s sheet text, fetched once per URL for the page (a document's `<link>` is fetched once too; a new
// page starts over, `resetCascadeState`).
const shadowLinkTexts = new Map();
function shadowLinkText(url) {
  // (A failed fetch is tried again next time, as a document's `<link>` is.)
  if (!shadowLinkTexts.has(url)) {
    const text = urlSheetText(url);
    if (text == null) return null;
    shadowLinkTexts.set(url, text);
  }
  return shadowLinkTexts.get(url);
}

// A shadow tree's `<link>`'s sheet URL, absolute — null for a link that is no enabled style sheet link.
function shadowLinkSheetUrl(l, base) {
  const rel = asciiTokens(asciiLower(l._attrs.rel || ''));
  if (!rel.includes('stylesheet') || rel.includes('alternate')) return null;
  const href = l._attrs.href;
  if (!href) return null;
  try { return new URL(href, base).href; } catch (_) { return null; }
}

// A document's (or a shadow root's) `<style>` and `<link>` elements in TREE order — the order their sheets cascade
// in, whichever kind each is (a `<style>` after a `<link>` wins over it). Walked over the tree itself, which a page
// cannot tamper with (a shadow root has no `getElementsByTagName` in any browser, and `compareDocumentPosition` is
// page-overridable), and kept per root until the tree changes.
const SHEET_OWNERS = new WeakMap();
// An HTML or SVG `<style>`, or an HTML `<link>` — by local name and namespace, as `getElementsByTagName` would not
// tell an SVG `STYLE` (no style element) from one.
function isSheetOwner(el) {
  const name = el._localName;
  if (name === 'style') return el._ns === HTML_NS || el._ns === SVG_NS;
  return name === 'link' && el._ns === HTML_NS;
}
function styleSheetOwners(root) {
  const tree = currentTreeGen();
  const kept = SHEET_OWNERS.get(root);
  if (kept !== undefined && kept.tree === tree) return kept.owners;
  const owners = [];
  walk(root, (el) => { if (isSheetOwner(el)) owners.push(el); });
  SHEET_OWNERS.set(root, { tree, owners });
  return owners;
}

function cascadeCacheKey(doc, vp) {
  const root = doc.documentElement;
  // …and the document's MODE, which the rule indexes are keyed for (`bucketFor`).
  let acc = 'vp:' + vp.width + 'x' + vp.height + (doc._quirks ? ':q' : '');
  let anyTitledOrAlt = false, preferred = '';
  // getElementsByTagName (HTMLCollection), NOT querySelectorAll (a static
  // NodeList) — the cascade rebuild runs mid-parse under streaming, where a
  // parse-time script may have tampered NodeList.prototype.length (which a static
  // NodeList's length reads through); iterating one would then yield undefined
  // and throw. Parity with rebuildCascade's own style/link scan below.
  for (const owner of styleSheetOwners(root)) {
    if (owner._tag === 'style') {
      const s = owner;
      if (!styleElementIsCss(s) || sheetDisabled(s)) continue;      // contributes nothing; re-enabling re-keys and rebuilds
      const media = s._attrs.media; if (media && !mediaMatches(media, vp)) continue;
      const t = effectiveStyleCss(s); if (!t) continue;
      const title = (s._attrs.title || '').trim();
      if (title) { anyTitledOrAlt = true; if (!preferred) preferred = title; }
      acc += '\nS:' + fnv1a(t) + ':' + t.length + (title ? '|t:' + title : '');
      continue;
    }
    const l = owner;
    const tokens = asciiTokens(asciiLower(l._attrs.rel || '')); if (!tokens.includes('stylesheet')) continue;
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
// …read as the version IN FORCE: a pending rebuild (a `<style>` inserted, a CSSOM edit) is taken first, so a memo keyed
// on it never files an answer under the version the change is about to replace.
globalThis.__csimCascadeVersion = () => { ensureCascadeFresh(); return cascadeVersion; };
// Whether the document declares an `@font-face` (font-metrics.js gates the per-run face lookup on this — a page without
// a web font never walks a stylesheet's rules).
globalThis.__csimDocHasFontFace = () => currentSheetFacts().hasFontFace;
// Whether the document sets a `background(-image)` / `cursor` / `list-style(-image)` to a url() —
// the O(1) gate for the rendering-update fetch of those CSS-embedded images (layout.js).
globalThis.__csimDocHasCssImage = () => currentSheetFacts().hasCssImage;

// What the document's sheets hold besides their rules — whether any declares an `@font-face` and whether any sets a
// CSS-embedded image (the two gates above), and each sheet owner's faces (`fontFaceRulesOf`) — asked of the style
// engine, which parsed them (`__dom.styleSheetFacts`): the faces that apply, inside an `@media` / `@supports` that holds
// and through an `@import`, each by the `<style>` / `<link>` (or adopted sheet) it came from. Asked once per rule set,
// when first wanted. (Read off the sheets' TEXT here, they took a Redmine page load 3 ms of regular expressions over its
// stylesheets and a css-tree parse of the one holding its Noto Sans — every load.) A realm with no engine — the
// snapshot's warm-up — has no faces and no images to speak of.
const NO_SHEET_FACTS = { hasFontFace: false, hasCssImage: false, ownerFaces: new Map() };
let sheetFacts = NO_SHEET_FACTS, sheetFactsOwed = false;
function currentSheetFacts() {
  ensureCascadeFresh();
  if (sheetFactsOwed) {
    sheetFactsOwed = false;
    sheetFacts = engineSheetFacts();
  }
  return sheetFacts;
}
function engineSheetFacts() {
  const flat = globalThis.__dom && globalThis.__dom.styleSheetFacts();
  if (!flat) return NO_SHEET_FACTS;
  const ownerFaces = new Map();
  for (let i = 1; i + 1 < flat.length; i += 2) {
    const owner = styleEngineOwners[flat[i]];
    if (owner === undefined) continue;
    let faces = ownerFaces.get(owner);
    if (faces === undefined) ownerFaces.set(owner, faces = []);
    faces.push(new EngineFontFace(flat[i + 1]));
    // (…a CONTROLLED document fetches each face's source through its service worker, as the JS model's collection did:
    // destination 'font', the response discarded — the fetch is the observable)
    const src = FACE_SRC_URL_RE.exec(flat[i + 1]);
    if (src) swFetchFontSrcs([src[2]], null);
  }
  return { hasFontFace: ownerFaces.size > 0, hasCssImage: flat[0] === true, ownerFaces };
}

export function rebuildCascade(doc) {
  // SHADOW measurement: re-resolve the flag here (a boot-time rebuild precedes the flag eval),
  // then bracket the full rebuild so the match fraction (safeMatches time over total cascade
  // time) is measurable. Direct tail-call when off — zero cost.
  cascadeTiming = globalThis.__csimNativeShadow === true && globalThis.__dom != null;
  // Native-authoritative matching reads the arena, which mirrors every tree as it changes (the parser's steps
  // included) — so a mid-parse `<script>` reading style is answered natively too. The verify mode checks it here.
  cascadeAuthoritative = globalThis.__csimNativeCascadeAuthoritative === true && globalThis.__dom != null;
  if (cascadeAuthoritative) maybeVerifyArena();
  if (!cascadeTiming) rebuildCascadeImpl(doc);
  else {
    const t = globalThis.__dom.nowNanos();
    try { rebuildCascadeImpl(doc); }
    finally { cascTotalNs += globalThis.__dom.nowNanos() - t; cascRuns++; }
  }
}

function rebuildCascadeImpl(doc) {
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
  // Under the style engine the sheets go to IT, and this side's own rule set is built only when something here reads
  // it (`ensureJsCascade`): parsing and indexing every sheet for the JS cascade on each rebuild was an eighth of a page
  // load for readers the engine answers.
  if (globalThis.__csimStylo === true && globalThis.__dom) {
    jsCascadeOwed = { doc, key };
    feedStyleEngine(doc, selectedSet);
    return;
  }
  jsCascadeOwed = null;
  buildJsCascade(doc, selectedSet);
}

// The JS cascade's rule set for `doc` — what the readers on this side match against: the hide and layout rules, their
// indexes and the document-level facts derived from the sheets.
function buildJsCascade(doc, selectedSet) {
  const collected = collectSheets(doc, selectedSet);
  const { hide, layout, keyframes } = cascadeRulesOf(collected.sheets);
  const sheets = collected.sheets;
  state.hideRules   = hide;
  state.layoutRules = layout;
  state.nativeCascade = null;
  state.quirks = !!doc._quirks;
  state.sheets      = sheets;
  state.keyframes   = keyframes;
  state.hideIdx = null;
  state.layoutPropIdx = null;
  state.keyframePropIdx = null;
  state.pseudoIdx = null;
  state.animNameIdx = null;
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
  state.hasMinMaxRule = computeHasMinMaxRule(layout);
}
// …and the rule set a rebuild under the style engine left to build (`rebuildCascadeImpl`), built on this side's first read
// of it. `JS_CASCADE_DEMANDS` counts those builds — the census of what still reads the JS cascade under the engine, by
// the reader's frame where `__csimJsCascadeCensus` asks for it (a stack per build: an instrument, not a hot path).
let jsCascadeOwed = null;
const JS_CASCADE_DEMANDS = { builds: 0, by: {} };
globalThis.__csimJsCascadeDemands = () => JS_CASCADE_DEMANDS;
function ensureJsCascade() {
  const owed = jsCascadeOwed;
  if (owed === null) return;
  jsCascadeOwed = null;
  JS_CASCADE_DEMANDS.builds++;
  if (globalThis.__csimJsCascadeCensus === true) {
    const frame = String(new Error().stack).split('\n').slice(2, 6).map((l) => l.trim().replace(/^at /, '').replace(/ \(.*$/, '')).join(' < ');
    JS_CASCADE_DEMANDS.by[frame] = (JS_CASCADE_DEMANDS.by[frame] || 0) + 1;
  }
  // (…built from the sheets as they stand NOW, which a change since the rebuild that owed it may have moved: then this
  // rule set is no longer the one `lastCascadeKey` names, and the rebuild that change schedules must not find the key
  // unchanged — and stop, with these rules — when the sheets move back to it)
  const { key, selectedSet } = cascadeCacheKey(owed.doc, currentViewport());
  if (key !== owed.key) lastCascadeKey = null;
  buildJsCascade(owed.doc, selectedSet);
}

// The style engine's sheets (stylo, `__dom.styleSheets`): the document's `<style>` / `<link>` sheets and its adopted
// ones, as text with the base URL and the media list each applies under, and whether it is a CONSTRUCTED sheet (whose
// `@import`s are ignored, as `replace()` ignores them) — the engine parses them, evaluates the media, and asks back
// for what their `@import`s name, which is fetched and handed over until nothing is waiting. Which sheets take part
// is the document's to say (disabled, the sheet set), so that is decided here.
// …each sheet's owner kept in its place (`styleEngineOwners`): the `<style>` / `<link>`, or the adopted sheet, the
// engine's facts name a sheet by (`engineSheetFacts`).
let styleEngineFedAt = null;
let styleEngineOwners = [];
function feedStyleEngine(doc, selectedSet = cascadeCacheKey(doc, currentViewport()).selectedSet) {
  styleEngineFedAt = cascadeVersion;
  const vp = currentViewport();
  const docBase = documentBaseUrl();
  const entries = [];
  const owners = [];
  for (const owner of styleSheetOwners(doc.documentElement)) {
    if (owner._tag === 'style') {
      const s = owner;
      if (!styleElementIsCss(s) || sheetDisabled(s)) continue;
      if (!sheetSetEnabled((s._attrs.title || '').trim(), false, selectedSet)) continue;
      entries.push(effectiveStyleCss(s) || '', docBase, s._attrs.media || '', false);
      owners.push(s);
      continue;
    }
    const l = owner;
    const tokens = asciiTokens(asciiLower(l._attrs.rel || ''));
    const href = l._attrs.href;
    if (!tokens.includes('stylesheet') || !href || sheetDisabled(l)) continue;
    if (!linkSheetEnabled(l, (l._attrs.title || '').trim(), tokens.includes('alternate'), selectedSet)) continue;
    let abs; try { abs = new URL(href, docBase).href; } catch (_) { continue; }
    const css = urlSheetText(abs);
    if (css != null) { entries.push(css, abs, l._attrs.media || '', false); owners.push(l); }
  }
  const adopted = doc.adoptedStyleSheets;
  if (adopted) for (const sheet of adopted) {
    if (!adoptedSheetActive(sheet, vp)) continue;
    const txt = sheetCssText(sheet);
    if (txt) { entries.push(txt, sheet._href || docBase, '', true); owners.push(sheet); }
  }
  resolveStyleEngineImports(globalThis.__dom.styleSheets(doc._nid, docBase, !!doc._quirks, vp.width, vp.height, entries));
  styleEngineOwners = owners;
  sheetFactsOwed = true;
}
// The sheets the style engine's `@import`s wait for, fetched and handed over until none is. Each URL is fetched once,
// however many sheets import it; an import CYCLE would ask for ever, so a chain deeper than any real page nests is
// answered with nothing.
function resolveStyleEngineImports(waiting) {
  const texts = new Map();
  for (let depth = 0; waiting && waiting.length; depth++) {
    const next = [];
    for (const url of new Set(waiting)) {
      if (!texts.has(url)) texts.set(url, urlSheetText(url, 'css'));
      next.push(...globalThis.__dom.styleImport(url, depth < IMPORT_DEPTH_LIMIT ? texts.get(url) : null));
    }
    waiting = next;
  }
}
const IMPORT_DEPTH_LIMIT = 16;

// Each shadow root's own sheets for the style engine (`__dom.styleShadowSheets`): its `<style>` elements in tree order,
// then its adopted sheets. A root is handed them again when the rule set moved (`cascadeVersion`, which a shadow tree's
// sheets move without the document's key seeing it); the document is walked for roots again when that or the tree
// moved, which is how a host connected since is found. Shadow roots nested in shadow trees are reached through their
// hosts, as a walk of the document does not enter a shadow tree.
let shadowSheetsFedAt = null, shadowSheetsFedTree = null;
function feedShadowStyleSheets(doc) {
  const tree = currentTreeGen();
  if (shadowSheetsFedAt === cascadeVersion && shadowSheetsFedTree === tree) return;
  shadowSheetsFedAt = cascadeVersion;
  shadowSheetsFedTree = tree;
  const vp = currentViewport();
  const docBase = documentBaseUrl();
  const feed = (host) => {
    const sr = host._shadowRoot;
    if (!sr || !(sr._nid >= 0)) return;
    if (sr._styleEngineFedAt !== cascadeVersion) {
      sr._styleEngineFedAt = cascadeVersion;
      const entries = [];
      for (const owner of styleSheetOwners(sr)) {
        if (sheetDisabled(owner)) continue;
        if (owner._tag === 'style') {
          if (styleElementIsCss(owner)) entries.push(effectiveStyleCss(owner) || '', docBase, owner._attrs.media || '', false);
        } else {
          const abs = shadowLinkSheetUrl(owner, docBase);
          const css = abs && shadowLinkText(abs);
          if (css != null && abs) entries.push(css, abs, owner._attrs.media || '', false);
        }
      }
      const adopted = sr.adoptedStyleSheets;
      if (adopted) for (const sheet of adopted) {
        if (!adoptedSheetActive(sheet, vp)) continue;
        const txt = sheetCssText(sheet);
        if (txt) entries.push(txt, sheet._href || docBase, '', true);
      }
      resolveStyleEngineImports(globalThis.__dom.styleShadowSheets(sr._nid, entries));
    }
    walk(sr, feed);
  };
  walk(doc, feed);
}

// Defined from the start, so a read of it on every `getComputedStyle` is no property miss (it is `true` in a document
// realm, where the runtime installs the style engine).
if (globalThis.__csimStylo === undefined) globalThis.__csimStylo = false;

// `el`'s computed value of the longhand `key` (or its pseudo-element `pseudo`'s: `before`, `placeholder`, …) from the
// style engine, or undefined where it has none to give — an element of another realm's document included, whose
// engine is that realm's.
export function styleEngineValue(el, key, pseudo) {
  const nid = arenaNid(el);
  if (nid < 0) return undefined;
  feedStyleEngineSheets();
  const value = globalThis.__dom.styleValue(nid, key, pseudo, styleEngineNow());
  // (…read again once the faces a font metric was computed without are told: `flushStyleEngine`)
  return teachStyleFaces() ? globalThis.__dom.styleValue(nid, key, pseudo, styleEngineNow()) : value;
}

// The JS LAYOUT (the JS walk and the oracle) is built around the JS cascade's DECLARED values, and reads them under the
// style engine too: `fn` runs with every declared-value read answered by the JS cascade (`computeDeclaredValue`).
let JS_CASCADE_SCOPE = 0;
export function withJsCascade(fn) {
  JS_CASCADE_SCOPE++;
  try { return fn(); } finally { JS_CASCADE_SCOPE--; }
}
// Whether the style engine answers a style read here: under it, and outside the JS layout (`withJsCascade`).
export function engineAnswers() {
  return globalThis.__csimStylo === true && JS_CASCADE_SCOPE === 0;
}
// …and its computed value of `key` for `el` — a generated box's being its element's pseudo-element's — or undefined
// where it has none (a node of another document, one under a `display: none`).
export function engineValue(el, key) {
  return el._pseudo ? styleEngineValue(el._parent, key, el._pseudo) : styleEngineValue(el, key);
}
// …and whether an element the engine has no value for is one it never styles: not in the document, which declares
// nothing and generates no box (a browser's `getComputedStyle` gives it no values either). The readers answer that
// rather than ask the JS rules, which the engine would otherwise build for a node no page can see.
export function outsideEngine(el) {
  return !el.isConnected;
}
// Whether the style engine shows `el` (`__dom.styleShown`): 0 no box, 1 displayed and visible, 2 displayed with its
// `visibility` hiding it — undefined where it has no node in the engine's arena, and for a generated box, whose style
// is its originating element's pseudo-element's rather than a node's own.
export function styleEngineShown(el) {
  const nid = el._pseudo ? -1 : arenaNid(el);
  if (nid < 0) return undefined;
  feedStyleEngineSheets();
  return globalThis.__dom.styleShown(nid, styleEngineNow());
}

// …and whether it SKIPS its contents (`__dom.styleSkips`): shown itself, under a `content-visibility: hidden` nothing under
// it is — undefined where it has no node in the engine's arena.
export function styleEngineSkips(el) {
  const nid = el._pseudo ? -1 : arenaNid(el);
  if (nid < 0) return undefined;
  feedStyleEngineSheets();
  return globalThis.__dom.styleSkips(nid, styleEngineNow());
}

// …and its `transform` as the 4x4 the engine composes (`__dom.styleTransformMatrix`), about a `width` x `height`
// reference box: null for `none`, undefined where it has no node or no style there.
export function styleEngineTransformMatrix(el, width, height) {
  const nid = el._pseudo ? -1 : arenaNid(el);
  if (nid < 0) return undefined;
  feedStyleEngineSheets();
  const m = globalThis.__dom.styleTransformMatrix(nid, width, height, styleEngineNow());
  return m === null || m === undefined ? m : Array.from(m);
}

// What `el`'s `::before` / `::after` renders as the style engine styled it (`__dom.styleGenerated`, what its walk lays
// out): its text, or null where it generates no box — undefined where `el` has no node in the engine's arena.
export function styleEngineGenerated(el, which) {
  const nid = arenaNid(el);
  if (nid < 0) return undefined;
  feedStyleEngineSheets();
  return globalThis.__dom.styleGenerated(nid, which === 'before' ? 0 : 1, styleEngineNow());
}

// A style flush (a forced `getComputedStyle` or layout read) in the style engine: the document is styled as it stands,
// which is what starts the transitions a change since the last flush owes.
export function flushStyleEngine() {
  feedStyleEngineSheets();
  const retargeted = globalThis.__dom.styleFlush(styleEngineNow());
  if (retargeted) RETARGETED(retargeted);
  // …and once more where a font metric (`ex`, `ch`) was computed with a stand-in for a face not resolved yet: the faces
  // are resolved on this side, and telling them restyles what used them.
  if (teachStyleFaces()) {
    const again = globalThis.__dom.styleFlush(styleEngineNow());
    if (again) RETARGETED(again);
  }
  // (…a transition or animation the flush started needs frames from now on.)
  globalThis.__csimWakeForAnimations();
}

// The rendering update in the style engine: a style flush, and the animation / transition events owed since the last
// update, as `__dom.styleTick` lists them after the elements the flush reports.
export function tickStyleEngine() {
  feedStyleEngineSheets();
  const out = globalThis.__dom.styleTick(styleEngineNow());
  if (!out) return out;
  const retargeted = out[0];
  if (retargeted) RETARGETED(out.slice(1, 1 + retargeted));
  return out.slice(1 + retargeted);
}

// What is told of the elements whose animations' properties a style flush changed (a CSS animation made or let go):
// registered by the Web Animations bindings, which this module cannot import (they import it).
let RETARGETED = () => {};
export function onStyleEngineRetargeted(fn) {
  RETARGETED = fn;
}

// The engine is asked with the sheets as they stand: a pending sheet edit is taken first, and a rule-set change the
// cascade key does not see (an adopted sheet's list or text) moves the version without a rebuild. (Exported for what
// needs the engine to exist before it asks anything of it: the Web Animations bindings.)
export function feedStyleEngineSheets() {
  const doc = globalThis.document;
  ensureCascadeFresh();
  if (styleEngineFedAt !== cascadeVersion && doc && doc.documentElement) feedStyleEngine(doc);
  if (globalThis.__csimShadowHostCount) feedShadowStyleSheets(doc);
}

// The realm's style engine, made if nothing has asked it anything yet (the first feed makes it); a page it styles
// already is left as it is — the next read feeds what changed.
export function ensureStyleEngine() {
  if (styleEngineFedAt === null) feedStyleEngineSheets();
}

function styleEngineNow() {
  return globalThis.__virtualNow ? globalThis.__virtualNow() : 0;
}

export function resetCascadeState() {
  lastCascadeKey = null;   // force the next rebuildCascade to run (state is now empty)
  jsCascadeOwed = null;    // (…and the last page's rule set is no longer anyone's to build)
  IMPORT_TIMED.clear();     // (…a new page fetches its imports anew)
  shadowLinkTexts.clear();
  cascadeVersion = (cascadeVersion + 1) | 0;
  state.hideRules = [];
  state.layoutRules = [];
  state.nativeCascade = null;
  state.quirks = false;
  state.keyframes = new Map();
  state.hideIdx = null;
  state.layoutPropIdx = null;
  state.keyframePropIdx = null;
  state.pseudoIdx = null;
  state.animNameIdx = null;
  state.hasImportantHideRule = false;
  state.hasVisibilityRule = false;
  state.hasMinMaxRule = false;
  state.sheets = [];
  sheetFacts = NO_SHEET_FACTS;
  sheetFactsOwed = false;
  styleEngineOwners = [];
  resetShadowSheetFacts();   // a new page: its trees are queued again as they are attached
}

function computeHasImportantHideRule(hide) {
  for (const r of hide) {
    if (r.displayImp || r.visibilityImp) return true;
  }
  return false;
}

// …and the pseudo-elements a rule index is kept for (`pseudoIndex`): those two, and `::placeholder`, whose text the
// painter draws in a form control — styled, and no box.
const INDEXED_PSEUDO_RE = /:{1,2}(before|after|placeholder|-webkit-input-placeholder)\s*$/i;
// (…the legacy WebKit name IS `::placeholder` in Chrome, so its rules go to the same index)
const PSEUDO_INDEX_ALIAS = { '-webkit-input-placeholder': 'placeholder' };

// The hosts whose `:host(:first-child)` / `:host(:empty)` a child-list change on `el` can flip: `el` itself, if it hosts a
// tree (its own child list is its `:empty`), and the hosts among its children (their positions). Their trees read the
// host through a condition no document memo key holds. (Every host is taken as reached: which ones a tree's rules can
// read is the style engine's to say.)
function forHostsStructurallyReached(el, fn) {
  if (!globalThis.__csimShadowHostCount) return;
  if (el._shadowRoot) fn(el);
  if (el._children) for (const c of el._children) if (c._shadowRoot) fn(c);
}
// …and the hosts whose `:host(:has(…))` a write at `el` can flip: every host on its chain, `el` itself included — the
// argument is relative to the host, and a class, a child or an emptiness anywhere under it can decide it.
function forHostsReachedFromBelow(el, fn) {
  if (!globalThis.__csimShadowHostCount) return;
  for (let a = el; a; a = a._parent) if (a._shadowRoot) fn(a);
}
// Called at a layout's ENTRY, before any memo is read: the rule set made known — fed to the style engine — if a sheet
// changed since.
export function settleLayoutInvalidation() {
  ensureCascadeFresh();
}
// Could `el`'s `:empty` have flipped with this change — does it hold nothing but `changed` (the nodes just added, or
// the text node just edited)?
function emptinessMayHaveFlipped(el, changed) {
  // (…a batch — `innerHTML`'s 60,000 nodes arrive as one change — is asked through a set: `indexOf` per child made it
  // quadratic.)
  const set = changed.length > 8 ? new Set(changed) : null;
  const kids = el._children;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if ((c.nodeType === NODE_ELEMENT || (c.nodeType === NODE_TEXT && c._data)) && (set === null ? changed.indexOf(c) === -1 : !set.has(c))) return false;
  }
  return true;
}

// Whether a rule's SELECTOR is dynamic (the memo field `ruleIsDynamic` reads), decided once when the sheet is parsed so
// it rides the sheet cache. One selector yields up to two rules (the hide slots and the captured declarations); both
// get the answer.
function noteDynamicRuleData(selectorText, hideRule, layoutRule) {
  const dynamic = ruleIsDynamic({ selectorText });   // a string scan, memoised onto both
  if (hideRule)   hideRule.__dynamicSel = dynamic;
  if (layoutRule) layoutRule.__dynamicSel = dynamic;
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
// the element's own cached map, and the UA stylesheet constrains only the tags whose entry names a
// `min-*` / `max-*` (a modal `<dialog>`'s `max-height`, `uaMayConstrainSize`) — so those three are
// the whole answer — plus a shadow tree's own sheets, which are in no rule index and
// are asked through `shadowSheetFacts` (a page with one used to answer yes unconditionally, which on
// a 400-row table is four cascade lookups per element per pass for a widget that declares no size at
// all).
export function mayConstrainSize (el) {
  ensureCascadeFresh();
  if (state.hasMinMaxRule || uaMayConstrainSize(el)) return true;
  const shadow = shadowSheetFacts();
  if (shadow.size) { for (const prop of MIN_MAX_PROPS) if (shadow.has(prop)) return true; }
  const inline = inlineDecls(el);
  for (const prop of MIN_MAX_PROPS) if (prop in inline) return true;
  return animationsDeclareAnyOf(el, MIN_MAX_PROPS);
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
    cascadeStale = false;               // …this IS the rebuild the mark asked for
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

// A face the style engine holds, standing where its CSSOM rule would: its declarations' text, and a `style` read as the
// rule's own would be (cssom.js `__csimFontFaceStyle`), built on first read.
class EngineFontFace {
  constructor(declText) { this._declText = declText; this._style = null; }
  get cssText() { return `@font-face { ${this._declText} }`; }
  get style() { return this._style || (this._style = globalThis.__csimFontFaceStyle(this._declText)); }
}
// The identity `document.fonts` connects a face by (`key`): the sheet's OWNER — its `<style>` / `<link>`, or an adopted
// sheet — and the face's place among the owner's faces as the parse reads them, for as long as the owner holds the same
// sheet (`faceSource`). Keyed by the rule read, a face became a new FontFace once a script built the sheet's CSSOM, and
// two `<style>`s of one text shared one.
const FACE_KEYS = new WeakMap();
function faceKey(owner, ordinal) {
  const source = faceSource(owner);
  let series = FACE_KEYS.get(owner);
  if (series === undefined || series.source !== source) FACE_KEYS.set(owner, series = { source, keys: [] });
  return series.keys[ordinal] || (series.keys[ordinal] = { owner, ordinal, rule: null });
}
// What an owner's faces are the faces OF: a `<style>`'s block as last updated (mutation-observer.js `styleBlockChanged`),
// a `<link>`'s URL. Changed, they are another sheet's rules, and so new FontFaces (CSS Font Loading §2.2: a rule removed
// is no longer connected, and one added makes a face of its own) — even a text changed and changed back — where a CSSOM
// edit of the sheet, which leaves the block alone, keeps the faces it does not touch.
function faceSource(owner) {
  if (owner._tag === 'style') return owner._sheetGen | 0;
  if (owner._tag === 'link') return owner._attrs.href;
  return owner;
}
// …and a CSSOM rule, once read, keeps the key it took: the one of its place if no other rule holds it — which is how
// the faces a parse listed stay the same FontFaces once the sheet is built — or one of its own. A rule inserted before
// another moves no key, so every face after it stays the FontFace it was (a `deleteRule` likewise).
function ruleFaceKey(rule, owner, ordinal) {
  if (rule._faceKey !== undefined) return rule._faceKey;
  const placed = faceKey(owner, ordinal);
  const key = placed.rule === null || placed.rule === rule ? placed : { owner, ordinal: -1, rule };
  key.rule = rule;
  return (rule._faceKey = key);
}
// A CSSOM sheet's `@font-face` rules in order, with the base each resolves against: into each `@import` that applies
// (the imported sheet's URL its base; `chain` guards a cycle) and each `@media` / `@supports` that holds, and every
// other grouping rule (`@layer`) — not a keyframes rule.
function walkFaceRules(rules, base, depth, chain, vp, visit) {
  if (!rules || depth > 32) return;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (!r) continue;
    switch (r.type) {
      case 5: visit(r, base); break;
      case 3: {                                                     // @import
        const mt = r.media && r.media.mediaText;
        if (mt && !mediaMatches(mt, vp)) break;
        if (r.supportsText && !supportsMatches(r.supportsText)) break;
        let sheet = null;
        try { sheet = r.styleSheet; } catch (_) { sheet = null; }
        const href = sheet && sheet.href;
        if (!sheet || (href && chain.has(href))) break;   // a cycle: this sheet is already an ancestor
        if (href) chain.add(href);
        walkFaceRules(sheet.cssRules, href || base, depth + 1, chain, vp, visit);
        if (href) chain.delete(href);
        break;
      }
      case 4:  if (mediaMatches(r.media ? r.media.mediaText : r.conditionText, vp)) walkFaceRules(r.cssRules, base, depth + 1, chain, vp, visit); break;
      case 12: if (supportsMatches(r.conditionText)) walkFaceRules(r.cssRules, base, depth + 1, chain, vp, visit); break;
      default: if (r.cssRules && r.type !== 7) walkFaceRules(r.cssRules, base, depth + 1, chain, vp, visit);   // @layer blocks and the like
    }
  }
}
// A `<style>` / `<link>`'s sheet has just been built (dom-nodes.js): its faces take their keys NOW, each the one of its
// place among the owner's faces — the key the style engine's listing gave it — before a script can insert a rule ahead
// of them (`ruleFaceKey`).
globalThis.__csimStampFaceKeys = function (owner, sheet) {
  if (!sheet) return;
  let n = 0;
  walkFaceRules(sheet.cssRules, sheet.href || null, 0, new Set(sheet.href ? [sheet.href] : []), currentViewport(),
                (r) => { ruleFaceKey(r, owner, n++); });
};
// The `@font-face` rules that apply to `doc`, in stylesheet order, each with the base URL its
// `src` resolves against (the owning sheet's, or the document's for a `<style>`): the sheets
// the cascade would take — a `<style media>` / `<link media>` that matches, no `disabled`
// sheet, alternate sets by the selected set — and inside them `@media` / `@supports` blocks
// that hold and `@import`s (the imported sheet's own base). Read by font-metrics.js and the
// FontFaceSet; memoised there per settle generation and cascade version.
export function fontFaceRulesOf(doc) {
  const out = [];
  if (!doc || !doc.documentElement) return out;
  const vp = currentViewport();
  const selectedSet = cascadeCacheKey(doc, vp).selectedSet || '';
  const docBase = documentBaseUrl();
  const seen = new Set();
  let keyOwner = null;
  const at = { n: 0 };
  const walk = (rules, base, depth, chain) =>
    walkFaceRules(rules, base, depth, chain, vp, (r, b) => out.push({ rule: r, base: b, key: ruleFaceKey(r, keyOwner, at.n++) }));
  // The sheet owners in tree order, as `document.styleSheets` lists them. One with no `sheet` built is read from the
  // style engine (`currentSheetFacts`), which holds the faces of exactly the sheets it took — their media, `disabled`
  // and stylesheet set already asked — each a key of its place among the owner's faces (`faceKey`): building its CSSOM
  // to find them cost a Redmine page load 8.7 ms, jQuery UI's sheet and every other beside the one declaring its Noto
  // Sans. Once built, a sheet is read as it stands: a script may have edited it.
  const { ownerFaces } = currentSheetFacts();
  const owners = [];
  walkSubtree(doc.documentElement, (n) => { if (n.nodeType === NODE_ELEMENT && (n._tag === 'style' || n._tag === 'link')) owners.push(n); });
  for (const owner of owners) {
    keyOwner = owner; at.n = 0;
    if (!owner._sheet) {
      // (…its sources' URLs already resolved, against the sheet each was written in: no base to hand on)
      for (const face of ownerFaces.get(owner) || []) out.push({ rule: face, base: null, key: faceKey(owner, at.n++) });
      continue;
    }
    const sheet = owner.sheet;
    if (!sheet || sheet.disabled) continue;
    if (sheetDisabled(owner)) continue;
    const media = owner._attrs.media;
    if (media && !mediaMatches(media, vp)) continue;
    const title = (owner._attrs.title || '').trim();
    if (owner._tag === 'link') {
      const tokens = asciiTokens(asciiLower(owner._attrs.rel || ''));
      if (!linkSheetEnabled(owner, title, tokens.includes('alternate'), selectedSet)) continue;
    } else if (!sheetSetEnabled(title, false, selectedSet)) continue;
    if (seen.has(sheet)) continue;
    seen.add(sheet);
    let rules; try { rules = sheet.cssRules; } catch (_) { continue; }
    const chain = new Set(); if (sheet.href) chain.add(sheet.href);
    walk(rules, sheet.href || docBase, 0, chain);
  }
  const adopted = doc.adoptedStyleSheets;
  for (let i = 0; adopted && i < adopted.length; i++) {
    const sheet = adopted[i];
    if (!sheet || sheet.disabled || seen.has(sheet) || !adoptedSheetActive(sheet, vp)) continue;
    seen.add(sheet);
    keyOwner = sheet; at.n = 0;
    walk(sheet.cssRules, docBase, 0, new Set());
  }
  return out;
}
globalThis.__csimFontFaceRules = fontFaceRulesOf;

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
// A hand-listed lowercasing used to live here, for the seventeen properties whose keywords the
// cascade compares by text. `serializeCssValue` folds a keyword for EVERY property now — it asks
// the generated table whether the identifier is one of the property's own — so the list is gone
// rather than kept as a second mechanism that could disagree with the first.
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
function expandBorderShorthand(value) {
  let width = null, style = null, color = null;
  for (const tok of splitTopLevel(value, ' ')) {
    const t = tok.trim(); if (!t) continue;
    // The SAME classification the CSSOM registry uses (shorthands.js). This was a third copy of it
    // — a bare `/^[\d.]/` — which sent `calc(2px)` to the COLOUR slot, where the real colour then
    // overwrote it and the width fell back to `medium`. `border-inline-start: calc(2px) solid red`
    // painted a `medium` border in a page that asked for 2px, and the CSSOM and the cascade
    // disagreed about the same declaration.
    if (isLineStyle(t)) style = t.toLowerCase();
    else if (isLineWidth(t)) width = t;
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
// rules are appended per-sheet (cascadeRulesOf), so a constructable sheet's custom `baseURL`
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

// The `mask` shorthand (CSS Masking 1), layer by layer as `background` is: an image, a mode, a position with its size
// after a `/`, a repeat, one or two boxes (origin, then clip — `no-clip` a clip alone) and a compositing operator, each
// longhand its initial where a layer omits it. Unexpanded, every longhand under it read as the initial — `mask: url(#a)
// luminance` gave `mask-mode: match-source` where Chrome and Firefox say `luminance`.
const MASK_LONGHANDS = [
  ['mask-image',     'none'],
  ['mask-mode',      'match-source'],
  ['mask-position',  '0% 0%'],
  ['mask-size',      'auto'],
  ['mask-repeat',    'repeat'],
  ['mask-origin',    'border-box'],
  ['mask-clip',      'border-box'],
  ['mask-composite', 'add']
];
const MASK_MODE_KW = new Set(['alpha', 'luminance', 'match-source']);
const MASK_BOX_KW = new Set(['border-box', 'padding-box', 'content-box', 'fill-box', 'stroke-box', 'view-box']);
const MASK_COMPOSITE_KW = new Set(['add', 'subtract', 'intersect', 'exclude']);
function parseMaskLayer(layer) {
  const out = {};
  const positions = [], sizes = [], repeats = [], boxes = [];
  let afterSlash = false;
  for (const tok of splitTopLevel(layer.replace(/\//g, ' / '), ' ')) {
    const t = tok.trim(), lt = t.toLowerCase();
    if (!t) continue;
    if (t === '/') { afterSlash = true; continue; }
    if (afterSlash && sizes.length < 2 && isBgSizeToken(t)) { sizes.push(/^(cover|contain|auto)$/i.test(t) ? lt : t); continue; }
    afterSlash = false;
    if (lt === 'none' || BG_IMAGE_RE.test(t)) out['mask-image'] = t;
    else if (MASK_MODE_KW.has(lt)) out['mask-mode'] = lt;
    else if (BG_REPEAT_KW.has(lt)) repeats.push(lt);
    else if (MASK_BOX_KW.has(lt)) boxes.push(lt);
    else if (lt === 'no-clip') out['mask-clip'] = lt;
    else if (MASK_COMPOSITE_KW.has(lt)) out['mask-composite'] = lt;
    else positions.push(t);
  }
  if (positions.length) out['mask-position'] = positions.join(' ');
  if (sizes.length) out['mask-size'] = sizes.join(' ');
  if (repeats.length) out['mask-repeat'] = repeats.join(' ');
  if (boxes.length) {
    out['mask-origin'] = boxes[0];
    if (!out['mask-clip']) out['mask-clip'] = boxes[1] || boxes[0];
  }
  return out;
}
function expandMaskShorthand(value) {
  const v = value.trim();
  if (/^(inherit|initial|unset|revert|revert-layer)$/i.test(v)) return MASK_LONGHANDS.map(([prop]) => ({ prop, value: v.toLowerCase() }));
  const parsed = splitTopLevel(v, ',').map((layer) => parseMaskLayer(layer.trim()));
  return MASK_LONGHANDS.map(([prop, initial]) => ({ prop, value: parsed.map((p) => p[prop] ?? initial).join(', ') }));
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
const HAND_EXPANDED = new Set(['border', 'flex', 'background', 'mask', 'overflow', 'margin', 'padding',
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
  mask:              MASK_LONGHANDS.map(([p]) => p),
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
             : prop === 'mask'       ? expandMaskShorthand(value)
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
  // …and so is a value the property's grammar rejects — a shorthand's components included. The INLINE
  // surfaces have always run this check; the cascade did not, so a stylesheet's `align-items: -1px` not
  // only survived, it WON over the valid declaration beneath it — the same failure the math guard above
  // exists to prevent.
  if (!declarationIsValid(prop, value)) return;
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
    const prop   = cssPropertyName(node.property);
    const custom = prop.startsWith('--');
    // `parseValue:false` keeps the raw value text, which can still hold a
    // `/* … */` comment; strip it so exact compares (`display === 'none'`)
    // match — the old parser ran stripCssComments over the whole sheet first.
    let value = stripCssComments(CT.generate(node.value)).trim();
    // A property name a browser doesn't support is not a declaration at all — it never reaches the
    // CSSOM, and letting one through now that EVERY declaration is captured would let a stylesheet
    // shadow the computed-style interface (`#a { constructor: red }`).
    if (!custom && !isSupportedCssPropertyName(prop)) return;

    if (custom) { decls.push({ prop, value, important: !!node.important }); return; }
    // Canonical form is applied HERE, once per declaration per sheet parse (which the sheet cache
    // memoises), matching what the inline declaration block does on the way in — `.4s` is stored
    // as `0.4s`, `BLUR(2PX)` as `blur(2px)`. Doing it at read time instead meant a CSS parse per
    // property per element (rule 3).
    expandDeclaration(prop, value, !!node.important, (p2, v2, imp) => {
      decls.push({ prop: p2, value: serializeCssValue(v2, p2), important: imp });
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
  // …then an optional `layer` / `layer(name)` and an optional `supports(…)`, each before the media query — whose
  // conditions both hold of the import (css-cascade-5 §6.3). (The layer itself is not modelled: an imported sheet's
  // rules cascade unlayered.)
  let tail = rest.trim();
  const layer = /^layer(?:\s*\(\s*([^)]*?)\s*\))?(?=\s|$|supports\b)/i.exec(tail);
  if (layer) tail = tail.slice(layer[0].length).trim();
  let supports = null;
  const sm = /^supports\s*\(/i.exec(tail);
  if (sm) {
    let depth = 1, i = sm[0].length;
    for (; i < tail.length && depth > 0; i++) {
      if (tail[i] === '(') depth++;
      else if (tail[i] === ')') depth--;
    }
    // (…an unclosed one runs to the end of the prelude, as the end of a stylesheet closes a block.)
    supports = tail.slice(sm[0].length, depth === 0 ? i - 1 : i).trim();
    tail = tail.slice(i).trim();
  }
  return { url, media: tail || null, supports };
}
// Whether an `@import`'s conditions hold: its media query and its `supports()` (a condition that is not a valid one
// holds of nothing).
function importApplies(imp, vp) {
  if (imp.media && !mediaMatches(imp.media, vp)) return false;
  // (`supports()` takes a bare declaration as well as a condition — `supports(display: grid)` — which a condition wraps.)
  if (imp.supports != null && !supportsMatches(/^[\w-]+\s*:/.test(imp.supports) ? `(${imp.supports})` : imp.supports)) return false;
  return true;
}
function parseNamespacePrelude(prelude) {
  const m = /^\s*([A-Za-z_][\w-]*)?\s*(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)|"([^"]*)"|'([^']*)')\s*$/.exec(String(prelude || ''));
  if (!m) return null;
  const uri = (m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : m[6] || '').trim();
  return { prefix: m[1] || '', uri };
}
// One `@keyframes` rule as DATA: its animation name and its blocks, each an offset list in [0,1]
// and the declarations at those offsets. A selector a browser doesn't understand (`from`, `to` and
// percentages are the whole grammar) drops that block, and a rule with no usable block at all is
// not a keyframes rule.
function keyframesBlock(node, prelude) {
  const name = String(prelude || '').trim();
  if (!name || !node.block || !node.block.children) return null;
  const blocks = [];
  node.block.children.forEach((kid) => {
    if (kid.type !== 'Rule' || !kid.prelude) return;
    const sel = kid.prelude.type === 'Raw' ? kid.prelude.value : CT.generate(kid.prelude);
    const offsets = [];
    for (const part of String(sel).split(',')) {
      const t = part.trim().toLowerCase();
      if (t === 'from') { offsets.push(0); continue; }
      if (t === 'to')   { offsets.push(1); continue; }
      const m = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(t);
      if (!m) return;                       // one bad selector invalidates the whole block
      offsets.push(parseFloat(m[1]) / 100);
    }
    const decls = ruleDecls(kid.block);
    if (offsets.length && decls.length) blocks.push({ offsets, decls });
  });
  // An EMPTY `@keyframes` is still a rule: the animation it names exists, runs and fires its
  // events — it simply animates nothing (Chrome reports one from `getAnimations()`).
  return { name, blocks };
}

function cssTreeFlatten(cssText, vp) {
  const out = [];
  const imports = [];
  const fontSrcs = [];
  // `@keyframes` rules, in the order the sheet declares them — a later one of the same name wins,
  // which the document-level merge in `cascadeRulesOf` decides.
  const keyframes = [];
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
            const fm = FACE_SRC_URL_RE.exec(src.slice(node.loc.start.offset, node.loc.end.offset));
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
        if (name === 'keyframes' || name === '-webkit-keyframes') {
          // An ANIMATION's frames. Kept as data — offsets in [0,1] plus the block's declarations —
          // because that is all the animation model needs, and it has to survive the JSON round
          // trip through the cross-visit sheet cache like everything else parseSheet returns.
          const kf = keyframesBlock(node, prelude);
          if (kf) keyframes.push(kf);
          return;
        }
        if      (name === 'media')     { if (!mediaMatches(prelude, vp)) return; }
        else if (name === 'supports')  { if (!supportsMatches(prelude)) return; }
        else if (name === 'container') { if (!containerMatches(prelude, vp)) return; }
        else                           { return; }  // font-face/page/… skipped
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
  return { rules: out, layers, imports, fontSrcs, keyframes };
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
  // their `__subjPE` / `dynReqs` / `dynSubs` (noteDynamicRuleData). v8: `cxIndex.positions`. v9: `cxIndex.reach` (the
  // children a child-list change reaches, per side of the change point), and no `:has()` argument in the index.
  // v10: each rule's `layoutF` (`layoutFeatures`). v11: the sheet's `fontFaces` count. v12: a reach key is
  // `[parent, own]` tokens. v13: `layoutF` only on a rule that can move a box. v14: `fontFaces` the rules' texts.
  // v15: tag / attribute bucket keys ASCII-lowercased (`terminalKey`), as the element names they meet are.
  // v16: no `cxIndex`, `varGraph`, `layoutF`, `dynReqs` / `dynSubs` — the gates that read them went with the JS style
  // engine. v17: no `fontFaces` / `cssImage` — the sheet facts are the style engine's.
  return 'v17:' + text.length + ':' + (h >>> 0).toString(16) + ':' + vp.width + 'x' + vp.height;
}

// Parse one stylesheet's text into the per-rule `{hide, layout}`
// shape `cascadeRulesOf` wants. Pure: no read of `state`, no
// reference to surrounding document, so the result is safe to cache
// across visits.
function parseSheet(cssText, vp) {
  const hide   = [];
  const layout = [];
  let serial   = 0;
  let flat;
  // Empty result on parse failure is also cached — a malformed sheet
  // re-served on every visit shouldn't pay the parse cost each time.
  try { flat = cssTreeFlatten(cssText, vp); } catch (_) { return { hide, layout, count: 0, layers: [], imports: [], fontSrcs: [], keyframes: [] }; }
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
      // Computed at PARSE time so it rides the cross-visit sheet cache instead of being
      // re-derived per rule per navigation. (It parses the selector again rather than sharing
      // `terminalKey`s parse — cold cost, but see the note there.)
      const anc    = ancestorHashes(trimmed);
      const source = serial++;
      const hideRule   = hasHide   ? { selectorText: trimmed, term, anc, spec, source, layer: r.layer, ns: r.ns, display, displayImp, visibility, visibilityImp } : null;
      const layoutRule = hasLayout ? { selectorText: trimmed, term, anc, spec, source, layer: r.layer, ns: r.ns, captured } : null;
      noteDynamicRuleData(trimmed, hideRule, layoutRule);
      if (hideRule)   hide.push(hideRule);
      if (layoutRule) layout.push(layoutRule);
    }
  }
  return { hide, layout, count: serial, layers: flat.layers, imports: flat.imports || [], fontSrcs: flat.fontSrcs || [], keyframes: flat.keyframes || [] };
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
// `initiator` names the Resource Timing entry a FETCH here records ('css' for an `@import`;
// a `<link>` records its own entry from its load task) — a cache hit is the memory cache and
// records none, as Chrome.
function parseUrlSheetCached(url, vp, initiator = null) {
  const key = urlSheetCacheKey(url, vp);
  let hit = __sheetCache.get(key);
  if (hit) return hit;
  const body = urlSheetText(url, initiator);
  if (body == null) return null;
  hit = parseSheetCached(body, vp);
  __sheetCacheSet(key, hit);
  return hit;
}
// The text of the sheet at `url` — null when it could not be fetched, or a controlling service worker blocked it or
// answered with no body. (css-utils' `fetchStyleSheetText` fetches the same way; this one also records the Resource
// Timing entry of a fetch that is the NETWORK's — a service worker's answer records none — so it is its own.)
const IMPORT_TIMED = new Set();
function urlSheetText(url, initiator = null) {
  let body = null;
  const timingStart = initiator ? globalThis.performance.now() : 0;
  try {
    if (/^data:/i.test(url)) {
      body = decodeDataUrlCss(url);
    } else {
      // A controlling service worker answers first (destination 'style'; memoized
      // per URL in bridge.entry so the load-event/.sheet consumers share the SAME
      // dispatch + body). blocked / bodyless → the sheet contributes nothing
      // (NOT cached, like a failed fetch — the memo already pins the verdict).
      const sw = (typeof globalThis.__csimSwFetchStyle === 'function') ? globalThis.__csimSwFetchStyle(url) : null;
      if (sw) return sw.blocked ? null : sw.body;
      body = networkStyleSheetText(url);
    }
  } catch (_) {}
  // (…an `@import` once: the JS cascade and the style engine each ask for the sheet, and so does every rebuild — it is
  // ONE fetch to the page, as the memory cache makes it in a browser)
  if (initiator === 'css') {
    if (IMPORT_TIMED.has(url)) initiator = null;
    else IMPORT_TIMED.add(url);
  }
  if (initiator && typeof globalThis.__csimRecordResource === 'function') {
    const fields = typeof globalThis.__csimAssetTimingFields === 'function' ? globalThis.__csimAssetTimingFields(url, body)
                                                                            : { body: body != null ? body : undefined, status: body != null ? 200 : undefined };
    globalThis.__csimRecordResource({ name: url, initiatorType: initiator, startTime: timingStart, ...fields });
  }
  return body;
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
// …kept per parsed rule for the base it was resolved against: a document's second rebuild (a sheet linked in its body)
// resolved every rule's image again.
const RESOLVED_CAPTURED = new WeakMap();
function resolveCapturedImageUrls(captured, base) {
  const bi = captured && captured['background-image'];
  if (!bi || typeof bi.value !== 'string' || bi.value.indexOf('url(') === -1) return captured;
  const kept = RESOLVED_CAPTURED.get(captured);
  if (kept !== undefined && kept.base === base) return kept.captured;
  const out = { ...captured, 'background-image': { value: resolveCssUrls(bi.value, base), important: bi.important, order: bi.order } };
  RESOLVED_CAPTURED.set(captured, { base, captured: out });
  return out;
}

const __swFontFetched = new Set();
function swFetchFontSrcs(srcs, base) {
  if (!srcs || !srcs.length || typeof globalThis.__csimSWControllerHandle !== 'function' ||
      (globalThis.__csimSWControllerHandle() | 0) <= 0) return;
  for (const fs of srcs) {
    let fabs = fs;
    try { fabs = new URL(fs, base || undefined).href; } catch (_) { continue; }
    if (!/^https?:/i.test(fabs) || __swFontFetched.has(fabs)) continue;
    __swFontFetched.add(fabs);
    try { globalThis.__csimSwFetchDest(fabs, 'font', 'cors', 'same-origin', true); } catch (_) {}
  }
}
// The first `url()` a face's `src` names (`cssTreeFlatten`'s `fontSrcs`, the engine's face text alike).
const FACE_SRC_URL_RE = /src\s*:[^;}]*url\(\s*(['"]?)([^'")]+)\1\s*\)/i;
function pushSheetWithImports(sheets, parsed, baseHref, vp, seen) {
  // A CONTROLLED document's @font-face src FETCHES through its service worker
  // (destination 'font', response discarded — glyph rendering isn't modeled, the
  // fetch is the observable). Once per URL per realm; uncontrolled documents pay
  // one array-length check.
  // The controller gate runs BEFORE the dedup Set (same rule as swFetchStyle /
  // swDiscardFetch): an UNCONTROLLED collect must not pin the URL as fetched, or
  // a later clients.claim() would never observe the font fetch.
  swFetchFontSrcs(parsed && parsed.fontSrcs, baseHref);
  const imps = parsed && parsed.imports;
  if (imps && imps.length) {
    for (const imp of imps) {
      if (!importApplies(imp, vp)) continue;
      let abs;
      try { abs = new URL(imp.url, baseHref || undefined).href; } catch (_) { continue; }
      if (seen.has(abs)) continue;
      seen.add(abs);
      const parsed = parseUrlSheetCached(abs, vp, 'css');
      // An imported sheet's own relative URLs resolve against ITS url, not the importer's.
      if (parsed) pushSheetWithImports(sheets, parsed, abs, vp, seen);
    }
  }
  // Carry the sheet's base URL alongside the (text-cached, base-independent) parse, so the append
  // step can absolutize `background-image` url()s against the correct originating sheet.
  sheets.push({ sheet: parsed, base: baseHref });
}
// The document's sheets in the order the cascade takes them — in TREE order, `<style>` and `<link>` alike
// (`styleSheetOwners`), then the adopted ones — each parsed, with its `@import`s after it (`pushSheetWithImports`).
function collectSheets(doc, selectedSet) {
  const sheets = [];
  if (!doc || !doc.documentElement) return { sheets };
  selectedSet = selectedSet || '';
  const vp = currentViewport();
  // getElementsByTagName (an HTMLCollection), NOT querySelectorAll (a static
  // NodeList whose length reads through the page-tamperable
  // `NodeList.prototype.length` — NodeList-static-length-getter-tampered-3.html
  // tampers it mid-parse under streaming, which would make this iteration yield
  // undefined and throw). The HTMLCollection's length is immune.
  // @import resolution: `importSeen` guards cycles/dups across all sheets;
  // `docBase` is the base URL for relative @imports AND background-image url()s in inline
  // <style> elements — the document's BASE URL (respecting `<base href>`), not the raw location.
  const importSeen = new Set();
  const docBase = documentBaseUrl();
  // Stylesheet-set selection (alternate / preferred / default-style). `selectedSet`
  // is resolved once by cascadeCacheKey and threaded in, so it matches the key
  // exactly (no recompute, no cache collision). `sheetSetEnabled` returns true for
  // a persistent (titleless non-alternate) sheet, so the common page is unaffected.
  for (const owner of styleSheetOwners(doc.documentElement)) {
    if (owner._tag === 'style') {
      const s = owner;
      if (!styleElementIsCss(s) || sheetDisabled(s)) continue;
      const media = s._attrs.media;
      if (media && !mediaMatches(media, vp)) continue;
      const title = (s._attrs.title || '').trim();
      if (!sheetSetEnabled(title, false, selectedSet)) continue;  // <style> can't be alternate
      const txt = effectiveStyleCss(s);
      const parsed = txt ? parseSheetCached(txt, vp) : null;
      if (parsed) pushSheetWithImports(sheets, parsed, docBase, vp, importSeen);
      continue;
    }
    const l = owner;
    const tokens = asciiTokens(asciiLower(l._attrs.rel || ''));
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
    const parsed = txt ? parseSheetCached(txt, vp) : null;
    if (parsed) pushSheetWithImports(sheets, parsed, sheet._href || docBase, vp, importSeen);
  }
  return { sheets };
}

// The rule set of `sheets` (`collectSheets`): the hide and layout rules, each with its document-wide source order and
// its layer's rank, and the `@keyframes` by name.
function cascadeRulesOf(sheets) {
  const hide   = [];
  const layout = [];
  // Merge layer names (first-appearance across sheets) → post-order ranks.
  const ordered = [];
  const seen = new Set();
  for (const { sheet: sh } of sheets) for (const nm of (sh.layers || [])) if (!seen.has(nm)) { seen.add(nm); ordered.push(nm); }
  const layerRank = buildLayerRanks(ordered);
  // Append rules in document order; resolve each rule's cacheable layer NAME
  // to its rank. Shift `source` by the running serial so cross-sheet ties
  // break correctly (later sheets win at equal specificity).
  const rankOf = (r) => r.layer != null ? layerRank.get(r.layer) : null;
  // `@keyframes` are keyed by NAME across the whole document, and the last rule to declare a name
  // wins outright — a keyframes rule has no specificity to compete on (css-animations §3).
  const keyframes = new Map();
  let serial = 0;
  for (const { sheet: sh, base: sheetBase } of sheets) {
    for (const r of sh.hide)   hide  .push({ ...r, source: r.source + serial, layerRank: rankOf(r) });
    for (const r of sh.layout) layout.push({ ...r, captured: resolveCapturedImageUrls(r.captured, sheetBase), source: r.source + serial, layerRank: rankOf(r) });
    for (const kf of (sh.keyframes || [])) keyframes.set(kf.name, kf.blocks);
    serial += sh.count;
  }
  return { hide, layout, keyframes };
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
// A quirks-mode document matches class and id selectors ASCII case-insensitively (Selectors 4 §6.6 / §6.7), so their
// buckets are keyed lowercased there, and `walkIndex` asks with the element's identifiers lowercased to match.
function bucketFor(idx, term) {
  let map, key = term.key;
  if (term.kind === 'class')     { map = idx.byClass; if (state.quirks) key = asciiLower(key); }
  else if (term.kind === 'id')   { map = idx.byId; if (state.quirks) key = asciiLower(key); }
  else if (term.kind === 'tag')  map = idx.byTag;
  else if (term.kind === 'attr') map = idx.byAttr;
  else if (term.kind === 'root') return idx.root;
  else if (term.kind === 'none') return null;               // a pseudo-element subject: no element matches
  else return idx.universal;
  let b = map.get(key);
  if (b === undefined) map.set(key, b = newBucket());
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
    const quirks = state.quirks;
    const idAttr = el._attrs.id;
    if (idAttr) {
      const idB = idx.byId.get(quirks ? asciiLower(idAttr) : idAttr);
      if (idB) walkBucket(idB, cb, pairs);
    }
    for (const c of classes(el)) {
      const cB = idx.byClass.get(quirks ? asciiLower(c) : c);
      if (cB) walkBucket(cB, cb, pairs);
    }
    if (idx.byAttr.size) {
      // Attribute keys are case-preserved on non-HTML elements (`viewBox`) and the bucket key is
      // lowercase, so a name that differs only in case is tried folded too.
      for (const name in el._attrs) {
        let aB = idx.byAttr.get(name);
        if (aB === undefined && /[A-Z]/.test(name)) aB = idx.byAttr.get(asciiLower(name));
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
// The dynamic pseudo-classes EVERY writer of which moves the style state (`bumpStyleState`) or marks the writer's subtree
// (an attribute write): hover and focus, a popover, a definition and a custom state, bumped where they change; `open`,
// an attribute. A flip of one of them moves the layout stamp of
// every box its rule can reach, so a read that considered only these is no taint to a memo kept under that stamp
// (`untrackedReadSeq`). The rest are not: a clean control's checkedness and value are its ATTRIBUTES' (`:checked`,
// `:placeholder-shown`, `:valid` …), a form's validity is its controls', `:dir()` follows `dir=auto` text, `:target` an
// `id`, and a modal dialog stops being `:modal` with its `open` attribute — each changes with no bump, and a kept slice
// replayed the box from before.
const STAMP_TRACKED_PSEUDOS = new Set(['hover', 'focus', 'focus-within', 'focus-visible', 'popover-open', 'open', 'defined',
  'state']);
// Whether a rule's selector is dynamic: false, or which of the two kinds above it names (any untracked one makes it
// untracked). Kept on the rule and on everything derived from it, as one field.
const DYN_TRACKED = 1, DYN_UNTRACKED = 2;
// A selector's text with its CSS ESCAPES resolved, for a scan that looks for pseudo-class names. An escape stands
// for its character (`:h\61s(` IS `:has(`, and the matchers read it so), except that a character which would be
// SYNTAX here stays part of an identifier: Tailwind's variant classes (`.hover\:bg-red-500`, `.md\:flex`) are one
// class each, and reading them as `:bg-red-500` / `:flex` marked most of a utility-CSS page dynamic.
const CSS_ESCAPE_RE = /\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([^\n\r\f0-9a-fA-F])/g;
function selectorSyntaxText(raw) {
  if (raw.indexOf('\\') === -1) return raw;
  return raw.replace(CSS_ESCAPE_RE, (_, hex, ch) => {
    const cp = hex ? parseInt(hex, 16) : -1;
    const c = hex ? (cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : '\uFFFD') : ch;
    return /^[-\w]$/.test(c) ? c : '_';
  });
}
function ruleIsDynamic(rule) {
  if (rule.__dynamicSel !== undefined) return rule.__dynamicSel;
  let dynamic = false;
  const sel = selectorSyntaxText(rule.selectorText || '');
  if (sel.indexOf(':') !== -1) {
    PSEUDO_NAME_RE.lastIndex = 0;
    let m;
    while ((m = PSEUDO_NAME_RE.exec(sel))) {
      // A pseudo-ELEMENT is not a state: it styles generated content, not this element's own
      // computed value. Both spellings — CSS3 `::before` and the legacy single-colon `:before` that
      // Bootstrap-era CSS still ships — are skipped, or a `.clearfix:before` rule would cost every
      // element it matches the caching of the properties it declares.
      const name = m[2].toLowerCase();
      if (m[1] === '::' || LEGACY_PSEUDO_ELEMENTS.has(name) || STATIC_PSEUDOS.has(name)) continue;
      dynamic = DYN_TRACKED;
      if (!STAMP_TRACKED_PSEUDOS.has(name)) { dynamic = DYN_UNTRACKED; break; }
    }
  }
  rule.__dynamicSel = dynamic;
  return dynamic;
}

// A monotonic counter, bumped whenever a read considers a dynamic rule — or is otherwise one the declared-value memo
// must not keep (`noteUnmemoisedRead`, `noteUncacheableRead`). A caller brackets its read
// by comparing the value before and after — which, unlike a flag, survives RE-ENTRY: a nested read
// (a `var()` lookup, a font-size resolution) only pushes the counter further, and the outer caller
// still sees a difference. Nothing ever resets it.
let dynamicSeq = 0;
export function dynamicReadSeq() { return dynamicSeq; }
// …and the part of it no LAYOUT STAMP tracks either, for a memo kept under `memoStamp` (layout.js): the clock
// (`noteUncacheableRead`), and a dynamic-state rule some writer of which flips it unseen (`STAMP_TRACKED_PSEUDOS`).
// A flip every writer of which is seen, and a change that could start a transition, are style changes, which dirty
// what they restyle (layout.js `markRestyles`), so such a memo needs no bracket for either.
let untrackedSeq = 0;
export function untrackedReadSeq() { return untrackedSeq; }
// …and the part of it that IS tracked: a rule naming only states every writer of which bumps the style state
// (`STAMP_TRACKED_PSEUDOS`). A read whose whole taint is this is good while the style state holds (`declaredValueIn`).
let trackedSeq = 0;
export function trackedReadSeq() { return trackedSeq; }
// …which a read served such a value hands on to whatever read encloses it.
export function noteTrackedStateRead() { dynamicSeq++; trackedSeq++; }
// Only the cache VERIFIER uses this: its recompute runs inside an outer read's bracket and must not
// be mistaken for that read's own taint.
export function restoreDynamicSeq(seq, untracked, tracked) { dynamicSeq = seq; untrackedSeq = untracked; trackedSeq = tracked; }
// Diagnostic: the classifier's verdict for a selector, so a spec can assert it directly. Testing it
// through a colour only works when the state can actually be toggled — the vendor-prefixed case
// can't be, so its guard passed against the very regression it was written for.
globalThis.__csimSelectorIsDynamic = (selectorText) => !!ruleIsDynamic({ selectorText: String(selectorText) });
// …and whether some writer of the state it names flips it unseen by the layout stamps (`STAMP_TRACKED_PSEUDOS`).
globalThis.__csimSelectorIsUntracked = (selectorText) => ruleIsDynamic({ selectorText: String(selectorText) }) === DYN_UNTRACKED;
// (…never for a rule whose selector cannot be compiled, `unmatchable`: it matches in no state, so no read that
// considered it depends on one.)
function noteDynamic(rule) {
  const dynamic = !rule.unmatchable && ruleIsDynamic(rule);
  if (!dynamic) return;
  dynamicSeq++;
  if (dynamic === DYN_UNTRACKED) untrackedSeq++;
  else trackedSeq++;
}
// A value that depends on something the epochs do NOT track — today, the CLOCK: an animation or a
// transition reports a different value at a different moment with nothing about the document
// having changed. Marking the read taints it exactly as a dynamic selector does, so the
// declared-value memo declines to keep it and the next read asks again.
export function noteUncacheableRead() { dynamicSeq++; untrackedSeq++; }
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

// ── the native author cascade (csim_native cascade.rs) ──────────────────────────────────────────────────────
// Every layout rule is loaded into the native store once per rule set, and one crossing answers for an element:
// the winning declaration of every property its STATIC rules declare — a selector the arena matcher compiles,
// reading no state the generations do not track — and, unmatched, the other rules its buckets select. Those are
// matched here per read as before; a rule is in exactly one half, and `winsProp` is a total order, so the winner
// of the two winners is the cascade's.
//
// Which rules are static is what the per-read path already decides for them: a dynamic or `:has()` rule taints
// the read that considers it (`noteDynamic` / `ruleLooksDown`), a `:host()`-prefixed one asks its host first, a
// namespaced one is css-select's — and none of those is moved. What the answer holds is a function of the
// element's structural context alone, which is what `ctxEpochOf` keys, so it is kept under that and the style
// epoch, exactly as the declared-value memo keeps what is computed from it.
// The style attribute's declaration of a property as the cascade compares it: above every selector at equal
// importance (`inline`), which `winsProp` reads off the incumbent.
const NO_INLINE_RECORDS = new Map();
function inlineRecord(d) {
  return { value: d.value, important: d.important, spec: [0, 0, 0], source: Infinity, inline: true, order: d.order };
}
function nativeRuleStatic(r) {
  if (r.unmatchable || r.ns || r.hostRule !== undefined || ruleIsDynamic(r) || ruleLooksDown(r)) return false;
  let h = r._natSel;
  if (h === undefined) h = r._natSel = globalThis.__dom.compileSelector(r.selectorText);
  return h >= 0;
}
const NATIVE_TERM_KINDS = { class: 1, id: 2, tag: 3, attr: 4, root: 5 };
function buildNativeCascade(rules) {
  const propIds = new Map(), props = [], decls = [], nums = [], keys = [], keyIds = new Map(), loaded = [];
  for (const r of rules) {
    const cap = r.captured;
    if (cap == null || r.term.kind === 'none') continue;
    const kind = NATIVE_TERM_KINDS[r.term.kind] || 0;
    let keyId = -1;
    if (kind !== 0 && kind !== 5) {
      // …keyed as `bucketFor` keys it: a class or id lowercased in a quirks-mode document.
      const key = state.quirks && (kind === 1 || kind === 2) ? asciiLower(r.term.key) : r.term.key;
      keyId = keyIds.get(key);
      if (keyId === undefined) { keyIds.set(key, keyId = keys.length); keys.push(key); }
    }
    const matched = nativeRuleStatic(r);
    const head = nums.length;
    nums.push(matched ? r._natSel : -1, r.spec[0], r.spec[1], r.spec[2], r.source, r.layerRank == null ? 0 : 1,
              r.layerRank == null ? 0 : r.layerRank, kind, keyId, 0);
    loaded.push(r);
    if (!matched) continue;
    let n = 0;
    for (const prop in cap) {
      const c = own(cap, prop);
      if (!c) continue;
      let p = propIds.get(prop);
      if (p === undefined) { propIds.set(prop, p = props.length); props.push(prop); }
      nums.push(p, decls.length, c.important ? 1 : 0);
      decls.push({ value: c.value, important: c.important, spec: r.spec, source: r.source, layerRank: r.layerRank, order: c.order });
      n++;
    }
    nums[head + 9] = n;
  }
  // A store that did not take every rule would answer for a subset — then nothing is answered natively.
  if (globalThis.__dom.cascadeLoad(new Float64Array(nums), keys, props.length, state.quirks) !== loaded.length) return null;
  return { rules: loaded, props, decls, out: new Int32Array(2 + 2 * props.length + loaded.length) };
}
// The native store for `el`'s reads, or null when the element is not one it can answer (no arena node — one built
// before `__dom`), or the timing mode keeps every match on the path it measures. (A shadow-tree element never asks:
// `cascadedRecord` walks its own tree's rules.)
function nativeCascadeFor(el) {
  if (!cascadeAuthoritative || cascadeTiming || arenaNid(el) < 0) return null;
  let nat = state.nativeCascade;
  if (nat === null) nat = state.nativeCascade = buildNativeCascade(state.layoutRules) || false;
  return nat || null;
}
// `el`'s answer — `won`, property → winning declaration record (the store's, shared and never written), `js`, the
// rules to match here, and `inline`, property → the style attribute's declaration as a cascade record — or null when
// the store could not answer and the caller walks the index itself. Kept under the cascade version (a new rule set
// is a new store) and the element's context, which ANY write to its own attributes moves (`ctxAttrEffect`) — its
// `style` included.
function nativeAnswer(el, nat) {
  const ctx = ctxEpochOf(el);
  if (el._nwinCtx === ctx && el._nwinEp === cascadeVersion) return el._nwin;
  let ans = null;
  let n = globalThis.__dom.cascadeWinners(arenaNid(el), nat.out);
  // The realm's store is gone (its arena was reset under this rule set): load it again — a new store, with its own
  // declaration numbering — and ask that.
  if (n === -2) {
    nat = state.nativeCascade = buildNativeCascade(state.layoutRules) || false;
    n = nat ? globalThis.__dom.cascadeWinners(arenaNid(el), nat.out) : -1;
  }
  if (n >= 0) {
    const out = nat.out, w = out[0], c = out[1], won = new Map(), js = new Array(c);
    for (let i = 0; i < w; i++) won.set(nat.props[out[2 + 2 * i]], nat.decls[out[3 + 2 * i]]);
    for (let i = 0; i < c; i++) js[i] = nat.rules[out[2 + 2 * w + i]];
    const decls = inlineDecls(el);
    let inline = NO_INLINE_RECORDS;
    for (const prop in decls) {
      if (inline === NO_INLINE_RECORDS) inline = new Map();
      inline.set(prop, inlineRecord(decls[prop]));
    }
    ans = { won, js, inline };
    cascNatAnswers++;
  }
  el._nwin = ans; el._nwinEp = cascadeVersion; el._nwinCtx = ctx;
  return ans;
}
// The rules that style GENERATED CONTENT — a subject of `::before` / `::after` (either spelling),
// which `terminalKey` keeps out of every element's walk — re-keyed on the selector WITHOUT the
// pseudo-element, so they can be matched against the originating element the same way any rule
// is, and indexed per property like the layout rules. Derived lazily from the same rule list (no
// second collection, nothing new in the cross-visit sheet cache), and reset with the layout index.
function buildPseudoIndex(which, rules) {
  const idx = new Map();
  for (const r of rules) {
    if (r.term.kind !== 'none' || r.captured == null) continue;
    const m = INDEXED_PSEUDO_RE.exec(r.selectorText);
    const name = m && m[1].toLowerCase();
    if (!m || (PSEUDO_INDEX_ALIAS[name] || name) !== which) continue;
    let stripped = r.selectorText.slice(0, m.index).trim();
    if (!stripped) stripped = '*';
    const term = terminalKey(stripped);
    // `::picker(select)::before`, `::details-content::before` — a pseudo OF a pseudo-element, which
    // nothing here renders; its stripped subject is still a pseudo-element and has no bucket.
    if (term.kind === 'none') continue;
    const derived = { ...r, ...SELECTOR_DERIVED, selectorText: stripped, term, anc: ancestorHashes(stripped), pseudo: which };
    for (const prop in r.captured) {
      const c = own(r.captured, prop);
      if (!c) continue;
      let sub = idx.get(prop);
      if (sub === undefined) idx.set(prop, sub = newIndex());
      bucketPush(bucketFor(sub, derived.term), derived, [derived, c]);
    }
  }
  return idx;
}
function pseudoIndex(which) {
  ensureCascadeFresh();
  const all = state.pseudoIdx ??= { before: null, after: null, placeholder: null, any: undefined };
  return (all[which] ??= buildPseudoIndex(which, state.layoutRules));
}
// …and a SHADOW TREE's own, from its sheets (the document's do not reach into it, and its own do
// not leave it — the encapsulation `cascadedRecord` has for element rules). Cached on the root
// against the rule array `scopedRulesFor` hands out, which changes identity when the sheets do.
function shadowPseudoIndex(sr, which) {
  const rules = scopedRulesFor(sr).layout || [];
  let cache = sr._pseudoIdx;
  if (!cache || cache.rules !== rules) cache = sr._pseudoIdx = { rules, before: null, after: null, placeholder: null };
  if (cache[which] === null) cache[which] = buildPseudoIndex(which, rules);
  return cache[which];
}
// Whether ANY rule gives a `::before` / `::after` a `content` — the O(1) gate the layout asks per
// `flatTreeChildren` call before it looks for generated content on an element.
export function pseudoDeclaresProperty (which, prop) {
  return pseudoIndex(which).has(prop);
}
// Could ANY `content` rule for `which` match `el` — the bucket test `walkIndex` would make, without
// the walk, the matching, or the declared-value machinery behind it? Asked per element per layout
// pass; on a Bootstrap-shaped page nearly every element fails it on a tag and a class lookup
// (measured: resolving the content through the full read cost a 6000-element page 13%).
export function pseudoContentCandidate (el, which) {
  if (el._tag === 'q' && el._ns === HTML_NS) return true;   // (…HTML's sheet quotes a `<q>`)
  const sr = globalThis.__csimShadowHostCount ? enclosingShadowRootOf(el) : null;
  const sub = (sr ? shadowPseudoIndex(sr, which) : pseudoIndex(which)).get('content');
  if (sub === undefined) return false;
  if (sub.universal.plain.length || sub.universal.byAnc.size) return true;
  if (sub.byTag.has(el._tag)) return true;
  // …asked as `bucketFor` keyed it: a class or id ASCII-lowercased in a quirks-mode document.
  const quirks = state.quirks, id = el._attrs.id;
  if (id && sub.byId.has(quirks ? asciiLower(id) : id)) return true;
  if (sub.byClass.size) for (const c of classes(el)) if (sub.byClass.has(quirks ? asciiLower(c) : c)) return true;
  if (sub.byAttr.size) for (const name in el._attrs) if (sub.byAttr.has(name) || sub.byAttr.has(asciiLower(name))) return true;
  return (sub.root.plain.length || sub.root.byAnc.size) && el._parent && el._parent.nodeType === NODE_DOC;
}
// The O(1) "could anything declare `prop` on THIS element" gate the hot readers ask before a
// cascade read: a rule (the index), the style attribute, an animation — or, for a generated-content
// box, a pseudo-element rule, which the index keeps out.
export function elementMayDeclare (el, prop) {
  if (el._pseudo) return pseudoDeclaresProperty(el._pseudo, prop);
  return cascadeDeclaresProperty(prop) || prop in inlineDecls(el) || animationsDeclareProperty(el, prop);
}
export function documentHasGeneratedContent () {
  // (…the style engine answers per element, `styleEngineGenerated`, and keeps no page-wide index to ask)
  if (engineAnswers()) return true;
  if (globalThis.__csimQuoteElement) return true;
  const before = pseudoIndex('before'), after = pseudoIndex('after'), all = state.pseudoIdx;
  if (all.any === undefined) all.any = before.has('content') || after.has('content');
  return all.any;
}
// The winning declaration of `prop` for the generated-content box `pseudo` (a node whose `_parent`
// is the originating element): the pseudo rules that match that element, no inline style.
function cascadedPseudoRecord(pseudo, prop) {
  const el = pseudo._parent;
  const sr = globalThis.__csimShadowHostCount ? enclosingShadowRootOf(el) : null;
  const sub = (sr ? shadowPseudoIndex(sr, pseudo._pseudo) : pseudoIndex(pseudo._pseudo)).get(prop);
  if (sub === undefined) return null;
  let best = null;
  walkIndex(sub, el, (r, cap) => {
    noteDynamic(r);
    if (!safeMatches(el, r)) return;
    if (winsProp(best, r.spec, r.source, cap.important, r.layerRank)) {
      best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source, layerRank: r.layerRank, order: cap.order };
    }
  }, true);
  return best;
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
    out[prop] = { value: prop.startsWith('--') ? value : serializeCssValue(value, prop), important, order };
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

// Is `el` a fieldset's RENDERED LEGEND (HTML §15.3.13)? A question about BOXES — layout.js's `renderedLegend`, which
// bridge.entry.js hands over (layout.js imports this module, so it cannot be imported back).
let renderedLegendTest = () => false;
export function setRenderedLegendTest(fn) {
  renderedLegendTest = fn;
}
export function isRenderedLegend(el) {
  return renderedLegendTest(el);
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
  const cascaded = (dv !== undefined ? declaredValueIn(dv, el, prop) : declaredValue(el, prop)) ?? uaDefault(el, prop);
  // A CSS-WIDE KEYWORD is not a length, and the cascade hands it through verbatim — so it stands
  // for something else here, or the box silently loses the edge while getComputedStyle reports it.
  // The gate is a first-character test because this runs for every `auto` / `none` / `max-content`
  // on the page: every one of the keywords starts with `i`, `u` or `r`.
  const raw = maybeCssWide(cascaded) ? cssWideStandsFor(el, prop, cascaded, 0) : cascaded;
  const px = parsePx(raw);
  if (px != null) return px;
  // An intrinsic-size KEYWORD is no length, but the caller that asked with an `info` may size the
  // box from what it holds (layout.js `usedSize` / `intrinsicWidths`) — reported here, off the
  // one read this function already made, rather than read a second time for every auto box.
  if (info) {
    // (…and a fieldset's RENDERED LEGEND sizes its auto width as `fit-content`: it is shrink-to-fit, whatever display
    // it has — HTML's rendering of fieldset and legend; Chrome, 8px for a legend of "x" whether `block`, `table` or
    // `inline`)
    if (prop === 'width' && el._tag === 'legend' && (raw == null || String(raw).trim().toLowerCase() === 'auto') && isRenderedLegend(el)) {
      info.keyword = 'fit-content';
      return null;
    }
    const c = String(raw).charCodeAt(0);
    if (c === 109 /* m */ || c === 102 /* f */ || c === 77 || c === 70) {
      const k = String(raw).trim().toLowerCase();
      if (k === 'min-content' || k === 'max-content' || k === 'fit-content') { info.keyword = k; return null; }
    }
  }
  // FONT-RELATIVE units (em / rem / ex / ch / pt …). Modern app CSS is written in
  // rem (Bootstrap, Tailwind) — resolving only px left every such padding, margin
  // and border at 0, so the box model didn't reach the stylesheets that matter.
  // The resolution is style-proxy's (the same one getComputedStyle uses); for
  // `font-size` itself the em basis is the PARENT's size, as the spec says.
  return lengthTextTail(el, raw, basis, info, prop === 'font-size');
}
// The tail of the resolution above, for a caller that holds the TEXT and no property to read it from — a
// piece of a `gap` shorthand, the length component of a `text-indent`. Factored out rather than re-spelled:
// two such callers had written their own partial version of it — `lengthOrFraction` (a bare length or a bare
// percentage and nothing else, and the caller's `?? GAP_NONE` turned that into a silent zero) and
// `textIndentOf` (split on white space, `parseFloat` per piece, which read `calc(10% + 1px)` as 1px) — and
// both were a silent 0 or a wrong number on a value this function already resolves.
// `lengthPx` in layout.js is a THIRD and is still one: it knows neither a percentage nor a math function.
// `parseTrack` read a grid template through it alone until 2026-09-23 — a `calc()` track came back null and
// one invalid track invalidates the whole template, so `grid-template-columns: calc(25% + 10px) 1fr` was ONE
// column in both engines — and reduces the length itself now. `lengthPx` is still the arm for a plain px
// there, which is all it has ever been able to answer.
// The COMPARISON functions, which are the only way a math value BENDS with its basis: `calc()` allows
// `+ - * /` and CSS Values 4 lets a `/` divide by a NUMBER only, so a value built of `calc()` alone is AFFINE
// in its basis by the grammar and two evaluations give it exactly. Layout's linear reductions ask this before
// they reduce anything; it lives here because both `layout.js` and `style-proxy.js` need it and both already
// import from this module.
export const PIECEWISE_MATH_RE = /(?:^|[^\w-])(?:min|max|clamp)\s*\(/i;
// A declared LENGTH / PERCENTAGE / math function as px against a basis, for a caller that holds the TEXT and
// has no property to read it from. A plain px FIRST — `resolveLayoutProp` has already returned on one before
// it delegates, so that step is for the standalone callers, and its absence is what made `text-indent: 40px`
// resolve to nothing the first time this was factored out: the caller that used to `parseFloat` the text now
// asked a function whose first step assumed the px case was already gone.
// NOT a general "resolve this value": CSS-WIDE keywords (`inherit`) and intrinsic-size keywords are the
// caller's to deal with before it gets here, as `resolveLayoutProp` does.
export function lengthTextToPx(el, raw, basis, info = null, forFontSize = false) {
  const px = parsePx(raw);
  if (px != null) return px;
  return lengthTextTail(el, raw, basis, info, forFontSize);
}
// …and the tail alone, for `resolveLayoutProp`, which has done the `parsePx` and the keyword arm already and
// must not pay for either twice (25 ns a call on the hottest path in the engine).
function lengthTextTail(el, raw, basis, info, forFontSize) {
  // FONT-RELATIVE units (em / rem / ex / ch / pt …). Modern app CSS is written in
  // rem (Bootstrap, Tailwind) — resolving only px left every such padding, margin
  // and border at 0, so the box model didn't reach the stylesheets that matter.
  const fontPx = fontRelativeToPx(el, raw, forFontSize);
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
// Could this value be a CSS-wide keyword? A first-character test, so the two string allocations
// `isCssWideKeyword` makes are paid only by a value that might be one — not by every `auto`,
// `none` and `max-content` a layout pass resolves.
const CSS_WIDE_FIRST = new globalThis.Set([105 /* i */, 117 /* u */, 114 /* r */]);
export function maybeCssWide(v) {
  if (v == null) return false;
  const s = String(v);
  return CSS_WIDE_FIRST.has(s.charCodeAt(0) | 32) && isCssWideKeyword(s);
}

// What a CSS-wide keyword STANDS FOR, as a declaration the caller then resolves in ITS OWN context.
//
// `inherit` is the parent's COMPUTED value — which is not the parent's used value, and the
// difference is a box: a length computes in the PARENT's font (so it comes back as px), while a
// PERCENTAGE stays a percentage, because the child re-resolves it against its own containing block.
// Chrome, `padding: 10%` on a 400px block with a `padding: inherit` child: the child's padding is
// 32px — 10% of ITS 320px block — not the parent's 40. Going through the parent's used value said
// 40, and made `height: inherit` under an auto-height parent 0 rather than auto.
//
// `revert` is the UA sheet's value, which is what makes it meaningful on a form control at all.
// `initial` — and `unset` on a property that does not inherit — stand for the initial value, which
// for every box-model property is `auto` or `0`: no length to hand back, so `null`.
export function cssWideStandsFor(el, prop, keyword, depth = 0) {
  const kw = String(keyword).trim().toLowerCase();
  if (kw === 'revert' || kw === 'revert-layer') return uaDefault(el, prop) ?? null;
  if (kw !== 'inherit' && !(kw === 'unset' && INHERITED_PROPERTIES.has(prop))) return null;
  // CSS inherits through the FLAT tree, so `inherit` takes the SLOT's declaration for slotted content and
  // the HOST's for a shadow-tree element, exactly as `computeFlowSides` does — reading `_parent` here made
  // a `height: inherit` box inside a slot take the host's 10px where Chrome gives it the slot's 0.
  const parent = flatTreeParent(el);
  if (!parent || parent.nodeType !== NODE_ELEMENT || depth > 32) return null;
  const up = declaredValue(parent, prop) ?? uaDefault(parent, prop);
  if (up == null) return null;                            // the parent's own initial: nothing to take
  if (maybeCssWide(up)) return cssWideStandsFor(parent, prop, up, depth + 1);
  const fontPx = fontRelativeToPx(parent, up, prop === 'font-size');
  return fontPx != null ? `${fontPx}px` : String(up);
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
function winsProp(current, candSpec, candSource, candImp, candLayerRank, candOuterness = 0) {
  if (!current) return true;
  if (candImp && !current.important) return true;
  if (!candImp && current.important) return false;
  const context = contextWins(current, candOuterness, candImp);
  if (context !== null) return context;
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
  // through the same winsCascade ladder, a `:host` / `::slotted()` one sorted on
  // CONTEXT against the document's (`contextWins`).
  // Shadow ENCAPSULATION, the same gate cascadedProperty applies: an element inside a shadow tree
  // is not matched by document-scope author rules — only by its own tree's sheets. Without this a
  // page-level `.invis { display: none }` reaches into every shadow tree that happens to use the
  // class and hides content the browser renders. (A slotted light child lives in the OUTER scope —
  // enclosingShadowRootOf returns null for it — so document rules still reach it, as they should.)
  const enclosingRoot = globalThis.__csimShadowHostCount ? enclosingShadowRootOf(el) : null;
  const documentRules = enclosingRoot ? [] : state.hideRules;
  const shadowHide = shadowRulesForEl(el, 'hide', enclosingRoot);
  // The UA sheet's own per-tag `display: none` — a `<link>` or `<meta>` written in the BODY. It is not an
  // author rule (so it is in none of the sets above), and those two tags are the only ones not already covered
  // by INVISIBLE_TAGS or `uaHidden`, so nothing here saw them: `visible?` said TRUE of a `<link>`, and the
  // layout laid one out as a flex ITEM (the item after it moved 100px), broke a line and separated two
  // margins. It loses to any author rule, exactly as `[hidden]` does.
  const uaNone = hidden || uaDisplay(el) === 'none';
  if (documentRules.length === 0 && !inline && !(shadowHide && shadowHide.length) &&
      !(enclosingRoot && el._attrs && el._attrs.part)) return uaNone;
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
        bestD = { value: r.display, important: r.displayImp, spec: r.spec, source: r.source, layerRank: r.layerRank, outerness: r.outerness };
      }
      if (!ignoreVisibility && r.visibility != null && winsCascade(bestV, r, false)) {
        bestV = { value: r.visibility, important: r.visibilityImp, spec: r.spec, source: r.source, layerRank: r.layerRank, outerness: r.outerness };
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
      // Sorted on CONTEXT like every other property (`contextWins`): running `display` and
      // `visibility` through a ladder without it gave them the OPPOSITE answer to everything else —
      // an outer `!important` beating an inner one, and an outer normal losing to the part's inline
      // style (both Chrome-verified backwards). This reaches Capybara's visibility predicate, not
      // just getComputedStyle.
      const pick = (best, value, important) => {
        if (!winsCascade(best, r, value === 'display', outerness)) return best;
        return { value: value === 'display' ? r.display : r.visibility,
                 important, spec: r.spec, source: r.source, layerRank: r.layerRank, outerness };
      };
      if (r.display != null) bestD = pick(bestD, 'display', r.displayImp);
      if (!ignoreVisibility && r.visibility != null) bestV = pick(bestV, 'visibility', r.visibilityImp);
    }
  }
  // `all` competes for `display` / `visibility` too. It has to be resolved HERE, not only in
  // `cascadedProperty`, because the hide cascade is a separate ladder — these two are read as
  // booleans on the hot path and never go through the property map. Leaving it out made
  // `getComputedStyle(el).display` answer `inline` for `#x { display: none } #x { all: initial }`
  // while the element still had NO BOX and `visible?` still said false: one question, two doors,
  // opposite answers. `allRecord` is memoised per element and short-circuits on a page that never
  // declares `all`, which is nearly all of them.
  const allD = allRecord(el, 'display');
  if (allD && preferRecord(bestD, allD) === allD) bestD = { ...allD, value: hideKeywordStandsFor(el, 'display', allD.value) };
  if (!ignoreVisibility) {
    const allV = allRecord(el, 'visibility');
    if (allV && preferRecord(bestV, allV) === allV) bestV = { ...allV, value: hideKeywordStandsFor(el, 'visibility', allV.value) };
  }
  if (bestD && bestD.value === 'none') return true;
  if (uaNone && bestD == null) return true;   // the UA's `display: none` (`[hidden]`, `<link>`), no author override
  if (bestV && (bestV.value === 'hidden' || bestV.value === 'collapse')) return true;
  return false;
}

// What a CSS-wide keyword stands for on the two hide properties. `cssWideStandsFor` answers for
// `inherit` / `revert` — and for `unset` on `visibility`, which DOES inherit, so `all: unset` on
// slotted content takes the slot's `hidden` rather than the initial `visible`. It returns null for
// `initial`, and for `unset` on `display`, which does not inherit — where null means the property's
// INITIAL value, which for exactly these two is a keyword worth naming rather than looking up.
const HIDE_INITIAL = { display: 'inline', visibility: 'visible' };
function hideKeywordStandsFor (el, prop, keyword) {
  return cssWideStandsFor(el, prop, keyword, 0) ?? HIDE_INITIAL[prop];
}

// The element's OWN cascaded value for a hide-cascade property (`display` or `visibility`),
// or null if neither inline `style=` nor any matching rule sets it. display / visibility live
// in the hide-rule cascade (not the captured-property map): the hide logic reads them only as
// none / hidden booleans, but getComputedStyle needs the actual keyword. Same precedence ladder
// as matchesAnyHideRule (winsCascade). Skips rule-matching when no rule sets it (common page).
// `null` is a valid resolved answer ("nothing declares it"), so absence is a distinct sentinel.
const HIDE_UNSET = Symbol('unset');
function ownHideProp(el, prop) {
  // Under the style engine, its computed value — which for `visibility` is what the walks up the tree below settle on.
  if (engineAnswers()) {
    const v = engineValue(el, prop);
    if (v !== undefined) return v;
  }
  // A generated-content box: its `display` / `visibility` come from the pseudo-element rules,
  // which the hide index keeps out (no inline style, no memo entry of its own).
  if (el._pseudo) {
    const rec = cascadedPseudoRecord(el, prop);
    return rec ? String(rec.value).trim().toLowerCase() : null;
  }
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
// `skipInline` leaves the `style=` declaration out of the cascade — the layout engine folds inline styles in
// itself (`resolveLayoutProp`), so `resolveCascadeDisplay` wants the RULES' answer alone. Everything below it —
// the shadow encapsulation gate, the shadow tree's own rules, `::part()` — is the same question either way, and
// keeping it in one function is what stops the two answers drifting: they did, and a page-level
// `.invis { display: none }` reached into a shadow tree for LAYOUT while `getComputedStyle` said otherwise.
function computeOwnHideProp(el, prop, skipInline = false) {
  const imp = prop + 'Imp', isDisplay = prop === 'display';
  const inline = skipInline ? null : inlineHideDecl(el);
  let best = (inline && inline[prop] != null)
    ? { value: inline[prop], important: inline[imp], spec: inline.spec, source: inline.source, inline: true }
    : null;
  // Shadow ENCAPSULATION, the same gate `computeMatchesAnyHideRule` applies: an element inside a
  // shadow tree is not matched by document-scope author rules. Without it a page-level
  // `.inv { display: none }` reached into every shadow tree using the class, and
  // `getComputedStyle(el).display` said `none` while the box was still laid out 18 tall — the two
  // halves of ONE geometry disagreeing (Chrome: `block`).
  const enclosingRoot = globalThis.__csimShadowHostCount ? enclosingShadowRootOf(el) : null;
  const encapsulated = !!enclosingRoot;
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
  // Shadow-tree hide rules incl. :host / ::slotted (gated; see matchesAnyHideRule). The enclosing root the
  // gate above already walked to is handed over rather than walked to again — this runs per element per layout
  // pass now that `resolveCascadeDisplay` comes through here.
  const shadowHide = shadowRulesForEl(el, 'hide', enclosingRoot);
  if (shadowHide) {
    for (const r of shadowHide) {
      if (r[prop] == null) continue;
      noteDynamic(r);
      if (!safeMatches(el, r)) continue;
      if (winsCascade(best, r, isDisplay)) {
        best = { value: r[prop], important: r[imp], spec: r.spec, source: r.source, layerRank: r.layerRank, outerness: r.outerness };
      }
    }
  }
  // …and the outer tree's `::part()` rules — already matched, so no `safeMatches` here, and
  // sorted on CONTEXT first (see the same branch in computeMatchesAnyHideRule).
  const partHide = partRulesForEl(el, 'hide', (r) => r[prop] != null);
  if (partHide) {
    for (const { rule: r, outerness } of partHide) {
      if (!winsCascade(best, r, isDisplay, outerness)) continue;
      best = { value: r[prop], important: r[imp], spec: r.spec, source: r.source, layerRank: r.layerRank, outerness };
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
    if (v != null && !VISIBILITY_INHERITS.has(v)) return v === 'initial' ? 'visible' : v;
    cur = flatTreeParent(cur);   // `visibility` inherits through the FLAT tree: a slotted span under a hidden shadow box
  }
  return 'visible';
}
export function visibilityHidden(el) { const v = resolveVisibility(el); return v === 'hidden' || v === 'collapse'; }
// …and one element's, given its parent's (`inherited`): what it declares, or what it inherits — for a walk that threads
// it down instead of resolving it per node.
function hidesByVisibility(el, inherited) {
  const v = ownVisibility(el);
  if (v == null || VISIBILITY_INHERITS.has(v)) return inherited;
  return v === 'hidden' || v === 'collapse';
}
// The keywords under which `visibility` takes its parent's value: `inherit` / `unset` (it is an inherited property),
// and `revert` / `revert-layer` too — the UA origin declares nothing for it, so a revert lands on inheritance (Chrome
// and Firefox leave a `visibility: revert` span inside a hidden div hidden).
const VISIBILITY_INHERITS = new Set(['inherit', 'unset', 'revert', 'revert-layer']);
// The resolved keyword for getComputedStyle (visibility lives in the hide-rule cascade, not
// the captured-property map, so it can't be read via cascadedProperty).
export function computedVisibility(el) { return resolveVisibility(el); }

function winsCascade(current, candidate, isDisplay, candOuterness = candidate.outerness || 0) {
  const candImp = isDisplay ? candidate.displayImp : candidate.visibilityImp;
  if (!current) return true;
  if (candImp && !current.important) return true;
  if (!candImp && current.important) return false;
  const context = contextWins(current, candOuterness, candImp);
  if (context !== null) return context;
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
// A run of CSS-collapsible white space — space, tab and newline (CR arrives normalized). NOT JS's
// `\s`, which also matches NBSP and the rest of Unicode's spacing, all of which render; and not the
// form feed either, which Chrome renders (`a\fb` keeps the U+000C).
const COLLAPSIBLE_WS_RUN_RE = /[ \t\n\r]+/g;
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
// The table structure itself holds no text: white space between a `<table>` and its rows generates
// no box, even under `white-space: pre` (Chrome: `<table style="white-space:pre">  <td>abc</td>  `
// is "abc"). Anything else there was foster-parented out by the parser long before this walk.
const TABLE_STRUCTURE_TAGS = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr']);
// An ATOMIC INLINE renders as one box of its own, so it does not join the collapsible white space
// on either side of it into one run: `abc <img> def` keeps BOTH spaces in Chrome, where `abc <span
// ></span> def` keeps one. It contributes no text of its own here.
const ATOMIC_INLINE_TAGS = new Set(['img', 'video', 'canvas', 'iframe', 'embed', 'object', 'input',
                                    'select', 'textarea', 'button', 'audio', 'svg', 'math']);
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
// (Avo's tab switcher: a Tailwind `flex` container of `<a>`s) — whatever
// declares the display: an inline style, or a stylesheet rule (Discourse's
// user menu stacks its label and description spans with `a > div { display:
// flex; flex-direction: column }`).
const FLEX_LIKE_DISPLAY = new Set(['flex','grid','inline-flex','inline-grid']);
export function isFlexLikeContainer(el) {
  const d = ownDisplay(el);
  return d != null && FLEX_LIKE_DISPLAY.has(canonicalDisplay(d));
}
// Returns the cascade-resolved `display` value (lowercased) or null
// when no matching rule sets the property. Doesn't fold in inline
// `style="display: …"` — callers needing that can read the attribute
// directly.
export function resolveCascadeDisplay(el) {
  if (el._pseudo) return ownHideProp(el, 'display');        // its pseudo-element rules, no memo slot
  // …a shadow tree brings rules of its own (and `::part()` brings the outer tree's back), so the document's
  // rule set being empty is not the whole question once there is a shadow host on the page.
  if (state.hideRules.length === 0 && !globalThis.__csimShadowHostCount) return null;
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
  const value = computeOwnHideProp(el, 'display', true);
  return value == null ? null : String(value).trim().toLowerCase();
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

// HTML "presentational hints" — a handful of content attributes contribute to
// the cascade at an origin BELOW author rules, so getComputedStyle reports them
// only when no author/inline rule sets the property. `<canvas>` maps its
// width/height attributes to the CSS width/height (with the default 300x150
// canvas size when unset); embedded content (`<img>` / `<iframe>` / `<embed>` /
// `<object>` / `<video>`) maps its `width`/`height` content attributes the same
// way. Returns a CSS value string, or null for no hint.
// HTML's rendering section, "maps to the dimension property": which CONTENT ATTRIBUTE of which
// element supplies which CSS property. `hspace` / `vspace` supply BOTH margins on their axis, and
// a few entries use the "(ignoring zero)" variant, where a parsed zero means the attribute is
// ignored rather than applied — `<td width=0>` is `auto`, while `<table height=0>` is `0px`.
// Transcribed from the spec and pinned by html/rendering/dimension-attributes.html.
const dim = (attr, zeroOk) => ({ attr, zeroOk });
const SIZE_HINTS    = (zeroOk) => ({ width: dim('width', zeroOk), height: dim('height', zeroOk) });
const SPACING_HINTS = {
  'margin-left': dim('hspace', true), 'margin-right':  dim('hspace', true),
  'margin-top':  dim('vspace', true), 'margin-bottom': dim('vspace', true)
};
// Prototype-less: `el._tag` is page-controlled, so a `<constructor>` would otherwise find
// Object.prototype's.
const DIMENSION_HINTS = Object.assign(Object.create(null), {
  hr:      { width: dim('width', true) },
  iframe:  SIZE_HINTS(true),
  video:   SIZE_HINTS(true),
  img:     { ...SIZE_HINTS(true), ...SPACING_HINTS },
  object:  { ...SIZE_HINTS(true), ...SPACING_HINTS },
  embed:   { ...SIZE_HINTS(true), ...SPACING_HINTS },
  marquee: { ...SIZE_HINTS(true), ...SPACING_HINTS },
  input:   { ...SIZE_HINTS(true), ...SPACING_HINTS },   // `type=image` only — gated below
  // The table family, where the zero rule differs per property.
  td:      SIZE_HINTS(false),
  th:      SIZE_HINTS(false),
  table:   { width: dim('width', false), height: dim('height', true) },
  tr:      { height: dim('height', true) },
  col:     { width: dim('width', true), height: dim('height', true) },
  colgroup:{ width: dim('width', true) },
  // The row groups map HEIGHT only, and zero counts.
  thead:   { height: dim('height', true) },
  tbody:   { height: dim('height', true) },
  tfoot:   { height: dim('height', true) }
});
// The six properties anything in the table can supply. Checked BEFORE the tag lookup: this runs
// for every property whose cascade found no author rule, and the overwhelming majority are neither
// a size nor a margin.
const HINTED_PROPS = new Set(['width', 'height', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom',
                              'list-style-type', 'vertical-align', 'float', 'clear', 'text-align',
                              'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
                              'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
                              'box-sizing', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
                              'justify-self']);

// `<hr>`'s own attribute table (HTML's rendering section): `size` is how thick the LINE is, and
// `color` / `noshade` turn the etched groove into a solid block whose border is half that size on
// every side. The reftests spell the three cases out: `<hr size=50>` is a 50px border box — its
// `height` the size less its two 1px borders, in the content box it keeps (HTML §15.3.11; Chrome 48px,
// `content-box`) — `<hr size=1>` drops its bottom border so only the 1px top one is left, and
// `<hr size=50 noshade>` is a 25px border all round.
function hrHint(el, prop) {
  const attrs = el._attrs;
  const size  = htmlInteger(attrs && attrs.size);
  const solid = !!attrs && (attrs.color != null || attrs.noshade != null);
  if (solid) {
    if (prop.endsWith('-style')) return 'solid';
    return (size != null && size > 0 && prop.endsWith('-width')) ? `${size / 2}px` : null;
  }
  if (size == null || size < 1) return null;
  if (size === 1) return prop === 'border-bottom-width' ? '0px' : null;
  return prop === 'height' ? `${size - 2}px` : null;
}

// HTML's "maps to the pixel length property" (`htmlPixelLength` is the grammar). Two families:
//
//   `<body marginwidth>` and friends — the pre-CSS way of setting a page's margins, and still what
//   a mail template or a Redmine-era layout uses. Each attribute maps BOTH sides of its own axis
//   (`topmargin` sets the bottom margin too), `marginwidth` / `marginheight` are asked FIRST, and
//   `rightmargin` / `bottommargin` are not in the table at all — that is the WHATWG list, and
//   `body-margin-3a` / `iframe-body-margin-attributes` test exactly the rows where Chrome (which
//   applies them in source order instead) disagrees with it.
const BODY_MARGIN_ATTRS = Object.assign(Object.create(null), {
  'margin-left':   ['marginwidth',  'leftmargin'],
  'margin-right':  ['marginwidth',  'leftmargin'],
  'margin-top':    ['marginheight', 'topmargin'],
  'margin-bottom': ['marginheight', 'topmargin']
});
//   …and the FRAME's own `marginwidth` / `marginheight`, last in the same list: they set the
//   margins of the body INSIDE the frame, the one presentational mapping that crosses documents.
const FRAME_MARGIN_ATTRS = Object.assign(Object.create(null), {
  'margin-left': 'marginwidth', 'margin-right': 'marginwidth',
  'margin-top': 'marginheight', 'margin-bottom': 'marginheight'
});
//   `<img border>` / `<object border>` / `<input type=image border>`, which draw a border of that
//   many pixels — and, whatever the number, a SOLID one (Chrome: `border="0"` still computes
//   `border-style: solid`).
const BORDER_HINT_TAGS = new globalThis.Set(['img', 'object', 'input']);
function pixelLengthHint(el, prop) {
  if (el._tag === 'body') {
    const attrs = BODY_MARGIN_ATTRS[prop];
    if (!attrs) return null;
    for (const attr of attrs) {
      const raw = el._attrs && el._attrs[attr];
      if (raw != null) return htmlPixelLength(raw);
    }
    // …and then the frame this document sits in, which the body of a framed page takes its
    // margins from.
    const frame = globalThis.frameElement;
    const owned = frame && frame._attrs && frame._attrs[FRAME_MARGIN_ATTRS[prop]];
    return owned == null ? null : htmlPixelLength(owned);
  }
  if (!BORDER_HINT_TAGS.has(el._tag)) return null;
  if (el._tag === 'input' && inputType(el) !== 'image') return null;
  const raw = el._attrs && el._attrs.border;
  if (raw == null) return null;
  // The attribute being THERE is what draws the border: a value that is no pixel length still maps
  // `border-style: solid`, with a width of zero (Chrome-measured on all three tags —
  // `border="abc"` and `border="-200"` alike report `0px` and `solid`).
  return prop.endsWith('-style') ? 'solid' : (htmlPixelLength(raw) || '0px');
}

// HTML's rendering section maps `<br clear>` onto `clear`, with `all` for the CSS `both` — the
// pre-CSS way of ending a float band, and still what `br-clear-presentational-hints` pins.
const BR_CLEAR_HINTS = Object.assign(Object.create(null), {
  left: 'left', right: 'right', all: 'both', both: 'both', none: 'none'
});

// HTML's rendering section, "the `align` attribute on replaced elements": `left` / `right` float
// the box, and every other value maps onto `vertical-align` — two of them onto a value no CSS
// keyword spells (`middle` and `center` put the box's own CENTRE on the baseline, where the CSS
// `middle` puts it half an x-height above; Chrome answers `-webkit-baseline-middle` for them and
// WPT's `align.html` checks only that it is not one of the standard keywords). ASCII
// case-insensitive, as the attribute's own mapping is.
const ALIGN_HINTS = Object.assign(Object.create(null), {
  left:      { float: 'left' },
  right:     { float: 'right' },
  top:       { 'vertical-align': 'top' },
  middle:    { 'vertical-align': '-webkit-baseline-middle' },
  center:    { 'vertical-align': '-webkit-baseline-middle' },
  baseline:  { 'vertical-align': 'baseline' },
  bottom:    { 'vertical-align': 'baseline' },
  texttop:   { 'vertical-align': 'text-top' },
  absmiddle: { 'vertical-align': 'middle' },
  abscenter: { 'vertical-align': 'middle' },
  absbottom: { 'vertical-align': 'bottom' }
});
// …on the EMBEDDED-content elements only: `align` on a `<div>` or a `<td>` is a different mapping
// (`text-align`), and on anything else it maps to nothing at all.
// …exactly the five the rendering section's selector names — `embed, iframe, img,
// input[type=image i], object`. Chrome leaves a `<video align=top>` and a `<marquee align=top>` at
// `baseline`, measured.
const ALIGN_HINT_TAGS = new globalThis.Set(['embed', 'iframe', 'img', 'input', 'object']);
// …and on a block or a table part the same attribute is `text-align` (HTML rendering §15.3.3 /
// §15.3.9), with the PLAIN keywords the spec (and html/rendering's table-attribute test) gives it —
// Chrome computes `-webkit-center`, which is how it also aligns the block-level descendants; the
// layout does that from the attribute itself (layout.js `legacyDescendantAlign`).
const TEXT_ALIGN_HINT_TAGS = new globalThis.Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                                                 'td', 'th', 'tr', 'thead', 'tbody', 'tfoot']);
const TEXT_ALIGN_HINTS = Object.assign(Object.create(null), {
  left: 'left', right: 'right', center: 'center', middle: 'center', justify: 'justify'
});
function textAlignHint(el) {
  if (!TEXT_ALIGN_HINT_TAGS.has(el._tag)) return null;
  const raw = el._attrs && el._attrs.align;
  if (raw == null) return null;
  const hint = TEXT_ALIGN_HINTS[String(raw).trim().toLowerCase()];
  return hint === undefined ? null : hint;
}
// …and `valign` on the table parts (HTML rendering §15.3.9: `col, colgroup, tbody, td, tfoot, th, thead, tr` with
// `valign=top / middle / bottom / baseline`, an ASCII case-insensitive attribute selector, so the value untrimmed).
const VALIGN_HINT_TAGS = new globalThis.Set(['col', 'colgroup', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr']);
const VALIGN_HINTS = new globalThis.Set(['top', 'middle', 'bottom', 'baseline']);
function valignHint(el) {
  if (!VALIGN_HINT_TAGS.has(el._tag)) return null;
  const raw = el._attrs && el._attrs.valign;
  if (raw == null) return null;
  const v = String(raw).toLowerCase();
  return VALIGN_HINTS.has(v) ? v : null;
}
// §15.3.8's table attributes: `border` is the frame's width — zero included, 1px for a value that is no number (its
// `outset` style is the UA sheet's, `tableFrameStyle`); `align` floats the table, or centres it with auto inline margins.
function tableHint(el, prop) {
  // (…and a `frame` with no `border` draws 1px, in Chrome and Firefox alike, where the spec leaves `medium`)
  if (prop.startsWith('border-')) {
    if (!prop.endsWith('-width')) return null;
    return tableBorderHint(el) ?? (el._attrs && el._attrs.frame != null ? '1px' : null);
  }
  const raw = el._attrs && el._attrs.align;
  if (raw == null) return null;
  const align = String(raw).toLowerCase();
  if (prop === 'float') return align === 'left' || align === 'right' ? align : null;
  if (prop === 'margin-left' || prop === 'margin-right') return align === 'center' ? 'auto' : null;
  return null;
}
// A table's `border`, as the frame width it maps to, or null for none. What its cells are framed by too (the UA's
// `table[border] > tr > td`, which draws nothing where the width is zero — Chrome and Firefox).
export function tableBorderHint(table) {
  const raw = table._attrs && table._attrs.border;
  return raw == null ? null : (htmlPixelLength(raw) ?? '1px');
}
// `cellpadding` pads every cell of its table: a `<td>` / `<th>` takes it from the table above its row (and group).
function cellPaddingHint(el) {
  if (el._tag !== 'td' && el._tag !== 'th') return null;
  for (let p = el._parent; p && p.nodeType === NODE_ELEMENT; p = p._parent) {
    if (p._tag === 'table') {
      const raw = p._attrs && p._attrs.cellpadding;
      return raw == null ? null : htmlPixelLength(raw);
    }
    if (p._tag !== 'tr' && p._tag !== 'thead' && p._tag !== 'tbody' && p._tag !== 'tfoot') return null;
  }
  return null;
}
function alignHint(el, prop) {
  if (!ALIGN_HINT_TAGS.has(el._tag)) return null;
  if (el._tag === 'input' && inputType(el) !== 'image') return null;
  const raw = el._attrs && el._attrs.align;
  if (raw == null) return null;
  // NOT trimmed: the mapping is an attribute SELECTOR (`img[align=top i]`), which compares the
  // whole value — Chrome leaves `align=" top "` at `baseline`. The same rule the `type` marker
  // hint above states.
  const entry = ALIGN_HINTS[String(raw).toLowerCase()];
  return entry && entry[prop] !== undefined ? entry[prop] : null;
}

// `<ol type>` / `<ul type>` / `<li type>` map to `list-style-type`, and the two halves have
// DIFFERENT case rules — the ordered keywords are case-SENSITIVE (`a` is lower-alpha, `A` is
// upper-alpha, which is the whole point of them), the unordered ones are ASCII case-insensitive
// (`SQUARE` is square). WPT has a file for exactly that asymmetry. An `<ol>` only takes the
// ordered set and a `<ul>` only the unordered; an `<li>` takes either, whatever its parent is
// (Chrome measured: `<ul><li type=A>` is upper-alpha). An unrecognised value maps to nothing, so
// the element keeps its UA marker.
const ORDERED_MARKERS   = {1: 'decimal', a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman'};
const UNORDERED_MARKERS = {none: 'none', disc: 'disc', circle: 'circle', square: 'square'};
function listMarkerHint (el) {
  const raw = el._attrs && el._attrs.type;
  if (raw == null) return null;
  // NOT trimmed: this mapping is an attribute SELECTOR (`ol[type=a]`, `ul[type=square i]`), and a
  // selector compares the whole value — Chrome leaves `<ol type="A ">` at `decimal`. The ASCII
  // case-fold on the unordered half is the only normalisation the spec asks for. (`String#trim`
  // would also eat U+00A0, which is not ASCII whitespace at all.) The `dir` reader next door
  // states the same rule.
  const text = String(raw);
  const tag  = el._tag;
  if (tag !== 'ul' && Object.prototype.hasOwnProperty.call(ORDERED_MARKERS, text)) return ORDERED_MARKERS[text];
  if (tag === 'ol') return null;
  const lower = text.toLowerCase();
  return Object.prototype.hasOwnProperty.call(UNORDERED_MARKERS, lower) ? UNORDERED_MARKERS[lower] : null;
}
export function presentationalHint (el, prop) {
  if (!HINTED_PROPS.has(prop)) return null;
  // …and `<hr>`'s own table, which answers for the properties `size` / `color` / `noshade` set and
  // leaves the rest — its `width` attribute is the ordinary dimension hint — to the tables below.
  if (el._tag === 'hr') {
    const own = hrHint(el, prop);
    if (own !== null) return own;
  }
  if (prop === 'box-sizing') return null;
  // …and a `<table>`'s frame and `align`, its SIZE being the dimension table's like any other element's.
  if (el._tag === 'table') {
    const own = tableHint(el, prop);
    if (own !== null) return own;
  }
  if (prop.startsWith('padding-')) return cellPaddingHint(el);
  if (prop.startsWith('border-')) return pixelLengthHint(el, prop);
  // (…only a `<body>`'s margins are `pixelLengthHint`'s: past it that table is the `border` attribute's, which maps no
  // margin — an `<img border=3>` was given three pixels of margin on every side, and its `hspace=0` overridden)
  if (prop.startsWith('margin-') && el._tag === 'body') {
    const px = pixelLengthHint(el, prop);
    if (px !== null) return px;
  }
  if (prop === 'clear') {
    if (el._tag !== 'br') return null;
    const raw = el._attrs && el._attrs.clear;
    // An attribute SELECTOR again (`br[clear=left i]`), so the whole value, ASCII case-folded.
    const hint = raw == null ? null : BR_CLEAR_HINTS[String(raw).toLowerCase()];
    return hint === undefined ? null : hint;
  }
  if (prop === 'vertical-align') return alignHint(el, prop) ?? valignHint(el);
  if (prop === 'float') return alignHint(el, prop);
  if (prop === 'text-align') return textAlignHint(el);
  // (…and a `<legend align>`'s `justify-self`, the UA sheet's `legend[align=left i]` and the rest)
  if (prop === 'justify-self') {
    const raw = el._tag === 'legend' && el._attrs ? el._attrs.align : null;
    const v = raw == null ? null : String(raw).toLowerCase();
    return v === 'left' || v === 'center' || v === 'right' ? v : null;
  }
  if (prop === 'list-style-type') {
    return (el._tag === 'ol' || el._tag === 'ul' || el._tag === 'li') ? listMarkerHint(el) : null;
  }
  // A `<canvas>` is deliberately absent from the table: its width/height attributes are the
  // BACKING STORE, not a presentational hint, so they size it the way an `<img>`'s decoded bitmap
  // does — through the layout engine's intrinsic size (layout.js `intrinsicSize`). Answering here
  // gave every canvas a SPECIFIED css width it doesn't have: Chrome reports `auto` for a
  // `display: none` canvas and `width: revert` could never reach `auto`.
  const forTag = DIMENSION_HINTS[el._tag];
  const hint = forTag && forTag[prop];
  if (!hint) return null;
  // Only `<input type=image>` takes them — a text field's `width` attribute is not a thing.
  if (el._tag === 'input' && inputType(el) !== 'image') return null;
  let attr = el._attrs && el._attrs[hint.attr];
  // An `<img>` in a `<picture>` maps the DIMENSION attributes of the `<source>` it selected — that
  // is how a responsive picture reserves the right box before the image decodes. The rule is
  // all-or-nothing per ELEMENT, not per axis (Chrome-measured): a source carrying EITHER width or
  // height takes over BOTH, so an axis it doesn't name becomes `auto` rather than falling back to
  // the img's own attribute. An axis the source names with an INVALID value does fall back.
  if (el._tag === 'img' && (prop === 'width' || prop === 'height')) {
    const source = pictureSourceFor(el, mediaMatchesForSource);
    const from = source && source._attrs;
    if (from && (from.width != null || from.height != null)) {
      const named = from[hint.attr];
      // An axis the source does not name at all is `auto` — the img's own attribute is out of the
      // picture entirely. One it names INVALIDLY falls back to the img's own (Chrome-measured:
      // `<source width="-5" height=50>` over `<img width=11 height=22>` is 11px / 50px).
      if (named == null) return null;
      const mapped = htmlDimensionValue(named);
      if (mapped !== null) return zeroChecked(mapped, hint);
    }
  }
  if (attr == null) return null;
  // `htmlDimensionValue` (css-utils) is the grammar — see there for why it is not a CSS length.
  const value = htmlDimensionValue(attr);
  return value === null ? null : zeroChecked(value, hint);
}
// HTML's "(ignoring zero)" variant: a parsed zero means the attribute is ignored outright.
function zeroChecked (value, hint) {
  return (!hint.zeroOk && parseFloat(value) === 0) ? null : value;
}
// A `<source media>` is evaluated against the current viewport, like any media query.
const mediaMatchesForSource = (query) => mediaMatches(query, currentViewport());

// The winning DECLARATION for `prop` — value plus the precedence fields — so a caller can compare
// two property names and pick the one the cascade actually prefers. `cascadedProperty` is the
// value-only wrapper every existing reader uses.
function cascadedRecord(el, prop) {
  ensureCascadeFresh();
  if (el._pseudo) return cascadedPseudoRecord(el, prop);
  // Shadow encapsulation: an element INSIDE a shadow tree is not matched by
  // document-scope author rules — only by its own tree's sheets (via
  // shadowRulesForEl below), plus inherited values that reach it through the
  // getComputedStyle parent walk. A host or slotted element lives in the OUTER
  // scope (enclosingShadowRootOf → null), so document rules still apply to it.
  const shadowRoot   = globalThis.__csimShadowHostCount ? enclosingShadowRootOf(el) : null;
  const encapsulated = !!shadowRoot;
  const rules = state.layoutRules;
  // The STATIC rules' winner comes from the native cascade, in one answer per element with the other rules the
  // element's buckets select and its inline declarations (`nativeAnswer`); an element it cannot answer walks the
  // index itself.
  const nat = encapsulated || !rules.length ? null : nativeCascadeFor(el);
  const ans = nat === null ? null : nativeAnswer(el, nat);
  // Inline seed carries `inline: true`; like winsCascade, the property
  // comparator (`winsProp`) checks inline-ness before specificity so a
  // non-`!important` inline value beats every author selector at equal
  // importance. `spec` stays a real 3-component value.
  let best;
  if (ans !== null) best = ans.inline.get(prop) || null;
  else {
    const inline = inlineDecls(el)[prop];
    best = inline ? inlineRecord(inline) : null;
  }
  if (ans !== null) {
    const d = ans.won.get(prop);
    if (d !== undefined && winsProp(best, d.spec, d.source, d.important, d.layerRank, d.outerness)) best = d;
    const js = ans.js;
    for (let i = 0; i < js.length; i++) {
      const r = js[i], cap = own(r.captured, prop);
      if (!cap) continue;
      // …and the ancestor group `walkBucket` would have skipped is skipped here, before the rule counts as
      // considered: the context epoch re-keys the element when that ancestor identifier arrives.
      if (r.anc && !ancestorAdmits(el, r.anc, 1)) continue;
      noteDynamic(r);
      if (!safeMatches(el, r)) continue;
      if (winsProp(best, r.spec, r.source, cap.important, r.layerRank)) {
        best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source, layerRank: r.layerRank, order: cap.order };
      }
    }
  } else if (!encapsulated && rules.length && rulesIndexHas(prop)) {
    forEachCandidatePropRule(el, prop, (r, cap) => {
      noteDynamic(r);                       // considered — a rule that misses now can match on hover
      if (!safeMatches(el, r)) return;
      if (winsProp(best, r.spec, r.source, cap.important, r.layerRank)) {
        best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source, layerRank: r.layerRank, order: cap.order };
      }
    });
  }
  // Shadow-tree author rules: a `<style>` / `adoptedStyleSheets` sheet inside
  // an enclosing shadow root styles elements within that tree — and a `:host` /
  // `::slotted()` one the host or a light child OUTSIDE it, where it meets the
  // document's rules on CONTEXT (`contextWins`), not on source order.
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
      if (winsProp(best, r.spec, r.source, cap.important, r.layerRank, r.outerness)) {
        best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source, layerRank: r.layerRank, order: cap.order,
                 outerness: r.outerness };
      }
    }
  }
  // `::part()` — the one way an OUTER tree's rule reaches INTO this one, so it is collected even
  // though the element is encapsulated from that tree's ordinary rules above. Already matched
  // (host and trailing pseudo-classes both), hence no `safeMatches` here. Sorted on CONTEXT before
  // anything but importance (`contextWins`): the outer tree wins a normal declaration outright, so
  // the source ladder only decides ties WITHIN one tree.
  const partRules = encapsulated ? partRulesForEl(el, 'layout', (r) => !!own(r.captured, prop)) : null;
  if (partRules) {
    for (const { rule: r, outerness } of partRules) {
      const cap = own(r.captured, prop);
      if (!winsProp(best, r.spec, r.source, cap.important, r.layerRank, outerness)) continue;
      best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source,
               layerRank: r.layerRank, order: cap.order, outerness };
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
// The flow-relative CORNERS are named differently from every other logical property: two axes at
// once and no axis words — `border-start-start-radius` is (block-start, inline-start). And the
// PHYSICAL corner is always written vertical-then-horizontal (`border-top-left-radius`) whatever
// the writing mode, so the pair has to be ORDERED rather than concatenated in flow order.
const LOGICAL_CORNER_RE  = /^border-(start|end)-(start|end)-radius$/;
const PHYSICAL_CORNER_RE = /^border-(top|bottom)-(left|right)-radius$/;
function orderedCorner (a, b) {
  const vertical = (a === 'top' || a === 'bottom') ? a : b;
  return `border-${vertical}-${vertical === a ? b : a}-radius`;
}
function physicalCorner (el, prop) {
  const m = LOGICAL_CORNER_RE.exec(prop);
  if (!m) return null;
  const sides = flowSides(el);
  return orderedCorner(sides[`block-${m[1]}`], sides[`inline-${m[2]}`]);
}
function logicalCorner (el, prop) {
  const m = PHYSICAL_CORNER_RE.exec(prop);
  if (!m) return null;
  const sides = flowSides(el);
  const flowFor = (physical) => {
    for (const flow of ['block-start', 'block-end', 'inline-start', 'inline-end']) {
      if (sides[flow] === physical) return flow;
    }
    return null;
  };
  const first = flowFor(m[1]), second = flowFor(m[2]);
  if (!first || !second) return null;
  const block  = first.startsWith('block') ? first : second;
  const inline = first.startsWith('block') ? second : first;
  return `border-${block.slice(6)}-${inline.slice(7)}-radius`;
}
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
const ENGINE_FLOW_SIDES = new Map();
function engineFlowSides (wm, rtl) {
  const key = rtl ? wm + ' rtl' : wm;
  let sides = ENGINE_FLOW_SIDES.get(key);
  if (sides === undefined) ENGINE_FLOW_SIDES.set(key, sides = wm === 'horizontal-tb' && !rtl ? DEFAULT_FLOW_SIDES : sidesFor(wm, rtl));
  return sides;
}
// `writing-mode` / `direction` INHERIT, so an element's flow sides are its PARENT's unless it
// declares one itself. Chained that way and memoised per cascade generation, each element costs
// one lookup instead of a walk to the root — this sits under `resolveLayoutProp`, which the layout
// pass calls several times per element, and the un-memoised walk hung an editor-shaped page (rule 3).
const FLOW_IN_PROGRESS = Symbol('flow-in-progress');
export function flowSides (el) {
  // Under the style engine, its computed `writing-mode` and `direction`: the flat-tree inheritance, a `dir` attribute
  // and every CSS-wide keyword resolved there — one object per combination, as this sits on the layout's hot path.
  if (engineAnswers()) {
    const wm = engineValue(el, 'writing-mode');
    if (wm !== undefined) return engineFlowSides(wm, engineValue(el, 'direction') === 'rtl');
    if (outsideEngine(el)) return DEFAULT_FLOW_SIDES;
  }
  if (!documentTurnsFlow()) return DEFAULT_FLOW_SIDES;
  if (el._styled === false) declareStyledMemos(el);
  const gen = cascadeGeneration();
  if (el._fsGen === gen) return el._fsVal;
  // A re-entrant ask — `computeFlowSides` reads the cascade, and one `uaDefault` on that path
  // would come back through `twinName` to here — answers the default rather than recursing
  // forever. The cycle does not close today; this makes that a property of the code instead of a
  // fact about the current call graph, for one store.
  if (el._fsGen === FLOW_IN_PROGRESS) return DEFAULT_FLOW_SIDES;
  el._fsGen = FLOW_IN_PROGRESS;
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
  // …and one that considered a `:has()` rule, for the same reason: what its argument reads DOWNWARD moves no key of this
  // memo's, and no context epoch either (`ctxUnsafeReadSeq`).
  const seqBefore = dynamicReadSeq(), ctxBefore = ctxUnsafeReadSeq();
  const val = computeFlowSides(el);
  // The sentinel is CLEARED either way. Leaving it set on the not-cacheable path poisoned every
  // later read of that element — they saw an in-progress marker and answered the LTR default,
  // which is how a `:placeholder-shown { direction: rtl }` element reported `rtl` while its
  // `margin-inline-start` mapped left. Restoring the previous generation keeps "not cached" and
  // "currently computing" distinct.
  if (dynamicReadSeq() === seqBefore && ctxUnsafeReadSeq() === ctxBefore) { el._fsGen = gen; el._fsVal = val; }
  else el._fsGen = undefined;
  return val;
}

function computeFlowSides (el) {
  // CSS inherits through the FLAT tree: slotted content takes its flow from the SLOT's ancestors,
  // and a shadow-tree element from its HOST. `flatTreeParent` is the one that knows both hops and
  // is mode-agnostic — `assignedSlot` is open-only, so a hand-rolled version silently stops
  // inheriting into every CLOSED root, and it never reaches the host at all (a shadow root is not
  // an element, so the walk just ended there and nothing inside ANY shadow tree inherited RTL).
  const parent = flatTreeParent(el);
  const base = (parent && parent.nodeType === NODE_ELEMENT) ? flowSides(parent) : DEFAULT_FLOW_SIDES;
  // Neither property declared ANYWHERE (the overwhelmingly common case)? Then nothing can differ
  // from the parent, and the two cascade lookups below are skipped entirely.
  // A `dir` ATTRIBUTE sets the computed direction without any declaration — `<html dir="rtl">` is
  // how essentially every RTL app does it, and reading only the CSS side put every
  // `*-inline-start` on the mirrored edge.
  // (…and so does being a `<bdi>` or a telephone `<input>`, which take a direction of their own with no valid `dir`:
  // `ownDirectionalityStep`.)
  const ownDir = (el._attrs && el._attrs.dir) != null || el._tag === 'bdi' || (el._tag === 'input' && String(el._attrs.type ?? '').toLowerCase() === 'tel');
  const declared = cascadeDeclaresProperty('writing-mode') || cascadeDeclaresProperty('direction') || ownDir ||
                   'writing-mode' in inlineDecls(el) || 'direction' in inlineDecls(el);
  if (!declared) return base;
  const wmRaw = ownCascaded(el, 'writing-mode');
  // A CSS declaration wins over the attribute — `dir` maps to a UA-origin declaration of the same
  // property, so an author's beats it — and BOTH are resolved properly. `declaredValue` rather
  // than the raw cascaded text, because a CSS-wide keyword (`direction: inherit` over a `dir`, or
  // `initial` under an rtl ancestor) and an invalid value (`direction: sideways`, which drops and
  // inherits) each have to resolve before this can compare them; the raw text answered `null` for
  // all of them and silently fell through to the attribute. And the DOM layer owns the attribute's
  // half — `dir=auto`'s first-strong character and a bare `<bdi>` read TEXT, which is HTML's rule
  // and lives with the text (`_ownDirectionality`).
  const cssDir = declaredValue(el, 'direction');
  let cssKeyword = cssDir != null ? String(cssDir).trim().toLowerCase() : null;
  // A CSS-WIDE keyword is still a declaration, so it beats the `dir` attribute — and it resolves
  // against what this function already has in hand. `inherit` / `unset` (direction inherits) take
  // the PARENT's resolved flow, which is `base` and therefore includes the parent's own `dir`;
  // `initial` is the property's initial `ltr`; `revert` drops to the UA origin, which for this
  // property IS the `dir` attribute, so it falls through below rather than resolving here.
  if (cssKeyword === 'inherit' || cssKeyword === 'unset') cssKeyword = base.rtl ? 'rtl' : 'ltr';
  else if (cssKeyword === 'initial') cssKeyword = 'ltr';
  else if (cssKeyword === 'revert' || cssKeyword === 'revert-layer') cssKeyword = null;
  const dirRaw = (cssKeyword === 'ltr' || cssKeyword === 'rtl') ? cssKeyword
               : (typeof el._ownDirectionality === 'function' ? el._ownDirectionality() : null);
  if (wmRaw == null && dirRaw == null) return base;
  const wm  = wmRaw != null ? String(wmRaw).trim().toLowerCase() : base.mode;
  const rtl = dirRaw != null ? dirRaw === 'rtl' : base.rtl;
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
  // A `dir=auto` scope a mutation touched is tested here, before the generation is read: a flip moves it.
  if (globalThis.__csimDirAutoPending) globalThis.__csimFlushDirAutoScopes();
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

// The epoch LAYOUT keys its memos on: the rule set. What a dynamic state flip reaches — `#t:placeholder-shown { width:
// 300px }` once the field is filled — the style engine marks as it restyles (layout.js `markRestyles`); keyed on the
// state as well, every keystroke relaid out the document.
const LAYOUT_EPOCH = { cv: -1, value: 0 };
export function cascadeLayoutEpoch () {
  ensureCascadeFresh();
  const cv = globalThis.__csimCascadeVersion ? globalThis.__csimCascadeVersion() : 0;
  if (cv !== LAYOUT_EPOCH.cv) {
    LAYOUT_EPOCH.cv = cv;
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
// Every write moves all three conservatively (`ctxAttrEffect` / `ctxChildListEffect`): what a write restyles is the
// style engine's to say, and these keep only the oracle's memo of the JS cascade right.
// Everything else a static selector can read is covered elsewhere: rules via cascadeVersion,
// dynamic pseudo-classes via the taint counter, and the one DOWNWARD-looking pseudo (`:has()`) via
// `ctxUnsafeReadSeq` below. Memoised per (element, tree generation) so a read burst between mutations
// walks each chain once. The chain crosses shadow boundaries (ShadowRoot._parent is the host). Shadow-SIDE slot
// mutations move nothing on a light child's chain, which is why the memos refuse slottable candidates
// outright (hideMemoFor).
// The stamp carries a realm token besides the generation: `_ctxGen` lives on the (cross-realm
// shared) element, but each realm counts its own tree generation from 0 — two realms' counters can
// collide numerically, and a parent-realm stamp must never satisfy a child-realm read.
const CTX_REALM_TOKEN = {};
// The memos an element gains once it is STYLED — the cascade's, then layout's — declared together, in one order, on
// its first style read or layout visit (here, in `flowSides` and style-proxy.js `pseudoNodeFor`, which write one before
// any read, and layout.js `inheritedDirty`, which a pass asks before either): added as each was first written,
// in whatever order a page's reads took, they split one tag's elements across several hidden classes (130 maps for
// the 369 elements of a Redmine issue page, 88 declared), a page load 5% slower. Declared in the Element constructor
// instead, every element paid for them — a detached, parsed or template one never styled: createElement 75% slower,
// ~550 bytes each. `undefined` is the absent memo each reader already tests for.
export function declareStyledMemos(el) {
  el._styled = true;
  el._pseudoNodes = undefined;                                              // ::before / ::after nodes (style-proxy.js)
  el._visMemo = undefined;                                                  // rendered-ness (`isVisibleNodeImpl`)
  // …and layout's (layout.js): the box and what a pass writes with it, then each memo beside its `…Pass` stamp — the
  // ones a geometry read asks of a page the Rust walk lays out. (The JS layout's and the JS cascade's own memos — the
  // selector context, the flow sides, the font and line records, … — are not declared: the JS walk and the oracle are
  // what write them, and declaring them for every styled element cost a Redmine page load 2.8% of its main thread.)
  el._lb = undefined; el._lbFrags = undefined; el._lbCbW = undefined; el._lbMargins = undefined;
  el._lbRel = undefined; el._lbRelPass = undefined; el._nlRow = undefined;
  el._ccAt = undefined; el._ccX = undefined; el._ccY = undefined; el._ccScroll = undefined; el._ccVal = undefined;
  el._lbInhDirty = undefined; el._lbInhDirtyPass = undefined; el._lbDisp = undefined; el._lbDispPass = undefined;
  el._lbPos = undefined; el._lbPosPass = undefined;
  el._lbEdge = undefined; el._lbEdgePct = undefined; el._lbEdgeCb = undefined; el._lbEdgeDep = undefined;
  el._lbEdgePass = undefined; el._lbTf = undefined; el._lbTfPass = undefined; el._lbPs = undefined; el._lbPsPass = undefined;
}
export function ctxEpochOf(el) {
  // A generated-content box's context IS its originating element's: which pseudo rules match it
  // moves with that element's classes, attributes and ancestors, and with nothing of its own.
  if (el && el._pseudo) return el._parent ? ctxEpochOf(el._parent) : 0;
  if (el._styled === false) declareStyledMemos(el);
  // Memoised per TREE generation (`currentTreeGen`): the parser moves the counters without moving settleGen, and a
  // mid-parse read must not keep a context the next parsed sibling moved.
  const gen = currentTreeGen();
  if (el._ctxTok === CTX_REALM_TOKEN && el._ctxGen === gen) return el._ctxVal;
  let h = (el._selEpoch || 0) + 1;
  const p = el._parent;
  if (p) h = (Math.imul(h, 31) + (p._kidsEpoch || 0) + 1) | 0;
  for (let n = p; n; n = n._parent) {
    h = (Math.imul(h, 31) + (n._descEpoch || 0) + 1) | 0;
  }
  el._ctxTok = CTX_REALM_TOKEN;
  el._ctxGen = gen;
  el._ctxVal = h;
  return h;
}


// What the SHADOW sheets on this page declare — the union of their property names and of the properties
// their `@keyframes` blocks animate. Shadow sheets are in no document index, so without
// this every document-wide "does anything here declare X?" gate had to answer YES for the whole page
// as soon as one host existed — a 400-row table beside a widget whose tree is one `<p>` relaid out
// 5.4x slower, every light-DOM element paying for a stylesheet that cannot reach it.
//
// Fed by a QUEUE, drained once per root and never re-walked: a root is queued when it is attached
// (`__csimPendingShadowRoots`) and again whenever `scopedRulesFor` rebuilds its buckets, which is
// exactly when what it declares can have changed. So N components cost O(N) in total rather than a
// re-walk of every root per cascade version, and nothing holds a discarded component's tree.
//
// The union only GROWS. A property a shadow sheet stops declaring keeps its gate open, which is the
// conservative direction and the same answer the fail-open gave; what matters is that a property one
// DOES declare is never missing, and draining the queue before answering is what guarantees that.
const shadowFactsPending = [];
let shadowProps = new Set(), shadowKeyframeProps = new Map(), shadowSheets = [], shadowSheetSeen = new Set();
let shadowTreeFolds = 0, shadowAnimNames = new Set(), shadowAnimVar = false;
function shadowSheetFacts () {
  // A page with no shadow tree, now or ever, pays one truthy check.
  if (!globalThis.__csimShadowHostCount && !shadowTreeFolds) return shadowProps;
  const queued = globalThis.__csimPendingShadowRoots;
  if (queued && queued.length) for (const sr of queued.splice(0)) shadowFactsPending.push(sr);
  while (shadowFactsPending.length) {
    const scoped = scopedRulesFor(shadowFactsPending.pop());   // …which re-queues on a rebuild; it is
    shadowTreeFolds++;                                         //   already fresh here, so it does not
    // Everything below comes off the PARSED sheet, which `parseSheetCached` shares across every
    // component with the same stylesheet text — so a thousand copies of one widget fold ONE sheet and
    // every later root costs a Set lookup. Reading the ROUTED buckets instead re-walked each tree's
    // rules on every cascade version, which a relayout bumps once per component: 1000 components took
    // 238 s that way and 0.2 s this way. The buckets carry the same properties anyway — routing only
    // rewrites selectors.
    for (const entry of scoped.sheets) {
      if (shadowSheetSeen.has(entry.key)) continue;
      shadowSheetSeen.add(entry.key);
      shadowSheets.push(entry);
      foldShadowSheet(entry.sheet);
    }
  }
  return shadowProps;
}
function foldShadowSheet (sheet) {
  // The `@keyframes` NAMES this tree references, so `referencedAnimationNames` can answer for the
  // page instead of giving up on it. Both indexes derived from that answer are dropped here rather
  // than keyed on a generation of their own: a tree arrives at most once, and they rebuild lazily.
  for (const r of sheet.layout) foldAnimationNames(r);
  state.animNameIdx = null;
  state.keyframePropIdx = null;
  // LAYOUT rules only: a hide rule carries `display` / `visibility` as its own fields and no
  // `captured` map, and `layoutPropIndex` does not index them on the document side either — the two
  // sides answer the same question over the same rules, which is the whole point of this union.
  for (const r of sheet.layout) foldCapturedProps(r);
  for (const kf of (sheet.keyframes || [])) {
    let props = shadowKeyframeProps.get(kf.name);
    if (!props) shadowKeyframeProps.set(kf.name, props = new Set());
    for (const block of kf.blocks) for (const d of block.decls) props.add(d.prop);
  }
}
function foldAnimationNames (r) {
  const cap = r.captured;
  if (!cap) return;
  for (const key of ANIMATION_NAME_KEYS) {
    const d = cap[key];
    if (d === undefined) continue;
    const value = String(d.value);
    if (ANIM_VAR_RE.test(value)) { shadowAnimVar = true; continue; }
    for (const token of value.split(/[\s,]+/)) if (token) shadowAnimNames.add(token);
  }
}
function foldCapturedProps (r) {
  if (r.captured == null) return;
  for (const prop in r.captured) if (own(r.captured, prop)) shadowProps.add(prop);
}
export function resetShadowSheetFacts () {
  // …including whatever dom-nodes is still holding: an in-place reload keeps the Document, so roots
  // attached on the OLD page would otherwise be folded into the new one's facts — widening its gates
  // for the life of the page, re-arming the `::part()` rescan, and keeping the old tree alive.
  if (globalThis.__csimPendingShadowRoots) globalThis.__csimPendingShadowRoots.length = 0;
  shadowFactsPending.length = 0;
  shadowProps = new Set(); shadowKeyframeProps = new Map(); shadowSheets = []; shadowSheetSeen = new Set();
  shadowTreeFolds = 0; shadowAnimNames = new Set(); shadowAnimVar = false;
  kfIndexInline = false;
}


// ── the writers ──
// Conservative: the whole subtree and the siblings' subtrees (what every write did before the gate).
export function bumpCtxAll(el) {
  // …the callers that edit a child list DIRECTLY (`document.open()`, a template's content) and so
  // never reach `ctxChildListEffect`. They are structural mutations like any other.
  bumpStructureGen();
  el._selEpoch  = (el._selEpoch  || 0) + 1;
  el._kidsEpoch = (el._kidsEpoch || 0) + 1;
  el._descEpoch = (el._descEpoch || 0) + 1;
  const p = el._parent;
  if (p) { p._kidsEpoch = (p._kidsEpoch || 0) + 1; p._descEpoch = (p._descEpoch || 0) + 1; }
}
// Something the declared values of each of `els` — and their descendants', which inherit them — read moved where the
// cascade does not look: an animation of it started setting a property it had cached (the Web Animations bindings).
// Their own contexts and their subtrees', as an attribute write the selectors read below it moves them, and the tree
// generation the context memo keys on, once.
export function rekeySubtrees(els) {
  for (const el of els) {
    el._selEpoch  = (el._selEpoch  || 0) + 1;
    el._descEpoch = (el._descEpoch || 0) + 1;
  }
  bumpTreeGen();
}
// An inserted node: its own chain is new (`_selEpoch`, so a moved element's entry can't collide
// with the one keyed under its old parent) and so is its descendants' (`_descEpoch`).
export function bumpCtxInserted(el) {
  el._selEpoch  = (el._selEpoch  || 0) + 1;
  el._descEpoch = (el._descEpoch || 0) + 1;
}
// A child-list change on `el`: its own `:empty`, its children's positions and everything under them, and its siblings
// where its `:empty` can have flipped (`.e:empty + .x`).
export function ctxChildListEffect(el, added, removed) {
  bumpStructureGen();   // …an insertion or removal: every enclosing-root memo is stale (see above)
  el._selEpoch  = (el._selEpoch  || 0) + 1;
  el._kidsEpoch = (el._kidsEpoch || 0) + 1;
  el._descEpoch = (el._descEpoch || 0) + 1;
  if (added === undefined || removed === undefined || emptinessMayHaveFlipped(el, added)) siblingsOfEmptiness(el);
  // …and a host whose `:host(:empty)` / `:host(:first-child)` this can flip re-keys its tree (its `_descEpoch` is on
  // every in-tree element's chain).
  forHostsStructurallyReached(el, bumpDescEpoch);
  forHostsReachedFromBelow(el, bumpDescEpoch);
}
const bumpDescEpoch = (h) => { h._descEpoch = (h._descEpoch || 0) + 1; };
// `el`'s emptiness / child positions changed: its siblings and their subtrees (`.e:empty ~ .d .x`).
function siblingsOfEmptiness(el) {
  const p = el._parent;
  if (p) { p._kidsEpoch = (p._kidsEpoch || 0) + 1; p._descEpoch = (p._descEpoch || 0) + 1; }
}
// A character-data change under `el` (`:empty`): same as a child-list change minus the positions — and only where it can
// have flipped `:empty` at all, the one thing a selector reads of text (a `:has()` over it is never memoised). Called for
// every text edit, it re-keyed the edited text's element, its whole subtree on a page with a position read in a
// non-subject compound, and its parent's on one with an `:empty` left of a sibling combinator — so a text edit in a
// Redmine table cell cold-started the declared values around it on every keystroke, the largest part of a relayout's
// walk. `text` is the node edited, `emptied` whether it went empty or left it (a coalescing append from empty says so).
export function ctxCharDataEffect(el, text, emptied) {
  if (!emptied || (text && !emptinessMayHaveFlipped(el, [text]))) return;
  el._selEpoch = (el._selEpoch || 0) + 1;
  if (el._shadowRoot) forHostsStructurallyReached(el, (h) => { if (h === el) bumpDescEpoch(h); });
  forHostsReachedFromBelow(el, bumpDescEpoch);
  el._descEpoch = (el._descEpoch || 0) + 1;
  siblingsOfEmptiness(el);
}
// An attribute write on `el`: its own context, its subtree's and its siblings' — what the selectors read of the attribute
// is the style engine's to say, and the memos this side keeps are re-keyed in full.
export function ctxAttrEffect(el) {
  el._selEpoch = (el._selEpoch || 0) + 1;
  el._descEpoch = (el._descEpoch || 0) + 1;
  forHostsReachedFromBelow(el, bumpDescEpoch);
  const p = el._parent;
  if (p) { p._kidsEpoch = (p._kidsEpoch || 0) + 1; p._descEpoch = (p._descEpoch || 0) + 1; }
}
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
    rule.__looksDown = selectorSyntaxText(rule.selectorText || '').toLowerCase().indexOf(':has(') !== -1;
  }
  return rule.__looksDown;
}

// FOCUS and HOVER are signalled where they are written (dom-nodes.js `Document#_activeElement` / `_hoverElement`).
// `__csimFocusVisible` is compared here: it distinguishes `:focus-visible` from `:focus` at the same instant, so a
// pointer-driven focus that leaves the focused element unchanged still counts as a change.
let lastFocusVisible = undefined;
export function styleStateGeneration () {
  const fv = globalThis.__csimFocusVisible;
  if (fv !== lastFocusVisible) {
    lastFocusVisible = fv;
    const doc = globalThis.document, active = doc ? doc._activeElement : null;
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
  // The corners, which the loop above cannot see: their logical names carry no axis word, so
  // `border-start-start-radius` does not look like `border-<side>-radius` to it.
  for (const a of ['top', 'bottom']) for (const b of ['left', 'right']) set.add(`border-${a}-${b}-radius`);
  for (const a of ['start', 'end']) for (const b of ['start', 'end']) set.add(`border-${a}-${b}-radius`);
  return set;
};

export function cascadedProperty (el, prop) {
  // Up to THREE names can declare one property, and the cascade picks between them the same way
  // each time (`preferRecord`): the property itself, its flow-relative twin, and `all`.
  let win = cascadedRecord(el, prop);
  win = preferRecord(win, allRecord(el, prop));
  if (!hasFlowTwin(prop)) return win ? win.value : null;
  // `logicalCounterpart` answers in BOTH directions for the sizes (they are named symmetrically);
  // only the SIDE families need the dedicated physical mapping.
  const other = twinName(el, prop);
  if (!other) return win ? win.value : null;
  // The twin lookup is a SECOND full cascade walk, on exactly the properties the layout pass reads
  // several times per element — so it only runs when the twin could actually be declared. Both
  // questions are cached: the rule index per property, the inline map per style attribute.
  if (!cascadeDeclaresProperty(other) && !(other in inlineDecls(el))) return win ? win.value : null;
  win = preferRecord(win, cascadedRecord(el, other));
  return win ? win.value : null;
}

// Whether the declaration the cascade picked for `prop` is `!important` — the one question the
// ANIMATION layer has to ask of the cascade, because an animation overrides a normal declaration of
// any origin and loses to an important one (CSS Cascade §6.1). Asked only for a property an
// animation actually targets, so it costs a cascade walk on those and nothing anywhere else.
export function cascadedIsImportant (el, prop) {
  const win = preferRecord(cascadedRecord(el, prop), allRecord(el, prop));
  return !!(win && win.important);
}

// `all` is a shorthand over nearly every property, and the only values it takes are the CSS-wide
// keywords — so a declaration of it competes for THIS property exactly as a longhand declaration
// of it would. Without this the whole shorthand was inert in the cascade (it was modelled only in
// the CSSOM declaration layer), so `:host { all: initial }` — what every Web Component reset is
// written with — changed nothing at all.
//
// Gated twice before the lookup, because this is the hottest read in the driver and almost no page
// declares `all`: the property has to be one `all` covers, and `all` has to be declared SOMEWHERE
// (the rule index answers that from a cached key set) or on this element's own style attribute.
function allRecord (el, prop) {
  // `isCoveredByAll` is false for `all` itself, so this also answers "don't recurse".
  if (!isCoveredByAll(prop)) return null;
  if (!cascadeDeclaresProperty('all') && !('all' in inlineDecls(el))) return null;
  // Memoised per element per cascade epoch: the winning `all` declaration does NOT depend on which
  // property is asking, so without this every property read on the element paid its own full
  // cascade walk. That is not hypothetical — `cascadeDeclaresProperty` answers TRUE for any page
  // with a shadow host whether or not `all` appears anywhere (the shadow sheets have no property
  // key-set to ask), which measured as +15% on a shadow page that never uses `all`.
  // Keyed on the sheet epoch AND the mutation sequence, the same discipline the hide memo uses:
  // which `all` rule wins depends on the element's own classes / attributes too, and only the
  // dirty sequence moves for those. So the memo lives exactly as long as one mutation-free burst
  // — which is the whole of a layout pass, where the saving is.
  const ep = cascadeStyleEpoch(), seq = currentDirtySeq();
  if (el._allRecEp !== ep || el._allRecSeq !== seq) {
    el._allRec = cascadedRecord(el, 'all');
    el._allRecEp = ep;
    el._allRecSeq = seq;
  }
  const rec = el._allRec;
  // `all` takes ONLY the CSS-wide keywords. Anything else is an invalid declaration and a browser
  // drops it — without this check `all: 5px` set every property on the element to `5px`, layout
  // included, and `all: red` painted the page red. Checked on the RESOLVED value so a substituted
  // `all: var(--k)` is judged by what it produced, which is also how Chrome treats it.
  return rec && isCssWideKeyword(String(rec.value).trim()) ? rec : null;
}

// Which of two competing declarations for the same property the cascade prefers. Extracted from
// the flow-twin comparison so the `all` competition cannot drift from it — the rules are the
// cascade's, not any one caller's.
function preferRecord (own_, alt) {
  if (!alt) return own_;
  if (!own_) return alt;
  // Same origin AND same block? Then neither specificity nor source order separates them — every
  // declaration of a rule shares one `source` — and the winner is simply the one written later.
  if (own_.important === alt.important && own_.source === alt.source &&
      own_.order != null && alt.order != null) {
    return alt.order > own_.order ? alt : own_;
  }
  // An INLINE declaration outranks every selector rule at equal importance. `winsProp` knows that
  // for the incumbent (`current.inline`) but has no parameter for the candidate — it assumes one
  // is always a rule — so an inline `margin-inline-start` was compared on specificity `[0,0,0]`
  // and lost to a class rule's `margin-left`.
  // …once CONTEXT has not already decided (`contextWins` sits above the style attribute): a `:host` rule's
  // `!important` beats the host's inline one, and an outer `::part()` rule's normal one the part's.
  if (own_.important === alt.important && !!own_.inline !== !!alt.inline &&
      (own_.outerness || 0) === (alt.outerness || 0)) {
    return alt.inline ? alt : own_;
  }
  return winsProp(own_, alt.spec, alt.source, alt.important, alt.layerRank, alt.outerness) ? alt : own_;
}

// The twin's name, memoised per (property, flow configuration). The configuration object is shared
// by every element that inherits it, so a page in one writing mode computes each name once —
// running the two regexes on every property read was most of what the twin lookup cost.
export function twinName (el, prop) {
  const sides = flowSides(el);
  let memo = sides.twins;
  if (!memo) memo = sides.twins = new Map();
  if (memo.has(prop)) return memo.get(prop);
  const name = LOGICAL_CORNER_RE.test(prop)  ? physicalCorner(el, prop)
             : PHYSICAL_CORNER_RE.test(prop) ? logicalCorner(el, prop)
             : LOGICAL_SIDE_RE.test(prop)    ? physicalCounterpart(el, prop)
             : logicalCounterpart(el, prop);
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

// Author serials for shadow-scoped rules start here, above any document-sheet serial (per-page rule counts
// are far below this), so a shadow rule's `source` never equals a document rule's — which `preferRecord`
// reads as "the same rule". It orders nothing across trees: that is CONTEXT's (`contextWins`).
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
// The shadow root `el` lives in, or null — an O(depth) walk that `cascadedProperty` makes for EVERY
// property read to decide whether document rules reach the element. On a 400-row table beside one
// widget that was ~50% of what the host still cost the page: 1,200 light-DOM cells, each walking to
// the document root, each read, to learn `null` every time.
//
// Only the NULL answer is memoised, and those cells are the whole of the win — an element actually
// inside a shadow tree is a handful and can keep walking. Caching the root instead would put a Node
// on every element the cascade has read, and `ShadowRoot._parent` is its host, so a detached
// component's tree would be held alive by any reference to one element of it.
//
// Keyed on `structureGen`, which moves on every insertion or removal (`bumpStructureGen`) — the only way the
// answer can change is the element's own or an ancestor's insertion or removal. Coarse on purpose: one
// insertion anywhere invalidates every entry, which is right for a page that builds its DOM and then
// reads it, and no worse than the walk for one that does not. The realm token is the same guard
// `ctxEpochOf` carries: two realms count their own `structureGen` from 1, so a parent-realm stamp must not
// satisfy a frame-realm read.
// It is NOT the tree generation (`currentTreeGen`), and on purpose: that one also moves on every attribute write, and
// this memo is asked on every property read — an attribute can move no element into or out of a shadow tree.
let structureGen = 1;
const TREE_REALM_TOKEN = {};
export function bumpStructureGen() {
  structureGen = (structureGen + 1) | 0;
}
export function currentStructureGen() { return structureGen; }
function enclosingShadowRootOf(el) {
  if (!el) return null;
  if (el._encTok === TREE_REALM_TOKEN && el._encGen === structureGen) return null;
  for (let n = el._parent; n; n = n._parent) {
    if (n._isShadowRoot) return n;
  }
  el._encTok = TREE_REALM_TOKEN;
  el._encGen = structureGen;
  return null;
}

// Captured hide (display/visibility) + layout (color/geometry/custom-prop)
// rules from a shadow root's own stylesheets — its `<style>` descendants plus
// `adoptedStyleSheets`. Cached as `{ hide, layout }` on the root keyed on the
// global cascade version (rebuilt on page load / a document sheet mutation; the
// adoptedStyleSheets setter clears the cache, so dynamic reassignment is fresh).
// Rule `source` starts at SHADOW_SOURCE_BASE, disjoint from the document's; a routed `:host` / `::slotted()`
// rule carries its CONTEXT (`outerness: -1`).
// Every field a rule derives from its SELECTOR TEXT, absent — spread over a rule REWRITTEN to another selector (`:host(.x)`
// to `.x`, `:host(.x) p` to `p`, `::part(p)` to `*`), so that none of the original's describes a selector the rule no
// longer has: `anc` an ancestor requirement, `_natSel` a compiled matcher,
// `unmatchable` the engine's refusal of `::part()`, the dynamic verdict and its data. Each is derived again from the new
// text where it is asked (the pseudo-element subject, the verdict, the matcher, the features) — or, for `anc`, stays
// without the requirement.
const SELECTOR_DERIVED = {
  anc:          null,
  _natSel:      undefined,
  unmatchable:  false,
  __looksDown:  undefined,
  __dynamicSel: undefined
};
function scopedRulesFor(sr) {
  if (sr._scopedRulesVer === cascadeVersion && sr._scopedRules) return sr._scopedRules;
  const vp = currentViewport();
  const docBase = documentBaseUrl();
  const out = { hide: [], layout: [], hostHide: [], hostLayout: [], slottedHide: [], slottedLayout: [],
                // …and the PARSED sheets, which is where `shadowSheetFacts` reads what this tree declares.
                sheets: [] };
  let serial = SHADOW_SOURCE_BASE;
  // Route a rule to its scope bucket: `:host` / `:host(<inner>)` style the host
  // element (parent scope); `::slotted(<inner>)` styles light-DOM nodes assigned
  // to this tree's slots; everything else styles in-tree descendants. The
  // selectorText is rewritten to the part that matches the cross-scope target
  // (`*` for a bare `:host`). A `:host` compound LEFT of a combinator styles in-tree
  // elements under the host (`hostPrefix`); `:host-context(...)` stays an in-tree rule
  // (where it harmlessly fails to match).
  const route = (bucketHide, bucketLayout, rule, sel) => {
    // Every routed rule is a single whole-selector functional pseudo today, which collects no ancestor requirement
    // anyway; dropping what the ORIGINAL text derived (`SELECTOR_DERIVED`) is what keeps a later rewrite from shipping
    // one — or a dynamic verdict — that belongs to a different selector.
    // …and its CONTEXT: the tree it is written in is one boundary IN from the element it styles (`contextWins`).
    const rewritten = { ...rule, ...SELECTOR_DERIVED, selectorText: sel, source: rule.source + serial, outerness: -1 };
    if (rule.__hideRule) bucketHide.push(rewritten);
    else                 bucketLayout.push(rewritten);
  };
  const addSheet = (cssText, base) => {
    if (!cssText) return;
    addParsedSheet(parseSheetCached(cssText, vp), __sheetCacheKey(cssText, vp), base);
  };
  // …and one parsed already, under the key it is cached by: a `<link>`'s, which is fetched once per URL
  // (`parseUrlSheetCached`) however often the rule set is rebuilt.
  const addParsedSheet = (parsed, key, base) => {
    // …with the cache key beside it: `parseSheetCached` shares ONE object per stylesheet text, but its
    // LRU evicts past 256 distinct texts, and a re-parse after eviction is a NEW object. Deduping on
    // identity therefore re-folded and re-listed the sheet every time past that limit — 500 components
    // with 500 distinct sheets grew `shadowSheets` to 92,610 entries. The key does not evict.
    out.sheets.push({ sheet: parsed, key });
    const place = (rule) => {
      const st = rule.selectorText;
      const stl = st.toLowerCase();   // CSS pseudo names are case-insensitive
      let m;
      // …an argument that is not ONE compound selector (`::slotted(.x + li)`, `:host(a, b)`) makes the selector invalid,
      // and it matches nothing: css-scoping takes `<compound-selector>` in both. It was applied as written.
      if ((m = matchStandalonePseudo(st, stl, '::slotted('))) { if (isCompoundSelector(m)) route(out.slottedHide, out.slottedLayout, rule, m); }
      else if (stl === ':host')                               route(out.hostHide, out.hostLayout, rule, '*');
      else if ((m = matchStandalonePseudo(st, stl, ':host('))) { if (isCompoundSelector(m)) route(out.hostHide, out.hostLayout, rule, m); }
      else if (stl.indexOf(':host') !== -1 && (m = hostPrefix(st)) !== null) {
        // …in-tree, under a condition on the host (`hostSel`, asked by `safeMatches`), or never (`undefined`); the
        // dynamic verdict is the WRITTEN selector's, so a `:host(:hover) p` stays a dynamic rule.
        if (m !== undefined) {
          const placed = { ...rule, ...SELECTOR_DERIVED, selectorText: m.rest, source: rule.source + serial,
                           hostRule: m.host === undefined ? undefined : { selectorText: m.host },
                           __dynamicSel: ruleIsDynamic(rule) };
          (rule.__hideRule ? out.hide : out.layout).push(placed);
        }
      }
      else if (rule.__hideRule) out.hide.push({ ...rule, source: rule.source + serial });
      else                      out.layout.push({ ...rule, source: rule.source + serial });
    };
    for (const r of parsed.hide)   place({ ...r, __hideRule: true });
    // Absolutize background-image url()s against the sheet's base (a shadow adoptedStyleSheet can
    // carry a custom baseURL), same as the document cascade's per-sheet append.
    for (const r of parsed.layout) place({ ...r, captured: resolveCapturedImageUrls(r.captured, base) });
    serial += parsed.count;
  };
  // …its `<style>` and `<link rel=stylesheet>` elements in tree order, as a document's (`styleSheetOwners`).
  for (const owner of styleSheetOwners(sr)) {
    const media = owner._attrs.media;
    if (sheetDisabled(owner) || (media && !mediaMatches(media, vp))) continue;
    if (owner._tag === 'style') {
      if (styleElementIsCss(owner)) addSheet(effectiveStyleCss(owner), docBase);
    } else {
      const abs = shadowLinkSheetUrl(owner, docBase);
      if (!abs) continue;
      try { if (typeof globalThis.__csimSwRegisterStyleCors === 'function') globalThis.__csimSwRegisterStyleCors(abs, owner); } catch (_) {}
      const parsed = parseUrlSheetCached(abs, vp);
      if (parsed) addParsedSheet(parsed, urlSheetCacheKey(abs, vp), abs);
    }
  }
  const adopted = sr.adoptedStyleSheets;
  if (adopted) for (const sheet of adopted) if (adoptedSheetActive(sheet, vp)) addSheet(sheetCssText(sheet), sheet._href || docBase);
  sr._scopedRules = out;
  sr._scopedRulesVer = cascadeVersion;
  shadowFactsPending.push(sr);   // …rebuilt, so what it declares is folded in again
  return out;
}

function hostAdmits(el, hostRule) {
  const sr = enclosingShadowRootOf(el);
  const host = sr ? sr._parent : null;
  return !!host && host.nodeType === NODE_ELEMENT && safeMatches(host, hostRule);
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
  const names = asciiTokens(selectorText.slice(open, i));
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
    // Everything derived from the ORIGINAL selector text is dropped, as `route()` does for `:host` / `::slotted`
    // (`SELECTOR_DERIVED`) — `unmatchable` above all: the ordinary shadow-rule walk sets it the first time it tries
    // `::part()` as a plain selector, and a copy that inherited it would refuse the perfectly matchable `*` / `.x` /
    // `*:hover` this rewrites to.
    const rewrite = (selectorText) => ({ ...r, ...SELECTOR_DERIVED, selectorText, __part: null });
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
  const names = asciiTokens(raw);
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
      // …the rules it is MATCHED by, which carry their own verdicts: the one it was written as holds `::part()`, which
      // the ordinary shadow walk cannot compile and so flags `unmatchable` — noted, a tree's own `:host::part(p):hover`
      // tainted nothing once that walk had run.
      noteDynamic(c.hostRule);
      if (c.partRule) noteDynamic(c.partRule);
      if (!safeMatches(host, c.hostRule)) continue;
      if (c.partRule && !safeMatches(el, c.partRule)) continue;
      // `outerness` — how many shadow boundaries out the rule lives — is the CONTEXT the cascade
      // sorts on (see contextWins).
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
// and an `!important` one from the INNER tree does. `outerness` counts the boundaries out from the
// element's own tree (0, which is where an inline style and the tree's own rules sit): a `::part()`
// rule is 1 or more, and a `:host` / `::slotted()` rule — written in the tree ONE boundary in — is -1.
// So, Chrome and Firefox alike:
//
//   `#host::part(p) { color: green }`   beats  `style="color: red"` on the part      (outer, normal)
//   `#host::part(p) { color: green !important }`  loses to the tree's own `!important` (inner)
//   `.base { height: 20px }` in the document  beats  `:host(.red) { height: 120px }`  (outer, normal)
//
// Asked by `winsProp` / `winsCascade` once importance is equal; null when the contexts are EQUAL, and the
// ordinary ladder (inline, layers, specificity, source) decides.
function contextWins(current, outerness, important) {
  const co = current.outerness || 0;
  if (outerness === co) return null;
  return important ? outerness < co : outerness > co;
}

// If `selectorText` is exactly `<prefix><inner>)` (a standalone functional
// pseudo like `:host(.x)` / `::slotted(span)` with nothing after the closing
// paren), return `<inner>` (original case, so a class like `.Foo` is preserved);
// else null. `lower` is `selectorText` lower-cased for the case-insensitive
// pseudo-name prefix test (`prefix` is lower-case). Balanced-paren aware.
// A shadow-tree selector whose FIRST compound is `:host` / `:host(<compound>)` followed by a combinator: the host is
// every in-tree element's shadow-including ancestor, and the one a top-level element hangs from (css-scoping §3.2.1),
// so `:host p` is the tree's `p`, `:host > p` its top-level `p` (`:not(* > *)` — nothing in the tree is its parent),
// and `:host(.x) p` the tree's `p` while the host matches `.x`. Answered as `{ host, rest }` (`host` undefined for a
// bare `:host`), `undefined` for a form that can never match (the host has no siblings in its tree, nothing in the
// tree precedes it, and a featureless host matches no type, class or attribute of its own), `null` when the selector
// has no leading `:host` at all. Chrome matched every one; this engine matched none.
function hostPrefix(sel) {
  let groups;
  try { groups = CW.parse(sel); } catch (_) { return null; }
  if (groups.length !== 1) return null;
  const g = groups[0];
  let end = 0;
  while (end < g.length && !CW_COMBINATORS.has(g[end].type)) end++;
  const first = g.slice(0, end);
  if (!first.some(hostToken)) return g.some(hostToken) ? undefined : null;   // `.a :host p`: the host is the tree's top
  if (end === g.length) return null;                                        // no combinator: a standalone form, routed above
  const comb = g[end].type;
  if (comb !== 'descendant' && comb !== 'child') return undefined;
  // …the compound is `:host` / `:host(<compound>)` and NOTHING else: a featureless host matches no type, class or
  // pseudo-class of its own (`:host:not(.q) p`, `:host(.x):not(.y) p` match nothing in Chrome).
  if (first.length !== 1) return undefined;
  const host = hostCondition(first[0]);
  if (host === undefined) return undefined;
  const rest = g.slice(end + 1);
  if (!rest.length) return undefined;
  if (comb === 'child') {
    let k = 0;
    while (k < rest.length && !CW_COMBINATORS.has(rest[k].type)) k++;
    rest.splice(k, 0, { type: 'pseudo', name: 'not', data: CW.parse('* > *') });
  }
  return { host: host === null ? undefined : host, rest: CW.stringify([rest]) };
}
// Whether a token IS the host — `:host`, `:host(…)`, or `:is()` / `:where()` holding only that (`:where(:host) p` matches
// in Chrome, with the specificity the written rule already carries).
function hostToken(t) {
  if (t.type !== 'pseudo') return false;
  const name = String(t.name).toLowerCase();
  if (name === 'host') return true;
  return (name === 'is' || name === 'where') && Array.isArray(t.data) && t.data.length === 1 && t.data[0].length === 1 && hostToken(t.data[0][0]);
}
// The condition a host token puts on the host: null for a bare `:host`, the argument's text for `:host(<compound>)`,
// `undefined` for an argument that makes the selector invalid (not one compound). A `:has()` is a pseudo-class of the
// compound like any other, and the host in its normal context matches it or not (css-shadow-1 `:host()`; Firefox
// matches `:host(:has(.f))` on a host holding a `.f`, Chrome takes no `:has()` there).
function hostCondition(t) {
  const name = String(t.name).toLowerCase();
  if (name !== 'host') return hostCondition(t.data[0][0]);
  if (!Array.isArray(t.data)) return null;
  if (t.data.length !== 1 || t.data[0].some((n) => CW_COMBINATORS.has(n.type))) return undefined;
  return CW.stringify([t.data[0]]);
}
function isCompoundSelector(text) {
  let groups;
  try { groups = CW.parse(text); } catch (_) { return false; }
  return groups.length === 1 && !groups[0].some((t) => CW_COMBINATORS.has(t.type));
}
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
// Does any `@keyframes` block declare this property? An animation is the THIRD place a value can
// come from, beside a rule and a style attribute, and it is the one the layout gates used to miss:
// a `transform` that only ever appears inside `@keyframes` is absent from the rule index, so
// `declaresLayoutProp` said no and the geometry never asked the value model what the property was —
// `getComputedStyle` reported the interpolated matrix while `getBoundingClientRect` reported the
// untransformed box. Document-wide and O(1), exactly like `cascadeDeclaresProperty`, and for the
// same reason: asking per element would be a scan per element per pass (rule 3).
//
// A shadow tree's keyframes are folded into `keyframePropIndex` by `shadowSheetFacts`, which it
// drains itself — it must not lean on a caller ORing `cascadeDeclaresProperty` in first, which is how
// the fail-open used to cover it and is a reordering away from the two halves of one geometry
// disagreeing again.
// The per-element half of the same question — the engine's animations — registered rather than imported:
// web-animations.js imports this module, so an import the other way would be a cycle. Two shapes so neither caller has
// to allocate: one property, or a whole family.
let ANIM_DECLARES = null;
let ANIM_DECLARES_ANY = null;
export function onAnimationProperties (one, any) {
  ANIM_DECLARES = one;
  ANIM_DECLARES_ANY = any;
}
// Does ANYTHING turn the flow — a `direction` / `writing-mode` rule, or what an attribute write
// latched (mutation-observer.js `noteDocumentWideAttribute`: an inline declaration, a `dir`) or an
// element's construction did (dom-nodes.js: a `<bdi>`)? `flowSides` starts here: on the
// overwhelmingly common page the answer is no, and every ask — margins, insets, line alignment,
// now one per block with text — is a constant, not a memo walk (measured: asking per block cost
// 4000 paragraphs 8-10% of a relayout before this).
export function documentTurnsFlow () {
  return !!globalThis.__csimFlowHint || cascadeDeclaresProperty('writing-mode') || cascadeDeclaresProperty('direction');
}
// Does ANYTHING in the document declare this inherited line property (`text-align` /
// `text-indent`) — a rule, a keyframe, an inline declaration anywhere, or for `text-align` a
// UA-aligned tag or an `align` attribute (the same latches)? The O(1) question a layout pass asks
// per BLOCK before it pays a computed-value read for a property that inherits: on a page that
// never mentions `text-align`, every line starts at the content edge and nothing is read.
export function documentDeclaresLineProp (prop) {
  // (…under the style engine, open: what each element reads is its computed value, which the engine has whatever the
  // document declares, where the latches would ask the JS rules)
  if (engineAnswers()) return true;
  return !!globalThis.__csimInlineLineStyle || cascadeDeclaresProperty(prop) || keyframesDeclareProperty(prop) ||
         (prop === 'text-align' && !!globalThis.__csimLineAlignHint);
}

// Does an ANIMATION declare this property anywhere in the document? Animations are the THIRD place
// a declaration can come from, beside a rule and a style attribute, and the one the layout gates
// were blind to: a `@keyframes` block and an `element.animate()` frame each declare a property that
// appears in no rule index and in no inline map. The value model already interpolated it, so
// `getComputedStyle` reported the animated value while every gate said the property was absent from
// the page and layout read the static cascade instead — measured, a `translateX` animated to 100px
// reported `matrix(1, 0, 0, 1, 100, 0)` from `getComputedStyle` and an UNTRANSFORMED
// `getBoundingClientRect`, and an animated `max-width: 40px` laid out at its full 100px where
// Chrome lays it out at 40. Adding a rule that matched NOTHING fixed both: the value was always
// there to be asked for.
//
// Document-wide and O(1), like `cascadeDeclaresProperty`, and for the same reason — the gates run
// per element per pass, so asking per element would be a scan per element per pass (rule 3).
// The `@keyframes` half is answered for the DOCUMENT and the engine's half for the ELEMENT, and the
// difference is measured: a `@keyframes` block is named by a rule that some set of elements matches,
// and deciding which without reading their style is the work the gate exists to avoid — but a running
// animation names its target outright, so asking per element there is free and keeps one animated
// element from opening the gate for the whole page (measured at +35% wall on a 1600-element page with
// 400 live animations, growing superlinearly).
export function animationsDeclareProperty (el, prop) {
  return keyframesDeclareProperty(prop) || (ANIM_DECLARES !== null && ANIM_DECLARES(el, prop));
}
// …and the same question about a whole FAMILY, asked once rather than once per name: a gate that
// covers eight longhands (`mayConstrainSize`) runs per element per pass, and eight calls would be
// eight index fetches and eight engine calls where one of each does.
export function animationsDeclareAnyOf (el, props) {
  const kf = keyframePropIndex();
  for (const prop of props) if (kf.has(prop)) return true;
  return ANIM_DECLARES_ANY !== null && ANIM_DECLARES_ANY(el, props);
}

export function keyframesDeclareProperty (prop) {
  return keyframePropIndex().has(prop);
}
function keyframePropIndex () {
  ensureCascadeFresh();
  // The drain goes FIRST, before the memo is read: it may DROP this index (a tree that just arrived
  // widens the referenced-name set), and reading first returned the narrower answer built without it.
  shadowSheetFacts();
  // …and the inline-animation latch is the one input this index folds in that nothing else watches.
  // `referencedAnimationNames` answers `null` once it is set — "every name counts" — and that answer
  // was baked into the memo, so a page READ before its first `el.style.animation = …` kept the
  // narrower index for good: `getComputedStyle` reported the interpolated matrix and
  // `getBoundingClientRect` the untransformed box, on a page with no shadow DOM at all. The normal
  // Capybara ordering — find, then act — is exactly the warm one.
  const inlineAnim = !!globalThis.__csimInlineAnimation;
  if (kfIndexInline !== inlineAnim) { kfIndexInline = inlineAnim; state.keyframePropIdx = null; state.animNameIdx = null; }
  let idx = state.keyframePropIdx;
  if (idx === null) {
    idx = state.keyframePropIdx = new Set();
    const named = referencedAnimationNames();
    const kf = state.keyframes;
    if (kf && kf.size) {
      for (const [name, blocks] of kf) {
        if (named !== null && !named.has(name)) continue;
        for (const block of blocks) for (const d of block.decls) idx.add(d.prop);
      }
    }
    // …and a SHADOW tree's own `@keyframes`, through the SAME name filter. A component that ships
    // `@keyframes spin` and references it nowhere is the very shape this filter exists for, and the
    // likelier one for a design system — folding its properties in unconditionally left that half
    // open while closing the document's.
    for (const [name, props] of shadowKeyframeProps) {
      if (named !== null && !named.has(name)) continue;
      for (const prop of props) idx.add(prop);
    }
  }
  return idx;
}
let kfIndexInline = false;

// Which `@keyframes` names anything actually references, or `null` when that cannot be decided from
// the sheets alone (an inline `animation` declaration) — and then every name counts, as it did before
// this filter. A shadow tree's rules are folded in (`shadowAnimNames`) rather than giving up on the
// page: a host used to make every `@keyframes` count again, which on the very shape this filter exists
// for — a block the page SHIPS and nothing references — measured 1.12x for a widget that animates
// nothing (43.5 ms → 48.6 ms on a 400-row table).
//
// A block nothing names declares nothing. `@keyframes spin { transform: … }` ships in Bootstrap and
// in Tailwind's default theme, so without this the transform gate opened for every element of every
// page that merely INCLUDES one of those stylesheets: measured at +19.5% wall on a page where the
// animation is applied to nothing at all, and back to +1.1% with the filter.
//
// The values are tokenised rather than parsed: `animation: 1s spin` and `animation-name: spin, fade`
// both just have to yield `spin`, and a keyword that happens to collide with a keyframes name only
// widens the answer — this is a "may" gate, and over-approximating is the safe direction. A `var()`
// is the one form that does NOT widen it: `animation: 10s var(--n)` tokenises to `var(--n)`, so the
// real name never enters the set and the block it names is filtered out WHILE IT IS RUNNING — Chrome
// moves the box 120px, we left it at 0. The page is undecidable from the sheets there, which is what
// `null` means and what the inline arm below already says.
const ANIMATION_NAME_KEYS = ['animation-name', 'animation'];
const ANIM_VAR_RE = /var\(/i;
function referencedAnimationNames () {
  if (globalThis.__csimInlineAnimation) return null;
  shadowSheetFacts();
  if (shadowAnimVar) return null;
  let names = state.animNameIdx;
  if (names === null) {
    names = new Set(shadowAnimNames);
    for (const rule of state.layoutRules) {
      const cap = rule.captured;
      if (!cap) continue;
      for (const key of ANIMATION_NAME_KEYS) {
        const d = cap[key];
        if (d === undefined) continue;
        const value = String(d.value);
        if (ANIM_VAR_RE.test(value)) return null;   // …undecidable: not memoised, and cheap to re-decide
        for (const token of value.split(/[\s,]+/)) if (token) names.add(token);
      }
    }
    state.animNameIdx = names;
  }
  return names;
}

export function cascadeDeclaresProperty (prop) {
  ensureCascadeFresh();
  return rulesIndexHas(prop) || shadowSheetFacts().has(prop);
}
// One structure answers both questions: the property-first index's key set IS "some rule
// captures this property", so the former per-property scan-and-cache (`propCache`) is gone.
function rulesIndexHas (prop) {
  return layoutPropIndex().has(prop);
}

function cascadedTextTransform (el) {
  // (…under the style engine, the computed value: the inherited one where it declares none)
  if (engineAnswers()) {
    const v = engineValue(el, 'text-transform');
    if (v !== undefined) return v;
  }
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
// The four `white-space` values that keep some of their white space, and they do NOT keep it the
// same way: `pre-line` collapses spaces and tabs and preserves only newlines, where the other three
// preserve everything.
const WS_PRESERVING_VALUES = new Set(['pre', 'pre-wrap', 'pre-line', 'break-spaces']);
const WS_VALUES = new Set(['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces']);
// What this element DECLARES for `white-space`, through the UA layer as well as the author cascade
// — `<pre>` / `<textarea>` / `<listing>` carry theirs as a UA rule, invisible to the cascade alone —
// or null when it declares nothing and the property inherits.
//
// Only a real keyword counts. `inherit` / `unset` / `revert` and anything unparseable are not
// values this property takes, and treating them as ones made a `white-space: unset` span inside a
// `<pre>` collapse its spaces where every browser preserves them; `initial` IS a value, and it is
// `normal`. Exported because layout resolves the same property for line breaking: one reader, so
// the geometry and the text can't disagree about which spaces exist.
// The only tags whose UA stylesheet sets `white-space`. `uaDefault` resolves a whole UA rule set
// and the rendered-text walk asks EVERY element, so it is asked only where it can answer (rule 3:
// unconditionally was +36% on the walk).
const UA_WS_TAGS = new Set(['pre', 'textarea', 'listing', 'xmp', 'plaintext', 'nobr']);
export function ownWhiteSpace(el) {
  // (…under the style engine, the computed value — one of the keywords, or a combination of the longhands no keyword
  // names, which this model has no mode for either way)
  if (engineAnswers()) {
    const v = engineValue(el, 'white-space');
    if (v !== undefined) return WS_VALUES.has(v) ? v : null;
  }
  // …and the cascade is only consulted where it CAN answer: the rule index says in O(1) whether any
  // stylesheet declares `white-space` at all, and the element's own inline map covers the rest —
  // the `declaresLayoutProp` pattern, for the same reason (one cascade read per element per walk is
  // what a hot `page.text` cannot afford, rule 3).
  let raw = elementMayDeclare(el, 'white-space') ? declaredValue(el, 'white-space') : null;
  if (raw == null) raw = UA_WS_TAGS.has(el._tag) ? uaDefault(el, 'white-space') : null;
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'initial') return 'normal';
  return WS_VALUES.has(v) ? v : null;
}
// This element's own computed `white-space`, through the SAME resolution layout uses — one value
// for one element. `layout.js` walks the ancestors reading `declaredValue ?? uaDefault` and
// memoises it, which is what `<pre>` needs: its `white-space: pre` is a UA rule, invisible to the
// author cascade. Reading only the author cascade here meant `<pre>` had to be special-cased by
// TAG, and then the preserve flag had to be made sticky to fake inheritance — which is why a
// `white-space: normal` span inside a `<pre>` kept preserving.
// The mode in force AT `node`, resolving the inheritance by walking up. O(depth), and the walk
// below pays it ONCE at its root — every element inside gets its parent's answer handed down.
export function inheritedWhiteSpace(node) {
  for (let cur = node; cur; cur = cur._parent) {
    if (cur.nodeType !== NODE_ELEMENT) continue;
    const own = ownWhiteSpace(cur);
    if (own) return own;
  }
  return 'normal';
}
// Does this element generate a box for the rendered-text walk? `<script>`/`<style>` and friends
// never do; fallback content is not rendered either, so `innerText` of a `<canvas>` carrying "your
// browser doesn't support…" is empty in a browser; and the two hiding predicates are the cascade's — the DISPLAY side
// only: `visibility` hides a node's own contribution, not its subtree (`collectText`'s `hidden`), so a hidden element
// stopping the walk here lost a `visibility: visible` child that still reads.
// (…and under the style engine, what it SHOWS: a `display: none` there, and a box that skips its contents — under a
// `content-visibility: hidden`, a `hidden=until-found`'s among them — whose text renders nothing, not even the breaks
// around it: Chrome, "A||" for `A|<div hidden=until-found>uf</div>|`.)
function generatesTextBox(el) {
  if (INVISIBLE_TAGS.has(el._tag) || hasFallbackOnlyContent(el) || uaNotRendered(el)) return false;
  const shown = engineAnswers() ? styleEngineShown(el) : undefined;
  return shown !== undefined ? shown !== 0 && !styleEngineSkips(el) : !selfHidden(el);
}

// What the last `collectVisibleText` call produced, beyond its string. A collected string cannot
// say whether its whitespace is COLLAPSIBLE (a space between words, which renders nothing against
// a line break) or rendered (a `<br>`, an NBSP, anything under `white-space: pre`), nor whether the
// walk ended owing its parent a break — and the caller needs both. Module-level rather than an
// out-parameter because the walk is depth-first and synchronous: the parent reads them on the line
// after the call returns, and nothing allocates.
let lastCollapsibleOnly = true;   // the string is only collapsible white space
let lastOwedBreaks = 0;           // required line breaks this walk did not write (see the return)
// White-space processing is STREAMING: whether a collapsible space renders depends on what was
// emitted before it, across siblings and across nesting, so the state belongs to the whole walk
// rather than to one element's string. The public entry starts a walk; the recursion below shares
// its state. (Before this, each text node was collapsed on its own and a final pass over the
// finished string did the rest — which could not tell a `<pre>`'s spaces from collapsible ones and
// trimmed them away.)
let emitAtStart = true;              // nothing rendered yet — a leading collapsible space is dropped
let emitEndsCollapsibleSpace = false; // the last thing rendered was a collapsible space
let emitBreakPending = false;         // a required break comes before whatever is collected next
let emitAnyRendered = false;          // anything at all has been rendered by this walk
let walkRoot = null;                  // the element the current walk was asked about
// Whether a host's light child renders is its slot's question, asked once per slot per walk (`slotTextState`) — and so
// is the `visibility` it inherits, which comes through the SLOT, not the host: a span slotted into a hidden shadow box
// is hidden, and one slotted into a visible box inside a hidden host is not (Chrome and Firefox, and our own computed
// style). 0: not rendered; 1: rendered and visible; 2: rendered, visibility-hidden.
let slotRenders = null;
function slotTextState(slot, shadowRoot, hostHidden) {
  if (!slotRenders) slotRenders = new Map();
  let v = slotRenders.get(slot);
  if (v === undefined) {
    if (!isVisibleNodeImpl(slot, true, false, shadowRoot)) {
      v = 0;
    } else {
      // Its `visibility` from the HOST's — which the walk already holds — down the shadow-side ancestors to the slot,
      // not resolved from the slot to the document: that second walk per slot per read doubled the text of an
      // 800-component page.
      const host = shadowRoot._parent, chain = [];
      for (let n = slot; n && n !== host; n = flatTreeParent(n)) chain.push(n);
      let hidden = hostHidden;
      for (let i = chain.length - 1; i >= 0; i--) hidden = hidesByVisibility(chain[i], hidden);
      v = hidden ? 2 : 1;
    }
    slotRenders.set(slot, v);
  }
  return v;
}
export function collectVisibleText(node, transform, preserveWs) {
  walkRoot = node;
  slotRenders = null;
  // The `visibility` the walk starts under: its parent's, resolved once, then threaded down (`hidesByVisibility`).
  const parent = node._parent && node._parent.nodeType === NODE_ELEMENT ? node._parent : null;
  const above = parent ? visibilityHidden(parent) : false;
  emitAtStart = true;
  emitEndsCollapsibleSpace = false;
  emitBreakPending = false;
  emitAnyRendered = false;
  const out = collectText(node, transform, preserveWs, node.nodeType === NODE_ELEMENT ? hidesByVisibility(node, above) : above);
  // A collapsible space at the very END renders nothing either — the last line's trailing edge,
  // which the per-line trim used to take care of before white-space processing moved in here.
  return (emitEndsCollapsibleSpace && out.endsWith(' ')) ? out.slice(0, -1) : out;
}
// `hidden`: whether THIS node's `visibility` hides it (for a text node, its parent's). innerText §2: a node whose
// `visibility` is not `visible` contributes its CHILDREN's items and nothing of its own — no text, no `<br>` newline, no
// required line breaks — so a `visibility: visible` child of a hidden element still reads (Chrome and Firefox: "b").
function collectText(node, transform, preserveWs, hidden = false) {
  lastCollapsibleOnly = true;
  lastOwedBreaks = 0;
  if (node.nodeType === NODE_TEXT && hidden) return '';
  if (node.nodeType === NODE_TEXT) {
    const data = String(node.data || '');
    // Recursion threads `preserveWs` from the entering element, but
    // a direct text-node entry (rare) has no flag — fall back to the
    // ancestor walk in that case.
    // A direct text-node entry (rare) has no mode threaded in — resolve it from the ancestors.
    if (preserveWs === undefined) preserveWs = node._parent ? inheritedWhiteSpace(node._parent) : 'normal';
    // CSS Text §white-space processing, per node: a run of collapsible white space renders as ONE
    // space, and `pre-line` collapses spaces and tabs while keeping its newlines. Doing it here —
    // rather than over the finished string — is what lets a `<pre>` inside a `white-space: normal`
    // parent keep its spaces.
    // `pre-line` renders only its newlines: its spaces and tabs collapse like `normal`'s, and the
    // ones that end up beside a newline disappear with it (Chrome: `abc \n def` is "abc\ndef").
    // `normal` / `nowrap` collapse everything; `pre-line` collapses spaces and tabs and keeps its
    // newlines; the other three keep it all.
    const preserving = WS_PRESERVING_VALUES.has(preserveWs);
    const collapsesSpaces = !preserving || preserveWs === 'pre-line';
    let raw = preserveWs === 'pre-line' ? data.replace(/[ \t\f]+/g, ' ').replace(/ ?\n ?/g, '\n')
            : preserving               ? data
            :                            data.replace(COLLAPSIBLE_WS_RUN_RE, ' ');
    let outText = applyTextTransform(raw, transform || 'none');
    // …and the run that CROSSES nodes: a collapsible space renders nothing when what came before it
    // was one, or when nothing has been rendered yet. `<b>a </b> b` is "a b", and " abc" is "abc".
    if (collapsesSpaces && outText.startsWith(' ') &&
        (emitAtStart || emitEndsCollapsibleSpace || emitBreakPending)) {
      outText = outText.slice(1);
    }
    // CSS collapsible white space is exactly ` \t\n\r\f` — NOT JS's `\s`, which also matches
    // NBSP, the ideographic space and the rest of Unicode's spacing, every one of which RENDERS.
    // And text that PRESERVES its white space is never collapsible.
    // `pre-line` collapses its spaces and tabs like `normal` does — only its newlines are
    // rendered — so a run of them next to a break disappears just the same.
    lastCollapsibleOnly = collapsesSpaces && !/[^ \t\n\r\f]/.test(outText) &&
                          !(preserving && outText.indexOf('\n') !== -1);
    if (outText) {
      emitAtStart = false;
      emitBreakPending = false;
      if (!lastCollapsibleOnly) emitAnyRendered = true;
      emitEndsCollapsibleSpace = collapsesSpaces && outText.endsWith(' ');
    }
    return outText;
  }
  if (node.nodeType !== NODE_ELEMENT && node.nodeType !== NODE_DOC && node.nodeType !== NODE_FRAGMENT) return '';
  if (node.nodeType === NODE_ELEMENT) {
    // Nothing under a box-less element is rendered text. `generatesTextBox` is the same question
    // the child loop below asks about an EMPTY block, so the two can't drift.
    if (!generatesTextBox(node)) return '';
    // …and the newline a `<br>` renders is a FORCED break: it survives beside a required one
    // (`abc<div><br></div>def` is three breaks in Chrome), where a collapsed space would not. It is
    // what the `<br>` contributes to the text AROUND it, though — asked for its OWN `innerText`, a
    // `<br>` has no content and answers "" (`getter.html`'s `<br>` case reads the element itself).
    // A `<textarea>`'s content is its VALUE, not rendered text: it contributes nothing to an
    // ancestor's `innerText` (Chrome measured — the wrapper of a textarea holding "a  b" is ""),
    // while the element asked about ITSELF still answers with its value, which is what Capybara
    // reads (`__csimInnerText`'s own textarea case).
    if (node._tag === 'textarea' && node !== walkRoot) return '';
    if (node._tag === 'br') {
      // (…a `display: contents` one is no break: it behaves as `none` on a `<br>`, and layout draws `aa<br>bb` on one
      // line — Chrome's innerText is `aabb`.)
      if (node === walkRoot || hidden || !globalThis.__csimGeneratesBox(node)) return '';
      lastCollapsibleOnly = false;
      emitAnyRendered = true;
      return '\n';
    }
    const ownTransform = cascadedTextTransform(node);
    const effTransform = (ownTransform && ownTransform !== 'inherit') ? ownTransform : (transform || 'none');
    // `preserveWs` is sticky: once an ancestor has `white-space: pre*`
    // (or is `<pre>`), every descendant text node preserves whitespace,
    // so threading the flag down beats walking ancestors per text node.
    // `white-space` INHERITS, so the mode is threaded DOWN and an element that declares its own
    // replaces it — a `white-space: normal` span inside a `<pre>` folds its spaces (Chrome), which
    // a sticky "is preserving" flag could not express. Threading also means each element reads its
    // own declaration once: no ancestor walk, no memo, no depth cap.
    preserveWs = ownWhiteSpace(node) || preserveWs || 'normal';
    if (node._tag === 'details' && node._attrs.open == null) {
      // Closed details: only emit text inside <summary>.
      let s = '';
      for (const c of node._children) {
        if (c.nodeType === NODE_ELEMENT && c._tag === 'summary') s += collectText(c, effTransform, preserveWs, hidesByVisibility(c, hidden));
      }
      return s;
    }
    transform = effTransform;
  }
  const flexContext = node.nodeType === NODE_ELEMENT && isFlexLikeContainer(node);
  let out = '';
  // Required line breaks are PENDING until something is written after them, because they MERGE
  // (innerText §4: consecutive requirements collapse to the largest) and because collapsible
  // white-space next to one renders nothing. Writing each break as it was met made
  // `abc<hr> <hr>def` two breaks around a space where every browser gives one.
  let pending = 0;
  // Whether everything written here is collapsible white space, and the breaks this walk ends up
  // owing — the two things `lastCollapsibleOnly` / `lastOwedBreaks` report to the caller.
  let collapsibleOnly = true;
  // Whether `out` currently ends in a space, tracked rather than asked. `out` is built by repeated
  // `+=`, which V8 keeps as a cons string; `endsWith` flattens it, and doing that once per child at
  // every level was the whole of this walk's cost over the previous one (measured: 113 ms to 106).
  let outEndsSpace = false;
  // Writing a required break also ENDS a line, and a collapsible space either side of one renders
  // nothing: `abc <div>x</div>` is "abc\nx", not "abc \nx". The trailing half is stripped here (it
  // is the tail of what this level has written), the leading half by the text branch, which sees
  // the flag this leaves behind.
  // Writing the owed breaks is INLINE at both sites below, never a closure: one arrow function per
  // element — capturing and mutating `out` and `pending` — costs a heap-allocated context per call
  // and measured 48% of this walk (`innertext_rendered_text`). `spaceBefore` there is the state as
  // it stood BEFORE the child being written was collected: collecting it has already moved the
  // flags, and the space to drop is the one that preceded it.
  // A shadow HOST renders its light children only through the slots they are assigned to — none, or a slot that is
  // itself not rendered, and they are no part of its text (Chrome: `""` for a host whose children no rendered slot
  // takes, where this read "UH"). The walk does not descend the shadow tree itself (see the carve-out below).
  // The host itself was reached through rendered ancestors, so the slot is asked only as far as its shadow root, and
  // once per walk: asked all the way to the document for every light child, the text of an 800-component page took
  // 2.5x as long.
  const host = node.nodeType === NODE_ELEMENT && node._shadowRoot;
  for (const c of node._children) {
    let inherited = hidden;
    if (host) {
      const slot = c._assignedSlot !== undefined ? c._assignedSlot : assignedSlotFor(c);
      const state = slot ? slotTextState(slot, host, hidden) : 0;
      if (!state) continue;
      inherited = state === 2;
    }
    // Whitespace-only text nodes between flex/grid items don't
    // produce visible runs (no anonymous flex item is generated
    // for whitespace).
    if (flexContext && c.nodeType === NODE_TEXT && !/\S/.test(String(c.data || ''))) continue;
    // …white space only: text put there by the DOM (`tr.appendChild(document.createTextNode(…))`)
    // is wrapped in an anonymous cell and RENDERS. The parser foster-parents such text out, so
    // this is the script-built case, and skipping it lost real content.
    if (c.nodeType === NODE_TEXT && node.nodeType === NODE_ELEMENT &&
        TABLE_STRUCTURE_TAGS.has(node._tag) && !/\S/.test(String(c.data || ''))) continue;
    const spaceBefore = emitEndsCollapsibleSpace;
    // …and whether anything has been rendered at all, sampled BEFORE this child is collected: a
    // required break SEPARATES, so with nothing in front of it there is nothing to separate. Asking
    // this element's own `out` instead answered "nothing" for a block that merely opens an inline
    // (`abc<span><div></div>def</span>` lost the break Chrome puts before `def`).
    const renderedBefore = emitAnyRendered;
    // Whatever is collected next opens a line if a break is already owed, so a collapsible space
    // at its start renders nothing either.
    if (pending) emitBreakPending = true;
    const isElement = c.nodeType === NODE_ELEMENT;
    const cHidden = isElement ? hidesByVisibility(c, inherited) : inherited;
    const part = collectText(c, transform, preserveWs, cHidden);
    const partCollapsible = lastCollapsibleOnly;
    // What the child itself left behind. Writing the owed breaks below sets the flag to "a
    // collapsible space was last", which is true of the BREAK but not of the part written after
    // it — and the next strip then ate a PRESERVED space (`<p>b  </p>` under `pre-wrap` lost one).
    const partEndsCollapsibleSpace = emitEndsCollapsibleSpace;
    const isCell = isElement && TABLE_CELL_TAGS.has(c._tag);
    // An atomic inline separates the white space around it even though it contributes no text of
    // its own — and it is skipped by the empty-child gate below, so this is settled first.
    if (isElement && ATOMIC_INLINE_TAGS.has(c._tag) && generatesTextBox(c)) {
      emitEndsCollapsibleSpace = false;
      emitAtStart = false;
      emitBreakPending = false;
    }
    // A td/th whose content includes a BLOCK box acts like a block at the tr-level: \n before AND
    // after, to produce `"A\n\t\nB"` between adjacent cells (W3C innerText §14.4). A cell whose
    // content is pure inline text emits only the `\t` separator — Chrome `tr.innerText` for
    // `<td>A</td><td>B</td>` is `"A\tB"`. The question is STRUCTURAL: the walk reports the breaks
    // the cell owes, where sniffing its string for a `\n` missed a cell holding exactly one block
    // (whose trailing break, by the rule at the return below, it never writes) and misfired on a
    // `<br>`, which renders a newline without being a block.
    const isCellWithInnerBlock = isCell && lastOwedBreaks > 0;
    // (…and a `<br>` that is no line break — block-level, floated, absolutely positioned — is a block like any other:
    // innerText gives it the required breaks either side of its newline, `aa\n\n\nbb` as the spec's algorithm and
    // Firefox have it.)
    const isBlock = isElement && !cHidden && (BLOCK_TAGS.has(c._tag) || flexContext || isCellWithInnerBlock ||
                                  (c._tag === 'br' && globalThis.__csimGeneratesBox(c) && !globalThis.__csimIsLineBreak(c)));
    // A block-level child that RENDERS contributes its line breaks even when it holds no text of
    // its own: `abc<div></div>def` is "abc\ndef" in every browser, and an `<hr>` — which can hold
    // nothing at all — is the same shape. A `display: none` sibling returns the same empty string
    // and must contribute nothing, so the question is whether the BOX exists, not the string.
    // …with one carve-out: a shadow HOST. Capybara pins an empty-looking host between two inlines
    // as a SPACE (its own `#shadow_root` fixture, node_spec.rb), and this walk does not descend
    // into a shadow tree, so it has nothing to put between the breaks either way. Chrome does
    // break there; matching it would need the walk to collect the shadow tree first.
    // `generatesTextBox` is asked LAST — it resolves the cascade, and the recursive call above has
    // already paid for that on every child that isn't empty.
    if (!part && !isCell && !(isBlock && !c._shadowRoot && generatesTextBox(c))) continue;
    // A `<p>` asks for TWO breaks — a blank line either side — and keeps asking for them whatever
    // its `display` is (Chrome: `123<p style="display:inline-block">abc` is still "123\n\nabc").
    // …and a cell passes on what its own content asked for, so a `<td>` holding a `<p>` still puts
    // a blank line before the next cell (Chrome: "A\n\n\tB").
    const breaks = isElement && c._tag === 'p' ? 2 : Math.max(1, isCell ? lastOwedBreaks : 1);
    if (isBlock && out) pending = Math.max(pending, breaks);
    // …and white space that is COLLAPSIBLE renders nothing against a break: the space in
    // `abc<hr> <hr>def` sits between two of them and disappears. What is collapsible is the CHILD's
    // question, not this element's — a `<pre>` inside a `white-space: normal` parent keeps its
    // spaces, an NBSP is not collapsible anywhere, and a `<br>`'s newline is a forced break.
    if (part && !(pending && partCollapsible)) {
      if (pending) {
        if (spaceBefore && outEndsSpace) { out = out.slice(0, -1); outEndsSpace = false; }
        // …and a break SEPARATES: with nothing left before it there is nothing to separate, which
        // is the case an atomic inline creates (`<input> <div>abc</div>` is "abc" — the input
        // renders but contributes no text, and the space it kept apart has just been stripped).
        if (renderedBefore) {
          out += pending === 1 ? '\n' : '\n'.repeat(pending);
          emitEndsCollapsibleSpace = true;
          emitAnyRendered = true;
        }
        pending = 0;
        emitAtStart = false;
        emitBreakPending = false;
      }
      // A `<br>` ends a line the same way a required break does, so the collapsible space either
      // side of one renders nothing (`abc <br> def` is "abc\ndef"). It arrives as a part that
      // BEGINS with the newline it renders, rather than as a break this level owes.
      else if (spaceBefore && !partCollapsible && part.startsWith('\n') && outEndsSpace) {
        out = out.slice(0, -1);
      }
      out += part;
      outEndsSpace = part.endsWith(' ');
      emitEndsCollapsibleSpace = partEndsCollapsibleSpace;
      if (part.endsWith('\n')) { emitEndsCollapsibleSpace = true; emitBreakPending = false; }
      if (!partCollapsible) collapsibleOnly = false;
    }
    if (isBlock) pending = Math.max(pending, breaks);
    // (…and a hidden cell adds its children's items and no separator of its own: innerText §2 comes before the tab.)
    if (isCell && !cHidden && hasNextCellSibling(c)) {
      if (pending) {
        if (spaceBefore && outEndsSpace) { out = out.slice(0, -1); outEndsSpace = false; }
        if (renderedBefore) { out += pending === 1 ? '\n' : '\n'.repeat(pending); }
        pending = 0;
        emitAtStart = false;
        emitBreakPending = false;
        emitEndsCollapsibleSpace = true;
      }
      out += '\t';
      emitAnyRendered = true;
      outEndsSpace = false;
      emitEndsCollapsibleSpace = false;
      collapsibleOnly = false;
    }
  }
  // …taken from what the CHILDREN reported, never re-derived from the string: a `<pre>` full of
  // spaces looks collapsible in the output and is not (`x<pre>   </pre>y` keeps them in Chrome).
  lastCollapsibleOnly = collapsibleOnly;
  lastOwedBreaks = pending;
  // A trailing required break is deliberately NOT written: this element's own block-ness is the
  // PARENT's business, and it raises the same requirement there. Writing it here as well gave
  // `abc<table><td>def</table>ghi` a break per nesting level — three — where each boundary asks
  // for one. A literal newline in preserved text is text and stays, which is the distinction the
  // old "count the newlines already at the end" version could not make.
  return out;
}
