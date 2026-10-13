// HTML's `<input>` type states (§4.10.5.1) and what applies to an input in each — the table the engine and the
// bindings (`__dom.inputFacts`) both read, so no two answers to "does `readonly` apply to a date field?" drift apart.

// Every type state's keyword: a `type` naming none of them, or none, is the Text state.
pub(crate) const TYPES: [&str; 22] = [
    "hidden", "text", "search", "tel", "url", "email", "password", "date", "month", "week", "time", "datetime-local",
    "number", "range", "color", "checkbox", "radio", "file", "submit", "image", "reset", "button",
];

// The type state a `type` attribute's value (or none) gives: its keyword, ASCII case-insensitively.
pub(crate) fn state(raw: Option<&str>) -> &'static str {
    let raw = raw.unwrap_or("");
    TYPES.iter().copied().find(|t| t.eq_ignore_ascii_case(raw)).unwrap_or("text")
}

// What applies to an input of a type state.
// `readonly` (and so the mutability `required` needs, `:read-write`).
pub(crate) const READONLY: u32 = 1;
// `pattern`, `minlength` and `maxlength`: a free-form string value.
pub(crate) const FREE_TEXT: u32 = 1 << 1;
// `valueAsNumber`, `step`, `stepUp()` — a user's ArrowUp / ArrowDown steps it.
pub(crate) const NUMERIC: u32 = 1 << 2;
// `valueAsDate`.
pub(crate) const DATE: u32 = 1 << 3;
// `list` (a datalist's suggestions).
pub(crate) const LIST: u32 = 1 << 4;
// Text a user types (execCommand's insertText goes into it).
pub(crate) const TYPED: u32 = 1 << 5;
// It holds text: the focus ring always shows (Chrome), its value scrolls.
pub(crate) const TEXTUAL: u32 = 1 << 6;
// A button state.
pub(crate) const BUTTON: u32 = 1 << 7;
// The selection APIs (`selectionStart`, `setSelectionRange()`, `setRangeText()`).
pub(crate) const SELECTION: u32 = 1 << 8;
// `select()` — an email field's too (Chrome: its offsets read null, its selection shows in `getSelection()`).
pub(crate) const SELECT: u32 = 1 << 9;
// `dirname` (a directionality entry submitted).
pub(crate) const DIRNAME: u32 = 1 << 10;
// A value that is no directional text: `dir=auto` on it is ltr.
pub(crate) const NO_DIRECTIONAL_VALUE: u32 = 1 << 11;
// Autocorrection never applies.
pub(crate) const NO_AUTOCORRECT: u32 = 1 << 12;
// Its value mode, in the bits above `VALUE_MODE_SHIFT`.
pub(crate) const VALUE_MODE_SHIFT: u32 = 16;
pub(crate) const MODE_VALUE: u32 = 0;
pub(crate) const MODE_DEFAULT: u32 = 1;
pub(crate) const MODE_DEFAULT_ON: u32 = 2;
pub(crate) const MODE_FILENAME: u32 = 3;

// What applies to an input of type state `ty`.
pub(crate) fn facts(ty: &str) -> u32 {
    let text_like = READONLY | FREE_TEXT | LIST | TYPED | TEXTUAL | SELECT | DIRNAME;
    let temporal = READONLY | NUMERIC | LIST | TEXTUAL | NO_DIRECTIONAL_VALUE;
    let mode = |m: u32| m << VALUE_MODE_SHIFT;
    match ty {
        "text" | "search" | "tel" => text_like | SELECTION,
        "url" => text_like | SELECTION | NO_AUTOCORRECT,
        "email" => text_like | NO_AUTOCORRECT,
        "password" => (text_like & !LIST) | SELECTION | NO_AUTOCORRECT,
        "date" | "month" | "week" | "time" => temporal | DATE,
        "datetime-local" => temporal,
        "number" => READONLY | NUMERIC | LIST | TYPED | TEXTUAL | NO_DIRECTIONAL_VALUE,
        "range" => NUMERIC | LIST | NO_DIRECTIONAL_VALUE,
        "color" => LIST | NO_DIRECTIONAL_VALUE,
        "hidden" => DIRNAME | mode(MODE_DEFAULT),
        "submit" => BUTTON | DIRNAME | mode(MODE_DEFAULT),
        "image" => BUTTON | NO_DIRECTIONAL_VALUE | mode(MODE_DEFAULT),
        "reset" | "button" => BUTTON | mode(MODE_DEFAULT),
        "checkbox" | "radio" => NO_DIRECTIONAL_VALUE | mode(MODE_DEFAULT_ON),
        "file" => NO_DIRECTIONAL_VALUE | mode(MODE_FILENAME),
        _ => 0,
    }
}

// Its value mode (`MODE_VALUE` …).
pub(crate) fn value_mode(ty: &str) -> u32 {
    facts(ty) >> VALUE_MODE_SHIFT
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "inputType", input_type_op, context_id);
    crate::dom::register(scope, ns, "inputFacts", input_facts_op, context_id);
}

// The type state of `element` (an `<input>`, or anything carrying a `type`): `state`.
fn type_of(scope: &mut v8::PinScope<'_, '_>, element: v8::Local<'_, v8::Value>) -> &'static str {
    let id = crate::node_handle::nid_of(scope, element);
    id.and_then(|id| crate::dom::dom(scope).arena.get(id).map(|n| n.input_type())).unwrap_or("text")
}
// __dom.inputType(input) -> its type state's keyword — the `type` IDL attribute too (limited to the known values).
fn input_type_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let ty = type_of(scope, args.get(0));
    rv.set(v8::String::new(scope, ty).map_or_else(|| v8::undefined(scope).into(), Into::into));
}
// __dom.inputFacts(input) -> what applies to it, by its type state (`facts`: `READONLY` …, its value mode above
// `VALUE_MODE_SHIFT`).
fn input_facts_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let ty = type_of(scope, args.get(0));
    rv.set_uint32(facts(ty));
}

#[cfg(test)]
mod tests {
    use super::*;

    // The table answers as each list it replaced did.
    #[test]
    fn the_table_answers_as_the_lists_it_replaced() {
        let with = |fact: u32| -> Vec<&str> { TYPES.iter().copied().filter(|t| facts(t) & fact != 0).collect() };
        let mut readonly = with(READONLY);
        readonly.sort_unstable();
        let mut expected = vec!["text", "search", "tel", "url", "email", "password", "number", "date", "month", "week", "time", "datetime-local"];
        expected.sort_unstable();
        assert_eq!(readonly, expected);
        assert_eq!(with(FREE_TEXT).len(), 6);
        assert_eq!(with(BUTTON), vec!["submit", "image", "reset", "button"]);
        assert_eq!(with(SELECTION), vec!["text", "search", "tel", "url", "password"]);
        assert_eq!(with(SELECT), vec!["text", "search", "tel", "url", "email", "password"]);
        assert_eq!(with(DIRNAME), vec!["hidden", "text", "search", "tel", "url", "email", "password", "submit"]);
        let non_text: Vec<&str> = TYPES.iter().copied().filter(|t| facts(t) & TEXTUAL == 0).collect();
        assert_eq!(non_text, vec!["hidden", "range", "color", "checkbox", "radio", "file", "submit", "image", "reset", "button"]);
        assert_eq!(value_mode("checkbox"), MODE_DEFAULT_ON);
        assert_eq!(value_mode("file"), MODE_FILENAME);
        assert_eq!(value_mode("email"), MODE_VALUE);
    }
}
