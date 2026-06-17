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

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'spec', 'wpt');
const REPO = 'web-platform-tests/wpt';

// Pin. Bump deliberately; regenerate the expected-failures allowlist after
// (`WPT_REGEN=1 bundle exec rspec spec/wpt_spec.rb`).
const PINNED = '34637df05a42cefd99ecc38e6602f7f64e4c1648';
const REF = process.env.WPT_REF || PINNED;

// Directories to vendor whole and scan for tests. Top-level trees plus a couple
// of narrow html/ SUBTREES (the full html/ tree is thousands of mostly
// layout-dependent files; we want only the layout-free event-loop oracle:
// timers + microtask-queuing). `resources` is fetched selectively (just the
// harness) below — the rest of resources/ is large and unneeded.
const TREES = [
  'dom', 'domparsing', 'url', 'encoding', 'shadow-dom',
  'html/webappapis/timers',            // setTimeout/setInterval/clearTimeout/clamp/ordering
  'html/webappapis/microtask-queuing'  // queueMicrotask + microtask-checkpoint ordering
];

// Support-only trees: vendored whole so absolute-path includes (`/common/…`)
// resolve at serve time, but the runner does NOT scan them for test files.
const SUPPORT_TREES = ['common'];
// Individual support files (outside the vendored trees) that tests include via
// `<script src>`. Kept across re-vendoring so local includes resolve.
// `html/resources/common.js` provides newHTMLDocument / newRenderedHTMLDocument
// / HTML5_ELEMENTS / HTML5_SHADOW_DISALLOWED_ELEMENTS used pervasively by the
// shadow-dom/untriaged suite and gethtml/attachShadow tests.
const SUPPORT_FILES = ['html/resources/common.js'];

const CONCURRENCY = 24;

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
  const url = `https://raw.githubusercontent.com/${REPO}/${sha}/${path}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'capybara-simulated-vendor' } });
  if (!res.ok) throw new Error(`raw ${path}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
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

async function main() {
  const sha = await resolveSha(REF);
  console.error(`Vendoring web-platform-tests @ ${sha}`);

  // Clean the vendored trees (but keep our committed resources/testharnessreport.js).
  for (const tree of [...TREES, ...SUPPORT_TREES]) {
    await rm(join(OUT, tree), { recursive: true, force: true });
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
