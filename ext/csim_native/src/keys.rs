// The keys a driver's `send_keys` presses (form-fields.js `__csimSendKeys`): what each names — a key by its name
// (`enter`, `left`, `page_down` …, as Capybara's symbols arrive stringified), a modifier (`control`, `cmd` …), or a
// character typed — as the KeyboardEvent a US keyboard gives for it: its `key`, its `code`, its legacy `keyCode`, the
// character it types and the `inputType` of the edit that is (none for a key that types nothing). A punctuation
// character takes its KEYBOARD key code, not its ASCII code: "." is 46 in ASCII — the Delete key's keyCode — and an
// editor reading `keyCode: 46` on keydown takes it for Delete.

// A key: its `key`, `code`, `keyCode`, the character it types and the `inputType` of that — and whether it was named.
pub(crate) struct Key {
    pub(crate) named: bool,
    pub(crate) key: Vec<u16>,
    pub(crate) code: Vec<u16>,
    pub(crate) key_code: u32,
    pub(crate) char: Option<Vec<u16>>,
    pub(crate) input_type: Option<&'static str>,
}

// The keys named, by name.
const NAMED: [(&str, &str, &str, u32, Option<&str>, Option<&str>); 17] = [
    ("enter", "Enter", "Enter", 13, Some("\n"), Some("insertLineBreak")),
    ("return", "Enter", "Enter", 13, Some("\n"), Some("insertLineBreak")),
    // (…moves focus, types nothing)
    ("tab", "Tab", "Tab", 9, None, None),
    ("space", " ", "Space", 32, Some(" "), Some("insertText")),
    ("backspace", "Backspace", "Backspace", 8, None, Some("deleteContentBackward")),
    ("delete", "Delete", "Delete", 46, None, Some("deleteContentForward")),
    ("escape", "Escape", "Escape", 27, None, None),
    ("up", "ArrowUp", "ArrowUp", 38, None, None),
    ("down", "ArrowDown", "ArrowDown", 40, None, None),
    ("left", "ArrowLeft", "ArrowLeft", 37, None, None),
    ("right", "ArrowRight", "ArrowRight", 39, None, None),
    ("home", "Home", "Home", 36, None, None),
    ("end", "End", "End", 35, None, None),
    ("page_up", "PageUp", "PageUp", 33, None, None),
    ("page_down", "PageDown", "PageDown", 34, None, None),
    ("pageup", "PageUp", "PageUp", 33, None, None),
    ("pagedown", "PageDown", "PageDown", 34, None, None),
];
// The modifiers, by name: `key`, `code`, `keyCode` — the left one of each pair.
const MODIFIERS: [(&str, &str, &str, u32); 8] = [
    ("shift", "Shift", "ShiftLeft", 16),
    ("control", "Control", "ControlLeft", 17),
    ("ctrl", "Control", "ControlLeft", 17),
    ("alt", "Alt", "AltLeft", 18),
    ("option", "Alt", "AltLeft", 18),
    ("meta", "Meta", "MetaLeft", 91),
    ("command", "Meta", "MetaLeft", 91),
    ("cmd", "Meta", "MetaLeft", 91),
];
// A punctuation character's key: its `code` and `keyCode`.
const PUNCTUATION: [(char, &str, u32); 33] = [
    (' ', "Space", 32),
    ('!', "Digit1", 49),
    ('"', "Quote", 222),
    ('#', "Digit3", 51),
    ('$', "Digit4", 52),
    ('%', "Digit5", 53),
    ('&', "Digit7", 55),
    ('\'', "Quote", 222),
    ('(', "Digit9", 57),
    (')', "Digit0", 48),
    ('*', "Digit8", 56),
    ('+', "Equal", 187),
    (',', "Comma", 188),
    ('-', "Minus", 189),
    ('.', "Period", 190),
    ('/', "Slash", 191),
    (':', "Semicolon", 186),
    (';', "Semicolon", 186),
    ('<', "Comma", 188),
    ('=', "Equal", 187),
    ('>', "Period", 190),
    ('?', "Slash", 191),
    ('@', "Digit2", 50),
    ('[', "BracketLeft", 219),
    ('\\', "Backslash", 220),
    (']', "BracketRight", 221),
    ('^', "Digit6", 54),
    ('_', "Minus", 189),
    ('`', "Backquote", 192),
    ('{', "BracketLeft", 219),
    ('|', "Backslash", 220),
    ('}', "BracketRight", 221),
    ('~', "Backquote", 192),
];
// What a key a US keyboard types a character with types with Shift held (WebDriver's shifted keys): a letter its
// capital, a digit or a punctuation mark the one above it; any other character as it is (Chrome: Shift+ß types ß).
const SHIFTED: [(char, char); 21] = [
    ('`', '~'),
    ('1', '!'),
    ('2', '@'),
    ('3', '#'),
    ('4', '$'),
    ('5', '%'),
    ('6', '^'),
    ('7', '&'),
    ('8', '*'),
    ('9', '('),
    ('0', ')'),
    ('-', '_'),
    ('=', '+'),
    ('[', '{'),
    (']', '}'),
    ('\\', '|'),
    (';', ':'),
    ('\'', '"'),
    (',', '<'),
    ('.', '>'),
    ('/', '?'),
];
fn shifted(spec: &[u16]) -> Option<u16> {
    let &[unit] = spec else { return None };
    let c = char::from_u32(u32::from(unit))?;
    let up = if c.is_ascii_lowercase() { c.to_ascii_uppercase() } else { SHIFTED.iter().find(|s| s.0 == c)?.1 };
    Some(up as u16)
}

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
// A name lowercased as JavaScript's `toLowerCase` does it — for the names compared here, which are ASCII, ASCII's.
fn lower(spec: &[u16]) -> String {
    String::from_utf16_lossy(spec).to_lowercase()
}

