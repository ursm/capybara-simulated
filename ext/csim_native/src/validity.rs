// HTML constraint validation over the arena: whether a control is a candidate (`willValidate`), which of its
// constraints it suffers from (`validity`), and the pseudo-classes read off those — `:valid`, `:invalid` (a form or a
// fieldset by its controls), `:user-valid`, `:user-invalid`, `:in-range`, `:out-of-range`. dom-nodes.js `validity`
// is what a page reads them through (`validityFlags`, `willValidate`).
//
// `pattern` is an ECMAScript regular expression, compiled with the `v` flag: regress (a JS-syntax engine in Rust)
// evaluates it over the value's UTF-16 code units, as a page's RegExp does, from a cache of compiled patterns.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::input_value::{number_of, parse_float, step_scale};
use web_atoms::local_name;
use crate::dom::{
    NodeData, NodeId, NodeKind, RealmArena, STATE_CUSTOM_ERROR, STATE_DIRTY_BY_USER, STATE_FORM_ASSOCIATED,
    STATE_HAS_FILES, STATE_SELECTED, STATE_SELECTED_DIRTY, STATE_SELECTED_INIT, STATE_USER_INTERACTED,
};

// The ValidityState flags.
pub(crate) const VALUE_MISSING: u16 = 1;
pub(crate) const TYPE_MISMATCH: u16 = 1 << 1;
pub(crate) const PATTERN_MISMATCH: u16 = 1 << 2;
pub(crate) const TOO_LONG: u16 = 1 << 3;
pub(crate) const TOO_SHORT: u16 = 1 << 4;
pub(crate) const RANGE_UNDERFLOW: u16 = 1 << 5;
pub(crate) const RANGE_OVERFLOW: u16 = 1 << 6;
pub(crate) const STEP_MISMATCH: u16 = 1 << 7;
pub(crate) const BAD_INPUT: u16 = 1 << 8;
pub(crate) const CUSTOM_ERROR: u16 = 1 << 9;

// The `<input>` types `pattern` applies to.
const PATTERN_TYPES: [&str; 6] = ["text", "search", "url", "tel", "email", "password"];
// The `<input>` types `readonly` applies to (the mutability `required` needs).
const READONLY_TYPES: [&str; 12] = [
    "text", "search", "tel", "url", "email", "password", "number", "date", "month", "week", "time", "datetime-local",
];
// The `<input>` types `minlength` / `maxlength` apply to.
const LENGTH_TYPES: [&str; 6] = ["text", "search", "url", "tel", "email", "password"];

fn is_ascii_ws(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\x0C' | '\r' | ' ')
}
fn trim_ascii_ws(s: &str) -> &str {
    s.trim_matches(is_ascii_ws)
}

// HTML "rules for parsing non-negative integers" — the rules for parsing integers, a negative value none (`-0` is 0) —
// or None.
pub(crate) fn parse_non_negative(s: &str) -> Option<u64> {
    parse_html_integer(s).and_then(|v| u64::try_from(v).ok())
}

// An exact decimal (coefficient, digits after the point), for a step check a double cannot resolve.
fn exact_decimal(s: &str) -> Option<(i128, i32)> {
    let s = trim_ascii_ws(s);
    let (mantissa, exp) = match s.find(['e', 'E']) {
        Some(i) => (&s[..i], s[i + 1..].parse::<i32>().ok()?),
        None => (s, 0),
    };
    let (neg, mantissa) = match mantissa.strip_prefix('-') {
        Some(m) => (true, m),
        None => (false, mantissa.strip_prefix('+').unwrap_or(mantissa)),
    };
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = format!("{int}{frac}");
    if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) || digits.len() > 36 {
        return None;
    }
    let mut coeff: i128 = digits.parse().ok()?;
    if neg {
        coeff = -coeff;
    }
    let mut scale = frac.len() as i32 - exp;
    if scale < 0 {
        coeff = coeff.checked_mul(10i128.checked_pow((-scale) as u32)?)?;
        scale = 0;
    }
    Some((coeff, scale))
}
fn decimal_step_mismatch(value: &str, step: &str, base: &str) -> Option<bool> {
    let (v, s, b) = (exact_decimal(value)?, exact_decimal(step)?, exact_decimal(base)?);
    if s.0 == 0 {
        return None;
    }
    let scale = v.1.max(s.1).max(b.1);
    let lift = |d: (i128, i32)| d.0.checked_mul(10i128.checked_pow((scale - d.1) as u32)?);
    Some((lift(v)? - lift(b)?) % lift(s)? != 0)
}

// HTML's "valid e-mail address" (dom-nodes.js's `emailRe`): a local part of the permitted characters, `@`, and a
// domain of labels of letters, digits and inner hyphens (63 at most) — one label is enough. The JS side validates the
// value the `value` getter returns, whose domain is IDNA-converted to ASCII (`user@お.com` → `user@xn--t8j.com`);
// the arena has no UTS 46 tables yet, so a label with non-ASCII characters in it stands for its conversion — taken as
// one that converts (the ASCII among it still held to the rule), its length unchecked.
fn valid_email(s: &str) -> bool {
    let Some((local, domain)) = s.split_once('@') else { return false };
    let local_ok = !local.is_empty()
        && local.bytes().all(|c| c.is_ascii_alphanumeric() || b".!#$%&'*+/=?^_`{|}~-".contains(&c));
    let label_ok = |l: &str| {
        let unicode = !l.is_ascii();
        (unicode && !l.is_empty() || (1..=63).contains(&l.len()))
            && l.chars().all(|c| !c.is_ascii() || c.is_ascii_alphanumeric() || c == '-')
            && !l.starts_with('-')
            && !l.ends_with('-')
    };
    local_ok && domain.split('.').all(label_ok)
}


impl RealmArena {
    // A control's value as its `value` getter reads it before sanitization: the live value once dirty, else the
    // `value` attribute — a `<textarea>`'s child text, newlines normalized.
    pub(crate) fn raw_value(&self, n: &NodeData) -> String {
        String::from_utf16_lossy(&self.raw_value_units(n))
    }
    // …exactly, as UTF-16.
    pub(crate) fn raw_value_units(&self, n: &NodeData) -> Vec<u16> {
        if let Some(v) = &n.value {
            return v.to_vec();
        }
        if n.local_name == local_name!("textarea") {
            let mut out = Vec::new();
            let text = n.children.iter().filter_map(|&c| self.get(c)).filter(|t| t.kind == NodeKind::Text).flat_map(|t| t.data.iter().copied());
            let mut text = text.peekable();
            while let Some(u) = text.next() {
                if u == 0x0D {
                    text.next_if_eq(&0x0A);
                    out.push(0x0A);
                } else {
                    out.push(u);
                }
            }
            return out;
        }
        n.plain_attr_units("value").unwrap_or_default()
    }
    // An `<input>`'s value, sanitized for its type as the `value` getter returns it (`input_value::sanitize`) — for the
    // types a constraint reads the value of (a colour is none of them).
    fn sanitized_value(&self, n: &NodeData, ty: &str) -> String {
        crate::input_value::sanitize(ty, &self.raw_value(n), &crate::input_value::Attrs::of(n), &|v| v.to_string())
    }

