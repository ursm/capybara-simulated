// The HTML element states the selector engine's state pseudo-classes read (`:checked`, `:disabled`, `:focus`,
// `:hover`, …): each one derived from the arena — an element's attributes, its tree, and the `state` bits for what no
// attribute carries (`NodeData::state`, written by the JS side at the one place each state changes).
//
// The ancestor walks here are SHADOW-INCLUDING — a shadow root's parent is its host — as the JS DOM's `_parent` chain
// is, which every one of these rules is written against.

use web_atoms::{local_name, ns};
use crate::dom::{
    NodeData, NodeId, NodeKind, RealmArena, STATE_CHECKED, STATE_CHECKED_DIRTY, STATE_CUSTOM, STATE_FILTERED,
    STATE_FOCUSED, STATE_FORM_ASSOCIATED, STATE_INDETERMINATE, STATE_IS_VALUE, STATE_MODAL, STATE_POPOVER_OPEN,
    STATE_SELECTED,
};

const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";

// The `<input>` types the `readonly` attribute applies to (form-helpers.js `READONLY_INPUT_TYPES`).
const READONLY_INPUT_TYPES: [&str; 12] = [
    "text", "search", "tel", "url", "email", "password", "number", "date", "month", "week", "time", "datetime-local",
];
// Every `<input>` type state keyword: an attribute naming none of them is the Text state.
const INPUT_TYPES: [&str; 22] = [
    "hidden", "text", "search", "tel", "url", "email", "password", "date", "month", "week", "time", "datetime-local",
    "number", "range", "color", "checkbox", "radio", "file", "submit", "image", "reset", "button",
];

// The names no custom element may take: the hyphenated SVG and MathML ones.
const RESERVED_CUSTOM_ELEMENT_NAMES: [&str; 8] = [
    "annotation-xml", "color-profile", "font-face", "font-face-src", "font-face-uri", "font-face-format",
    "font-face-name", "missing-glyph",
];

// HTML "valid floating-point number" (dom-nodes.js `isValidFloatingPoint`): `-`?, digits with an optional fraction or
// a fraction alone, then an optional exponent — and finite.
pub(crate) fn is_valid_floating_point(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = usize::from(b.first() == Some(&b'-'));
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > start
    };
    let int = digits(&mut i);
    if i < b.len() && b[i] == b'.' {
        i += 1;
        if !digits(&mut i) {
            return false;
        }
    } else if !int {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        if !digits(&mut i) {
            return false;
        }
    }
    i == b.len() && s.parse::<f64>().is_ok_and(f64::is_finite)
}

// A valid custom element name (custom-elements.js `isValidCustomElementName`): a valid element local name that starts
// with an ASCII lower alpha, has no ASCII upper alpha and a hyphen, and is not reserved.
fn is_valid_custom_element_name(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_lowercase())
        && name.contains('-')
        && !name.contains(|c: char| c.is_ascii_uppercase() || matches!(c, '\0' | '\t' | '\n' | '\x0C' | '\r' | ' ' | '/' | '>'))
        && !RESERVED_CUSTOM_ELEMENT_NAMES.contains(&name)
}

// The radio groups holding a checked radio (name, form owner) and each form's default button, of one tree.
#[derive(Default)]
pub(crate) struct FormFacts {
    checked_groups: std::collections::HashSet<(String, Option<NodeId>)>,
    required_groups: std::collections::HashSet<(String, Option<NodeId>)>,
    defaults: std::collections::HashMap<NodeId, NodeId>,
}
// Those facts per tree root, as of the arena's `mutations` count — and, from a second walk that reads them (a radio's
// validity is its group's), the forms and fieldsets holding an invalid candidate for constraint validation.
#[derive(Default)]
pub(crate) struct FormFactsMemo {
    mutations: u64,
    per_root: std::collections::HashMap<NodeId, FormFacts>,
    invalid_containers: std::collections::HashMap<NodeId, std::rc::Rc<std::collections::HashSet<NodeId>>>,
}
impl FormFactsMemo {
    pub(crate) fn clear(&mut self) {
        self.per_root.clear();
        self.invalid_containers.clear();
    }
}

