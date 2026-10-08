// The asynchronous clipboard (Clipboard API and events §7), generated from its IDL: `navigator.clipboard` — a
// Clipboard — and the ClipboardItems it reads and writes, over the session's one system clipboard, which the host holds
// (the Driver's, every window's and frame's, kept across visits until the session resets) — the copy-then-paste round
// trip the driver needs (`copy_*_to_clipboard`, ProseMirror / Tiptap paste tests writing a ClipboardItem, Discourse's
// `cdp.copy_test_image` an image/png Blob beside a text/html placeholder), on one page or across them.

import { EventTarget, installEventHandlerAttrs } from './events.js';
import { Blob, File, blobBytes, isBlob, isFile } from './blob.js';
import { latin1ToBytes, utf8DecodeBytes } from './bytes.js';
import { parseMimeType } from './mime.js';
import { convertClipboardItemArguments, installClipboard, installClipboardItem } from './generated/bindings.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, rejectedPromise, slotsOf } from './webidl.js';

// The promises this realm's clipboard makes are its own %Promise%'s, whatever a page puts in `Promise` (Zone.js).
const NativePromise = Promise;

// The system clipboard: one item, its representations a Blob for each type (by its type's essence; a web custom format
// "web " and its own) — and its change count, which a ClipboardItem read from it compares at getType(). Held by the host
// as [type, bytes] pairs; the Blobs made of them kept here while the count says they are what it holds.
let cached = { count: -1, entries: {} };
function systemClipboard() {
  if (globalThis.__csim_clipboardCount() === cached.count) return cached;
  const held = globalThis.__csim_clipboardRead();
  {
    const entries = {};
    for (const [type, bytes] of held.entries) entries[type] = new Blob([latin1ToBytes(bytes)], { type: type.startsWith('web ') ? type.slice(4) : type });
    cached = { count: held.count, entries };
  }
  return cached;
}
const clipboardEntries = () => systemClipboard().entries;
function writeClipboard(next) {
  globalThis.__csim_clipboardWrite(Object.entries(next).map(([type, blob]) => [type, blobBytes(blob)]));
  cached = { count: -1, entries: {} };
}

