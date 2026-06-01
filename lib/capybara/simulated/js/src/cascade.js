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
import { splitTopLevel }           from './css-utils.js';
import { matchesSelector }         from './selectors.js';

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
function safeMatches(el, selectorText) {
  try { return matchesSelector(el, selectorText); }
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
  if (el._attrs.hidden != null) return true;
  // `<dialog>` HTML spec UA stylesheet: `dialog:not([open]) { display: none }`.
  // Avo's confirm-dialog template (the "Close modal / Are you sure? /
  // Yes, I'm sure / No, cancel" block) is rendered into every page
  // and stays in the DOM without `open` until `data-turbo-confirm`
  // triggers `showModal()`. Without honouring the UA hide here,
  // Capybara's `click_on "Close modal"` matches both the dropdown
  // action item and the dialog's close button → ambiguous-match.
  if (el._tag === 'dialog' && el._attrs.open == null) return true;
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
  return matchesAnyHideRule(el, ignoreVisibility, inline);
}

// Parse the element's inline `style=` display / visibility declarations
// into the `{ display, displayImp, visibility, visibilityImp, spec,
// source }` shape the cascade resolver compares against stylesheet rules.
// Returns null when neither is declared inline (the common case — keeps
// the hot path cheap).
function inlineHideDecl(el) {
  const style = el._attrs && el._attrs.style;
  if (!style) return null;
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
  if (display == null && visibility == null) return null;
  // Inline declarations outrank EVERY author selector at equal
  // importance regardless of selector specificity (an inline
  // `display:block` beats `#a #b{display:none}`). That ordering is
  // modelled by the explicit `inline` flag the cascade comparators
  // check before specificity — not by an inflated spec tuple, which
  // would collapse to a single-id specificity through the 3-component
  // `compareSpec` and lose to multi-id selectors. `spec` stays a real
  // 3-component value so any compareSpec call on it is well-defined.
  return { display, displayImp, visibility, visibilityImp,
           inline: true, spec: [0, 0, 0], source: Number.MAX_SAFE_INTEGER };
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
export function rebuildCascade(doc) {
  doc = doc || globalThis.document;
  if (!doc || !doc.documentElement) return;
  const { hide, layout } = collectCascadeRules(doc);
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

const LOWERCASE_VALUE_PROPS = new Set(['display', 'visibility', 'text-transform', 'white-space']);
const CAPTURED_PROPS = new Set(['top', 'left', 'width', 'height', 'color', 'background-color']);

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
    const prop = node.property.toLowerCase();
    const custom = prop.startsWith('--');
    if (!LOWERCASE_VALUE_PROPS.has(prop) && !CAPTURED_PROPS.has(prop) && !custom) return;
    // `parseValue:false` keeps the raw value text, which can still hold a
    // `/* … */` comment; strip it so exact compares (`display === 'none'`)
    // match — the old parser ran stripCssComments over the whole sheet first.
    let value = CT.generate(node.value).replace(CSS_COMMENT_RE, '').trim();
    if (LOWERCASE_VALUE_PROPS.has(prop)) value = value.toLowerCase();
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

function cssTreeFlatten(cssText, vp) {
  const out = [];
  const PARSE_OPTS = { parseValue: false, parseRulePrelude: false, positions: true };
  const emitRule = (ruleNode, src, parentSel) => {
    const sel   = composeNestedSelector(preludeSource(ruleNode, src), parentSel);
    const decls = ruleDecls(ruleNode.block);
    if (decls.length) out.push({ selectorText: sel, decls });
    visit(ruleNode.block && ruleNode.block.children, src, sel);
  };
  // `src` is the source string the current AST was parsed from — needed so
  // `preludeSource` can slice verbatim. The Raw-reparse below changes it to the
  // nested rule's own mini-source.
  const visit = (children, src, parentSel) => {
    if (!children) return;
    children.forEach(node => {
      if (node.type === 'Rule') {
        emitRule(node, src, parentSel);
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
          if (r && r.type === 'Rule') emitRule(r, mini, parentSel);
        }
      } else if (node.type === 'Atrule') {
        const name    = (node.name || '').toLowerCase();
        const prelude = node.prelude ? CT.generate(node.prelude).trim() : '';
        if      (name === 'media')     { if (!mediaMatches(prelude, vp)) return; }
        else if (name === 'supports')  { if (!supportsMatches(prelude)) return; }
        else if (name === 'container') { if (!containerMatches(prelude, vp)) return; }
        else                           { return; }  // keyframes/font-face/import/@layer/… skipped — matches the prior parser (proper @layer cascade precedence is a deliberate follow-up, not smuggled into this swap)
        // Declarations directly inside the at-rule attach to the enclosing
        // rule's selector (e.g. `@media` nested inside a rule block).
        if (parentSel) {
          const decls = ruleDecls(node.block);
          if (decls.length) out.push({ selectorText: parentSel, decls });
        }
        visit(node.block && node.block.children, src, parentSel);
      }
    });
  };
  let ast;
  try { ast = CT.parse(cssText, PARSE_OPTS); }
  catch (_) { return out; }
  visit(ast.children, cssText, null);
  return out;
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
  return text.length + ':' + (h >>> 0).toString(16) + ':' + vp.width + 'x' + vp.height;
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
  try { flat = cssTreeFlatten(cssText, vp); } catch (_) { return { hide, layout, count: 0 }; }
  for (const r of flat) {
    if (!r.selectorText || !r.decls.length) continue;
    let display = null, displayImp = false;
    let visibility = null, visibilityImp = false;
    const captured = {};
    for (const d of r.decls) {
      if      (d.prop === 'display')    { display = d.value; displayImp = d.important; }
      else if (d.prop === 'visibility') { visibility = d.value; visibilityImp = d.important; }
      if (LAYOUT_PROPS.includes(d.prop) || d.prop.startsWith('--')) {
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
      if (hasHide)   hide  .push({ selectorText: trimmed, term, spec, source, display, displayImp, visibility, visibilityImp });
      if (hasLayout) layout.push({ selectorText: trimmed, term, spec, source, captured });
    }
  }
  return { hide, layout, count: serial };
}

function parseSheetCached(cssText, vp) {
  const key = __sheetCacheKey(cssText, vp);
  let hit = __sheetCache.get(key);
  if (hit) return hit;
  hit = parseSheet(cssText, vp);
  while (__sheetCache.size >= SHEET_CACHE_LIMIT) {
    __sheetCache.delete(__sheetCache.keys().next().value);
  }
  __sheetCache.set(key, hit);
  return hit;
}

function collectCascadeRules(doc) {
  const empty = { hide: [], layout: [] };
  if (!doc || !doc.documentElement) return empty;
  state.ruleSerial = 0;
  const vp = currentViewport();
  const hide   = [];
  const layout = [];
  // Shift each cached rule's source by the running document-wide
  // serial so cross-stylesheet ties break correctly (later sheets win
  // at equal specificity). Spread keeps rule-shape changes local to
  // `parseSheet` — any new prop is picked up automatically here.
  const append = (sheet) => {
    const base = state.ruleSerial;
    for (const r of sheet.hide)   hide  .push({ ...r, source: r.source + base });
    for (const r of sheet.layout) layout.push({ ...r, source: r.source + base });
    state.ruleSerial += sheet.count;
  };
  for (const s of doc.documentElement.querySelectorAll('style')) {
    const media = s._attrs.media;
    if (media && !mediaMatches(media, vp)) continue;
    const txt = scriptText(s);
    if (txt) append(parseSheetCached(txt, vp));
  }
  for (const l of doc.documentElement.querySelectorAll('link')) {
    const rel = (l._attrs.rel || '').toLowerCase();
    if (!rel.split(/\s+/).includes('stylesheet')) continue;
    const href = l._attrs.href;
    if (!href) continue;
    const media = l._attrs.media;
    if (media && !mediaMatches(media, vp)) continue;
    try {
      const resp = globalThis.__rackFetch('GET', href, '', null, 'follow');
      if (resp && resp.status < 400 && resp.body) append(parseSheetCached(resp.body, vp));
    } catch (_) {}
  }
  return { hide, layout };
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
// Union of `CAPTURED_PROPS` (numeric: top/left/width/height, plus
// color / background-color for `style("color")` reads) and the
// lowercase-keyword props (`text-transform` / `white-space`) — the
// rule-capture filter in `collectCascadeRules` uses this single
// `includes()` test to keep the captured set tight.
const LAYOUT_PROPS = [...CAPTURED_PROPS, 'text-transform', 'white-space'];
// Inline `style="top: 100px; left: 100px"` parsing for one element.
export function parseInlineLayout (el) {
  const out = {};
  const s = el._attrs && el._attrs.style;
  if (!s) return out;
  for (const part of String(s).split(';')) {
    const m = /^\s*(top|left|width|height)\s*:\s*([^;]+?)\s*$/.exec(part);
    if (m) out[m[1]] = { value: m[2], important: /\s+!important\s*$/.test(m[2]) };
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
      if (!safeMatches(el, r.selectorText)) return;
      if (winsProp(best, r.spec, r.source, cap.important)) {
        best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source };
      }
    });
  }
  return best ? parsePx(best.value) : null;
}
// Property cascade comparator (the `winsProp` analogue of
// `winsCascade`): does a candidate stylesheet rule beat the current
// best? Importance first, then inline-ness (a non-`!important` inline
// value beats every author selector at equal importance), then
// specificity, then source order. `candidate` is always a stylesheet
// rule, so `candInline` is always false — the check exists so the
// seeded inline `best` holds against same-importance selectors.
function winsProp(current, candSpec, candSource, candImp) {
  if (!current) return true;
  if (candImp && !current.important) return true;
  if (!candImp && current.important) return false;
  if (current.inline) return false; // candidate is a selector; inline best holds
  if (compareSpec(candSpec, current.spec) !== 0) return compareSpec(candSpec, current.spec) > 0;
  return candSource >= current.source;
}
// Sum each ancestor's top/left to translate an element's CSS-declared
// box into an absolute "viewport" position. We don't run a layout
// engine; this is just "if a test declares position via px values,
// honour those values" — enough for the click-offset specs.

