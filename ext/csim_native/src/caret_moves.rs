// Where a key's caret move (keys.rs `motion`: Home / End, the arrows — a word's or the whole text's with Control, the
// selection extended with Shift) takes the caret of the element it goes to, as its default action: in an editing host
// its selection's focus — to its line's edge or its text's (text_geometry.rs `line_edge`, caret.rs `caret_edge`), a
// character or a word on (`caret_step`), a line over (`line_over`) — in a textarea its value's caret, by its lines as
// they wrap, and in any other text control the edit that moves it (text_selection.rs `EDIT_*`). The bindings set the
// selection to what it answers, which fires its `selectionchange` (form-fields.js).

use crate::dom::{dom, realm, realm_id, register, NodeId};
use crate::keys::{MOVE_CHAR, MOVE_EXTEND, MOVE_FORWARD, MOVE_LINE, MOVE_LINE_EDGE, MOVE_WHOLE, MOVE_WORD};
use crate::text_selection::Direction;

// What a move answers: the selection's focus moved to a point — kept as the move line-wise moves set out from
// (`KEEP`), revealing the caret in a root that scrolls (`REVEAL`) — a textarea's caret moved to an offset, or a text
// control edited; or, asked before its text was laid out, that a move by its lines needs it to be (`TEXT_WANTED`).
const TO_POINT: u32 = 1;
const TO_VALUE: u32 = 2;
const TO_EDIT: u32 = 3;
const TEXT_WANTED: u32 = 4;
const KEEP: u32 = 1;
const REVEAL: u32 = 2;

// The text control edits (text_selection.rs `EDIT_*`) a move makes.
const EDIT_LEFT: u32 = 2;
const EDIT_RIGHT: u32 = 3;
const EDIT_HOME: u32 = 4;
const EDIT_END: u32 = 5;
const EDIT_TEXT_START: u32 = 6;
const EDIT_TEXT_END: u32 = 7;
const EDIT_WORD_LEFT: u32 = 8;
const EDIT_WORD_RIGHT: u32 = 9;
const EDIT_EXTEND: u32 = 16;

// A move's answer.
enum Move {
    // (…the point, the x a line-wise move set out from, whether it is the upstream end of a wrap, and KEEP / REVEAL)
    Point((NodeId, u32), Option<f64>, bool, u32),
    // (…the textarea's anchor, the caret's offset, x and upstream as a point's, and REVEAL)
    Value(u32, u32, Option<f64>, bool, u32),
    Edit(u32),
    TextWanted,
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "keyMoveTarget", key_move_target_op, context_id);
}