// A `dir` attribute's state: an enumerated attribute, its keyword matched ASCII-case-insensitively with no trimming, so
// `dir=" rtl "` is none and sets no direction.
enum Dir {
    Ltr,
    Rtl,
    Auto,
}
fn dir_keyword(raw: &str) -> Option<Dir> {
    [("ltr", Dir::Ltr), ("rtl", Dir::Rtl), ("auto", Dir::Auto)].into_iter().find(|(k, _)| raw.eq_ignore_ascii_case(k)).map(|(_, d)| d)
}
// The `<input>` types whose value is no directional text: `dir=auto` on one is ltr (dom-nodes.js `DIR_NO_VALUE_INPUT_TYPES`).
const DIR_NO_VALUE_INPUT_TYPES: [&str; 12] =
    ["date", "month", "week", "time", "datetime-local", "number", "range", "color", "checkbox", "radio", "image", "file"];

impl NodeData {
    // A submit button (form-helpers.js `isSubmitButton`): an `<input type=submit|image>`, or a `<button>` in the Submit
    // state — any `type` but `reset` and `button`, and a missing one unless a `command` / `commandfor` makes it a
    // Command button.
    pub(crate) fn is_submit_button(&self) -> bool {
        if self.is_html_named("input") {
            return matches!(self.input_type(), "submit" | "image");
        }
        if !self.is_html_named("button") {
            return false;
        }
        match self.plain_attr("type") {
            None => self.plain_attr("command").is_none() && self.plain_attr("commandfor").is_none(),
            Some(t) => !t.eq_ignore_ascii_case("reset") && !t.eq_ignore_ascii_case("button"),
        }
    }
    // An `<input>`'s type state: its `type` attribute, ASCII-lowercased, when that names one; else Text.
    pub(crate) fn input_type(&self) -> &'static str {
        let raw = self.plain_attr("type").unwrap_or("");
        INPUT_TYPES.iter().copied().find(|t| t.eq_ignore_ascii_case(raw)).unwrap_or("text")
    }
}

impl RealmArena {
    // The parent, or — for a shadow root — its host.
    fn shadow_including_parent(&self, id: NodeId) -> Option<NodeId> {
        let node = self.get(id)?;
        node.parent.or(node.host).filter(|&p| self.get(p).is_some())
    }
    // Is `node` `ancestor` or a shadow-including descendant of it?
    pub(crate) fn is_inclusive_ancestor(&self, ancestor: NodeId, node: NodeId) -> bool {
        let mut cur = Some(node);
        while let Some(c) = cur {
            if c == ancestor {
                return true;
            }
            cur = self.shadow_including_parent(c);
        }
        false
    }
    // Is `id` in a document (shadow-including)?
    pub(crate) fn is_connected(&self, id: NodeId) -> bool {
        let mut cur = Some(id);
        while let Some(c) = cur {
            if self.is_document(c) {
                return true;
            }
            cur = self.shadow_including_parent(c);
        }
        false
    }
    fn has_state(&self, id: NodeId, bit: u32) -> bool {
        self.get(id).is_some_and(|n| n.state & bit != 0)
    }

    // `:focus`: the focused element — and every shadow host whose shadow tree holds it (HTML "focused area" for
    // the purposes of `:focus`), compared host by host up from it.
    pub(crate) fn is_focused(&self, id: NodeId) -> bool {
        if self.has_state(id, STATE_FOCUSED) {
            return true;
        }
        let Some(focus) = self.focus.filter(|_| self.has_shadow_hosts) else { return false };
        let mut cur = Some(focus);
        while let Some(c) = cur {
            let node = self.get(c);
            if let Some(host) = node.and_then(|n| n.host) {
                if host == id {
                    return true;
                }
            }
            cur = self.shadow_including_parent(c);
        }
        false
    }
    // `:focus-visible`: focused, with a focus ring.
    pub(crate) fn is_focus_visible(&self, id: NodeId) -> bool {
        !self.focus_ring_hidden && self.is_focused(id)
    }
    // `:focus-within`: the focused element or one of its shadow-including ancestors.
    pub(crate) fn has_focus_within(&self, id: NodeId) -> bool {
        self.focus.is_some_and(|f| self.is_inclusive_ancestor(id, f))
    }
    // `:hover`: the hovered element or one of its shadow-including ancestors.
    pub(crate) fn is_hovered(&self, id: NodeId) -> bool {
        self.hover.is_some_and(|h| self.is_inclusive_ancestor(id, h))
    }

