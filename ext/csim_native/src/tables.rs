// The tabular data interfaces' tree navigation (HTML §4.9): a table's caption, head, foot and bodies — its HTML children
// of those names — its rows and a row's cells, and where a row or a cell sits among them. Their live collections and
// their create* / insert* / delete* steps are html-tables.js's, which changes the tree with what these answer.

use crate::dom::{nodes_value, nid_arg, realm, realm_id, register, NodeData, NodeId, NodeKind, RealmArena};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "tableParts", table_parts, context_id);
    register(scope, ns, "tableIndex", table_index, context_id);
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
const FIRST_NON_HEADER: u32 = 7;

// __dom.tableParts(nid, part) -> a table's rows (0), a section's rows (1), a row's cells (2), a table's bodies (3), its
// first caption (4), thead (5) or tfoot (6) child, its first child neither a caption nor a colgroup (7) — in tree
// order, as `nodes_value` answers them.
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
        FIRST_NON_HEADER => arena.first_non_header_child(id).into_iter().collect(),
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
