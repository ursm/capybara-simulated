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

globalThis.__csimSetTimezone = function (tz) {
  targetTZ = (typeof tz === 'string' && tz.length > 0) ? tz : null;
};

const OrigDTF = Intl.DateTimeFormat;

function PatchedDTF(locales, options) {
  if (!(this instanceof PatchedDTF)) return new PatchedDTF(locales, options);
  // Hot path: no override active → fall through to the native
  // constructor without `Reflect.construct`'s extra hop.
  if (!targetTZ || (options && options.timeZone)) return new OrigDTF(locales, options);
  return new OrigDTF(locales, Object.assign({}, options, { timeZone: targetTZ }));
}
PatchedDTF.prototype          = OrigDTF.prototype;
PatchedDTF.supportedLocalesOf = function (l, o) { return OrigDTF.supportedLocalesOf(l, o); };
Intl.DateTimeFormat = PatchedDTF;
