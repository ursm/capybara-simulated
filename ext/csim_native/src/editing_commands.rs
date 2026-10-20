// `document.execCommand`'s editing commands in an editing host — the engine's edit of each: a list toggled, retagged
// or wrapped around the selection's block; the selected text wrapped innermost in a formatting element (superscript and
// subscript exclusive), a link or a span; the block wrapped in a blockquote, or out of one; the host's inline content
// wrapped in a block to align; a horizontal rule at the caret; the links the selection touches unwrapped. Each a plain
// shape of the edit — the shapes editors and the exec-command tests take — not the Editing spec's styling algorithm
// (merging runs, `<font>`, lists inside blocks), which is in-scope backlog. Every change of children the engine's; the
// bindings finish them, set the CSS a command gives the elements it answers (a colour, a font, an alignment, a cleared
// style), put the selection where it says, and fire `input`.

use crate::dom::{realm, NodeId, NodeKind, RealmArena};
use crate::editing_insert::Edit;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "editCommand", edit_command, context_id);
    crate::dom::register(scope, ns, "commandSupport", command_support_op, context_id);
    crate::dom::register(scope, ns, "commandTarget", command_target_op, context_id);
    crate::dom::register(scope, ns, "commandPlan", command_plan_op, context_id);
    crate::dom::register(scope, ns, "commandStyle", command_style_op, context_id);
}

