// A text control's selection (HTML §4.10.6 "APIs for the text control selections"): the offsets of its selection —
// its text entry cursor where collapsed — into its RELEVANT VALUE (the value the user edits: a dirty one as typed, a
// clean `<input>`'s attribute sanitized for its type, a `<textarea>`'s child text with its newlines normalized), and
// the selection's direction. Kept by the engine for each
// `<input>` / `<textarea>` that has had one (none until then: `selectionStart` reads 0, the driver's typing goes to the
// end), clamped to the value as it is when read; "set the selection range", `setRangeText()` and the cursor the user
// moves all write it. Whether the change is one to send `select` and `selectionchange` for, the bindings hear.

use crate::dom::{nid_arg, utf16_arg, NodeData, NodeId, RealmArena};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) struct TextSelection {
    pub(crate) start: u32,
    pub(crate) end: u32,
    pub(crate) direction: Direction,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) enum Direction {
    #[default]
    None,
    Forward,
    Backward,
}

impl Direction {
    fn parse(s: &str) -> Direction {
        match s {
            "forward" => Direction::Forward,
            "backward" => Direction::Backward,
            _ => Direction::None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Direction::None => "none",
            Direction::Forward => "forward",
            Direction::Backward => "backward",
        }
    }
}

// The input types the selection APIs apply to (`selectionStart`, `setSelectionRange()`, `setRangeText()`); `select()`
// to an email field too (Chrome: its offsets read null, its selection shows in `getSelection()`).
const SELECTION_INPUT_TYPES: [&str; 5] = ["text", "search", "tel", "url", "password"];
const SELECT_INPUT_TYPES: [&str; 6] = ["text", "search", "tel", "url", "password", "email"];

// The input types `maxlength` cuts typing short in (HTML: the text-like ones; a textarea too).
const MAXLENGTH_INPUT_TYPES: [&str; 6] = ["text", "search", "tel", "url", "email", "password"];
// What typing into a control changed (`type_text`): its value, its selection.
pub(crate) const TYPED_VALUE: u32 = 1;
pub(crate) const TYPED_SELECTION: u32 = 2;
// The editing keys a text control takes (`edit_control`).
const EDIT_BACKSPACE: u32 = 0;
const EDIT_DELETE: u32 = 1;
const EDIT_LEFT: u32 = 2;
const EDIT_RIGHT: u32 = 3;
const EDIT_HOME: u32 = 4;
const EDIT_END: u32 = 5;

// Why `setRangeText()` refused.
#[derive(Debug, PartialEq)]
pub(crate) enum RangeTextError {
    // The control's type has no selection: InvalidStateError.
    NotApplicable,
    // The start past the end: IndexSizeError.
    Index,
}

impl RealmArena {
    // Do the selection APIs apply to `n`: a `<textarea>`, or an `<input>` of a type they apply to? (`select()`, with
    // `for_select`, to an email field too.)
    pub(crate) fn selection_applies(&self, n: &NodeData, for_select: bool) -> bool {
        let types: &[&str] = if for_select { &SELECT_INPUT_TYPES } else { &SELECTION_INPUT_TYPES };
        n.is_html_named("textarea") || (n.is_html_named("input") && types.contains(&n.input_type()))
    }

    // `n`'s relevant value.
    pub(crate) fn relevant_value(&self, n: &NodeData) -> Vec<u16> {
        if n.value.is_some() || !n.is_html_named("input") {
            return self.raw_value_units(n);
        }
        let attr = n.plain_attr_units("value").unwrap_or_default();
        crate::input_value::sanitize_units(n.input_type(), &attr, &crate::input_value::Attrs::of(n), &|v| v.to_string())
    }
    // …its length, counted where that needs no copy: a dirty value's, a textarea's child text with each CR LF one.
    fn relevant_value_len(&self, n: &NodeData) -> u32 {
        if let Some(v) = &n.value {
            return v.len() as u32;
        }
        if !n.is_html_named("textarea") {
            return self.relevant_value(n).len() as u32;
        }
        let mut len = 0u32;
        let mut after_cr = false;
        for t in n.children.iter().filter_map(|&c| self.get(c)).filter(|t| t.kind == crate::dom::NodeKind::Text) {
            for &u in t.data.iter() {
                if !(after_cr && u == 0x0A) {
                    len += 1;
                }
                after_cr = u == 0x0D;
            }
        }
        len
    }

