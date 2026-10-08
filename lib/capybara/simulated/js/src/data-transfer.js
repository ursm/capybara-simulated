// DataTransfer, DataTransferItemList and DataTransferItem (HTML §6.11.3), generated from their IDL — the drag data
// store a drag event, a clipboard event or a paste's input event carries. Real apps probe `e.dataTransfer instanceof
// DataTransfer` and iterate `dataTransfer.items` to handle a drop or a paste.
//
// A DataTransfer's slots hold its drag data store — its item list (`{kind, type, data}` each, `kind` 'text' or 'file')
// and its mode: 'read/write' where its data is written (a script's own, a drag's `dragstart`), 'read-only' where it is
// read (a `drop`, a paste), 'protected' while it is carried over the page (the other drag events) — its formats listed,
// its data and files none — and null once the drag is over and the store gone ("no longer associated"). Its item list
// and items are views of that store: an item removed from it, or of a store gone, is disabled.

import { defineDataTransferItem, defineDataTransferItemList, installDataTransfer } from './generated/bindings.js';
import { makeSlots, registerInterface, slotsOf } from './webidl.js';
import { createFileList, filesOf } from './file-list.js';
import { asciiLowercase, normalizeDataFormat } from './mime.js';

const transferOf = (o) => slotsOf(o, 'DataTransfer');
registerInterface('DataTransfer', (o) => transferOf(o) !== undefined);

// The item list: its DataTransfer's slots.
const itemList = defineDataTransferItemList({
  init(list, t) { list.t = t; },
  get_length: (list) => (list.t.store.mode === null ? 0 : list.t.store.items.length),
  // (…the same DataTransferItem for an item each time it is asked for)
  getter: (list, index) => {
    const entry = list.t.store.mode === null ? undefined : list.t.store.items[index];
    return entry === undefined ? undefined : itemFor(list.t, entry);
  },
  // add(): only in read/write mode (else null); a string under its type ASCII-lowercased — a second string of that type a
  // NotSupportedError (the spec; Chrome adds it under the type as written) — a file under its own type, lowercased.
  add_data_type(list, data, type) {
    const t = list.t;
    if (t.store.mode !== 'read/write') return null;
    const lower = asciiLowercase(type);
    if (t.store.items.some((e) => e.kind === 'text' && e.type === lower)) {
      throw new DOMException(`Failed to execute 'add' on 'DataTransferItemList': An item already exists for type '${lower}'.`, 'NotSupportedError');
    }
    return addEntry(t, { kind: 'text', type: lower, data });
  },
  add_data(list, file) {
    const t = list.t;
    if (t.store.mode !== 'read/write') return null;
    return addEntry(t, { kind: 'file', type: asciiLowercase(file.type), data: file });
  },
  // remove(): only in read/write mode (else an InvalidStateError); an index past the end nothing.
  remove(list, index) {
    const t = list.t;
    if (t.store.mode !== 'read/write') {
      throw new DOMException("Failed to execute 'remove' on 'DataTransferItemList': The list is not editable.", 'InvalidStateError');
    }
    if (index >= t.store.items.length) return;
    t.store.items.splice(index, 1);
    changed(t);
  },
  clear(list) {
    const t = list.t;
    if (t.store.mode !== 'read/write') return;
    t.store.items.length = 0;
    changed(t);
  }
});
globalThis.DataTransferItemList = itemList.interface;
function addEntry(t, entry) {
  t.store.items.push(entry);
  changed(t);
  return itemFor(t, entry);
}

// An item: its DataTransfer's slots and the store's entry it represents — its mode the store's while the store holds
// it, disabled otherwise.
const item = defineDataTransferItem({
  init(slots, t, entry) { slots.t = t; slots.entry = entry; },
  get_kind: (s) => (modeOf(s) === null ? '' : s.entry.kind === 'text' ? 'string' : 'file'),
  get_type: (s) => (modeOf(s) === null ? '' : s.entry.type),
  // getAsString(): its text, to the callback in a task — never in protected or disabled mode, nor for a file.
  getAsString(s, callback) {
    if (callback === null || !readable(modeOf(s)) || s.entry.kind !== 'text') return;
    const data = s.entry.data;
    globalThis.__csimSetTimeout(() => {
      try { callback(data); } catch (e) { globalThis.__csimReportCallbackError(callback, e); }
    }, 0);
  },
  // getAsFile(): "a new File object" of its file's data, in read/write or read-only mode.
  getAsFile(s) {
    if (!readable(modeOf(s)) || s.entry.kind !== 'file') return null;
    const file = s.entry.data;
    return new globalThis.File([file], file.name, { type: file.type, lastModified: file.lastModified });
  }
});
globalThis.DataTransferItem = item.interface;
const modeOf = (s) => (s.t.store.items.includes(s.entry) ? s.t.store.mode : null);
const readable = (mode) => mode === 'read/write' || mode === 'read-only';
function itemFor(t, entry) {
  if (!entry.item) entry.item = item.create(t, entry);
  return entry.item;
}

