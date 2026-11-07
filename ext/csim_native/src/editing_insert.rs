// Inserting in an editing host — what typing, Enter and Shift+Enter do, and execCommand's `insertText`,
// `insertLineBreak` and `insertParagraph` — the engine's: the selection's contents deleted first (editing_delete.rs
// `delete`), then at the caret text (`Edit::text`), a `<br>` (`Edit::line_break`), or the caret's block split in two
// (`Edit::paragraph`); the white space the insertion brings together rebalanced as the line shows it (editing.rs
// `rebalance_space`). Every change of children the engine's change; the bindings finish them as the op returns, run the
// cloning steps of the elements a split copied, and put the caret where it says. Every expectation is Chrome's.

use crate::cloning::BindingsSteps;
use crate::dom::{realm, NodeData, NodeId, NodeKind, RealmArena};
use crate::editing::{inline_level, selection_host, block_of, edge, has_content, line_edge, make, make_element, rebalance_space, within, Edge};
use crate::mutation::Change;
use crate::node_handle::NodeHandle;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "editInsert", edit_insert, context_id);
}

// What an insertion inserts (`editInsert`'s `kind`): text, a line break, a paragraph's break.
pub(crate) const TEXT: u32 = 0;
pub(crate) const LINE_BREAK: u32 = 1;
pub(crate) const PARAGRAPH: u32 = 2;
// …and pasted text: its white space all rebalanced as the line shows it (`a  b` is `a&nbsp; b`, Chrome and Firefox), where
// a script's or a keystroke's stands as it is.
pub(crate) const PASTED_TEXT: u32 = 3;

// __dom.editInsert(anchorNode, anchorOffset, focusNode, focusOffset, kind, text, steps) -> [caretNode, caretOffset,
// copies, (source, copy, names)…, changes…], or undefined where nothing is inserted: the insertion in the editing host
// the selection from the anchor to the focus edits (editing.rs `selection_host`: its anchor's, the focus kept to it and
// out of its non-editable islands) at the selection's range — its contents deleted first — of `text` (`TEXT`: its lines,
// a paragraph's break between them; nothing at all where it is empty), a line break
// (`LINE_BREAK`) or a paragraph's break (any other): the place the caret goes (null where a copy's shadow root threw:
// `takeCloneException`), how many elements a split copied and each
// with its source and the names of the attributes whose cloning steps are the bindings' (cloning.rs `bindings_value`),
// and the changes of children it made (mutation.rs `changes_value`).
fn edit_insert(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(sc), Some(ec)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 2)) else { return };
    let (so, eo) = (args.get(1).uint32_value(scope).unwrap_or(0), args.get(3).uint32_value(scope).unwrap_or(0));
    crate::cloning::begin_clone(scope);
    let kind = args.get(4).uint32_value(scope).unwrap_or(TEXT);
    let text = args.get(5).to_string(scope).map_or_else(Vec::new, |s| {
        let mut units = vec![0u16; s.length()];
        s.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
        units
    });
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(6)) else { return };
    let caller = crate::dom::realm_id(scope, &args);
    let steps = v8::Local::new(scope, steps);
    let ((sc, so), (ec, eo)) = if kind == TEXT && (sc, so) == (ec, eo) {
        let place = typing_place(&crate::dom::dom(scope).arena, (sc, so));
        (place, place)
    } else {
        ((sc, so), (ec, eo))
    };
    let Some(Inserted { cid, caret, changes, copies, held }) = insertion(scope, caller, steps, (sc, so), (ec, eo), kind, &text) else { return };
    let mut out: Vec<v8::Local<'_, v8::Value>> = vec![crate::dom::node_value(scope, caret.map(|(node, _)| node))];
    if crate::dom::factory_threw(scope) {
        return;
    }
    out.push(v8::Integer::new_from_unsigned(scope, caret.map_or(0, |(_, offset)| offset)).into());
    out.push(v8::Integer::new_from_unsigned(scope, copies.len() as u32).into());
    out.extend(crate::cloning::bindings_value(scope, cid, &copies));
    if crate::dom::factory_threw(scope) {
        return;
    }
    out.extend(crate::mutation::changes_value(scope, cid, &changes));
    if crate::dom::factory_threw(scope) {
        return;
    }
    drop(held);
    rv.set(v8::Array::new_with_elements(scope, &out).into());
}

// What an insertion made: the host's realm, where the caret goes (none where a copy's shadow root threw, what it changed
// answered all the same for the bindings to finish before they throw it: `takeCloneException`), the changes of children,
// the elements a split copied, and what holds the nodes it made.
pub(crate) struct Inserted {
    pub(crate) cid: i32,
    pub(crate) caret: Option<(NodeId, u32)>,
    pub(crate) changes: Vec<Change>,
    pub(crate) copies: BindingsSteps,
    pub(crate) held: Vec<v8::cppgc::Persistent<NodeHandle>>,
}
// The insertion `editInsert` answers, by realm `caller`'s code: none where nothing is inserted.
pub(crate) fn insertion<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    caller: i32,
    steps: v8::Local<'s, v8::Array>,
    anchor: (NodeId, u32),
    focus: (NodeId, u32),
    kind: u32,
    text: &[u16],
) -> Option<Inserted> {
    if matches!(kind, TEXT | PASTED_TEXT) && text.is_empty() {
        return None;
    }
    let (host, ((sc, so), (ec, eo))) = selection_host(&crate::dom::dom(scope).arena, anchor, focus)?;
    let collapsed = (sc, so) == (ec, eo);
    let cid = crate::dom::dom(scope).arena.get(host).map(|n| n.realm)?;
    let (mut changes, mut copies, mut held) = (Vec::new(), Vec::new(), Vec::new());
    let mut edit = Edit { cid, caller, steps, host, changes: &mut changes, copies: &mut copies, held: &mut held };
    let mut caret = (sc, so);
    if !collapsed {
        let took = crate::editing_delete::Took::Step;
        // (…none deleted — a range a non-editable island's edge left empty — and the insertion at its start)
        if let Some((at, made)) = crate::editing_delete::delete(scope, caller, steps, host, ((sc, so), (ec, eo)), took, false, false)? {
            caret = at;
            edit.changes.extend(made);
        }
    }
    let caret = match kind {
        TEXT => edit.lines(scope, caret, text, false),
        PASTED_TEXT => edit.lines(scope, caret, text, true),
        LINE_BREAK => edit.line_break(scope, caret),
        _ => edit.paragraph(scope, caret),
    };
    if caret.is_none() && crate::dom::dom(scope).clone_exception.is_none() {
        return None;
    }
    Some(Inserted { cid, caret, changes, copies, held })
}

