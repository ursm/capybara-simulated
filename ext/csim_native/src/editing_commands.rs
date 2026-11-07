// `document.execCommand`'s editing commands in an editing host — the engine's edit of each: a list toggled, retagged
// or wrapped around the selection's block; the selected text wrapped innermost in a formatting element (superscript and
// subscript exclusive), a link or a span; the block wrapped in a blockquote, or out of one; the host's inline content
// wrapped in a block to align; a horizontal rule at the caret; the links the selection touches unwrapped. Each a plain
// shape of the edit — the shapes editors and the exec-command tests take — not the Editing spec's styling algorithm
// (merging runs, `<font>`, lists inside blocks), which is in-scope backlog. Every change of children the engine's; the
// bindings finish them, set the CSS a command gives the elements it answers (a colour, a font, an alignment, a cleared
// style), put the selection where it says, and fire `input`. And how a command is carried out (`commandPlan`), which
// holds the clipboard's actions too, whichever of a script and the user asks: what is decided here, and what the bindings
// walk, firing the events it names — page code runs between them, so each part of the plan is asked after the last's has.

use crate::dom::{realm, NodeId, NodeKind, RealmArena};
use crate::editing_insert::Edit;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "editCommand", edit_command, context_id);
    crate::dom::register(scope, ns, "commandSupport", command_support_op, context_id);
    crate::dom::register(scope, ns, "commandTarget", command_target_op, context_id);
    crate::dom::register(scope, ns, "commandPlan", command_plan_op, context_id);
    crate::dom::register(scope, ns, "controlCommand", control_command_op, context_id);
    crate::dom::register(scope, ns, "clipboardEventTarget", clipboard_event_target_op, context_id);
    crate::dom::register(scope, ns, "clipboardWriteControl", clipboard_write_control_op, context_id);
    crate::dom::register(scope, ns, "clipboardMarkup", clipboard_markup_op, context_id);
    crate::dom::register(scope, ns, "editInsertFragment", edit_insert_fragment, context_id);
    crate::dom::register(scope, ns, "pasteRemovals", paste_removals_op, context_id);
}

// What carrying a command out comes to, beyond `inputType`'s `input`: the engine's edit of it alone; text inserted (the
// selection deleted, for none); the selection's deletion, backward or forward; a line break, a paragraph; a span carrying
// a CSS property; the block aligned (its `text-align`); the styles cleared; a link; the clipboard's cut, copy and paste;
// markup — in a text control, its text; in an editing host, the edit; everything selected.
#[derive(Clone, Copy, PartialEq)]
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
    SelectAll,
}

