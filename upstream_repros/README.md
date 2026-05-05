# Quickjs::VM segfault repro

Two scripts demonstrating a core dump in long-running `Quickjs::VM` sessions.

`pure_quickjs_repro.rb` — minimal, depends only on the `quickjs` gem (and a copy
of jQuery 1.12 lying around in the Capybara gem path). Eval'd jQuery + a small
synthesized DOM bridge, repeated N iterations on the same VM. No
`capybara-simulated` involvement.

`capybara_simulated_repro.rb` — runs the actual Capybara shared spec against
`capybara-simulated`'s v2 driver, which is how the bug surfaced in practice.

## TL;DR — two bugs hiding behind one core dump

After rebuilding `quickjs.rb` with `CFLAGS='-g -O0' rake compile`, the
core dump goes away. So there are actually **two issues**:

1. **Memory leak** (`-O0` and `-O2` both show it). `eval_code(jquery_src)`
   into the same VM repeatedly grows RSS by ~250 KB/iter. By iter ~600
   the VM exhausts its allocation budget and from then on every
   `eval_code` rejects with JS-level `InternalError: out of memory`.
   The leak is the primary bug.

2. **`-O2`-only segfault in the OOM-handling path.** With release
   optimisation, somewhere on the `JS_ThrowOutOfMemory` → finaliser
   path the process dies (no Ruby backtrace, no JS exception, just
   core dump). With `-O0 -g` the same workload survives indefinitely
   and only logs `InternalError: out of memory`. Smells like an
   uninitialised read or use-after-free that the optimiser reorders
   into a real segfault.

Numbers from running `pure_quickjs_repro.rb 2000` on each build:

| build  | iter at OOM | iter at crash | final RSS |
|--------|-------------|---------------|-----------|
| `-O2`  | ~600        | ~800-1000     | core dump |
| `-O0`  | ~600        | survives 2000 | ~205 MB   |

So **the leak alone is enough to take a long-running test suite
out**, even after the segfault is fixed — the VM just stops doing
work.

## Versions reproduced on

- ruby 4.0.3
- quickjs 0.15.0
- jQuery 1.12.4 (bundled with capybara 3.40.0 at
  `lib/capybara/spec/public/jquery.js`)
- linux x86_64

## How to run

```sh
cd <repo root>
bundle exec ruby upstream_repros/pure_quickjs_repro.rb 2000
bundle exec ruby upstream_repros/capybara_simulated_repro.rb 2000
```

`pure_quickjs_repro.rb` is the gem-only repro — depends on `quickjs` and
`capybara` (only for the bundled `jquery.js`). `capybara_simulated_repro.rb`
is the higher-level one that surfaced the bug originally.

## Hypotheses for upstream

For the leak (issue 1):

1. `eval_code` on a large source string holds a reference to the
   compiled bytecode that doesn't get freed when the eval returns.
   Repeated evals of the *same* source should ideally either be cached
   (so they cost ~nothing) or fully released.
2. `define_function`'s closure binding may not get GC'd correctly
   when re-evaluations create new closures that shadow earlier ones.
3. The `js_std_await` path holds onto promise wrappers; an explicit
   sync-only mode (see also the `JS_EVAL_FLAG_ASYNC` request) would
   sidestep this.

For the `-O2`-only crash (issue 2):

4. Look at `JS_ThrowOutOfMemory` callers and any path that returns
   `JS_EXCEPTION` without checking for `JS_NULL`/`JS_UNINITIALIZED`.
   `addr2line` on the core-dump RIP would pinpoint it once the
   release build is rebuilt with `-g` retained.

The repro is small enough to bisect against quickjs.rb commits / a
debug build of QuickJS itself if helpful.