    // `:checked`: an option's selectedness, or a checkbox's / radio button's checkedness — its own once dirty (a
    // click, a script's `.checked`), the `checked` attribute until then.
    pub(crate) fn is_checked(&self, id: NodeId) -> bool {
        let Some(n) = self.get(id) else { return false };
        if n.is_html_named("option") {
            return n.state & STATE_SELECTED != 0;
        }
        if n.is_html_named("input") && matches!(n.input_type(), "checkbox" | "radio") {
            return if n.state & STATE_CHECKED_DIRTY != 0 {
                n.state & STATE_CHECKED != 0
            } else {
                n.plain_attr("checked").is_some()
            };
        }
        false
    }
    // An option's selectedness (its `:checked`).
    pub(crate) fn is_selected(&self, id: NodeId) -> bool {
        self.get(id).is_some_and(|n| n.is_html_named("option") && n.state & STATE_SELECTED != 0)
    }
    // `:indeterminate`: a checkbox whose `indeterminate` is set, a radio button whose group has nothing checked, and a
    // `<progress>` with no value.
    pub(crate) fn is_indeterminate(&self, id: NodeId) -> bool {
        let Some(n) = self.get(id) else { return false };
        if n.is_html_named("progress") {
            return n.plain_attr("value").is_none();
        }
        if !n.is_html_named("input") {
            return false;
        }
        match n.input_type() {
            "checkbox" => n.state & STATE_INDETERMINATE != 0,
            "radio" => !self.radio_group_has_checked(id),
            _ => false,
        }
    }
    // Does `id`'s radio button group — its name, form owner and tree — hold a checked radio (form-helpers.js
    // `radioGroupHasChecked`)? A nameless radio is its own group.
    fn radio_group_has_checked(&self, id: NodeId) -> bool {
        if self.is_checked(id) {
            return true;
        }
        let Some(name) = self.get(id).and_then(|n| n.plain_attr("name")).filter(|n| !n.is_empty()) else { return false };
        let owner = self.form_owner(id);
        self.with_form_facts(self.root_of(id), |f| f.checked_groups.contains(&(name.to_string(), owner)))
    }
    // What those two ask of `root`'s tree, from ONE walk of it, kept until the arena next changes: a pseudo-class asked of
    // every radio or submit button in turn walked the whole tree per element.
    fn with_form_facts<R>(&self, root: NodeId, answer: impl FnOnce(&FormFacts) -> R) -> R {
        {
            let memo = self.form_facts.borrow();
            if memo.mutations == self.mutations {
                if let Some(facts) = memo.per_root.get(&root) {
                    return answer(facts);
                }
            }
        }
        let mut facts = FormFacts::default();
        self.find_in_tree(root, |c, n| {
            if n.is_html_named("input") && n.input_type() == "radio" {
                if let Some(name) = n.plain_attr("name").filter(|n| !n.is_empty()) {
                    let group = (name.to_string(), self.form_owner(c));
                    if n.plain_attr("required").is_some() {
                        facts.required_groups.insert(group.clone());
                    }
                    if self.is_checked(c) {
                        facts.checked_groups.insert(group);
                    }
                }
            }

            if n.is_submit_button() && !self.in_select(c) {
                if let Some(form) = self.form_owner(c) {
                    facts.defaults.entry(form).or_insert(c);
                }
            }
            false
        });
        let result = answer(&facts);
        let mut memo = self.form_facts.borrow_mut();
        if memo.mutations != self.mutations {
            memo.clear();
            memo.mutations = self.mutations;
        }
        memo.per_root.insert(root, facts);
        result
    }

