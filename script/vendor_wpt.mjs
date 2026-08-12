// Dev-time vendoring: pull a pinned subset of web-platform-tests into
// spec/wpt/ so the behavioural-conformance gate (spec/wpt_spec.rb) runs
// offline, with no Node toolchain — the same "fetch at dev time, commit the
// artifact" model as gen_idl_surface.mjs and the JS bundles.
//
//   node script/vendor_wpt.mjs            # vendor at the pinned commit
//   WPT_REF=<sha|branch> node script/vendor_wpt.mjs   # override the pin
//
// What it vendors, all at one pinned commit:
//   - resources/testharness.js          (upstream harness, unmodified)
//   - <test trees>/**                   (every blob: tests + their support
//                                        files, so local includes resolve)
//   - common/**                         (support-only: `/common/*.js` helpers
//                                        like sab.js / subset-tests.js that
//                                        `.any.js` tests pull in by absolute
//                                        path; served but NOT scanned for tests
//                                        — the runner's own TREES list controls
//                                        which trees become test files)
//
// It deliberately does NOT vendor resources/testharnessreport.js — ours lives
// at spec/wpt/resources/testharnessreport.js (committed, hand-written: it
// disables DOM output and captures results into a global the Ruby runner
// reads). The pinned SHA is written to spec/wpt/WPT_VERSION.
//
// `.any.js` / `.window.js` / `.worker.js` tests need a server-generated HTML
// wrapper that we don't have; they're vendored as support but the runner only
// visits real `.html` test files.

import { mkdir, writeFile, rm, readdir, rmdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'spec', 'wpt');
const REPO = 'web-platform-tests/wpt';

// Pin. Bump deliberately; regenerate the expected-failures allowlist after
// (`WPT_REGEN=1 bundle exec rspec spec/wpt_spec.rb`).
const PINNED = 'bbe4ce211741e3b36f58ccdcffd6a7c1926fde1b';   // web-platform-tests/wpt @ 2026-06-27
const REF = process.env.WPT_REF || PINNED;

