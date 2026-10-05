// A worker's global (workers.js `__csim_installWorkerScope`): made from the window's snapshot, it drops the Window's
// members (window.js) and has WindowOrWorkerGlobalScope's — own properties of the scope, as a window's members were
// before they were generated: `self` the scope, and its `navigator` and `location` the realm's.
// (A leaf, which bridge.entry.js imports: workers.js is in an import cycle with blob.js, and its hook asks this one.)

import {
  documentOrigin, performance, reportError, structuredClone
} from './platform-globals.js';
import {
  cancelAnimationFrame, clearTimer, queueMicrotask, requestAnimationFrame, setInterval, setTimeout
} from './timers.js';
import { atob, btoa } from './encoding.js';
import { createImageBitmap } from './canvas.js';
import { location } from './location.js';
import { navigator } from './navigator.js';
import { indexedDB } from './idb.js';
import { caches } from './cache-storage.js';
import { crypto } from './webcrypto.js';
import { windowMemberNames } from './window.js';

globalThis.__csimInstallWorkerGlobals = function () {
  for (const name of windowMemberNames()) delete globalThis[name];
  const own = (name, value) => Object.defineProperty(globalThis, name, { value, writable: true, enumerable: true, configurable: true });
  const read = (name, get) => Object.defineProperty(globalThis, name, { get, enumerable: true, configurable: true });
  own('self', globalThis);
  own('navigator', navigator);
  read('location', () => location);
  read('origin', documentOrigin);
  own('isSecureContext', true);
  read('crossOriginIsolated', () => false);
  own('reportError', reportError);
  own('btoa', btoa);
  own('atob', atob);
  own('setTimeout', function (handler, timeout, ...args) { return setTimeout(handler, timeout, args); });
  own('setInterval', function (handler, timeout, ...args) { return setInterval(handler, timeout, args); });
  own('clearTimeout', function (id) { clearTimer(id); });
  own('clearInterval', function (id) { clearTimer(id); });
  own('queueMicrotask', function (callback) {
    if (typeof callback !== 'function') throw new TypeError("Failed to execute 'queueMicrotask' on 'WorkerGlobalScope': parameter 1 is not of type 'Function'.");
    queueMicrotask(callback);
  });
  own('createImageBitmap', createImageBitmap);
  own('structuredClone', structuredClone);
  own('indexedDB', indexedDB);
  own('performance', performance);
  own('caches', caches);
  own('crypto', crypto);
  own('requestAnimationFrame', requestAnimationFrame);
  own('cancelAnimationFrame', cancelAnimationFrame);
};