    // The user typing `text` into the control `id`: what it inserts replacing its selection (the caret at its value's
    // end where none was ever set) — or, `whole`, its value, as a driver's fill does — the text entry cursor after it — but no keystroke that leaves a number field's text
    // no prefix of a scientific number being entered ("1e+1" takes no second sign; "1.", "1e", "1e+" stand), and what
    // passes `maxlength` cut off where it applies (a textarea, a text-like input). What it changed (`TYPED_*`); the value
    // written is the engine's, the string the bindings held of it forgotten by the caller.
    pub(crate) fn type_text(&mut self, id: NodeId, text: &[u16], whole: bool) -> u32 {
        let Some(n) = self.get(id) else { return 0 };
        let current = self.relevant_value(n);
        let number = n.is_html_named("input") && n.input_type() == "number";
        let cuts = n.is_html_named("textarea") || (n.is_html_named("input") && MAXLENGTH_INPUT_TYPES.contains(&n.input_type()));
        let max = if cuts { n.plain_attr("maxlength").and_then(crate::validity::parse_non_negative).filter(|&m| m > 0) } else { None };
        let (sel, set) = self.text_selection(id);
        let (start, end) = match (whole, set) {
            (true, _) => (0, current.len()),
            (false, true) => (sel.start as usize, sel.end as usize),
            (false, false) => (current.len(), current.len()),
        };
        let (start, end) = (start.min(current.len()), end.min(current.len()));
        let mut next = Vec::with_capacity(current.len() + text.len());
        next.extend_from_slice(&current[..start]);
        next.extend_from_slice(text);
        next.extend_from_slice(&current[end..]);
        if number && !number_being_entered(&next) {
            return 0;
        }
        if let Some(max) = max {
            next.truncate(max as usize);
        }
        let caret = next.len().min(start + text.len()) as u32;
        let mut changed = 0;
        if self.write_live_value(id, Some(next.into_boxed_slice())) {
            changed |= TYPED_VALUE;
        }
        if self.set_text_selection(id, caret, caret, Direction::None) {
            changed |= TYPED_SELECTION;
        }
        changed
    }

    // An editing key pressed in the control `id`, as Chrome takes it: Backspace / Delete remove the selection, or the
    // character before / after the caret (a surrogate pair one); ArrowLeft / ArrowRight collapse a selection to its
    // start / end, or move the caret by a character; Home / End go to the start / end of the line the caret is on (a
    // textarea's — its value's line, between line feeds — or an input's whole value). What it changed (`TYPED_*`).
    pub(crate) fn edit_control(&mut self, id: NodeId, edit: u32) -> u32 {
        let Some(n) = self.get(id) else { return 0 };
        let value = self.relevant_value(n);
        let multiline = n.is_html_named("textarea");
        let len = value.len();
        let (sel, set) = self.text_selection(id);
        let (start, end) = if set { (sel.start as usize, sel.end as usize) } else { (len, len) };
        let back = |i: usize| if i >= 2 && is_low(value[i - 1]) && is_high(value[i - 2]) { i - 2 } else { i.saturating_sub(1) };
        let on = |i: usize| if i + 1 < len && is_high(value[i]) && is_low(value[i + 1]) { i + 2 } else { (i + 1).min(len) };
        let line_start = |i: usize| if multiline { value[..i].iter().rposition(|&u| u == 0x0A).map_or(0, |p| p + 1) } else { 0 };
        let line_end = |i: usize| if multiline { value[i..].iter().position(|&u| u == 0x0A).map_or(len, |p| i + p) } else { len };
        let (removed, caret) = match edit {
            EDIT_BACKSPACE | EDIT_DELETE if end > start => (Some(start..end), start),
            EDIT_BACKSPACE if start > 0 => (Some(back(start)..start), back(start)),
            EDIT_DELETE if start < len => (Some(start..on(start)), start),
            EDIT_BACKSPACE | EDIT_DELETE => return 0,
            EDIT_LEFT => (None, if end > start { start } else { back(start) }),
            EDIT_RIGHT => (None, if end > start { end } else { on(end) }),
            EDIT_HOME => (None, line_start(start)),
            EDIT_END => (None, line_end(end)),
            _ => return 0,
        };
        let mut changed = 0;
        if let Some(range) = removed {
            let mut next = value;
            next.drain(range);
            if self.write_live_value(id, Some(next.into_boxed_slice())) {
                changed |= TYPED_VALUE;
            }
        }
        if self.set_text_selection(id, caret as u32, caret as u32, Direction::None) {
            changed |= TYPED_SELECTION;
        }
        changed
    }