// Directories to vendor whole and scan for tests. Top-level trees plus a few
// narrow html/ SUBTREES (the full html/ tree is thousands of mostly
// layout-dependent files; we cherry-pick the layout-light slices: the
// event-loop oracle — timers + microtask-queuing — and the forms semantics
// surface that real app suites hammer). `resources` is fetched selectively
// (just the harness) below — the rest of resources/ is large and unneeded.
const TREES = [
  'dom', 'domparsing', 'url', 'encoding', 'shadow-dom',
  'FileAPI',                           // Blob / File / FileReader / createObjectURL — data API, no layout
  'html/dom',                          // IDL attribute REFLECTION (content attr <-> IDL prop) — the IDL
                                       // coverage gate only checks member EXISTENCE; this checks behaviour
  'html/webappapis/timers',            // setTimeout/setInterval/clearTimeout/clamp/ordering
  'html/webappapis/microtask-queuing', // queueMicrotask + microtask-checkpoint ordering
  'html/webappapis/scripting/events',  // the HTML "event handler" algorithm — IDL/inline on-handler
                                       // reflection, compile-on-first-use + lexical scopes, listener
                                       // registration order, OnErrorEventHandler; validates the
                                       // registered-listener on-handler model (events.js setHandlerSlot)
  'html/semantics/forms',              // form submission / constraint validation / FormData / input /
                                       // select / textarea / labels — the form-driven surface every app
                                       // suite exercises (layout-dependent widget-rendering subtests are
                                       // earned out-of-scope in wpt_out_of_scope.yml)
  'custom-elements',                   // customElements.define / upgrade / reactions (connected /
                                       // disconnected / adopted / attributeChanged) / form-associated CE +
                                       // ElementInternals — the custom-element lifecycle Turbo
                                       // (`<turbo-frame>` / `<turbo-stream>`) and every Web Component app
                                       // (Lit / Shoelace) ride on; the driver already models CE (sync
                                       // upgrade, attributeChangedCallback, reactions), so this validates
                                       // and hardens the contract FrameRedirector depends on. DOM/JS
                                       // surface, no layout.
  'xhr',                               // XMLHttpRequest — responseType / FormData upload / progress events /
                                       // timeout / abort / responseURL / headers — the request surface
                                       // Turbo / Rails-UJS / jQuery hammer; data API, no layout
  'fetch/api',                         // fetch() Request/Response/Headers/Body — the same request stack as
                                       // xhr (rack_fetch / CORS / body serialization / URL / redirects), so
                                       // the foundations hardened for xhr should pay off here for free
  'fetch/data-urls',                   // data: URL parsing (reuses the whatwg-url backend)
  'fetch/h1-parsing',                  // HTTP/1 response-line / header parsing edge cases
  'html/webappapis/atob',              // base64 btoa/atob (binary-string round-trip)
  'html/webappapis/structured-clone',  // structuredClone — deep-clone of platform objects, no layout
  'webmessaging',                      // postMessage / MessageChannel / MessagePort / BroadcastChannel /
                                       // MessageEvent + cross-context structured-clone & transfer — the
                                       // channel every SPA (Mastodon, React/Vue) and iframe integration
                                       // hammers. Same-origin surface is in scope (we model MessageChannel
                                       // + Worker + structured-clone); cross-origin / multi-global subtests
                                       // that need the multi-origin subsystem earn out per rule 1.
  'input-events',                      // beforeinput / input InputEvent contract (inputType / data /
                                       // getTargetRanges) — the editing surface every rich-text editor
                                       // (Trix / ActionText / ProseMirror) depends on. The value-editing /
                                       // spinner-step / paste / execCommand input-event slices are all in
                                       // scope (DOM + Selection, no layout); only coordinate spinner / drag
                                       // hit-testing (needs a layout engine) earns out per rule 1
  'css/cssom',                         // CSSOM object model — CSSStyleDeclaration / CSSRule / insertRule /
                                       // cssRules / style serialization, backed by our css-tree cascade
                                       // engine; the pure-API slice of CSS (css/cssom-view is the
                                       // layout-dependent one and is deliberately NOT vendored)
  'html/canvas/element',               // 2D canvas context — the in-process software rasterizer (paths /
                                       // gradients / text via libvips / shadow / compositing / Path2D / AA)
                                       // measured against the harness tests. Pixel-exact-Chrome-AA / filter
                                       // / reftest cases earn out; the API + close-enough-pixel slice is in
                                       // scope. (offscreen/ mirrors this via OffscreenCanvas — added later.)
  'service-workers/service-worker',    // registration / lifecycle / messaging / fetch interception against
                                       // the real SW runtime; ships the FULL upstream test-helpers.sub.js
                                       // (service_worker_test & friends) plus committed local csim-* fixtures
  'service-workers/cache-storage',     // Cache Storage API (caches/Cache) — the origin-partitioned,
                                       // Ruby-backed store (cache-storage.js), visible from window + SW
                                       // isolates; the pure-API slice. cache-abort (unbounded streaming
                                       // fetch) is skip-listed; cache-storage-buckets earns out (Storage
                                       // Buckets subsystem)
  'websockets',                        // WebSocket client (RFC6455) — the same runtime Action Cable /
                                       // Turbo Streams ride on, validated against the spec's own send /
                                       // receive / close / close-code / protocol / binary tests. The runner
                                       // stands up an in-process RFC6455 server (wss:// routing + native
                                       // echo / pywebsocket-`_wsh.py` handlers); both the legacy `.htm`
                                       // slice and the modern `.any.js` (via JS_TREES) are in scope.
                                       // WebSocketStream (stream/) is .tentative → out.
  'webstorage',                        // localStorage / sessionStorage — the Ruby-backed, origin-shared
                                       // Web Storage areas + the cross-window `storage` event (fired at the
                                       // OTHER same-origin documents on a change). Both the storage-event
                                       // `.html` tests and the `.window.js` API tests (via JS_TREES) are in
                                       // scope. Storage partitioning earns out per rule 1.
  'WebCryptoAPI',                      // SubtleCrypto — digest / sign / verify / encrypt / decrypt / importKey /
                                       // exportKey / deriveBits / deriveKey / generateKey / wrapKey / unwrapKey,
                                       // backed by Ruby's OpenSSL (the same host-fn model as `__csim_subtleDigest`).
                                       // The crypto every auth stack (jose / OIDC / oidc-client-ts), Web Push
                                       // (Mastodon: ECDH + HKDF + AES-GCM), and Signal/E2E library rides on. All
                                       // `.https.any.js` — run via the synthesized window wrapper (JS_TREES). Data
                                       // API, no layout. `.tentative` algorithms (Argon2 / cSHAKE / SHA-3 / Ed448
                                       // curve448 / AES-OCB / ML-KEM) auto-route out; getPublicKey / encap_decap /
                                       // supports are .tentative too.
];