// "When the contents of the drag data store item list change, or when the DataTransfer object becomes no longer
// associated with a drag data store": its types array made anew — its text items' types, then "Files" for any file.
function changed(t) {
  t.types = null;
}
function typesOf(t) {
  if (t.types === null) {
    const list = [];
    if (t.store.mode !== null) {
      for (const e of t.store.items) if (e.kind === 'text') list.push(e.type);
      if (t.store.items.some((e) => e.kind === 'file')) list.push('Files');
    }
    t.types = Object.freeze(list);
  }
  return t.types;
}

// The DataTransfer constructor: an empty store in read/write mode, dropEffect and effectAllowed "none".
export class DataTransfer {
  constructor() {
    const t = makeSlots(this, 'DataTransfer', {
      store: { items: [], mode: 'read/write' }, dropEffect: 'none', effectAllowed: 'none', types: null, filesView: null
    });
    t.list = itemList.create(t);
  }
}
const DROP_EFFECTS = new Set(['none', 'copy', 'link', 'move']);
const EFFECTS_ALLOWED = new Set(['none', 'copy', 'copyLink', 'copyMove', 'link', 'linkMove', 'move', 'all', 'uninitialized']);
installDataTransfer(DataTransfer, {
  get_dropEffect: (dt) => transferOf(dt).dropEffect,
  set_dropEffect(dt, v) { if (DROP_EFFECTS.has(v)) transferOf(dt).dropEffect = v; },
  get_effectAllowed: (dt) => transferOf(dt).effectAllowed,
  set_effectAllowed(dt, v) {
    const t = transferOf(dt);
    if (t.store.mode === 'read/write' && EFFECTS_ALLOWED.has(v)) t.effectAllowed = v;
  },
  get_items: (dt) => transferOf(dt).list,
  // setDragImage(): no drag image is drawn — a drag's feedback is no part of the page.
  setDragImage() {},
  get_types: (dt) => typesOf(transferOf(dt)),
  // getData(): none once the store is gone or while protected; a "url" the first URL of its text/uri-list.
  getData(dt, format) {
    const t = transferOf(dt);
    if (t.store.mode === null || t.store.mode === 'protected') return '';
    const type = normalizeDataFormat(format);
    const entry = t.store.items.find((e) => e.kind === 'text' && e.type === type);
    if (!entry) return '';
    if (asciiLowercase(format) !== 'url') return entry.data;
    const first = entry.data.split(/\r?\n/).find((line) => line !== '' && line[0] !== '#');
    return first === undefined ? '' : first;
  },
  // setData(): in read/write mode, the format's one text item replaced.
  setData(dt, format, data) {
    const t = transferOf(dt);
    if (t.store.mode !== 'read/write') return;
    const type = normalizeDataFormat(format);
    t.store.items = t.store.items.filter((e) => !(e.kind === 'text' && e.type === type));
    t.store.items.push({ kind: 'text', type, data });
    changed(t);
  },
  // clearData(): in read/write mode, the format's text item — or with no format every text item, the files staying.
  clearData(dt, format) {
    const t = transferOf(dt);
    if (t.store.mode !== 'read/write') return;
    const type = format === undefined ? null : normalizeDataFormat(format);
    t.store.items = t.store.items.filter((e) => !(e.kind === 'text' && (type === null || e.type === type)));
    changed(t);
  },
  // files: its file items' files, none once the store is gone or while protected — the same FileList while they are
  // the same files.
  get_files(dt) {
    const t = transferOf(dt);
    const out = readable(t.store.mode) ? t.store.items.filter((e) => e.kind === 'file').map((e) => e.data) : [];
    const files = t.filesView && filesOf(t.filesView);
    if (files && files.length === out.length && files.every((f, i) => f === out[i])) return t.filesView;
    return (t.filesView = createFileList(out));
  }
});
globalThis.DataTransfer = DataTransfer;

// The drag data store's mode for a drag event of `type`.
export function dragDataStoreMode(type) {
  return type === 'dragstart' ? 'read/write' : type === 'drop' ? 'read-only' : 'protected';
}
// …a DataTransfer's store put in `mode` — null for the store gone, the drag over — and its effectAllowed set (a drag's
// own starts "uninitialized").
export function setDataTransferMode(dt, mode) {
  const t = transferOf(dt);
  t.store.mode = mode;
  if (mode === null) changed(t);
}
export function setEffectAllowed(dt, value) {
  transferOf(dt).effectAllowed = value;
}