// The data types a page may write and read (§6.4, §6.5): the mandatory ones, and the optional ones this clipboard
// recognises — text/uri-list, image/svg+xml, and a web custom format ("web " and a MIME type) — by a type's essence, as
// writeText's own "text/plain;charset=utf-8" Blob has it; the key it is held under (null for one no page may write).
const KNOWN_TYPES = new Set(['text/plain', 'text/html', 'image/png', 'text/uri-list', 'image/svg+xml']);
function clipboardKey(type) {
  const custom = type.startsWith('web ');
  const mimeType = parseMimeType(custom ? type.slice(4) : type);
  if (mimeType === null) return null;
  if (custom) return 'web ' + mimeType.essence;
  return KNOWN_TYPES.has(mimeType.essence) ? mimeType.essence : null;
}
const knownType = (type) => clipboardKey(type) !== null;
// A representation's data as it resolves, converted to `(DOMString or Blob)` (Web IDL "react to a Promise<T>"): a Blob
// of any realm as it is, anything else its string.
function asData(v) {
  if (isBlob(v)) return v;
  if (typeof v === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
  return String(v);
}

// A ClipboardItem's slots: its representations — `{mimeType, isCustom, data}`, its data a promise of a string or a
// Blob — its presentation style, its types array (frozen, the same each time), and, for one read from the clipboard,
// the change count it was read at (null for one a page made).
const itemOf = (o) => slotsOf(o, 'ClipboardItem');
registerInterface('ClipboardItem', (o) => itemOf(o) !== undefined);
export class ClipboardItem {
  // The constructor steps (§7.2): no empty record; each key a MIME type — or "web " and one, a custom format — none
  // twice (TypeError); its type the MIME type serialized.
  constructor(items, options) {
    const read = items === PLATFORM ? options : null;
    let representations;
    let presentationStyle = 'unspecified';
    if (read) {
      representations = read.representations;
    } else {
      [items, options] = convertClipboardItemArguments(arguments);
      if (items.length === 0) throw new TypeError("Failed to construct 'ClipboardItem': Empty dictionary argument");
      presentationStyle = options.presentationStyle;
      representations = [];
      for (const [key, data] of items) {
        const isCustom = key.startsWith('web ');
        const mimeType = parseMimeType(isCustom ? key.slice(4) : key);
        if (mimeType === null) throw new TypeError(`Failed to construct 'ClipboardItem': Invalid MIME type '${key}'.`);
        const type = String(mimeType);
        if (representations.some((r) => r.type === type && r.isCustom === isCustom)) {
          throw new TypeError(`Failed to construct 'ClipboardItem': The type '${key}' is given more than once.`);
        }
        representations.push({ type, essence: mimeType.essence, isCustom, data });
      }
    }
    makeSlots(this, 'ClipboardItem', {
      representations, presentationStyle,
      types: Object.freeze(representations.map((r) => (r.isCustom ? 'web ' : '') + r.type)),
      changeCountAtRead: read ? read.changeCount : null
    });
  }
}
installClipboardItem(ClipboardItem, {
  get_presentationStyle: (item) => itemOf(item).presentationStyle,
  get_types: (item) => itemOf(item).types,
  // getType(): its representation of the type — a string made a Blob of that type — or a NotFoundError; for an item
  // read from the clipboard, an InvalidStateError once the clipboard has changed since (stale data is never returned).
  getType(item, type) {
    const s = itemOf(item);
    const isCustom = type.startsWith('web ');
    const mimeType = parseMimeType(isCustom ? type.slice(4) : type);
    if (mimeType === null) throw new TypeError(`Failed to execute 'getType' on 'ClipboardItem': Invalid MIME type '${type}'.`);
    const representation = s.representations.find((r) => r.essence === mimeType.essence && r.isCustom === isCustom);
    if (!representation) {
      return rejectedPromise(new DOMException("Failed to execute 'getType' on 'ClipboardItem': The type was not found", 'NotFoundError'));
    }
    if (s.changeCountAtRead !== null && s.changeCountAtRead !== systemClipboard().count) {
      return rejectedPromise(new DOMException("Failed to execute 'getType' on 'ClipboardItem': The clipboard has changed since it was read.", 'InvalidStateError'));
    }
    // (…its data a Blob of the type — a read item's a new one of its bytes, an item's own a string's or the Blob it was
    // given — and a rejection a NotFoundError, as §7.2.3 says, whatever the page's promise rejected with)
    // (…a read item's one promise per type, however many times it is asked: §7.2.3's representations with resolvers)
    if (representation.blob) return representation.blob;
    const blob = representation.data.then((v) => {
      const data = asData(v);
      if (typeof data === 'string') return new Blob([data], { type: representation.type });
      return s.changeCountAtRead === null ? data : data.slice(0, data.size, representation.type);
    }, () => {
      throw new DOMException("Failed to execute 'getType' on 'ClipboardItem': The type was not found", 'NotFoundError');
    });
    if (s.changeCountAtRead !== null) representation.blob = blob;
    return blob;
  },
  supports: (self, type) => knownType(type)
});
globalThis.ClipboardItem = ClipboardItem;

// The Clipboard: one per realm, `navigator.clipboard` ([SameObject]), made by the platform alone. Its reads and writes
// are the clipboard task source's: each settles in a task, as a browser's do.
registerInterface('Clipboard', (o) => slotsOf(o, 'Clipboard') !== undefined);
export class Clipboard extends EventTarget {
  constructor(token) {
    constructedBy(PLATFORM, token, 'Clipboard');
    super();
    makeSlots(this, 'Clipboard', {});
  }
}
const inTask = (steps) => new NativePromise((resolve, reject) => {
  globalThis.__csimSetTimeout(() => {
    try { resolve(steps()); } catch (e) { reject(e); }
  }, 0);
});
// (…its text the bytes UTF-8 decoded natively, no page's TextDecoder in the way)
const textOf = (blob) => utf8DecodeBytes(blobBytes(blob));
installClipboard(Clipboard, {
  // read(): the clipboard's item, its representations' data each the Blob it holds — no items for an empty clipboard.
  read: () => inTask(() => {
    const { count, entries } = systemClipboard();
    const types = Object.keys(entries);
    if (types.length === 0) return [];
    const representations = types.map((key) => {
      const isCustom = key.startsWith('web '), type = isCustom ? key.slice(4) : key;
      return { type, essence: type, isCustom, data: NativePromise.resolve(entries[key]) };
    });
    return [new ClipboardItem(PLATFORM, { representations, changeCount: count })];
  }),
  // readText(): its text/plain, UTF-8 decoded — a NotFoundError where it has none.
  readText: () => inTask(() => {
    const blob = clipboardEntries()['text/plain'];
    if (!blob) throw new DOMException("Failed to execute 'readText' on 'Clipboard': No text in the clipboard.", 'NotFoundError');
    return textOf(blob);
  }),
  // write(): the first item's representations (the clipboard holds one) — a string a Blob of its type — each of a type
  // a page may write (else a NotAllowedError, the clipboard untouched); no item writes nothing.
  write: (clipboard, data) => inTask(() => data[0]).then((item) => {
    if (!item) return;
    const s = itemOf(item);
    return NativePromise.all(s.representations.map((r) => r.data.then(
      (v) => { const d = asData(v); return typeof d === 'string' ? new Blob([d], { type: r.type }) : d; },
      () => { throw new DOMException("Failed to execute 'write' on 'Clipboard': A representation's data was rejected.", 'NotAllowedError'); }
    ))).then((blobs) => {
      const next = {};
      blobs.forEach((blob, i) => {
        const key = clipboardKey((s.representations[i].isCustom ? 'web ' : '') + blob.type);
        if (key === null) throw new DOMException(`Failed to execute 'write' on 'Clipboard': Type ${blob.type || '(none)'} not supported on write.`, 'NotAllowedError');
        // (…two of one type a clipboard holding a Blob per type cannot keep both of: refused, not one dropped — Chrome
        // refuses a Blob whose type is not its key's)
        if (key in next) throw new DOMException(`Failed to execute 'write' on 'Clipboard': Type ${blob.type} is given more than once.`, 'NotAllowedError');
        next[key] = blob;
      });
      writeClipboard(next);
    });
  }),
  // writeText(): text/plain, as a UTF-8 Blob.
  writeText: (clipboard, text) => inTask(() => writeClipboard({ 'text/plain': new Blob([text], { type: 'text/plain' }) })),
  installEventHandlers: (proto, names, isSelf) => installEventHandlerAttrs(proto, names, null, isSelf)
});
globalThis.Clipboard = Clipboard;
export const clipboard = new Clipboard(PLATFORM);

// The driver's own reads and writes of the system clipboard — the paste / copy / cut actions (dom-nodes.js) and the
// session's — through hooks, as the modules that use them are in import cycles with this one.
// Synchronous text accessor for the paste-event default-action path: the entry's blob's bytes UTF-8-decoded (`Blob.text()`
// is async per spec) — without decoding, non-ASCII text pastes as mojibake. Binary Blobs (image/*) don't reach this path
// (only text/* entries do).
globalThis.__csimClipboardGet = function (kind) {
  const t = String(kind || 'text/plain');
  const entries = clipboardEntries();
  const b = entries[t] || (t === 'text' ? entries['text/plain'] : null);
  return b ? textOf(b) : '';
};
globalThis.__csimClipboardSet = function (text) {
  writeClipboard({ 'text/plain': new Blob([String(text == null ? '' : text)], { type: 'text/plain' }) });
};
// Multi-flavor write: a rich (contenteditable) cut / copy stores both text/plain
// and text/html, so a later paste's dataTransfer can round-trip the original
// markup (input-events-cut-paste asserts `getData('text/html')` recovers the
// copied `<b>rich</b>`). Empty flavors are skipped so a plain-text selection
// never leaves a spurious empty text/html entry on the clipboard.
globalThis.__csimClipboardSetData = function (map) {
  const next = {};
  const m = map || {};
  for (const k of Object.keys(m)) {
    const v = m[k];
    if (v == null || v === '') continue;
    next[String(k)] = new Blob([String(v)], { type: String(k) });
  }
  // Copying an empty selection is a no-op — leave the existing clipboard intact
  // rather than wiping it (real browsers don't clear the clipboard when there's
  // nothing to copy).
  if (Object.keys(next).length === 0) return;
  writeClipboard(next);
};
globalThis.__csimClipboardTypes = function () { return Object.keys(clipboardEntries()); };
// Return Files (only entries with non-text MIME types) for the
// `clipboardData.files` slot in the paste event. Real browsers give
// each clipboard binary a `File` (not a `Blob`), with a synthesised
// name like "image.png". Discourse's PM paste handler filters by
// `file.name` / `file.type` to decide between processing the binary
// vs. falling back to text/html — naming the entries is required
// for the file-precedes-html branch to fire.
const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'application/pdf': 'pdf', 'application/zip': 'zip',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav',
  'video/mp4': 'mp4', 'video/webm': 'webm'
};
// (…a web custom format no paste event sees, nor an image/svg+xml, which is markup: Chrome)
globalThis.__csimClipboardFiles = function () {
  const out = [], entries = clipboardEntries();
  for (const t of Object.keys(entries)) {
    if (t === 'text/plain' || t === 'text/html' || t === 'text/uri-list' || t === 'image/svg+xml' || t.startsWith('web ')) continue;
    const b = entries[t];
    if (!b) continue;
    if (isFile(b)) { out.push(b); continue; }
    const kind = String(t).split('/')[0] || 'file';
    const ext  = EXT_BY_MIME[t] || 'bin';
    out.push(new File([b], `${kind}.${ext}`, { type: t }));
  }
  return out;
};