// Support-only trees: vendored whole so absolute-path includes (`/common/…`)
// resolve at serve time, but the runner does NOT scan them for test files.
// `html/canvas/resources` holds canvas-tests.js — the `_addTest` / `_assertPixel`
// harness every generated canvas test pulls in by absolute path. `images` holds
// the shared PNG/SVG fixtures (`/images/green.png`, …) that canvas drawImage /
// createPattern / <img>-decode tests fetch by absolute path.
// `cookies/resources` backs the SameSite service-worker tests (same-site-cookies.https
// pulls cookie-helper.sub.js + the set/drop/postToParent .py endpoints by absolute path);
// the tree is self-contained (helpers.py + the endpoint handlers).
const SUPPORT_TREES = ['common', 'html/canvas/resources', 'images', 'fonts', 'cookies/resources'];
// Individual support files (outside the vendored trees) that tests include via
// `<script src>`. Kept across re-vendoring so local includes resolve.
// `html/resources/common.js` provides newHTMLDocument / newRenderedHTMLDocument
// / HTML5_ELEMENTS / HTML5_SHADOW_DISALLOWED_ELEMENTS used pervasively by the
// shadow-dom/untriaged suite and gethtml/attachShadow tests.
// `pointerevents/pointerevent_support.js` provides getEvent() and pointer
// helpers that html/semantics/forms/the-label-element click-forwarding tests
// pull in via an absolute `<script src>`; it is self-contained (no further
// includes) and not scanned as a test (pointerevents is not in TREES).
// The two `…/resources/common.js` executor helpers define the cross-context
// orchestration primitives (importScript / newPopup / newIframe) that the
// FileAPI/BlobURL/cross-partition* tests pull in by absolute path on top of
// the vendored common/dispatcher framework; neither tree is in TREES.
const SUPPORT_FILES = [
  'html/resources/common.js',
  'pointerevents/pointerevent_support.js',
  'html/cross-origin-embedder-policy/credentialless/resources/common.js',
  'html/anonymous-iframe/resources/common.js',
  // input-events editing tests pull EditorTestUtils (send copy/cut/paste shortcut
  // keys, set selection from markup) by absolute path from the editing/ tree,
  // which we don't vendor wholesale; it's self-contained on top of testdriver.
  'editing/include/editor-test-utils.js',
  // css/cssom's font-family-serialization test pulls the <generic-family> /
  // <family-name> keyword lists from the css-fonts tree, which we don't vendor;
  // the file is a plain array of keyword strings (no further includes).
  'css/css-fonts/support/font-family-keywords.js'
  // NOTE: service-workers/service-worker (vendored above) ships the FULL upstream
  // test-helpers.sub.js — `service_worker_test` and friends run against the real SW runtime.
  // The hand-written minimal helper that used to live at that path (with_iframe only, while SW
  // tests were meant to abort) is gone; webmessaging/broadcastchannel and the SW subtests in
  // FileAPI / fetch/api all include the upstream helper now. The tree also hosts committed
  // local `csim-*` fixtures (SW round-trip regression guards) — `cleanTree` preserves those.
];

const CONCURRENCY = 24;

