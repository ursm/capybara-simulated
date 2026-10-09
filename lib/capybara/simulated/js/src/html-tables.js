// The tabular data interfaces' members (HTML §4.9) that reflect no content attribute — the generated bindings take
// those (gen_bindings.mjs) — as the implementations dom-class-aliases.js installs them with: HTMLTableElement's,
// HTMLTableSectionElement's, HTMLTableRowElement's and HTMLTableCellElement's. The table API is tree navigation over
// element children: tBodies / tHead / caption are filtered children; the rows and cells collections, live, and the
// create* / insert* / delete* methods walk and change that tree, a new element made as the parser would make it.

import { HTML_NS, NODE_ELEMENT } from './constants.js';
import { liveHTMLCollection } from './dom-collections.js';

const TABLE_SECTION_TAGS = new Set(['thead', 'tbody', 'tfoot']);

// (…an HTML element, of the local name `tag` where one is given — an SVG `<tr>` is no table part)
const isHTML = (node, tag) => node != null && node._nodeType === NODE_ELEMENT && node._ns === HTML_NS && (tag === undefined || node._localName === tag);
const isSection = (node) => isHTML(node) && TABLE_SECTION_TAGS.has(node._localName);

function childrenByTag(node, tag) {
  const out = [];
  for (const c of node._children) if (isHTML(c, tag)) out.push(c);
  return out;
}
const firstChildByTag = (node, tag) => childrenByTag(node, tag)[0] || null;

// A table's rows: its header sections' rows (tree order), then its own `tr` children and its bodies' rows interleaved
// in tree order, then its footer sections' rows. A `tr` child of a table is legal through the DOM API, though the
// parser wraps one in a tbody.
function tableRows(table) {
  const head = [], body = [], foot = [];
  for (const c of table._children) {
    if (!isHTML(c)) continue;
    if (c._localName === 'thead')      head.push(...childrenByTag(c, 'tr'));
    else if (c._localName === 'tfoot') foot.push(...childrenByTag(c, 'tr'));
    else if (c._localName === 'tbody') body.push(...childrenByTag(c, 'tr'));
    else if (c._localName === 'tr') body.push(c);
  }
  return head.concat(body, foot);
}
const rowCells = (row) => row._children.filter((c) => isHTML(c) && (c._localName === 'td' || c._localName === 'th'));

const indexSizeError = (method, iface) =>
  new globalThis.DOMException(`Failed to execute '${method}' on '${iface}': The index provided is out of range.`, 'IndexSizeError');
// The deleteRow / deleteCell steps: −1 removes the last item (none where there is none); an index out of range is an
// IndexSizeError.
function deleteFrom(items, index, method, iface) {
  if (index < -1 || index >= items.length) throw indexSizeError(method, iface);
  if (index === -1) { if (items.length) items[items.length - 1].remove(); }
  else items[index].remove();
}
// (…what a caption or a thead goes before: the first child that is neither a caption nor a colgroup, or none)
function firstNonHeaderChild(table) {
  for (const c of table._children) if (c._nodeType === NODE_ELEMENT && !isHTML(c, 'caption') && !isHTML(c, 'colgroup')) return c;
  return null;
}
// (…a table's own child of `tag` replaced by `value`, or removed for null, `value` inserted before `before`)
function replaceChildOfTag(table, tag, value, before) {
  const existing = firstChildByTag(table, tag);
  if (existing) existing.remove();
  if (value !== null) table._insertBefore(value, before(table));
}
function createChildOfTag(table, tag, before) {
  const existing = firstChildByTag(table, tag);
  if (existing) return existing;
  const child = table.ownerDocument.createElement(tag);
  table._insertBefore(child, before(table));
  return child;
}
function deleteChildOfTag(table, tag) {
  const child = firstChildByTag(table, tag);
  if (child) child.remove();
}
const atStart = (table) => table._children[0] || null;
const atEnd = () => null;