// What the bindings do to carry a command out, beyond `inputType`'s `input` (codes as `commandPlan` hands them): the
// engine's edit of it alone (`editCommand`); text inserted (the selection deleted, for none); the selection's deletion,
// backward or forward; a line break, a paragraph; a span carrying a CSS property (`commandStyle`); the block aligned
// (its `text-align`); the styles cleared; a link; the clipboard's cut, copy and paste; markup — in a text control, its
// text; in an editing host, the edit.
#[derive(Clone, Copy)]
enum Action {
    Edit,
    Text,
    Delete,
    ForwardDelete,
    LineBreak,
    Paragraph,
    Style(&'static str),
    Align(&'static str),
    RemoveFormat,
    Link,
    Cut,
    Copy,
    Paste,
    Html,
}
impl Action {
    fn code(self) -> (u32, &'static str) {
        match self {
            Action::Edit => (0, ""),
            Action::Text => (1, ""),
            Action::Delete => (2, ""),
            Action::ForwardDelete => (3, ""),
            Action::LineBreak => (4, ""),
            Action::Paragraph => (5, ""),
            Action::Style(property) => (6, property),
            Action::Align(value) => (7, value),
            Action::RemoveFormat => (8, ""),
            Action::Link => (9, ""),
            Action::Cut => (10, ""),
            Action::Copy => (11, ""),
            Action::Paste => (12, ""),
            Action::Html => (13, ""),
        }
    }
}

// The commands `execCommand` carries out, by name (matched ASCII case-insensitively), each with whether it is one a
// focused text control takes as well as an editing host (Chrome's `queryCommandEnabled` with a selection in one), and
// the `inputType` of the `input` event it fires (Input Events §5.1, as Chrome names each; '' for none: `unlink`'s
// `input` carries none, `copy` fires no `input`), and what the bindings do for it (`Action`). (…`paste` among them, the
// driver's clipboard read: Chrome refuses a page that)
const COMMANDS: [(&str, bool, &str, Action); 31] = [
    ("bold", false, "formatBold", Action::Edit),
    ("italic", false, "formatItalic", Action::Edit),
    ("underline", false, "formatUnderline", Action::Edit),
    ("strikethrough", false, "formatStrikeThrough", Action::Edit),
    ("superscript", false, "formatSuperscript", Action::Edit),
    ("subscript", false, "formatSubscript", Action::Edit),
    ("forecolor", false, "formatFontColor", Action::Style("color")),
    ("backcolor", false, "formatBackColor", Action::Style("background-color")),
    ("hilitecolor", false, "formatBackColor", Action::Style("background-color")),
    ("fontname", false, "formatFontName", Action::Style("font-family")),
    ("justifycenter", false, "formatJustifyCenter", Action::Align("center")),
    ("justifyfull", false, "formatJustifyFull", Action::Align("justify")),
    ("justifyright", false, "formatJustifyRight", Action::Align("right")),
    ("justifyleft", false, "formatJustifyLeft", Action::Align("left")),
    ("removeformat", false, "formatRemove", Action::RemoveFormat),
    ("indent", false, "formatIndent", Action::Edit),
    ("outdent", false, "formatOutdent", Action::Edit),
    ("createlink", false, "insertLink", Action::Link),
    ("unlink", false, "", Action::Edit),
    ("inserthorizontalrule", false, "insertHorizontalRule", Action::Edit),
    ("insertorderedlist", false, "insertOrderedList", Action::Edit),
    ("insertunorderedlist", false, "insertUnorderedList", Action::Edit),
    ("inserttext", true, "insertText", Action::Text),
    ("inserthtml", true, "", Action::Html),
    ("insertlinebreak", true, "insertLineBreak", Action::LineBreak),
    ("insertparagraph", true, "insertParagraph", Action::Paragraph),
    ("delete", true, "deleteContentBackward", Action::Delete),
    ("forwarddelete", true, "deleteContentForward", Action::ForwardDelete),
    ("cut", true, "deleteByCut", Action::Cut),
    ("copy", true, "", Action::Copy),
    ("paste", true, "insertFromPaste", Action::Paste),
];
fn command(name: &str) -> Option<&'static (&'static str, bool, &'static str, Action)> {
    COMMANDS.iter().find(|(c, _, _, _)| c.eq_ignore_ascii_case(name))
}
// What `queryCommandSupported` / `queryCommandEnabled` answer of `command`: None for one not carried out — 1 where a
// text control's selection takes it as well as an editing host's, 0 where only an editing host's.
pub(crate) fn command_support(name: &str) -> Option<u32> {
    command(name).map(|&(_, text, _, _)| u32::from(text))
}
// __dom.commandSupport(command) -> `command_support`, -1 for none.
fn command_support_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let command = args.get(0).to_rust_string_lossy(scope);
    rv.set_int32(command_support(&command).map_or(-1, |s| s as i32));
}
// What a command of a document acts on (execCommand's, queryCommandEnabled's): none for a command it does not carry
// out; a focused text control — one text is typed into, a number or an email field too — first, as focusing one moves
// the selection into it: for a text command (`command_support` 1), one not `readonly` nor disabled (`TARGET_CONTROL`),
// and for a cut one with something selected (Blink's needs a range), else none; else the root editable element the
// selection's anchor is in (its own range's, a shadow tree's too — the anchor, which the engine's edits go by:
// element_state.rs `editing_root` — a `contenteditable=true` nested in an editable element no root of its own, the
// body in design mode), its kind deciding — a `plaintext-only` one takes the text commands alone (`TARGET_HOST`). None
// for no range at all, and for `unlink` with one that selects nothing.
const TARGET_NONE: u32 = 0;
const TARGET_CONTROL: u32 = 1;
const TARGET_HOST: u32 = 2;
fn command_target(scope: &mut v8::PinScope<'_, '_>, cid: i32, name: &str, active: Option<NodeId>, selection: v8::Local<'_, v8::Value>) -> (u32, Option<NodeId>) {
    let Some(support) = command_support(name) else { return (TARGET_NONE, None) };
    let arena = realm(scope, cid);
    let control = active.filter(|&a| {
        arena.get(a).is_some_and(|n| n.is_html_named("textarea") || (n.is_html_named("input") && n.input_has(crate::input_types::TYPED)))
    });
    if let Some(control) = control {
        let n = arena.get(control).expect("filtered above");
        let refused = support != 1 || n.is_read_only() || arena.is_actually_disabled(control);
        let nothing_cut = name.eq_ignore_ascii_case("cut") && {
            let (sel, _) = arena.text_selection(control);
            sel.start == sel.end
        };
        return if refused || nothing_cut { (TARGET_NONE, None) } else { (TARGET_CONTROL, Some(control)) };
    }
    let Some((anchor, collapsed)) = crate::selection::document_anchor(scope, cid, selection) else { return (TARGET_NONE, None) };
    if name.eq_ignore_ascii_case("unlink") && collapsed {
        return (TARGET_NONE, None);
    }
    // (…the arena again: reading the selection needed the scope it was borrowed from)
    let arena = realm(scope, cid);
    let Some(host) = arena.editing_root(anchor) else { return (TARGET_NONE, None) };
    let plaintext = arena.get(host).and_then(|n| n.plain_attr("contenteditable")).is_some_and(|v| v.eq_ignore_ascii_case("plaintext-only"));
    if support != 1 && plaintext { (TARGET_NONE, None) } else { (TARGET_HOST, Some(host)) }
}
// __dom.commandTarget(command, activeNid | -1, selection | null) -> [kind, node | null]: what the command acts on
// (`command_target`, `TARGET_*`), the document's active element and its selection's state given.
fn command_target_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = args.get(0).to_rust_string_lossy(scope);
    let active = crate::dom::nid_arg(scope, &args, 1);
    let cid = crate::dom::realm_id(scope, &args);
    let (kind, node) = command_target(scope, cid, &name, active, args.get(2));
    let items = [v8::Integer::new_from_unsigned(scope, kind).into(), crate::dom::node_value(scope, node)];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// How `execCommand` carries a command out (`commandPlan`): not at all (it answers false) — in a document with no
