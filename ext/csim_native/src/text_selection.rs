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
// What typing into a control changed (`type_text`): its value, its selection — and, above `TYPED_LENGTH_SHIFT`, how many
// code units of the text went in.
pub(crate) const TYPED_VALUE: u32 = 1;
pub(crate) const TYPED_SELECTION: u32 = 2;
const TYPED_LENGTH_SHIFT: u32 = 2;
// Where typed text goes (`type_text`): at the selection, the caret at the value's end where none was ever set (the
// user's keystrokes); over the whole value (a driver's fill); at the selection a script reads, its start where none was
// set (execCommand, the clipboard).
pub(crate) const TYPE_AT_CARET: u32 = 0;
pub(crate) const TYPE_WHOLE: u32 = 1;
pub(crate) const TYPE_AT_SELECTION: u32 = 2;
// The editing keys a text control takes (`edit_control`) — the moves extending the selection with `EDIT_EXTEND` (Shift).
const EDIT_BACKSPACE: u32 = 0;
const EDIT_DELETE: u32 = 1;
const EDIT_LEFT: u32 = 2;
const EDIT_RIGHT: u32 = 3;
const EDIT_HOME: u32 = 4;
const EDIT_END: u32 = 5;
const EDIT_TEXT_START: u32 = 6;
const EDIT_TEXT_END: u32 = 7;
const EDIT_EXTEND: u32 = 16;

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

    // The user typing `text` into the control `id`: what it inserts replacing its selection (`at`: the caret at its
    // value's end where none was ever set; its start, as a script reads it; or its whole value, as a driver's fill
    // does) — the text entry cursor after it —
    // but no keystroke that leaves a number field's text no prefix of a scientific number being entered ("1e+1" takes
    // no second sign; "1.", "1e", "1e+" stand), and of the text no more than `maxlength` has room for where it applies
    // (a textarea, a text-like input): what the value keeps besides the selection is left whole, and a surrogate pair
    // goes in whole or not at all (Chrome: "abcde" at maxlength 5 takes no "X"; a script's longer value takes nothing,
    // and loses nothing). What it changed (`TYPED_*`); the value written is the engine's, the string the bindings held
    // of it forgotten by the caller — and how much of the text went in.
    pub(crate) fn type_text(&mut self, id: NodeId, text: &[u16], at: u32) -> u32 {
        let Some(n) = self.get(id) else { return 0 };
        let current = self.relevant_value(n);
        let number = n.is_html_named("input") && n.input_type() == "number";
        let cuts = n.is_html_named("textarea") || (n.is_html_named("input") && MAXLENGTH_INPUT_TYPES.contains(&n.input_type()));
        let max = if cuts { n.plain_attr("maxlength").and_then(crate::validity::parse_non_negative) } else { None };
        let (sel, set) = self.text_selection(id);
        let (start, end) = match (at, set) {
            (TYPE_WHOLE, _) => (0, current.len()),
            (TYPE_AT_CARET, false) => (current.len(), current.len()),
            _ => (sel.start as usize, sel.end as usize),
        };
        let (start, end) = (start.min(current.len()), end.min(current.len()));
        let mut text = text;
        if let Some(max) = max {
            let mut room = (max as usize).saturating_sub(current.len() - (end - start)).min(text.len());
            if room > 0 && room < text.len() && is_high(text[room - 1]) {
                room -= 1;
            }
            text = &text[..room];
        }
        let mut next = Vec::with_capacity(current.len() + text.len());
        next.extend_from_slice(&current[..start]);
        next.extend_from_slice(text);
        next.extend_from_slice(&current[end..]);
        if number && !number_being_entered(&next) {
            return 0;
        }
        let caret = (start + text.len()) as u32;
        let mut changed = 0;
        if self.write_live_value(id, Some(next.into_boxed_slice())) {
            changed |= TYPED_VALUE;
        }
        if self.set_text_selection(id, caret, caret, Direction::None) {
            changed |= TYPED_SELECTION;
        }
        changed | (text.len() as u32) << TYPED_LENGTH_SHIFT
    }

    // An editing key pressed in the control `id`, as Chrome takes it: Backspace / Delete remove the selection, or what
    // is before / after the caret — Delete a grapheme cluster, Backspace a code point but for an emoji sequence or a
    // flag, which go whole ("é" leaves "e"; "👍🏽" nothing); ArrowLeft / ArrowRight collapse a selection to its start /
    // end, or move the caret by a grapheme cluster; Home / End go to the start / end of the line the caret is on (a
    // textarea's — its value's line, between line feeds — or an input's whole value), Ctrl+Home / Ctrl+End to the
    // value's; and with `EDIT_EXTEND` (Shift) the moves take the selection's focus there, its anchor staying. What it
    // changed (`TYPED_*`).
    pub(crate) fn edit_control(&mut self, id: NodeId, edit: u32) -> u32 {
        let Some(n) = self.get(id) else { return 0 };
        let value = self.relevant_value(n);
        let multiline = n.is_html_named("textarea");
        let len = value.len();
        let (sel, set) = self.text_selection(id);
        let (start, end) = if set { (sel.start as usize, sel.end as usize) } else { (len, len) };
        let line_start = |i: usize| if multiline { value[..i].iter().rposition(|&u| u == 0x0A).map_or(0, |p| p + 1) } else { 0 };
        let line_end = |i: usize| if multiline { value[i..].iter().position(|&u| u == 0x0A).map_or(len, |p| i + p) } else { len };
        let extend = edit & EDIT_EXTEND != 0;
        let key = edit & !EDIT_EXTEND;
        if extend && key >= EDIT_LEFT {
            // (…the focus the end the selection runs to, the anchor the other)
            let backward = sel.direction == Direction::Backward;
            let (anchor, focus) = if backward { (end, start) } else { (start, end) };
            let to = match key {
                EDIT_LEFT => cluster_before(&value, focus),
                EDIT_RIGHT => cluster_after(&value, focus),
                EDIT_HOME => line_start(focus),
                EDIT_END => line_end(focus),
                EDIT_TEXT_START => 0,
                EDIT_TEXT_END => len,
                _ => return 0,
            };
            let (from, until, direction) = if to < anchor { (to, anchor, Direction::Backward) } else { (anchor, to, Direction::Forward) };
            return if self.set_text_selection(id, from as u32, until as u32, direction) { TYPED_SELECTION } else { 0 };
        }
        let (removed, caret) = match key {
            EDIT_BACKSPACE | EDIT_DELETE if end > start => (Some(start..end), start),
            EDIT_BACKSPACE if start > 0 => {
                let from = backspace_from(&value, start);
                (Some(from..start), from)
            }
            EDIT_DELETE if start < len => (Some(start..cluster_after(&value, start)), start),
            EDIT_BACKSPACE | EDIT_DELETE => return 0,
            EDIT_LEFT => (None, if end > start { start } else { cluster_before(&value, start) }),
            EDIT_RIGHT => (None, if end > start { end } else { cluster_after(&value, end) }),
            EDIT_HOME => (None, line_start(start)),
            EDIT_END => (None, line_end(end)),
            EDIT_TEXT_START => (None, 0),
            EDIT_TEXT_END => (None, len),
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

// The grapheme cluster boundaries around `at` in `value` (UAX #29, ICU4X's segmenter): the one before it and the one
// after — what the arrows and Delete step over, read in a window of the text either side (no cluster runs longer).
const CLUSTER_WINDOW: usize = 64;
fn cluster_boundaries(value: &[u16], at: usize) -> (usize, Vec<usize>) {
    let from = at.saturating_sub(CLUSTER_WINDOW);
    let to = (at + CLUSTER_WINDOW).min(value.len());
    let segmenter = icu_segmenter::GraphemeClusterSegmenter::new();
    (from, segmenter.segment_utf16(&value[from..to]).map(|b| from + b).collect())
}
fn cluster_before(value: &[u16], at: usize) -> usize {
    let (from, bounds) = cluster_boundaries(value, at);
    bounds.into_iter().rev().find(|&b| b < at).unwrap_or(from)
}
fn cluster_after(value: &[u16], at: usize) -> usize {
    let (_, bounds) = cluster_boundaries(value, at);
    bounds.into_iter().find(|&b| b > at).unwrap_or(value.len())
}
// …and where Backspace at `at` deletes from: the code point before it — but the whole cluster where that is an emoji
// sequence or a flag (an extended pictographic, a skin tone, a regional indicator, a joiner in it), as Blink's
// backspace state machine takes them.
fn backspace_from(value: &[u16], at: usize) -> usize {
    let cluster = cluster_before(value, at);
    let emoji = char::decode_utf16(value[cluster..at].iter().copied()).filter_map(Result::ok).any(|c| {
        let c = u32::from(c);
        crate::unicode::is_extended_pictographic(c) || (0x1F1E6..=0x1F1FF).contains(&c) || (0x1F3FB..=0x1F3FF).contains(&c) || c == 0x200D
    });
    if emoji {
        cluster
    } else if at >= 2 && is_low(value[at - 1]) && is_high(value[at - 2]) {
        at - 2
    } else {
        at - 1
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

// __dom.typeText(control, text, at) -> what typing `text` into the control where `at` (`TYPE_*`) says changed, and how
// much went in (`type_text`'s `TYPED_*` bits, the length above them).
fn type_text_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let control = args.get(0);
    let Some(id) = crate::node_handle::nid_of(scope, control) else { return rv.set_uint32(0) };
    let text = crate::dom::utf16_arg(scope, args.get(1));
    let at = args.get(2).uint32_value(scope).unwrap_or(TYPE_AT_CARET);
    // (…in the control's realm, whatever realm's code asks: its style state is what the value moves)
    let Some(cid) = crate::dom::dom(scope).arena.get(id).map(|n| n.realm) else { return rv.set_uint32(0) };
    let changed = crate::dom::realm(scope, cid).type_text(id, &text, at);
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
    let Some(cid) = crate::dom::dom(scope).arena.get(id).map(|n| n.realm) else { return rv.set_uint32(0) };
    let changed = crate::dom::realm(scope, cid).edit_control(id, edit);
    if changed & TYPED_VALUE != 0 {
        crate::node_handle::forget_live_value(scope, control);
    }
    rv.set_uint32(changed);
}
