// FileList (File API §5.2), generated from its IDL — the files of an `<input type=file>` and of a DataTransfer. Made by
// the platform alone (no constructor), its files indexed properties of a legacy platform object, `item` / `length` and
// @@iterator its interface's; what it lists is its internal slots', the array it is made over — the selection it shows,
// shared, not copied.

import { defineFileList } from './generated/bindings.js';
import { brandKey, slotsOf } from './webidl.js';

const binding = defineFileList({
  init(list, files) { list.files = files; },
  item: (list, index) => (index < list.files.length ? list.files[index] : null),
  get_length: (list) => list.files.length
});
globalThis.FileList = binding.interface;
const KEY = brandKey('FileList');

// A FileList over `files`.
export const createFileList = (files) => binding.create(files);
// …and the files a FileList of any realm is over — undefined for anything else, which is no FileList.
export function filesOf(list) {
  const slots = slotsOf(list, KEY);
  return slots && slots.files;
}
