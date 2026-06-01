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
// xpathway: standalone XPath 1.0 engine, replaces the vendored wgxpath blob.
// Currently a local `file:../xpathway` dep (pending an npm publish); only needed
// when rebuilding this bundle — the gem ships the pre-built output.
import * as xpathway  from 'xpathway';

export { cssSelect, cssWhat, xpathway };