    // The root of `id`'s tree: a document, a fragment or shadow root, or a detached subtree's top.
    fn root_of(&self, id: NodeId) -> NodeId {
        let mut cur = id;
        while let Some(p) = self.parent_of(cur) {
            cur = p;
        }
        cur
    }
    // The first element of `root`'s tree (itself included, shadow trees not) that `pred` takes, in tree order.
    fn find_in_tree(&self, root: NodeId, mut pred: impl FnMut(NodeId, &NodeData) -> bool) -> Option<NodeId> {
        let mut stack = vec![root];
        while let Some(c) = stack.pop() {
            let Some(n) = self.get(c) else { continue };
            if n.kind == NodeKind::Element && pred(c, n) {
                return Some(c);
            }
            stack.extend(n.children.iter().rev().copied());
        }
        None
    }
    // A control's form owner (form-helpers.js `formForControl`): the form its `form` attribute names in its tree
    // when it is connected (none for an empty or unmatched one, or a non-form), else its nearest ancestor form, else
    // the form the parser gave it while it still shares that form's tree.
    fn form_owner(&self, id: NodeId) -> Option<NodeId> {
        let n = self.get(id)?;
        if let Some(form_id) = n.plain_attr("form").filter(|_| self.is_connected(id)) {
            if form_id.is_empty() {
                return None;
            }
            let hit = self.find_in_tree(self.root_of(id), |_, e| e.get_attr("id") == Some(form_id))?;
            return self.get(hit).is_some_and(|f| f.is_html_named("form")).then_some(hit);
        }
        let mut cur = self.parent_of(id);
        while let Some(c) = cur {
            let p = self.get(c)?;
            if p.kind != NodeKind::Element {
                break;
            }
            if p.local_name == local_name!("form") {
                return Some(c);
            }
            cur = self.parent_of(c);
        }
        let hint = self.parser_form_owner(id)?;
        (self.get(hint).is_some() && self.root_of(hint) == self.root_of(id)).then_some(hint)
    }
    // A form's default button: the first submit button in tree order whose form owner is the form, not a
    // `<select>`'s (form-helpers.js `defaultButtonOf`).
    fn default_button_of(&self, form: NodeId) -> Option<NodeId> {
        let root = if self.is_connected(form) { self.root_of(form) } else { form };
        self.with_form_facts(root, |f| f.defaults.get(&form).copied())
    }
    fn in_select(&self, id: NodeId) -> bool {
        let mut cur = self.shadow_including_parent(id);
        while let Some(c) = cur {
            if self.get(c).is_some_and(|p| p.is_html_named("select")) {
                return true;
            }
            cur = self.shadow_including_parent(c);
        }
        false
    }
    pub(crate) fn is_filtered(&self, id: NodeId) -> bool {
        self.has_state(id, STATE_FILTERED)
    }
    // A `<select>` shown as a LIST BOX rather than a drop-down (HTML rendering §15.5.15): `multiple`, or a display size
    // above 1 — its `size` PARSED as a non-negative integer, so ` 1 ` and junk are drop-downs as they are to
    // `selectDisplaySize`. What the UA sheet's `:-servo-list-box` asks, and the walk's.
    pub(crate) fn is_list_box(&self, id: NodeId) -> bool {
        self.get(id).is_some_and(|n| n.is_html_named("select")) && self.select_display_size(id) > 1
    }
    // …a `<select>`'s DISPLAY SIZE (`selectDisplaySize`): its `size` where that parses above 0, else 4 for a `multiple`
    // one and 1 for a drop-down.
    pub(crate) fn select_display_size(&self, id: NodeId) -> u64 {
        let Some(n) = self.get(id) else { return 1 };
        match n.get_attr("size").and_then(crate::validity::parse_non_negative).filter(|&s| s > 0) {
            Some(size) => size,
            None if n.get_attr("multiple").is_some() => 4,
            None => 1,
        }
    }
    // A `<table>` whose `border` maps to a non-zero width, whose cells the UA sheet frames (`:-servo-nonzero-border`).
    pub(crate) fn has_nonzero_border(&self, id: NodeId) -> bool {
        self.get(id).is_some_and(|n| n.is_html_named("table") && crate::hints::table_border(n).is_some_and(|px| px != "0px"))
    }
    // `:popover-open`: a showing popover, in a document.
    pub(crate) fn is_popover_open(&self, id: NodeId) -> bool {
        self.has_state(id, STATE_POPOVER_OPEN) && self.is_connected(id)
    }
    // `:modal`: a dialog shown modally that is still open (any way of closing it drops the `open` attribute), in a
    // document.
    pub(crate) fn is_modal(&self, id: NodeId) -> bool {
        self.get(id).is_some_and(|n| n.state & STATE_MODAL != 0 && n.plain_attr("open").is_some()) && self.is_connected(id)
    }
    // `:placeholder-shown`: a `<textarea>`, or an `<input>` of a type the `placeholder` applies to, with one and an
    // empty value — the SANITIZED value, as it is shown.
    pub(crate) fn is_placeholder_shown(&self, id: NodeId) -> bool {
        let Some(n) = self.get(id) else { return false };
        if n.plain_attr("placeholder").is_none() {
            return false;
        }
        if n.is_html_named("textarea") {
            return match &n.value {
                Some(v) => v.is_empty(),
                // A clean textarea's value is its direct Text children's data.
                None => n.children.iter().all(|&c| self.get(c).is_none_or(|t| t.kind != NodeKind::Text || t.data.is_empty())),
            };
        }
        if !n.is_html_named("input") {
            return false;
        }
        let raw = match &n.value {
            Some(v) => String::from_utf16_lossy(v),
            None => n.plain_attr("value").unwrap_or("").to_string(),
        };
        let ascii_ws = |c: char| matches!(c, '\t' | '\n' | '\x0C' | '\r' | ' ');
        // Empty once value sanitization has run (dom-nodes.js `sanitizeInputValue`).
        match n.input_type() {
            "text" | "search" | "tel" | "password" => raw.chars().all(|c| c == '\r' || c == '\n'),
            "url" => raw.chars().all(ascii_ws),
            "email" if n.plain_attr("multiple").is_some() => !raw.contains(',') && raw.chars().all(ascii_ws),
            "email" => raw.chars().all(ascii_ws),
            "number" => !is_valid_floating_point(&raw),
            _ => false,
        }
    }
    // `:required` / `:optional`: an `<input>` the `required` attribute applies to (not a button, hidden, range or color
    // one, whose `required` is ignored), a `<select>` or a `<textarea>` — `Some(required)` — or neither (`None`).
    pub(crate) fn requiredness(&self, id: NodeId) -> Option<bool> {
        let n = self.get(id)?;
        let requirable = if n.is_html_named("input") {
            !matches!(n.input_type(), "submit" | "image" | "reset" | "button" | "hidden" | "range" | "color")
        } else {
            n.is_html_named("select") || n.is_html_named("textarea")
        };
        requirable.then(|| n.plain_attr("required").is_some())
    }
    // `:defined`: any element but a custom element — one with a valid custom element name or an `is` value (fixed at
    // creation, not the attribute) — that is not custom yet (undefined), or never will be (its upgrade failed).
    pub(crate) fn is_defined(&self, id: NodeId) -> bool {
        let Some(n) = self.get(id) else { return false };
        if !n.is_html() || n.state & STATE_CUSTOM != 0 {
            return true;
        }
        !(is_valid_custom_element_name(&n.local_name) || n.state & STATE_IS_VALUE != 0)
    }
    // Does `id`'s radio group — some member `required` — have nothing checked (valueMissing for every member)?
    pub(crate) fn radio_group_misses_required(&self, id: NodeId) -> bool {
        let Some(name) = self.get(id).and_then(|n| n.plain_attr("name")).filter(|n| !n.is_empty()) else { return false };
        let group = (name.to_string(), self.form_owner(id));
        let required = self.get(id).is_some_and(|n| n.plain_attr("required").is_some());
        self.with_form_facts(self.root_of(id), |f| {
            (required || f.required_groups.contains(&group)) && !f.checked_groups.contains(&group)
        })
    }
    // Does this form / fieldset hold an invalid candidate — a form by the controls it OWNS (a `form=` one outside it
    // included), a fieldset by its descendants?
    pub(crate) fn contains_invalid(&self, id: NodeId) -> bool {
        let root = self.root_of(id);
        {
            let memo = self.form_facts.borrow();
            if memo.mutations == self.mutations {
                if let Some(set) = memo.invalid_containers.get(&root) {
                    return set.contains(&id);
                }
            }
        }
        let mut set = std::collections::HashSet::new();
        self.find_in_tree(root, |c, n| {
            let control = matches!(&*n.local_name, "input" | "select" | "textarea" | "button")
                || n.state & STATE_FORM_ASSOCIATED != 0;
            if control && self.will_validate(c) && self.validity(c) != 0 {
                if let Some(form) = self.form_owner(c) {
                    set.insert(form);
                }
                let mut up = self.parent_of(c);
                while let Some(p) = up {
                    if self.get(p).is_some_and(|e| e.is_html_named("fieldset")) {
                        set.insert(p);
                    }
                    up = self.parent_of(p);
                }
            }
            false
        });
        let answer = set.contains(&id);
        let mut memo = self.form_facts.borrow_mut();
        if memo.mutations != self.mutations {
            memo.clear();
            memo.mutations = self.mutations;
        }
        memo.invalid_containers.insert(root, std::rc::Rc::new(set));
        answer
    }

