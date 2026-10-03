// Entry point for the combined vendor bundle.
//
// esbuild wraps the exports under `globalThis.__csimVendor` via
// `--global-name=__csimVendor` so bridge.js consumes e.g.
//   const V = globalThis.__csimVendor.streams;
//
// To rebuild after a `pnpm install` / dep bump:
//   pnpm run build
//
// The output (`vendor/js/vendor.bundle.js`) is checked in and shipped
// in the gem; consumers never need npm.

// web-streams-polyfill: spec-compliant pure-JS WHATWG Streams (ReadableStream /
// WritableStream / TransformStream + queuing strategies), defined entirely over
// promises + microtask queuing — which our event loop models. The ponyfill entry
// exports the classes WITHOUT installing globals; the bridge wires them onto
// globalThis (and layers TextDecoderStream / TextEncoderStream over
// TransformStream + our existing TextDecoder/TextEncoder).
import * as streams from 'web-streams-polyfill';

// URLPattern (the URL Pattern spec) — the reference polyfill, imported via its
// pure subpath (the package root's index.js side-effect-installs a global; the
// bridge decides where and whether to expose it, like every other vendor piece).
// First consumer: the ServiceWorker Static Routing API's `urlPattern` conditions.
import { URLPattern } from 'urlpattern-polyfill/urlpattern';
export { streams, URLPattern };
