// `Audio` constructor — Mastodon's `redux/middlewares/sounds.ts` and
// `media_container` chunk construct one at module-init time to load
// notification ping / boop / etc. Without it the audio sub-module's
// eval rejects, the dynamic-import chain that mounts MediaGallery
// rejects with it, and the admin report page never gets a
// `.spoiler-button__overlay__label`. Stub does nothing audible
// (no `play` engine here) but lets the construct succeed.
//
// `new Audio(src)` in real browsers returns an `HTMLAudioElement`
// (an `<audio>` Element subclass). Build a real `<audio>` element so
// `t.appendChild(<source>)` works — Mastodon's sounds middleware
// does `e.forEach(({src}) => { let r = document.createElement('source');
// … ; t.appendChild(r); })` against the Audio result.

export function Audio(src) {
  const el = globalThis.document.createElement('audio');
  if (src) el.setAttribute('src', String(src));
  el.play         = function () { return Promise.resolve(); };
  el.pause        = function () {};
  el.load         = function () {};
  el.canPlayType  = function () { return ''; };
  el.paused       = true;
  el.currentTime  = 0;
  el.volume       = 1;
  el.muted        = false;
  return el;
}