// browsing context, whose selection is no window's, nothing; the selection copied, whatever it is in; in a focused text
// control, its `Action` — the ones a control takes: text typed, the selection's deletion, a line break (which an input
// takes as nothing: true all the same, Chrome), markup's text (a textarea's or a free-text input's), and cut and paste
// where its selection APIs apply; in an editing host, its `Action`.
const STEP_NONE: u32 = 0;
const STEP_COPY: u32 = 1;
const STEP_CONTROL: u32 = 2;
const STEP_HOST: u32 = 3;
fn command_plan(scope: &mut v8::PinScope<'_, '_>, cid: i32, name: &str, active: Option<NodeId>, selection: v8::Local<'_, v8::Value>, has_view: bool) -> (u32, Option<NodeId>) {
    let Some(&(_, _, _, action)) = command(name) else { return (STEP_NONE, None) };
    if !has_view {
        return (STEP_NONE, None);
    }
    if matches!(action, Action::Copy) {
        return (STEP_COPY, None);
    }
    match command_target(scope, cid, name, active, selection) {
        (TARGET_HOST, host) => (STEP_HOST, host),
        (TARGET_CONTROL, Some(control)) => {
            let arena = realm(scope, cid);
            let n = arena.get(control).expect("a target is a node");
            let takes = match action {
                Action::Text | Action::Delete | Action::ForwardDelete | Action::LineBreak | Action::Paragraph => true,
                Action::Cut | Action::Paste => arena.selection_applies(n, false),
                Action::Html => n.is_html_named("textarea") || (n.is_html_named("input") && n.input_has(crate::input_types::FREE_TEXT)),
                _ => false,
            };
            if takes { (STEP_CONTROL, Some(control)) } else { (STEP_NONE, None) }
        }
        _ => (STEP_NONE, None),
    }
}
// __dom.commandPlan(command, activeNid | -1, selection | null, hasView) -> [step, node | null, action, its argument,
// inputType, name] (`command_plan`, `STEP_*`; `Action::code`; the `inputType` of the `input` it fires, '' for none; its
// name as `COMMANDS` spells it), the document's active element, its selection's state and whether it has a browsing
// context given — undefined for no command.
fn command_plan_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = args.get(0).to_rust_string_lossy(scope);
    let Some(&(canonical, _, input_type, action)) = command(&name) else { return };
    let active = crate::dom::nid_arg(scope, &args, 1);
    let cid = crate::dom::realm_id(scope, &args);
    let has_view = args.get(3).is_true();
    let (step, node) = command_plan(scope, cid, &name, active, args.get(2), has_view);
    let (code, arg) = action.code();
    let items = [
        v8::Integer::new_from_unsigned(scope, step).into(),
        crate::dom::node_value(scope, node),
        v8::Integer::new_from_unsigned(scope, code).into(),
        v8::String::new(scope, arg).map_or_else(|| v8::undefined(scope).into(), Into::into),
        v8::String::new(scope, input_type).map_or_else(|| v8::undefined(scope).into(), Into::into),
        v8::String::new(scope, canonical).map_or_else(|| v8::undefined(scope).into(), Into::into),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.commandStyle(property, value, docNid) -> [the style attribute a styling command's span carries, the `input`
// event's `data`]: `property: value` as an inline style of the document serializes it, in its mode (a quirks one's
// hashless colour) — '' for a value that does not parse, which styles nothing; the data a colour
// as the value's CSS serialization — a legacy-syntax one's (a name, a hex, rgb()), lowercased where it is a bare word,
// `currentcolor` and the CSS-wide keywords so; the string itself where it does not parse — Chrome's report; a font name
// as given.
fn command_style_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let property = args.get(0).to_rust_string_lossy(scope);
    let value = args.get(1).to_rust_string_lossy(scope);
    let quirks = crate::dom::quirks_arg(scope, &args, 2);
    let key = crate::cssom_decl::Key::new("", crate::cssom_decl::Kind::Style, quirks, "about:blank");
    let text = crate::cssom_decl::set(&key, None, &property, &value, false).map(|w| w.text).unwrap_or_default();
    let data = if property.ends_with("color") {
        let trimmed = value.trim_matches(|c: char| c.is_ascii_whitespace());
        let cid = crate::dom::realm_id(scope, &args);
        let d = crate::dom::dom(scope);
        let arena = d.arena.enter(cid);
        let parsed = crate::style::parse_color(d.styles.get(&cid), arena, trimmed, "").filter(|c| c.is_legacy_syntax());
        if trimmed.eq_ignore_ascii_case("currentcolor") {
            "currentcolor".to_owned()
        } else if let Some(color) = parsed {
            style_traits::ToCss::to_css_string(&color)
        } else if !trimmed.is_empty() && trimmed.bytes().all(|b| b.is_ascii_alphabetic()) {
            trimmed.to_ascii_lowercase()
        } else {
            trimmed.to_owned()
        }
    } else {
        value
    };
    let items: Vec<v8::Local<v8::Value>> = [text, data]
        .iter()
        .map(|t| v8::String::new(scope, t).map_or_else(|| v8::undefined(scope).into(), Into::into))
        .collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// (…an element of the local name `tag`, ASCII case-insensitively, in any namespace: the tags the commands compare)
fn tag_is(arena: &RealmArena, id: NodeId, tag: &str) -> bool {
    arena.get(id).is_some_and(|n| n.kind == NodeKind::Element && (*n.local_name).eq_ignore_ascii_case(tag))
}

// Where the selection goes after a command: left where it is, collapsed at a place, or around a node.
enum Caret {
    Keep,
    At(NodeId, u32),
    Around(NodeId, u32, NodeId, u32),
}

// __dom.editCommand(hostNid, anchorNid, anchorOffset, focusNid, focusOffset, command, value, steps) -> [fire, caret…,
// styled, nodes…, copies, changes…], or undefined for a command it does not know or a selection out of the host: the
// edit of `command` (its name ASCII lowercased, `value` its argument: a link's URL, a span's `style`) in the editing
// host `host` over the selection's range — whether the bindings fire `input` for it; where the selection goes (0 left,
// 1 collapsed: node, offset, 2 around: node, offset, node, offset); the elements whose CSS the bindings set (the block
// to align, the block whose style is cleared); then, as `editInsert` answers them, the elements it copied (none) and
// the changes of children it made.
fn edit_command(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(host), Some(anchor), Some(focus)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1), crate::dom::nid_arg(scope, &args, 3)) else { return };
    let (ao, fo) = (args.get(2).uint32_value(scope).unwrap_or(0), args.get(4).uint32_value(scope).unwrap_or(0));
    let command = args.get(5).to_rust_string_lossy(scope);
    let value = crate::dom::utf16_arg(scope, args.get(6));
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(7)) else { return };
    let caller = crate::dom::realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(host).map(|n| n.realm) else { return };
    crate::cloning::begin_clone(scope);
    let steps = v8::Local::new(scope, steps);
    // (…its range as the selection's in the editing host it is in — its anchor's, the focus clamped to it, nothing
    // selected in a comment: editing.rs `selection_host` — where `host` is the anchor's root editable element (a
    // `contenteditable=true` nested in an editable one edits in its own, the outer root firing `input`); a selection of
    // another host's, or none, edits nothing: Chrome)
    let arena = realm(scope, cid);
    let Some((host, range)) = crate::editing::selection_host(arena, (anchor, ao), (focus, fo)).filter(|_| arena.editing_root(anchor) == Some(host)) else { return };
    let (mut changes, mut copies, mut held) = (Vec::new(), Vec::new(), Vec::new());
    let mut edit = Edit { cid, caller, steps, host, changes: &mut changes, copies: &mut copies, held: &mut held };
    let done = match command.as_str() {
        "insertorderedlist" => list(scope, &mut edit, range.0, "ol"),
        "insertunorderedlist" => list(scope, &mut edit, range.0, "ul"),
        "bold" => wrap(scope, &mut edit, range, "b", None, None),
        "italic" => wrap(scope, &mut edit, range, "i", None, None),
        "underline" => wrap(scope, &mut edit, range, "u", None, None),
        "strikethrough" => wrap(scope, &mut edit, range, "strike", None, None),
        "superscript" => wrap(scope, &mut edit, range, "sup", Some("sub"), None),
        "subscript" => wrap(scope, &mut edit, range, "sub", Some("sup"), None),
        "createlink" => wrap(scope, &mut edit, range, "a", None, Some(("href", &value[..]))),
        "span" => wrap(scope, &mut edit, range, "span", None, Some(("style", &value[..])).filter(|_| !value.is_empty())),
        "justify" => justify(scope, &mut edit, range.0),
        "removeformat" => {
            let block = selection_block(realm(scope, cid), host, range.0, true);
            Some((true, Caret::Keep, block.filter(|&b| b != host).into_iter().collect()))
        }
        "indent" => indent(scope, &mut edit, range.0),
        "outdent" => outdent(scope, &mut edit, range.0),
        "unlink" => unlink(scope, &mut edit, range),
        "inserthorizontalrule" => horizontal_rule(scope, &mut edit, range),
        _ => return,
    };
    // (…where a copy's shadow root threw, what it changed answered all the same, the selection kept, for the bindings to
    // finish before they throw it: `takeCloneException`)
    let (fire, caret, styled) = match done {
        Some(done) => done,
        None if crate::dom::dom(scope).clone_exception.is_some() => (false, Caret::Keep, Vec::new()),
        None => return,
    };
    let mut out: Vec<v8::Local<'_, v8::Value>> = vec![v8::Boolean::new(scope, fire).into()];
    let places: Vec<(NodeId, u32)> = match caret {
        Caret::Keep => {
            out.push(v8::Integer::new(scope, 0).into());
            Vec::new()
        }
        Caret::At(node, offset) => {
            out.push(v8::Integer::new(scope, 1).into());
            vec![(node, offset)]
        }
        Caret::Around(a, ao, b, bo) => {
            out.push(v8::Integer::new(scope, 2).into());
            vec![(a, ao), (b, bo)]
        }
    };
    for (node, offset) in places {
        out.push(crate::dom::node_value(scope, Some(node)));
        if crate::dom::factory_threw(scope) {
            return;
        }
        out.push(v8::Integer::new_from_unsigned(scope, offset).into());
    }
    out.push(v8::Integer::new_from_unsigned(scope, styled.len() as u32).into());
    let styled = crate::dom::nodes_value(scope, cid, &styled);
    let Ok(styled) = v8::Local::<v8::Array>::try_from(styled) else { return };
    for k in 0..styled.length() {
        out.push(styled.get_index(scope, k).unwrap_or_else(|| v8::null(scope).into()));
    }
    out.push(v8::Integer::new_from_unsigned(scope, copies.len() as u32).into());
    out.extend(crate::cloning::bindings_value(scope, cid, &copies));
    out.extend(crate::mutation::changes_value(scope, cid, &changes));
    if crate::dom::factory_threw(scope) {
        return;
    }
    drop(held);
    rv.set(v8::Array::new_with_elements(scope, &out).into());
}

