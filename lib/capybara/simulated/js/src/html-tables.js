// The tabular data interfaces' members (HTML §4.9) that reflect no content attribute — the generated bindings take
// those (gen_bindings.mjs) — as the implementations dom-class-aliases.js installs them with: HTMLTableElement's,
// HTMLTableSectionElement's, HTMLTableRowElement's and HTMLTableCellElement's. The table API is the engine's (tables.rs):
// its tree navigation over element children, and its create* / insert* / delete* steps and setters that change that
// tree; here the live rows and cells collections over it, and the changes it makes finished.

import { liveHTMLCollection } from './dom-collections.js';
import { CHANGE_STEPS, finishChanges } from './dom-nodes.js';

// The tree navigation the engine answers (tables.rs `tableParts`): a table's rows — its head sections' rows, then its
// own `tr` children and its bodies' rows in tree order, then its foot sections' — a section's rows, a row's cells, a
// table's bodies, its first caption / thead / tfoot child. Each an HTML element: an SVG `<tr>` is no table part.
const ROWS = 0, SECTION_ROWS = 1, CELLS = 2, TBODIES = 3, CAPTION = 4, THEAD = 5, TFOOT = 6;
const parts = (node, part) => globalThis.__dom.tableParts(node._nid, part);
const part = (node, which) => parts(node, which)[0] ?? null;
const tableRows = (table) => parts(table, ROWS);
const sectionRows = (section) => parts(section, SECTION_ROWS);
const rowCells = (row) => parts(row, CELLS);
const tBodies = (table) => parts(table, TBODIES);
// …and where a row or a cell sits (tables.rs `tableIndex`): among its table's rows, its parent's rows, its row's cells.
const ROW_INDEX = 0, SECTION_ROW_INDEX = 1, CELL_INDEX = 2;
const indexOf = (node, which) => globalThis.__dom.tableIndex(node._nid, which);

const indexSizeError = (method, iface) =>
  new globalThis.DOMException(`Failed to execute '${method}' on '${iface}': The index provided is out of range.`, 'IndexSizeError');
// What a create* / insert* / delete* step or a setter's removal changed (tables.rs `tableInsert`, `tableRemove`,
// `tableReplace`) finished, and the element it answers — or, an index out of range, an IndexSizeError; null where the
// engine changed nothing (a node factory's exception is what the call throws).
const INDEX_OUT_OF_RANGE = 1;
function changed(made, method, iface) {
  if (made === INDEX_OUT_OF_RANGE) throw indexSizeError(method, iface);
  if (made === undefined) return null;
  finishChanges(made, 1);
  return made[0];
}
const insert = (node, which, index, method, iface) => changed(globalThis.__dom.tableInsert(node._nid, which, index, CHANGE_STEPS), method, iface);
const remove = (node, which, index, method, iface) => { changed(globalThis.__dom.tableRemove(node._nid, which, index, CHANGE_STEPS), method, iface); };
// (…a setter: the part there removed, then `value` pre-inserted where that part goes — adopted, and refused where it holds
// the table — as any insertion is)
function replace(table, which, value) {
  const made = globalThis.__dom.tableReplace(table._nid, which, CHANGE_STEPS);
  if (made === undefined) return;
  const before = changed(made);
  if (value !== null) table._insertBefore(value, before);
}
const notOf = (tag, property) =>
  new globalThis.DOMException(`Failed to set the '${property}' property on 'HTMLTableElement': Not a ${tag} element.`, 'HierarchyRequestError');

export const htmlTableElementMembers = {
  get_caption: (table) => part(table, CAPTION),
  set_caption: (table, value) => replace(table, CAPTION, value),
  createCaption: (table) => insert(table, CAPTION, -1),
  deleteCaption: (table) => remove(table, CAPTION, -1),
  get_tHead: (table) => part(table, THEAD),
  set_tHead(table, value) {
    if (value !== null && value._localName !== 'thead') throw notOf('thead', 'tHead');
    replace(table, THEAD, value);
  },
  createTHead: (table) => insert(table, THEAD, -1),
  deleteTHead: (table) => remove(table, THEAD, -1),
  get_tFoot: (table) => part(table, TFOOT),
  set_tFoot(table, value) {
    if (value !== null && value._localName !== 'tfoot') throw notOf('tfoot', 'tFoot');
    replace(table, TFOOT, value);
  },
  createTFoot: (table) => insert(table, TFOOT, -1),
  deleteTFoot: (table) => remove(table, TFOOT, -1),
  get_tBodies: (table) => table._tBodiesColl || (table._tBodiesColl = liveHTMLCollection(() => tBodies(table))),
  createTBody: (table) => insert(table, TBODIES, -1),
  get_rows: (table) => table._rowsColl || (table._rowsColl = liveHTMLCollection(() => tableRows(table))),
  insertRow: (table, index) => insert(table, ROWS, index, 'insertRow', 'HTMLTableElement'),
  deleteRow: (table, index) => remove(table, ROWS, index, 'deleteRow', 'HTMLTableElement')
};

export const htmlTableSectionElementMembers = {
  get_rows: (section) => section._rowsColl || (section._rowsColl = liveHTMLCollection(() => sectionRows(section))),
  insertRow: (section, index) => insert(section, SECTION_ROWS, index, 'insertRow', 'HTMLTableSectionElement'),
  deleteRow: (section, index) => remove(section, SECTION_ROWS, index, 'deleteRow', 'HTMLTableSectionElement')
};

export const htmlTableRowElementMembers = {
  get_cells: (row) => row._cellsColl || (row._cellsColl = liveHTMLCollection(() => rowCells(row))),
  get_rowIndex: (row) => indexOf(row, ROW_INDEX),
  get_sectionRowIndex: (row) => indexOf(row, SECTION_ROW_INDEX),
  insertCell: (row, index) => insert(row, CELLS, index, 'insertCell', 'HTMLTableRowElement'),
  deleteCell: (row, index) => remove(row, CELLS, index, 'deleteCell', 'HTMLTableRowElement')
};

export const htmlTableCellElementMembers = {
  // (…its place among its row's cells, or −1 where its parent is no row)
  get_cellIndex: (cell) => indexOf(cell, CELL_INDEX)
};