// What `spec` presses: a key by its name, a line feed Enter and a tab Tab — a text's own — else the character it is,
// with `shift` held the one its key types so (`shifted`): typed with its key's code on a US keyboard — `Key` and its
// capital for a letter, `Digit` and it for a digit — and its `keyCode`; one no such key types (a `ß`, an astral
// character) with none, `keyCode` 0 (Chrome).
pub(crate) fn resolve(spec: &[u16], shift: bool) -> Key {
    let named = |name: &str| {
        NAMED.iter().find(|n| n.0 == name).map(|&(_, key, code, key_code, ch, input_type)| Key {
            named: true,
            key: units(key),
            code: units(code),
            key_code,
            char: ch.map(units),
            input_type,
        })
    };
    if let Some(key) = named(&lower(spec)) {
        return key;
    }
    match spec {
        [0x0a] => return named("enter").expect("a named key"),
        [0x09] => return named("tab").expect("a named key"),
        [] => return Key { named: false, key: Vec::new(), code: Vec::new(), key_code: 0, char: None, input_type: None },
        _ => {}
    }
    let typed = shift.then(|| shifted(spec)).flatten().map_or_else(|| spec.to_vec(), |u| vec![u]);
    let (code, key_code) = match typed[..] {
        [unit] => match char::from_u32(u32::from(unit)) {
            Some(c) if c.is_ascii_alphabetic() => (units(&format!("Key{}", c.to_ascii_uppercase())), u32::from(c.to_ascii_uppercase())),
            Some(c) if c.is_ascii_digit() => (units(&format!("Digit{c}")), u32::from(c)),
            Some(c) => PUNCTUATION.iter().find(|p| p.0 == c).map_or((Vec::new(), 0), |&(_, code, key_code)| (units(code), key_code)),
            None => (Vec::new(), 0),
        },
        _ => (Vec::new(), 0),
    };
    Key { named: false, key: typed.clone(), code, key_code, char: Some(typed), input_type: Some("insertText") }
}

// The modifier `name` names: its `key`, `code` and `keyCode` — None for a name that is none.
pub(crate) fn modifier(name: &[u16]) -> Option<(&'static str, &'static str, u32)> {
    let name = lower(name);
    MODIFIERS.iter().find(|m| m.0 == name).map(|&(_, key, code, key_code)| (key, code, key_code))
}

