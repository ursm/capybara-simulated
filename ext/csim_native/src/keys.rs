// The keys a driver's `send_keys` presses (form-fields.js `sendKeys`): what each names — a key by its name
// (`enter`, `left`, `page_down` …, as Capybara's symbols arrive stringified), a modifier (`control`, `cmd` …), or a
// character typed — as the KeyboardEvent a US keyboard gives for it: its `key`, its `code`, its legacy `keyCode`, the
// character it types and the `inputType` of the edit that is (none for a key that types nothing). A punctuation
// character takes its KEYBOARD key code, not its ASCII code: "." is 46 in ASCII — the Delete key's keyCode — and an
// editor reading `keyCode: 46` on keydown takes it for Delete.

use crate::dom::{NodeId, RealmArena};

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

// A chord's parts (`[:control, :shift, 'a']`), read as a keyboard presses them: the modifiers before its key — every
// part a modifier names up to the last that names none, a name that is neither dropped — held while it is pressed,
// their bits (`CTRL` …) and keys in the order pressed; and its key, None where every part is a modifier
// (`[:control]`). A key of more than one character that names no key is a text, typed a character at a time with the
// modifiers held (`unfold`: `[:shift, 'side']` is S, I, D, E).
pub(crate) struct Chord {
    pub(crate) modifiers: u32,
    pub(crate) keys: Vec<(&'static str, &'static str, u32)>,
    pub(crate) key: Vec<u16>,
    pub(crate) unfold: bool,
}
pub(crate) fn chord(parts: &[Vec<u16>]) -> Chord {
    let last = parts.iter().rposition(|p| modifier(p).is_none());
    let keys: Vec<_> = parts[..last.unwrap_or(parts.len())].iter().filter_map(|p| modifier(p)).collect();
    let modifiers = keys.iter().fold(0, |bits, &(key, ..)| {
        bits | match key {
            "Control" => CTRL,
            "Meta" => META,
            "Alt" => ALT,
            _ => SHIFT,
        }
    });
    let key = last.map_or_else(Vec::new, |i| parts[i].clone());
    let unfold = key.len() > 1 && !resolve(&key, false).named;
    Chord { modifiers, keys, key, unfold }
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
// Enter in a field, no chord held: its form's implicit submission (element_state.rs `implicit_submission_form`).
pub(crate) const IMPLICIT_SUBMIT: u32 = 1 << 8;
// Enter on a link, or with no chord held on a button or a summary — none `disabled`: its activation, a keyboard's click.
pub(crate) const ENTER_ACTIVATES: u32 = 1 << 9;
// Space on a button, a checkbox, a radio or a summary: its activation on the key's release.
pub(crate) const SPACE_ACTIVATES: u32 = 1 << 10;
// Tab with no Control / Meta / Alt held: focus moved to the next tabbable element (Shift: the previous one).
pub(crate) const FOCUS_NAVIGATION: u32 = 1 << 11;
// Control / Meta + A, no Shift held: all the content selected — an editing host's, a text control's (a read-only one's
// too), else the document's (Chrome's SelectAll; Control + Shift + A selects nothing, Chrome and Firefox).
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
pub(crate) fn plan(arena: &RealmArena, id: NodeId, key: &[u16], char: Option<&[u16]>, modifiers: u32) -> u32 {
    let Some(n) = arena.get(id) else { return 0 };
    let is = |name: &str| is_units(key, name);
    let chord = modifiers & (CTRL | META | ALT) != 0;
    // (…by its local name, whatever its namespace, as the bindings' `tagOf` is)
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
    set(IMPLICIT_SUBMIT, is("Enter") && tag == "input" && !chord && !arena.is_actually_disabled(id));
    let link = tag == "a" && n.is_hyperlink();
    set(ENTER_ACTIVATES, is("Enter") && n.plain_attr("disabled").is_none() && (link || ((button || tag == "summary") && !chord)));
    set(SPACE_ACTIVATES, is(" ") && (check_or_radio || button || tag == "summary"));
    set(FOCUS_NAVIGATION, is("Tab") && !chord);
    let command = modifiers & (CTRL | META) != 0;
    let letter = |l: u8| matches!(key, [u] if u8::try_from(*u).is_ok_and(|b| b.to_ascii_lowercase() == l));
    set(SELECT_ALL, command && modifiers & SHIFT == 0 && letter(b'a'));
    set(CUT, command && letter(b'x'));
    set(COPY, command && letter(b'c'));
    set(PASTE, command && letter(b'v'));
    plan
}

// Where `send_keys` to an element sends its keys, and what it does to it first (`send_target`): FOCUS it — a typeable
// element that does not have focus its caret moved to the end of its content first (WebDriver "element send keys"): a
// text control's to its value's end, an editing host's to its last caret position (CARET_LAST) — or focus the VIEWPORT.
pub(crate) const SEND_FOCUS: u32 = 1;
pub(crate) const SEND_CARET_END: u32 = 1 << 1;
pub(crate) const SEND_CARET_LAST: u32 = 1 << 2;
pub(crate) const SEND_VIEWPORT: u32 = 1 << 3;

// `send_target` of `id`: its bits, and the element the keys go to.
pub(crate) fn send_target(engine: &mut crate::style::StyleEngine, arena: &RealmArena, id: NodeId, now: f64) -> (u32, NodeId) {
    let facts = plan(arena, id, &[], None, 0);
    let doc = Some(arena.shadow_including_root(id)).filter(|&d| arena.get(d).is_some_and(|d| d.kind == crate::dom::NodeKind::Document));
    let body = doc.and_then(|d| arena.body_element(d));
    // (…the element its document has focused)
    let active = crate::focus::document_focus(arena, id);
    // An element a key does something to — one a text is typed into, a checkbox or a radio, a link, a button — or one
    // that takes focus whatever it is (a `tabindex` container, a listbox: WebDriver "keyboard-interactable") is focused,
    // as Selenium / Playwright `send_keys` focus their target even where nothing is typed into it — blurring what had
    // focus (Discourse's `.topic-list-item` drops its `.selected` class on `a.title`'s blur, which keeps its `Enter`
    // binding from taking the keys to the wrong row).
    if facts & (TYPEABLE | CHECK_OR_RADIO | INTERACTIVE) != 0 || crate::focus::focusable(engine, arena, id, now) {
        let caret = match facts & (TYPEABLE | EDITING_HOST) {
            0 => 0,
            _ if active.or(body) == Some(id) => 0,
            TYPEABLE => SEND_CARET_END,
            _ => SEND_CARET_LAST,
        };
        return (SEND_FOCUS | caret, id);
    }
    // …the document element, or a body that takes no focus, focusing the VIEWPORT (HTML "get the focusable area"): what
    // had focus loses it, and the keys go to the body (chromedriver, measured 2026-10-10 — a dialog the focus was in no
    // longer holds it, so closing it gives none back).
    if doc.is_some_and(|d| arena.first_element_child(d) == Some(id)) || body == Some(id) {
        return (SEND_VIEWPORT, body.unwrap_or(id));
    }
    // An element that takes no focus at all (a `<details>`, a plain `<div>`) hands the keys to the focused element inside
    // it — in a shadow tree too — whatever its tag: a key event goes to the focused element. (chromedriver refuses such
    // a target outright — ElementNotInteractableError, WebDriver's "keyboard-interactable" check — where this driver is
    // lenient.)
    match active.filter(|&a| a != id && Some(a) != body && arena.shadow_including_ancestor(id, a)) {
        Some(a) => (0, a),
        None => (0, id),
    }
}

// What a driver's `set` does to an element (Capybara's `Element#set`, as Selenium does it: `set_plan`) — its KIND: nothing
// (a read-only control; a select with no option of the value the user can pick), the value typed over what it held (a
// textarea's, a text-like input's — cut at `maxlength`, the caret at its end), the value as given (a number field keeps
// what was typed, out of range or not), the value sanitized (a range's UI can only land on its range and step), a
// checkbox or radio button clicked where that changes it — no click unchecks a radio button — or left as it is, the
// `value` content attribute written (a checkbox's or radio's set to no boolean), an option picked, an editing host's
// content replaced as typed — and whether it is focused first (a text control or an editing host, as Selenium's typing
// focuses it), is an input or a textarea (a user's edit: `tooShort` / `tooLong` can apply), and is submitted after (an
// input's value ending in a line feed, the feed no part of it: Enter pressed).
pub(crate) const SET_NONE: u32 = 0;
pub(crate) const SET_TYPE: u32 = 1;
pub(crate) const SET_LIVE: u32 = 2;
pub(crate) const SET_SANITIZED: u32 = 3;
pub(crate) const SET_CLICK: u32 = 4;
pub(crate) const SET_UNCHANGED: u32 = 5;
pub(crate) const SET_VALUE_ATTRIBUTE: u32 = 6;
pub(crate) const SET_OPTION: u32 = 7;
pub(crate) const SET_EDITING_HOST: u32 = 8;
pub(crate) const SET_KIND: u32 = 15;
pub(crate) const SET_FOCUS: u32 = 1 << 4;
pub(crate) const SET_CONTROL: u32 = 1 << 5;
pub(crate) const SET_SUBMIT: u32 = 1 << 6;

// What `set` is given: a boolean, or a value's string (none for null).
pub(crate) enum SetValue {
    Bool(bool),
    Text(Vec<u16>),
}

// `set_plan` of `id` given `value`: its bits, the text it writes, and the option it picks.
pub(crate) fn set_plan(arena: &RealmArena, id: NodeId, value: &SetValue) -> (u32, Vec<u16>, Option<NodeId>) {
    let Some(n) = arena.get(id) else { return (SET_NONE, Vec::new(), None) };
    let (input, textarea) = (n.is_html_named("input"), n.is_html_named("textarea"));
    // (…an HTML text control edits its own value; any other element an editing host's content: its own, or a host's
    // that holds it)
    let host = !(input || textarea) && arena.is_editable(id);
    let mut flags = 0;
    if input || textarea {
        flags |= SET_CONTROL;
    }
    if input || textarea || host {
        flags |= SET_FOCUS;
    }
    if n.is_read_only() {
        return (flags, Vec::new(), None);
    }
    let mut text = match value {
        SetValue::Bool(b) => (if *b { "true" } else { "false" }).encode_utf16().collect(),
        SetValue::Text(t) => t.clone(),
    };
    if input && matches!(value, SetValue::Text(t) if t.last() == Some(&u16::from(b'\n'))) {
        text.pop();
        flags |= SET_SUBMIT;
    }
    let kind = if textarea {
        SET_TYPE
    } else if input {
        match n.input_type() {
            kind @ ("checkbox" | "radio") => {
                let want = match value {
                    SetValue::Bool(b) => Some(*b),
                    SetValue::Text(t) if is_units(t, "true") => Some(true),
                    SetValue::Text(t) if is_units(t, "false") => Some(false),
                    SetValue::Text(_) => None,
                };
                match want {
                    None => SET_VALUE_ATTRIBUTE,
                    Some(want) if want != arena.is_checked(id) && (want || kind == "checkbox") => SET_CLICK,
                    Some(_) => SET_UNCHANGED,
                }
            },
            "number" => SET_LIVE,
            "range" => SET_SANITIZED,
            _ => SET_TYPE,
        }
    } else if n.is_html_named("select") {
        // (…the first option of the value — the option's value, its `value` attribute else its collapsed text — that the
        // user can pick: none in a disabled select, nor a disabled one)
        let pick = (!arena.is_actually_disabled(id))
            .then(|| arena.list_of_options(id).into_iter().find(|&o| !arena.option_disabled(o) && arena.option_value(o) == text))
            .flatten();
        return match pick {
            Some(o) => (flags | SET_OPTION, text, Some(o)),
            None => (flags, text, None),
        };
    } else if host {
        SET_EDITING_HOST
    } else {
        SET_LIVE
    };
    (flags | kind, text, None)
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
pub(crate) const SELECTION_RANGE: u32 = 1;
pub(crate) const SELECTION_COLLAPSED: u32 = 2;

// What the key `key` — typing `char`, its edit `input_type` (`resolve`) — types into `id` with `modifiers` held: the
// `inputType` of its `beforeinput` and `input`, and its edit (none for Enter in a single-line `<input>`, which submits);
// None where it types nothing — no typeable element, an editing host with no selection in it, a chord, a key with no
// edit. Enter in an editing host inserts a paragraph, a line break with Shift. Control alone with Backspace or Delete
// deletes a word — with Shift, Backspace in a text control to the line's start, `deleteSoftLineBackward` — named so
// where the selection is collapsed (one that is not is deleted as itself): Chrome on Linux.
pub(crate) fn edit(
    arena: &RealmArena,
    id: NodeId,
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
    let single_line = arena.get(id).filter(|n| &*n.local_name == "input");
    if facts & TYPEABLE == 0 || (host && selection == SELECTION_NONE) || (char.is_none() && !deleting) || (chord && !word && !line) {
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
        // (…a single-line field's inserts nothing: it submits — a text field's beforeinput fires all the same, an
        // `insertLineBreak` (Chrome and Firefox), no date's or range's)
        if let Some(n) = single_line {
            return n.input_has(crate::input_types::TYPED).then_some(("insertLineBreak", 0));
        }
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
pub(crate) fn motion(arena: &RealmArena, id: NodeId, key: &[u16], modifiers: u32) -> u32 {
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

// The keyboard the driver plays — every gesture of it: `send_keys`' keys, a chord's modifiers held around its key, and
// Capybara's `set` (`KeyGesture`). The bindings play one (form-fields.js `playKeys`): they ask for it (`keyGesture`) and
// then for each step in turn (`keyNext`), telling the engine the outcome of the one they took — whether the event they
// fired was canceled, whether an edit changed anything — and they fire what they are told to: which event, at what,
// with which key and modifiers, and whether at all, and which default action runs, is decided here, each step as the
// page stands once the one before it ran (a listener may move focus, make a field read-only, take a link's `href`).
#[derive(Default)]
pub(crate) struct Keyboard {
    // The gestures being played, the innermost last: one a step of another started (a frame's, a nested drain's) plays
    // to its end before the outer one goes on.
    gestures: Vec<KeyGesture>,
}

// A gesture: what it has yet to do, the key being pressed and how far it is, and where the keys go.
struct KeyGesture {
    // The realm it plays in.
    cid: i32,
    // The element the keys go to: the focused one, as a keyboard's go — `to` while focus stays where it was, though it
    // took none (a paragraph in an editing host) — and the focused element (`focused`) as the last look left it.
    to: NodeId,
    focused: Option<NodeId>,
    // Its jobs yet to start, and the steps the one under way has queued — the last of them, where it waits on its
    // outcome, marked so.
    jobs: std::collections::VecDeque<Job>,
    queued: std::collections::VecDeque<(Step, bool)>,
    // The job under way, and whether the bindings owe its stage the outcome of the step they took last.
    stage: Stage,
    owed: bool,
    // What it answers at its end.
    answer: bool,
}

// A job of a gesture.
enum Job {
    // The keys' target as the steps before left it: the focused element from now on looked at.
    Begin,
    // A key pressed and released with the modifiers `held`.
    Press(Key, u32),
    // A chord's modifier key pressed, or released: its `key`, `code` and `keyCode`, and the modifiers held as it is.
    Modifier(&'static str, &'static str, &'static str, u32, u32),
    // `set`'s, given the value.
    Set(SetValue),
}

// How far the job under way is.
enum Stage {
    Idle,
    Press(Box<Press>),
    Set(Box<SetJob>),
}

// A key's press, and what its steps have found so far.
struct Press {
    key: Key,
    held: u32,
    at: PressAt,
    // Whether its default actions are canceled: its keydown, keypress or beforeinput canceled.
    blocked: bool,
    // Its plan as its keypress left it, its edit, and whether its target is an editing host to it.
    plan: u32,
    edit: Option<(&'static str, u32)>,
    host: bool,
    // Whether its keyup goes to another element than its keydown's events did: focus moved.
    moved: bool,
}
#[derive(Clone, Copy, PartialEq)]
enum PressAt {
    KeyDown,
    KeyPress,
    Defaults,
    StepValue,
    StepCommit,
    Selection,
    BeforeInput,
    Edit,
    Input,
    Submit,
    Accelerator,
    FocusNavigation,
    KeyUp,
    Activation,
    Done,
}

// `set`'s job: its element, the value it is given, and its plan.
struct SetJob {
    at: SetAt,
    value: SetValue,
    n: NodeId,
    how: u32,
    text: Vec<u16>,
    option: Option<NodeId>,
}
#[derive(Clone, Copy, PartialEq)]
enum SetAt {
    Focused,
    Write,
    Submit,
    Done,
}

// A step, as the bindings take it (`step_value`) — or the engine itself (`Edited`, `Dirty`).
enum Step {
    Key { ty: &'static str, target: NodeId, key: Vec<u16>, code: Vec<u16>, key_code: u32, char_code: u32, modifiers: u32, forget_caret: bool },
    Input { ty: &'static str, target: NodeId, input_type: &'static str, data: Option<Vec<u16>>, cancelable: bool, target_ranges: bool },
    Change(NodeId),
    Focus(NodeId),
    Blur(NodeId),
    CaretEnd(NodeId),
    CaretLast(NodeId),
    CloseRequest(NodeId),
    Arrow(NodeId, Vec<u16>),
    StepValue(NodeId, bool),
    Commit(NodeId),
    Click(NodeId, u32),
    Submit(NodeId),
    Selection(NodeId),
    Move(NodeId, u32, bool),
    Insert(u32, Vec<u16>),
    Delete(bool, bool),
    Type(NodeId, Vec<u16>, u32),
    EditControl(NodeId, u32),
    FocusNavigation(bool),
    SelectAll(NodeId),
    Clipboard(&'static str, NodeId),
    Drain,
    Write(NodeId, Vec<u16>, u32),
    Pick(NodeId),
    ClickResolve(NodeId),
    ClearHost(NodeId),
    // (…the engine's own: the user edited the control or not — `change_on_blur.rs` — and it is dirtied by the user)
    Edited(NodeId, bool),
    Dirty(NodeId),
}

impl Key {
    // Its `keypress` char code, where it produces a character: Enter's a carriage return, a printable one's its
    // character's code point — UI Events' legacy `charCode`, "the Unicode reference number" — an emoji's past U+FFFF.
    fn char_code(&self) -> u32 {
        if is_units(&self.key, "Enter") {
            return 13;
        }
        self.char.as_ref().and_then(|c| char::decode_utf16(c.iter().copied()).next()).and_then(Result::ok).map_or(0, u32::from)
    }
}

// The key events' targets in realm `cid`: its document's focused element, else its body — `n` where it has neither.
fn key_event_target(arena: &RealmArena, cid: i32, n: NodeId) -> NodeId {
    focus_of(arena, cid).or_else(|| arena.realm_document(cid).and_then(|d| arena.body_element(d))).unwrap_or(n)
}
fn focus_of(arena: &RealmArena, cid: i32) -> Option<NodeId> {
    arena.realm_state(cid).and_then(|s| s.focus)
}

// The modifiers' bits of a chord's first `count` modifier keys.
fn modifier_bits(keys: &[(&'static str, &'static str, u32)]) -> u32 {
    keys.iter().fold(0, |bits, &(key, ..)| {
        bits | match key {
            "Control" => CTRL,
            "Meta" => META,
            "Alt" => ALT,
            _ => SHIFT,
        }
    })
}

impl KeyGesture {
    fn new(cid: i32, to: NodeId) -> Self {
        KeyGesture {
            cid,
            to,
            focused: None,
            jobs: Default::default(),
            queued: Default::default(),
            stage: Stage::Idle,
            owed: false,
            answer: true,
        }
    }

    // `send_keys`' keys to `n` (`atoms`: a text typed a character at a time, a key by its name, a chord), what it does to
    // `n` first (`send_target`: focusing it, its caret at its content's end, or the viewport), and the element they go to.
    fn send_keys(&mut self, arena: &mut RealmArena, how: u32, to: NodeId, atoms: Vec<Atom>) {
        let n = self.to;
        // (…keyboard-driven: `:focus-visible` applies)
        arena.pointer_modality = false;
        if how & SEND_FOCUS != 0 {
            self.tell(Step::Focus(n));
        }
        if how & SEND_CARET_LAST != 0 {
            self.tell(Step::CaretLast(n));
        } else if how & SEND_CARET_END != 0 {
            self.tell(Step::CaretEnd(n));
        } else if how & SEND_VIEWPORT != 0 {
            if let Some(focused) = arena.get(n).and_then(|d| focus_of(arena, d.realm)) {
                self.tell(Step::Blur(focused));
            }
        }
        self.to = to;
        // (…typed input is a user edit of the element the keys go to, so `minlength` / `maxlength` can apply — it never
        // does for a script's `value`)
        if arena.get(to).is_some_and(|d| d.is_html_named("input") || d.is_html_named("textarea")) {
            self.tell(Step::Dirty(to));
        }
        self.jobs.push_back(Job::Begin);
        for atom in atoms {
            match atom {
                Atom::Text(text) => self.type_text(&text, 0),
                Atom::Key(name) => self.jobs.push_back(Job::Press(resolve(&name, false), 0)),
                Atom::Chord(parts) => self.chord(&parts),
            }
        }
    }

    // A text typed a character at a time — a code point, a surrogate pair's two units one character — with `held`.
    fn type_text(&mut self, text: &[u16], held: u32) {
        let mut i = 0;
        while i < text.len() {
            let wide = (0xD800..0xDC00).contains(&text[i]) && text.get(i + 1).is_some_and(|u| (0xDC00..0xE000).contains(u));
            let end = i + if wide { 2 } else { 1 };
            self.jobs.push_back(Job::Press(resolve(&text[i..end], held & SHIFT != 0), held));
            i = end;
        }
    }

    // A chord — `[:control, 'a']`, `[:shift, 'side']`, `[:control]` — as a keyboard presses it (`chord`): a keydown for
    // each modifier first, each with the modifiers held so far, itself among them (Chrome: Capybara's `should generate
    // key events` checks their 16 / 17 / 18 keyCodes beside the key's), its key pressed with them held — a text that
    // names no key a character at a time, each the one its key types with Shift held (`!` for `1`, `ß` as it is) — then
    // their keyups, the last pressed first, each with the ones still held. A chord of modifiers alone presses no other key.
    fn chord(&mut self, parts: &[Vec<u16>]) {
        let c = chord(parts);
        for (i, &(key, code, key_code)) in c.keys.iter().enumerate() {
            self.jobs.push_back(Job::Modifier("keydown", key, code, key_code, modifier_bits(&c.keys[..=i])));
        }
        if c.unfold {
            self.type_text(&c.key, c.modifiers);
        } else if !c.key.is_empty() {
            self.jobs.push_back(Job::Press(resolve(&c.key, c.modifiers & SHIFT != 0), c.modifiers));
        }
        for (i, &(key, code, key_code)) in c.keys.iter().enumerate().rev() {
            self.jobs.push_back(Job::Modifier("keyup", key, code, key_code, modifier_bits(&c.keys[..i])));
        }
    }

    // The keys go to the focused element, as a keyboard's do: once focus moved since it was last looked at — a key's
    // default action (a Tab, an arrow through a radio group), a listener's `focus()` or `blur()` — to where it went
    // (`send_keys('a', :tab, 'b')` types the `b` into the next field); while it stays, to `to`. Whether they moved.
    fn follow_focus(&mut self, arena: &RealmArena) -> bool {
        let focus = focus_of(arena, self.cid);
        if focus == self.focused {
            return false;
        }
        self.focused = focus;
        let to = key_event_target(arena, self.cid, self.to);
        std::mem::replace(&mut self.to, to) != to
    }

    // A key event at the keys' target.
    fn key_event(&self, ty: &'static str, key: &Key, modifiers: u32, forget_caret: bool) -> Step {
        let char_code = if ty == "keypress" { key.char_code() } else { 0 };
        // (…a keypress's key code its char code, Chrome's)
        let key_code = if ty == "keypress" { char_code } else { key.key_code };
        Step::Key { ty, target: self.to, key: key.key.clone(), code: key.code.clone(), key_code, char_code, modifiers, forget_caret }
    }

    // The next step the bindings take, the outcome of the one they took last `outcome`; None at the gesture's end.
    fn next(&mut self, arena: &mut RealmArena, outcome: u32) -> Option<Step> {
        let mut outcome = std::mem::take(&mut self.owed).then_some(outcome);
        loop {
            if let Some((step, owed)) = self.queued.pop_front() {
                match step {
                    Step::Edited(id, edited) => arena.mark_change(id, edited),
                    Step::Dirty(id) => {
                        let bits = arena.get(id).map_or(0, |n| n.state);
                        arena.set_state(id, bits | crate::dom::STATE_DIRTY_BY_USER);
                    },
                    _ => {
                        self.owed = owed;
                        return Some(step);
                    },
                }
                continue;
            }
            match std::mem::replace(&mut self.stage, Stage::Idle) {
                Stage::Press(mut press) => {
                    self.press(arena, &mut press, outcome.take());
                    if press.at != PressAt::Done {
                        self.stage = Stage::Press(press);
                    }
                },
                Stage::Set(mut set) => {
                    self.set(arena, &mut set);
                    if set.at != SetAt::Done {
                        self.stage = Stage::Set(set);
                    }
                },
                Stage::Idle => match self.jobs.pop_front()? {
                    Job::Begin => self.focused = focus_of(arena, self.cid),
                    Job::Press(key, held) => {
                        let press = Press { key, held, at: PressAt::KeyDown, blocked: false, plan: 0, edit: None, host: false, moved: false };
                        self.stage = Stage::Press(Box::new(press));
                    },
                    Job::Modifier(ty, key, code, key_code, modifiers) => {
                        self.follow_focus(arena);
                        let key = Key { named: true, key: units(key), code: units(code), key_code, char: None, input_type: None };
                        self.tell(self.key_event(ty, &key, modifiers, false));
                    },
                    Job::Set(value) => {
                        let mut set = SetJob { at: SetAt::Focused, value, n: self.to, how: SET_NONE, text: Vec::new(), option: None };
                        self.set_begin(arena, &mut set);
                        if set.at != SetAt::Done {
                            self.stage = Stage::Set(Box::new(set));
                        }
                    },
                },
            }
        }
    }
}

// What `send_keys` is given: a text, a key by its name, a chord.
pub(crate) enum Atom {
    Text(Vec<u16>),
    Key(Vec<u16>),
    Chord(Vec<Vec<u16>>),
}

// The keys that move the caret by lines, which carry what the last of them left (layout.js `forgetCaretMove`).
fn line_key(key: &[u16]) -> bool {
    ["ArrowUp", "ArrowDown", "Home", "End"].iter().any(|k| is_units(key, k))
}

impl KeyGesture {
    fn ask(&mut self, step: Step) {
        self.queued.push_back((step, true));
    }
    fn tell(&mut self, step: Step) {
        self.queued.push_back((step, false));
    }

    // A key's press, as UI Events orders its events — keydown, keypress, beforeinput, input, keyup — and HTML and UI
    // Events its default actions, each where none of its events before was canceled, all in the one task (Chrome and
    // Firefox: a listener's microtasks run between its events, so a `.then(() => e.preventDefault())` on the keydown —
    // Tagify's, Algolia's — cancels the key's default as a canceling listener does). `outcome` that of the step it asked
    // last.
    fn press(&mut self, arena: &mut RealmArena, p: &mut Press, outcome: Option<u32>) {
        // (…the step it asked last answering yes: its event canceled, its step or its edit made)
        let yes = outcome == Some(1);
        // (…what the key does to the element its events go to: `plan` — asked again after each event, as a listener may
        // change what that is to the key: remove a link's `href`, make an input read-only)
        let plan = |arena: &RealmArena, to: NodeId| plan(arena, to, &p.key.key, p.key.char.as_deref(), p.held);
        match p.at {
            PressAt::KeyDown => {
                self.follow_focus(arena);
                p.at = PressAt::KeyPress;
                self.ask(self.key_event("keydown", &p.key, p.held, !line_key(&p.key.key)));
            },
            // Its keypress — the legacy event of a key that produces a character: a printable key's, Enter's (a carriage
            // return), none with Control / Alt / Meta held — where its keydown was not canceled, its char code the
            // character's (Mousetrap-shape libraries, Discourse's `@discourse/itsatrap`, read `e.which` to look up a
            // binding). It and the rest of the key's events and actions — the character typed, Enter's submission — go
            // where focus is once the keydown's listeners moved it: to the element they focused, to the body where they
            // blurred it (Chrome and Firefox; UI Events §3.7: a key event's target is the focused element).
            PressAt::KeyPress => {
                p.blocked = yes;
                self.follow_focus(arena);
                p.at = PressAt::Defaults;
                if !p.blocked && plan(arena, self.to) & KEYPRESS != 0 {
                    self.ask(self.key_event("keypress", &p.key, p.held, false));
                }
            },
            PressAt::Defaults => {
                p.blocked |= yes;
                p.plan = plan(arena, self.to);
                p.host = p.plan & EDITING_HOST != 0;
                p.at = PressAt::Selection;
                if p.blocked {
                    p.at = PressAt::KeyUp;
                    return;
                }
                // Escape's: a close request (HTML §6.4.4) — the topmost showing auto popover hidden, else the dialog
                // opened last that takes one closed.
                if p.plan & CLOSE_REQUEST != 0 {
                    self.tell(Step::CloseRequest(self.to));
                }
                // An arrow on a select or a radio button: the adjacent option picked, the next or previous radio button
                // of its group focused and clicked (validity.rs `arrowDefault`).
                if p.plan & ARROW_CHOICE != 0 {
                    self.tell(Step::Arrow(self.to, p.key.key.clone()));
                    p.at = PressAt::KeyUp;
                    return;
                }
                // ArrowUp / ArrowDown on a stepped input steps its value: beforeinput, the step, `input` where the value
                // moved, and the edit committed — `change` where it moved since it last was (Chrome).
                if p.plan & STEP != 0 {
                    p.at = PressAt::StepValue;
                    self.ask(Step::Input { ty: "beforeinput", target: self.to, input_type: "", data: None, cancelable: true, target_ranges: false });
                    return;
                }
                // Enter on a link, a button or a summary: its activation, a keyboard's click — no pointer, its count 0
                // (react-aria's `isVirtualClick` tells it from a mouse's) — a link's in a new window with Control /
                // Meta held.
                if p.plan & ENTER_ACTIVATES != 0 {
                    self.tell(Step::Click(self.to, p.held));
                }
            },
            PressAt::StepValue => {
                p.at = PressAt::KeyUp;
                if !yes {
                    p.at = PressAt::StepCommit;
                    self.ask(Step::StepValue(self.to, is_units(&p.key.key, "ArrowUp")));
                }
            },
            PressAt::StepCommit => {
                if yes {
                    self.tell(Step::Edited(self.to, true));
                    self.tell(Step::Input { ty: "input", target: self.to, input_type: "", data: None, cancelable: false, target_ranges: false });
                }
                self.tell(Step::Commit(self.to));
                p.at = PressAt::KeyUp;
            },
            // What it types (`edit`): an editing host's by the document's selection, which the bindings read, a text
            // control's by its own.
            PressAt::Selection => {
                p.at = PressAt::BeforeInput;
                if p.host {
                    self.ask(Step::Selection(self.to));
                } else {
                    let (sel, set) = arena.text_selection(self.to);
                    let selection = if !set || sel.start == sel.end { SELECTION_COLLAPSED } else { SELECTION_RANGE };
                    p.edit = edit(arena, self.to, &p.key.key, p.key.char.as_deref(), p.key.input_type, p.held, selection);
                }
            },
            // …its beforeinput, with the `inputType` of the edit — an insertion's targeting the selection, which
            // ProseMirror / Tiptap map back to model positions — `data` an `insertText`'s text. Enter in a single-line
            // field fires one too, an `insertLineBreak` that inserts nothing, and canceling it stops the submission
            // (Chrome; Firefox submits).
            PressAt::BeforeInput => {
                if p.host {
                    p.edit = edit(arena, self.to, &p.key.key, p.key.char.as_deref(), p.key.input_type, p.held, outcome.unwrap_or(SELECTION_NONE));
                }
                p.at = PressAt::Edit;
                if let Some((input_type, bits)) = p.edit {
                    let data = (input_type == "insertText").then(|| p.key.char.clone()).flatten();
                    let target_ranges = p.host && bits & EDIT_DELETE == 0;
                    self.ask(Step::Input { ty: "beforeinput", target: self.to, input_type, data, cancelable: true, target_ranges });
                }
            },
            // Home / End and the arrows move the caret (`motion`: Control a word's or the whole text's, Shift extending
            // the selection — Chrome on Linux) — no beforeinput, no input — where the bindings place it; then the edit,
            // the engine's (editing_insert.rs, editing_delete.rs, text_selection.rs), and `input` where it changed
            // something — an editing host's whatever it did, as WPT input-events-typing holds it (Chrome fires none
            // where there was nothing to delete); a keystroke `maxlength` or a number field's text refuses none (Chrome).
            PressAt::Edit => {
                p.blocked |= yes;
                p.at = PressAt::Submit;
                if p.blocked {
                    return;
                }
                let motion = motion(arena, self.to, &p.key.key, p.held);
                if motion != 0 {
                    self.tell(Step::Move(self.to, motion, p.host));
                }
                let Some((_, bits)) = p.edit.filter(|e| e.1 != 0) else { return };
                let ch = p.key.char.clone().unwrap_or_default();
                let forward = bits & EDIT_FORWARD != 0;
                let step = match (p.host, bits) {
                    (true, b) if b & EDIT_TYPE != 0 => Step::Insert(INSERT_TEXT, ch),
                    (true, b) if b & EDIT_PARAGRAPH != 0 => Step::Insert(INSERT_PARAGRAPH, Vec::new()),
                    (true, b) if b & EDIT_LINE_BREAK != 0 => Step::Insert(INSERT_LINE_BREAK, Vec::new()),
                    (true, b) => Step::Delete(forward, b & EDIT_WORD != 0),
                    (false, b) if b & EDIT_TYPE != 0 => Step::Type(self.to, ch, crate::text_selection::TYPE_AT_CARET),
                    (false, b) => Step::EditControl(self.to, crate::text_selection::control_edit(forward, b & EDIT_WORD != 0, b & EDIT_LINE != 0)),
                };
                p.at = PressAt::Input;
                self.ask(step);
            },
            PressAt::Input => {
                if yes {
                    let (input_type, _) = p.edit.expect("an edit");
                    let data = (input_type == "insertText").then(|| p.key.char.clone()).flatten();
                    self.tell(Step::Edited(self.to, true));
                    self.tell(Step::Input { ty: "input", target: self.to, input_type, data, cancelable: false, target_ranges: false });
                }
                p.at = PressAt::Submit;
            },
            // Enter's in a field of a form: its implicit submission (HTML §4.10.21.2).
            PressAt::Submit => {
                if !p.blocked && p.plan & IMPLICIT_SUBMIT != 0 {
                    self.implicit_submission(arena, self.to);
                }
                p.at = PressAt::Accelerator;
            },
            // Control / Meta with A, X, C, V: all the content selected — an editing host's root editable element's (a
            // design-mode document's body's, not the head with it: element_state.rs `editing_root`), a text control's,
            // else the body's — or the clipboard's cut, copy and paste of the focused element's selection — the
            // keydown's default action, before the key's keyup (Chrome).
            PressAt::Accelerator => {
                p.at = PressAt::FocusNavigation;
                if p.blocked {
                    return;
                }
                let plan = plan(arena, self.to);
                if plan & SELECT_ALL != 0 {
                    if let Some(el) = select_all_target(arena, self.to, plan) {
                        self.tell(Step::SelectAll(el));
                    }
                } else if plan & (CUT | COPY | PASTE) != 0 {
                    let op = if plan & CUT != 0 { "cut" } else if plan & COPY != 0 { "copy" } else { "paste" };
                    self.tell(Step::Clipboard(op, self.to));
                }
            },
            // Tab's: focus moved through the document's sequential focus navigation order, back with Shift — before the
            // key's keyup, which goes to the element it focused (Chrome and Firefox).
            PressAt::FocusNavigation => {
                if !p.blocked && p.plan & FOCUS_NAVIGATION != 0 {
                    self.tell(Step::FocusNavigation(p.held & SHIFT != 0));
                }
                p.at = PressAt::KeyUp;
            },
            // Its keyup, where focus is now: a keydown listener that blurred the field — Discourse's Escape closing its
            // search menu — has it go to the body, not back to the field.
            PressAt::KeyUp => {
                p.moved = self.follow_focus(arena);
                p.at = PressAt::Activation;
                self.ask(self.key_event("keyup", &p.key, p.held, false));
            },
            // Space activates a focused button, checkbox or radio button on its release — the keyup's default action,
            // so unless it, its keydown or its keypress was canceled, or focus left it.
            PressAt::Activation => {
                if !p.blocked && !yes && !p.moved && plan(arena, self.to) & SPACE_ACTIVATES != 0 {
                    self.tell(Step::Click(self.to, p.held));
                }
                p.at = PressAt::Done;
            },
            PressAt::Done => {},
        }
    }

    // HTML implicit submission from `control` — Enter in it, or a `set("…\n")` — its form (`implicit_submission_form`)
    // submitted by a click at its default button, whose activation submits it, a click listener that cancels it stopping
    // it; a disabled one blocking the submission — or, with none, an interactive submission from the form itself. A
    // dirtied field commits its `change` before the `submit`, keeping focus (Chrome and Firefox).
    fn implicit_submission(&mut self, arena: &RealmArena, control: NodeId) {
        let Some(form) = arena.implicit_submission_form(control) else { return };
        let button = arena.default_button_of(form);
        if button.is_some_and(|b| arena.is_actually_disabled(b)) {
            return;
        }
        self.tell(Step::Commit(control));
        self.tell(button.map_or(Step::Submit(form), |b| Step::Click(b, 0)));
    }
}

// What an insertion in an editing host inserts (dom-nodes.js `insertInEditingHost`: editing_insert.rs `editInsert`).
const INSERT_TEXT: u32 = 0;
const INSERT_LINE_BREAK: u32 = 1;
const INSERT_PARAGRAPH: u32 = 2;

// What Control / Meta + A selects in `to`, its plan `plan`: an editing host's root editable element's content, a text
// control's whose `select()` applies, the body's (or the document element's) — none in a text entry field of no selection
// the engine models (a number one).
fn select_all_target(arena: &RealmArena, to: NodeId, plan: u32) -> Option<NodeId> {
    let n = arena.get(to)?;
    if plan & EDITING_HOST != 0 {
        if let Some(root) = arena.editing_root(to) {
            return Some(root);
        }
    }
    if arena.selection_applies(n, true) {
        return Some(to);
    }
    if n.is_html_named("input") && n.input_has(crate::input_types::READONLY) {
        return None;
    }
    let doc = arena.get(arena.shadow_including_root(to)).and_then(|_| arena.realm_document(n.realm))?;
    arena.body_element(doc).or_else(|| arena.first_element_child(doc))
}

impl KeyGesture {
    // Capybara's `set`, as Selenium does it (`set_plan`): the element focused first where that is a text control or an
    // editing host, as Selenium's typing focuses it — delegated focus handlers (Redmine's inline autocomplete, Trix's
    // editor, Stimulus' actionable-on-focus controllers) wire up there — and the zero-delay work they queued run, which
    // may swap the control out from under it (`set_focused`).
    fn set_begin(&mut self, arena: &mut RealmArena, set: &mut SetJob) {
        self.plan_set(arena, set, true);
        if set.how & SET_KIND == SET_NONE {
            self.answer = false;
            set.at = SetAt::Done;
        } else if set.how & SET_FOCUS != 0 {
            self.tell(Step::Focus(set.n));
            self.tell(Step::Drain);
        } else {
            set.at = SetAt::Write;
        }
    }
    // `set_plan`: its kind, the text it writes and the option it picks — a control's typing a user's edit, so `tooShort`
    // / `tooLong` can apply (unlike a script's `value`).
    fn plan_set(&mut self, arena: &RealmArena, set: &mut SetJob, dirty: bool) {
        (set.how, set.text, set.option) = set_plan(arena, set.n, &set.value);
        if dirty && set.how & SET_CONTROL != 0 {
            self.tell(Step::Dirty(set.n));
        }
    }

    fn set(&mut self, arena: &mut RealmArena, set: &mut SetJob) {
        match set.at {
            // Its focus handlers may have swapped the control: `<trix-editor>` focuses its inner editing host, a
            // replaceWith-style swap detaches the original and focuses its replacement — the focused one written where it
            // is inside the original, or the original left its tree — but not a control an app mounts beside it (Forem's
            // comments' Preact tree), the field asked for written still. Asked again of the element as its focus handlers
            // left it: its type, its checkedness, made read-only, as anything they changed of it stands.
            SetAt::Focused => {
                let n = set.n;
                let swapped = focus_of(arena, self.cid).filter(|&a| {
                    a != n
                        && (crate::ranges::contains(arena, n, a) || arena.parent_of(n).is_none())
                        && arena.get(a).is_some_and(|e| e.is_html_named("input") || e.is_html_named("textarea") || arena.is_editable(a))
                });
                set.n = swapped.unwrap_or(n);
                self.plan_set(arena, set, false);
                set.at = SetAt::Write;
                if set.how & SET_KIND == SET_NONE {
                    self.answer = false;
                    set.at = SetAt::Done;
                }
            },
            SetAt::Write => {
                let (n, text) = (set.n, std::mem::take(&mut set.text));
                set.at = SetAt::Submit;
                match set.how & SET_KIND {
                    // (…typed over what it held, CR / CRLF as LF — a textarea's child text, the default `<form>.reset()`
                    // restores, left as it is — cut at `maxlength`, the caret after it, as typing leaves it: Tribute /
                    // inline-autocomplete read `selectionStart` to find the trigger character before the cursor)
                    SET_TYPE => self.tell(Step::Type(n, text, crate::text_selection::TYPE_WHOLE)),
                    // (…a number field keeps what the user typed: out of its range or off its step is a constraint it
                    // now suffers, text that is no number sanitizing to "" with badInput — flatpickr's minute input,
                    // `type=number step=5`, keeps a typed 17)
                    SET_LIVE => self.tell(Step::Write(n, text, WRITE_LIVE)),
                    SET_SANITIZED => self.tell(Step::Write(n, text, WRITE_SANITIZED)),
                    // (…an attribute write, recorded for MutationObserver and a context change for `[value=…]` rules)
                    SET_VALUE_ATTRIBUTE => self.tell(Step::Write(n, text, WRITE_ATTRIBUTE)),
                    SET_OPTION => self.tell(Step::Pick(set.option.expect("an option"))),
                    // Selenium's `set(true)` / `set(false)`: the control clicked — the user's pointer click, the driver's
                    // own — and nothing else.
                    SET_CLICK => {
                        self.tell(Step::ClickResolve(n));
                        set.at = SetAt::Done;
                        return;
                    },
                    SET_EDITING_HOST => {
                        // An editing host's content made `text` as a user makes it: its content selected and deleted, the
                        // caret at the first caret position of what is left, and `text` typed a key at a time, each
                        // through the whole of a key's press (ProseMirror observes the deletion and resets the editor to
                        // its empty placeholder, the characters typed into it).
                        self.tell(Step::ClearHost(n));
                        self.to = n;
                        self.jobs.push_back(Job::Begin);
                        self.type_text(&text, 0);
                        set.at = SetAt::Done;
                        return;
                    },
                    _ => {
                        set.at = SetAt::Done;
                        return;
                    },
                }
                // (…its keydown and keyup — Tribute initialises its per-keystroke state in the keydown — around the
                // change, of no key: there is no character's chain to lean on; then `input` and `change` — which a
                // checkbox's fires on a user's interaction alone, but Selenium's `set` fires both — the user's edit
                // committed so its blur fires none again)
                let blank = |ty| Step::Key { ty, target: n, key: Vec::new(), code: Vec::new(), key_code: 0, char_code: 0, modifiers: 0, forget_caret: false };
                if set.how & SET_FOCUS != 0 {
                    self.tell(blank("keydown"));
                }
                self.tell(Step::Input { ty: "input", target: n, input_type: "", data: None, cancelable: false, target_ranges: false });
                self.tell(Step::Change(n));
                self.tell(Step::Edited(n, false));
                if set.how & SET_FOCUS != 0 {
                    self.tell(blank("keyup"));
                }
            },
            // A value ending in a line feed submits as Enter in the field does.
            SetAt::Submit => {
                if set.how & SET_SUBMIT != 0 {
                    self.implicit_submission(arena, set.n);
                }
                set.at = SetAt::Done;
            },
            SetAt::Done => {},
        }
    }
}

// How a `set` writes a control's value (form-fields.js): its live value as given, sanitized first, or its `value` attribute.
const WRITE_LIVE: u32 = 0;
const WRITE_SANITIZED: u32 = 1;
const WRITE_ATTRIBUTE: u32 = 2;

// A step as the bindings take it, `[kind, …]` (form-fields.js `keyStep`): a KeyboardEvent `[KEY, type, target, key, code,
// keyCode, charCode, modifiers, forgetCaret]`, an InputEvent `[INPUT, type, target, inputType, data, flags]` (CANCELABLE,
// TARGET_RANGES: the selection's), and the default actions' — each of an element, `[kind, element, …]`.
const KEY: u32 = 0;
const INPUT: u32 = 1;
const CHANGE: u32 = 2;
const FOCUS: u32 = 3;
const BLUR: u32 = 4;
const CARET_END: u32 = 5;
const CARET_LAST: u32 = 6;
const CLOSE: u32 = 7;
const ARROW: u32 = 8;
const STEP_VALUE: u32 = 9;
const COMMIT: u32 = 10;
const CLICK: u32 = 11;
const SUBMIT: u32 = 12;
const SELECTION: u32 = 13;
const MOVE: u32 = 14;
const INSERT: u32 = 15;
const DELETE: u32 = 16;
const TYPE: u32 = 17;
const EDIT_CONTROL: u32 = 18;
const FOCUS_NAV: u32 = 19;
const SELECT_ALL_STEP: u32 = 20;
const CLIPBOARD: u32 = 21;
const DRAIN: u32 = 22;
const WRITE: u32 = 23;
const PICK: u32 = 24;
const CLICK_RESOLVE: u32 = 25;
const CLEAR_HOST: u32 = 26;
const CANCELABLE: u32 = 1;
const TARGET_RANGES: u32 = 2;
fn step_value<'s>(scope: &mut v8::PinScope<'s, '_>, step: Step) -> v8::Local<'s, v8::Value> {
    let int = |scope: &mut v8::PinScope<'s, '_>, n: u32| -> v8::Local<'s, v8::Value> { v8::Integer::new_from_unsigned(scope, n).into() };
    let name = |scope: &mut v8::PinScope<'s, '_>, s: &str| -> v8::Local<'s, v8::Value> {
        v8::String::new_from_one_byte(scope, s.as_bytes(), v8::NewStringType::Internalized).unwrap().into()
    };
    let node = |scope: &mut v8::PinScope<'s, '_>, id: NodeId| crate::dom::node_value(scope, Some(id));
    let items: Vec<v8::Local<'s, v8::Value>> = match step {
        Step::Key { ty, target, key, code, key_code, char_code, modifiers, forget_caret } => vec![
            int(scope, KEY),
            name(scope, ty),
            node(scope, target),
            crate::dom::utf16_value(scope, &key),
            crate::dom::utf16_value(scope, &code),
            int(scope, key_code),
            int(scope, char_code),
            int(scope, modifiers),
            v8::Boolean::new(scope, forget_caret).into(),
        ],
        Step::Input { ty, target, input_type, data, cancelable, target_ranges } => {
            let data = match data {
                Some(d) => crate::dom::utf16_value(scope, &d),
                None => v8::null(scope).into(),
            };
            let flags = if cancelable { CANCELABLE } else { 0 } | if target_ranges { TARGET_RANGES } else { 0 };
            vec![int(scope, INPUT), name(scope, ty), node(scope, target), name(scope, input_type), data, int(scope, flags)]
        },
        Step::Change(el) => vec![int(scope, CHANGE), node(scope, el)],
        Step::Focus(el) => vec![int(scope, FOCUS), node(scope, el)],
        Step::Blur(el) => vec![int(scope, BLUR), node(scope, el)],
        Step::CaretEnd(el) => vec![int(scope, CARET_END), node(scope, el)],
        Step::CaretLast(el) => vec![int(scope, CARET_LAST), node(scope, el)],
        Step::CloseRequest(el) => vec![int(scope, CLOSE), node(scope, el)],
        Step::Arrow(el, key) => vec![int(scope, ARROW), node(scope, el), crate::dom::utf16_value(scope, &key)],
        Step::StepValue(el, up) => vec![int(scope, STEP_VALUE), node(scope, el), v8::Boolean::new(scope, up).into()],
        Step::Commit(el) => vec![int(scope, COMMIT), node(scope, el)],
        Step::Click(el, modifiers) => vec![int(scope, CLICK), node(scope, el), int(scope, modifiers)],
        Step::Submit(form) => vec![int(scope, SUBMIT), node(scope, form)],
        Step::Selection(el) => vec![int(scope, SELECTION), node(scope, el)],
        Step::Move(el, motion, host) => vec![int(scope, MOVE), node(scope, el), int(scope, motion), v8::Boolean::new(scope, host).into()],
        Step::Insert(kind, text) => vec![int(scope, INSERT), int(scope, kind), crate::dom::utf16_value(scope, &text)],
        Step::Delete(forward, word) => vec![int(scope, DELETE), v8::Boolean::new(scope, forward).into(), v8::Boolean::new(scope, word).into()],
        Step::Type(el, text, how) => vec![int(scope, TYPE), node(scope, el), crate::dom::utf16_value(scope, &text), int(scope, how)],
        Step::EditControl(el, edits) => vec![int(scope, EDIT_CONTROL), node(scope, el), int(scope, edits)],
        Step::FocusNavigation(back) => vec![int(scope, FOCUS_NAV), v8::Boolean::new(scope, back).into()],
        Step::SelectAll(el) => vec![int(scope, SELECT_ALL_STEP), node(scope, el)],
        Step::Clipboard(op, el) => vec![int(scope, CLIPBOARD), name(scope, op), node(scope, el)],
        Step::Drain => vec![int(scope, DRAIN)],
        Step::Write(el, text, how) => vec![int(scope, WRITE), node(scope, el), crate::dom::utf16_value(scope, &text), int(scope, how)],
        Step::Pick(option) => vec![int(scope, PICK), node(scope, option)],
        Step::ClickResolve(el) => vec![int(scope, CLICK_RESOLVE), node(scope, el)],
        Step::ClearHost(el) => vec![int(scope, CLEAR_HOST), node(scope, el)],
        Step::Edited(..) | Step::Dirty(_) => unreachable!("taken by the engine"),
    };
    v8::Array::new_with_elements(scope, &items).into()
}

// The gesture's next step to the bindings, the outcome of the one they took last `outcome` — or, at its end, what it
// answers.
fn answer_next(scope: &mut v8::PinScope<'_, '_>, mut rv: v8::ReturnValue<'_, v8::Value>, outcome: u32) {
    let d = crate::dom::dom(scope);
    let Some(gesture) = d.keyboard.gestures.last_mut() else { return rv.set_bool(false) };
    // (…none past its realm's end: a frame whose listener removed it)
    let next = match d.arena.enter_known(gesture.cid) {
        Some(arena) => gesture.next(arena, outcome),
        None => None,
    };
    match next {
        Some(step) => {
            let value = step_value(scope, step);
            rv.set(value);
        },
        None => {
            let answer = crate::dom::dom(scope).keyboard.gestures.pop().is_some_and(|g| g.answer);
            rv.set_bool(answer);
        },
    }
}

// What a gesture plays (`keyGesture`'s `kind`): `send_keys`' keys, or `set`.
const SEND_KEYS: u32 = 0;
const SET: u32 = 1;

// __dom.keyGesture(kind, element, what) -> the first step of a gesture of the keyboard at `element` — `send_keys`' keys
// (`what` its atoms: `{kind: 'text', value}`, `{kind: 'key', name}`, `{kind: 'combo', parts}`) or `set`'s (`what` its
// value: a boolean, null, or any other value as its string; `element` null where it vanished, the focused text control or
// editing host taken instead) — its answer where it has none: false where there is no element to play it at.
fn gesture_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let kind = args.get(0).uint32_value(scope).unwrap_or(SEND_KEYS);
    let n = crate::node_handle::nid_of(scope, args.get(1)).filter(|&id| crate::dom::realm(scope, cid).is_element(id));
    if kind != SET {
        let Some(n) = n else { return rv.set_bool(false) };
        let atoms = atoms_arg(scope, args.get(2));
        let (how, to) = crate::rendered::with_engine(scope, &args, |engine, arena, now| send_target(engine, arena, n, now)).unwrap_or((0, n));
        let mut gesture = KeyGesture::new(cid, n);
        gesture.send_keys(crate::dom::realm(scope, cid), how, to, atoms);
        crate::dom::dom(scope).keyboard.gestures.push(gesture);
    } else {
        let value = args.get(2);
        let value = if value.is_boolean() {
            SetValue::Bool(value.is_true())
        } else if value.is_null_or_undefined() {
            SetValue::Text(Vec::new())
        } else {
            let Some(text) = value.to_string(scope) else { return };
            SetValue::Text(crate::dom::utf16_arg(scope, text.into()))
        };
        // The element vanished between the test's `find` and the `set`: Forem's reply form focuses its textarea in a
        // timer that `set`'s `tick_real_time` runs, whose focus handler hands off to Preact's `replaceTextArea` and
        // removes the original — so whatever the page just focused, what the test meant to type into, where it is a
        // text control or an editing host.
        let arena = crate::dom::realm(scope, cid);
        let n = n.or_else(|| {
            let doc = arena.realm_document(cid)?;
            focus_of(arena, cid).filter(|&a| {
                Some(a) != arena.body_element(doc) && arena.get(a).is_some_and(|e| e.is_html_named("input") || e.is_html_named("textarea") || arena.is_editable(a))
            })
        });
        let Some(n) = n else { return rv.set_bool(false) };
        let mut gesture = KeyGesture::new(cid, n);
        gesture.jobs.push_back(Job::Set(value));
        crate::dom::dom(scope).keyboard.gestures.push(gesture);
    }
    answer_next(scope, rv, 0);
}

// __dom.keyNext(outcome) -> the gesture's next step, the outcome of the step last handed out `outcome` (a canceled
// event's 1; an edit's 1 where it changed something; the selection a SELECTION step reads); its answer at its end.
fn next_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    let outcome = args.get(0).uint32_value(scope).unwrap_or(0);
    answer_next(scope, rv, outcome);
}

// `send_keys`' atoms, read off the own properties of the records the host made.
fn atoms_arg(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Vec<Atom> {
    let Ok(list) = v8::Local::<v8::Array>::try_from(value) else { return Vec::new() };
    let own = |scope: &mut v8::PinScope<'_, '_>, obj: v8::Local<'_, v8::Object>, k: &str| -> Option<Vec<u16>> {
        let key: v8::Local<v8::Name> = v8::String::new(scope, k)?.into();
        if !obj.has_own_property(scope, key)? {
            return None;
        }
        let v = obj.get(scope, key.into())?;
        (!v.is_null_or_undefined()).then(|| crate::dom::utf16_arg(scope, v))
    };
    let mut atoms = Vec::new();
    for i in 0..list.length() {
        let Some(atom) = list.get_index(scope, i).and_then(|a| a.to_object(scope)) else { continue };
        let Some(kind) = own(scope, atom, "kind") else { continue };
        if is_units(&kind, "text") {
            atoms.push(Atom::Text(own(scope, atom, "value").unwrap_or_default()));
        } else if is_units(&kind, "key") {
            atoms.push(Atom::Key(own(scope, atom, "name").unwrap_or_default()));
        } else if is_units(&kind, "combo") {
            let key: v8::Local<v8::Name> = v8::String::new(scope, "parts").unwrap().into();
            let parts = atom.has_own_property(scope, key).unwrap_or(false).then(|| atom.get(scope, key.into())).flatten();
            let parts = parts.and_then(|p| v8::Local::<v8::Array>::try_from(p).ok());
            let parts = parts.map_or_else(Vec::new, |a| (0..a.length()).map(|j| a.get_index(scope, j).map_or_else(Vec::new, |v| crate::dom::utf16_arg(scope, v))).collect());
            atoms.push(Atom::Chord(parts));
        }
    }
    atoms
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "resolveKey", resolve_op, context_id);
    crate::dom::register(scope, ns, "keyGesture", gesture_op, context_id);
    crate::dom::register(scope, ns, "keyNext", next_op, context_id);
}
// __dom.resolveKey(spec, shift) -> [key, code, keyCode, char (null for none), inputType (null for none), named, charCode]
// (`resolve`; `charCode` its keypress's, `Key::char_code`).
fn resolve_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let spec = crate::dom::utf16_arg(scope, args.get(0));
    let shift = args.get(1).is_true();
    let k = resolve(&spec, shift);
    let ch: v8::Local<v8::Value> = match k.char.as_deref() {
        Some(c) => crate::dom::utf16_value(scope, c),
        None => v8::null(scope).into(),
    };
    let items: [v8::Local<v8::Value>; 7] = [
        crate::dom::utf16_value(scope, &k.key),
        crate::dom::utf16_value(scope, &k.code),
        v8::Integer::new_from_unsigned(scope, k.key_code).into(),
        ch,
        k.input_type.and_then(|t| v8::String::new(scope, t)).map_or_else(|| v8::null(scope).into(), Into::into),
        v8::Boolean::new(scope, k.named).into(),
        v8::Integer::new_from_unsigned(scope, k.char_code()).into(),
    ];
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
    fn a_chord_holds_its_modifiers_while_its_key_is_pressed() {
        let parts = |ps: &[&str]| ps.iter().map(|p| units(p)).collect::<Vec<_>>();
        let c = chord(&parts(&["control", "SHIFT", "a"]));
        assert_eq!(c.modifiers, CTRL | SHIFT);
        assert_eq!(c.keys, [("Control", "ControlLeft", 17), ("Shift", "ShiftLeft", 16)]);
        assert_eq!((String::from_utf16_lossy(&c.key), c.unfold), ("a".into(), false));
        // (…every part a modifier: the chord's key none, its modifiers pressed and released alone)
        let c = chord(&parts(&["cmd", "alt"]));
        assert_eq!((c.modifiers, c.keys.len(), c.key.len()), (META | ALT, 2, 0));
        // (…a modifier after the key held for none, and a name before it that is none dropped)
        let c = chord(&parts(&["bogus", "shift", "side", "ctrl"]));
        assert_eq!((c.modifiers, String::from_utf16_lossy(&c.key), c.unfold), (SHIFT, "side".into(), true));
        // (…a key's name is no text to unfold)
        assert!(!chord(&parts(&["control", "enter"])).unfold);
    }

    #[test]
    fn a_chord_presses_its_modifiers_around_its_key() {
        let parts = |ps: &[&str]| ps.iter().map(|p| units(p)).collect::<Vec<_>>();
        let jobs = |ps: &[&str]| {
            let mut g = KeyGesture::new(0, NodeId { idx: 0, generation: 0 });
            g.chord(&parts(ps));
            g.jobs
                .into_iter()
                .map(|j| match j {
                    Job::Modifier(ty, key, _, _, held) => format!("{ty} {key} {held}"),
                    Job::Press(k, held) => format!("press {} {held}", String::from_utf16_lossy(&k.key)),
                    _ => unreachable!(),
                })
                .collect::<Vec<_>>()
        };
        // (…each modifier going down with those held so far, itself among them, and up with those still held; the key
        // with all of them, Shift typing its shifted character)
        assert_eq!(jobs(&["control", "shift", "a"]), ["keydown Control 1", "keydown Shift 9", "press A 9", "keyup Shift 1", "keyup Control 0"]);
        // (…a modifier alone presses no other key; a text that names none unfolds a character at a time)
        assert_eq!(jobs(&["control"]), ["keydown Control 1", "keyup Control 0"]);
        assert_eq!(jobs(&["shift", "ab"]), ["keydown Shift 8", "press A 8", "press B 8", "keyup Shift 0"]);
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