// A command's result: whether `input` fires for it, where the selection goes, and the elements whose CSS the bindings
// set. None where a change could not be made (a node factory's exception, the page's).
type Done = Option<(bool, Caret, Vec<NodeId>)>;

// The block container holding the selection's start (editing.rs `edit_ancestor`), entering an element start's child at
// its offset with `descend`.
fn selection_block(arena: &RealmArena, host: NodeId, (node, offset): (NodeId, u32), descend: bool) -> Option<NodeId> {
    crate::editing::block_container_of(arena, host, node, offset, descend)
}

// insertOrderedList / insertUnorderedList: in a list item of a list of `tag`, the list toggled off — each item's
// children lifted out in its place; of the other kind, the list retagged; in none, the block holding the caret (the
// host's inline content where it has none) wrapped in a list of one item, the caret at its end.
fn list(scope: &mut v8::PinScope<'_, '_>, edit: &mut Edit<'_, '_>, (node, offset): (NodeId, u32), tag: &str) -> Done {
    let arena = realm(scope, edit.cid);
    let item = crate::editing::list_item_of(arena, edit.host, node, offset);
    if let Some(item) = item {
        let list = arena.parent_of(item)?;
        let parent = arena.parent_of(list)?;
        if tag_is(arena, list, tag) {
            let items = arena.get(list)?.children.clone();
            for i in items {
                let kids = realm(scope, edit.cid).get(i).map_or_else(Vec::new, |n| n.children.clone());
                edit.move_before(scope, parent, &kids, Some(list))?;
            }
            edit.remove(scope, list)?;
            return Some((true, Caret::Keep, Vec::new()));
        }
        let kids = arena.get(list)?.children.clone();
        let retagged = edit.element(scope, list, tag);
        edit.move_into(scope, retagged, &kids)?;
        edit.replace(scope, list, retagged)?;
        let first = realm(scope, edit.cid).get(retagged)?.children.first().copied().unwrap_or(retagged);
        return Some((true, Caret::At(first, 0), Vec::new()));
    }
    let block = selection_block(arena, edit.host, (node, offset), false).unwrap_or(edit.host);
    let (item, list) = (edit.element(scope, block, "li"), edit.element(scope, block, tag));
    edit.insert(scope, list, &[item], None)?;
    let kids = realm(scope, edit.cid).get(block)?.children.clone();
    edit.move_into(scope, item, &kids)?;
    if block == edit.host {
        edit.insert(scope, block, &[list], None)?;
    } else {
        edit.replace(scope, block, list)?;
    }
    let end = realm(scope, edit.cid).get(item)?.children.len() as u32;
    Some((true, Caret::At(item, end), Vec::new()))
}