export function matchesAnyHideRule(el, ignoreVisibility = false, inline = null) {
  if (state.hideRules.length === 0 && !inline) return false;
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
      if (!safeMatches(el, r.selectorText)) return;
      if (r.display != null && winsCascade(bestD, r, true)) {
        bestD = { value: r.display, important: r.displayImp, spec: r.spec, source: r.source };
      }
      if (!ignoreVisibility && r.visibility != null && winsCascade(bestV, r, false)) {
        bestV = { value: r.visibility, important: r.visibilityImp, spec: r.spec, source: r.source };
      }
    });
  }
  if (bestD && bestD.value === 'none') return true;
  if (bestV && (bestV.value === 'hidden' || bestV.value === 'collapse')) return true;
  return false;
}

// The element's OWN cascaded `visibility` value ('visible' / 'hidden' /
// 'collapse'), or null if neither inline `style=` nor any matching rule sets
// it. Same precedence ladder as matchesAnyHideRule (winsCascade), restricted to
// `visibility`. Skips rule-matching when no rule sets visibility (common page).
function ownVisibility(el) {
  const inline = inlineHideDecl(el);
  let best = (inline && inline.visibility != null)
    ? { value: inline.visibility, important: inline.visibilityImp, spec: inline.spec, source: inline.source, inline: true }
    : null;
  if (state.hasVisibilityRule && state.hideRules.length) {
    if (!state.hideIdx) state.hideIdx = buildRuleIndex(state.hideRules);
    forEachCandidateRule(state.hideIdx, el, (r) => {
      if (r.visibility == null) return;
      if (!safeMatches(el, r.selectorText)) return;
      if (winsCascade(best, r, false)) {
        best = { value: r.visibility, important: r.visibilityImp, spec: r.spec, source: r.source };
      }
    });
  }
  return best ? best.value : null;
}