    // `id`'s selection as it stands — clamped to its value's length, which may have shrunk by a path that moved no
    // cursor (a `type` change re-sanitizing, a reset, a clean `<textarea>`'s children), and kept so — and whether it
    // was ever set.
    pub(crate) fn text_selection(&mut self, id: NodeId) -> (TextSelection, bool) {
        let Some(sel) = self.text_selections.get(&id).copied() else { return (TextSelection::default(), false) };
        let len = self.get(id).map_or(0, |n| self.relevant_value_len(n));
        let clamped = TextSelection { start: sel.start.min(len), end: sel.end.min(len), ..sel };
        self.text_selections.insert(id, clamped);
        (clamped, true)
    }

    // A child taken out of `id`: a non-dirty `<textarea>`'s value is its child text, so its text entry cursor is clamped
    // to what is left — which an insertion after it does not restore: a replacement of its text leaves it at 0 (Chrome and
    // Firefox; Firefox moves it to 0 for any removal).
    pub(crate) fn clamp_text_entry_cursor(&mut self, id: NodeId) {
        let clean_textarea = self.get(id).is_some_and(|n| n.is_html_named("textarea") && n.value.is_none());
        if clean_textarea && self.text_selections.contains_key(&id) {
            self.text_selection(id);
        }
    }

    // HTML "set the selection range" of `id` to `start`..`end` in `direction`: each clamped to the value's length, the
    // start no later than the end. Whether that changed it.
    pub(crate) fn set_text_selection(&mut self, id: NodeId, start: u32, end: u32, direction: Direction) -> bool {
        let len = self.get(id).map_or(0, |n| self.relevant_value_len(n));
        let end = end.min(len);
        let start = start.min(len).min(end);
        let next = TextSelection { start, end, direction };
        self.text_selections.insert(id, next) != Some(next)
    }

    // `setRangeText(replacement, start, end, mode)` of `id` — `start` / `end` the selection's where not given: the value
    // with `replacement` over that range, and the selection after, by `mode` ("select" the replacement, "start" before
    // it, "end" after it, "preserve" — any other — the selection as it was: an edge past the range moved with the text,
    // a start inside it to its start, an end inside it to the replacement's end). Its direction none, as "set the
    // selection range" given none makes it.
    pub(crate) fn range_text(
        &mut self,
        id: NodeId,
        replacement: &[u16],
        range: Option<(u32, u32)>,
        mode: &str,
    ) -> Result<(Vec<u16>, u32, u32, Direction), RangeTextError> {
        let n = self.get(id).ok_or(RangeTextError::NotApplicable)?;
        if !self.selection_applies(n, false) {
            return Err(RangeTextError::NotApplicable);
        }
        let value = self.relevant_value(n);
        let (sel, _) = self.text_selection(id);
        let (start, end) = range.unwrap_or((sel.start, sel.end));
        if start > end {
            return Err(RangeTextError::Index);
        }
        let len = value.len() as u32;
        let (s, e) = (start.min(len), end.min(len));
        let next = [&value[..s as usize], replacement, &value[e as usize..]].concat();
        let replaced_end = s + replacement.len() as u32;
        let (ns, ne) = match mode {
            "select" => (s, replaced_end),
            "start" => (s, s),
            "end" => (replaced_end, replaced_end),
            _ => {
                let delta = replacement.len() as i64 - i64::from(e - s);
                let past = |o: u32| (i64::from(o) + delta) as u32;
                let start = if sel.start > e { past(sel.start) } else if sel.start > s { s } else { sel.start };
                let end = if sel.end > e { past(sel.end) } else if sel.end > s { replaced_end } else { sel.end };
                (start, end)
            }
        };
        Ok((next, ns, ne, Direction::None))
    }
}