    // `:target`: the realm document's target element (target.js) — its indicated part for its target fragments, tried
    // in turn: the first element of its tree (not a shadow tree) with that id, else the first HTML `<a>` with that name.
    // Only an element whose own id or name is one of them can be, so every other answers without walking the tree.
    pub(crate) fn is_target(&self, id: NodeId) -> bool {
        let Some((doc, fragments)) = &self.target else { return false };
        let Some(n) = self.get(id) else { return false };
        let named = |n: &NodeData, f: &str| n.is_html_named("a") && n.plain_attr("name") == Some(f);
        let candidate = |f: &String| n.get_attr("id") == Some(f.as_str()) || named(n, f);
        if !fragments.iter().any(candidate) || self.root_of(id) != *doc {
            return false;
        }
        let indicated = fragments.iter().find_map(|f| {
            self.find_in_tree(*doc, |_, e| e.get_attr("id") == Some(f.as_str()))
                .or_else(|| self.find_in_tree(*doc, |_, e| named(e, f)))
        });
        indicated == Some(id)
    }
    // `:lang(ranges)` (selectors.js `matchesLang`): the element's language — the nearest shadow-including inclusive
    // ancestor's `lang` in the XML namespace, or an HTML or SVG one's own `lang` — matches a range (comma-joined, lowercased)
    // equal to it, extended by it at a subtag boundary, or `*`; an empty language (lang="") none.
    pub(crate) fn matches_lang(&self, id: NodeId, ranges: &str) -> bool {
        let Some(lang) = self.language_of(id).map(str::to_ascii_lowercase).filter(|l| !l.is_empty()) else { return false };
        ranges.split(',').map(str::trim).filter(|r| !r.is_empty()).any(|r| {
            r == "*" || r == lang || (lang.len() > r.len() && lang.starts_with(r) && lang.as_bytes()[r.len()] == b'-')
        })
    }
    fn language_of(&self, id: NodeId) -> Option<&str> {
        let mut cur = Some(id);
        while let Some(c) = cur {
            if let Some(n) = self.get(c).filter(|n| n.kind == NodeKind::Element) {
                if let Some(v) = n.ns_attr(XML_NS, "lang") {
                    return Some(v);
                }
                if n.is_html() || n.ns == ns!(svg) {
                    if let Some(v) = n.plain_attr("lang") {
                        return Some(v);
                    }
                }
            }
            cur = self.shadow_including_parent(c);
        }
        None
    }
    // HTML's DIRECTIONALITY (§3.2.6.4, dom-nodes.js `_directionality`) — what `:dir()` matches, true for rtl: the
    // nearest shadow-including inclusive ancestor that decides by ITSELF (`own_directionality`), the root's ltr where
    // none does. Every element on the walk up is remembered as of `mutations`, so a page's state scan asks each once:
    // a descendant stops at its parent's answer.
    pub(crate) fn is_rtl(&self, id: NodeId) -> bool {
        if !self.direction_sources {
            return false;
        }
        {
            let mut memo = self.directionality.borrow_mut();
            if memo.0 != self.mutations {
                *memo = (self.mutations, Default::default());
            }
        }
        let mut path = Vec::new();
        let mut cur = Some(id);
        let mut rtl = false;
        while let Some(c) = cur {
            if let Some(&known) = self.directionality.borrow().1.get(&c) {
                rtl = known;
                break;
            }
            path.push(c);
            if let Some(own) = self.own_directionality(c) {
                rtl = own;
                break;
            }
            cur = self.shadow_including_parent(c);
        }
        let mut memo = self.directionality.borrow_mut();
        for c in path {
            memo.1.insert(c, rtl);
        }
        rtl
    }
    // The steps an element decides its directionality by ITSELF (`ownDirectionalityStep`), None where it inherits: an
    // HTML element's valid `dir` (an enumerated attribute, its keyword matched ASCII-case-insensitively and NOT
    // trimmed — a `dir` on an SVG or MathML element is no such attribute, Chrome and Firefox), `auto` or a `<bdi>`
    // with none resolving by its content, a telephone `<input>` with none ltr (a number is written left to right in
    // any script).
    fn own_directionality(&self, id: NodeId) -> Option<bool> {
        let n = self.get(id).filter(|n| n.kind == NodeKind::Element && n.is_html())?;
        match n.plain_attr("dir").and_then(dir_keyword) {
            Some(Dir::Ltr) => Some(false),
            Some(Dir::Rtl) => Some(true),
            Some(Dir::Auto) => Some(self.resolve_auto(id)),
            None if n.is_html_named("input") && n.input_type() == "tel" => Some(false),
            None if n.is_html_named("bdi") => Some(self.resolve_auto(id)),
            None => None,
        }
    }
    // A text control's from its VALUE (`controlAutoDir` — an `<input>` of a type whose value is no text, ltr), anything
    // else's from the first strong character of its text (`autoDirectionality`): in tree order, skipping what sets its
    // own direction (an HTML element's valid `dir`, a `<bdi>`, an HTML `<script>` / `<style>` / `<textarea>`), a
    // shadow tree's `<slot>` ending the scan with its HOST's directionality — and a `<slot>` itself scanning its
    // ASSIGNED nodes where it has any, its own children where it has none.
    fn resolve_auto(&self, id: NodeId) -> bool {
        let Some(n) = self.get(id) else { return false };
        let strong = crate::unicode::first_strong_direction;
        if n.is_html_named("textarea") {
            return match &n.value {
                Some(v) => strong(v),
                None => n.children.iter().filter_map(|&c| self.get(c)).filter(|t| t.kind == NodeKind::Text).find_map(|t| strong(&t.data)),
            }
            .unwrap_or(false);
        }
        if n.is_html_named("input") {
            if DIR_NO_VALUE_INPUT_TYPES.contains(&n.input_type()) {
                return false;
            }
            return match &n.value {
                Some(v) => strong(v),
                None => n.plain_attr_units("value").and_then(|v| strong(&v)),
            }
            .unwrap_or(false);
        }
        let first: &[NodeId] = if n.is_html_named("slot") && !n.assigned.is_empty() { &n.assigned } else { &n.children };
        let mut stack: Vec<NodeId> = first.iter().rev().copied().collect();
        while let Some(c) = stack.pop() {
            let Some(k) = self.get(c) else { continue };
            match k.kind {
                NodeKind::Text => {
                    if let Some(rtl) = strong(&k.data) {
                        return rtl;
                    }
                }
                NodeKind::Element => {
                    let own = k.is_html()
                        && (["bdi", "script", "style", "textarea"].iter().any(|t| k.is_html_named(t))
                            || k.plain_attr("dir").and_then(dir_keyword).is_some());
                    if own {
                        continue;
                    }
                    if k.is_html_named("slot") {
                        if let Some(host) = self.slot_host(c) {
                            return self.is_rtl(host);
                        }
                    }
                    stack.extend(k.children.iter().rev().copied());
                }
                _ => {}
            }
        }
        false
    }
    // The shadow host of the tree `id` is in, if it is in one.
    fn slot_host(&self, id: NodeId) -> Option<NodeId> {
        let mut cur = id;
        while let Some(p) = self.get(cur)?.parent {
            cur = p;
        }
        self.get(cur)?.host
    }
    // `:open`: a `<details>` or `<dialog>` with the `open` attribute.
    pub(crate) fn is_open(&self, id: NodeId) -> bool {
        self.get(id)
            .is_some_and(|n| (n.is_html_named("details") || n.is_html_named("dialog")) && n.plain_attr("open").is_some())
    }