// The selected text wrapped innermost — each text node the range covers split at the slice's edges, the slice moved
// into a new `tag` element (with `attribute` set: a link's `href`, a span's `style`) where it was, so chained commands nest — `exclusive` (superscript and
// subscript) first unwrapping a conflicting element that wraps the selected text alone; the selection around a single
// wrapped run. `input` only where it wrapped any, as Chrome.
fn wrap(scope: &mut v8::PinScope<'_, '_>, edit: &mut Edit<'_, '_>, (start, end): ((NodeId, u32), (NodeId, u32)), tag: &str, exclusive: Option<&str>, attribute: Option<(&str, &[u16])>) -> Done {
    if start == end {
        return Some((false, Caret::Keep, Vec::new()));
    }
    let runs = realm(scope, edit.cid).covered_text(start, end);
    let mut targets = Vec::with_capacity(runs.len());
    for (node, from, to) in runs {
        let len = realm(scope, edit.cid).get(node).map_or(0, |n| n.data.len() as u32);
        if to < len {
            edit.split_at(scope, (node, to))?;
        }
        let target = if from > 0 { edit.split_at(scope, (node, from))?.1? } else { node };
        targets.push(target);
    }
    let selected: std::collections::HashSet<NodeId> = if exclusive.is_some() { targets.iter().copied().collect() } else { Default::default() };
    let mut wrappers = Vec::with_capacity(targets.len());
    for &t in &targets {
        if let Some(other) = exclusive {
            unwrap_exclusive(scope, edit, t, other, &selected)?;
        }
        let parent = realm(scope, edit.cid).parent_of(t)?;
        let wrapper = edit.element(scope, parent, tag);
        if let Some((name, units)) = attribute {
            let lossy = String::from_utf16_lossy(units);
            let exact = if lossy.encode_utf16().eq(units.iter().copied()) { Vec::new() } else { vec![(name.to_owned(), units.to_vec())] };
            crate::dom::replace_attributes(scope, edit.cid, wrapper, vec![(name.to_owned(), lossy)], exact, None);
        }
        edit.insert(scope, parent, &[wrapper], Some(t))?;
        edit.move_into(scope, wrapper, &[t])?;
        wrappers.push(wrapper);
    }
    let caret = match wrappers.as_slice() {
        [only] => {
            let arena = realm(scope, edit.cid);
            let parent = arena.parent_of(*only)?;
            let at = arena.child_index(*only) as u32;
            Caret::Around(parent, at, parent, at + 1)
        }
        _ => Caret::Keep,
    };
    Some((!wrappers.is_empty(), caret, Vec::new()))
}
// …the element of `other` immediately around `text` — not the host — unwrapped where every text it holds that shows any
// is selected (`targets`); one that also formats unselected text is left (a slice-scoped unwrap is editing backlog).
fn unwrap_exclusive(scope: &mut v8::PinScope<'_, '_>, edit: &mut Edit<'_, '_>, text: NodeId, other: &str, targets: &std::collections::HashSet<NodeId>) -> Option<()> {
    let arena = realm(scope, edit.cid);
    let Some(conflict) = arena.parent_of(text).filter(|&p| p != edit.host && tag_is(arena, p, other)) else { return Some(()) };
    let mut stack = vec![conflict];
    while let Some(n) = stack.pop() {
        let d = arena.get(n)?;
        if d.kind == NodeKind::Text && !d.data.is_empty() && !targets.contains(&n) {
            return Some(());
        }
        stack.extend(d.children.iter());
    }
    let (parent, kids) = (arena.parent_of(conflict)?, arena.get(conflict)?.children.clone());
    edit.move_before(scope, parent, &kids, Some(conflict))?;
    edit.remove(scope, conflict)
}