fn is_high(u: u16) -> bool {
    (0xD800..0xDC00).contains(&u)
}
fn is_low(u: u16) -> bool {
    (0xDC00..0xE000).contains(&u)
}

// Whether `units` is a prefix of a floating-point number as one is typed — `[-+]?\d*\.?\d*([eE][-+]?\d*)?`.
fn number_being_entered(units: &[u16]) -> bool {
    let mut i = 0;
    let at = |i: usize| units.get(i).copied();
    let digits = |mut i: usize| {
        while at(i).is_some_and(|u| (0x30..=0x39).contains(&u)) {
            i += 1;
        }
        i
    };
    if matches!(at(i), Some(0x2B | 0x2D)) {
        i += 1;
    }
    i = digits(i);
    if at(i) == Some(0x2E) {
        i = digits(i + 1);
    }
    if matches!(at(i), Some(0x45 | 0x65)) {
        i += 1;
        if matches!(at(i), Some(0x2B | 0x2D)) {
            i += 1;
        }
        i = digits(i);
    }
    i == units.len()
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "selectionApplies", selection_applies_op, context_id);
    crate::dom::register(scope, ns, "textSelection", text_selection_op, context_id);
    crate::dom::register(scope, ns, "setTextSelection", set_text_selection_op, context_id);
    crate::dom::register(scope, ns, "rangeTextEdit", range_text_op, context_id);
    crate::dom::register(scope, ns, "typeText", type_text_op, context_id);
    crate::dom::register(scope, ns, "editControl", edit_control_op, context_id);
}

// __dom.selectionApplies(nid, forSelect) -> whether the selection APIs (`select()`, with `forSelect`) apply to the
// control (`selection_applies`).
fn selection_applies_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let for_select = args.get(1).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    rv.set_bool(arena.get(id).is_some_and(|n| arena.selection_applies(n, for_select)));
}

// __dom.textSelection(nid, applicableOnly) -> [start, end, direction, set] (`text_selection`), or null where
// `applicableOnly` and the selection APIs do not apply to the control.
fn text_selection_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let applicable_only = args.get(1).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    if applicable_only && !arena.get(id).is_some_and(|n| arena.selection_applies(n, false)) {
        return;
    }
    let (sel, set) = arena.text_selection(id);
    let items: [v8::Local<'_, v8::Value>; 4] = [
        v8::Integer::new_from_unsigned(scope, sel.start).into(),
        v8::Integer::new_from_unsigned(scope, sel.end).into(),
        v8::String::new(scope, sel.direction.name()).unwrap().into(),
        v8::Boolean::new(scope, set).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.setTextSelection(nid, start, end, direction) -> whether the selection changed (`set_text_selection`).
fn set_text_selection_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let start = args.get(1).uint32_value(scope).unwrap_or(0);
    let end = args.get(2).uint32_value(scope).unwrap_or(0);
    let direction = Direction::parse(&args.get(3).to_rust_string_lossy(scope));
    let cid = crate::dom::realm_id(scope, &args);
    rv.set_bool(crate::dom::realm(scope, cid).set_text_selection(id, start, end, direction));
}