    // `willValidate`: a submittable control of a validating kind — an `<input>` but a hidden / reset / button one, a
    // Submit-state `<button>`, a `<select>`, a `<textarea>`, a form-associated custom element — that is not actually
    // disabled, not `readonly` (an input, a textarea, a form-associated custom element), and not in a `<datalist>`.
    pub(crate) fn will_validate(&self, id: NodeId) -> bool {
        let Some(n) = self.get(id).filter(|n| n.is_html()) else { return false };
        let face = n.state & STATE_FORM_ASSOCIATED != 0;
        let candidate = face
            || match &*n.local_name {
                "input" => !matches!(n.input_type(), "hidden" | "reset" | "button"),
                "button" => n.is_submit_button(),
                "select" | "textarea" => true,
                _ => false,
            };
        if !candidate || self.is_actually_disabled(id) {
            return false;
        }
        if (face || matches!(&*n.local_name, "input" | "textarea")) && n.plain_attr("readonly").is_some() {
            return false;
        }
        let mut cur = self.parent_of(id);
        while let Some(c) = cur {
            if self.get(c).is_some_and(|p| p.is_html_named("datalist")) {
                return false;
            }
            cur = self.parent_of(c);
        }
        true
    }

    // The constraints `id` suffers from (dom-nodes.js `validity`), as the flags above.
    pub(crate) fn validity(&self, id: NodeId) -> u16 {
        let Some(n) = self.get(id).filter(|n| n.is_html()) else { return 0 };
        let mut v = if n.state & STATE_CUSTOM_ERROR != 0 { CUSTOM_ERROR } else { 0 };
        let tag = &*n.local_name;
        if !matches!(tag, "input" | "textarea" | "select") {
            return v;
        }
        let ty = if tag == "input" { n.input_type() } else { "" };
        let dirty_by_user = n.state & STATE_DIRTY_BY_USER != 0;
        if tag == "select" {
            if n.plain_attr("required").is_some() && self.select_suffers_value_missing(id) {
                v |= VALUE_MISSING;
            }
            return v;
        }
        let val = if tag == "textarea" { self.raw_value(n) } else { self.sanitized_value(n, ty) };
        let checkable = matches!(ty, "checkbox" | "radio");
        let empty = match ty {
            "checkbox" | "radio" => !self.is_checked(id),
            "file" => n.state & STATE_HAS_FILES == 0,
            _ => val.is_empty(),
        };
        if tag == "input" && ty == "number" && dirty_by_user {
            let raw = self.raw_value(n);
            if !raw.is_empty() && crate::validity::parse_number_field(&raw).is_none() {
                v |= BAD_INPUT;
            }
        }
        // valueMissing: a radio by its GROUP — some member required, none checked; any other where `required`
        // applies, on a mutable control (disabled / readonly spare only the types readonly applies to), when empty.
        if ty == "radio" {
            if n.plain_attr("name").is_some_and(|name| !name.is_empty()) && self.radio_group_misses_required(id) {
                v |= VALUE_MISSING;
            }
        } else {
            let required_applies = tag == "textarea"
                || !matches!(ty, "submit" | "image" | "reset" | "button" | "hidden" | "range" | "color");
            let readonly_applies = tag == "textarea" || READONLY_TYPES.contains(&ty);
            let mutable = !(readonly_applies && (self.is_actually_disabled(id) || n.plain_attr("readonly").is_some()));
            if required_applies && n.plain_attr("required").is_some() && empty && mutable {
                v |= VALUE_MISSING;
            }
        }
        if checkable || tag != "input" && tag != "textarea" || empty {
            return v;
        }
        if tag == "input" && PATTERN_TYPES.contains(&ty) && self.pattern_mismatch(n, ty) {
            v |= PATTERN_MISMATCH;
        }
        if tag == "input" {
            let bad_type = match ty {
                "email" if n.plain_attr("multiple").is_some() => !val.split(',').map(trim_ascii_ws).all(valid_email),
                "email" => !valid_email(&val),
                "url" => {
                    let scheme = val.find("://").map(|i| &val[..i]);
                    !scheme.is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_alphabetic()))
                }
                _ => false,
            };
            if bad_type {
                v |= TYPE_MISMATCH;
            }
        }
        if dirty_by_user && (tag == "textarea" || LENGTH_TYPES.contains(&ty)) {
            let len = val.encode_utf16().count() as u64;
            if n.plain_attr("minlength").and_then(parse_non_negative).is_some_and(|min| len < min) {
                v |= TOO_SHORT;
            }
            if n.plain_attr("maxlength").and_then(parse_non_negative).is_some_and(|max| len > max) {
                v |= TOO_LONG;
            }
        }
        // (A range's value is sanitized into its range and onto its step — it suffers from neither.)
        if tag == "input" && ty != "range" {
            v |= self.range_and_step(n, ty, &val);
        }
        v
    }

    // rangeUnderflow / rangeOverflow / stepMismatch of a numeric or temporal input with value `val`.
    fn range_and_step(&self, n: &NodeData, ty: &str, val: &str) -> u16 {
        let Some((scale, default_step)) = step_scale(ty) else { return 0 };
        let Some(num) = number_of(ty, val) else { return 0 };
        let mut v = 0;
        let min = n.plain_attr("min").and_then(|m| number_of(ty, m));
        let max = n.plain_attr("max").and_then(|m| number_of(ty, m));
        match (min, max) {
            // A reversed range accepts value <= max or >= min: a value between suffers both.
            (Some(lo), Some(hi)) if lo > hi => {
                if num > hi && num < lo {
                    v |= RANGE_UNDERFLOW | RANGE_OVERFLOW;
                }
            }
            _ => {
                if min.is_some_and(|lo| num < lo) {
                    v |= RANGE_UNDERFLOW;
                }
                if max.is_some_and(|hi| num > hi) {
                    v |= RANGE_OVERFLOW;
                }
            }
        }
        let step_attr = n.plain_attr("step");
        if step_attr.is_some_and(|s| s.eq_ignore_ascii_case("any")) {
            return v;
        }
        let explicit = step_attr.filter(|s| parse_float(s).is_some_and(|x| x > 0.0));
        let step = explicit.and_then(parse_float).unwrap_or(default_step);
        let step_value = step * scale;
        // The step base: `min`, else the `value` attribute, else the type's default.
        let base = min.or_else(|| n.plain_attr("value").and_then(|x| number_of(ty, x))).unwrap_or(if ty == "week" {
            number_of("week", "1970-W01").unwrap_or(0.0)
        } else {
            0.0
        });
        if step_value <= 0.0 {
            return v;
        }
        let exact = if matches!(ty, "number" | "range") {
            let step_str = explicit.map(str::to_string).unwrap_or_else(|| format!("{step}"));
            let base_str = n
                .plain_attr("min")
                .filter(|m| parse_float(m).is_some())
                .or_else(|| n.plain_attr("value").filter(|x| parse_float(x).is_some()))
                .unwrap_or("0");
            decimal_step_mismatch(val, &step_str, base_str)
        } else {
            None
        };
        let mismatch = exact.unwrap_or_else(|| {
            let rem = ((num - base) % step_value).abs();
            let tol = if matches!(ty, "number" | "range") { 1e-9 * step_value.abs().max(1.0) } else { 0.0 };
            rem > tol && (rem - step_value).abs() > tol
        });
        if mismatch {
            v |= STEP_MISMATCH;
        }
        v
    }

    // A `<select>`'s valueMissing: nothing selected — or, for a drop-down box,
    // only its placeholder label option (an empty-valued first option, a child of the select).
    fn select_suffers_value_missing(&self, id: NodeId) -> bool {
        let options = self.list_of_options(id);
        let selected: Vec<NodeId> = options.iter().copied().filter(|&o| self.is_selected(o)).collect();
        if self.is_list_box(id) {
            return selected.is_empty();
        }
        let placeholder = options
            .first()
            .copied()
            .filter(|&o| self.parent_of(o) == Some(id) && self.option_value(o).is_empty());
        selected.is_empty() || (selected.len() == 1 && Some(selected[0]) == placeholder)
    }
    // The select's list of options: its option descendants in tree order past transparent wrappers, an optgroup's
    // (not a nested optgroup's), none under an `<hr>`, a `<datalist>` or a nested `<select>` — HTML elements each, an
    // element of another namespace named so only a wrapper.
    pub(crate) fn list_of_options(&self, select: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        self.collect_options(select, false, &mut out);
        out
    }
    fn collect_options(&self, node: NodeId, in_optgroup: bool, out: &mut Vec<NodeId>) {
        let Some(n) = self.get(node) else { return };
        for &c in &n.children {
            let Some(e) = self.get(c).filter(|e| e.kind == NodeKind::Element) else { continue };
            match if e.is_html() { &*e.local_name } else { "" } {
                "option" => out.push(c),
                "hr" | "datalist" | "select" => {}
                "optgroup" if in_optgroup => {}
                "optgroup" => self.collect_options(c, true, out),
                _ => self.collect_options(c, in_optgroup, out),
            }
        }
    }
    // An option's state with its selectedness initialised from its `selected` attribute where nothing has done it yet —
    // the default the attribute gives one that is not dirty — however the option entered the tree.
    pub(crate) fn option_initialised(&self, option: NodeId) -> u32 {
        let Some(n) = self.get(option) else { return 0 };
        let state = n.state;
        if state & STATE_SELECTED_INIT != 0 {
            return state;
        }
        let selected = if state & STATE_SELECTED_DIRTY != 0 {
            state & STATE_SELECTED
        } else if n.plain_attr("selected").is_some() {
            STATE_SELECTED
        } else {
            0
        };
        (state & !STATE_SELECTED) | selected | STATE_SELECTED_INIT
    }
    // A select's selected options, in its list of options' order — the first only, with `first` — with each one's index
    // there.
    pub(crate) fn selected_options(&self, select: NodeId, first: bool) -> Vec<(usize, NodeId)> {
        let selected = self
            .list_of_options(select)
            .into_iter()
            .enumerate()
            .filter(|&(_, o)| self.get(o).is_some_and(|n| n.state & STATE_SELECTED != 0));
        if first { selected.take(1).collect() } else { selected.collect() }
    }
    // `select.selectedIndex = …` / `select.value = …`: every option of the select initialised, the first that `pick`
    // takes (by its index and itself) selected and dirty — as a user's pick, not through its `selected` attribute — and
    // every other deselected; none, where it takes none (the select reads back -1, not re-defaulted, as Chrome). The
    // options whose selectedness changed.
    pub(crate) fn select_option(&mut self, select: NodeId, pick: impl Fn(&Self, usize, NodeId) -> bool) -> Vec<NodeId> {
        let mut changed = Vec::new();
        let mut picked = false;
        for (i, o) in self.list_of_options(select).into_iter().enumerate() {
            let Some(had) = self.get(o).map(|n| n.state) else { continue };
            let initialised = self.option_initialised(o);
            let next = if !picked && pick(self, i, o) {
                picked = true;
                initialised | STATE_SELECTED | STATE_SELECTED_DIRTY
            } else {
                initialised & !STATE_SELECTED
            };
            if next != had {
                self.set_state(o, next);
            }
            if (next ^ had) & STATE_SELECTED != 0 {
                changed.push(o);
            }
        }
        changed
    }
    // Whether an option is disabled for its select's selectedness (HTML §4.10.10): its own `disabled`, or its nearest
    // optgroup's — across a wrapper of a customizable select — not its select's.
    pub(crate) fn option_disabled(&self, option: NodeId) -> bool {
        if self.get(option).is_some_and(|n| n.plain_attr("disabled").is_some()) {
            return true;
        }
        let mut at = self.parent_of(option);
        while let Some(id) = at {
            let Some(n) = self.get(id).filter(|n| n.kind == NodeKind::Element) else { return false };
            match if n.is_html() { &*n.local_name } else { "" } {
                "optgroup" => return n.plain_attr("disabled").is_some(),
                "select" | "option" | "datalist" => return false,
                _ => at = self.parent_of(id),
            }
        }
        false
    }
    // HTML's selectedness setting algorithm (§4.10.7) for a select that is not `multiple`, `just` the option just
    // selected — inserted selected, or set so — which wins over the others: every option initialised first; then the
    // others cleared where `just` is selected; with none selected, a drop-down box's first option not disabled
    // selected; with more than one, all but the last in tree order cleared. The options whose state it changes, with their new
    // state — which the caller writes, as the element objects mirror it.
    pub(crate) fn selectedness(&self, select: NodeId, just: Option<NodeId>) -> Vec<(NodeId, u32)> {
        if self.get(select).is_none_or(|n| !n.is_html_named("select") || n.plain_attr("multiple").is_some()) {
            return Vec::new();
        }
        let options = self.list_of_options(select);
        let before: Vec<u32> = options.iter().map(|&o| self.get(o).map_or(0, |n| n.state)).collect();
        let mut state: Vec<u32> = options.iter().map(|&o| self.option_initialised(o)).collect();
        let selected = |s: u32| s & STATE_SELECTED != 0;
        if let Some(at) = just.and_then(|j| options.iter().position(|&o| o == j)).filter(|&at| selected(state[at])) {
            for (i, s) in state.iter_mut().enumerate() {
                if i != at {
                    *s &= !STATE_SELECTED;
                }
            }
        }
        let chosen: Vec<usize> = (0..state.len()).filter(|&i| selected(state[i])).collect();
        if chosen.is_empty() {
            if !self.is_list_box(select) {
                if let Some(i) = (0..options.len()).find(|&i| !self.option_disabled(options[i])) {
                    state[i] |= STATE_SELECTED;
                }
            }
        } else {
            for &i in &chosen[..chosen.len() - 1] {
                state[i] &= !STATE_SELECTED;
            }
        }
        (0..options.len()).filter(|&i| state[i] != before[i]).map(|i| (options[i], state[i])).collect()
    }
    // An option's value: its `value` attribute, else its text — as the code units the page sees, a lone surrogate
    // included.
    pub(crate) fn option_value(&self, id: NodeId) -> Vec<u16> {
        match self.get(id).and_then(|n| n.plain_attr_units("value")) {
            Some(v) => v,
            None => self.option_text_units(id),
        }
    }
    // …and its `text`: its descendant text but an HTML or SVG script's, ASCII whitespace stripped and collapsed.
    fn option_text_units(&self, id: NodeId) -> Vec<u16> {
        let mut text: Vec<u16> = Vec::new();
        self.collect_text(id, &mut text);
        let words: Vec<&[u16]> = text.split(|&u| is_ascii_ws_unit(u)).filter(|w| !w.is_empty()).collect();
        words.join(&0x20)
    }
    fn option_text(&self, id: NodeId) -> String {
        String::from_utf16_lossy(&self.option_text_units(id))
    }

    // The text a form control SHOWS in its box (walk.rs `control_text`), and whether that is its placeholder: a
    // textarea's value, a text field's as its `value` getter returns it — a password's as as many bullets — or, while
    // either is empty, its `placeholder` (a field's with its line breaks stripped, a textarea's turned into LFs); a
    // button input's label, its `value` or else the one its type names; a drop-down's selected option's label, its
    // `label` unless that is empty, else its text. None for a control that shows no text of its own — a checkbox, a date
    // field, a LIST box, whose options are boxes of their own.
    pub(crate) fn shown_text(&self, id: NodeId) -> Option<(Vec<u16>, bool)> {
        let n = self.get(id).filter(|n| n.is_html())?;
        let (text, field) = match &*n.local_name {
            "textarea" => (self.raw_value(n), true),
            "input" => match n.input_type() {
                ty @ ("text" | "search" | "url" | "tel" | "email" | "password" | "number") => {
                    let value = self.sanitized_value(n, ty);
                    (if ty == "password" { "\u{2022}".repeat(value.chars().count()) } else { value }, true)
                }
                "submit" => (n.plain_attr("value").unwrap_or("Submit").to_string(), false),
                "reset" => (n.plain_attr("value").unwrap_or("Reset").to_string(), false),
                "button" => (n.plain_attr("value").unwrap_or("").to_string(), false),
                _ => return None,
            },
            "select" if !self.is_list_box(id) => {
                let selected = self.list_of_options(id).into_iter().find(|&o| self.is_selected(o));
                let label = selected.and_then(|o| self.get(o)?.plain_attr("label").filter(|l| !l.is_empty()).map(str::to_string));
                (label.or_else(|| selected.map(|o| self.option_text(o))).unwrap_or_default(), false)
            }
            _ => return None,
        };
        if !text.is_empty() || !field {
            return Some((text.encode_utf16().collect(), false));
        }
        let placeholder = n.plain_attr("placeholder")?;
        let placeholder: String = if n.local_name == local_name!("input") {
            placeholder.chars().filter(|&c| c != '\r' && c != '\n').collect()
        } else {
            placeholder.replace("\r\n", "\n").replace('\r', "\n")
        };
        Some((placeholder.encode_utf16().collect(), true))
    }
    fn collect_text(&self, id: NodeId, out: &mut Vec<u16>) {
        let Some(n) = self.get(id) else { return };
        for &c in &n.children {
            match self.get(c) {
                Some(t) if t.kind == NodeKind::Text => out.extend_from_slice(&t.data),
                Some(e) if e.kind == NodeKind::Element && !(e.local_name == local_name!("script") && (e.is_html() || e.ns == web_atoms::ns!(svg))) => {
                    self.collect_text(c, out)
                }
                _ => {}
            }
        }
    }

    // `:valid` / `:invalid`: a candidate by its own constraints; a `<form>` / `<fieldset>` by whether an invalid
    // candidate sits in it.
    pub(crate) fn is_valid_pseudo(&self, id: NodeId) -> Option<bool> {
        let n = self.get(id)?;
        if n.is_html_named("form") || n.is_html_named("fieldset") {
            return Some(!self.contains_invalid(id));
        }
        self.will_validate(id).then(|| self.validity(id) == 0)
    }
    // `:user-valid` / `:user-invalid`: the same, once the user has interacted with the control.
    pub(crate) fn is_user_valid_pseudo(&self, id: NodeId) -> Option<bool> {
        let n = self.get(id)?;
        if n.state & STATE_USER_INTERACTED == 0 || !self.will_validate(id) {
            return None;
        }
        Some(self.validity(id) == 0)
    }
    // `:in-range` / `:out-of-range`: a candidate whose type has a range and which has a `min` or a `max`, by whether it
    // suffers an underflow or an overflow.
    pub(crate) fn is_in_range(&self, id: NodeId) -> Option<bool> {
        let n = self.get(id).filter(|n| n.is_html_named("input"))?;
        let ty = n.input_type();
        step_scale(ty)?;
        if n.plain_attr("min").is_none() && n.plain_attr("max").is_none() || !self.will_validate(id) {
            return None;
        }
        Some(self.validity(id) & (RANGE_UNDERFLOW | RANGE_OVERFLOW) == 0)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "validityFlags", validity_flags, context_id);
    crate::dom::register(scope, ns, "willValidate", will_validate, context_id);
    crate::dom::register(scope, ns, "actuallyDisabled", actually_disabled, context_id);
    crate::dom::register(scope, ns, "listOfOptions", list_of_options, context_id);
    crate::dom::register(scope, ns, "selectedOptions", selected_options, context_id);
    crate::dom::register(scope, ns, "selectedIndex", selected_index, context_id);
    crate::dom::register(scope, ns, "selectIndex", select_index, context_id);
    crate::dom::register(scope, ns, "selectValue", select_value, context_id);
    crate::dom::register(scope, ns, "isListBox", is_list_box, context_id);
    crate::dom::register(scope, ns, "isSubmitButton", is_submit_button, context_id);
    crate::dom::register(scope, ns, "selectedness", selectedness, context_id);
    crate::dom::register(scope, ns, "optionInitialised", option_initialised, context_id);
    crate::dom::register(scope, ns, "optionDisabled", option_disabled, context_id);
    crate::dom::register(scope, ns, "radioGroup", radio_group, context_id);
    crate::dom::register(scope, ns, "formOwner", form_owner, context_id);
    crate::dom::register(scope, ns, "defaultButton", default_button, context_id);
    crate::dom::register(scope, ns, "formListed", form_listed, context_id);
    crate::dom::register(scope, ns, "fieldsetListed", fieldset_listed, context_id);
    crate::dom::register(scope, ns, "formNamed", form_named, context_id);
    crate::dom::register(scope, ns, "isFormNamedCandidate", is_form_named_candidate, context_id);
    crate::dom::register(scope, ns, "formSubmittables", form_submittables, context_id);
    crate::dom::register(scope, ns, "implicitSubmissionForm", implicit_submission_form, context_id);
    crate::dom::register(scope, ns, "editingHost", editing_host, context_id);
    crate::dom::register(scope, ns, "isLabelable", is_labelable, context_id);
    crate::dom::register(scope, ns, "labeledControl", labeled_control, context_id);
    crate::dom::register(scope, ns, "labelsOf", labels_of, context_id);
    crate::dom::register(scope, ns, "labelToActivate", label_to_activate, context_id);
    crate::dom::register(scope, ns, "isEditable", is_editable, context_id);
    crate::dom::register(scope, ns, "isClickActivatable", is_click_activatable, context_id);
    crate::dom::register(scope, ns, "isDetailsSummary", is_details_summary, context_id);
    crate::dom::register(scope, ns, "activationTarget", activation_target, context_id);
}