// Where what is inserted at a place goes: outside a link the place is at the edge of (`<a>link</a>`, typed at its end,
// is `<a>link</a>x`); at the end of the text before it, or the start of the text after it, where there is one; and
// before a `<br>` that ends its block's last line — no line follows it — rather than after it (`ab<br>`, typed at its
// end, is `abx<br>`).
fn insertion_point(arena: &RealmArena, place: (NodeId, u32)) -> (NodeId, u32) {
    let (node, offset) = out_of_link(arena, place).unwrap_or(place);
    let Some(n) = arena.get(node).filter(|n| n.kind == NodeKind::Element) else { return (node, offset) };
    let mut k = (offset as usize).min(n.children.len());
    let br = |c: NodeId| arena.get(c).is_some_and(|d| d.is_html_named("br"));
    if k.checked_sub(1).and_then(|i| n.children.get(i).copied()).is_some_and(|b| br(b) && line_edge(arena, b, true) == Edge::Block) {
        k -= 1;
    }
    let text = |c: Option<NodeId>| c.filter(|&c| arena.get(c).is_some_and(|d| d.kind == NodeKind::Text));
    let before = k.checked_sub(1).and_then(|i| n.children.get(i).copied());
    if let Some(t) = text(before) {
        return (t, arena.get(t).map_or(0, |d| d.data.len() as u32));
    }
    if let Some(t) = text(n.children.get(k).copied()) {
        return (t, 0);
    }
    (node, k as u32)
}
// Where a user's typing at the caret `place` goes: into the end of what is before it —
// `<b>x</b>`, typed after, is `<b>xT</b>`, and `<p>x</p>` `<p>xT</p>`, Chrome and Firefox — where a script's `insertText` at
// that point, whose place the Editing draft says, stays (editing/run/inserttext).
fn typing_place(arena: &RealmArena, place: (NodeId, u32)) -> (NodeId, u32) {
    let Some(n) = arena.get(place.0).filter(|n| n.kind == NodeKind::Element) else { return place };
    let before = &n.children[..(place.1 as usize).min(n.children.len())];
    shown_end(arena, before).unwrap_or(place)
}
// The end of what typing after `nodes` goes into: their last that shows anything, past what shows nothing (a style, a script,
// a `display: none`, `visibility: hidden` or `hidden` element, an empty one, a comment: `<b>x</b><style>…</style>`, typed after, is `<b>xT</b>`,
// Chrome; a `<br>` is a line's end, no nothing) — none where that one holds no caret at its end.
pub(crate) fn shown_end(arena: &RealmArena, nodes: &[NodeId]) -> Option<(NodeId, u32)> {
    let last = nodes.iter().rev().copied().find(|&c| !shows_nothing(arena, c))?;
    typing_end(arena, last)
}
fn shows_nothing(arena: &RealmArena, id: NodeId) -> bool {
    let Some(d) = arena.get(id) else { return true };
    match d.kind {
        NodeKind::Comment | NodeKind::ProcessingInstruction => true,
        NodeKind::Text => d.data.is_empty(),
        NodeKind::Element => {
            ["script", "style", "template", "title", "meta", "link", "base", "noscript"].iter().any(|t| (*d.local_name).eq_ignore_ascii_case(t))
                || (crate::geometry::box_style(arena, id).is_some() && !crate::rendered::has_own_box(arena, id))
                || d.plain_attr("hidden").is_some_and(|v| !v.eq_ignore_ascii_case("until-found"))
                || crate::rendered::hides_by_visibility(arena, id, false)
                || (!d.is_html_named("br") && !crate::editing::has_content(arena, id))
        }
        _ => false,
    }
}
// Whether `id` can hold a caret typed text goes in at its end — an element of the host's that shows inline or block
// content of its own: editable (no island), rendered (no `display: none`), not raw text (a script, a style, a textarea's or a
// title's text is no line), not replaced or void (a `<br>`, an image, a control, a frame), not a table or one of its parts,
// whose content no caret after it reaches, not a link, whose edge `out_of_link` keeps a caret out of, not a template. The
// Editing draft's own rules have it so in part: "editable", and its "visible" (no `display: none`, none of a collapsed
// whitespace's or line break's) for what the caret may be beside.
const NO_CARET_INSIDE: [&str; 26] = [
    "script", "style", "xmp", "textarea", "title", "noscript", "noframes", "noembed", "iframe", "plaintext", "template", "select",
    "option", "optgroup", "datalist", "button", "img", "input", "video", "audio", "canvas", "object", "embed", "svg", "math", "a",
];
fn holds_caret(arena: &RealmArena, id: NodeId) -> bool {
    let Some(d) = arena.get(id).filter(|d| d.kind == NodeKind::Element) else { return false };
    !crate::caret::CARET_VOID_TAGS.contains(&&*d.local_name)
        && !NO_CARET_INSIDE.iter().any(|t| (*d.local_name).eq_ignore_ascii_case(t))
        && !crate::editing::table_part(arena, id)
        && arena.editing_host(id).is_some()
        && !crate::rendered::is_atomic_inline(arena, id)
        && (crate::geometry::box_style(arena, id).is_none() || crate::rendered::has_own_box(arena, id))
}
// The end of the last text that shows down the end of `id` — through what holds a caret, each one's last child — where
// there is one: none where that ends in anything else (`<b>x<br></b>`, an empty `<b>`, a `<b>` ending in a non-editable
// island), whose end the caret stays outside of (Chrome, Firefox).
pub(crate) fn typing_end(arena: &RealmArena, id: NodeId) -> Option<(NodeId, u32)> {
    let mut at = id;
    loop {
        let n = arena.get(at)?;
        if n.kind == NodeKind::Text {
            let shows = arena.parent_of(at).is_some_and(|p| p == id && at == id || holds_caret(arena, p));
            return (shows && !n.data.is_empty()).then_some((at, n.data.len() as u32));
        }
        // (…a `<br>` ending its block's line: before it, as `insertion_point` takes a place there: `<b>a<br></b>`, typed
        // after, is `<b>aT<br></b>`, Chrome)
        if n.is_html_named("br") && at != id && line_edge(arena, at, true) == Edge::Block {
            return Some((arena.parent_of(at)?, arena.child_index(at) as u32));
        }
        if !holds_caret(arena, at) {
            return None;
        }
        let kids = &n.children;
        at = *kids.iter().rev().find(|&&c| !shows_nothing(arena, c))?;
    }
}
// The place outside the link `(node, offset)` is at the start or the end of — the inline elements between ending or
// starting there too — before the link or after it; none where it is at no link's edge.
fn out_of_link(arena: &RealmArena, (node, offset): (NodeId, u32)) -> Option<(NodeId, u32)> {
    let n = arena.get(node)?;
    let length = if n.kind == NodeKind::Text { n.data.len() } else { n.children.len() };
    let end = offset as usize == length;
    if !end && offset != 0 {
        return None;
    }
    let mut at = node;
    loop {
        let parent = arena.parent_of(at).filter(|&p| arena.editing_host(at) != Some(at) && arena.is_element(p))?;
        if arena.get(at).is_some_and(|d| d.is_html_named("a")) {
            let k = arena.child_index(at) as u32;
            return Some((parent, if end { k + 1 } else { k }));
        }
        let edge_child = arena.get(parent).and_then(|p| if end { p.children.last() } else { p.children.first() }.copied());
        if edge_child != Some(at) || inline_level(arena, parent) != Some(true) {
            return None;
        }
        at = parent;
    }
}
// Whether `id` is a `<br>` holding an empty line open — nothing on its line before it, the block's end after it — which
// the line's first text takes the place of (`<p><b><br></b></p>`, typed into, is `<p><b>x</b></p>`; `abcd<br><br>`,
// typed into its last line, `abcd<br>x`).
fn placeholder(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| n.is_html_named("br")) && line_edge(arena, id, true) == Edge::Block && line_edge(arena, id, false) != Edge::Content
}
// Whether an element is a heading, whose split leaves a `<div>` after it where nothing follows the caret.
fn heading(arena: &RealmArena, id: NodeId) -> bool {
    arena.get(id).is_some_and(|n| ["h1", "h2", "h3", "h4", "h5", "h6"].iter().any(|t| n.is_html_named(t)))
}

