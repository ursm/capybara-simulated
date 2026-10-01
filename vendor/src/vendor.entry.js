// Entry point for the combined vendor bundle.
//
// esbuild wraps the exports under `globalThis.__csimVendor` via
// `--global-name=__csimVendor` so bridge.js consumes e.g.
//   const CT = globalThis.__csimVendor.cssTree;
//
// To rebuild after a `pnpm install` / dep bump:
//   pnpm run build
//
// The output (`vendor/js/vendor.bundle.js`) is checked in and shipped
// in the gem; consumers never need npm.
//
// Two of these deps are LOCALLY PATCHED (pnpm patches, registered in
// pnpm-workspace.yaml, sources under `patches/`). Read the patch file to see an
// edit in full; the newer ones also mark themselves `// csim patch:` in the
// dependency's own source:
//   css-what    — selector-escape parsing (`\<EOF>` → U+FFFD, non-ASCII names)
//   css-tree    — attribute-selector recovery at EOF (`[foo` parses as `[foo]`)

import * as cssWhat   from 'css-what';
// css-tree: CSS parser (stylesheets + selectors + specificity). Backs the JS
// cascade the layout oracle reads (selector.rs does the matching); css-tree provides clean specificity (distinguishes `#x` from `[id=x]`, which
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

// whatwg-mimetype: the WHATWG MIME-type parser + serializer (npm, MIT — the jsdom
// reference impl). Backs XHR send()'s "fix the charset to UTF-8" step, which needs a
// real parser (quoted strings, backslash escapes, duplicate-parameter dedup) and the
// canonical serializer (lowercases type/subtype + parameter names). Pure regex
// parse/serialize — no WebIDL / ArrayBuffer descriptors — so it's safe in the V8
// snapshot build.
import { MIMEType } from 'whatwg-mimetype';
const mimeType = { MIMEType };

// web-streams-polyfill: spec-compliant pure-JS WHATWG Streams (ReadableStream /
// WritableStream / TransformStream + queuing strategies), defined entirely over
// promises + microtask queuing — which our event loop models. The ponyfill entry
// exports the classes WITHOUT installing globals; the bridge wires them onto
// globalThis (and layers TextDecoderStream / TextEncoderStream over
// TransformStream + our existing TextDecoder/TextEncoder).
import * as streams from 'web-streams-polyfill';

// culori: CSS Color 4 parser + converters (npm, MIT). Backs `<input type=color>`
// value sanitization and the canvas's colours. Imported via the TREE-SHAKEABLE
// `culori/fn` entry (the barrel registers every colour mode + formatter); here we
// register the modes CSS Color 4 defines — rgb (which also carries the named-colour
// and hex parsers), hsl, hwb, lab / lch, oklab / oklch, and the `color()` spaces —
// and none of culori's others. `toHex` is the HTML color-input serialization:
// parse, convert to sRGB, channel-clamp to an opaque #rrggbb (NOT OKLCH gamut-
// mapping — HTML clamps; verified against the WPT color tests).
import { useMode, modeRgb, modeHsl, modeHwb, modeLab, modeLch, modeOklab, modeOklch, modeLrgb, modeP3, modeA98, modeProphoto,
         modeRec2020, modeXyz50, modeXyz65, parse as culoriParse, formatHex as culoriFormatHex } from 'culori/fn';

// URLPattern (the URL Pattern spec) — the reference polyfill, imported via its
// pure subpath (the package root's index.js side-effect-installs a global; the
// bridge decides where and whether to expose it, like every other vendor piece).
// First consumer: the ServiceWorker Static Routing API's `urlPattern` conditions.
import { URLPattern } from 'urlpattern-polyfill/urlpattern';
const culoriRgb = useMode(modeRgb);   // registers 'rgb' (+ named + hex parsers); returns the rgb converter
useMode(modeHsl);                     // registers 'hsl' / 'hsla'
useMode(modeHwb);                     // registers 'hwb' (browsers flatten it to rgb in computed style)
useMode(modeLab);                     // registers 'lab' (lab())
useMode(modeLch);                     // registers 'lch' (lch())
useMode(modeOklab);                   // registers 'oklab' (oklab())
useMode(modeOklch);                   // registers 'oklch' (oklch())
useMode(modeLrgb);                    // registers 'lrgb' (color(srgb-linear …))
useMode(modeP3);                      // registers 'p3' (color(display-p3 …))
useMode(modeA98);                     // registers 'a98' (color(a98-rgb …))
useMode(modeProphoto);                // registers 'prophoto' (color(prophoto-rgb …))
useMode(modeRec2020);                 // registers 'rec2020' (color(rec2020 …))
useMode(modeXyz50);                   // registers 'xyz50' (color(xyz-d50 …))
useMode(modeXyz65);                   // registers 'xyz65' (color(xyz-d65 …), color(xyz …))
function cssColorToHex(str) {
  if (typeof str !== 'string') return null;
  let parsed;
  try { parsed = culoriParse(str.trim()); } catch (_) { return null; }
  if (!parsed) return null;
  try { return culoriFormatHex(culoriRgb(parsed)) || null; } catch (_) { return null; }
}
// An sRGB-family colour — a named colour / hex / rgb() / hsl() / hwb() — as the
// channels a computed value is written from: `{ r, g, b }` bytes and `a` the alpha
// as it is (the bridge's `normalizeColor` writes it). Returns null for an
// unparseable value OR a value browsers PRESERVE verbatim in computed style rather
// than flattening to legacy rgb():
//   - the CSS `color()` function — `color(srgb …)`, `color(display-p3 …)`,
//     `color(srgb-linear …)`, … — Chrome/Firefox keep these as-is. culori
//     parses `color(srgb …)` to mode 'rgb', so the syntax must be excluded
//     up front, before the mode check, or it would wrongly flatten.
//   - non-sRGB colour spaces (lab / oklch / …), which the mode check below turns
//     away.
// The caller passes those through unchanged.
function cssColorSrgb(str) {
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
  return { r: byte(c.r), g: byte(c.g), b: byte(c.b), a: c.alpha == null ? 1 : Math.max(0, Math.min(1, c.alpha)) };
}
// …and ANY colour, in whatever space it is written, as the sRGB bytes a canvas puts on a pixel: each channel clamped
// into the gamut, as `toHex` does. Null for an unparseable value.
function cssColorRaster(str) {
  if (typeof str !== 'string') return null;
  let c;
  try { c = culoriRgb(culoriParse(str.trim())); } catch (_) { return null; }
  if (!c) return null;
  const byte = x => Math.max(0, Math.min(255, Math.round((x || 0) * 255)));
  return { r: byte(c.r), g: byte(c.g), b: byte(c.b), a: c.alpha == null ? 1 : Math.max(0, Math.min(1, c.alpha)) };
}
const color = { toHex: cssColorToHex, srgb: cssColorSrgb, raster: cssColorRaster };

export { cssWhat, cssTree, mimeType, streams, color, URLPattern };