// __dom.isEditable / isClickActivatable / isDetailsSummary(nid) -> what `element_state` answers of the node: whether it
// is in an editing host, whether a click activates it, whether it is the summary of its details.
fn is_editable(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    node_test(scope, &args, rv, RealmArena::is_editable);
}
fn is_click_activatable(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    node_test(scope, &args, rv, RealmArena::is_click_activatable);
}
fn is_details_summary(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    node_test(scope, &args, rv, RealmArena::is_details_summary);
}
fn node_test(
    scope: &mut v8::PinScope<'_, '_>,
    args: &v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
    test: impl FnOnce(&RealmArena, NodeId) -> bool,
) {
    let cid = crate::dom::realm_id(scope, args);
    let Some(id) = crate::dom::nid_arg(scope, args, 0) else { return rv.set_bool(false) };
    rv.set_bool(test(crate::dom::realm(scope, cid), id));
}

// __dom.activationTarget(nid) -> [a click's activation target] or [] (`element_state::activation_target`), from the
// target's shadow-including root: the path runs out of shadow trees.
fn activation_target(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(target) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let arena = crate::dom::realm(scope, cid);
    let (root, found) = (arena.shadow_including_root(target), arena.activation_target(target));
    rv.set(crate::dom::nodes_value(scope, cid, root, found.as_slice()));
}