// Effective `visibility` for `el`, honouring BOTH inheritance and descendant
// override. `visibility` inherits, but a descendant's `visibility: visible`
// re-shows it under a `visibility: hidden` ancestor — so unlike `display`,
// visibility CANNOT be decided by "any hidden ancestor". Walk ancestor-or-self;
// the nearest element that sets `visibility` explicitly wins (default visible).
// The visible-filter therefore resolves visibility per-target, separately from
// the unconditional display-side ancestor walk.
export function visibilityHidden(el) {
  let cur = el;
  while (cur && cur.nodeType === NODE_ELEMENT) {
    const v = ownVisibility(cur);
    if (v != null) return v === 'hidden' || v === 'collapse';
    cur = cur._parent;
  }
  return false;
}

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
  const cmp = compareSpec(candidate.spec, current.spec);
  if (cmp !== 0) return cmp > 0;
  return candidate.source >= current.source;
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
    if (!safeMatches(el, r.selectorText)) return;
    if (winsCascade(best, r, true)) {
      best = { value: r.display, important: r.displayImp, spec: r.spec, source: r.source };
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
export function cascadedProperty (el, prop) {
  const style = el._attrs && el._attrs.style;
  const inline = style ? parseInlinePropertyValue(style, prop) : null;
  // Inline seed carries `inline: true`; like winsCascade, the property
  // comparator (`winsProp`) checks inline-ness before specificity so a
  // non-`!important` inline value beats every author selector at equal
  // importance. `spec` stays a real 3-component value.
  let best = inline ? { value: inline.value, important: inline.important, spec: [0,0,0], source: Infinity, inline: true } : null;
  const rules = state.layoutRules;
  if (rules.length && rulesIndexHas(prop)) {
    if (!state.layoutIdx) state.layoutIdx = buildRuleIndex(rules);
    forEachCandidateRule(state.layoutIdx, el, (r) => {
      const cap = r.captured[prop];
      if (!cap) return;
      if (!safeMatches(el, r.selectorText)) return;
      if (winsProp(best, r.spec, r.source, cap.important)) {
        best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source };
      }
    });
  }
  return best ? best.value : null;
}
function parseInlinePropertyValue (style, prop) {
  const re = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;!]+?)\\s*(?:!important)?\\s*(?:;|$)', 'i');
  const m = re.exec(String(style));
  if (!m) return null;
  // Keyword-valued props normalise to lowercase (`cascadedTextTransform`
  // and `cascadedWhiteSpace` compare against lowercase tokens).
  // Non-keyword props — `color: #AABBCC`, custom properties carrying
  // `url(/Foo.png)` etc. — must keep their case.
  const lower = prop === 'display' || prop === 'visibility' || prop === 'text-transform' || prop === 'white-space';
  return { value: lower ? m[1].toLowerCase() : m[1], important: /!important/i.test(style) };
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
