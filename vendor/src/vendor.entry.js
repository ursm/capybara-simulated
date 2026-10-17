// Entry point for the combined vendor bundle.
//
// esbuild wraps the exports under `globalThis.__csimVendor` via
// `--global-name=__csimVendor` inside a function its banner and footer make (an assignment, not a top-level `var`: a
// property the bridge can keep out of a page's enumeration of the window) so bridge.js consumes e.g.
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
export { streams };