export const htmlTableElementMembers = {
  get_caption: (table) => firstChildByTag(table, 'caption'),
  set_caption: (table, value) => replaceChildOfTag(table, 'caption', value, atStart),
  createCaption: (table) => createChildOfTag(table, 'caption', atStart),
  deleteCaption: (table) => deleteChildOfTag(table, 'caption'),
  get_tHead: (table) => firstChildByTag(table, 'thead'),
  set_tHead(table, value) {
    if (value !== null && value._localName !== 'thead') throw new globalThis.DOMException("Failed to set the 'tHead' property on 'HTMLTableElement': Not a thead element.", 'HierarchyRequestError');
    replaceChildOfTag(table, 'thead', value, firstNonHeaderChild);
  },
  createTHead: (table) => createChildOfTag(table, 'thead', firstNonHeaderChild),
  deleteTHead: (table) => deleteChildOfTag(table, 'thead'),
  get_tFoot: (table) => firstChildByTag(table, 'tfoot'),
  set_tFoot(table, value) {
    if (value !== null && value._localName !== 'tfoot') throw new globalThis.DOMException("Failed to set the 'tFoot' property on 'HTMLTableElement': Not a tfoot element.", 'HierarchyRequestError');
    replaceChildOfTag(table, 'tfoot', value, atEnd);
  },
  createTFoot: (table) => createChildOfTag(table, 'tfoot', atEnd),
  deleteTFoot: (table) => deleteChildOfTag(table, 'tfoot'),
  get_tBodies: (table) => table._tBodiesColl || (table._tBodiesColl = liveHTMLCollection(() => childrenByTag(table, 'tbody'))),
  createTBody(table) {
    const tbody = table.ownerDocument.createElement('tbody');
    const bodies = childrenByTag(table, 'tbody');
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
      let tbody = childrenByTag(table, 'tbody').pop();
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
  get_rows: (section) => section._rowsColl || (section._rowsColl = liveHTMLCollection(() => childrenByTag(section, 'tr'))),
  insertRow(section, index) {
    const rows = childrenByTag(section, 'tr');
    if (index < -1 || index > rows.length) throw indexSizeError('insertRow', 'HTMLTableSectionElement');
    const row = section.ownerDocument.createElement('tr');
    section._insertBefore(row, (index === -1 || index === rows.length) ? null : rows[index]);
    return row;
  },
  deleteRow: (section, index) => deleteFrom(childrenByTag(section, 'tr'), index, 'deleteRow', 'HTMLTableSectionElement')
};

// The table a row belongs to: its parent, or its section's parent.
function owningTable(row) {
  const p = row._parent;
  if (isHTML(p, 'table')) return p;
  return isSection(p) && isHTML(p._parent, 'table') ? p._parent : null;
}
export const htmlTableRowElementMembers = {
  get_cells: (row) => row._cellsColl || (row._cellsColl = liveHTMLCollection(() => rowCells(row))),
  // (…read off the table's `rows` and the section's, each a live collection kept per settle: a table's rows each
  // asked their index stays O(N) overall)
  get_rowIndex(row) {
    const table = owningTable(row);
    return table ? Array.prototype.indexOf.call(htmlTableElementMembers.get_rows(table), row) : -1;
  },
  // (…among its parent's rows: a section's, or — for a row that is a table's child — the table's)
  get_sectionRowIndex(row) {
    const p = row._parent;
    if (isSection(p)) return Array.prototype.indexOf.call(htmlTableSectionElementMembers.get_rows(p), row);
    return isHTML(p, 'table') ? Array.prototype.indexOf.call(htmlTableElementMembers.get_rows(p), row) : -1;
  },
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
  get_cellIndex(cell) {
    const p = cell._parent;
    return isHTML(p, 'tr') ? Array.prototype.indexOf.call(htmlTableRowElementMembers.get_cells(p), cell) : -1;
  }
};