// The justify commands' block — the block holding the selection, or, the host's inline content where it has none, a
// `<div>` wrapped around that, the caret at its start — answered for its `text-align`.
fn justify(scope: &mut v8::PinScope<'_, '_>, edit: &mut Edit<'_, '_>, start: (NodeId, u32)) -> Done {
    let arena = realm(scope, edit.cid);
    if let Some(block) = selection_block(arena, edit.host, start, true).filter(|&b| b != edit.host) {
        return Some((true, Caret::Keep, vec![block]));
    }
    let kids = arena.get(edit.host)?.children.clone();
    let div = edit.element(scope, edit.host, "div");
    edit.move_into(scope, div, &kids)?;
    edit.insert(scope, edit.host, &[div], None)?;
    Some((true, Caret::At(div, 0), vec![div]))
}

// indent: the block holding the selection wrapped in a `<blockquote>` — the host's content where it is the host.
fn indent(scope: &mut v8::PinScope<'_, '_>, edit: &mut Edit<'_, '_>, start: (NodeId, u32)) -> Done {
    let arena = realm(scope, edit.cid);
    let block = selection_block(arena, edit.host, start, true).filter(|&b| b != edit.host);
    let quote = edit.element(scope, edit.host, "blockquote");
    match block {
        Some(block) => {
            let parent = realm(scope, edit.cid).parent_of(block)?;
            edit.insert(scope, parent, &[quote], Some(block))?;
            edit.move_into(scope, quote, &[block])?;
        }
        None => {
            let kids = realm(scope, edit.cid).get(edit.host)?.children.clone();
            edit.move_into(scope, quote, &kids)?;
            edit.insert(scope, edit.host, &[quote], None)?;
        }
    }
    Some((true, Caret::Keep, Vec::new()))
}
// outdent: the nearest `<blockquote>` at or above the block holding the selection unwrapped — its children lifted out
// in its place — so an indent and an outdent give the tree back.
fn outdent(scope: &mut v8::PinScope<'_, '_>, edit: &mut Edit<'_, '_>, start: (NodeId, u32)) -> Done {
    let arena = realm(scope, edit.cid);
    let quote = selection_block(arena, edit.host, start, true).and_then(|b| crate::editing::blockquote_of(arena, edit.host, b));
    if let Some(quote) = quote {
        let (parent, kids) = (arena.parent_of(quote)?, arena.get(quote)?.children.clone());
        edit.move_before(scope, parent, &kids, Some(quote))?;
        edit.remove(scope, quote)?;
    }
    Some((true, Caret::Keep, Vec::new()))
}