// __dom.implicitSubmissionForm(nid) -> [the form Enter in the control submits] or []
// (`element_state::implicit_submission_form`).
fn implicit_submission_form(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    nodes_from_root(scope, &args, rv, |arena, id| arena.implicit_submission_form(id).into_iter().collect());
}

// __dom.isLabelable(nid) -> whether the element is labelable (`element_state::is_labelable`).
fn is_labelable(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    rv.set_bool(crate::dom::realm(scope, cid).is_labelable(id));
}

// __dom.labeledControl / labelsOf / labelToActivate(nid) -> the node(s) `element_state` answers: a label's labeled
// control, a control's labels, the label a click activates.
fn labeled_control(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    nodes_from_root(scope, &args, rv, |arena, id| arena.labeled_control(id).into_iter().collect());
}
fn labels_of(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    nodes_from_root(scope, &args, rv, |arena, id| arena.labels_of(id));
}
fn label_to_activate(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    nodes_from_root(scope, &args, rv, |arena, id| arena.label_to_activate(id).into_iter().collect());
}
// (…what `answer` gives of a node, as `nodes_value` answers it from the node's root)
fn nodes_from_root(
    scope: &mut v8::PinScope<'_, '_>,
    args: &v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
    answer: impl FnOnce(&RealmArena, NodeId) -> Vec<NodeId>,
) {
    let cid = crate::dom::realm_id(scope, args);
    let Some(id) = crate::dom::nid_arg(scope, args, 0) else { return };
    let arena = crate::dom::realm(scope, cid);
    let (root, nodes) = (arena.root_of(id), answer(arena, id));
    rv.set(crate::dom::nodes_value(scope, cid, root, &nodes));
}