// What pressing a key on an element does besides its events, each where its events are not canceled (`plan`): the
// element's facts the rest is decided by, and the default actions that apply.
// (…the element a text can be typed into: an editing host's, or an `<input>` / `<textarea>` with no `readonly` or
// `disabled` — a checkbox or a radio none)
pub(crate) const TYPEABLE: u32 = 1;
pub(crate) const EDITING_HOST: u32 = 1 << 1;
pub(crate) const CHECK_OR_RADIO: u32 = 1 << 2;
// (…an anchor, a button, a summary, a select: send_keys focuses it though nothing is typed into it)
pub(crate) const INTERACTIVE: u32 = 1 << 3;
// The legacy `keypress` after the keydown: a key that produces a character — a printable one, Enter (a carriage
// return) — none with Control / Alt / Meta held.
pub(crate) const KEYPRESS: u32 = 1 << 4;
// Escape's: a close request (HTML §6.4.4).
pub(crate) const CLOSE_REQUEST: u32 = 1 << 5;
// An arrow on a `<select>` or a radio: the adjacent option, the next or previous radio of its group.
pub(crate) const ARROW_CHOICE: u32 = 1 << 6;
// ArrowUp / ArrowDown on a stepped `<input>` (number, range, date …) with no `readonly` or `disabled`: a step.
pub(crate) const STEP: u32 = 1 << 7;
// Enter in a typeable element, no chord held: the form's implicit submission.
pub(crate) const IMPLICIT_SUBMIT: u32 = 1 << 8;
// Enter on a link, or with no chord held on a button or a summary — none `disabled`: its activation, a keyboard's click.
pub(crate) const ENTER_ACTIVATES: u32 = 1 << 9;
// Space on a button, a checkbox, a radio or a summary: its activation on the key's release.
pub(crate) const SPACE_ACTIVATES: u32 = 1 << 10;
// Tab with no Control / Meta / Alt held: focus moved to the next tabbable element (Shift: the previous one).
pub(crate) const FOCUS_NAVIGATION: u32 = 1 << 11;
// Control / Meta + A: all the content selected — an editing host's, a text control's (a read-only one's too), else
// the document's (Chrome's SelectAll).
pub(crate) const SELECT_ALL: u32 = 1 << 12;
// Control / Meta + X, C, V: the clipboard's cut, copy and paste of the focused element's selection.
pub(crate) const CUT: u32 = 1 << 13;
pub(crate) const COPY: u32 = 1 << 14;
pub(crate) const PASTE: u32 = 1 << 15;
// The modifiers held, as `plan` takes them.
pub(crate) const CTRL: u32 = 1;
pub(crate) const META: u32 = 1 << 1;
pub(crate) const ALT: u32 = 1 << 2;
pub(crate) const SHIFT: u32 = 1 << 3;

// `plan` of the key `key` (a KeyboardEvent `key`) typing `char` (None for none), pressed on `id` with `modifiers` held.
pub(crate) fn plan(arena: &crate::dom::RealmArena, id: crate::dom::NodeId, key: &[u16], char: Option<&[u16]>, modifiers: u32) -> u32 {
    let Some(n) = arena.get(id) else { return 0 };
    let is = |name: &str| is_units(key, name);
    let chord = modifiers & (CTRL | META | ALT) != 0;
    // (…by its local name, whatever its namespace, as the bindings' `_tag` is)
    let tag = &*n.local_name;
    let input_type = if tag == "input" { n.input_type() } else { "" };
    let check_or_radio = matches!(input_type, "checkbox" | "radio");
    let control = matches!(tag, "input" | "textarea") && !n.is_read_only() && n.plain_attr("disabled").is_none();
    // (…a text control edits its own value, wherever it is: one inside an editing host — a design-mode document's
    // included — is no part of the host's content to a key, Chrome)
    let host = !matches!(tag, "input" | "textarea") && arena.is_editable(id);
    let button = tag == "button" || (tag == "input" && n.input_has(crate::input_types::BUTTON));
    let mut plan = 0;
    let mut set = |bit: u32, on: bool| {
        if on {
            plan |= bit;
        }
    };
    let typeable = host || (control && !check_or_radio);
    set(TYPEABLE, typeable);
    set(EDITING_HOST, host);
    set(CHECK_OR_RADIO, check_or_radio);
    set(INTERACTIVE, matches!(tag, "a" | "button" | "summary" | "select"));
    set(KEYPRESS, !chord && (is("Enter") || (one_character(key) && char == Some(key))));
    set(CLOSE_REQUEST, is("Escape"));
    let arrow = is("ArrowDown") || is("ArrowUp") || is("ArrowLeft") || is("ArrowRight");
    set(ARROW_CHOICE, arrow && (tag == "select" || input_type == "radio"));
    set(STEP, (is("ArrowUp") || is("ArrowDown")) && tag == "input" && control && n.input_has(crate::input_types::NUMERIC));
    set(IMPLICIT_SUBMIT, is("Enter") && typeable && !chord);
    let link = tag == "a" && n.is_hyperlink();
    set(ENTER_ACTIVATES, is("Enter") && n.plain_attr("disabled").is_none() && (link || ((button || tag == "summary") && !chord)));
    set(SPACE_ACTIVATES, is(" ") && (check_or_radio || button || tag == "summary"));
    set(FOCUS_NAVIGATION, is("Tab") && !chord);
    let command = modifiers & (CTRL | META) != 0;
    let letter = |l: u8| matches!(key, [u] if u8::try_from(*u).is_ok_and(|b| b.to_ascii_lowercase() == l));
    set(SELECT_ALL, command && letter(b'a'));
    set(CUT, command && letter(b'x'));
    set(COPY, command && letter(b'c'));
    set(PASTE, command && letter(b'v'));
    plan
}