// The commands `execCommand` carries out, by name (matched ASCII case-insensitively), each with whether it is one a
// focused text control takes as well as an editing host (Chrome's `queryCommandEnabled` with a selection in one), and
// the `inputType` of the `input` event it fires (Input Events §5.1, as Chrome names each; '' for none: `unlink`'s
// `input` carries none, `copy` fires no `input`), and what the bindings do for it (`Action`). (…`paste` among them, the
// driver's clipboard read: Chrome refuses a page that)
const COMMANDS: [(&str, bool, &str, Action); 32] = [
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
    ("selectall", true, "", Action::SelectAll),
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
// for no range at all, and for `unlink` and `cut` with one that selects nothing. `selectAll` selects in any focused text control,
// a readonly or disabled one's too (Chrome), and in no host the document's body — its document element where it has
// none, and none at all (`TARGET_HOST` with no node: the selection emptied) where it has no document element either
// (the Editing draft's selectAll; Chrome).
const TARGET_NONE: u32 = 0;
const TARGET_CONTROL: u32 = 1;
const TARGET_HOST: u32 = 2;
fn command_target(scope: &mut v8::PinScope<'_, '_>, cid: i32, name: &str, active: Option<NodeId>, selection: v8::Local<'_, v8::Value>) -> (u32, Option<NodeId>) {
    let Some(support) = command_support(name) else { return (TARGET_NONE, None) };
    let select_all = name.eq_ignore_ascii_case("selectall");
    let cut = name.eq_ignore_ascii_case("cut");
    let arena = realm(scope, cid);
    let control = active.filter(|&a| {
        arena.get(a).is_some_and(|n| n.is_html_named("textarea") || (n.is_html_named("input") && n.input_has(crate::input_types::TYPED)))
    });
    if let Some(control) = control {
        let n = arena.get(control).expect("filtered above");
        let refused = support != 1 || (!select_all && (n.is_read_only() || arena.is_actually_disabled(control)));
        let nothing_cut = cut && arena.selected_text(control).is_none();
        return if refused || nothing_cut { (TARGET_NONE, None) } else { (TARGET_CONTROL, Some(control)) };
    }
    let page = |scope: &mut v8::PinScope<'_, '_>| -> (u32, Option<NodeId>) {
        if !select_all {
            return (TARGET_NONE, None);
        }
        let Some(doc) = crate::selection::document_of(scope, selection) else { return (TARGET_NONE, None) };
        let arena = realm(scope, cid);
        (TARGET_HOST, arena.relative(doc, crate::dom::RELATIVE_BODY).or_else(|| arena.get(doc)?.children.iter().copied().find(|&c| arena.is_element(c))))
    };
    let Some((anchor, collapsed)) = crate::selection::document_anchor(scope, cid, selection) else { return page(scope) };
    if (cut || name.eq_ignore_ascii_case("unlink")) && collapsed {
        return (TARGET_NONE, None);
    }
    // (…the arena again: reading the selection needed the scope it was borrowed from)
    let arena = realm(scope, cid);
    let Some(host) = arena.editing_root(anchor) else { return page(scope) };
    if support != 1 && arena.get(host).is_some_and(plaintext_only) { (TARGET_NONE, None) } else { (TARGET_HOST, Some(host)) }
}
fn plaintext_only(n: &crate::dom::NodeData) -> bool {
    n.plain_attr("contenteditable").is_some_and(|v| v.eq_ignore_ascii_case("plaintext-only"))
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

// How a command is carried out (`commandPlan`): not at all (it answers false) — in a document with no browsing context,
// whose selection is no window's, nothing; everything in what `command_target` answers selected (`selectAll`); a
// clipboard action, its event first, whose listeners may move the selection the rest acts on (§5.3.5), so the rest is
// planned after it — a script's cut, copy and paste whatever is selected, as Clipboard API §5.3.3 has them; the selection
// copied, whatever it is in; in a focused text control, its `Action` — the ones a control takes: text typed, the
// selection's deletion, a line break (which an input takes as nothing: true all the same, Chrome), markup's text (a
// textarea's or a free-text input's), and cut and paste where its selection APIs apply — a user's in a number or an email
// field too (Chrome, Firefox); in an editing host, its `Action`.
const STEP_NONE: u32 = 0;
const STEP_COPY: u32 = 1;
const STEP_CONTROL: u32 = 2;
const STEP_HOST: u32 = 3;
const STEP_SELECT_ALL: u32 = 4;
const STEP_CLIPBOARD_EVENT: u32 = 5;
// Who asks: a script's `execCommand`; the rest of a clipboard action's, or of a user's gesture, its event dispatched.
const ASKED_BY_SCRIPT: u32 = 0;
#[cfg(test)]
const SCRIPT_AFTER_EVENT: u32 = 1;
const GESTURE_AFTER_EVENT: u32 = 2;
// What the bindings do around the edit of a step: the selection written to the clipboard (a cut's, canceled or not a
// beforeinput — Chrome); a cancelable `beforeinput` first (a user's cut and paste; a script's edit fires only `input`:
// the input-events tests, Chrome, Firefox — the Editing draft's step otherwise is w3c/editing#200, open); the paste's
// clipboard flavors a read-only DataTransfer on the InputEvents, its `data` null (Input Events §4: an editing host's); the
// value markup whose text is what goes in (a control's `insertHTML`, and a `plaintext-only` host's: Chrome, Firefox); the
// value markup whose fragment goes in (`insertHTML` in a host, the Editing draft's); that fragment one parsed as a paste's,
// nothing of it running (Clipboard API: the page's own markup is none it asked for).
const PLAN_WRITE_SELECTION: u32 = 1;
const PLAN_BEFORE_INPUT: u32 = 2;
const PLAN_PASTE_TRANSFER: u32 = 4;
const PLAN_MARKUP_TEXT: u32 = 8;
const PLAN_MARKUP_FRAGMENT: u32 = 16;
const PLAN_PASTED_FRAGMENT: u32 = 32;
fn plan_flags(step: u32, action: Action, asked: u32, plaintext: bool, pasted_markup: bool) -> u32 {
    let user_edit = asked == GESTURE_AFTER_EVENT && matches!(action, Action::Cut | Action::Paste);
    let html = action == Action::Html;
    (if action == Action::Cut { PLAN_WRITE_SELECTION } else { 0 })
        | (if user_edit { PLAN_BEFORE_INPUT } else { 0 })
        | (if step == STEP_HOST && action == Action::Paste { PLAN_PASTE_TRANSFER } else { 0 })
        | (if html && (step == STEP_CONTROL || (step == STEP_HOST && plaintext)) { PLAN_MARKUP_TEXT } else { 0 })
        | (if html && step == STEP_HOST && !plaintext { PLAN_MARKUP_FRAGMENT } else { 0 })
        | (if pasted_markup && step == STEP_HOST && action == Action::Paste && !plaintext { PLAN_PASTED_FRAGMENT } else { 0 })
}
#[allow(clippy::too_many_arguments)]
fn command_plan(scope: &mut v8::PinScope<'_, '_>, cid: i32, name: &str, action: Action, active: Option<NodeId>, selection: v8::Local<'_, v8::Value>, has_view: bool, asked: u32) -> (u32, Option<NodeId>) {
    if !has_view {
        return (STEP_NONE, None);
    }
    if asked == ASKED_BY_SCRIPT && matches!(action, Action::Cut | Action::Copy | Action::Paste) {
        return (STEP_CLIPBOARD_EVENT, None);
    }
    if action == Action::Copy {
        return (STEP_COPY, typed_control(realm(scope, cid), active));
    }
    match command_target(scope, cid, name, active, selection) {
        (TARGET_NONE, _) => (STEP_NONE, None),
        (_, node) if action == Action::SelectAll => (STEP_SELECT_ALL, node),
        (TARGET_HOST, host) => (STEP_HOST, host),
        (TARGET_CONTROL, Some(control)) => {
            let arena = realm(scope, cid);
            let n = arena.get(control).expect("a target is a node");
            let takes = match action {
                Action::Text | Action::Delete | Action::ForwardDelete | Action::LineBreak | Action::Paragraph => true,
                Action::Cut | Action::Paste => asked == GESTURE_AFTER_EVENT || arena.selection_applies(n, false),
                Action::Html => n.is_html_named("textarea") || (n.is_html_named("input") && n.input_has(crate::input_types::FREE_TEXT)),
                _ => false,
            };
            if takes { (STEP_CONTROL, Some(control)) } else { (STEP_NONE, None) }
        }
        _ => (STEP_NONE, None),
    }
}
// …the active element where it is a text control, one text is typed into — what holds the selection while it is focused.
fn typed_control(arena: &RealmArena, active: Option<NodeId>) -> Option<NodeId> {
    active.filter(|&a| arena.get(a).is_some_and(|n| n.is_html_named("textarea") || (n.is_html_named("input") && n.input_has(crate::input_types::TYPED))))
}
fn data_value<'s>(scope: &mut v8::PinScope<'s, '_>, data: Option<&[u16]>) -> v8::Local<'s, v8::Value> {
    match data {
        Some(units) => crate::dom::utf16_value(scope, units),
        None => v8::null(scope).into(),
    }
}
fn str_value<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
}
// __dom.commandPlan(command, activeNid | -1, selection | null, hasView, asked, partition) -> [step, node | null, flags,
// inputType, name, pasted] (`command_plan`, `STEP_*`; `PLAN_*`; the `inputType` of the InputEvents it fires, '' for none;
// its name as `COMMANDS` spells it; what a paste goes on to insert, that the session's clipboard holds — its markup in an
// editing host that takes it, else its text — null for none and for any other command), the document's active element, its selection's state, whether it has a browsing context and who asks
// (`ASKED_BY_SCRIPT` …) given — undefined for no command.
fn command_plan_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = args.get(0).to_rust_string_lossy(scope);
    let Some(&(canonical, _, input_type, action)) = command(&name) else { return };
    let active = crate::dom::nid_arg(scope, &args, 1);
    let cid = crate::dom::realm_id(scope, &args);
    let has_view = args.get(3).is_true();
    let asked = args.get(4).uint32_value(scope).unwrap_or(ASKED_BY_SCRIPT);
    let (step, node) = command_plan(scope, cid, &name, action, active, args.get(2), has_view, asked);
    let arena = realm(scope, cid);
    let plaintext = step == STEP_HOST && node.is_some_and(|host| arena.get(host).is_some_and(plaintext_only));
    let pasting = action == Action::Paste && asked != ASKED_BY_SCRIPT && matches!(step, STEP_CONTROL | STEP_HOST);
    let partition = args.get(5).integer_value(scope).unwrap_or(0) as u64;
    let markup = if pasting && step == STEP_HOST && !plaintext { crate::system_clipboard::text_of(partition, "text/html") } else { Vec::new() };
    let pasted = if !markup.is_empty() {
        markup.clone()
    } else if pasting {
        crate::system_clipboard::text_of(partition, "text/plain")
    } else {
        Vec::new()
    };
    let pasted = data_value(scope, Some(&pasted[..]).filter(|p| !p.is_empty()));
    let items = [
        v8::Integer::new_from_unsigned(scope, step).into(),
        crate::dom::node_value(scope, node),
        v8::Integer::new_from_unsigned(scope, plan_flags(step, action, asked, plaintext, !markup.is_empty())).into(),
        str_value(scope, input_type),
        str_value(scope, canonical),
        pasted,
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// The element a clipboard event is fired at (Clipboard API "fire a clipboard event" — whose "focused node" is
// w3c/clipboard-apis#70, open — as Chrome and Firefox both have it, editable context or not): a focused text control;
// else the element holding the start of the selection's range; else the body, a focused button's selection-less page
// too.
fn clipboard_event_target(scope: &mut v8::PinScope<'_, '_>, cid: i32, active: Option<NodeId>, selection: v8::Local<'_, v8::Value>) -> Option<NodeId> {
    if let Some(control) = typed_control(realm(scope, cid), active) {
        return Some(control);
    }
    let start = crate::selection::document_start(scope, cid, selection);
    let doc = crate::selection::document_of(scope, selection)?;
    let arena = realm(scope, cid);
    let mut at = start;
    while let Some(n) = at {
        if arena.is_element(n) {
            return Some(n);
        }
        at = arena.parent_of(n);
    }
    arena.relative(doc, crate::dom::RELATIVE_BODY)
}
// __dom.clipboardEventTarget(activeNid | -1, selection | null) -> `clipboard_event_target`, null for none.
fn clipboard_event_target_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let active = crate::dom::nid_arg(scope, &args, 0);
    let cid = crate::dom::realm_id(scope, &args);
    let target = clipboard_event_target(scope, cid, active, args.get(1));
    rv.set(crate::dom::node_value(scope, target));
}
// __dom.clipboardMarkup(fragmentNid, startNid, endNid) -> what a copy holds of a Range's contents as markup: the clone of
// them `fragment`, in the inline elements that hold the whole of it (`<b>f[o]o</b>` is `<b>o</b>`, its ancestors' up to
// the block or the editing host holding it, as Chrome and Firefox copy it).
fn clipboard_markup_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let (Some(fragment), Some(start), Some(end)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1), crate::dom::nid_arg(scope, &args, 2)) else { return };
    let arena = realm(scope, cid);
    let mut holders = Vec::new();
    let mut at = Some(crate::ranges::common_ancestor(arena, start, end));
    while let Some(n) = at {
        if arena.is_element(n) {
            if arena.editing_host(n) == Some(n) || crate::editing::inline_level(arena, n) != Some(true) {
                break;
            }
            holders.push(n);
        }
        at = arena.parent_of(n);
    }
    let out = crate::serialize::html_in(arena, fragment, &holders);
    rv.set(crate::dom::utf16_value(scope, &out));
}
// __dom.clipboardWriteControl(partition, controlNid): what is selected in the text control copied (`selected_text`) —
// nothing selected leaving the clipboard as it was.
fn clipboard_write_control_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let partition = args.get(0).integer_value(scope).unwrap_or(0) as u64;
    let Some(id) = crate::dom::nid_arg(scope, &args, 1) else { return };
    let Some(cid) = crate::dom::dom(scope).arena.get(id).map(|n| n.realm) else { return };
    if let Some(text) = realm(scope, cid).selected_text(id) {
        crate::system_clipboard::write_selected(partition, &text, "");
    }
}

