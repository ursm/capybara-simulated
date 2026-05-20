// `navigator` global stub + `sendBeacon` (analytics fire-and-forget
// POST) + a Promise-shaped `navigator.clipboard`. The clipboard
// buffer lives module-local and is reachable from the Ruby paste /
// copy paths via `__csimClipboardGet` / `__csimClipboardSet`.

let clipboardText = '';

export const navigator = {
  // Lead with `Mozilla/5.0` so server-side bot detectors (`browser`
  // gem, ahoy_matey's `Browser.new(ua).bot?`) recognise us as a
  // regular client rather than a crawler. Without it Ahoy's exclude
  // path drops every visit/event we POST. Keep in sync with
  // `Browser::USER_AGENT` in `lib/capybara/simulated/browser.rb`,
  // which sets the same string as `HTTP_USER_AGENT` on the Rack env.
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64; Rails Testing) capybara-simulated (V8-resident DOM)',
  appName:    'Netscape',
  appVersion: '5.0',
  platform:   'Linux',
  language:   'en-US',
  languages:  ['en-US', 'en'],
  onLine:     true,
  cookieEnabled: true,
  // Stimulus `navigator.clipboard.writeText(...)` from
  // `copyToClipboard` / `clipboard#copyPre` resolves cleanly. The
  // buffer is in-process and survives across visits in the same
  // Browser — real browsers share a system clipboard; we just need
  // round-trip parity for the copy-then-paste flow tested by
  // `copy_*_to_clipboard`.
  clipboard: {
    writeText(text) {
      clipboardText = String(text == null ? '' : text);
      return Promise.resolve();
    },
    readText() { return Promise.resolve(clipboardText); },
    // Generic write/read with ClipboardItem entries (rare in app
    // code; provide a stub so feature-detection doesn't trip).
    write() { return Promise.resolve(); },
    read()  { return Promise.resolve([]); }
  },
  // `sendBeacon` is what analytics libraries (Ahoy.js, Segment) use
  // to POST a payload at page-unload time without blocking
  // navigation. Real browsers queue the request and fire it
  // asynchronously; we route through `__rackFetch` synchronously
  // which is fine for tests — the assertion that follows the click
  // sees the POST through. Without this method,
  // `typeof navigator.sendBeacon === "undefined"` makes Ahoy.js's
  // `canTrackNow()` return false and the code falls back to
  // `setTimeout(trackEvent, 1000)`, which a fast synchronous test
  // never advances past.
  sendBeacon(url, data) {
    try {
      let body = '';
      const headers = {};
      if (data instanceof globalThis.FormData) {
        const parts = [];
        data.forEach((v, k) => parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v))));
        body = parts.join('&');
        headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
      } else if (data instanceof globalThis.URLSearchParams) {
        body = data.toString();
        headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
      } else if (typeof data === 'string') {
        body = data;
        headers['Content-Type'] = 'text/plain;charset=UTF-8';
      } else if (data instanceof globalThis.Blob) {
        body = (data._parts || []).join('');
        headers['Content-Type'] = data.type || 'application/octet-stream';
      } else if (data == null) {
        body = '';
      } else {
        body = String(data);
        headers['Content-Type'] = 'application/octet-stream';
      }
      const resp = globalThis.__rackFetch('POST', String(url), body, headers, 'follow');
      return !!resp;
    } catch (_) { return false; }
  }
};

// Bridge-internal getters/setters for the paste/copy event paths
// — they live on `globalThis` so the dispatch IIFE can reach them
// without an explicit import.
globalThis.__csimClipboardGet = function () { return clipboardText; };
globalThis.__csimClipboardSet = function (text) { clipboardText = String(text == null ? '' : text); };

globalThis.navigator = navigator;