// The edit a key makes in a typeable element (`edit`), besides its `inputType`: a character typed (a textarea's line
// break among them), an editing host's line break or paragraph, or a deletion — forward or back, of a word or to the
// line's start.
pub(crate) const EDIT_TYPE: u32 = 1;
pub(crate) const EDIT_LINE_BREAK: u32 = 1 << 1;
pub(crate) const EDIT_PARAGRAPH: u32 = 1 << 2;
pub(crate) const EDIT_DELETE: u32 = 1 << 3;
pub(crate) const EDIT_FORWARD: u32 = 1 << 4;
pub(crate) const EDIT_WORD: u32 = 1 << 5;
pub(crate) const EDIT_LINE: u32 = 1 << 6;

// The selection a key edits, as `edit` takes it: none — an editing host's where the document's lies outside it — a
// range, or a collapsed one.
pub(crate) const SELECTION_NONE: u32 = 0;
pub(crate) const SELECTION_COLLAPSED: u32 = 2;

// What the key `key` — typing `char`, its edit `input_type` (`resolve`) — types into `id` with `modifiers` held: the
// `inputType` of its `beforeinput` and `input`, and its edit; None where it types nothing — no typeable element, an
// editing host with no selection in it, a chord, a key with no edit, Enter in a single-line `<input>` (it submits). Enter in an editing host inserts a paragraph, a line break with Shift. Control alone with Backspace or Delete
// deletes a word — with Shift, Backspace in a text control to the line's start, `deleteSoftLineBackward` — named so
// where the selection is collapsed (one that is not is deleted as itself): Chrome on Linux.
pub(crate) fn edit(
    arena: &crate::dom::RealmArena,
    id: crate::dom::NodeId,
    key: &[u16],
    char: Option<&[u16]>,
    input_type: Option<&'static str>,
    modifiers: u32,
    selection: u32,
) -> Option<(&'static str, u32)> {
    let facts = plan(arena, id, key, char, modifiers);
    let input_type = input_type?;
    let host = facts & EDITING_HOST != 0;
    let collapsed = selection == SELECTION_COLLAPSED;
    let shift = modifiers & SHIFT != 0;
    let ctrl_only = modifiers & (CTRL | META | ALT) == CTRL;
    let forward = input_type == "deleteContentForward";
    let deleting = forward || input_type == "deleteContentBackward";
    let line = ctrl_only && shift && !host && input_type == "deleteContentBackward";
    let word = ctrl_only && !shift && deleting;
    let chord = modifiers & (CTRL | META | ALT) != 0;
    let single_line = arena.get(id).is_some_and(|n| &*n.local_name == "input");
    if facts & TYPEABLE == 0 || (host && selection == SELECTION_NONE) || (char.is_none() && !deleting) || (is_units(key, "Enter") && single_line) || (chord && !word && !line) {
        return None;
    }
    if deleting {
        let named = collapsed && (word || line);
        let input_type = match (named, line, forward) {
            (true, true, _) => "deleteSoftLineBackward",
            (true, false, false) => "deleteWordBackward",
            (true, false, true) => "deleteWordForward",
            (false, ..) => input_type,
        };
        // (…an editing host deletes the selection, or the word its `inputType` names; a text control the word whatever
        // its selection is)
        let by_word = if host { named } else { word };
        let bits = EDIT_DELETE | if forward { EDIT_FORWARD } else { 0 } | if by_word { EDIT_WORD } else { 0 } | if line { EDIT_LINE } else { 0 };
        return Some((input_type, bits));
    }
    if is_units(key, "Enter") {
        let paragraph = host && !shift;
        let input_type = if paragraph { "insertParagraph" } else { "insertLineBreak" };
        return Some((input_type, if !host { EDIT_TYPE } else if paragraph { EDIT_PARAGRAPH } else { EDIT_LINE_BREAK }));
    }
    Some((input_type, EDIT_TYPE))
}
// The caret a key moves in a typeable element (`motion`): to an edge of its line (Home / End — of the whole text with
// Control), by a character (ArrowLeft / ArrowRight — by a word with Control), or a line over (ArrowUp / ArrowDown);
// forward (End, ArrowRight, ArrowDown) or back, and extending the selection with Shift.
pub(crate) const MOVE_LINE_EDGE: u32 = 1;
pub(crate) const MOVE_CHAR: u32 = 2;
pub(crate) const MOVE_LINE: u32 = 3;
pub(crate) const MOVE_FORWARD: u32 = 1 << 2;
pub(crate) const MOVE_WHOLE: u32 = 1 << 3;
pub(crate) const MOVE_WORD: u32 = 1 << 4;
pub(crate) const MOVE_EXTEND: u32 = 1 << 5;

