// Shim for Node's `url` module. mini_racer's V8 has no URL global, so we
// pull in the whatwg-url package and re-export it. Code that grabs the URL
// constructor at import time (e.g. happy-dom subclassing it) gets a real
// parser; downstream code can keep using `globalThis.URL`.
import {URL as WhatwgURL, URLSearchParams as WhatwgURLSearchParams} from 'whatwg-url';

if (!globalThis.URL) globalThis.URL = WhatwgURL;
if (!globalThis.URLSearchParams) globalThis.URLSearchParams = WhatwgURLSearchParams;

export const URL = WhatwgURL;
export const URLSearchParams = WhatwgURLSearchParams;
export default {URL, URLSearchParams};