// One edit's state — an insertion's, or an editing command's (editing_commands.rs): the host's realm, the realm whose code
// edits, the bindings' steps of a change of children, and the host; the changes of children it makes, the elements it
// copies, and what holds the nodes it makes until a tree does.
pub(crate) struct Edit<'s, 'a> {
    pub(crate) cid: i32,
    pub(crate) caller: i32,
    pub(crate) steps: v8::Local<'s, v8::Array>,
    pub(crate) host: NodeId,
    pub(crate) changes: &'a mut Vec<Change>,
    pub(crate) copies: &'a mut BindingsSteps,
    pub(crate) held: &'a mut Vec<v8::cppgc::Persistent<NodeHandle>>,
}

impl<'s> Edit<'s, '_> {
    pub(crate) fn insert(&mut self, scope: &mut v8::PinScope<'_, '_>, parent: NodeId, nodes: &[NodeId], before: Option<NodeId>) -> Option<()> {
        self.changes.push(crate::mutation::insert(scope, self.cid, self.caller, parent, nodes, before, self.steps)?);
        Some(())
    }
    pub(crate) fn remove(&mut self, scope: &mut v8::PinScope<'_, '_>, node: NodeId) -> Option<()> {
        self.changes.push(crate::mutation::remove(scope, self.cid, self.caller, node, self.steps)?);
        Some(())
    }
    // …`old` replaced by `new`, a node in no tree…
    pub(crate) fn replace(&mut self, scope: &mut v8::PinScope<'_, '_>, old: NodeId, new: NodeId) -> Option<()> {
        self.changes.push(crate::mutation::replace(scope, self.cid, self.caller, old, &[new], self.steps)?);
        Some(())
    }
    // `nodes` out of where they are, into `parent` at its end — or before `before`.
    pub(crate) fn move_into(&mut self, scope: &mut v8::PinScope<'_, '_>, parent: NodeId, nodes: &[NodeId]) -> Option<()> {
        self.move_before(scope, parent, nodes, None)
    }
    pub(crate) fn move_before(&mut self, scope: &mut v8::PinScope<'_, '_>, parent: NodeId, nodes: &[NodeId], before: Option<NodeId>) -> Option<()> {
        for &n in nodes {
            if realm(scope, self.cid).parent_of(n).is_some() {
                self.remove(scope, n)?;
            }
        }
        if !nodes.is_empty() {
            self.insert(scope, parent, nodes, before)?;
        }
        Some(())
    }
    pub(crate) fn element(&mut self, scope: &mut v8::PinScope<'_, '_>, near: NodeId, name: &str) -> NodeId {
        let (id, held) = make_element(scope, self.cid, self.caller, near, name);
        self.held.push(held);
        id
    }
    // A copy of `src` alone — attributes, `id` too (Chrome) — its cloning steps the bindings' to run where it has them.
    fn copy(&mut self, scope: &mut v8::PinScope<'_, '_>, src: NodeId) -> Option<NodeId> {
        let doc = crate::editing::document_of(scope, src);
        crate::cloning::clone_into(scope, self.cid, self.caller, src, None, false, doc, self.held, self.copies)
    }

    // A fragment's children `kids` at the caret, and `descendants` all they hold (the Editing draft's insertHTML; a paste's
    // markup): a `<br>` holding the line open that they take the place of removed first, a text split at the caret, a block
    // left holding nothing visible held open, and each of `descendants` where it may be (`fix_disallowed_ancestors`). The
    // place after the last of them, none where a change failed.
    pub(crate) fn fragment(&mut self, scope: &mut v8::PinScope<'_, '_>, caret: (NodeId, u32), kids: &[NodeId], descendants: &[NodeId]) -> Option<(NodeId, u32)> {
        let mut last = *kids.last()?;
        let arena = realm(scope, self.cid);
        if inline_level(arena, caret.0) == Some(false) {
            let held = arena.get(caret.0).and_then(|n| n.children.get(caret.1 as usize).copied()).filter(|&c| placeholder(arena, c));
            if let Some(br) = held {
                self.remove(scope, br)?;
            }
        }
        let (parent, before) = self.split_at(scope, caret)?;
        self.move_before(scope, parent, kids, before)?;
        let arena = realm(scope, self.cid);
        if inline_level(arena, parent) == Some(false) && !has_content(arena, parent) {
            let br = self.element(scope, parent, "br");
            self.insert(scope, parent, &[br], None)?;
        }
        for &node in descendants {
            let fixed = self.fix_disallowed_ancestors(scope, node)?;
            if node == last {
                last = fixed;
            }
        }
        let arena = realm(scope, self.cid);
        Some((arena.parent_of(last)?, arena.child_index(last) as u32 + 1))
    }

    // The Editing draft's "fix disallowed ancestors" of `node`: where no ancestor in its editing host may hold it, a `dd` or
    // `dt` wrapped in a `dl`, and a prohibited paragraph child made a `div`, its own such children split out of it; where one
    // may, its parent split until its parent is that one. (The draft's "record the values" around a split, which keeps a
    // node's inline style where its ancestors' go, is the styling algorithm's backlog.) What `node` is now.
    fn fix_disallowed_ancestors(&mut self, scope: &mut v8::PinScope<'_, '_>, node: NodeId) -> Option<NodeId> {
        let arena = realm(scope, self.cid);
        let Some(element) = (if arena.is_element(node) { Some(node) } else { arena.parent_of(node) }) else { return Some(node) };
        let Some(host) = arena.editing_host(element) else { return Some(node) };
        let mut any = false;
        let mut at = arena.parent_of(node);
        while let Some(a) = at {
            if allowed_child(arena, Child::Node(node), a) {
                any = true;
                break;
            }
            if a == host {
                break;
            }
            at = arena.parent_of(a);
        }
        if !any {
            if !arena.is_element(node) {
                return Some(node);
            }
            if tag_in(arena, node, &["dd", "dt"]) {
                return self.wrap_in_dl(scope, node);
            }
            if !allowed_child(arena, Child::Name("p"), host) || !tag_in(arena, node, &PROHIBITED_PARAGRAPH_CHILDREN) {
                return Some(node);
            }
            let div = self.retagged(scope, node, "div")?;
            let div = self.fix_disallowed_ancestors(scope, div)?;
            let kids = realm(scope, self.cid).get(div)?.children.clone();
            for child in kids {
                if tag_in(realm(scope, self.cid), child, &PROHIBITED_PARAGRAPH_CHILDREN) {
                    self.split_parent(scope, child)?;
                }
            }
            return Some(div);
        }
        loop {
            let arena = realm(scope, self.cid);
            let Some(parent) = arena.parent_of(node) else { return Some(node) };
            if allowed_child(arena, Child::Node(node), parent) || !self.split_parent(scope, node)? {
                return Some(node);
            }
        }
    }
    fn wrap_in_dl(&mut self, scope: &mut v8::PinScope<'_, '_>, node: NodeId) -> Option<NodeId> {
        let arena = realm(scope, self.cid);
        let parent = arena.parent_of(node)?;
        let plain_dl = |id: NodeId| tag_in(arena, id, &["dl"]) && arena.get(id).is_some_and(|n| n.attributes.is_empty());
        if let Some(dl) = arena.sibling(node, -1).filter(|&s| plain_dl(s)) {
            self.move_into(scope, dl, &[node])?;
            return Some(node);
        }
        let dl = self.element(scope, node, "dl");
        self.insert(scope, parent, &[dl], Some(node))?;
        self.move_into(scope, dl, &[node])?;
        Some(node)
    }
    // `node` replaced by an element of the name `name`, its attributes and children hers.
    fn retagged(&mut self, scope: &mut v8::PinScope<'_, '_>, node: NodeId, name: &str) -> Option<NodeId> {
        let made = self.element(scope, node, name);
        let (attributes, kids) = {
            let n = realm(scope, self.cid).get(node)?;
            (n.attributes.clone(), n.children.clone())
        };
        crate::dom::replace_attributes(scope, self.cid, made, attributes, Vec::new(), None);
        self.replace(scope, node, made)?;
        self.move_into(scope, made, &kids)?;
        Some(made)
    }

    // The Editing draft's "split the parent" of the one-node list `node`: its parent's content before it and after it each
    // kept in an element of the parent's, the node between them, in the parent's parent — a parent left with nothing gone, a
    // line break where that would run the lines together added, one it leaves with no line to break removed. Whether it did.
    // (…what comes after it moved, not what comes before as the draft's words go: the same tree, a run of N of them split out
    // of one parent in N moves and not N²; the draft's id stays on the first part.)
    fn split_parent(&mut self, scope: &mut v8::PinScope<'_, '_>, node: NodeId) -> Option<bool> {
        let arena = realm(scope, self.cid);
        let Some(original) = arena.parent_of(node) else { return Some(false) };
        let Some(outer) = arena.parent_of(original) else { return Some(false) };
        if original == self.host || !arena.is_element(original) || arena.editing_host(original).is_none() {
            return Some(false);
        }
        let n = arena.get(original)?;
        let (first, last) = (n.children.first() == Some(&node), n.children.last() == Some(&node));
        let follows = first && line_edge(arena, original, false) != Edge::Content;
        let precedes = last && line_edge(arena, original, true) != Edge::Content;
        if !first && last {
            let next = arena.sibling(original, 1);
            self.move_before(scope, outer, &[node], next)?;
            self.break_after(scope, node, precedes)?;
            self.remove_extraneous_at_end(scope, original)?;
            return Some(true);
        }
        let holder = if first {
            self.move_before(scope, outer, &[node], Some(original))?;
            original
        } else {
            let arena = realm(scope, self.cid);
            let at = arena.child_index(node) + 1;
            let (after, next) = (arena.get(original)?.children[at..].to_vec(), arena.sibling(original, 1));
            let copy = self.copy(scope, original)?;
            let attributes: Vec<_> = realm(scope, self.cid).get(copy)?.attributes.iter().filter(|(k, _)| k != "id").cloned().collect();
            crate::dom::replace_attributes(scope, self.cid, copy, attributes, Vec::new(), None);
            self.move_into(scope, copy, &after)?;
            self.move_before(scope, outer, &[node], next)?;
            self.insert(scope, outer, &[copy], next)?;
            copy
        };
        let arena = realm(scope, self.cid);
        if follows && line_edge(arena, node, false) == Edge::Content {
            let br = self.element(scope, node, "br");
            self.insert(scope, outer, &[br], Some(node))?;
        }
        let arena = realm(scope, self.cid);
        let is_br = |id: Option<NodeId>| id.and_then(|i| arena.get(i)).is_some_and(|d| d.is_html_named("br"));
        let first_child = arena.get(holder)?.children.first().copied();
        if inline_level(arena, node) == Some(true) && !is_br(Some(node)) && is_br(first_child) && inline_level(arena, holder) == Some(false) {
            self.remove(scope, first_child?)?;
        }
        if realm(scope, self.cid).get(holder)?.children.is_empty() {
            self.remove(scope, holder)?;
            self.break_after(scope, node, precedes)?;
        } else if let Some(before) = realm(scope, self.cid).sibling(node, -1) {
            self.remove_extraneous_at_end(scope, before)?;
        }
        if realm(scope, self.cid).sibling(node, 1).is_none() {
            self.remove_extraneous_at_end(scope, outer)?;
        }
        Some(true)
    }
    fn break_after(&mut self, scope: &mut v8::PinScope<'_, '_>, node: NodeId, precedes: bool) -> Option<()> {
        let arena = realm(scope, self.cid);
        if precedes && line_edge(arena, node, true) == Edge::Content {
            let (parent, next) = (arena.parent_of(node)?, arena.sibling(node, 1));
            let br = self.element(scope, node, "br");
            self.insert(scope, parent, &[br], next)?;
        }
        Some(())
    }
    // The draft's "remove extraneous line breaks at the end of" `node`: a `<br>` last in it, ending a line that has content,
    // that no line follows — none that is all a list item holds.
    fn remove_extraneous_at_end(&mut self, scope: &mut v8::PinScope<'_, '_>, node: NodeId) -> Option<()> {
        let arena = realm(scope, self.cid);
        let mut at = node;
        while let Some(&last) = arena.get(at)?.children.last() {
            at = last;
        }
        let lone = arena.parent_of(at).and_then(|p| arena.get(p)).is_some_and(|p| p.is_html_named("li") && p.children.len() == 1);
        if arena.get(at)?.is_html_named("br") && !lone && arena.editing_host(at).is_some() && line_edge(arena, at, true) != Edge::Content && line_edge(arena, at, false) == Edge::Content {
            self.remove(scope, at)?;
        }
        Some(())
    }

    // Text of lines: each line at the caret, a paragraph's break between them (CR LF, CR or LF — Enter's); where one
    // inserts nothing the next goes where the caret was. Where the caret goes, none where nothing went in or a copy's
    // shadow root threw.
    fn lines(&mut self, scope: &mut v8::PinScope<'_, '_>, mut caret: (NodeId, u32), text: &[u16], pasted: bool) -> Option<(NodeId, u32)> {
        let mut inserted = false;
        let mut rest = text;
        loop {
            let end = rest.iter().position(|&u| u == 0x0d || u == 0x0a).unwrap_or(rest.len());
            if end > 0 {
                if let Some(at) = self.text(scope, caret, &rest[..end], pasted) {
                    (caret, inserted) = (at, true);
                }
            }
            if end == rest.len() || crate::dom::dom(scope).clone_exception.is_some() || crate::dom::factory_threw(scope) {
                break;
            }
            let crlf = rest[end] == 0x0d && rest.get(end + 1) == Some(&0x0a);
            rest = &rest[end + if crlf { 2 } else { 1 }..];
            if let Some(at) = self.host_break(scope, caret) {
                (caret, inserted) = (at, true);
            }
            if crate::dom::dom(scope).clone_exception.is_some() || crate::dom::factory_threw(scope) {
                break;
            }
        }
        inserted.then_some(caret)
    }

    // A line's end in the host: a paragraph's break — but in a `plaintext-only` host, which holds no block of its own, a
    // line break: a line feed where the white space keeps them, else a `<br>` (editing/plaintext-only's tests).
    fn host_break(&mut self, scope: &mut v8::PinScope<'_, '_>, caret: (NodeId, u32)) -> Option<(NodeId, u32)> {
        let arena = realm(scope, self.cid);
        let plaintext = arena.get(self.host).and_then(|n| n.plain_attr("contenteditable")).is_some_and(|v| v.eq_ignore_ascii_case("plaintext-only"));
        if !plaintext {
            return self.paragraph(scope, caret);
        }
        let element = if arena.is_element(caret.0) { Some(caret.0) } else { arena.parent_of(caret.0) };
        if crate::rendered::collapses_white_space(arena, element) {
            self.line_break(scope, caret)
        } else {
            self.text(scope, caret, &[0x0A], false)
        }
    }

    // `text` at the caret: into the text there, or a text of its own — taking the place of a placeholder `<br>` — and the
    // white space at either edge of it rebalanced (what it holds as it is: Chrome). Where the caret goes: after it.
    fn text(&mut self, scope: &mut v8::PinScope<'_, '_>, caret: (NodeId, u32), text: &[u16], whole: bool) -> Option<(NodeId, u32)> {
        let (node, offset) = insertion_point(realm(scope, self.cid), caret);
        let arena = realm(scope, self.cid);
        let (target, at) = if arena.get(node)?.kind == NodeKind::Text {
            let object = crate::dom::node_value(scope, Some(node));
            if crate::dom::factory_threw(scope) {
                return None;
            }
            let string = v8::String::new_from_two_byte(scope, text, v8::NewStringType::Normal)?;
            crate::character_data::replace_data(scope, self.caller, node, object, offset as usize, 0, string).ok()?;
            (node, offset)
        } else {
            let before = arena.get(node)?.children.get(offset as usize).copied();
            let placeholder = before.filter(|&b| placeholder(arena, b));
            let (made, held) = make(scope, self.cid, self.caller, node, NodeData::of_kind(NodeKind::Text, text.to_vec()));
            self.held.push(held);
            self.insert(scope, node, &[made], before)?;
            if let Some(br) = placeholder {
                self.remove(scope, br)?;
            }
            (made, 0)
        };
        let end = at + text.len() as u32;
        if whole {
            rebalance_space(scope, self.caller, target, at, end)?;
        } else {
            rebalance_space(scope, self.caller, target, at, at)?;
            rebalance_space(scope, self.caller, target, end, end)?;
        }
        Some((target, end))
    }

    // A `<br>` at the caret — a second after it where it ends its block, which the line it starts is — and the white
    // space starting the line after it rebalanced (that ending the line before it collapses as it is: Chrome). Where the
    // caret goes: after it, at the start of the text that follows it.
    fn line_break(&mut self, scope: &mut v8::PinScope<'_, '_>, caret: (NodeId, u32)) -> Option<(NodeId, u32)> {
        let place = insertion_point(realm(scope, self.cid), caret);
        let (parent, before) = self.split_at(scope, place)?;
        let br = self.element(scope, parent, "br");
        self.insert(scope, parent, &[br], before)?;
        if line_edge(realm(scope, self.cid), br, true) == Edge::Block {
            let second = self.element(scope, parent, "br");
            let after = realm(scope, self.cid).sibling(br, 1);
            self.insert(scope, parent, &[second], after)?;
        }
        let after = realm(scope, self.cid).sibling(br, 1);
        self.rebalance_beside(scope, parent, after)?;
        let arena = realm(scope, self.cid);
        Some(match after.filter(|&t| arena.get(t).is_some_and(|n| n.kind == NodeKind::Text)) {
            Some(text) => (text, 0),
            None => (parent, arena.child_index(br) as u32 + 1),
        })
    }

    // The caret's block split in two at the caret — in a table's cell, a `<pre>` or an inline host a line break; in an
    // empty list item (or one whose block the caret's is), the item out of its list (`out_of_list`); in the host itself,
    // the line (`host_line`): what follows the caret in it — in the elements between, copies of them — in a copy of it
    // after it (a `<div>` after a heading nothing follows the caret in), a list item split with the block it holds
    // (`<li><p>ab</p></li>`, broken at its end, is `<li><p>ab</p></li><li><p><br></p></li>`), the inline elements the
    // caret leaves empty at the end of the first part gone where it shows anything else, and either part that shows
    // nothing held open by a `<br>`. Where the caret goes: the start of the second.
    fn paragraph(&mut self, scope: &mut v8::PinScope<'_, '_>, caret: (NodeId, u32)) -> Option<(NodeId, u32)> {
        let (cid, host) = (self.cid, self.host);
        let arena = realm(scope, cid);
        let place = insertion_point(arena, caret);
        let block = block_of(arena, place.0, host);
        let b = arena.get(block)?;
        if ["td", "th", "caption", "pre", "listing"].iter().any(|t| b.is_html_named(t)) || (block == host && inline_level(arena, host) == Some(true)) {
            return self.line_break(scope, caret);
        }
        let li = |n: NodeId| n != host && arena.get(n).is_some_and(|d| d.is_html_named("li"));
        let item = Some(block).filter(|&n| li(n)).or_else(|| arena.parent_of(block).filter(|&p| li(p) && block != host));
        if let Some(item) = item.filter(|&i| !has_content(arena, i) && arena.parent_of(i).is_some_and(|list| list != host && within(arena, host, list))) {
            return self.out_of_list(scope, item);
        }
        let top = item.unwrap_or(block);
        let (parent, before) = self.split_at(scope, place)?;
        if top == host {
            return self.host_line(scope, parent, before);
        }
        let (moved, before) = self.split_inlines(scope, parent, before, top)?;
        let arena = realm(scope, cid);
        let nodes: Vec<NodeId> = moved.into_iter().chain(std::iter::successors(before, |&n| arena.sibling(n, 1))).collect();
        let copy = if heading(arena, top) && !nodes.iter().any(|&n| has_content(arena, n)) { self.element(scope, top, "div") } else { self.copy(scope, top)? };
        self.move_into(scope, copy, &nodes)?;
        let arena = realm(scope, cid);
        let (outer, after) = (arena.parent_of(top)?, arena.sibling(top, 1));
        self.insert(scope, outer, &[copy], after)?;
        self.drop_emptied_edge(scope, top, false)?;
        self.drop_emptied_edge(scope, copy, true)?;
        self.hold_open(scope, top, false)?;
        let caret = self.hold_open(scope, copy, true)?;
        self.rebalance_leaf(scope, top, false)?;
        self.rebalance_leaf(scope, copy, true)?;
        Some(caret)
    }
    // The line the caret is on in the host itself split: at its start, more of it after the caret, an empty `<div>` before
    // it, the caret where it was (`ab`, broken at its start, is `<div><br></div>ab`); anywhere else, what follows the caret
    // up to the host's next block — its `<br>`s and the lines after them too — in a `<div>` after what precedes it
    // (`a<div>b<br>cd</div>`), and a `<br>` before that where nothing does on its line (an empty host, broken, is
    // `<br><div><br></div>`).
    fn host_line(&mut self, scope: &mut v8::PinScope<'_, '_>, parent: NodeId, before: Option<NodeId>) -> Option<(NodeId, u32)> {
        let (cid, host) = (self.cid, self.host);
        let arena = realm(scope, cid);
        if edge(arena, parent, before, false) != Edge::Content && edge(arena, parent, before, true) == Edge::Content {
            let mut top = before;
            let mut at = parent;
            while at != host {
                top = Some(at);
                at = arena.parent_of(at)?;
            }
            let caret = match before {
                Some(b) if arena.get(b).is_some_and(|n| n.kind == NodeKind::Text) => (b, 0),
                Some(b) => (parent, arena.child_index(b) as u32),
                None => (parent, arena.get(parent)?.children.len() as u32),
            };
            let div = self.element(scope, host, "div");
            let br = self.element(scope, host, "br");
            self.insert(scope, div, &[br], None)?;
            self.insert(scope, host, &[div], top)?;
            return Some(caret);
        }
        let (moved, before) = self.split_inlines(scope, parent, before, host)?;
        let arena = realm(scope, cid);
        let block = |n: NodeId| arena.is_element(n) && inline_level(arena, n) == Some(false);
        let line: Vec<NodeId> = std::iter::successors(before, |&n| arena.sibling(n, 1)).take_while(|&n| !block(n)).collect();
        let next = line.last().map_or(before, |&n| arena.sibling(n, 1));
        let nodes: Vec<NodeId> = moved.into_iter().chain(line).collect();
        let div = self.element(scope, host, "div");
        self.move_into(scope, div, &nodes)?;
        self.insert(scope, host, &[div], next)?;
        if edge(realm(scope, cid), host, Some(div), false) != Edge::Content {
            let br = self.element(scope, host, "br");
            self.insert(scope, host, &[br], Some(div))?;
        }
        let caret = self.hold_open(scope, div, true)?;
        self.rebalance_beside(scope, host, Some(div))?;
        self.rebalance_leaf(scope, div, true)?;
        Some(caret)
    }
    // An empty list item out of its list: in a list that ends another's item, a new item of that list after it; else a
    // `<div>` after the list (`<li>a<ul><li></li></ul>b</li>` is `<li>a<div><br></div>b</li>`); the items after this one in
    // a copy of the list after that, the list removed where that empties it. Where the caret goes: in the new block,
    // before its `<br>`.
    fn out_of_list(&mut self, scope: &mut v8::PinScope<'_, '_>, item: NodeId) -> Option<(NodeId, u32)> {
        let arena = realm(scope, self.cid);
        let list = arena.parent_of(item)?;
        let outer = arena.parent_of(list)?;
        let ends = std::iter::successors(arena.sibling(list, 1), |&n| arena.sibling(n, 1)).all(|n| !has_content(arena, n));
        let nested = outer != self.host && ends && arena.get(outer).is_some_and(|n| n.is_html_named("li"));
        let following: Vec<NodeId> = std::iter::successors(arena.sibling(item, 1), |&n| arena.sibling(n, 1)).collect();
        self.remove(scope, item)?;
        let (block, into, after) = if nested {
            let arena = realm(scope, self.cid);
            let (into, after) = (arena.parent_of(outer)?, arena.sibling(outer, 1));
            (self.element(scope, outer, "li"), into, after)
        } else {
            (self.element(scope, list, "div"), outer, realm(scope, self.cid).sibling(list, 1))
        };
        let br = self.element(scope, block, "br");
        self.insert(scope, block, &[br], None)?;
        self.insert(scope, into, &[block], after)?;
        if !following.is_empty() {
            let rest = self.copy(scope, list)?;
            self.move_into(scope, rest, &following)?;
            let after = realm(scope, self.cid).sibling(block, 1);
            self.insert(scope, into, &[rest], after)?;
        }
        if realm(scope, self.cid).get(list).is_some_and(|n| n.children.is_empty()) {
            self.remove(scope, list)?;
        }
        Some((block, 0))
    }

    // A place made one between children: a text there split at it (character_data.rs `split_text`), where it is inside
    // one. The parent, and the child after the place.
    pub(crate) fn split_at(&mut self, scope: &mut v8::PinScope<'_, '_>, (node, offset): (NodeId, u32)) -> Option<(NodeId, Option<NodeId>)> {
        let arena = realm(scope, self.cid);
        let n = arena.get(node)?;
        if n.kind != NodeKind::Text {
            return Some((node, n.children.get(offset as usize).copied()));
        }
        let parent = n.parent?;
        if offset == 0 {
            return Some((parent, Some(node)));
        }
        if offset as usize >= n.data.len() {
            return Some((parent, arena.sibling(node, 1)));
        }
        let object = crate::dom::node_value(scope, Some(node));
        if crate::dom::factory_threw(scope) {
            return None;
        }
        let (new, made) = crate::character_data::split_text(scope, self.caller, node, object, offset as usize, self.steps)?;
        self.changes.extend(made);
        Some((parent, Some(new)))
    }
    // The inline elements from `parent` up to — not — `top` split at the place before `before`: what follows the place in
    // each moved into a copy of it, the copy of the one below first. The child of `top` the place is before then, and the
    // copy of the one it split, holding what followed the place in it.
    fn split_inlines(&mut self, scope: &mut v8::PinScope<'_, '_>, mut parent: NodeId, mut before: Option<NodeId>, top: NodeId) -> Option<(Option<NodeId>, Option<NodeId>)> {
        let mut moved = None;
        while parent != top {
            let arena = realm(scope, self.cid);
            let nodes: Vec<NodeId> = moved.into_iter().chain(std::iter::successors(before, |&n| arena.sibling(n, 1))).collect();
            let copy = self.copy(scope, parent)?;
            self.move_into(scope, copy, &nodes)?;
            let arena = realm(scope, self.cid);
            before = arena.sibling(parent, 1);
            parent = arena.parent_of(parent)?;
            moved = Some(copy);
        }
        Some((moved, before))
    }
    // The inline element at the end of `block` a split left empty — the caret was at its start — or at its start (`first`)
    // — the caret was at its end — gone, where the block shows anything else (`<p>ab<b>|cd</b></p>`, broken, is
    // `<p>ab</p><p><b>cd</b></p>`; `<p><b>ab|</b>cd</p>` `<p><b>ab</b></p><p>cd</p>`).
    fn drop_emptied_edge(&mut self, scope: &mut v8::PinScope<'_, '_>, block: NodeId, first: bool) -> Option<()> {
        let arena = realm(scope, self.cid);
        if !has_content(arena, block) {
            return Some(());
        }
        let last = arena.get(block).and_then(|n| if first { n.children.first() } else { n.children.last() }.copied());
        let emptied = last.filter(|&c| {
            arena.get(c).is_some_and(|d| d.kind == NodeKind::Element && !crate::caret::CARET_VOID_TAGS.contains(&&*d.local_name))
                && inline_level(arena, c) == Some(true)
                && !has_content(arena, c)
        });
        match emptied {
            Some(c) => self.remove(scope, c),
            None => Some(()),
        }
    }
    // `block`, where it shows nothing, held open by a `<br>` in its innermost element on one side — its first (`first`)
    // or last children's, none a non-editable island, an atom or a link — and where the caret goes in it on that side:
    // before that `<br>`, or at the start of its first text.
    fn hold_open(&mut self, scope: &mut v8::PinScope<'_, '_>, block: NodeId, first: bool) -> Option<(NodeId, u32)> {
        let arena = realm(scope, self.cid);
        let side = |n: NodeId| arena.get(n).and_then(|d| if first { d.children.first() } else { d.children.last() }.copied());
        let mut at = block;
        let into = |c: NodeId| {
            arena.get(c).is_some_and(|d| d.kind == NodeKind::Element && !crate::caret::CARET_VOID_TAGS.contains(&&*d.local_name) && !d.is_html_named("a"))
                && arena.editing_host(c).is_some()
                && !crate::rendered::is_atomic_inline(arena, c)
        };
        while let Some(c) = side(at).filter(|&c| into(c)) {
            at = c;
        }
        if has_content(arena, block) {
            return Some(match side(at).filter(|&c| arena.get(c).is_some_and(|d| d.kind == NodeKind::Text)) {
                Some(text) if first => (text, 0),
                _ => (at, 0),
            });
        }
        if !arena.get(at)?.children.iter().any(|&c| arena.get(c).is_some_and(|d| d.is_html_named("br"))) {
            let br = self.element(scope, at, "br");
            self.insert(scope, at, &[br], None)?;
        }
        Some((at, 0))
    }
    // The white space at the start (`first`) or the end of what `root` holds — a line a split began or ended — rebalanced.
    fn rebalance_leaf(&mut self, scope: &mut v8::PinScope<'_, '_>, root: NodeId, first: bool) -> Option<()> {
        let arena = realm(scope, self.cid);
        let mut at = root;
        while let Some(c) = arena.get(at).and_then(|d| if first { d.children.first() } else { d.children.last() }.copied()) {
            at = c;
        }
        let Some(len) = arena.get(at).filter(|d| d.kind == NodeKind::Text).map(|d| d.data.len() as u32) else { return Some(()) };
        let offset = if first { 0 } else { len };
        rebalance_space(scope, self.caller, at, offset, offset)
    }
    // The white space of the texts either side of the place before `child` in `parent`.
    fn rebalance_beside(&mut self, scope: &mut v8::PinScope<'_, '_>, parent: NodeId, child: Option<NodeId>) -> Option<()> {
        let arena = realm(scope, self.cid);
        let before = child.map_or_else(|| arena.get(parent).and_then(|n| n.children.last().copied()), |c| arena.sibling(c, -1));
        let text = |n: Option<NodeId>| n.filter(|&n| arena.get(n).is_some_and(|d| d.kind == NodeKind::Text));
        let sides = [text(before).map(|t| (t, arena.get(t).map_or(0, |d| d.data.len() as u32))), text(child).map(|t| (t, 0))];
        for (t, at) in sides.into_iter().flatten() {
            rebalance_space(scope, self.caller, t, at, at)?;
        }
        Some(())
    }
}