// unlink: every `<a>` the selection touches — those in the range, and those it starts in, short of the host — unwrapped,
// its children lifted out in its place.
fn unlink(scope: &mut v8::PinScope<'_, '_>, edit: &mut Edit<'_, '_>, (start, end): ((NodeId, u32), (NodeId, u32))) -> Done {
    let arena = realm(scope, edit.cid);
    let common = crate::ranges::common_ancestor(arena, start.0, end.0);
    let root = if arena.is_element(common) { common } else { arena.parent_of(common).unwrap_or(common) };
    let intersects = |n: NodeId| {
        let Some(parent) = arena.parent_of(n) else { return true };
        let at = arena.child_index(n) as u32;
        crate::ranges::compare_points(arena, start, (parent, at + 1)) == Some(std::cmp::Ordering::Less)
            && crate::ranges::compare_points(arena, end, (parent, at)) == Some(std::cmp::Ordering::Greater)
    };
    let mut anchors = Vec::new();
    let mut stack = vec![root];
    while let Some(n) = stack.pop() {
        let Some(d) = arena.get(n) else { continue };
        if tag_is(arena, n, "a") && intersects(n) {
            anchors.push(n);
        }
        stack.extend(d.children.iter().rev());
    }
    let mut at = Some(start.0);
    while let Some(n) = at.filter(|&n| n != edit.host) {
        if tag_is(arena, n, "a") && !anchors.contains(&n) {
            anchors.push(n);
        }
        at = arena.parent_of(n);
    }
    for a in anchors {
        let arena = realm(scope, edit.cid);
        let (Some(parent), Some(kids)) = (arena.parent_of(a), arena.get(a).map(|n| n.children.clone())) else { continue };
        edit.move_before(scope, parent, &kids, Some(a))?;
        edit.remove(scope, a)?;
    }
    Some((true, Caret::Keep, Vec::new()))
}

