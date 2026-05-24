// Display / visibility cascade.
//
// Scope: just `display` and `visibility`. selfHidden in
// bridge.entry.js is the only consumer of the resolution result,
// so the resolver can throw away every other CSS property at parse
// time.
//
// Pipeline:
//   1. parseCssTree(text)         — tokenise into nested {at-rule|rule}
//   2. flattenCssTree(tree, vp)   — eval @media against viewport
//                                   and substitute & for parent selector
//   3. collectCascadeRules(doc)   — flatten → one entry per (selector,
//                                   display, visibility, !important)
//   4. matchesAnyHideRule(el)     — for each matching rule, pick the
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
import { mediaMatches, currentViewport } from './media-query.js';
import { splitTopLevel }           from './css-utils.js';
import { parseSelector, matchOne, specificity, compareSpec } from './selector-parser.js';

// Tags whose subtree never contributes to visible text or
// `__csimVisible`: head/script/style/template/noscript/title.
export const INVISIBLE_TAGS = new Set(['head','script','style','template','noscript','title']);

const DISPLAY_NONE_RE      = /(^|;|\s)display\s*:\s*none\b/i;
const VISIBILITY_HIDDEN_RE = /(^|;|\s)visibility\s*:\s*hidden\b/i;
// Inline `display` / `visibility` declarations that AREN'T `none` /
// `hidden` — anything else (block, inline, inline-block, …) wins
// over a class-derived `display: none` (per spec, inline style has
// higher specificity than ordinary author rules). jQuery's
// `.show()` over a `.hidden`-classed element ends up writing
// `style="display: block"`; without this branch the element stays
// invisible because matchesAnyHideRule keeps asserting hidden.
const DISPLAY_OTHER_RE     = /(^|;|\s)display\s*:\s*(?!none\b)[^;]+/i;

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
  let cur = el;
  while (cur) {
    if (cur.nodeType === NODE_DOC) return true;
    if (cur.nodeType === NODE_ELEMENT) {
      if (INVISIBLE_TAGS.has(cur._tag)) return false;
      if (selfHidden(cur, ignoreVisibility)) return false;
    }
    cur = cur._parent;
  }
  return false;
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
  const style = el._attrs.style;
  if (style) {
    if (DISPLAY_NONE_RE.test(style)) return true;
    if (!ignoreVisibility && VISIBILITY_HIDDEN_RE.test(style)) return true;
    // Inline display:<other> overrides any class-derived display:none.
    if (DISPLAY_OTHER_RE.test(style)) return false;
  }
  return matchesAnyHideRule(el, ignoreVisibility);
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
  ruleSerial: 0
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
}

export function resetCascadeState() {
  state.hideRules = [];
  state.layoutRules = [];
  state.hideIdx = state.layoutIdx = null;
}

globalThis.__csimRebuildCascade = function () { rebuildCascade(); };


function stripCssComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }

// Parse CSS text into a tree. Returns an array of nodes:
//   { type: 'rule', selector, decls: [{prop, value, important}], children: [...] }
//   { type: 'at-rule', name, prelude, children: [...] | null, decls: [...] }
//
// CSS Nesting (Level 4) is supported: a rule can contain both
// declarations and child rules. The flattener composes child rule
// selectors against the parent's.
function parseCssTree(text) {
  const s = stripCssComments(text);
  const out = parseCssBody(s, 0, false);
  return out.nodes;
}

function parseCssBody(s, start, inBlock) {
  const nodes = [];
  let i = start;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (inBlock && s[i] === '}') { i++; return { nodes, next: i }; }
    if (s[i] === '@') {
      const at = parseAtRule(s, i);
      nodes.push(at.node);
      i = at.next;
      continue;
    }
    // Look ahead to decide if this is a declaration or a qualified
    // rule. Track top-level `{`/`;`/`}` (i.e. depth == 0 for [], ()).
    const probe = scanToBreaker(s, i);
    if (probe.kind === 'lbrace') {
      const selector = s.slice(i, probe.at).trim();
      const body = parseDeclsAndNested(s, probe.at + 1);
      nodes.push({ type: 'rule', selector, decls: body.decls, children: body.children });
      i = body.next;
      continue;
    }
    // Stray declaration at top level (or no terminator) — skip past.
    i = probe.at + (probe.kind === 'semi' ? 1 : 0);
    if (i <= start) i = s.length;
  }
  return { nodes, next: i };
}