// The move `motion` makes of the caret of `n` — an editing host's, its document's selection `selection` (its state), where
// `host` — or None where it moves nowhere; one that reads the lines of its text asked for its text laid out first where
// it is not (`laid_out`).
fn key_move(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, n: NodeId, motion: u32, host: bool, laid_out: bool) -> Option<Move> {
    let cid = realm_id(scope, args);
    let forward = motion & MOVE_FORWARD != 0;
    let extend = if motion & MOVE_EXTEND != 0 { EDIT_EXTEND } else { 0 };
    let textarea = dom(scope).arena.get(n).is_some_and(|e| e.is_html_named("textarea"));
    let (focus, range) = crate::selection::caret_points(scope, cid, args.get(3));
    let editing_host = dom(scope).arena.editing_host(n);
    match motion & 3 {
        MOVE_LINE_EDGE => {
            let whole = motion & MOVE_WHOLE != 0;
            if host {
                // (…to the start or end of the caret's line in the host — its whole text's with Control)
                let root = editing_host?;
                if whole {
                    let at = crate::rendered::with_engine(scope, args, |engine, arena, now| arena.caret_edge(engine, now, root, forward))?;
                    return Some(Move::Point(at, None, false, KEEP));
                }
                if !laid_out {
                    return Some(Move::TextWanted);
                }
                let (at, upstream) = crate::text_geometry::line_edge(scope, cid, root, focus?.0, focus?.1, forward)?;
                return Some(Move::Point(at, None, upstream, KEEP));
            }
            if textarea && !whole {
                // (…to the start or end of its LINE as it wraps, not of the value's line between newlines)
                if !laid_out {
                    return Some(Move::TextWanted);
                }
                let (focus, anchor) = textarea_ends(scope, cid, n);
                let ((node, offset), upstream) = crate::text_geometry::line_edge(scope, cid, n, n, focus, forward)?;
                return (node == n).then_some(Move::Value(anchor, offset, None, upstream, 0));
            }
            let edit = match (forward, whole) {
                (true, true) => EDIT_TEXT_END,
                (true, false) => EDIT_END,
                (false, true) => EDIT_TEXT_START,
                (false, false) => EDIT_HOME,
            };
            Some(Move::Edit(edit | extend))
        }
        MOVE_CHAR => {
            let word = motion & MOVE_WORD != 0;
            if host {
                // (…a range, with no Shift and no Control, collapsed to its edge that way; else the focus a character —
                // a word with Control — on, across adjacent text leaves, never out of the host: caret.rs)
                let focus = focus?;
                if extend == 0 && !word {
                    if let Some([start, end]) = range.filter(|[s, e]| s != e) {
                        return Some(Move::Point(if forward { end } else { start }, None, false, 0));
                    }
                }
                let to = crate::rendered::with_engine(scope, args, |engine, arena, now| {
                    if word { arena.caret_word_step(engine, now, focus.0, focus.1, forward) } else { arena.caret_step(engine, now, focus.0, focus.1, forward) }
                })??;
                return Some(Move::Point(to, None, false, 0));
            }
            let edit = match (word, forward) {
                (true, true) => EDIT_WORD_RIGHT,
                (true, false) => EDIT_WORD_LEFT,
                (false, true) => EDIT_RIGHT,
                (false, false) => EDIT_LEFT,
            };
            Some(Move::Edit(edit | extend))
        }
        MOVE_LINE => {
            let up = !forward;
            if host {
                // (…a line up or down in the host, past its first or last line to its text's edge — in the host still)
                if !laid_out {
                    return Some(Move::TextWanted);
                }
                let root = editing_host?;
                let focus = focus?;
                let edge = crate::rendered::with_engine(scope, args, |engine, arena, now| arena.caret_edge(engine, now, root, !up))?;
                let (at, x) = crate::text_geometry::line_over(scope, cid, root, focus.0, focus.1, up, Some(edge))?;
                let arena = &dom(scope).arena;
                let element = if arena.is_element(at.0) { Some(at.0) } else { arena.parent_of(at.0) };
                return (element.and_then(|e| arena.editing_host(e)) == Some(root)).then_some(Move::Point(at, Some(x), false, KEEP | REVEAL));
            }
            if textarea {
                if !laid_out {
                    return Some(Move::TextWanted);
                }
                let (focus, anchor) = textarea_ends(scope, cid, n);
                let arena = realm(scope, cid);
                let len = arena.get(n).map_or(0, |e| arena.relevant_value_len(e));
                let ((node, offset), x) = crate::text_geometry::line_over(scope, cid, n, n, focus, up, Some((n, if up { 0 } else { len })))?;
                return (node == n).then_some(Move::Value(anchor, offset, Some(x), false, REVEAL));
            }
            None
        }
        _ => None,
    }
}
// A textarea's selection's focus and anchor: its end and start, the other way round where it was selected backwards.
fn textarea_ends(scope: &mut v8::PinScope<'_, '_>, cid: i32, n: NodeId) -> (u32, u32) {
    let (sel, _) = realm(scope, cid).text_selection(n);
    if sel.direction == Direction::Backward { (sel.start, sel.end) } else { (sel.end, sel.start) }
}

// __dom.keyMoveTarget(element, motion, editingHost, selectionState, laidOut) -> where `motion` (`keyMotion`) takes the
// caret of `element` (`key_move`): `[TO_POINT, [node], offset, x | undefined, upstream, flags]`, `[TO_VALUE, anchor,
// offset, x | undefined, upstream, flags]`, `[TO_EDIT, edit]`, `[TEXT_WANTED]` — asked again once its text is laid out
// — undefined where it moves nowhere.
fn key_move_target_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(n) = crate::node_handle::nid_of(scope, args.get(0)) else { return };
    let motion = args.get(1).uint32_value(scope).unwrap_or(0);
    let host = args.get(2).is_true();
    let laid_out = args.get(4).is_true();
    let Some(answer) = key_move(scope, &args, n, motion, host, laid_out) else { return };
    let cid = realm_id(scope, &args);
    fn x<'s>(scope: &mut v8::PinScope<'s, '_>, x: Option<f64>) -> v8::Local<'s, v8::Value> {
        match x {
            Some(x) => v8::Number::new(scope, x).into(),
            None => v8::undefined(scope).into(),
        }
    }
    let items: Vec<v8::Local<v8::Value>> = match answer {
        Move::Point((node, offset), at_x, upstream, flags) => vec![
            v8::Integer::new_from_unsigned(scope, TO_POINT).into(),
            crate::dom::nodes_value(scope, cid, &[node]),
            v8::Integer::new_from_unsigned(scope, offset).into(),
            x(scope, at_x),
            v8::Boolean::new(scope, upstream).into(),
            v8::Integer::new_from_unsigned(scope, flags).into(),
        ],
        Move::Value(anchor, offset, at_x, upstream, flags) => vec![
            v8::Integer::new_from_unsigned(scope, TO_VALUE).into(),
            v8::Integer::new_from_unsigned(scope, anchor).into(),
            v8::Integer::new_from_unsigned(scope, offset).into(),
            x(scope, at_x),
            v8::Boolean::new(scope, upstream).into(),
            v8::Integer::new_from_unsigned(scope, flags).into(),
        ],
        Move::Edit(edit) => vec![v8::Integer::new_from_unsigned(scope, TO_EDIT).into(), v8::Integer::new_from_unsigned(scope, edit).into()],
        Move::TextWanted => vec![v8::Integer::new_from_unsigned(scope, TEXT_WANTED).into()],
    };
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