// __dom.editingHost(nid) -> [the node's editing host] or [] (`element_state::editing_host`).
fn editing_host(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    nodes_from_root(scope, &args, rv, |arena, id| arena.editing_host(id).into_iter().collect());
}

// __dom.formOwner(nid) -> [the control's form owner] or [] (`element_state::form_owner`).
fn form_owner(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    nodes_from_root(scope, &args, rv, |arena, id| arena.form_owner(id).into_iter().collect());
}

// __dom.defaultButton(nid) -> [the form's default button] or [] (`element_state::default_button_of`), from the form's
// tree (`form_tree`).
fn default_button(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(form) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let arena = crate::dom::realm(scope, cid);
    let (tree, button) = (arena.form_tree(form), arena.default_button_of(form));
    rv.set(crate::dom::nodes_value(scope, cid, tree, button.as_slice()));
}

// __dom.formNamed(formNid, name) -> the form's named elements of `name` (`element_state::form_named`), from its tree.
fn form_named(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(form) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let name = crate::dom::utf16_arg(scope, args.get(1));
    let arena = crate::dom::realm(scope, cid);
    let (tree, named) = (arena.form_tree(form), arena.form_named(form, &name));
    rv.set(crate::dom::nodes_value(scope, cid, tree, &named));
}
// __dom.isFormNamedCandidate(formNid, nid) -> whether the element is one of the form's named elements.
fn is_form_named_candidate(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let (Some(form), Some(el)) = (crate::dom::nid_arg(scope, &args, 0), crate::dom::nid_arg(scope, &args, 1)) else {
        return rv.set_bool(false);
    };
    rv.set_bool(crate::dom::realm(scope, cid).is_form_named_candidate(form, el));
}

// __dom.fieldsetListed(nid) -> a fieldset's listed descendants (`element_state::fieldset_listed`), from the fieldset.
fn fieldset_listed(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(fieldset) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let listed = crate::dom::realm(scope, cid).fieldset_listed(fieldset);
    rv.set(crate::dom::nodes_value(scope, cid, fieldset, &listed));
}

// __dom.formSubmittables(formNid, submitterNid) -> the elements the form's entry list takes values of
// (`element_state::form_submittables`), from the form's tree; `submitterNid` -1 for none.
fn form_submittables(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(form) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let submitter = crate::dom::nid_arg(scope, &args, 1);
    let arena = crate::dom::realm(scope, cid);
    let (tree, elements) = (arena.form_tree(form), arena.form_submittables(form, submitter));
    rv.set(crate::dom::nodes_value(scope, cid, tree, &elements));
}

// __dom.formListed(nid) -> the form's listed elements (`element_state::form_listed`), from the form's tree.
fn form_listed(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(form) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let arena = crate::dom::realm(scope, cid);
    let (tree, listed) = (arena.form_tree(form), arena.form_listed(form));
    rv.set(crate::dom::nodes_value(scope, cid, tree, &listed));
}

// __dom.radioGroup(nid) -> a radio's group, itself included, in tree order (`element_state::radio_group`).
fn radio_group(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    nodes_from_root(scope, &args, rv, RealmArena::radio_group);
}

// __dom.optionDisabled(nid) -> whether an option is disabled for its select's selectedness and entry list
// (`option_disabled`).
fn option_disabled(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(option) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    rv.set_bool(crate::dom::realm(scope, cid).option_disabled(option));
}

// __dom.selectedness(selectNid, justNid) -> [index, state, index, state, …]: the options of the select's list of
// options whose state the selectedness setting algorithm (`selectedness`) changes, by their index there, with their new
// state; `justNid` -1 for none.
fn selectedness(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(select) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let just = crate::dom::nid_arg(scope, &args, 1);
    let arena = crate::dom::realm(scope, cid);
    let options = arena.list_of_options(select);
    let items: Vec<v8::Local<v8::Value>> = arena
        .selectedness(select, just)
        .into_iter()
        .flat_map(|(o, state)| [options.iter().position(|&x| x == o).unwrap_or(0) as f64, f64::from(state)])
        .map(|n| v8::Number::new(scope, n).into())
        .collect();
    let array = v8::Array::new_with_elements(scope, &items);
    rv.set(array.into());
}