function scanToBreaker(s, i) {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    // CSS escape outside strings: `\<char>` consumes one extra char.
    // Avo's Tailwind utilities encode every attribute-selector punct
    // (`\[disabled\=\'true\'\]`) this way — without the skip, a bare
    // `\'` flips us into quote mode and we miss the next `}`.
    if (c === '\\' && i + 1 < s.length) { i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && (c === '{' || c === ';' || c === '}')) {
      return { kind: c === '{' ? 'lbrace' : c === ';' ? 'semi' : 'rbrace', at: i };
    }
    i++;
  }
  return { kind: 'eof', at: i };
}

function parseAtRule(s, i) {
  i++; // skip @
  const start = i;
  while (i < s.length && /[a-zA-Z-]/.test(s[i])) i++;
  const name = s.slice(start, i).toLowerCase();
  const preStart = i;
  while (i < s.length && /\s/.test(s[i])) i++;
  // prelude until ; or {
  const pStart = i;
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && (c === ';' || c === '{')) break;
    i++;
  }
  const prelude = s.slice(pStart, i).trim();
  if (i >= s.length || s[i] === ';') {
    return { node: { type: 'at-rule', name, prelude, children: null }, next: i + 1 };
  }
  // s[i] === '{'
  i++;
  // For @keyframes / @font-face / @page / etc. we just want to skip
  // the body without descending. Everything else can carry nested
  // rules + declarations.
  if (name === 'keyframes' || name === 'font-face' || name === 'page' ||
      name === 'counter-style' || name === 'property' || name === 'font-feature-values') {
    const skipped = skipBalancedBlock(s, i);
    return { node: { type: 'at-rule', name, prelude, children: null }, next: skipped };
  }
  const body = parseDeclsAndNested(s, i);
  return {
    node: { type: 'at-rule', name, prelude, children: body.children, decls: body.decls },
    next: body.next
  };
}

function skipBalancedBlock(s, i) {
  let depth = 1;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return i;
}

function parseDeclsAndNested(s, i) {
  const decls = [];
  const children = [];
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === '}') return { decls, children, next: i + 1 };
    if (s[i] === '@') {
      const at = parseAtRule(s, i);
      children.push(at.node);
      i = at.next;
      continue;
    }
    const probe = scanToBreaker(s, i);
    if (probe.kind === 'lbrace') {
      // nested rule
      const selector = s.slice(i, probe.at).trim();
      const body = parseDeclsAndNested(s, probe.at + 1);
      children.push({ type: 'rule', selector, decls: body.decls, children: body.children });
      i = body.next;
      continue;
    }
    if (probe.kind === 'semi' || probe.kind === 'rbrace') {
      const declText = s.slice(i, probe.at).trim();
      if (declText) {
        const colonIdx = declText.indexOf(':');
        if (colonIdx > 0) {
          const prop = declText.slice(0, colonIdx).trim().toLowerCase();
          let value = declText.slice(colonIdx + 1).trim();
          let important = false;
          if (/!important\s*$/i.test(value)) {
            important = true;
            value = value.replace(/!important\s*$/i, '').trim();
          }
          // Retain only the properties the cascade resolvers care
          // about — display / visibility (hide rules),
          // top / left / width / height (layout for click-offset),
          // text-transform (visible-text uppercase/lowercase).
          if (prop === 'display' || prop === 'visibility' || prop === 'text-transform') {
            decls.push({ prop, value: value.toLowerCase(), important });
          } else if (prop === 'top' || prop === 'left' || prop === 'width' || prop === 'height') {
            decls.push({ prop, value: value.trim(), important });
          }
        }
      }
      if (probe.kind === 'rbrace') return { decls, children, next: probe.at + 1 };
      i = probe.at + 1;
      continue;
    }
    // EOF / no terminator
    break;
  }
  return { decls, children, next: i };
}


