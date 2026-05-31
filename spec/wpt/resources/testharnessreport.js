// capybara-simulated WPT reporter (hand-written — NOT from upstream).
//
// WPT test files load this right after testharness.js via
// `<script src="/resources/testharnessreport.js">`. The real browser reporter
// renders results into the page and posts them to the test runner; we instead
// capture them into a global the Ruby runner (spec/wpt_spec.rb) reads back
// with evaluate_script.
//
// `setup({ output: false })` disables testharness's DOM result rendering: we
// read results programmatically, so there's no need to mutate #log — and it
// keeps the harness off the output-rendering DOM path entirely.
//
// The driver does not auto-fire window 'load', so the runner dispatches it and
// drains the virtual clock; testharness's load handler then sets `all_loaded`
// and runs the completion callback registered here.
setup({ output: false });

add_completion_callback(function (tests, harness_status) {
  globalThis.__wptResults = {
    harness: { status: harness_status.status, message: harness_status.message || null },
    tests: tests.map(function (t) {
      return { name: t.name, status: t.status, message: t.message || null };
    })
  };
});