    // HTML "actually disabled" (form-helpers.js `isNodeActuallyDisabled`): a form control — a form-associated custom
    // element included — with its own `disabled`, or inside a disabled `<fieldset>` but not in that fieldset's first
    // `<legend>`; an `<optgroup>` or `<option>` with its own, or in a disabled `<optgroup>` / `<select>` it belongs
    // to.
    pub(crate) fn is_actually_disabled(&self, id: NodeId) -> bool {
        let Some(n) = self.get(id) else { return false };
        if !n.is_html() {
            return false;
        }
        let tag = &*n.local_name;
        let disableable = matches!(tag, "button" | "input" | "select" | "textarea" | "fieldset" | "optgroup" | "option");
        if !disableable && n.state & STATE_FORM_ASSOCIATED == 0 {
            return false;
        }
        if n.plain_attr("disabled").is_some() {
            return true;
        }
        if tag == "option" || tag == "optgroup" {
            // The list-of-options path up to the `<select>`: an option, an `<hr>` or a `<datalist>` ends it, and so
            // does a second `<optgroup>` (a nested one is no member), while any other element is a transparent
            // wrapper.
            let mut crossed_optgroup = false;
            let mut cur = self.shadow_including_parent(id);
            while let Some(c) = cur {
                let Some(p) = self.get(c) else { break };
                if p.kind == NodeKind::Element {
                    match &*p.local_name {
                        "select" => return self.is_actually_disabled(c),
                        "option" | "hr" | "datalist" => return false,
                        "optgroup" => {
                            if tag == "optgroup" || crossed_optgroup {
                                return false;
                            }
                            crossed_optgroup = true;
                            if p.plain_attr("disabled").is_some() {
                                return true;
                            }
                        }
                        _ => {}
                    }
                }
                cur = self.shadow_including_parent(c);
            }
            return false;
        }
        let mut cur = self.shadow_including_parent(id);
        while let Some(c) = cur {
            if self.get(c).is_some_and(|p| p.is_html_named("fieldset") && p.plain_attr("disabled").is_some())
                && !self.in_first_legend(id, c)
            {
                return true;
            }
            cur = self.shadow_including_parent(c);
        }
        false
    }
    // Is `id` inside `fieldset`'s first `<legend>` child?
    fn in_first_legend(&self, id: NodeId, fieldset: NodeId) -> bool {
        let Some(f) = self.get(fieldset) else { return false };
        let legend = f.children.iter().copied().find(|&c| self.get(c).is_some_and(|n| n.is_html_named("legend")));
        legend.is_some_and(|l| self.is_inclusive_ancestor(l, id))
    }
    // `:enabled`: a form control (a form-associated custom element included) that is not actually disabled.
    pub(crate) fn is_enabled(&self, id: NodeId) -> bool {
        let Some(n) = self.get(id) else { return false };
        let enableable = n.is_html()
            && (matches!(
                &*n.local_name,
                "button" | "input" | "select" | "textarea" | "optgroup" | "option" | "fieldset"
            ) || n.state & STATE_FORM_ASSOCIATED != 0);
        enableable && !self.is_actually_disabled(id)
    }
    // `:read-write`: a mutable text-entry `<input>` or `<textarea>` (not `readonly`, not actually disabled), or an
    // element in an editing host.
    pub(crate) fn is_read_write(&self, id: NodeId) -> bool {
        let Some(n) = self.get(id) else { return false };
        if n.is_html_named("input") {
            return READONLY_INPUT_TYPES.contains(&n.input_type())
                && n.plain_attr("readonly").is_none()
                && !self.is_actually_disabled(id);
        }
        if n.is_html_named("textarea") {
            return n.plain_attr("readonly").is_none() && !self.is_actually_disabled(id);
        }
        self.is_editable(id)
    }
    // Is `id` in an editing host — the nearest element ancestor with a `contenteditable` state says `true` (or
    // `plaintext-only`), not `false`?
    fn is_editable(&self, id: NodeId) -> bool {
        let mut cur = Some(id);
        while let Some(c) = cur {
            let Some(n) = self.get(c) else { break };
            if n.kind != NodeKind::Element {
                break;
            }
            if let Some(v) = n.plain_attr("contenteditable") {
                if v.is_empty() || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("plaintext-only") {
                    return true;
                }
                if v.eq_ignore_ascii_case("false") {
                    return false;
                }
            }
            cur = self.parent_of(c);
        }
        false
    }
    // `:default`: an option with the `selected` attribute, a checkbox / radio button with `checked`, and its form's
    // default button (none for a submit button with no form owner).
    pub(crate) fn is_default(&self, id: NodeId) -> bool {
        let Some(n) = self.get(id) else { return false };
        if !n.is_html() {
            return false;
        }
        if n.local_name == local_name!("option") {
            return n.plain_attr("selected").is_some();
        }
        if n.local_name == local_name!("input") && matches!(n.input_type(), "checkbox" | "radio") {
            return n.plain_attr("checked").is_some();
        }
        n.is_submit_button() && self.form_owner(id).is_some_and(|f| self.default_button_of(f) == Some(id))
    }
}

#[cfg(test)]
mod tests {
    use super::is_valid_floating_point;

    #[test]
    fn valid_floating_point_numbers() {
        for ok in ["0", "-1", "1.5", ".5", "-.5", "1e3", "1E-3", "2.5e+10"] {
            assert!(is_valid_floating_point(ok), "{ok}");
        }
        for bad in ["", "-", "1.", "+1", "abc", "1e", "1e+", " 1", "1 ", "0x10", "1e999", "Infinity"] {
            assert!(!is_valid_floating_point(bad), "{bad}");
        }
    }
}
