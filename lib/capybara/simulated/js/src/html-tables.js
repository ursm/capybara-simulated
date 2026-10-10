// The tabular data interfaces' members (HTML §4.9) that reflect no content attribute — the generated bindings take
// those (gen_bindings.mjs) — as the implementations dom-class-aliases.js installs them with: HTMLTableElement's,
// HTMLTableSectionElement's, HTMLTableRowElement's and HTMLTableCellElement's. The table API is tree navigation over
// element children, which the engine answers (tables.rs); here the live rows and cells collections over it, and the
// create* / insert* / delete* methods that change that tree, a new element made as the parser would make it.

import { liveHTMLCollection } from './dom-collections.js';

// The tree navigation the engine answers (tables.rs `tableParts`): a table's rows — its head sections' rows, then its
// own `tr` children and its bodies' rows in tree order, then its foot sections' — a section's rows, a row's cells, a
// table's bodies, its first caption / thead / tfoot child, and its first child neither a caption nor a colgroup (what
// a caption or a thead goes before). Each an HTML element: an SVG `<tr>` is no table part.
const ROWS = 0, SECTION_ROWS = 1, CELLS = 2, TBODIES = 3, CAPTION = 4, THEAD = 5, TFOOT = 6, FIRST_NON_HEADER = 7;
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
// The deleteRow / deleteCell steps: −1 removes the last item (none where there is none); an index out of range is an
// IndexSizeError.
function deleteFrom(items, index, method, iface) {
  if (index < -1 || index >= items.length) throw indexSizeError(method, iface);
  if (index === -1) { if (items.length) items[items.length - 1].remove(); }
  else items[index].remove();
}
// (…a table's own child of `which` replaced by `value`, or removed for null, `value` inserted before `before`)
function replaceChildOfTag(table, which, value, before) {
  const existing = part(table, which);
  if (existing) existing.remove();
  if (value !== null) table._insertBefore(value, before(table));
}
function createChildOfTag(table, which, tag, before) {
  const existing = part(table, which);
  if (existing) return existing;
  const child = table.ownerDocument.createElement(tag);
  table._insertBefore(child, before(table));
  return child;
}
function deleteChildOfTag(table, which) {
  const child = part(table, which);
  if (child) child.remove();
}
const atStart = (table) => table._children[0] ?? null;
const atEnd = () => null;
const firstNonHeaderChild = (table) => part(table, FIRST_NON_HEADER);

export const htmlTableElementMembers = {
  get_caption: (table) => part(table, CAPTION),
  set_caption: (table, value) => replaceChildOfTag(table, CAPTION, value, atStart),
  createCaption: (table) => createChildOfTag(table, CAPTION, 'caption', atStart),
  deleteCaption: (table) => deleteChildOfTag(table, CAPTION),
  get_tHead: (table) => part(table, THEAD),
  set_tHead(table, value) {
    if (value !== null && value._localName !== 'thead') throw new globalThis.DOMException("Failed to set the 'tHead' property on 'HTMLTableElement': Not a thead element.", 'HierarchyRequestError');
    replaceChildOfTag(table, THEAD, value, firstNonHeaderChild);
  },
  createTHead: (table) => createChildOfTag(table, THEAD, 'thead', firstNonHeaderChild),
  deleteTHead: (table) => deleteChildOfTag(table, THEAD),
  get_tFoot: (table) => part(table, TFOOT),
  set_tFoot(table, value) {
    if (value !== null && value._localName !== 'tfoot') throw new globalThis.DOMException("Failed to set the 'tFoot' property on 'HTMLTableElement': Not a tfoot element.", 'HierarchyRequestError');
    replaceChildOfTag(table, TFOOT, value, atEnd);
  },
  createTFoot: (table) => createChildOfTag(table, TFOOT, 'tfoot', atEnd),
  deleteTFoot: (table) => deleteChildOfTag(table, TFOOT),
  get_tBodies: (table) => table._tBodiesColl || (table._tBodiesColl = liveHTMLCollection(() => tBodies(table))),
  createTBody(table) {
    const tbody = table.ownerDocument.createElement('tbody');
    const bodies = tBodies(table);
    const last = bodies[bodies.length - 1];
    table._insertBefore(tbody, last ? last.nextSibling : null);
    return tbody;
  },
  get_rows: (table) => table._rowsColl || (table._rowsColl = liveHTMLCollection(() => tableRows(table))),
  // (…the table with no rows yet grows a tbody for one, its last if it has bodies)
  insertRow(table, index) {
    const rows = tableRows(table);
    if (index < -1 || index > rows.length) throw indexSizeError('insertRow', 'HTMLTableElement');
    const row = table.ownerDocument.createElement('tr');
    if (rows.length === 0) {
      let tbody = tBodies(table).pop();
      if (!tbody) { tbody = table.ownerDocument.createElement('tbody'); table._appendChild(tbody); }
      tbody._appendChild(row);
    } else if (index === -1 || index === rows.length) {
      const last = rows[rows.length - 1];
      last.parentNode._insertBefore(row, last.nextSibling);
    } else {
      rows[index].parentNode._insertBefore(row, rows[index]);
    }
    return row;
  },
  deleteRow: (table, index) => deleteFrom(tableRows(table), index, 'deleteRow', 'HTMLTableElement')
};

export const htmlTableSectionElementMembers = {
  get_rows: (section) => section._rowsColl || (section._rowsColl = liveHTMLCollection(() => sectionRows(section))),
  insertRow(section, index) {
    const rows = sectionRows(section);
    if (index < -1 || index > rows.length) throw indexSizeError('insertRow', 'HTMLTableSectionElement');
    const row = section.ownerDocument.createElement('tr');
    section._insertBefore(row, (index === -1 || index === rows.length) ? null : rows[index]);
    return row;
  },
  deleteRow: (section, index) => deleteFrom(sectionRows(section), index, 'deleteRow', 'HTMLTableSectionElement')
};

export const htmlTableRowElementMembers = {
  get_cells: (row) => row._cellsColl || (row._cellsColl = liveHTMLCollection(() => rowCells(row))),
  get_rowIndex: (row) => indexOf(row, ROW_INDEX),
  get_sectionRowIndex: (row) => indexOf(row, SECTION_ROW_INDEX),
  insertCell(row, index) {
    const cells = rowCells(row);
    if (index < -1 || index > cells.length) throw indexSizeError('insertCell', 'HTMLTableRowElement');
    const cell = row.ownerDocument.createElement('td');
    row._insertBefore(cell, (index === -1 || index === cells.length) ? null : cells[index]);
    return cell;
  },
  deleteCell: (row, index) => deleteFrom(rowCells(row), index, 'deleteCell', 'HTMLTableRowElement')
};

export const htmlTableCellElementMembers = {
  // (…its place among its row's cells, or −1 where its parent is no row)
  get_cellIndex: (cell) => indexOf(cell, CELL_INDEX)
};
