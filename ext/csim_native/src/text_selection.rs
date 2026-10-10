// A text control's selection (HTML §4.10.6 "APIs for the text control selections"): the offsets of its selection —
// its text entry cursor where collapsed — into its value, and the selection's direction. Kept by the engine for each
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
// applies to an email field too.
const SELECTION_INPUT_TYPES: [&str; 5] = ["text", "search", "tel", "url", "password"];

// Why `setRangeText()` refused.
#[derive(Debug, PartialEq)]
pub(crate) enum RangeTextError {
    // The control's type has no selection: InvalidStateError.
    NotApplicable,
    // The start past the end: IndexSizeError.
    Index,
}

impl RealmArena {
    // Do the selection APIs apply to `n`: a `<textarea>`, or an `<input>` of a type they apply to?
    pub(crate) fn selection_applies(&self, n: &NodeData) -> bool {
        n.is_html_named("textarea") || (n.is_html_named("input") && SELECTION_INPUT_TYPES.contains(&n.input_type()))
    }

    // `id`'s selection as it stands — clamped to its value's length, which may have shrunk by a path that moved no
    // cursor (a `type` change re-sanitizing, a reset, a clean `<textarea>`'s children), and kept so — and whether it
    // was ever set.
    pub(crate) fn text_selection(&mut self, id: NodeId) -> (TextSelection, bool) {
        let Some(sel) = self.text_selections.get(&id).copied() else { return (TextSelection::default(), false) };
        let len = self.get(id).map_or(0, |n| self.raw_value_units(n).len() as u32);
        let clamped = TextSelection { start: sel.start.min(len), end: sel.end.min(len), ..sel };
        self.text_selections.insert(id, clamped);
        (clamped, true)
    }

    // HTML "set the selection range" of `id` to `start`..`end` in `direction`: each clamped to the value's length, the
    // start no later than the end. Whether that changed it.
    pub(crate) fn set_text_selection(&mut self, id: NodeId, start: u32, end: u32, direction: Direction) -> bool {
        let len = self.get(id).map_or(0, |n| self.raw_value_units(n).len() as u32);
        let end = end.min(len);
        let start = start.min(len).min(end);
        let next = TextSelection { start, end, direction };
        self.text_selections.insert(id, next) != Some(next)
    }

    // `setRangeText(replacement, start, end, mode)` of `id` — `start` / `end` the selection's where not given: the value
    // with `replacement` over that range, and the selection after, by `mode` ("select" the replacement, "start" before
    // it, "end" after it, "preserve" — any other — the selection as it was, moved with the text).
    pub(crate) fn range_text(
        &mut self,
        id: NodeId,
        replacement: &[u16],
        range: Option<(u32, u32)>,
        mode: &str,
    ) -> Result<(Vec<u16>, u32, u32, Direction), RangeTextError> {
        let n = self.get(id).ok_or(RangeTextError::NotApplicable)?;
        if !self.selection_applies(n) {
            return Err(RangeTextError::NotApplicable);
        }
        let value = self.raw_value_units(n);
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
                let moved = |o: u32| if o > e { (i64::from(o) + delta) as u32 } else if o > s { replaced_end } else { o };
                (moved(sel.start), moved(sel.end))
            }
        };
        Ok((next, ns, ne, sel.direction))
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "textSelection", text_selection_op, context_id);
    crate::dom::register(scope, ns, "setTextSelection", set_text_selection_op, context_id);
    crate::dom::register(scope, ns, "rangeTextEdit", range_text_op, context_id);
}

// __dom.textSelection(nid, applicableOnly) -> [start, end, direction, set] (`text_selection`), or null where
// `applicableOnly` and the selection APIs do not apply to the control.
fn text_selection_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let applicable_only = args.get(1).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    if applicable_only && !arena.get(id).is_some_and(|n| arena.selection_applies(n)) {
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

// __dom.setTextSelection(nid, start, end, direction, applicableOnly) -> whether the selection changed
// (`set_text_selection`), or null where `applicableOnly` and the selection APIs do not apply to the control.
fn set_text_selection_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let start = args.get(1).uint32_value(scope).unwrap_or(0);
    let end = args.get(2).uint32_value(scope).unwrap_or(0);
    let direction = Direction::parse(&args.get(3).to_rust_string_lossy(scope));
    let applicable_only = args.get(4).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    if applicable_only && !arena.get(id).is_some_and(|n| arena.selection_applies(n)) {
        return;
    }
    rv.set_bool(arena.set_text_selection(id, start, end, direction));
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
        assert_eq!(arena.range_text(id, &u("X"), Some((4, 2)), "end"), Err(RangeTextError::Index));
    }
}
