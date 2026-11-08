// The request a fetch() or an XMLHttpRequest's send() hands to Fetch, as the engine describes it (fetch_request.rs
// `fetchRequest`): the leg that answers it, the host's description of it, the service worker fetch event's, and the
// response a preload had where one answers it — and the response a `data:` or `blob:` URL's scheme fetch makes, which
// both answer in place. What is the caller's — its body, its promise or its events — stays the caller's.

import { blobResponse } from './blob.js';
import { ROUTE_BLOB } from './constants.js';
import { obtainHost } from './obtain-host.js';
import { controllerHandle } from './sw-client.js';
import { dom } from './engine.js';

// The request of `source` — a Request's state, an XHR's — with its author's header list `headers` and, an XHR's,
// `challenge` the credentials its open() brought: `{route, request, worker, preloaded, controller}`, the controller the
// handle of the service worker the realm had as it was asked, which a ROUTE_SERVICE_WORKER request goes to.
export function describeRequest(source, headers, challenge = null) {
  const controller = controllerHandle();
  const d = dom.fetchRequest(source, headers, challenge, controller, obtainHost());
  return { route: d[0], request: d[1], worker: d[2], preloaded: d[3], controller };
}

// The response `request`'s scheme fetch makes on route ROUTE_DATA or ROUTE_BLOB — a raw record (a response's facts and
// `body_bytes`), or null for a network error: a data: URL's of the data: URL processor (data_url.rs, a HEAD's with no
// body), a blob: URL's of `snapshot` — the bytes its URL named as the caller took it (a Request at construction, an XHR
// at open()) — for `range`, its `Range` header's value or null (blob.js `blobResponse`).
export function schemeResponse(route, request, snapshot, range) {
  if (route === ROUTE_BLOB) return blobResponse(request.url, snapshot, request.method, range);
  const r = dom.dataUrlResponse(request.url, request.method);
  return r && { status: 200, statusText: 'OK', url: request.url, headers: { 'content-type': r[0] }, body: '', body_bytes: r[1] };
}
