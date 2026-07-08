// Local capybara-simulated helper (NOT upstream WPT) — see csim-sw-roundtrip.html.
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (!url.searchParams.has('intercept')) return;   // fall through to the network
  if (url.searchParams.has('err')) {
    // Handle Fetch: a Response.error() respondWith makes the client fetch reject.
    e.respondWith(Response.error());
  } else if (url.searchParams.has('stream')) {
    // A ReadableStream-constructed body (workbox streamed-shell pattern).
    e.respondWith(new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('streamed')); c.close(); }
    }), {status: 200}));
  } else if (e.request.method === 'POST') {
    // Async respondWith: exercises the promise path + the request-body round-trip (UTF-8
    // included). The wire-private X-Csim-Body-B64 header must not be visible here.
    const leak = e.request.headers.has('x-csim-body-b64') ? ' LEAK' : '';
    e.respondWith(e.request.text().then(body => new Response('HELLO POST ' + body + leak, {status: 200, headers: {'X-SW': 'yes'}})));
  } else {
    e.respondWith(new Response('HELLO ' + e.request.method, {status: 200, headers: {'X-SW': 'yes'}}));
  }
});
