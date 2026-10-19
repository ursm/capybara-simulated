// DataTransfer, DataTransferItemList and DataTransferItem (HTML §6.11.3), generated from their IDL — the drag data
// store a drag event, a clipboard event or a paste's input event carries. Real apps probe `e.dataTransfer instanceof
// DataTransfer` and iterate `dataTransfer.items` to handle a drop or a paste.
//
// The store is the engine's (drag_data_store.rs, a handle on `__dom.DragDataStoreBase`): its items, its mode, its
// `types`, dropEffect, effectAllowed and the current drag operation. A DataTransfer's slots hold that handle, each file
// item's File and each item's DataTransferItem object — by the item's number — and its FileList. Its item list and
// items are views of the store: an item removed from it, or of a store gone, is disabled.

import { defineDataTransferItem, defineDataTransferItemList, installDataTransfer } from './generated/bindings.js';
import { makeSlots, registerInterface, slotsOf } from './webidl.js';
import { createFileList } from './file-list.js';
import { asciiLower } from './ascii.js';
import { blobType, copyFile } from './blob.js';
import { DOMException } from './dom-exception.js';

const transferOf = (o) => slotsOf(o, 'DataTransfer');
const storeOf = (o) => transferOf(o).store;
registerInterface('DataTransfer', (o) => transferOf(o) !== undefined);

// (…what `__dom.dragStoreEffect` / `dragStoreSetEffect` name: drag_data_store.rs)
const DROP_EFFECT = 0;
const EFFECT_ALLOWED = 1;
const OPERATION = 2;

// The item list: its DataTransfer's slots.
const itemList = defineDataTransferItemList({
  init(list, t) { list.t = t; },
  get_length: (list) => globalThis.__dom.dragStoreLength(list.t.store),
  // (…the same DataTransferItem for an item each time it is asked for)
  getter: (list, index) => {
    const number = globalThis.__dom.dragStoreItemAt(list.t.store, index);
    return number < 0 ? null : itemFor(list.t, number);
  },
  // add(): only in read/write mode (else null); a string under its type ASCII-lowercased — a second string of that type a
  // NotSupportedError (the spec; Chrome adds it under the type as written) — a file under its own type, lowercased.
  add_data_type(list, data, type) {
    const number = globalThis.__dom.dragStoreAdd(list.t.store, false, type, data);
    if (number === -2) {
      throw new DOMException(`Failed to execute 'add' on 'DataTransferItemList': An item already exists for type '${asciiLower(type)}'.`, 'NotSupportedError');
    }
    return added(list.t, number);
  },
  add_data(list, file) {
    const number = globalThis.__dom.dragStoreAdd(list.t.store, true, blobType(file));
    if (number > 0) list.t.fileOf.set(number, file);
    return added(list.t, number);
  },
  // remove(): only in read/write mode (else an InvalidStateError); an index past the end nothing.
  remove(list, index) {
    if (!globalThis.__dom.dragStoreRemove(list.t.store, index)) {
      throw new DOMException("Failed to execute 'remove' on 'DataTransferItemList': The list is not editable.", 'InvalidStateError');
    }
    changed(list.t);
  },
  clear(list) {
    if (globalThis.__dom.dragStoreRemove(list.t.store)) changed(list.t);
  }
});
globalThis.DataTransferItemList = itemList.interface;
function added(t, number) {
  if (number < 0) return null;
  changed(t);
  return itemFor(t, number);
}
// The item list changed: an item it no longer holds lets its object go — its number never comes back — and the files
// are its file items' again.
function changed(t) {
  for (const number of t.itemOf.keys()) {
    if (globalThis.__dom.dragStoreItem(t.store, number) === null) t.itemOf.delete(number);
  }
  syncFiles(t);
}

// An item: its DataTransfer's slots and the number of the store's item it represents — its mode the store's while the
// store holds it, disabled otherwise.
const item = defineDataTransferItem({
  init(slots, t, number) { slots.t = t; slots.number = number; },
  get_kind: (s) => {
    const info = globalThis.__dom.dragStoreItem(s.t.store, s.number);
    return info === null ? '' : info[1] ? 'file' : 'string';
  },
  get_type: (s) => globalThis.__dom.dragStoreItem(s.t.store, s.number)?.[2] ?? '',
  // getAsString(): its text, to the callback in a task — never in protected or disabled mode, nor for a file.
  getAsString(s, callback) {
    if (callback === null) return;
    const data = globalThis.__dom.dragStoreText(s.t.store, s.number);
    if (data === null) return;
    globalThis.__csimSetTimeout(() => {
      try { callback(data); } catch (e) { globalThis.__csimReportCallbackError(callback, e); }
    }, 0);
  },
  // getAsFile(): "a new File object" of its file's data — the same data, unread: a picked file's stays the pick's — in
  // read/write or read-only mode.
  getAsFile(s) {
    const info = globalThis.__dom.dragStoreItem(s.t.store, s.number);
    if (info === null || !info[1] || (info[0] !== 'read/write' && info[0] !== 'read-only')) return null;
    return copyFile(s.t.fileOf.get(s.number));
  }
});
globalThis.DataTransferItem = item.interface;
function itemFor(t, number) {
  let made = t.itemOf.get(number);
  if (!made) t.itemOf.set(number, made = item.create(t, number));
  return made;
}

