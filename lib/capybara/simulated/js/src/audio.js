// `new Audio(src)` (HTML §4.8.10): the legacy factory of an `<audio>` element — `preload="auto"`, its `src` the
// argument — its prototype HTMLAudioElement's (dom-class-aliases.js). Mastodon's sounds middleware constructs one at
// module-init time and appends `<source>`s to it; its playback state is every media element's (video.js).
export function Audio(src) {
  const el = globalThis.document.createElement('audio');
  el.setAttribute('preload', 'auto');
  if (src !== undefined) el.setAttribute('src', String(src));
  return el;
}

globalThis.Audio = Audio;
