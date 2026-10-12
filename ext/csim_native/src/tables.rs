// The tabular data interfaces' tree navigation (HTML §4.9): a table's caption, head, foot and bodies — its HTML children
// of those names — its rows and a row's cells, and where a row or a cell sits among them; and their create* / insert* /
// delete* steps and their caption / tHead / tFoot setters, which change that tree (`tableInsert`, `tableRemove`,
// `tableReplace`). Their live collections are html-tables.js's.

use crate::dom::{nodes_value, nid_arg, realm, realm_id, register, NodeData, NodeId, NodeKind, RealmArena};
use crate::mutation::Change;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "tableParts", table_parts, context_id);
    register(scope, ns, "tableIndex", table_index, context_id);
    register(scope, ns, "tableInsert", table_insert, context_id);
    register(scope, ns, "tableRemove", table_remove, context_id);
    register(scope, ns, "tableReplace", table_replace, context_id);
}

// (…an HTML element of the local name `tag` — an SVG `<tr>` is no table part)
fn is(n: &NodeData, tag: &str) -> bool {
    n.kind == NodeKind::Element && n.is_html_named(tag)
}
fn is_section(n: &NodeData) -> bool {
    n.kind == NodeKind::Element && n.is_html() && matches!(&*n.local_name, "thead" | "tbody" | "tfoot")
}

impl RealmArena {
    // `node`'s HTML children of `tag`, in tree order.
    fn children_named(&self, node: NodeId, tag: &str) -> Vec<NodeId> {
        self.get(node).map_or_else(Vec::new, |n| {
            n.children.iter().copied().filter(|&c| self.get(c).is_some_and(|c| is(c, tag))).collect()
        })
    }
    // A table's rows: its head sections' rows in tree order, then its own `tr` children and its bodies' rows interleaved
    // in tree order, then its foot sections' rows (a `tr` child of a table is legal through the DOM API, though the
    // parser wraps one in a tbody).
    pub(crate) fn table_rows(&self, table: NodeId) -> Vec<NodeId> {
        let (mut head, mut body, mut foot) = (Vec::new(), Vec::new(), Vec::new());
        for &c in self.get(table).map_or(&[][..], |n| &n.children) {
            let Some(n) = self.get(c).filter(|n| n.kind == NodeKind::Element && n.is_html()) else { continue };
            match &*n.local_name {
                "thead" => head.extend(self.children_named(c, "tr")),
                "tfoot" => foot.extend(self.children_named(c, "tr")),
                "tbody" => body.extend(self.children_named(c, "tr")),
                "tr" => body.push(c),
                _ => {}
            }
        }
        head.extend(body);
        head.extend(foot);
        head
    }
    // A row's cells: its HTML `td` and `th` children.
    pub(crate) fn row_cells(&self, row: NodeId) -> Vec<NodeId> {
        self.get(row).map_or_else(Vec::new, |n| {
            n.children.iter().copied().filter(|&c| self.get(c).is_some_and(|c| is(c, "td") || is(c, "th"))).collect()
        })
    }
    // What a caption or a thead goes before: a table's first child element that is neither a caption nor a colgroup.
    fn first_non_header_child(&self, table: NodeId) -> Option<NodeId> {
        self.get(table)?.children.iter().copied().find(|&c| {
            self.get(c).is_some_and(|n| n.kind == NodeKind::Element && !is(n, "caption") && !is(n, "colgroup"))
        })
    }
    // The table a row belongs to: its parent, or its section's.
    fn owning_table(&self, row: NodeId) -> Option<NodeId> {
        let parent = self.parent_of(row)?;
        let p = self.get(parent)?;
        if is(p, "table") {
            return Some(parent);
        }
        let grand = self.parent_of(parent).filter(|_| is_section(p))?;
        self.get(grand).is_some_and(|g| is(g, "table")).then_some(grand)
    }
    // A row's `rowIndex` (among its table's rows), `sectionRowIndex` (among its parent's — a section's, or a table's
    // own), a cell's `cellIndex` (among its row's cells): −1 where it is in none.
    fn index_among(list: Vec<NodeId>, id: NodeId) -> i32 {
        list.iter().position(|&x| x == id).map_or(-1, |i| i as i32)
    }
    pub(crate) fn row_index(&self, row: NodeId) -> i32 {
        self.owning_table(row).map_or(-1, |t| Self::index_among(self.table_rows(t), row))
    }
    pub(crate) fn section_row_index(&self, row: NodeId) -> i32 {
        let Some(parent) = self.parent_of(row) else { return -1 };
        match self.get(parent) {
            Some(p) if is_section(p) => Self::index_among(self.children_named(parent, "tr"), row),
            Some(p) if is(p, "table") => Self::index_among(self.table_rows(parent), row),
            _ => -1,
        }
    }
    pub(crate) fn cell_index(&self, cell: NodeId) -> i32 {
        let Some(parent) = self.parent_of(cell).filter(|&p| self.get(p).is_some_and(|p| is(p, "tr"))) else { return -1 };
        Self::index_among(self.row_cells(parent), cell)
    }
}