// The Editing draft's "allowed child": what a parent may hold.
pub(crate) enum Child<'a> {
    Node(NodeId),
    Name(&'a str),
}
const PROHIBITED_PARAGRAPH_CHILDREN: [&str; 50] = [
    "address", "article", "aside", "blockquote", "caption", "center", "col", "colgroup", "dd", "details", "dir", "div", "dl", "dt", "fieldset",
    "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "listing", "menu", "nav", "ol", "p",
    "plaintext", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "xmp", "main", "search", "dialog",
];
const INLINE_CONTENTS: [&str; 44] = [
    "a", "abbr", "b", "bdi", "bdo", "cite", "code", "dfn", "em", "h1", "h2", "h3", "h4", "h5", "h6", "i", "kbd", "mark", "p", "pre", "q", "rp", "rt", "ruby",
    "s", "samp", "small", "span", "strong", "sub", "sup", "u", "var", "acronym", "listing", "strike", "xmp", "big", "blink", "font", "marquee", "nobr", "tt", "label",
];
const HEADINGS: [&str; 6] = ["h1", "h2", "h3", "h4", "h5", "h6"];
fn tag_in(arena: &RealmArena, id: NodeId, names: &[&str]) -> bool {
    arena.get(id).is_some_and(|n| n.kind == NodeKind::Element && n.ns == web_atoms::ns!(html) && names.contains(&&*n.local_name))
}
pub(crate) fn allowed_child(arena: &RealmArena, child: Child<'_>, parent: NodeId) -> bool {
    let Some(p) = arena.get(parent) else { return false };
    const TABLE_PARTS: [&str; 6] = ["colgroup", "table", "tbody", "tfoot", "thead", "tr"];
    let parent_html = p.kind == NodeKind::Element && p.ns == web_atoms::ns!(html);
    let parent_name: &str = if parent_html { &p.local_name } else { "" };
    let child_node = match child {
        Child::Node(id) => arena.get(id),
        Child::Name(_) => None,
    };
    let is_text = child_node.is_some_and(|c| c.kind == NodeKind::Text);
    if TABLE_PARTS.contains(&parent_name) && is_text && child_node.is_some_and(|c| !c.data.iter().all(|&u| matches!(u, 0x20 | 0x09 | 0x0A | 0x0C | 0x0D))) {
        return false;
    }
    if ["script", "style", "plaintext", "xmp"].contains(&parent_name) && !is_text {
        return false;
    }
    let child: &str = match child {
        Child::Name(name) => name,
        Child::Node(_) => match child_node {
            Some(c) if c.kind == NodeKind::Document || c.kind == NodeKind::Fragment => return false,
            Some(c) if c.kind == NodeKind::Element && c.ns == web_atoms::ns!(html) => &c.local_name,
            _ => return true,
        },
    };
    if !parent_html {
        return true;
    }
    let (heading, prohibited) = (HEADINGS.contains(&child), PROHIBITED_PARAGRAPH_CHILDREN.contains(&child));
    let mut at = Some(parent);
    while let Some(a) = at {
        if child == "a" && tag_in(arena, a, &["a"]) {
            return false;
        }
        if prohibited && tag_in(arena, a, &INLINE_CONTENTS) {
            return false;
        }
        if heading && tag_in(arena, a, &HEADINGS) {
            return false;
        }
        at = arena.parent_of(a);
    }
    match parent_name {
        "colgroup" => return child == "col",
        "table" => return ["caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"].contains(&child),
        "tbody" | "thead" | "tfoot" => return ["td", "th", "tr"].contains(&child),
        "tr" => return ["td", "th"].contains(&child),
        "dl" => return ["dt", "dd"].contains(&child),
        "dir" | "ol" | "ul" => return ["dir", "li", "ol", "ul"].contains(&child),
        "hgroup" => return heading,
        _ => {}
    }
    if ["body", "caption", "col", "colgroup", "frame", "frameset", "head", "html", "tbody", "td", "tfoot", "th", "thead", "tr"].contains(&child) {
        return false;
    }
    if (child == "dd" || child == "dt") && parent_name != "dl" {
        return false;
    }
    if child == "li" && parent_name != "ol" && parent_name != "ul" {
        return false;
    }
    let same = |a: &[&str]| a.contains(&parent_name) && a.contains(&child);
    if same(&["a"]) || same(&["dd", "dt"]) || same(&HEADINGS) || same(&["li"]) || same(&["nobr"]) {
        return false;
    }
    if INLINE_CONTENTS.contains(&parent_name) && prohibited {
        return false;
    }
    if (parent_name == "td" || parent_name == "th") && ["caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"].contains(&child) {
        return false;
    }
    true
}