// What a command's edit of a text control comes to: what it changed (text_selection.rs `TYPED_*`), whether `input` fires
// for it, its `data` and `inputType`.
#[derive(Debug, PartialEq)]
struct ControlEdited {
    changed: u32,
    fire: bool,
    data: Option<Vec<u16>>,
    input_type: &'static str,
}
// A command's edit of the text control `id`, its `value` what goes in — where `at` says (`TYPE_*`: the selection a script
// reads, or the one a user made) — as Chrome takes it; a user edit, so a `change` is owed on blur. Text and markup's text
// fire `input` where something went in or the selection was replaced (`maxlength` may leave no room, a number field refuse
// it: none there, and one for text the same as what it replaced), its `data` what went in — markup's in an input
// `insertText`, a textarea's with neither `inputType` nor `data` and whatever went in (Chrome; Firefox inserts nothing and
// no spec says); a cut and a paste always, a paste's `data` what went in (a text control's: Input Events §4); a deletion
// Backspace's or Delete's at the selection a script reads — its start where none was ever set, Chrome's caret after
// focus() — where the value changed; a line break where it went in, into a textarea: an input takes none and stays as it
// was (Chrome).
fn control_command(arena: &mut RealmArena, id: NodeId, action: Action, input_type: &'static str, value: &[u16], at: u32) -> ControlEdited {
    use crate::text_selection::{EDIT_AT_SELECTION, EDIT_BACKSPACE, EDIT_DELETE, TYPED_VALUE};
    let selected = arena.text_selection(id).0;
    let selected = selected.start != selected.end;
    let textarea = arena.get(id).is_some_and(|n| n.is_html_named("textarea"));
    let mut edited = ControlEdited { changed: 0, fire: false, data: None, input_type };
    match action {
        Action::Delete | Action::ForwardDelete => {
            let key = if action == Action::ForwardDelete { EDIT_DELETE } else { EDIT_BACKSPACE };
            edited.changed = arena.edit_control(id, key | EDIT_AT_SELECTION);
            edited.fire = edited.changed & TYPED_VALUE != 0;
            if edited.fire {
                arena.mark_change(id, true);
            }
        }
        Action::LineBreak | Action::Paragraph if !textarea => {}
        Action::LineBreak | Action::Paragraph => {
            let (changed, typed) = arena.type_text(id, &[0x0A], at);
            arena.mark_change(id, true);
            edited.changed = changed;
            edited.fire = !typed.is_empty();
        }
        Action::Cut => {
            edited.changed = arena.type_text(id, &[], at).0;
            arena.mark_change(id, true);
            edited.fire = true;
        }
        _ => {
            let (changed, typed) = arena.type_text(id, value, at);
            arena.mark_change(id, true);
            edited.changed = changed;
            match action {
                Action::Paste => edited.fire = true,
                Action::Html if textarea => edited.fire = true,
                Action::Html => edited.input_type = "insertText",
                _ => {}
            }
            edited.fire |= !typed.is_empty() || selected;
            // (…a paste of a clipboard holding no text none: Chrome)
            let no_data = (action == Action::Html && textarea) || (action == Action::Paste && value.is_empty());
            if !no_data {
                edited.data = Some(typed);
            }
        }
    }
    edited
}
// __dom.controlCommand(control, command, value, byUser) -> [what it changed, fire, data, inputType] (`control_command`),
// the command's edit of the text control the plan named — at the selection a script reads, or, `byUser`, the one the user
// made (an email or a number field's too, which a script reads none of).
fn control_command_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let control = args.get(0);
    let Some(id) = crate::node_handle::nid_of(scope, control) else { return };
    let Some(&(_, _, input_type, action)) = command(&args.get(1).to_rust_string_lossy(scope)) else { return };
    let value = crate::dom::utf16_arg(scope, args.get(2));
    let at = if args.get(3).is_true() { crate::text_selection::TYPE_AT_CARET } else { crate::text_selection::TYPE_AT_SELECTION };
    let Some(cid) = crate::dom::dom(scope).arena.get(id).map(|n| n.realm) else { return };
    let edited = control_command(realm(scope, cid), id, action, input_type, &value, at);
    if edited.changed & crate::text_selection::TYPED_VALUE != 0 {
        crate::node_handle::forget_live_value(scope, control);
    }
    let items = [
        v8::Integer::new_from_unsigned(scope, edited.changed).into(),
        v8::Boolean::new(scope, edited.fire).into(),
        data_value(scope, edited.data.as_deref()),
        str_value(scope, edited.input_type),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// The style attribute a styling command's span carries, and the `input` event's `data`: `property: value` as an inline
// style of the document serializes it, in its mode (a quirks one's hashless colour) — '' for a value that does not parse,
// which styles nothing; the data a colour as the value's CSS serialization — a legacy-syntax one's (a name, a hex, rgb()),
// lowercased where it is a bare word, `currentcolor` and the CSS-wide keywords so; the string itself where it does not
// parse — Chrome's report; a font name as given.
fn command_style(scope: &mut v8::PinScope<'_, '_>, cid: i32, quirks: bool, property: &str, value: &str) -> (String, String) {
    let key = crate::cssom_decl::Key::new("", crate::cssom_decl::Kind::Style, quirks, "about:blank");
    let text = crate::cssom_decl::set(&key, None, property, value, false).map(|w| w.text).unwrap_or_default();
    let data = if property.ends_with("color") {
        let trimmed = value.trim_matches(|c: char| c.is_ascii_whitespace());
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
        value.to_owned()
    };
    (text, data)
}

// (…an element of the local name `tag`, ASCII case-insensitively, in any namespace: the tags the commands compare)
fn tag_is(arena: &RealmArena, id: NodeId, tag: &str) -> bool {
    arena.get(id).is_some_and(|n| n.kind == NodeKind::Element && (*n.local_name).eq_ignore_ascii_case(tag))
}

// Where the selection goes after a command: left where it is, collapsed at a place, around a node; or collapsed at a
// place after an edit that moved its range already, so the change is one to announce however the collapse finds it.
enum Caret {
    Keep,
    At(NodeId, u32),
    Around(NodeId, u32, NodeId, u32),
    Moved(NodeId, u32),
}

// __dom.editCommand(hostNid, anchorNid, anchorOffset, focusNid, focusOffset, command, value, documentNid, steps) -> [fire,
// data, alignment, caret, place…, styled, nodes…, copies, changes…], or undefined for a command it does not know or a
// selection out of the host: the edit of `command` (`value` its argument) in the editing host `host` over the selection —
// whether the bindings fire `input` for it, with what `data`; the `text-align` they give the elements it answers ('' to
// clear their style); where the selection goes (`Caret`: 0 left, 1 collapsed: node, offset, 2 around: node, offset, node,
// offset, 3 collapsed, a change to announce: node, offset); the elements whose CSS the bindings set; then, as `editInsert`
// answers them, the elements it copied and the changes of children it made.
//
// The commands of the plain text kinds — text, markup's text, a deletion, a break, a cut and a paste — say whether anything went in or
// came out, and answer the same for a selection nowhere they can edit: `input` is fired where it did and none where it
// did not, true all the same (Chrome): text the selection's deletion for none, a cut's `input` only where it deleted, a
// paste's whatever it held (Chrome). Every other is the edit of the selection's range, in the editing host it is in.
fn edit_command(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(host), Some(anchor), Some(focus)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1), crate::dom::nid_arg(scope, &args, 3)) else { return };
    let (ao, fo) = (args.get(2).uint32_value(scope).unwrap_or(0), args.get(4).uint32_value(scope).unwrap_or(0));
    let Some(&(canonical, _, _, action)) = command(&args.get(5).to_rust_string_lossy(scope)) else { return };
    let value = crate::dom::utf16_arg(scope, args.get(6));
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(8)) else { return };
    let caller = crate::dom::realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(host).map(|n| n.realm) else { return };
    crate::cloning::begin_clone(scope);
    let steps = v8::Local::new(scope, steps);
    let (a, f) = ((anchor, ao), (focus, fo));
    let (mut fire, mut data, mut align, mut caret, mut styled) = (false, None, "", Caret::Keep, Vec::new());
    let (mut changes, mut copies, mut held) = (Vec::new(), Vec::new(), Vec::new());
    match action {
        Action::Text | Action::Html | Action::Paste | Action::LineBreak | Action::Paragraph if !(matches!(action, Action::Text | Action::Html) && value.is_empty()) => {
            let kind = match action {
                Action::LineBreak => crate::editing_insert::LINE_BREAK,
                Action::Paragraph => crate::editing_insert::PARAGRAPH,
                _ => crate::editing_insert::TEXT,
            };
            if let Some(made) = crate::editing_insert::insertion(scope, caller, steps, a, f, kind, &value) {
                fire = true;
                caret = made.caret.map_or(Caret::Keep, |(node, offset)| Caret::Moved(node, offset));
                (changes, copies, held) = (made.changes, made.copies, made.held);
            }
            fire |= action == Action::Paste;
            if action == Action::Text {
                data = Some(value);
            }
        }
        Action::Delete | Action::ForwardDelete | Action::Text | Action::Html | Action::Cut => {
            // (…of a selection, where these ask one: `execCommand('insertText', false, '')` at a caret, none)
            let selection_only = matches!(action, Action::Text | Action::Html | Action::Cut);
            if !(selection_only && a == f) {
                if let Some((_, place, made)) = crate::editing_delete::deletion(scope, &args, steps, a, f, action == Action::ForwardDelete, false) {
                    fire = true;
                    caret = Caret::Moved(place.0, place.1);
                    changes = made;
                }
            }
            if action == Action::Text {
                data = Some(value);
            }
        }
        _ => {
            // (…its range as the selection's in the editing host it is in — its anchor's, the focus clamped to it, nothing
            // selected in a comment: editing.rs `selection_host` — where `host` is the anchor's root editable element (a
            // `contenteditable=true` nested in an editable one edits in its own, the outer root firing `input`); a selection
            // of another host's, or none, edits nothing: Chrome)
            let arena = realm(scope, cid);
            let Some((host, range)) = crate::editing::selection_host(arena, a, f).filter(|_| arena.editing_root(anchor) == Some(host)) else { return };
            let mut edit = Edit { cid, caller, steps, host, changes: &mut changes, copies: &mut copies, held: &mut held };
            let value_text = String::from_utf16_lossy(&value);
            let done = match action {
                Action::Style(property) => {
                    let quirks = crate::dom::quirks_arg(scope, &args, 7);
                    let (style, reported) = command_style(scope, cid, quirks, property, &value_text);
                    data = Some(reported.encode_utf16().collect());
                    // (…a value that styles nothing makes no span: the `input` alone where it would have styled the
                    // selection — none for a caret, as a value that styles fires none there: Chrome)
                    if style.is_empty() {
                        Some((range.0 != range.1, Caret::Keep, Vec::new()))
                    } else {
                        let units: Vec<u16> = style.encode_utf16().collect();
                        wrap(scope, &mut edit, range, "span", None, Some(("style", &units[..])))
                    }
                }
                Action::Align(alignment) => {
                    align = alignment;
                    justify(scope, &mut edit, range.0)
                }
                Action::RemoveFormat => {
                    let block = selection_block(realm(scope, cid), host, range.0, true);
                    Some((true, Caret::Keep, block.filter(|&b| b != host).into_iter().collect()))
                }
                Action::Link => {
                    data = Some(value.clone());
                    wrap(scope, &mut edit, range, "a", None, Some(("href", &value[..])))
                }
                Action::Edit => match canonical {
                    "insertorderedlist" => list(scope, &mut edit, range.0, "ol"),
                    "insertunorderedlist" => list(scope, &mut edit, range.0, "ul"),
                    "bold" => wrap(scope, &mut edit, range, "b", None, None),
                    "italic" => wrap(scope, &mut edit, range, "i", None, None),
                    "underline" => wrap(scope, &mut edit, range, "u", None, None),
                    "strikethrough" => wrap(scope, &mut edit, range, "strike", None, None),
                    "superscript" => wrap(scope, &mut edit, range, "sup", Some("sub"), None),
                    "subscript" => wrap(scope, &mut edit, range, "sub", Some("sup"), None),
                    "indent" => indent(scope, &mut edit, range.0),
                    "outdent" => outdent(scope, &mut edit, range.0),
                    "unlink" => unlink(scope, &mut edit, range),
                    "inserthorizontalrule" => horizontal_rule(scope, &mut edit, range),
                    _ => return,
                },
                _ => return,
            };
            // (…where a copy's shadow root threw, what it changed answered all the same, the selection kept, for the
            // bindings to finish before they throw it: `takeCloneException`)
            (fire, caret, styled) = match done {
                Some(done) => done,
                None if crate::dom::dom(scope).clone_exception.is_some() => (false, Caret::Keep, Vec::new()),
                None => return,
            };
        }
    }
    answer_edit(scope, &mut rv, cid, fire, data.as_deref(), align, caret, &styled, &copies, &changes, held);
}

