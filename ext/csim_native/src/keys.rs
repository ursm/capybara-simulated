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

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
// A name lowercased as JavaScript's `toLowerCase` does it — for the names compared here, which are ASCII, ASCII's.
fn lower(spec: &[u16]) -> String {
    String::from_utf16_lossy(spec).to_lowercase()
}

// What `spec` presses: a key by its name, a line feed Enter and a tab Tab — a text's own — else the character it is
// (one code unit typed with its key's code, `Key` and its uppercase letter for any other; more, as an astral
// character is, with none).
pub(crate) fn resolve(spec: &[u16]) -> Key {
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
    let (code, key_code) = match spec {
        [unit] => match char::from_u32(u32::from(*unit)) {
            Some(c) => match PUNCTUATION.iter().find(|p| p.0 == c) {
                Some(&(_, code, key_code)) => (units(code), key_code),
                None => {
                    let upper: Vec<u16> = c.to_uppercase().collect::<String>().encode_utf16().collect();
                    let mut code = units("Key");
                    code.extend(&upper);
                    (code, u32::from(upper[0]))
                }
            },
            // (…a lone surrogate, which no case maps)
            None => {
                let mut code = units("Key");
                code.push(*unit);
                (code, u32::from(*unit))
            }
        },
        _ => (Vec::new(), 0),
    };
    Key { named: false, key: spec.to_vec(), code, key_code, char: Some(spec.to_vec()), input_type: Some("insertText") }
}

// The modifier `name` names: its `key`, `code` and `keyCode` — None for a name that is none.
pub(crate) fn modifier(name: &[u16]) -> Option<(&'static str, &'static str, u32)> {
    let name = lower(name);
    MODIFIERS.iter().find(|m| m.0 == name).map(|&(_, key, code, key_code)| (key, code, key_code))
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "resolveKey", resolve_op, context_id);
    crate::dom::register(scope, ns, "modifierKey", modifier_op, context_id);
}
// __dom.resolveKey(spec) -> [key, code, keyCode, char (null for none), inputType (null for none), named] (`resolve`).
fn resolve_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let spec = crate::dom::utf16_arg(scope, args.get(0));
    let k = resolve(&spec);
    let ch: v8::Local<v8::Value> = match k.char.as_deref() {
        Some(c) => crate::dom::utf16_value(scope, c),
        None => v8::null(scope).into(),
    };
    let items: [v8::Local<v8::Value>; 6] = [
        crate::dom::utf16_value(scope, &k.key),
        crate::dom::utf16_value(scope, &k.code),
        v8::Integer::new_from_unsigned(scope, k.key_code).into(),
        ch,
        k.input_type.and_then(|t| v8::String::new(scope, t)).map_or_else(|| v8::null(scope).into(), Into::into),
        v8::Boolean::new(scope, k.named).into(),
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
        let k = resolve(&units(s));
        (String::from_utf16_lossy(&k.key), String::from_utf16_lossy(&k.code), k.key_code, k.char.map(|c| String::from_utf16_lossy(&c)), k.input_type)
    }

    #[test]
    fn keys_resolve_as_a_us_keyboard_types_them() {
        assert_eq!(key("ENTER"), ("Enter".into(), "Enter".into(), 13, Some("\n".into()), Some("insertLineBreak")));
        assert_eq!(key("\t").0, "Tab");
        assert_eq!(key(".").1, "Period");
        assert_eq!(key(".").2, 190);
        assert_eq!(key("a"), ("a".into(), "KeyA".into(), 65, Some("a".into()), Some("insertText")));
        assert_eq!(key("ß").1, "KeySS");
        assert_eq!(key("😀").2, 0);
        assert_eq!(modifier(&units("Cmd")), Some(("Meta", "MetaLeft", 91)));
        assert_eq!(modifier(&units("x")), None);
    }
}