#[cfg(test)]
mod allowed_child_tests {
    use super::*;
    use web_atoms::ns;

    fn el(arena: &mut RealmArena, parent: Option<NodeId>, name: &str) -> NodeId {
        let mut n = NodeData::of_kind(NodeKind::Element, Vec::new());
        n.local_name = name.into();
        n.ns = ns!(html);
        arena.create(n, parent)
    }

    #[test]
    fn what_a_parent_may_hold() {
        let mut arena = RealmArena::default();
        let arena = &mut arena;
        let div = el(arena, None, "div");
        let p = el(arena, Some(div), "p");
        let b = el(arena, Some(p), "b");
        let ul = el(arena, Some(div), "ul");
        let li = el(arena, Some(ul), "li");
        assert!(allowed_child(arena, Child::Name("p"), div));
        assert!(!allowed_child(arena, Child::Name("p"), p));
        assert!(!allowed_child(arena, Child::Name("div"), b), "not through an ancestor with inline contents");
        assert!(allowed_child(arena, Child::Name("b"), p));
        assert!(allowed_child(arena, Child::Name("li"), ul));
        assert!(!allowed_child(arena, Child::Name("li"), li));
        assert!(!allowed_child(arena, Child::Name("li"), div));
        assert!(!allowed_child(arena, Child::Name("p"), ul));
        assert!(allowed_child(arena, Child::Name("ul"), li));
        assert!(!allowed_child(arena, Child::Name("td"), div));
    }
}
