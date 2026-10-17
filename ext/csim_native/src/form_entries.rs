// HTML "constructing the entry list" (§4.10.21.4) over the arena: the name–value pairs a form's submittable elements
// contribute, in tree order — each field's VALUE as its `value` getter has it, sanitized for its type (Chrome: an email
// field's `value=" a@b "` submits `a@b`, a range's out-of-range value its clamped one). What only the bindings hold —
// a file input's selected files, a form-associated custom element's submission value — the list names, for them to
// fill in.

use crate::dom::{nid_arg, NodeData, NodeId, RealmArena, Text, STATE_FORM_ASSOCIATED, STATE_SELECTED};
use crate::reflect_keywords::{FORM_ENCTYPE, FORM_METHOD, TABLES};

pub(crate) enum Entry {
    // A name and a string value.
    Text(Vec<u16>, Vec<u16>),
    // A file input's selected files, under its name.
    Files(Vec<u16>, NodeId),
    // A form-associated custom element's submission value.
    Custom(NodeId),
}

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

impl RealmArena {
    // The entry list of `form`, submitted by `submitter` — an image button at its selected coordinate `at` — in the
    // character encoding `encoding` (what a `_charset_` hidden field takes); `colour` the style engine's reading of a
    // colour field's value.
    pub(crate) fn entry_list(
        &self,
        form: NodeId,
        submitter: Option<NodeId>,
        at: (i32, i32),
        encoding: &[u16],
        colour: &dyn Fn(&str) -> String,
    ) -> Vec<Entry> {
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
            // (…a nameless field submits nothing, but an image button submitting: its selected coordinate, under bare `x`
            // and `y` where it has no name)
            if n.is_html_named("input") && n.input_type() == "image" && submits {
                let coordinate = |axis: &str| if name.is_empty() { units(axis) } else { [&name[..], &units(&format!(".{axis}"))].concat() };
                out.push(Entry::Text(coordinate("x"), units(&at.0.to_string())));
                out.push(Entry::Text(coordinate("y"), units(&at.1.to_string())));
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
                    "file" => {
                        out.push(Entry::Files(name, field));
                        continue;
                    }
                    // (…a `_charset_` hidden field: the encoding, whatever its value — Chrome too)
                    "hidden" if String::from_utf16_lossy(&name).eq_ignore_ascii_case("_charset_") => {
                        (encoding.to_vec(), true)
                    }
                    ty => (self.input_value(n, ty, colour).map_or_else(Vec::new, Text::into_units), crate::input_types::facts(ty) & crate::input_types::DIRNAME != 0),
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
                            out.push(Entry::Text(name.clone(), self.option_value(option)));
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
    crate::dom::register(scope, ns, "formSubmission", form_submission, context_id);
}

// An enumerated attribute's state: its value ASCII-lowercased where it is one of `keywords`, else `invalid`.
// __dom.formSubmission(formNid, submitterNid, documentEncoding) -> `[action, method, enctype, target, rel, encoding]`:
// how a form submits (HTML §4.10.21.3) — the submitter's `formaction`, `formmethod`, `formenctype` and `formtarget`
// where it has them, else the form's own; the action as written (null for none: the bindings resolve it against the
// document's base URL); the method and the enctype their states (an invalid or missing one GET, urlencoded); the target
// the form's `target`, else the first `<base target>` of its tree's; its submission character encoding — the first of
// its `accept-charset` labels that names an encoding, else the document's, UTF-8 for a UTF-16 one or `replacement`.
fn form_submission(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(form) = nid_arg(scope, &args, 0) else { return };
    let submitter = nid_arg(scope, &args, 1);
    let document_encoding = args.get(2).to_rust_string_lossy(scope);
    let arena = &crate::dom::dom(scope).arena;
    let Some(f) = arena.get(form) else { return };
    let s = submitter.and_then(|id| arena.get(id));
    let own = |submitter_attr: &str, form_attr: &str| s.and_then(|s| s.plain_attr_units(submitter_attr)).or_else(|| f.plain_attr_units(form_attr));
    let text = |units: Vec<u16>| String::from_utf16_lossy(&units);
    let action = own("formaction", "action");
    let state = |table: usize, value: Option<Vec<u16>>| TABLES[table].state(value.map(text).as_deref()).unwrap_or_default();
    let method = state(FORM_METHOD, own("formmethod", "method"));
    let enctype = state(FORM_ENCTYPE, own("formenctype", "enctype"));
    let target = s.and_then(|s| s.plain_attr_units("formtarget")).or_else(|| f.plain_attr_units("target")).or_else(|| {
        let root = arena.root_of(form);
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            let n = arena.get(id)?;
            if n.is_html_named("base") {
                if let Some(t) = n.plain_attr_units("target") {
                    return Some(t);
                }
            }
            stack.extend(n.children.iter().rev());
        }
        None
    });
    let rel = f.plain_attr_units("rel").unwrap_or_default();
    let ascii_ws = |c: char| matches!(c, '\t' | '\n' | '\x0C' | '\r' | ' ' | ',');
    let labelled = f.plain_attr("accept-charset").and_then(|ac| ac.split(ascii_ws).filter(|l| !l.is_empty()).find_map(|l| encoding_rs::Encoding::for_label(l.as_bytes())));
    let encoding = labelled.or_else(|| encoding_rs::Encoding::for_label(document_encoding.as_bytes())).map_or("UTF-8", |e| e.name());
    let encoding = if matches!(encoding, "replacement" | "UTF-16BE" | "UTF-16LE") { "UTF-8" } else { encoding };
    let action = match action {
        Some(a) => crate::dom::utf16_value(scope, &a),
        None => v8::null(scope).into(),
    };
    let values: [v8::Local<'_, v8::Value>; 6] = [
        action,
        v8::String::new(scope, method).map_or_else(|| v8::null(scope).into(), Into::into),
        v8::String::new(scope, enctype).map_or_else(|| v8::null(scope).into(), Into::into),
        crate::dom::utf16_value(scope, &target.unwrap_or_default()),
        crate::dom::utf16_value(scope, &rel),
        v8::String::new(scope, encoding).map_or_else(|| v8::null(scope).into(), Into::into),
    ];
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}

// __dom.formEntries(formNid, submitterNid, encoding, x, y) -> [entries, nodes] — `x`, `y` an image submitter's selected
// coordinate: `entries` flat, three to an entry — `0, name,
// value` a string entry, `1, name, k` the files of `nodes[k]`, `2, null, k` the custom element `nodes[k]`'s — and
// `nodes` those elements, as `nodes_value` answers them.
fn form_entries(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(form) = nid_arg(scope, &args, 0) else { return };
    let submitter = nid_arg(scope, &args, 1);
    let encoding = crate::dom::utf16_arg(scope, args.get(2));
    let at = (args.get(3).int32_value(scope).unwrap_or(0), args.get(4).int32_value(scope).unwrap_or(0));
    let cid = crate::dom::realm_id(scope, &args);
    let entries = {
        let d = crate::dom::dom(scope);
        let arena: &RealmArena = d.arena.enter(cid);
        let engine = d.styles.get(&cid);
        let colour = |v: &str| crate::input_value::colour_value(engine, arena, v);
        arena.entry_list(form, submitter, at, &encoding, &colour)
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
    let nodes = crate::dom::nodes_value(scope, cid, &nodes);
    rv.set(v8::Array::new_with_elements(scope, &[entries, nodes]).into());
}
