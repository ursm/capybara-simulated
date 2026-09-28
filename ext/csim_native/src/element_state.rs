// The HTML element states the selector engine's state pseudo-classes read (`:checked`, `:disabled`, `:focus`,
// `:hover`, …): each one derived from the arena — an element's attributes, its tree, and the `state` bits for what no
// attribute carries (`NodeData::state`, written by the JS side at the one place each state changes).
//
// The ancestor walks here are SHADOW-INCLUDING — a shadow root's parent is its host — as the JS DOM's `_parent` chain
// is, which every one of these rules is written against.

use crate::dom::{
    NodeData, NodeId, NodeKind, RealmArena, STATE_CHECKED, STATE_CHECKED_DIRTY, STATE_FILTERED, STATE_FOCUSED,
    STATE_FORM_ASSOCIATED, STATE_INDETERMINATE, STATE_MODAL, STATE_POPOVER_OPEN, STATE_SELECTED,
};

// The `<input>` types the `readonly` attribute applies to (form-helpers.js `READONLY_INPUT_TYPES`).
const READONLY_INPUT_TYPES: [&str; 12] = [
    "text", "search", "tel", "url", "email", "password", "number", "date", "month", "week", "time", "datetime-local",
];
// Every `<input>` type state keyword: an attribute naming none of them is the Text state.
const INPUT_TYPES: [&str; 22] = [
    "hidden", "text", "search", "tel", "url", "email", "password", "date", "month", "week", "time", "datetime-local",
    "number", "range", "color", "checkbox", "radio", "file", "submit", "image", "reset", "button",
];

impl NodeData {
    fn is_html(&self) -> bool {
        self.kind == NodeKind::Element && self.ns.is_empty()
    }
    fn is_html_named(&self, name: &str) -> bool {
        self.is_html() && self.local_name == name
    }
    // A submit button (form-helpers.js `isSubmitButton`): an `<input type=submit|image>`, or a `<button>` in the Submit
    // state — any `type` but `reset` and `button`, and a missing one unless a `command` / `commandfor` makes it a
    // Command button.
    fn is_submit_button(&self) -> bool {
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
    fn input_type(&self) -> &'static str {
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
    fn is_inclusive_ancestor(&self, ancestor: NodeId, node: NodeId) -> bool {
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
    fn is_connected(&self, id: NodeId) -> bool {
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
    // css-select's `:selected`: an option's selectedness.
    pub(crate) fn is_selected(&self, id: NodeId) -> bool {
        self.get(id).is_some_and(|n| n.is_html_named("option") && n.state & STATE_SELECTED != 0)
    }
    pub(crate) fn is_indeterminate(&self, id: NodeId) -> bool {
        self.has_state(id, STATE_INDETERMINATE)
    }
    pub(crate) fn is_filtered(&self, id: NodeId) -> bool {
        self.has_state(id, STATE_FILTERED)
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
    // `:placeholder-shown`: an `<input>` or `<textarea>` with a `placeholder` and an empty live value.
    pub(crate) fn is_placeholder_shown(&self, id: NodeId) -> bool {
        let Some(n) = self.get(id) else { return false };
        if !(n.is_html_named("input") || n.is_html_named("textarea")) || n.plain_attr("placeholder").is_none() {
            return false;
        }
        match &n.value {
            Some(v) => v.is_empty(),
            // A clean textarea's value is its direct Text children's data; an input's, its `value` attribute.
            None if n.local_name == "textarea" => {
                n.children.iter().all(|&c| self.get(c).is_none_or(|t| t.kind != NodeKind::Text || t.data.is_empty()))
            }
            None => n.plain_attr("value").is_none_or(str::is_empty),
        }
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
        let tag = n.local_name.as_str();
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
                    match p.local_name.as_str() {
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
                n.local_name.as_str(),
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
    // `:default`: an option with the `selected` attribute, a checkbox / radio button with `checked`, and a submit
    // button — an `<input type=submit|image>`, or a `<button>` of the Submit state that is not a `<select>`'s.
    pub(crate) fn is_default(&self, id: NodeId) -> bool {
        let Some(n) = self.get(id) else { return false };
        if !n.is_html() {
            return false;
        }
        match n.local_name.as_str() {
            "option" => n.plain_attr("selected").is_some(),
            "input" => match n.input_type() {
                "checkbox" | "radio" => n.plain_attr("checked").is_some(),
                "submit" | "image" => true,
                _ => false,
            },
            "button" => {
                if !n.is_submit_button() {
                    return false;
                }
                let mut cur = self.shadow_including_parent(id);
                while let Some(c) = cur {
                    if self.get(c).is_some_and(|p| p.is_html_named("select")) {
                        return false;
                    }
                    cur = self.shadow_including_parent(c);
                }
                true
            }
            _ => false,
        }
    }
}