// __dom.editInsertFragment(hostNid, anchorNid, anchorOffset, focusNid, focusOffset, fragmentNid, steps) -> as `editCommand`
// answers (`input` fired; its `data` none), or undefined where nothing goes in: the children of `fragment`, a document
// fragment of the document's, at the start of the selection in the editing host `host` (the Editing draft's insertHTML:
// the selection deleted before the fragment is made, in the place that left), the caret after the last of them (`Edit::fragment`).
fn edit_insert_fragment(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(host), Some(anchor), Some(focus), Some(fragment)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1), crate::dom::nid_arg(scope, &args, 3), crate::dom::nid_arg(scope, &args, 5)) else { return };
    let (ao, fo) = (args.get(2).uint32_value(scope).unwrap_or(0), args.get(4).uint32_value(scope).unwrap_or(0));
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(6)) else { return };
    let caller = crate::dom::realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(host).map(|n| n.realm) else { return };
    crate::cloning::begin_clone(scope);
    let steps = v8::Local::new(scope, steps);
    let arena = realm(scope, cid);
    let Some((host, range)) = crate::editing::selection_host(arena, (anchor, ao), (focus, fo)).filter(|_| arena.editing_root(anchor) == Some(host)) else { return };
    let kids = arena.get(fragment).map_or_else(Vec::new, |n| n.children.clone());
    if kids.is_empty() {
        return;
    }
    let (mut changes, mut copies, mut held) = (Vec::new(), Vec::new(), Vec::new());
    let mut edit = Edit { cid, caller, steps, host, changes: &mut changes, copies: &mut copies, held: &mut held };
    let caret = match edit.fragment(scope, range.0, &kids) {
        Some((node, offset)) => Caret::At(node, offset),
        None if crate::dom::dom(scope).clone_exception.is_some() => Caret::Keep,
        None => return,
    };
    answer_edit(scope, &mut rv, cid, true, None, "", caret, &[], &copies, &changes, held);
}

