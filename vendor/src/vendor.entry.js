// Entry point for the combined vendor bundle.
//
// esbuild wraps the exports under `globalThis.__csimVendor` via
// `--global-name=__csimVendor` so bridge.js consumes e.g.
//   const { compile, selectAll, selectOne } = __csimVendor.cssSelect;
//
// To rebuild after a `pnpm install` / dep bump:
//   pnpm run build
//
// The output (`vendor/js/vendor.bundle.js`) is checked in and shipped
// in the gem; consumers never need npm.

import * as cssSelect from 'css-select';
import * as cssWhat   from 'css-what';
// xpathway: standalone XPath 1.0 engine (npm, MIT), replaces the vendored
// wgxpath blob. Only needed when rebuilding this bundle — the gem ships the
// pre-built output.
import * as xpathway  from 'xpathway';
// css-tree: CSS parser (stylesheets + selectors + specificity). Backs the real
// in-V8 cascade engine (visibility resolution) — css-select still does matching;
// css-tree provides clean specificity (distinguishes `#x` from `[id=x]`, which
// css-what blurs) and `<style>`/`@layer`/`@media`/nesting parse.
//
// Import the parser / generator / walker SUBPATHS, not the `css-tree` barrel:
// the barrel builds the full syntax including the value-validation **lexer**
// (mdn-data property grammar, ~60% of css-tree's minified weight) which we never
// use — we only parse/walk/generate. `import * from 'css-tree'` can't tree-shake
// the lexer out (the default `parse` is bound to the full syntax). The subpath
// defaults are `createParser(parserConfig)` / `createGenerator` / `createWalker`
// — the exact same parse/generate/walk the barrel exposes, minus the lexer.
import cssTreeParse    from 'css-tree/parser';
import cssTreeGenerate from 'css-tree/generator';
import cssTreeWalk     from 'css-tree/walker';
const cssTree = { parse: cssTreeParse, generate: cssTreeGenerate, walk: cssTreeWalk };

// whatwg-url's URL state machine: the jsdom reference WHATWG URL parser (npm,
// MIT). Backs `__csim_parseUrl` (the old Ruby `URI` delegation was RFC 3986,
// ASCII-strict, NOT WHATWG) — so URL parsing is spec-correct AND in-VM (no
// V8↔Ruby boundary per parse). We import the bare state machine, NOT the
// `whatwg-url` barrel: the barrel's `URL` WebIDL wrapper pulls in
// webidl-conversions/utils.js, which capture `ArrayBuffer.prototype.resizable` /
// `SharedArrayBuffer` descriptors at load time — features unavailable during
// V8 snapshot build, so they throw there. The state machine needs none of
// that (just tr46, aliased to an ASCII-only shim, and TextEncoder — stubbed in
// snapshot_stubs.js). url-parse.js assembles the component shape from it exactly
// as whatwg-url's URL-impl does.
import * as urlEngine from 'whatwg-url/lib/url-state-machine.js';

// whatwg-mimetype: the WHATWG MIME-type parser + serializer (npm, MIT — the jsdom
// reference impl). Backs XHR send()'s "fix the charset to UTF-8" step, which needs a
// real parser (quoted strings, backslash escapes, duplicate-parameter dedup) and the
// canonical serializer (lowercases type/subtype + parameter names). Pure regex
// parse/serialize — no WebIDL / ArrayBuffer descriptors — so it's safe in the V8
// snapshot build (unlike whatwg-url's URL wrapper).
import { MIMEType } from 'whatwg-mimetype';
const mimeType = { MIMEType };

// web-streams-polyfill: spec-compliant pure-JS WHATWG Streams (ReadableStream /
// WritableStream / TransformStream + queuing strategies), defined entirely over
// promises + microtask queuing — which our event loop models. The ponyfill entry
// exports the classes WITHOUT installing globals; the bridge wires them onto
// globalThis (and layers TextDecoderStream / TextEncoderStream over
// TransformStream + our existing TextDecoder/TextEncoder).
import * as streams from 'web-streams-polyfill';