// The parts `__dom.tableParts` names, by number.
const ROWS: u32 = 0;
const SECTION_ROWS: u32 = 1;
const CELLS: u32 = 2;
const TBODIES: u32 = 3;
const CAPTION: u32 = 4;
const THEAD: u32 = 5;
const TFOOT: u32 = 6;

// __dom.tableParts(nid, part) -> a table's rows (0), a section's rows (1), a row's cells (2), a table's bodies (3), its
// first caption (4), thead (5) or tfoot (6) child — in tree order, as `nodes_value` answers them.
fn table_parts(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let part = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let arena = realm(scope, cid);
    let first = |tag| arena.children_named(id, tag).into_iter().take(1).collect();
    let parts: Vec<NodeId> = match part {
        ROWS => arena.table_rows(id),
        SECTION_ROWS => arena.children_named(id, "tr"),
        CELLS => arena.row_cells(id),
        TBODIES => arena.children_named(id, "tbody"),
        CAPTION => first("caption"),
        THEAD => first("thead"),
        TFOOT => first("tfoot"),
        _ => Vec::new(),
    };
    rv.set(nodes_value(scope, cid, &parts));
}

// __dom.tableIndex(nid, which) -> a row's rowIndex (0) or sectionRowIndex (1), a cell's cellIndex (2).
fn table_index(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_int32(-1) };
    let which = args.get(1).uint32_value(scope);
    let arena = realm(scope, cid);
    rv.set_int32(match which {
        Some(0) => arena.row_index(id),
        Some(1) => arena.section_row_index(id),
        Some(2) => arena.cell_index(id),
        _ => -1,
    });
}

// Why an insertion or a deletion refuses: the index is out of range (an IndexSizeError).
const INDEX_OUT_OF_RANGE: u32 = 1;

// The place `part` (a `tableParts` number) goes in `table` — a caption first, a head before the first child neither a
// caption nor a colgroup, a foot last — and the table's first child of it.
fn header_place(arena: &RealmArena, table: NodeId, part: u32) -> (Option<NodeId>, Option<NodeId>) {
    let (tag, before) = match part {
        CAPTION => ("caption", arena.get(table).and_then(|n| n.children.first().copied())),
        THEAD => ("thead", arena.first_non_header_child(table)),
        _ => ("tfoot", None),
    };
    (arena.children_named(table, tag).into_iter().next(), before)
}
// The answer of an op that changed the tree: the element it made or none (null), and the changes of children it made
// (mutation.rs `changes_value`).
fn answer<'s>(scope: &mut v8::PinScope<'s, '_>, cid: i32, made: Option<NodeId>, changes: &[Change]) -> Option<v8::Local<'s, v8::Value>> {
    let mut out = vec![crate::dom::node_value(scope, made)];
    if crate::dom::factory_threw(scope) {
        return None;
    }
    out.extend(crate::mutation::changes_value(scope, cid, changes));
    if crate::dom::factory_threw(scope) {
        return None;
    }
    Some(v8::Array::new_with_elements(scope, &out).into())
}

