// Local capybara-simulated helper (NOT upstream WPT) — see csim-sw-roundtrip.html.
self.addEventListener('message', e => { e.source.postMessage({echo: e.data, from: 'sw'}); });