// parse5: spec-compliant HTML parser (npm, MIT). We drive its `Parser` directly
// (not the `parse5-parser-stream` Writable wrapper — that's just Node-stream
// plumbing): `new Parser({treeAdapter, scriptingEnabled})` plus
// `parser.tokenizer.write/pause/resume/insertHtmlAtCurrentPos` and a
// `parser.scriptHandler` give incremental parsing with script-blocking and
// document.write — the streaming behavior our hand-rolled parser lacks. A custom
// tree adapter (js/src/parse5-adapter.js) maps parse5's node ops onto our live
// DOM nodes. Pure JS, no runtime deps; safe in the V8 snapshot build.
//
// Import ONLY the `Parser` class, NOT the `parse5` barrel: re-exporting the
// whole namespace (accessed dynamically as `__csimVendor.parse5.x`) would defeat
// tree-shaking and also pull in parse5's serializer. The named `Parser` import
// lets esbuild drop the serializer. (The default tree adapter is NOT dropped —
// `Parser`'s constructor default-initialises `options.treeAdapter` to it — but
// it's small; our custom adapter is what actually drives the parse.)
import { Parser as Parse5Parser } from 'parse5';
const parse5 = { Parser: Parse5Parser };

// culori: CSS Color 4 parser + converters (npm, MIT). Backs `<input type=color>`
// value sanitization. Imported via the TREE-SHAKEABLE `culori/fn` entry (the
// barrel registers every colour mode + formatter); here we register only the
// modes the HTML colour syntaxes need — rgb (which also carries the named-colour
// and hex parsers), hsl, hwb, and p3 (`color(display-p3 …)`) — so esbuild drops
// the lab/lch/oklab/… machinery. `toHex` is the HTML color-input serialization:
// parse, convert to sRGB, channel-clamp to an opaque #rrggbb (NOT OKLCH gamut-
// mapping — HTML clamps; verified against the WPT color tests).
import { useMode, modeRgb, modeHsl, modeHwb, modeP3, parse as culoriParse, formatHex as culoriFormatHex } from 'culori/fn';
const culoriRgb = useMode(modeRgb);   // registers 'rgb' (+ named + hex parsers); returns the rgb converter
useMode(modeHsl);                     // registers 'hsl' / 'hsla'
useMode(modeHwb);                     // registers 'hwb' (browsers flatten it to rgb in computed style)
useMode(modeP3);                      // registers 'p3' (color(display-p3 …))
function cssColorToHex(str) {
  if (typeof str !== 'string') return null;
  let parsed;
  try { parsed = culoriParse(str.trim()); } catch (_) { return null; }
  if (!parsed) return null;
  try { return culoriFormatHex(culoriRgb(parsed)) || null; } catch (_) { return null; }
}
// The getComputedStyle-canonical serialization of an sRGB-family colour: a named
// colour / hex / rgb() / hsl() / hwb() → "rgb(r, g, b)" (opaque) or
// "rgba(r, g, b, a)". Returns null for an unparseable value OR a value browsers
// PRESERVE verbatim in computed style rather than flattening to legacy rgb():
//   - the CSS `color()` function — `color(srgb …)`, `color(display-p3 …)`,
//     `color(srgb-linear …)`, … — Chrome/Firefox keep these as-is. culori
//     parses `color(srgb …)` to mode 'rgb', so the syntax must be excluded
//     up front, before the mode check, or it would wrongly flatten.
//   - non-sRGB colour spaces (lab / oklch / …), which culori doesn't register
//     here and so fail to parse.
// The caller passes those through unchanged.
function cssColorComputed(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (/^color\(/i.test(s)) return null;
  let p;
  try { p = culoriParse(s); } catch (_) { return null; }
  if (!p || (p.mode !== 'rgb' && p.mode !== 'hsl' && p.mode !== 'hwb')) return null;
  let c;
  try { c = culoriRgb(p); } catch (_) { return null; }
  if (!c) return null;
  const byte = x => Math.max(0, Math.min(255, Math.round((x || 0) * 255)));
  const r = byte(c.r), g = byte(c.g), b = byte(c.b);
  const a = c.alpha == null ? 1 : c.alpha;
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
}
const color = { toHex: cssColorToHex, computed: cssColorComputed };

export { cssSelect, cssWhat, xpathway, cssTree, urlEngine, mimeType, streams, parse5, color };