// Flatten the parsed CSS tree to a list of {selectorText, decls,
// sourceIdx, important}. Resolves @media (drops non-matching),
// @supports (always-true, descend), CSS nesting via `&` substitution.
// `@container (max-width: 47em)` evaluator. Strips an optional
// container-name prefix (`@container my-card (min-width: …)`), then
// reuses `mediaMatches` against the viewport. Bare `@container <name>`
// blocks without a feature query always match.
function containerMatches(prelude, vp) {
  const featureQuery = (prelude || '').replace(/^[^\s(]*\s*/, '');
  if (!featureQuery.trim().startsWith('(')) return true;
  return mediaMatches(featureQuery, vp);
}

function flattenCssTree(tree, vp) {
  const out = [];
  const stack = []; // parent selector groups for nesting context
  function walk(nodes) {
    for (const node of nodes) {
      if (node.type === 'at-rule') {
        if (node.name === 'media') {
          if (mediaMatches(node.prelude, vp)) {
            if (node.decls && node.decls.length && stack.length) {
              // Decls inside @media inside a rule attach to the
              // enclosing rule's selector.
              out.push({ selectorText: stack[stack.length - 1], decls: node.decls });
            }
            walk(node.children || []);
          }
          continue;
        }
        if (node.name === 'supports') {
          // Always-on fallback: descend.
          if (node.decls && node.decls.length && stack.length) {
            out.push({ selectorText: stack[stack.length - 1], decls: node.decls });
          }
          walk(node.children || []);
          continue;
        }
        if (node.name === 'container') {
          // `@container (max-width: 47em)` etc. — evaluate against the
          // current viewport, treating any container's size as
          // viewport-sized (we don't run layout, so we can't measure a
          // specific container). Discourse's directory-table mobile-
          // table fallback used to apply unconditionally and hide
          // `.btn.bulk-select` even on the 1024 px default viewport.
          // Bare `@container <name>` blocks without a feature query
          // descend unconditionally.
          if (!containerMatches(node.prelude, vp)) continue;
          if (node.decls && node.decls.length && stack.length) {
            out.push({ selectorText: stack[stack.length - 1], decls: node.decls });
          }
          walk(node.children || []);
          continue;
        }
        // @keyframes / @font-face / @import / etc. — skip.
        continue;
      }
      // node.type === 'rule'
      const parentSel = stack.length ? stack[stack.length - 1] : null;
      const resolved = composeNestedSelector(node.selector, parentSel);
      if (node.decls && node.decls.length) {
        out.push({ selectorText: resolved, decls: node.decls });
      }
      if (node.children && node.children.length) {
        stack.push(resolved);
        walk(node.children);
        stack.pop();
      }
    }
  }
  walk(tree);
  return out;
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

// Walk every `<style>` and `<link rel=stylesheet>` once and pull
// out the two slices of cascade state we care about — hide rules
// (display / visibility, for `visible?`) and layout rules
// (`top/left/width/height` + `text-transform`, for click-offset
// resolution and visible-text upper-casing). One Rack fetch per
// external stylesheet, one `parseCssTree` per blob.
function collectCascadeRules(doc) {
  const empty = { hide: [], layout: [] };
  if (!doc || !doc.documentElement) return empty;
  state.ruleSerial = 0;
  const vp = currentViewport();
  const hide   = [];
  const layout = [];
  const consume = (cssText) => {
    let tree;
    try { tree = parseCssTree(cssText); } catch (_) { return; }
    for (const r of flattenCssTree(tree, vp)) {
      if (!r.selectorText || !r.decls.length) continue;
      let display = null, displayImp = false;
      let visibility = null, visibilityImp = false;
      const captured = {};
      for (const d of r.decls) {
        if      (d.prop === 'display')    { display = d.value; displayImp = d.important; }
        else if (d.prop === 'visibility') { visibility = d.value; visibilityImp = d.important; }
        if (LAYOUT_PROPS.includes(d.prop)) captured[d.prop] = { value: d.value, important: d.important };
      }
      const hasHide   = display != null || visibility != null;
      const hasLayout = Object.keys(captured).length > 0;
      if (!hasHide && !hasLayout) continue;
      for (const sel of splitTopLevel(r.selectorText, ',')) {
        const trimmed = sel.trim();
        if (!trimmed) continue;
        let group;
        try { group = parseSelector(trimmed); } catch (_) { continue; }
        if (!group || !group.length) continue;
        const spec   = specificity(group[0]);
        const source = state.ruleSerial++;
        if (hasHide)   hide  .push({ group, spec, source, display, displayImp, visibility, visibilityImp });
        if (hasLayout) layout.push({ group, spec, source, captured });
      }
    }
  };
  for (const s of doc.documentElement.querySelectorAll('style')) {
    const txt = scriptText(s);
    if (txt) consume(txt);
  }
  for (const l of doc.documentElement.querySelectorAll('link')) {
    const rel = (l._attrs.rel || '').toLowerCase();
    if (!rel.split(/\s+/).includes('stylesheet')) continue;
    const href = l._attrs.href;
    if (!href) continue;
    try {
      const resp = globalThis.__rackFetch('GET', href, '', null, 'follow');
      if (resp && resp.status < 400 && resp.body) consume(resp.body);
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
    const seq = r.group[0];
    const term = seq[seq.length - 1];
    let bucket;
    if (term.classes && term.classes.length) {
      const key = term.classes[0];
      bucket = idx.byClass.get(key);
      if (!bucket) idx.byClass.set(key, bucket = []);
    } else if (term.id) {
      bucket = idx.byId.get(term.id);
      if (!bucket) idx.byId.set(term.id, bucket = []);
    } else if (term.tag) {
      bucket = idx.byTag.get(term.tag);
      if (!bucket) idx.byTag.set(term.tag, bucket = []);
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
// `top/left/width/height` resolve to numeric coordinates for the
// click-offset path; `text-transform` feeds the visible-text
// upper/lower-case path (Tailwind `.uppercase` etc. — without it
// Avo's column headers come back mixed-case instead of `ID`/`NAME`).
const LAYOUT_PROPS = ['top', 'left', 'width', 'height', 'text-transform'];
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
  let best = inline ? { spec: [1,0,0,0], source: Infinity, ...inline } : null;
  if (state.layoutRules.length) {
    if (!state.layoutIdx) state.layoutIdx = buildRuleIndex(state.layoutRules);
    forEachCandidateRule(state.layoutIdx, el, (r) => {
      const cap = r.captured[prop];
      if (!cap) return;
      let m;
      try { m = matchOne(el, r.group); } catch (_) { return; }
      if (!m) return;
      if (!best ||
          (cap.important && !best.important) ||
          (cap.important === best.important &&
           (specCompare(r.spec, best.spec) > 0 ||
            (specCompare(r.spec, best.spec) === 0 && r.source >= best.source)))) {
        best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source };
      }
    });
  }
  return best ? parsePx(best.value) : null;
}
function specCompare(a, b) {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
// Sum each ancestor's top/left to translate an element's CSS-declared
// box into an absolute "viewport" position. We don't run a layout
// engine; this is just "if a test declares position via px values,
// honour those values" — enough for the click-offset specs.

export function matchesAnyHideRule(el, ignoreVisibility = false) {
  if (state.hideRules.length === 0) return false;
  if (!state.hideIdx) state.hideIdx = buildRuleIndex(state.hideRules);
  let bestD = null, bestV = null;
  forEachCandidateRule(state.hideIdx, el, (r) => {
    let m;
    try { m = matchOne(el, r.group); } catch (_) { return; }
    if (!m) return;
    if (r.display != null && winsCascade(bestD, r, true)) {
      bestD = { value: r.display, important: r.displayImp, spec: r.spec, source: r.source };
    }
    if (!ignoreVisibility && r.visibility != null && winsCascade(bestV, r, false)) {
      bestV = { value: r.visibility, important: r.visibilityImp, spec: r.spec, source: r.source };
    }
  });
  if (bestD && bestD.value === 'none') return true;
  if (bestV && bestV.value === 'hidden') return true;
  return false;
}

function winsCascade(current, candidate, isDisplay) {
  const candImp = isDisplay ? candidate.displayImp : candidate.visibilityImp;
  if (!current) return true;
  if (candImp && !current.important) return true;
  if (!candImp && current.important) return false;
  const cmp = compareSpec(candidate.spec, current.spec);
  if (cmp !== 0) return cmp > 0;
  return candidate.source >= current.source;
}
// Per innerText: collapse inline-whitespace runs (tab/newline/VT)
// to a single space in each text node.
const INLINE_WS_RE = /[\t\n\v\f\r]+/g;
// Block-shaped tags get a `\n` boundary before/after their content.
const BLOCK_TAGS = new Set([
  'address','article','aside','blockquote','dd','div','dl','dt',
  'figcaption','figure','footer','form','h1','h2','h3','h4','h5',
  'h6','header','hr','li','main','nav','ol','p','pre','section',
  'table','tbody','td','tfoot','th','thead','tr','ul'
]);
// Adjacent `<th>` / `<td>` cells get a U+0009 between them per the
// innerText spec §14.4 step 4 ("required line break count" carries a
// tab on table-cell boundaries). The expected text in Avo's
// `table thead` assertion is `"A\n\t\nB"`, which only comes out
// after appending this tab AFTER each cell that has a next cell
// sibling.
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
    let m;
    try { m = matchOne(el, r.group); } catch (_) { return; }
    if (!m) return;
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
// Utility-class shortcut: Tailwind / similar frameworks ship one
// class per text-transform value. When an element carries the
// class AND has no inline `style="text-transform: …"` override,
// skip the full cascade walk — the matching rule's value is
// determined by the class name. Falls back to the cascade for
// anything more elaborate (inline style with `!important`, a
// higher-specificity stylesheet rule).
const TAILWIND_TEXT_TRANSFORM = Object.assign(Object.create(null), {
  uppercase:    'uppercase',
  lowercase:    'lowercase',
  capitalize:   'capitalize',
  'normal-case': 'none',
});
function tailwindTextTransform (el) {
  for (const tok of classes(el)) {
    const t = TAILWIND_TEXT_TRANSFORM[tok];
    if (t) return t;
  }
  return null;
}
function parseInlineTextTransform (el) {
  const s = el._attrs && el._attrs.style;
  if (!s) return null;
  const m = /(?:^|;)\s*text-transform\s*:\s*([^;!]+?)\s*(?:!important)?\s*(?:;|$)/i.exec(String(s));
  return m ? m[1].toLowerCase() : null;
}
function cascadedTextTransform (el) {
  const inline = parseInlineTextTransform(el);
  // Fast path: no inline override + a Tailwind utility-class token
  // present. Skip the cascade walk entirely.
  if (!inline) {
    const tw = tailwindTextTransform(el);
    if (tw) return tw;
  }
  let best = inline ? { value: inline, spec: [1,0,0,0], important: /!important/i.test(el._attrs.style || ''), source: Infinity } : null;
  if (state.layoutRules.length) {
    if (!state.layoutIdx) state.layoutIdx = buildRuleIndex(state.layoutRules);
    forEachCandidateRule(state.layoutIdx, el, (r) => {
      const cap = r.captured['text-transform'];
      if (!cap) return;
      let m;
      try { m = matchOne(el, r.group); } catch (_) { return; }
      if (!m) return;
      if (!best ||
          (cap.important && !best.important) ||
          (cap.important === best.important &&
           (specCompare(r.spec, best.spec) > 0 ||
            (specCompare(r.spec, best.spec) === 0 && r.source >= best.source)))) {
        best = { value: cap.value, important: cap.important, spec: r.spec, source: r.source };
      }
    });
  }
  return best ? best.value : null;
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
// `<pre>` (UA stylesheet: white-space:pre) and any descendant of it
// preserves newlines in visible_text. Without this, our text
// collapse turns the contents of `<pre>` and `<pre><code>` into
// space-joined runs and Capybara assertions like
// `have_css('pre code', text: "a\\nb")` never match.
function preservesWhitespace(node) {
  for (let cur = node; cur; cur = cur._parent) {
    if (cur.nodeType !== NODE_ELEMENT) continue;
    if (cur._tag === 'pre' || cur._tag === 'textarea') return true;
    const ws = cascadedWhiteSpace(cur);
    if (ws === 'pre' || ws === 'pre-wrap' || ws === 'pre-line' || ws === 'break-spaces') return true;
  }
  return false;
}
function cascadedWhiteSpace(node) {
  // Inline style first, then any matching stylesheet rule's `white-space`.
  const inline = (node._attrs && node._attrs.style) || '';
  const m = /(?:^|;)\s*white-space\s*:\s*([^;]+)/i.exec(inline);
  if (m) return m[1].trim().toLowerCase();
  return '';
}
export function collectVisibleText(node, transform) {
  if (node.nodeType === NODE_TEXT) {
    const data = String(node.data || '');
    // `<pre>` (and any other element with white-space:pre*) preserves
    // newlines verbatim. Without this, our text collapse turns
    // multi-line code blocks into space-joined runs and Capybara's
    // `have_css('pre code', text: "a\\nb\\nc")` never matches.
    const raw = preservesWhitespace(node._parent)
      ? data
      : data.replace(INLINE_WS_RE, ' ');
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
    if (node._tag === 'details' && node._attrs.open == null) {
      // Closed details: only emit text inside <summary>.
      let s = '';
      for (const c of node._children) {
        if (c.nodeType === NODE_ELEMENT && c._tag === 'summary') s += collectVisibleText(c, effTransform);
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
    const part = collectVisibleText(c, transform);
    if (!part) continue;
    const isBlock = c.nodeType === NODE_ELEMENT && (BLOCK_TAGS.has(c._tag) || flexContext);
    if (isBlock && out && !out.endsWith('\n')) out += '\n';
    out += part;
    if (isBlock && !part.endsWith('\n')) out += '\n';
    if (c.nodeType === NODE_ELEMENT && TABLE_CELL_TAGS.has(c._tag) && hasNextCellSibling(c)) {
      out += '\t';
    }
  }
  return out;
}