// __dom.tableInsert(nid, part, index, steps) -> [element, changes…], or `INDEX_OUT_OF_RANGE`: the element a table's
// createCaption / createTHead / createTFoot answers — its first of that name, or a new one where it goes — its
// createTBody's (a new body after its last), its insertRow's (a new row at `index` among its rows, −1 the end: after the
// last, or — none yet — in its last body, a new one where it has none), a section's insertRow's, a row's insertCell's;
// each new element an HTML one of its node document, made by the calling realm's code.
fn table_insert(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let part = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let index = args.get(2).int32_value(scope).unwrap_or(-1);
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(3)) else { return };
    let caller = realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(id).map(|n| n.realm) else { return };
    let arena = realm(scope, cid);
    // (…its name, and where it goes: the parent and the child it goes before — none for a table with no rows yet, whose
    // last body it goes in; or the one already there)
    let (tag, place) = match part {
        CAPTION | THEAD | TFOOT => {
            let (existing, before) = header_place(arena, id, part);
            if existing.is_some() {
                if let Some(out) = answer(scope, cid, existing, &[]) {
                    rv.set(out);
                }
                return;
            }
            (["caption", "thead", "tfoot"][(part - CAPTION) as usize], Some((id, before)))
        }
        TBODIES => ("tbody", Some((id, arena.children_named(id, "tbody").last().and_then(|&b| arena.sibling(b, 1))))),
        ROWS | SECTION_ROWS | CELLS => {
            let items = match part {
                ROWS => arena.table_rows(id),
                SECTION_ROWS => arena.children_named(id, "tr"),
                _ => arena.row_cells(id),
            };
            if index < -1 || index > items.len() as i32 {
                return rv.set_uint32(INDEX_OUT_OF_RANGE);
            }
            let at = usize::try_from(index).ok().and_then(|k| items.get(k).copied());
            let place = match (part, at, items.last()) {
                (ROWS, Some(at), _) => arena.parent_of(at).map(|p| (p, Some(at))),
                (ROWS, None, Some(&last)) => arena.parent_of(last).map(|p| (p, arena.sibling(last, 1))),
                (ROWS, None, None) => None,
                _ => Some((id, at)),
            };
            (if part == CELLS { "td" } else { "tr" }, place)
        }
        _ => return,
    };
    let (mut changes, mut held) = (Vec::new(), Vec::new());
    let (parent, before) = match place {
        Some(place) => place,
        None => match realm(scope, cid).children_named(id, "tbody").last() {
            Some(&body) => (body, None),
            None => {
                let (body, handle) = crate::editing::make_element(scope, cid, caller, id, "tbody");
                held.push(handle);
                let Some(change) = crate::mutation::insert(scope, cid, caller, id, &[body], None, steps) else { return };
                changes.push(change);
                (body, None)
            }
        },
    };
    let (made, handle) = crate::editing::make_element(scope, cid, caller, id, tag);
    held.push(handle);
    let Some(change) = crate::mutation::insert(scope, cid, caller, parent, &[made], before, steps) else { return };
    changes.push(change);
    if let Some(out) = answer(scope, cid, Some(made), &changes) {
        rv.set(out);
    }
    drop(held);
}

// __dom.tableRemove(nid, part, index, steps) -> [null, changes…], or `INDEX_OUT_OF_RANGE`: a table's deleteCaption /
// deleteTHead / deleteTFoot (its first of that name removed, where it has one), its deleteRow (the row at `index` among
// its rows, −1 the last, where there is one), a section's deleteRow, a row's deleteCell.
fn table_remove(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let part = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let index = args.get(2).int32_value(scope).unwrap_or(-1);
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(3)) else { return };
    let caller = realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(id).map(|n| n.realm) else { return };
    let arena = realm(scope, cid);
    let gone = match part {
        CAPTION | THEAD | TFOOT => header_place(arena, id, part).0,
        ROWS | SECTION_ROWS | CELLS => {
            let items = match part {
                ROWS => arena.table_rows(id),
                SECTION_ROWS => arena.children_named(id, "tr"),
                _ => arena.row_cells(id),
            };
            if index < -1 || index >= items.len() as i32 {
                return rv.set_uint32(INDEX_OUT_OF_RANGE);
            }
            if index == -1 { items.last().copied() } else { items.get(index as usize).copied() }
        }
        _ => return,
    };
    let mut changes = Vec::new();
    if let Some(gone) = gone {
        let Some(change) = crate::mutation::remove(scope, cid, caller, gone, steps) else { return };
        changes.push(change);
    }
    if let Some(out) = answer(scope, cid, None, &changes) {
        rv.set(out);
    }
}

// __dom.tableReplace(nid, part, value, steps) -> [null, changes…]: a table's caption / tHead / tFoot setter — its first
// child of that name removed, and `value` (an element, or null for none) put where that part goes.
fn table_replace(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let part = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let value = crate::node_handle::nid_of(scope, args.get(2));
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(3)) else { return };
    let caller = realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(id).map(|n| n.realm) else { return };
    if !matches!(part, CAPTION | THEAD | TFOOT) {
        return;
    }
    let mut changes = Vec::new();
    if let Some(existing) = header_place(realm(scope, cid), id, part).0 {
        let Some(change) = crate::mutation::remove(scope, cid, caller, existing, steps) else { return };
        changes.push(change);
    }
    if let Some(value) = value {
        // (…inserted before itself: before what follows it)
        let arena = realm(scope, cid);
        let before = header_place(arena, id, part).1.and_then(|b| if b == value { arena.sibling(value, 1) } else { Some(b) });
        let Some(change) = crate::mutation::insert(scope, cid, caller, id, &[value], before, steps) else { return };
        changes.push(change);
    }
    if let Some(out) = answer(scope, cid, None, &changes) {
        rv.set(out);
    }
}