// (…what `editCommand` answers)
#[allow(clippy::too_many_arguments)]
fn answer_edit(
    scope: &mut v8::PinScope<'_, '_>,
    rv: &mut v8::ReturnValue<'_, v8::Value>,
    cid: i32,
    fire: bool,
    data: Option<&[u16]>,
    align: &str,
    caret: Caret,
    styled: &[NodeId],
    copies: &crate::cloning::BindingsSteps,
    changes: &[crate::mutation::Change],
    held: Vec<v8::cppgc::Persistent<crate::node_handle::NodeHandle>>,
) {
    let mut out: Vec<v8::Local<'_, v8::Value>> = vec![
        v8::Boolean::new(scope, fire).into(),
        data_value(scope, data),
        str_value(scope, align),
    ];
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
        Caret::Moved(node, offset) => {
            out.push(v8::Integer::new(scope, 3).into());
            vec![(node, offset)]
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
    let styled = crate::dom::nodes_value(scope, cid, styled);
    let Ok(styled) = v8::Local::<v8::Array>::try_from(styled) else { return };
    for k in 0..styled.length() {
        out.push(styled.get_index(scope, k).unwrap_or_else(|| v8::null(scope).into()));
    }
    out.push(v8::Integer::new_from_unsigned(scope, copies.len() as u32).into());
    out.extend(crate::cloning::bindings_value(scope, cid, copies));
    out.extend(crate::mutation::changes_value(scope, cid, changes));
    if crate::dom::factory_threw(scope) {
        return;
    }
    drop(held);
    rv.set(v8::Array::new_with_elements(scope, &out).into());
}

