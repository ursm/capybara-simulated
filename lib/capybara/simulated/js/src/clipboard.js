// The asynchronous clipboard (Clipboard API and events §7), generated from its IDL: `navigator.clipboard` — a
// Clipboard — and the ClipboardItems it reads and writes, over the session's one system clipboard. The system clipboard
// is in-process and survives across visits in the same Browser — real browsers share one; the driver needs the
// copy-then-paste round trip (`copy_*_to_clipboard`, ProseMirror / Tiptap paste tests writing a ClipboardItem, Discourse's
// `cdp.copy_test_image` an image/png Blob beside a text/html placeholder).

import { EventTarget, installEventHandlerAttrs } from './events.js';
import { Blob, File, blobBytes, isFile } from './blob.js';
import { latin1ToBytes } from './bytes.js';
import { parseMimeType } from './mime.js';
import { convertClipboardItemArguments, installClipboard, installClipboardItem } from './generated/bindings.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';

// The system clipboard: one item, its representations a Blob for each type — and its change count, which a
// ClipboardItem read from it compares at getType().
let entries = {};
let changeCount = 0;
function writeClipboard(next) {
  entries = next;
  changeCount++;
}

// The data types a page may write and read (§6.4, §6.5): the mandatory ones, and the optional ones this clipboard
// recognises — text/uri-list, image/svg+xml, and a web custom format ("web " and a MIME type).
const KNOWN_TYPES = new Set(['text/plain', 'text/html', 'image/png', 'text/uri-list', 'image/svg+xml']);
function knownType(type) {
  if (type.startsWith('web ')) return parseMimeType(type.slice(4)) !== null;
  return KNOWN_TYPES.has(type);
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
      return Promise.reject(new DOMException("Failed to execute 'getType' on 'ClipboardItem': The type was not found", 'NotFoundError'));
    }
    if (s.changeCountAtRead !== null && s.changeCountAtRead !== changeCount) {
      return Promise.reject(new DOMException("Failed to execute 'getType' on 'ClipboardItem': The clipboard has changed since it was read.", 'InvalidStateError'));
    }
    return representation.data.then((v) => (typeof v === 'string' ? new Blob([v], { type: representation.type }) : v));
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
const inTask = (steps) => new Promise((resolve, reject) => {
  globalThis.__csimSetTimeout(() => {
    try { resolve(steps()); } catch (e) { reject(e); }
  }, 0);
});
const textOf = (blob) => new globalThis.TextDecoder().decode(latin1ToBytes(blobBytes(blob)));
installClipboard(Clipboard, {
  // read(): the clipboard's item, its representations' data each the Blob it holds — no items for an empty clipboard.
  read: () => inTask(() => {
    const types = Object.keys(entries);
    if (types.length === 0) return [];
    const representations = types.map((type) => {
      const mimeType = parseMimeType(type.startsWith('web ') ? type.slice(4) : type);
      return { type, essence: mimeType ? mimeType.essence : type, isCustom: type.startsWith('web '), data: Promise.resolve(entries[type]) };
    });
    return [new ClipboardItem(PLATFORM, { representations, changeCount })];
  }),
  // readText(): its text/plain, UTF-8 decoded — a NotFoundError where it has none.
  readText: () => inTask(() => {
    const blob = entries['text/plain'];
    if (!blob) throw new DOMException("Failed to execute 'readText' on 'Clipboard': No text in the clipboard.", 'NotFoundError');
    return textOf(blob);
  }),
  // write(): the first item's representations (the clipboard holds one) — a string a Blob of its type — each of a type
  // a page may write (else a NotAllowedError, the clipboard untouched).
  write: (clipboard, data) => inTask(() => data[0]).then((item) => {
    if (!item) return writeClipboard({});
    const s = itemOf(item);
    return Promise.all(s.representations.map((r) => r.data.then(
      (v) => (typeof v === 'string' ? new Blob([v], { type: r.type }) : v),
      () => { throw new DOMException("Failed to execute 'write' on 'Clipboard': A representation's data was rejected.", 'NotAllowedError'); }
    ))).then((blobs) => {
      const next = {};
      blobs.forEach((blob, i) => {
        const type = s.representations[i].isCustom ? 'web ' + blob.type : blob.type;
        if (!knownType(type)) throw new DOMException(`Failed to execute 'write' on 'Clipboard': Type ${blob.type || '(none)'} not supported on write.`, 'NotAllowedError');
        next[type] = blob;
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
globalThis.__csimClipboardTypes = function () { return Object.keys(entries); };
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
globalThis.__csimClipboardFiles = function () {
  const out = [];
  for (const t of Object.keys(entries)) {
    if (t === 'text/plain' || t === 'text/html' || t === 'text/uri-list') continue;
    const b = entries[t];
    if (!b) continue;
    if (isFile(b)) { out.push(b); continue; }
    const kind = String(t).split('/')[0] || 'file';
    const ext  = EXT_BY_MIME[t] || 'bin';
    out.push(new File([b], `${kind}.${ext}`, { type: t }));
  }
  return out;
};
