// MINIMAL, hand-written stand-in for the upstream WPT service-worker test-helpers.
//
// webmessaging/broadcastchannel/{cross-origin,detached-iframe} pull ONLY `with_iframe` from this
// file (by absolute path). The full upstream helper also defines `service_worker_test` etc., and
// once those are DEFINED the service-worker tests that include this file (FileAPI/historical,
// fetch/api/policies/referrer-*-service-worker) register service-worker subtests that predate the
// SW runtime's current coverage (registration/lifecycle/messaging/fetch-interception ARE modeled
// now — see sw-client.js / __csim_installServiceWorkerScope — but those trees' SW subtests aren't
// green yet). Keeping this file to just `with_iframe` leaves `service_worker_test` undefined, so
// those SW tests abort at that call rather than running failing SW subtests. Swap in the upstream
// helper when the service-worker tree slice is vendored.
//
// NOT fetched by script/vendor_wpt.mjs (it would overwrite this with the full upstream file); it
// lives outside every cleaned tree so re-vendoring leaves it intact.

function with_iframe(url) {
  return new Promise(function (resolve) {
    var frame = document.createElement('iframe');
    frame.className = 'test-iframe';
    frame.src = url;
    frame.onload = function () { resolve(frame); };
    document.body.appendChild(frame);
  });
}

function normalizeURL(url) {
  return new URL(url, self.location).toString().replace(/#.*$/, '');
}