// __dom.optionInitialised(nid) -> the option's state with its selectedness initialised (`option_initialised`).
fn option_initialised(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(option) = crate::dom::nid_arg(scope, &args, 0) else { return };
    rv.set_uint32(crate::dom::realm(scope, cid).option_initialised(option));
}

// __dom.isSubmitButton(nid) -> whether the element is a submit button (`element_state::is_submit_button`).
fn is_submit_button(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    rv.set_bool(crate::dom::realm(scope, cid).get(id).is_some_and(|n| n.is_submit_button()));
}

// __dom.isListBox(nid) -> whether a `<select>` shows as a list box, its display size above 1 (`is_list_box`) — else a
// drop-down box.
fn is_list_box(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    rv.set_bool(crate::dom::realm(scope, cid).is_list_box(id));
}

// __dom.listOfOptions(nid) -> a `<select>`'s list of options (`list_of_options`), as `nodes_value` answers.
fn list_of_options(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(select) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let ids = crate::dom::realm(scope, cid).list_of_options(select);
    rv.set(crate::dom::nodes_value(scope, cid, select, &ids));
}

// __dom.selectedOptions(selectNid, first) -> its selected options (`selected_options`), as `nodes_value` answers.
fn selected_options(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(select) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let first = args.get(1).is_true();
    let ids: Vec<NodeId> = crate::dom::realm(scope, cid).selected_options(select, first).into_iter().map(|(_, o)| o).collect();
    rv.set(crate::dom::nodes_value(scope, cid, select, &ids));
}

// __dom.selectedIndex(selectNid) -> the index of its first selected option, -1 with none.
fn selected_index(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(select) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_int32(-1) };
    let first = crate::dom::realm(scope, cid).selected_options(select, true).first().map_or(-1, |&(i, _)| i as i32);
    rv.set_int32(first);
}

// __dom.selectIndex(selectNid, index) / __dom.selectValue(selectNid, value) -> the options whose selectedness changed
// as the index-th option, or the first of that value, is picked (`select_option`), as `nodes_value` answers.
fn select_index(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(select) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let index = args.get(1).integer_value(scope).unwrap_or(-1);
    let changed = crate::dom::realm(scope, cid).select_option(select, |_, i, _| i as i64 == index);
    rv.set(crate::dom::nodes_value(scope, cid, select, &changed));
}
fn select_value(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(select) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let value = crate::dom::utf16_arg(scope, args.get(1));
    let changed = crate::dom::realm(scope, cid).select_option(select, |arena, _, o| arena.option_value(o) == value);
    rv.set(crate::dom::nodes_value(scope, cid, select, &changed));
}

// __dom.validityFlags(nid) -> the constraints the element suffers from (`validity`), its ValidityState's flags in IDL
// order, bit 0 `valueMissing` to bit 9 `customError`.
fn validity_flags(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_int32(0) };
    rv.set_int32(i32::from(crate::dom::realm(scope, cid).validity(id)));
}

// __dom.willValidate(nid) -> whether the element is a candidate for constraint validation (`will_validate`).
fn will_validate(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    rv.set_bool(crate::dom::realm(scope, cid).will_validate(id));
}

// __dom.actuallyDisabled(nid) -> whether the element is actually disabled (`element_state::is_actually_disabled`).
fn actually_disabled(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    rv.set_bool(crate::dom::realm(scope, cid).is_actually_disabled(id));
}

// HTML "rules for parsing integers", or None.
pub(crate) fn parse_html_integer(s: &str) -> Option<i64> {
    let s = s.trim_start_matches(is_ascii_ws);
    let (neg, s) = match s.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let digits = &s[..s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len())];
    if digits.is_empty() {
        return None;
    }
    let v = digits.bytes().fold(0i64, |v, d| v.saturating_mul(10).saturating_add(i64::from(d - b'0')));
    Some(if neg { -v } else { v })
}
// A number field's text as a user may type it (dom-nodes.js `parseNumberFieldValue`): a sign, digits with a point, an
// exponent — or None when it converts to no finite number (badInput).
pub(crate) fn parse_number_field(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let mut i = usize::from(matches!(b.first(), Some(b'-' | b'+')));
    let start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - start;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let f0 = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if int_digits == 0 && i == f0 {
            return None;
        }
    } else if int_digits == 0 {
        return None;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let e0 = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == e0 {
            return None;
        }
    }
    if i != b.len() {
        return None;
    }
    s.parse::<f64>().ok().filter(|x| x.is_finite())
}

