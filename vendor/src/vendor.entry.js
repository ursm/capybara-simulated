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

export { cssSelect, cssWhat, xpathway, cssTree };