// Percent-encode each path SEGMENT (preserving the `/` separators) so filenames
// containing URL-reserved characters — e.g. css/cssom support images like
// `ruler-h-50%.png` — survive the GitHub API / raw-CDN request instead of 400ing.
function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function gh(path, accept = 'application/vnd.github+json') {
  const headers = { Accept: accept, 'User-Agent': 'capybara-simulated-vendor' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${path}: ${res.status} ${res.statusText}`);
  return res;
}

async function resolveSha(ref) {
  // A 40-char hex string is already a commit SHA.
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  const res = await gh(`commits/${ref}`, 'application/vnd.github.sha');
  return (await res.text()).trim();
}

async function listBlobs(sha, tree) {
  const res = await gh(`git/trees/${sha}:${tree}?recursive=1`);
  const json = await res.json();
  if (json.truncated) {
    throw new Error(`tree ${tree} truncated — vendor it in smaller pieces`);
  }
  return json.tree.filter((e) => e.type === 'blob').map((e) => `${tree}/${e.path}`);
}

async function fetchRaw(sha, path) {
  const encoded = encodePath(path);
  const url = `https://raw.githubusercontent.com/${REPO}/${sha}/${encoded}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'capybara-simulated-vendor' } });
  if (res.ok) return Buffer.from(await res.arrayBuffer());
  // raw.githubusercontent occasionally 400s a single valid path at a given commit
  // (CDN quirk — the blob exists and lists in the tree). Fall back to the contents API
  // with the `raw` media type, which returns the file's RAW bytes (and lifts the JSON
  // endpoint's size cap). gh() throws on a non-200, so a genuinely missing path still
  // fails loudly rather than being masked.
  const blob = await gh(`contents/${encoded}?ref=${sha}`, 'application/vnd.github.raw');
  return Buffer.from(await blob.arrayBuffer());
}

async function pool(items, n, worker) {
  let i = 0;
  let done = 0;
  const total = items.length;
  async function run() {
    while (i < total) {
      const idx = i++;
      await worker(items[idx]);
      done++;
      if (done % 50 === 0 || done === total) process.stderr.write(`\r  ${done}/${total}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, total) }, run));
  process.stderr.write('\n');
}

async function vendorPath(sha, path) {
  const buf = await fetchRaw(sha, path);
  const dest = join(OUT, path);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
}

// Remove a vendored tree, PRESERVING locally-authored `csim-*` files — hand-written regression
// guards committed inside otherwise-vendored trees (e.g. the service-worker round-trip
// fixtures) — the same way resources/testharnessreport.js is preserved above. Directories left
// non-empty by a surviving fixture are kept.
async function cleanTree(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // tree doesn't exist yet
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) await cleanTree(p);
    else if (!ent.name.startsWith('csim-')) await rm(p, { force: true });
  }
  try {
    await rmdir(dir);
  } catch {
    // non-empty (a csim-* fixture survived) — keep it
  }
}

async function main() {
  const sha = await resolveSha(REF);
  console.error(`Vendoring web-platform-tests @ ${sha}`);

  // Clean the vendored trees (but keep our committed resources/testharnessreport.js).
  for (const tree of [...TREES, ...SUPPORT_TREES]) {
    await cleanTree(join(OUT, tree));
  }
  await rm(join(OUT, 'resources', 'testharness.js'), { force: true });

  const paths = [];
  for (const tree of [...TREES, ...SUPPORT_TREES]) {
    const blobs = await listBlobs(sha, tree);
    console.error(`  ${tree}: ${blobs.length} blobs`);
    paths.push(...blobs);
  }
  paths.push('resources/testharness.js');
  paths.push(...SUPPORT_FILES);

  console.error(`Downloading ${paths.length} files (concurrency ${CONCURRENCY})…`);
  await pool(paths, CONCURRENCY, (p) => vendorPath(sha, p));

  await writeFile(
    join(OUT, 'WPT_VERSION'),
    `${sha}\nweb-platform-tests/wpt\ntrees: ${TREES.join(', ')}` +
      `\nsupport: ${SUPPORT_TREES.join(', ')}, resources/testharness.js, ${SUPPORT_FILES.join(', ')}\n`
  );
  console.error(`Done. Pinned SHA written to spec/wpt/WPT_VERSION.`);
  console.error(`Next: WPT_REGEN=1 bundle exec rspec spec/wpt_spec.rb  # refresh the allowlist`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
