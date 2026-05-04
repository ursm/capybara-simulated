// Bundle entry: brings happy-dom + wgxpath into one IIFE that exposes them
// on a single `__csim_bundle` global. happy-dom does not implement
// `document.evaluate`, so wgxpath layers it onto `Document.prototype`.
import {Window} from 'happy-dom';
import {URL, URLSearchParams} from 'whatwg-url';
import wgxpath from 'wicked-good-xpath';

// happy-dom 20's `document` is an `HTMLDocument` instance and the proto
// chain doesn't include `Document.prototype` (where wgxpath plants
// `evaluate` / `createExpression` / `createNSResolver`). Mirror the three
// methods onto `HTMLDocument.prototype` so `document.evaluate` works.
function installXPath(win) {
  wgxpath.install(win, /* opt_force */ true);
  if (win.HTMLDocument && win.Document) {
    for (const m of ['evaluate', 'createExpression', 'createNSResolver']) {
      if (win.Document.prototype[m] && !win.HTMLDocument.prototype[m]) {
        win.HTMLDocument.prototype[m] = win.Document.prototype[m];
      }
    }
  }
}

export {Window, URL, URLSearchParams, installXPath};
