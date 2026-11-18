import { realmHooks } from './engine.js';
import { objectAssign, objectDefineProperty, reflectApply } from './intrinsics.js';
// Process-level TZ override (Intl only).
//
// V8 reads `TZ` once at platform init and caches the local zone for
// the lifetime of the process — `DateTimeConfigurationChange
// Notification` is the only flush hook and the embedding doesn't expose
// it. Real-browser drivers sidestep this by killing Chrome on
// `reset_browser`; we can't kill V8. Avo's suite (and others) use
// `tz:` example metadata that flips `ENV['TZ']` per-example,
// expecting the browser to pick up the change.
//
// We patch `Intl.DateTimeFormat()` to default `timeZone` to the
// Ruby-supplied target. That covers libraries that route through
// Intl (Luxon's `SystemZone`, `DateTime.local()`, IANAZone
// conversion). We deliberately do NOT patch `Date.prototype` local
// accessors: those have setter pairs (`setHours`, etc.) that V8
// implements natively against the cached zone, and a half-patch
// (getters only) breaks `setHours(getHours())` round-trips —
// flatpickr's `setHoursFromDate` does exactly that and corrupted the
// instant by the offset delta. Code paths that call native `Date`
// getters keep reporting V8's cached zone; tests that exercise
// per-`tz:` switches in those paths (flatpickr's clock-face
// round-trip) stay out of scope.

let targetTZ = null;

realmHooks.setTimezone = function (tz) {
  targetTZ = (typeof tz === 'string' && tz.length > 0) ? tz : null;
};

const OrigDTF = Intl.DateTimeFormat;

// (…the constructor it stands in for as a page sees it: its name, its length, its prototype's `constructor`, its static —
// and read as a builtin, `function DateTimeFormat() { [native code] }`)
function DateTimeFormat(locales, options) {
  if (!(this instanceof DateTimeFormat)) return new DateTimeFormat(locales, options);
  // Hot path: no override active → fall through to the native
  // constructor without `Reflect.construct`'s extra hop.
  if (!targetTZ || (options && options.timeZone)) return new OrigDTF(locales, options);
  return new OrigDTF(locales, objectAssign({}, options, { timeZone: targetTZ }));
}
objectDefineProperty(DateTimeFormat, 'length', { __proto__: null, value: 0, writable: false, enumerable: false, configurable: true });
objectDefineProperty(DateTimeFormat, 'prototype', { __proto__: null, value: OrigDTF.prototype, writable: false, enumerable: false, configurable: false });
objectDefineProperty(OrigDTF.prototype, 'constructor', { __proto__: null, value: DateTimeFormat, writable: true, enumerable: false, configurable: true });
const supportedLocalesOf = OrigDTF.supportedLocalesOf;
objectDefineProperty(DateTimeFormat, 'supportedLocalesOf', { __proto__: null, value: { supportedLocalesOf(locales) { return reflectApply(supportedLocalesOf, OrigDTF, arguments); } }.supportedLocalesOf, writable: true, enumerable: false, configurable: true });
Intl.DateTimeFormat = DateTimeFormat;