// Its FileList ([SameObject], live) kept to its file items' files while the store's data can be read. Once it cannot —
// protected, or the store gone — the DataTransfer is given an empty list of its own, and the one it had is left as it
// stood: an `<input>` that took it (`input.files = e.dataTransfer.files`, the drop-to-upload pattern) keeps its selection
// whatever is read of the DataTransfer later.
function syncFiles(t) {
  const numbers = globalThis.__dom.dragStoreFiles(t.store);
  if (numbers === null) {
    if (t.files.length) {
      t.files = [];
      t.filesView = createFileList(t.files);
    }
    return;
  }
  // (…a file item the store no longer holds lets its File go)
  for (const number of t.fileOf.keys()) if (!numbers.includes(number)) t.fileOf.delete(number);
  t.files.splice(0, t.files.length, ...numbers.map((n) => t.fileOf.get(n)));
}
// "When the contents of the drag data store item list change, or when the DataTransfer object becomes no longer
// associated with a drag data store": its types array made anew.
function typesOf(t) {
  const made = globalThis.__dom.dragStoreTypes(t.store, t.typesVersion);
  if (made !== null) {
    t.typesVersion = made[0];
    t.types = Object.freeze(made.slice(1));
  }
  return t.types;
}

// The DataTransfer constructor: an empty store in read/write mode, dropEffect and effectAllowed "none".
export class DataTransfer {
  constructor() {
    const t = makeSlots(this, 'DataTransfer', {
      store: new globalThis.__dom.DragDataStoreBase(), fileOf: new Map(), itemOf: new Map(), types: null, typesVersion: null,
      files: [], filesView: null
    });
    t.list = itemList.create(t);
    t.filesView = createFileList(t.files);
  }
}
installDataTransfer(DataTransfer, {
  get_dropEffect: (dt) => globalThis.__dom.dragStoreEffect(storeOf(dt), DROP_EFFECT),
  set_dropEffect(dt, v) { globalThis.__dom.dragStoreSetEffect(storeOf(dt), DROP_EFFECT, v); },
  get_effectAllowed: (dt) => globalThis.__dom.dragStoreEffect(storeOf(dt), EFFECT_ALLOWED),
  set_effectAllowed(dt, v) { globalThis.__dom.dragStoreSetEffect(storeOf(dt), EFFECT_ALLOWED, v); },
  get_items: (dt) => transferOf(dt).list,
  // setDragImage(): no drag image is drawn — a drag's feedback is no part of the page.
  setDragImage() {},
  get_types: (dt) => typesOf(transferOf(dt)),
  getData: (dt, format) => globalThis.__dom.dragStoreGetData(storeOf(dt), format),
  setData: (dt, format, data) => setTransferData(dt, format, data),
  clearData(dt, format) {
    const t = transferOf(dt);
    globalThis.__dom.dragStoreClearData(t.store, format);
    changed(t);
  },
  // files: its FileList (`syncFiles`) — its file items' files, none once the store is gone or while protected.
  get_files: (dt) => transferOf(dt).filesView
});
globalThis.DataTransfer = DataTransfer;

// A DataTransfer's data of `format` set — `setData`'s steps, and the UA's own seeding of a drag's store.
export function setTransferData(dt, format, data) {
  const t = transferOf(dt);
  globalThis.__dom.dragStoreSetData(t.store, format, data);
  changed(t);
}
// A DataTransfer's store put in `mode` — null for the store gone, the drag over.
export function setDataTransferMode(dt, mode) {
  const t = transferOf(dt);
  globalThis.__dom.dragStoreSetMode(t.store, mode);
  syncFiles(t);
}
// …its effectAllowed set whatever its mode (a drag's own starts "uninitialized").
export function setEffectAllowed(dt, value) {
  globalThis.__dom.dragStoreSetEffect(storeOf(dt), EFFECT_ALLOWED, value, true);
}

// "Fire a DND event" (HTML §6.11.5) of `type` with `dt`: before it its store's mode and its dropEffect, after it the
// current drag operation (drag_data_store.rs `Store::begin` / `end`). `link`: the drag is of a link (an `<a href>`).
export function beginDndEvent(dt, type, link = false) {
  const t = transferOf(dt);
  globalThis.__dom.dragStoreBegin(t.store, type, link);
  syncFiles(t);
}
export function endDndEvent(dt, type, canceled) {
  globalThis.__dom.dragStoreEnd(storeOf(dt), type, canceled);
}
// The current drag operation: what a drop is, "none" for none.
export const dragOperation = (dt) => globalThis.__dom.dragStoreEffect(storeOf(dt), OPERATION);