// What a paste makes no part of the page of the markup it is given, as Chrome and Firefox both take it (the Clipboard API
// says "the most suitable content", and "if the implementation supports pasting HTML" leaves the rest to it): the elements
// that run, load or say something of a document — a script; a frame, an object, an embed (Firefox; Chrome falls back to
// the text for those, and keeps a frame); a document's own metadata — and comments; of the rest, `on*` handlers and the
// URL attributes that would run a script (`<a href="javascript:…">`). A template's contents are no part of it.
const PASTE_DROPS: [&str; 11] = ["script", "iframe", "frame", "frameset", "object", "embed", "applet", "meta", "title", "base", "link"];
const PASTE_URLS: [&str; 7] = ["href", "src", "action", "formaction", "data", "xlink:href", "background"];
fn paste_removals(arena: &RealmArena, fragment: NodeId) -> (Vec<NodeId>, Vec<(NodeId, String)>) {
    let (mut nodes, mut attributes) = (Vec::new(), Vec::new());
    let mut stack: Vec<NodeId> = arena.get(fragment).map_or_else(Vec::new, |n| n.children.clone());
    while let Some(id) = stack.pop() {
        let Some(n) = arena.get(id) else { continue };
        match n.kind {
            NodeKind::Comment | NodeKind::ProcessingInstruction => nodes.push(id),
            NodeKind::Element if PASTE_DROPS.iter().any(|d| (*n.local_name).eq_ignore_ascii_case(d)) => nodes.push(id),
            NodeKind::Element => {
                for (name, value) in &n.attributes {
                    let handler = name.len() > 2 && name.as_bytes()[..2].eq_ignore_ascii_case(b"on");
                    let scripted = PASTE_URLS.iter().any(|u| name.eq_ignore_ascii_case(u)) && runs_script(value);
                    if handler || scripted {
                        attributes.push((id, name.to_string()));
                    }
                }
                stack.extend(n.children.iter().copied());
            }
            _ => {}
        }
    }
    (nodes, attributes)
}
// Whether a URL attribute's value is a `javascript:` one, as a URL parser reads it: past C0 controls and spaces, tabs and
// newlines anywhere in it dropped.
fn runs_script(value: &str) -> bool {
    let scheme = value.trim_start_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\n' | '\r'));
    let lower: String = scheme.take(11).map(|c| c.to_ascii_lowercase()).collect();
    lower == "javascript:"
}
// __dom.pasteRemovals(fragmentNid) -> [nodes, element, attribute, …]: what the bindings take out of a paste's fragment
// before it goes in (`paste_removals`).
fn paste_removals_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(fragment) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let (nodes, attributes) = paste_removals(realm(scope, cid), fragment);
    let mut out = vec![crate::dom::nodes_value(scope, cid, &nodes)];
    for (element, name) in attributes {
        out.push(crate::dom::node_value(scope, Some(element)));
        out.push(str_value(scope, &name));
    }
    if crate::dom::factory_threw(scope) {
        return;
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::NodeData;
    use crate::text_selection::{Direction, TYPE_AT_SELECTION, TYPED_VALUE};
    use web_atoms::ns;

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn a_plan_says_what_goes_round_the_edit() {
        // (…a script's edit fires `input` alone, a user's cut and paste a cancelable beforeinput too)
        let plan = |step, action, asked| plan_flags(step, action, asked, false, false);
        assert_eq!(plan(STEP_CONTROL, Action::Text, ASKED_BY_SCRIPT), 0);
        assert_eq!(plan(STEP_HOST, Action::Cut, SCRIPT_AFTER_EVENT), PLAN_WRITE_SELECTION);
        assert_eq!(plan(STEP_HOST, Action::Cut, GESTURE_AFTER_EVENT), PLAN_WRITE_SELECTION | PLAN_BEFORE_INPUT);
        assert_eq!(plan(STEP_CONTROL, Action::Paste, GESTURE_AFTER_EVENT), PLAN_BEFORE_INPUT);
        assert_eq!(plan(STEP_HOST, Action::Paste, GESTURE_AFTER_EVENT), PLAN_BEFORE_INPUT | PLAN_PASTE_TRANSFER);
        assert_eq!(plan(STEP_HOST, Action::Paste, SCRIPT_AFTER_EVENT), PLAN_PASTE_TRANSFER);
        assert_eq!(plan(STEP_CONTROL, Action::Html, ASKED_BY_SCRIPT), PLAN_MARKUP_TEXT);
        assert_eq!(plan(STEP_HOST, Action::Html, ASKED_BY_SCRIPT), PLAN_MARKUP_FRAGMENT);
        // (…markup a `plaintext-only` host takes as text; a paste's fragment only where the clipboard holds markup, and a
        // host that takes it)
        assert_eq!(plan_flags(STEP_HOST, Action::Html, ASKED_BY_SCRIPT, true, false), PLAN_MARKUP_TEXT);
        assert_eq!(plan_flags(STEP_HOST, Action::Paste, SCRIPT_AFTER_EVENT, false, true), PLAN_PASTE_TRANSFER | PLAN_PASTED_FRAGMENT);
        assert_eq!(plan_flags(STEP_HOST, Action::Paste, SCRIPT_AFTER_EVENT, true, true), PLAN_PASTE_TRANSFER);
        assert_eq!(plan_flags(STEP_CONTROL, Action::Paste, SCRIPT_AFTER_EVENT, false, true), 0);
    }

    fn control(arena: &mut RealmArena, tag: &str, value: &str) -> NodeId {
        let mut n = NodeData::of_kind(NodeKind::Element, Vec::new());
        n.local_name = tag.into();
        n.ns = ns!(html);
        let id = arena.create(n, None);
        arena.write_live_value(id, Some(u(value).into_boxed_slice()));
        id
    }

    #[test]
    fn a_control_edit_says_whether_input_fires() {
        let mut arena = RealmArena::default();
        let arena = &mut arena;
        let ta = control(arena, "textarea", "hello");
        let at = TYPE_AT_SELECTION;
        arena.set_text_selection(ta, 1, 1, Direction::None);
        // (…text: what went in, nothing at a caret firing none)
        let e = control_command(arena, ta, Action::Text, "insertText", &u("x"), at);
        assert_eq!((e.fire, e.data, e.changed & TYPED_VALUE != 0), (true, Some(u("x")), true));
        let e = control_command(arena, ta, Action::Text, "insertText", &[], at);
        assert_eq!((e.fire, e.data), (false, Some(Vec::new())));
        // (…and nothing over a selection firing all the same)
        arena.set_text_selection(ta, 0, 2, Direction::None);
        let e = control_command(arena, ta, Action::Text, "insertText", &[], at);
        assert_eq!((e.fire, e.data), (true, Some(Vec::new())));
        // (…a cut no data, a paste what went in; markup's text as a textarea takes it)
        arena.set_text_selection(ta, 0, 1, Direction::None);
        let e = control_command(arena, ta, Action::Cut, "deleteByCut", &[], at);
        assert_eq!((e.fire, e.data), (true, None));
        let e = control_command(arena, ta, Action::Paste, "insertFromPaste", &u("p"), at);
        assert_eq!((e.fire, e.data), (true, Some(u("p"))));
        let e = control_command(arena, ta, Action::Paste, "insertFromPaste", &[], at);
        assert_eq!((e.fire, e.data), (true, None));
        let e = control_command(arena, ta, Action::Html, "", &u("m"), at);
        assert_eq!((e.fire, e.data, e.input_type), (true, None, ""));
        // (…a line break: `data` none, into a textarea)
        let e = control_command(arena, ta, Action::LineBreak, "insertLineBreak", &[], at);
        assert_eq!((e.fire, e.data), (true, None));
        let line = control(arena, "input", "ab");
        let e = control_command(arena, line, Action::LineBreak, "insertLineBreak", &[], at);
        assert_eq!((e.fire, e.changed), (false, 0));
        // (…markup's text as an input takes it: `insertText`, none for nothing at a caret)
        let e = control_command(arena, line, Action::Html, "", &[], at);
        assert_eq!((e.fire, e.input_type), (false, "insertText"));
        let e = control_command(arena, line, Action::Html, "", &u("q"), at);
        assert_eq!((e.fire, e.data, e.input_type), (true, Some(u("q")), "insertText"));
        // (…a deletion fires only where the value changed)
        arena.set_text_selection(line, 0, 0, Direction::None);
        let e = control_command(arena, line, Action::Delete, "deleteContentBackward", &[], at);
        assert_eq!((e.fire, e.data), (false, None));
    }

    #[test]
    fn a_paste_takes_what_runs_out() {
        let mut arena = RealmArena::default();
        let arena = &mut arena;
        let fragment = arena.create(NodeData::of_kind(NodeKind::Fragment, Vec::new()), None);
        let element = |arena: &mut RealmArena, parent, tag: &str, attributes: &[(&str, &str)]| {
            let mut n = NodeData::of_kind(NodeKind::Element, Vec::new());
            n.local_name = tag.into();
            n.ns = ns!(html);
            n.attributes = attributes.iter().map(|&(name, value)| (name.to_owned(), value.to_owned())).collect();
            arena.create(n, Some(parent))
        };
        let script = element(arena, fragment, "script", &[]);
        let link = element(arena, fragment, "a", &[("href", "  java\tscript:alert(1)"), ("onclick", "x"), ("title", "keep"), ("on", "keep")]);
        let safe = element(arena, link, "b", &[]);
        let comment = arena.create(NodeData::of_kind(NodeKind::Comment, Vec::new()), Some(safe));
        let (nodes, attributes) = paste_removals(arena, fragment);
        assert_eq!(nodes.len(), 2);
        assert!(nodes.contains(&script) && nodes.contains(&comment));
        let mut names: Vec<&str> = attributes.iter().map(|(_, n)| n.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["href", "onclick"]);
        assert!(!runs_script("https://x/"));
        assert!(runs_script("JAVASCRIPT:1"));
    }

    #[test]
    fn a_password_gives_a_clipboard_nothing() {
        let mut arena = RealmArena::default();
        let arena = &mut arena;
        let plain = control(arena, "input", "secret");
        arena.set_text_selection(plain, 0, 3, Direction::None);
        assert_eq!(arena.selected_text(plain).as_deref(), Some("sec"));
        arena.set_text_selection(plain, 2, 2, Direction::None);
        assert_eq!(arena.selected_text(plain), None);
    }
}