// The caret motion the key `key` makes in `id` with `modifiers` held, 0 for none — no typeable element, a key that moves
// nothing, or one with a chord it makes none with: Meta with Home or End, Alt or Meta with ArrowLeft or ArrowRight
// (Control a word's), any of Control, Alt and Meta with ArrowUp or ArrowDown — Chrome on Linux.
pub(crate) fn motion(arena: &crate::dom::RealmArena, id: crate::dom::NodeId, key: &[u16], modifiers: u32) -> u32 {
    if plan(arena, id, key, None, modifiers) & TYPEABLE == 0 {
        return 0;
    }
    let is = |name: &str| is_units(key, name);
    let held = |bits: u32| modifiers & bits != 0;
    let (kind, forward) = if is("Home") || is("End") {
        (if held(META) { 0 } else { MOVE_LINE_EDGE | if held(CTRL) { MOVE_WHOLE } else { 0 } }, is("End"))
    } else if is("ArrowLeft") || is("ArrowRight") {
        (if held(ALT | META) { 0 } else { MOVE_CHAR | if held(CTRL) { MOVE_WORD } else { 0 } }, is("ArrowRight"))
    } else if is("ArrowUp") || is("ArrowDown") {
        (if held(CTRL | ALT | META) { 0 } else { MOVE_LINE }, is("ArrowDown"))
    } else {
        (0, false)
    };
    if kind == 0 {
        return 0;
    }
    kind | if forward { MOVE_FORWARD } else { 0 } | if held(SHIFT) { MOVE_EXTEND } else { 0 }
}
// Whether `units` are one character: one code point, a surrogate pair's two units among them.
fn one_character(units: &[u16]) -> bool {
    char::decode_utf16(units.iter().copied()).count() == 1
}
fn is_units(units: &[u16], ascii: &str) -> bool {
    units.iter().copied().eq(ascii.bytes().map(u16::from))
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "resolveKey", resolve_op, context_id);
    crate::dom::register(scope, ns, "modifierKey", modifier_op, context_id);
    crate::dom::register(scope, ns, "keyPlan", plan_op, context_id);
    crate::dom::register(scope, ns, "keyEdit", edit_op, context_id);
    crate::dom::register(scope, ns, "keyMotion", motion_op, context_id);
}
// __dom.keyPlan(element, key, char, modifiers) -> `plan` (its bits, `modifiers` CTRL | META | ALT).
fn plan_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(id) = crate::node_handle::nid_of(scope, args.get(0)) else { return rv.set_uint32(0) };
    let key = crate::dom::utf16_arg(scope, args.get(1));
    let ch = (!args.get(2).is_null_or_undefined()).then(|| crate::dom::utf16_arg(scope, args.get(2)));
    let modifiers = args.get(3).uint32_value(scope).unwrap_or(0);
    rv.set_uint32(plan(crate::dom::realm(scope, cid), id, &key, ch.as_deref(), modifiers));
}
// __dom.keyEdit(element, key, char, inputType, modifiers, selection) -> [inputType, edit] (`edit`; `char` and
// `inputType` null for none, as `resolveKey` gives them), null for none.
fn edit_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(id) = crate::node_handle::nid_of(scope, args.get(0)) else { return rv.set_null() };
    let key = crate::dom::utf16_arg(scope, args.get(1));
    let ch = (!args.get(2).is_null_or_undefined()).then(|| crate::dom::utf16_arg(scope, args.get(2)));
    let input_type = args.get(3).to_rust_string_lossy(scope);
    let input_type = ["insertText", "insertLineBreak", "deleteContentBackward", "deleteContentForward"].into_iter().find(|t| *t == input_type);
    let modifiers = args.get(4).uint32_value(scope).unwrap_or(0);
    let selection = args.get(5).uint32_value(scope).unwrap_or(SELECTION_NONE);
    let Some((input_type, bits)) = edit(crate::dom::realm(scope, cid), id, &key, ch.as_deref(), input_type, modifiers, selection) else {
        return rv.set_null();
    };
    let items: [v8::Local<v8::Value>; 2] = [v8::String::new(scope, input_type).unwrap().into(), v8::Integer::new_from_unsigned(scope, bits).into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.keyMotion(element, key, modifiers) -> `motion` (its bits, `modifiers` CTRL | META | ALT | SHIFT).
fn motion_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(id) = crate::node_handle::nid_of(scope, args.get(0)) else { return rv.set_uint32(0) };
    let key = crate::dom::utf16_arg(scope, args.get(1));
    let modifiers = args.get(2).uint32_value(scope).unwrap_or(0);
    rv.set_uint32(motion(crate::dom::realm(scope, cid), id, &key, modifiers));
}
// __dom.resolveKey(spec, shift) -> [key, code, keyCode, char (null for none), inputType (null for none), named, charCode]
// (`resolve`).
fn resolve_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let spec = crate::dom::utf16_arg(scope, args.get(0));
    let shift = args.get(1).is_true();
    let k = resolve(&spec, shift);
    let ch: v8::Local<v8::Value> = match k.char.as_deref() {
        Some(c) => crate::dom::utf16_value(scope, c),
        None => v8::null(scope).into(),
    };
    // (…the `keypress` char code of a key that produces a character: Enter's a carriage return, a printable one's its
    // character's code point — UI Events' legacy `charCode`, "the Unicode reference number" — an emoji's past U+FFFF)
    let char_code = if is_units(&k.key, "Enter") {
        13
    } else {
        k.char.as_ref().and_then(|c| char::decode_utf16(c.iter().copied()).next()).and_then(Result::ok).map_or(0, u32::from)
    };
    let items: [v8::Local<v8::Value>; 7] = [
        crate::dom::utf16_value(scope, &k.key),
        crate::dom::utf16_value(scope, &k.code),
        v8::Integer::new_from_unsigned(scope, k.key_code).into(),
        ch,
        k.input_type.and_then(|t| v8::String::new(scope, t)).map_or_else(|| v8::null(scope).into(), Into::into),
        v8::Boolean::new(scope, k.named).into(),
        v8::Integer::new_from_unsigned(scope, char_code).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.modifierKey(name) -> [key, code, keyCode] of the modifier `name` names, null for none (`modifier`).
fn modifier_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = crate::dom::utf16_arg(scope, args.get(0));
    let Some((key, code, key_code)) = modifier(&name) else { return rv.set_null() };
    let items: [v8::Local<v8::Value>; 3] =
        [v8::String::new(scope, key).unwrap().into(), v8::String::new(scope, code).unwrap().into(), v8::Integer::new_from_unsigned(scope, key_code).into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(s: &str) -> (String, String, u32, Option<String>, Option<&'static str>) {
        let k = resolve(&units(s), false);
        (String::from_utf16_lossy(&k.key), String::from_utf16_lossy(&k.code), k.key_code, k.char.map(|c| String::from_utf16_lossy(&c)), k.input_type)
    }

    #[test]
    fn keys_resolve_as_a_us_keyboard_types_them() {
        assert_eq!(key("ENTER"), ("Enter".into(), "Enter".into(), 13, Some("\n".into()), Some("insertLineBreak")));
        assert_eq!(key("\t").0, "Tab");
        assert_eq!(key(".").1, "Period");
        assert_eq!(key(".").2, 190);
        assert_eq!(key("a"), ("a".into(), "KeyA".into(), 65, Some("a".into()), Some("insertText")));
        assert_eq!((key("1").1, key("1").2), ("Digit1".into(), 49));
        assert_eq!((key("ß").1, key("ß").2), (String::new(), 0));
        assert_eq!(key("😀").2, 0);
        let shift = |s: &str| {
            let k = resolve(&units(s), true);
            (String::from_utf16_lossy(&k.key), String::from_utf16_lossy(&k.code), k.key_code)
        };
        assert_eq!(shift("1"), ("!".into(), "Digit1".into(), 49));
        assert_eq!(shift("a"), ("A".into(), "KeyA".into(), 65));
        assert_eq!(shift(";"), (":".into(), "Semicolon".into(), 186));
        assert_eq!(shift("ß"), ("ß".into(), String::new(), 0));
        assert_eq!(modifier(&units("Cmd")), Some(("Meta", "MetaLeft", 91)));
        assert_eq!(modifier(&units("x")), None);
    }
}
