// HTML "constructing the entry list" (§4.10.21.4) over the arena: the name–value pairs a form's submittable elements
// contribute, in tree order — each field's VALUE as its `value` getter has it, sanitized for its type (Chrome: an email
// field's `value=" a@b "` submits `a@b`, a range's out-of-range value its clamped one). What only the bindings hold —
// a file input's selected files, a form-associated custom element's submission value — the list names, for them to
// fill in.

use crate::dom::{nid_arg, NodeData, NodeId, RealmArena, STATE_DIRTY_BY_USER, STATE_FORM_ASSOCIATED, STATE_SELECTED};
use crate::input_value::{sanitize_units, typed_number, Attrs};

pub(crate) enum Entry {
    // A name and a string value.
    Text(Vec<u16>, Vec<u16>),
    // A file input's selected files, under its name.
    Files(Vec<u16>, NodeId),
    // A form-associated custom element's submission value.
    Custom(NodeId),
}

// The input types whose field submits its directionality under its `dirname` (HTML: the types `dirname` applies to).
const DIRNAME_INPUT_TYPES: [&str; 8] = ["hidden", "text", "search", "tel", "url", "email", "password", "submit"];

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

impl RealmArena {
    // The entry list of `form`, submitted by `submitter`, in the character encoding `encoding` (what a `_charset_`
    // hidden field takes); `colour` the style engine's reading of a colour field's value.
    pub(crate) fn entry_list(&self, form: NodeId, submitter: Option<NodeId>, encoding: &[u16], colour: &dyn Fn(&str) -> String) -> Vec<Entry> {
        let mut out = Vec::new();
        for field in self.form_submittables(form, submitter) {
            let Some(n) = self.get(field) else { continue };
            if n.state & STATE_FORM_ASSOCIATED != 0 {
                out.push(Entry::Custom(field));
                continue;
            }
            let submits = Some(field) == submitter;
            let name = n.plain_attr_units("name").unwrap_or_default();
            let attr = |local: &str, or: &str| n.plain_attr_units(local).unwrap_or_else(|| units(or));
            // (…a nameless field submits nothing, but an image button submitting: bare `x` and `y`)
            if n.is_html_named("input") && n.input_type() == "image" && submits {
                let coordinate = |axis: &str| if name.is_empty() { units(axis) } else { [&name[..], &units(&format!(".{axis}"))].concat() };
                out.push(Entry::Text(coordinate("x"), units("0")));
                out.push(Entry::Text(coordinate("y"), units("0")));
                continue;
            }
            if name.is_empty() || !n.is_html() {
                continue;
            }
            let (value, dirname) = match &*n.local_name {
                "input" => match n.input_type() {
                    "image" => continue,
                    "submit" | "reset" | "button" if !submits => continue,
                    "checkbox" | "radio" if !self.is_checked(field) => continue,
                    "checkbox" | "radio" => (attr("value", "on"), false),
                    "file" => {
                        out.push(Entry::Files(name, field));
                        continue;
                    }
                    // (…a `_charset_` hidden field: the encoding, whatever its value — Chrome too)
                    "hidden" if String::from_utf16_lossy(&name).eq_ignore_ascii_case("_charset_") => {
                        (encoding.to_vec(), true)
                    }
                    ty => (self.input_value_units(n, ty, colour), DIRNAME_INPUT_TYPES.contains(&ty)),
                },
                "textarea" => {
                    let value = self.raw_value_units(n);
                    let hard = n.plain_attr("wrap").is_some_and(|w| w.eq_ignore_ascii_case("hard"));
                    let cols = n.plain_attr("cols").and_then(crate::validity::parse_non_negative).filter(|&c| c > 0).unwrap_or(20);
                    (if hard { hard_wrap(&value, cols as usize) } else { value }, true)
                }
                // (…each option selected and not disabled — the first only where it takes one)
                "select" => {
                    for option in self.list_of_options(field) {
                        if self.get(option).is_some_and(|o| o.state & STATE_SELECTED != 0) && !self.option_disabled(option) {
                            out.push(Entry::Text(name.clone(), units(&self.option_value(option))));
                            if n.plain_attr("multiple").is_none() {
                                break;
                            }
                        }
                    }
                    continue;
                }
                "button" if submits => (attr("value", ""), false),
                _ => continue,
            };
            out.push(Entry::Text(name, value));
            if dirname {
                self.push_dirname(&mut out, field, n);
            }
        }
        out
    }