// insertHorizontalRule: the selection's contents deleted, an `<hr>` where that left the range — inside a text there, the
// text split at it — and the caret after it.
fn horizontal_rule<'s>(scope: &mut v8::PinScope<'s, '_>, edit: &mut Edit<'s, '_>, (start, end): ((NodeId, u32), (NodeId, u32))) -> Done {
    let arena = realm(scope, edit.cid);
    let place = if start != end {
        // (…where DOM "delete the contents" leaves the range: after the start's highest ancestor the end is not in)
        let mut reference = None;
        if !crate::editing::within(arena, start.0, end.0) {
            let mut at = start.0;
            while let Some(p) = arena.parent_of(at).filter(|&p| !crate::editing::within(arena, p, end.0)) {
                at = p;
            }
            reference = Some(at);
        }
        let (made, _) = crate::range_contents::delete(scope, edit.cid, edit.caller, edit.steps, start.0, start.1, end.0, end.1)?;
        edit.changes.extend(made);
        match reference {
            Some(r) => {
                let arena = realm(scope, edit.cid);
                (arena.parent_of(r)?, arena.child_index(r) as u32 + 1)
            }
            None => start,
        }
    } else {
        start
    };
    let (parent, before) = edit.split_at(scope, place)?;
    let rule = edit.element(scope, parent, "hr");
    edit.insert(scope, parent, &[rule], before)?;
    let at = realm(scope, edit.cid).child_index(rule) as u32 + 1;
    Some((true, Caret::At(parent, at), Vec::new()))
}