// The compiled form of a `pattern` (by its UTF-16 text): anchored — `^(?:pattern)$` — with the `v` flag, or None when
// the pattern does not compile ON ITS OWN (HTML: a pattern that fails to compile is ignored — and the wrapper must not
// balance an unbalanced one like `a)(b`). A page has a handful of patterns; the cache is dropped whole past a bound.
thread_local! {
    static PATTERNS: RefCell<HashMap<Vec<u16>, Option<Rc<regress::Regex>>>> = RefCell::new(HashMap::new());
    // …and whether a value fails a pattern, by (pattern, value): a style read asks again for an unchanged field, and a
    // backtracking pattern (`(a+)+b`) takes time exponential in the value to answer.
    static PATTERN_RESULTS: RefCell<HashMap<(Vec<u16>, Vec<u16>), bool>> = RefCell::new(HashMap::new());
}
const PATTERN_CACHE_LIMIT: usize = 256;
fn compiled_pattern(pattern: &[u16]) -> Option<Rc<regress::Regex>> {
    if let Some(hit) = PATTERNS.with_borrow(|c| c.get(pattern).cloned()) {
        return hit;
    }
    // Code points, a lone surrogate as itself (regress parses from u32s).
    let points = |u: &[u16]| -> Vec<u32> {
        char::decode_utf16(u.iter().copied()).map(|r| r.map_or_else(|e| u32::from(e.unpaired_surrogate()), u32::from)).collect()
    };
    let alone = points(pattern);
    let compiled = (strict_unicode_syntax(&alone) && regress::Regex::from_unicode(alone.iter().copied(), "v").is_ok()).then(|| {
        let mut anchored: Vec<u32> = "^(?:".chars().map(u32::from).collect();
        anchored.extend(alone.iter().copied());
        anchored.extend(")$".chars().map(u32::from));
        regress::Regex::from_unicode(anchored.iter().copied(), "v").ok().map(Rc::new)
    }).flatten();
    PATTERNS.with_borrow_mut(|c| {
        if c.len() >= PATTERN_CACHE_LIMIT {
            c.clear();
        }
        c.insert(pattern.to_vec(), compiled.clone());
    });
    compiled
}
// The Unicode-mode rules (the `u` / `v` flags) regress lets through and V8 enforces — each a SyntaxError there, so a
// pattern breaking one is ignored (HTML). Outside a character class: an identity escape of anything but a syntax
// character (`\-`, `\a`), a legacy octal escape (`\101`, `\0` then a digit), a backreference past the last group,
// `\k` with no named group of that name, `\q` (a class-only escape), and a `{` / `}` / `]` that is no quantifier or
// class. Classes are left to regress, which checks the `v` class syntax.
fn strict_unicode_syntax(p: &[u32]) -> bool {
    let ch = |i: usize| p.get(i).copied().and_then(char::from_u32);
    // First pass: the capturing groups, and the names of the named ones.
    let (mut groups, mut names) = (0usize, Vec::<Vec<u32>>::new());
    let mut i = 0;
    let mut depth = 0usize; // class nesting (the `v` flag nests classes)
    while i < p.len() {
        match ch(i) {
            Some('\\') => i += 1,
            Some('[') => depth += 1,
            Some(']') if depth > 0 => depth -= 1,
            Some('(') if depth == 0 => {
                if ch(i + 1) != Some('?') {
                    groups += 1;
                } else if ch(i + 2) == Some('<') && !matches!(ch(i + 3), Some('=' | '!')) {
                    groups += 1;
                    let end = p[i + 3..].iter().position(|&c| c == u32::from('>')).map(|e| i + 3 + e);
                    if let Some(end) = end {
                        names.push(p[i + 3..end].to_vec());
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    // Second pass: the escapes and braces outside classes.
    let (mut i, mut depth) = (0usize, 0usize);
    let quantifier_end = |from: usize| -> Option<usize> {
        // `{n}`, `{n,}`, `{n,m}` starting at `from` (the `{`): the index of its `}`.
        let mut j = from + 1;
        let digits = |j: &mut usize| {
            let s = *j;
            while ch(*j).is_some_and(|c| c.is_ascii_digit()) {
                *j += 1;
            }
            *j > s
        };
        if !digits(&mut j) {
            return None;
        }
        if ch(j) == Some(',') {
            j += 1;
            digits(&mut j);
        }
        (ch(j) == Some('}')).then_some(j)
    };
    while i < p.len() {
        let c = ch(i);
        if depth > 0 {
            match c {
                Some('\\') => i += 1,
                Some('[') => depth += 1,
                Some(']') => depth -= 1,
                _ => {}
            }
            i += 1;
            continue;
        }
        match c {
            Some('[') => depth += 1,
            Some(']' | '}') => return false,
            Some('{') => match quantifier_end(i) {
                Some(end) => i = end,
                None => return false,
            },
            Some('\\') => {
                let Some(e) = ch(i + 1) else { return false };
                match e {
                    '1'..='9' => {
                        let mut j = i + 1;
                        let mut n = 0usize;
                        while let Some(d) = ch(j).and_then(|d| d.to_digit(10)) {
                            n = n.saturating_mul(10).saturating_add(d as usize);
                            j += 1;
                        }
                        if n > groups {
                            return false;
                        }
                        i = j - 1;
                    }
                    '0' if ch(i + 2).is_some_and(|d| d.is_ascii_digit()) => return false,
                    'k' => {
                        if ch(i + 2) != Some('<') {
                            return false;
                        }
                        let Some(end) = p[i + 3..].iter().position(|&c| c == u32::from('>')).map(|e| i + 3 + e) else {
                            return false;
                        };
                        if !names.iter().any(|n| n.as_slice() == &p[i + 3..end]) {
                            return false;
                        }
                        i = end;
                    }
                    // (`\\p{…}`, `\\P{…}` and `\\u{…}` carry a braced body — no quantifier.)
                    'p' | 'P' | 'u' if ch(i + 2) == Some('{') => {
                        let Some(end) = p[i + 2..].iter().position(|&c| c == u32::from('}')).map(|e| i + 2 + e) else {
                            return false;
                        };
                        i = end;
                    }
                    'd' | 'D' | 's' | 'S' | 'w' | 'W' | 'b' | 'B' | 'f' | 'n' | 'r' | 't' | 'v' | 'c' | 'p' | 'P'
                    | 'u' | 'x' | '0' => i += 1,
                    '^' | '$' | '\\' | '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '/' => i += 1,
                    _ => return false,
                }
            }
            _ => {}
        }
        i += 1;
    }
    true
}

// ASCII whitespace (Infra), as a UTF-16 unit.
pub(crate) fn is_ascii_ws_unit(u: u16) -> bool {
    matches!(u, 0x09 | 0x0A | 0x0C | 0x0D | 0x20)
}
fn trim_ascii_ws_units(u: &[u16]) -> &[u16] {
    let start = u.iter().position(|&c| !is_ascii_ws_unit(c)).unwrap_or(u.len());
    let end = u.iter().rposition(|&c| !is_ascii_ws_unit(c)).map_or(start, |e| e + 1);
    &u[start..end]
}

impl RealmArena {
    // patternMismatch of a non-empty input of a type `pattern` applies to: its sanitized value — each of a multiple
    // email's non-empty tokens — does not match the whole pattern. Over UTF-16, as the value getter returns it.
    fn pattern_mismatch(&self, n: &NodeData, ty: &str) -> bool {
        let Some(pattern) = n.plain_attr_units("pattern") else { return false };
        let raw: Vec<u16> = match &n.value {
            Some(v) => v.to_vec(),
            None => n.plain_attr_units("value").unwrap_or_default(),
        };
        // (The type decides how the value is cut and trimmed, so it is part of the value's key.)
        let mut key_value = raw.clone();
        key_value.extend(ty.encode_utf16());
        key_value.push(u16::from(n.plain_attr("multiple").is_some()));
        let key = (pattern, key_value);
        if let Some(hit) = PATTERN_RESULTS.with_borrow(|c| c.get(&key).copied()) {
            return hit;
        }
        let answer = self.pattern_mismatch_uncached(n, ty, &key.0, &raw);
        PATTERN_RESULTS.with_borrow_mut(|c| {
            if c.len() >= PATTERN_CACHE_LIMIT {
                c.clear();
            }
            c.insert(key, answer);
        });
        answer
    }
    fn pattern_mismatch_uncached(&self, n: &NodeData, ty: &str, pattern: &[u16], raw: &[u16]) -> bool {
        let Some(re) = compiled_pattern(pattern) else { return false };
        let fails = |s: &[u16]| re.find_from_utf16(s, 0).next().is_none();
        let strip = |u: &[u16]| u.iter().copied().filter(|&c| c != 0x0D && c != 0x0A).collect::<Vec<u16>>();
        match ty {
            "email" if n.plain_attr("multiple").is_some() => raw
                .split(|&c| c == u16::from(b','))
                .map(trim_ascii_ws_units)
                .filter(|t| !t.is_empty())
                .any(fails),
            "url" | "email" => fails(trim_ascii_ws_units(&strip(raw))),
            _ => fails(&strip(raw)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::compiled_pattern;

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }
    fn matches(pattern: &str, value: &str) -> Option<bool> {
        compiled_pattern(&units(pattern)).map(|re| re.find_from_utf16(&units(value), 0).next().is_some())
    }

    #[test]
    fn a_pattern_matches_the_whole_value_with_the_v_flag() {
        assert_eq!(matches("[a-z]{3}", "abc"), Some(true));
        assert_eq!(matches("[a-z]{3}", "abcd"), Some(false));
        assert_eq!(matches("a|b", "ab"), Some(false)); // anchored around the whole alternation
        assert_eq!(matches("a.b", "a\u{1D306}b"), Some(true)); // code points, not code units
        assert_eq!(matches(r"\p{RGI_Emoji}+", "\u{1F618}\u{1F48B}"), Some(true));
        assert_eq!(matches(r"[\p{L}--[a-z]]+", "ÄÖ"), Some(true));
    }

    #[test]
    fn a_pattern_that_does_not_compile_alone_is_ignored() {
        assert_eq!(matches("(", "x"), None);
        assert_eq!(matches("a)(b", "a)(b"), None); // the anchoring wrapper would balance it
        assert_eq!(matches("[(]", "("), None); // a reserved class-set character under `v`
    }

    // Each a SyntaxError to V8 under `v` (Chrome ignores the pattern), and each one regress alone accepts.
    #[test]
    fn a_pattern_v8_rejects_is_ignored() {
        for bad in [r"\d{3}\-\d{4}", "a{,3}", r"\101", r"\a", r"\q{a}", r"[a-z]{2}\1", r"\k<x>", "a}", "a]", r"\01"] {
            assert_eq!(matches(bad, "x"), None, "{bad}");
        }
    }

    // …and what V8 accepts stays accepted.
    #[test]
    fn a_pattern_v8_accepts_is_kept() {
        for good in [
            r"\d{3}-\d{4}",
            "a{2,3}",
            "a{2,}",
            r"(a)\1",
            r"(?<y>b)\k<y>",
            r"[\-a]",
            r"[\q{ab|c}]",
            r"\p{L}+",
            r"\u{1F600}",
            r"\x41\cJ\0",
            r"(?:a)(?=b)(?!c)(?<=d)(?<!e)",
            r"\^\$\\\.\*\+\?\(\)\[\]\{\}\|\/",
        ] {
            assert!(compiled_pattern(&units(good)).is_some(), "{good}");
        }
    }

    #[test]
    fn a_lone_surrogate_is_a_character_of_its_own() {
        let value = vec![0x61, 0xD800, 0x62];
        let re = compiled_pattern(&units("a.b")).unwrap();
        assert!(re.find_from_utf16(&value, 0).next().is_some());
    }
}

#[cfg(test)]
mod form_tests {
    use super::*;
    use web_atoms::ns;

    // An HTML element named `name` with `attrs`, a child of `parent`.
    fn html(arena: &mut RealmArena, parent: Option<NodeId>, name: &str, attrs: &[&str]) -> NodeId {
        let mut n = NodeData::of_kind(NodeKind::Element, Vec::new());
        n.local_name = name.into();
        n.ns = ns!(html);
        n.attributes = attrs.iter().map(|a| (a.to_string(), String::new())).collect();
        arena.create(n, parent)
    }
    fn selected(arena: &RealmArena, changes: &[(NodeId, u32)], option: NodeId) -> bool {
        let changed = changes.iter().find(|(o, _)| *o == option);
        let state = changed.map_or_else(|| arena.get(option).unwrap().state, |c| c.1);
        state & STATE_SELECTED != 0
    }

    #[test]
    fn selectedness_setting_algorithm() {
        let mut arena = RealmArena::default();
        // (…a drop-down box with none selected: its first option not disabled — past a disabled one and one in a
        // disabled optgroup)
        let select = html(&mut arena, None, "select", &[]);
        let off = html(&mut arena, Some(select), "option", &["disabled"]);
        let group = html(&mut arena, Some(select), "optgroup", &["disabled"]);
        let grouped = html(&mut arena, Some(group), "option", &[]);
        let first = html(&mut arena, Some(select), "option", &[]);
        let changes = arena.selectedness(select, None);
        assert!(!selected(&arena, &changes, off) && !selected(&arena, &changes, grouped));
        assert!(selected(&arena, &changes, first));
        // (…two selected by their attribute: the last; one just selected: it, whatever its place)
        let two = html(&mut arena, None, "select", &[]);
        let a = html(&mut arena, Some(two), "option", &["selected"]);
        let b = html(&mut arena, Some(two), "option", &["selected"]);
        let changes = arena.selectedness(two, None);
        assert!(!selected(&arena, &changes, a) && selected(&arena, &changes, b));
        let changes = arena.selectedness(two, Some(a));
        assert!(selected(&arena, &changes, a) && !selected(&arena, &changes, b));
        // (…a list box keeps none; a multiple select is left to its options)
        let list = html(&mut arena, None, "select", &["size"]);
        arena.get_mut_quietly(list).unwrap().attributes = vec![("size".into(), "3".into())];
        html(&mut arena, Some(list), "option", &[]);
        assert!(arena.selectedness(list, None).iter().all(|(_, s)| s & STATE_SELECTED == 0));
        let multiple = html(&mut arena, None, "select", &["multiple"]);
        html(&mut arena, Some(multiple), "option", &["selected"]);
        assert!(arena.selectedness(multiple, None).is_empty());
        // (…a dirty option keeps its selectedness over its attribute)
        let dirty = html(&mut arena, None, "option", &["selected"]);
        arena.get_mut_quietly(dirty).unwrap().state = STATE_SELECTED_DIRTY;
        assert_eq!(arena.option_initialised(dirty), STATE_SELECTED_DIRTY | STATE_SELECTED_INIT);
    }

    #[test]
    fn labels_and_editing_hosts() {
        let mut arena = RealmArena::default();
        let root = html(&mut arena, None, "div", &[]);
        // (…a label without `for`: its first labelable descendant — past a hidden input — in tree order)
        let label = html(&mut arena, Some(root), "label", &[]);
        let wrap = html(&mut arena, Some(label), "span", &[]);
        let hidden = html(&mut arena, Some(wrap), "input", &["type"]);
        arena.get_mut_quietly(hidden).unwrap().attributes = vec![("type".into(), "hidden".into())];
        let input = html(&mut arena, Some(wrap), "input", &[]);
        assert_eq!(arena.labeled_control(label), Some(input));
        assert_eq!(arena.labels_of(input), vec![label]);
        assert!(!arena.is_labelable(hidden) && arena.labels_of(hidden).is_empty());
        // (…a click on the label's text activates it, one on its control the control)
        let text = html(&mut arena, Some(label), "b", &[]);
        assert_eq!(arena.label_to_activate(text), Some(label));
        assert_eq!(arena.label_to_activate(input), None);
        // (…an editing host is the nearest contenteditable that is not false)
        let host = html(&mut arena, Some(root), "div", &["contenteditable"]);
        let off = html(&mut arena, Some(host), "p", &["contenteditable"]);
        arena.get_mut_quietly(off).unwrap().attributes = vec![("contenteditable".into(), "FALSE".into())];
        let inner = html(&mut arena, Some(host), "em", &[]);
        assert_eq!(arena.editing_host(inner), Some(host));
        assert_eq!(arena.editing_host(off), None);
    }
}