    // An input's value as its `value` getter has it, past the modes that are an attribute's: its live value — its
    // `value` attribute until dirtied — sanitized for its type, but a number field the user typed into, whose value
    // reads as it was typed where it converts.
    fn input_value_units(&self, n: &NodeData, ty: &str, colour: &dyn Fn(&str) -> String) -> Vec<u16> {
        if matches!(ty, "hidden" | "submit" | "image" | "reset" | "button") {
            return n.plain_attr_units("value").unwrap_or_default();
        }
        let raw = self.raw_value_units(n);
        if ty == "number" && n.state & STATE_DIRTY_BY_USER != 0 {
            return units(&typed_number(&String::from_utf16_lossy(&raw)));
        }
        sanitize_units(ty, &raw, &Attrs::of(n), colour)
    }

    // A field's `dirname` entry, where it has a non-empty one: its directionality under that name.
    fn push_dirname(&self, out: &mut Vec<Entry>, field: NodeId, n: &NodeData) {
        if let Some(dirname) = n.plain_attr_units("dirname").filter(|d| !d.is_empty()) {
            out.push(Entry::Text(dirname, units(if self.is_rtl(field) { "rtl" } else { "ltr" })));
        }
    }
}

// HTML's "textarea wrapping transformation" for `wrap=hard`: each line broken where it passes `cols` — at the last space
// within it, that space dropped, else at `cols` itself. The algorithm is the UA's to choose (any that inserts the breaks
// conforms; Chrome breaks where the rendered lines do).
fn hard_wrap(text: &[u16], cols: usize) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    for (i, line) in text.split(|&u| u == 0x0A).enumerate() {
        if i > 0 {
            out.push(0x0A);
        }
        let mut rest = line;
        while rest.len() > cols {
            match rest[..=cols].iter().rposition(|&u| u == 0x20).filter(|&b| b > 0) {
                Some(space) => {
                    out.extend_from_slice(&rest[..space]);
                    rest = &rest[space + 1..];
                }
                None => {
                    out.extend_from_slice(&rest[..cols]);
                    rest = &rest[cols..];
                }
            }
            out.push(0x0A);
        }
        out.extend_from_slice(rest);
    }
    out
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "formEntries", form_entries, context_id);
}

// __dom.formEntries(formNid, submitterNid, encoding) -> [entries, nodes]: `entries` flat, three to an entry — `0, name,
// value` a string entry, `1, name, k` the files of `nodes[k]`, `2, null, k` the custom element `nodes[k]`'s — and
// `nodes` those elements, as `nodes_value` answers from the form's tree.
fn form_entries(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(form) = nid_arg(scope, &args, 0) else { return };
    let submitter = nid_arg(scope, &args, 1);
    let encoding = crate::dom::utf16_arg(scope, args.get(2));
    let cid = crate::dom::realm_id(scope, &args);
    let (entries, tree) = {
        let d = crate::dom::dom(scope);
        let arena: &RealmArena = d.arena.enter(cid);
        let engine = d.styles.get(&cid);
        let colour = |v: &str| crate::input_value::colour_value(engine, arena, v);
        (arena.entry_list(form, submitter, &encoding, &colour), arena.form_tree(form))
    };
    let (mut flat, mut nodes): (Vec<v8::Local<'_, v8::Value>>, Vec<NodeId>) = (Vec::new(), Vec::new());
    for entry in entries {
        let (kind, name, value) = match entry {
            Entry::Text(name, value) => (0, Some(name), crate::dom::utf16_value(scope, &value)),
            Entry::Files(name, field) => {
                nodes.push(field);
                (1, Some(name), v8::Integer::new(scope, nodes.len() as i32 - 1).into())
            }
            Entry::Custom(field) => {
                nodes.push(field);
                (2, None, v8::Integer::new(scope, nodes.len() as i32 - 1).into())
            }
        };
        flat.push(v8::Integer::new(scope, kind).into());
        let name = match name {
            Some(name) => crate::dom::utf16_value(scope, &name),
            None => v8::null(scope).into(),
        };
        flat.push(name);
        flat.push(value);
    }
    let entries = v8::Array::new_with_elements(scope, &flat).into();
    let nodes = crate::dom::nodes_value(scope, cid, tree, &nodes);
    rv.set(v8::Array::new_with_elements(scope, &[entries, nodes]).into());
}