// __dom.rangeTextEdit(nid, replacement, start, end, mode) -> [value, start, end, direction] (`range_text`: the value to write
// and the selection to set after), or 1 where the selection APIs do not apply, 2 for a start past the end. `start` and
// `end` undefined for the selection's.
fn range_text_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_int32(1) };
    let replacement = utf16_arg(scope, args.get(1));
    let range = if args.get(2).is_undefined() {
        None
    } else {
        Some((args.get(2).uint32_value(scope).unwrap_or(0), args.get(3).uint32_value(scope).unwrap_or(0)))
    };
    let mode = if args.get(4).is_undefined() { String::from("preserve") } else { args.get(4).to_rust_string_lossy(scope) };
    let cid = crate::dom::realm_id(scope, &args);
    match crate::dom::realm(scope, cid).range_text(id, &replacement, range, &mode) {
        Ok((value, start, end, direction)) => {
            let items: [v8::Local<'_, v8::Value>; 4] = [
                crate::dom::utf16_value(scope, &value),
                v8::Integer::new_from_unsigned(scope, start).into(),
                v8::Integer::new_from_unsigned(scope, end).into(),
                v8::String::new(scope, direction.name()).unwrap().into(),
            ];
            rv.set(v8::Array::new_with_elements(scope, &items).into());
        }
        Err(RangeTextError::NotApplicable) => rv.set_int32(1),
        Err(RangeTextError::Index) => rv.set_int32(2),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::{NodeData, NodeKind};
    use web_atoms::ns;

    fn input(arena: &mut RealmArena, value: &str) -> NodeId {
        let mut n = NodeData::of_kind(NodeKind::Element, Vec::new());
        n.local_name = "input".into();
        n.ns = ns!(html);
        n.attributes = vec![("value".into(), value.into())];
        arena.create(n, None)
    }
    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn set_and_replace() {
        let mut arena = RealmArena::default();
        let id = input(&mut arena, "hello world");
        assert_eq!(arena.text_selection(id), (TextSelection::default(), false));
        // (…clamped, the start no later than the end; unchanged, no change)
        assert!(arena.set_text_selection(id, 20, 3, Direction::Backward));
        assert_eq!(arena.text_selection(id).0, TextSelection { start: 3, end: 3, direction: Direction::Backward });
        assert!(!arena.set_text_selection(id, 3, 3, Direction::Backward));
        arena.set_text_selection(id, 6, 11, Direction::None);
        assert_eq!(arena.range_text(id, &u("there"), None, "select"), Ok((u("hello there"), 6, 11, Direction::None)));
        assert_eq!(arena.range_text(id, &u("X"), Some((0, 5)), "preserve"), Ok((u("X world"), 2, 7, Direction::None)));
        // (…preserve: a start inside the range to its start, an end inside it to the replacement's end; direction none)
        arena.set_text_selection(id, 2, 8, Direction::Backward);
        assert_eq!(arena.range_text(id, &u("XYZ"), Some((0, 4)), "preserve"), Ok((u("XYZo world"), 0, 7, Direction::None)));
        arena.set_text_selection(id, 2, 3, Direction::Backward);
        assert_eq!(arena.range_text(id, &u("XYZ"), Some((0, 4)), "preserve"), Ok((u("XYZo world"), 0, 3, Direction::None)));
        assert_eq!(arena.range_text(id, &u("X"), Some((4, 2)), "end"), Err(RangeTextError::Index));
    }
}

// __dom.typeText(control, text, whole) -> what typing `text` into the control — over its whole value, `whole` — changed
// (`type_text`'s `TYPED_*` bits).
fn type_text_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let control = args.get(0);
    let Some(id) = crate::node_handle::nid_of(scope, control) else { return rv.set_uint32(0) };
    let text = crate::dom::utf16_arg(scope, args.get(1));
    let cid = crate::dom::realm_id(scope, &args);
    let whole = args.get(2).is_true();
    let changed = crate::dom::realm(scope, cid).type_text(id, &text, whole);
    if changed & TYPED_VALUE != 0 {
        crate::node_handle::forget_live_value(scope, control);
    }
    rv.set_uint32(changed);
}

// __dom.editControl(control, edit) -> what the editing key `edit` (`EDIT_*`) pressed in the control changed
// (`edit_control`'s `TYPED_*` bits).
fn edit_control_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let control = args.get(0);
    let Some(id) = crate::node_handle::nid_of(scope, control) else { return rv.set_uint32(0) };
    let edit = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let cid = crate::dom::realm_id(scope, &args);
    let changed = crate::dom::realm(scope, cid).edit_control(id, edit);
    if changed & TYPED_VALUE != 0 {
        crate::node_handle::forget_live_value(scope, control);
    }
    rv.set_uint32(changed);
}
