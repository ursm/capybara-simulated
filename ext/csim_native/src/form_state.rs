// A document's controls' persisted user state (HTML §7.4.6.2 "persisted user state"): what a history traversal back to
// a document puts back into its form controls — each value of its own, checkedness and selected options as the user
// left them, NOT their defaults, and without an `input` or `change` (a restore, not an edit). The host keeps it with
// the session history entry the document is navigated away from, and the document fetched again lines its controls
// up with it one to one, in tree order.
//
// What is remembered is what the autofill processing model lets be (HTML §4.10.18.7.1): a control whose autofill field
// name is "off" — its own `autocomplete`, or its form owner's where its own says neither — keeps its data to itself, as
// does a password field (Chrome). (Chrome also forgets the controls that say `on` in a form that says
// `off`; the spec makes theirs "on".) A value is a control's own only in the value mode "value": a hidden field's, a
// button's is its attribute, which the document fetched again has.

use crate::dom::{nid_arg, realm, realm_id, NodeId, RealmArena, STATE_SELECTED, STATE_SELECTED_DIRTY};
use crate::input_types::{value_mode, MODE_DEFAULT_ON, MODE_VALUE};

pub(crate) enum PersistedState {
    // Nothing remembered.
    None,
    // A text control's value.
    Value(Vec<u16>),
    // A checkbox's or a radio button's checkedness.
    Checked(bool),
    // The values of a select's selected options.
    Selected(Vec<Vec<u16>>),
}

impl RealmArena {
    // The controls whose state a document keeps — its `<input>`s, `<textarea>`s and `<select>`s, in tree order.
    pub(crate) fn persisted_state_controls(&self, doc: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut stack = vec![doc];
        while let Some(id) = stack.pop() {
            let Some(n) = self.get(id) else { continue };
            if n.is_html_named("input") || n.is_html_named("textarea") || n.is_html_named("select") {
                out.push(id);
            }
            stack.extend(n.children.iter().rev().copied());
        }
        out
    }
    // …and what each of them remembers.
    pub(crate) fn persisted_state(&self, control: NodeId) -> PersistedState {
        let Some(n) = self.get(control) else { return PersistedState::None };
        if self.autofill_off(control) {
            return PersistedState::None;
        }
        if n.is_html_named("select") {
            let selected = self.selected_options(control, false).into_iter().map(|(_, o)| self.option_value(o)).collect();
            return PersistedState::Selected(selected);
        }
        if n.is_html_named("textarea") {
            return PersistedState::Value(self.raw_value_units(n));
        }
        let ty = n.input_type();
        match value_mode(ty) {
            _ if ty == "password" => PersistedState::None,
            MODE_VALUE => PersistedState::Value(self.raw_value_units(n)),
            MODE_DEFAULT_ON if matches!(ty, "checkbox" | "radio") => PersistedState::Checked(self.is_checked(control)),
            _ => PersistedState::None,
        }
    }
    // Whether a control's autofill field name is "off".
    fn autofill_off(&self, control: NodeId) -> bool {
        let own = self.get(control).and_then(|n| n.plain_attr("autocomplete")).map_or(String::new(), |v| crate::reflect::autofill(v, false));
        match own.as_str() {
            "off" => true,
            "" => self
                .form_owner(control)
                .and_then(|f| self.get(f))
                .and_then(|f| f.plain_attr("autocomplete"))
                .is_some_and(|v| v.trim_matches(|c| matches!(c, '\t' | '\n' | '\x0C' | '\r' | ' ')).eq_ignore_ascii_case("off")),
            _ => false,
        }
    }
    // A select's selected options remembered as `values` put back: a single one's first option of the first of them
    // that one has, a multiple one's every option of one of them — each dirty, as a user's pick. A select none of whose
    // options has one keeps the selection it was parsed with. The options whose selectedness changed.
    pub(crate) fn restore_selected(&mut self, select: NodeId, values: &[Vec<u16>]) -> Vec<NodeId> {
        let Some(n) = self.get(select).filter(|n| n.is_html_named("select")) else { return Vec::new() };
        if n.plain_attr("multiple").is_none() {
            let options = self.list_of_options(select);
            let Some(value) = values.iter().find(|v| options.iter().any(|&o| self.option_value(o) == **v)) else { return Vec::new() };
            return self.select_option(select, |arena, _, o| arena.option_value(o) == *value);
        }
        let mut changed = Vec::new();
        for o in self.list_of_options(select) {
            let Some(had) = self.get(o).map(|n| n.state) else { continue };
            let selected = values.contains(&self.option_value(o));
            let next = self.option_initialised(o) & !STATE_SELECTED | STATE_SELECTED_DIRTY | if selected { STATE_SELECTED } else { 0 };
            if next != had {
                self.set_state(o, next);
            }
            if (next ^ had) & STATE_SELECTED != 0 {
                changed.push(o);
            }
        }
        changed
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "persistedStateControls", persisted_state_controls, context_id);
    crate::dom::register(scope, ns, "persistedFormState", persisted_form_state, context_id);
    crate::dom::register(scope, ns, "restoreSelected", restore_selected, context_id);
}

// __dom.persistedStateControls(docNid) -> the document's controls whose state it keeps (`persisted_state_controls`).
fn persisted_state_controls(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let controls = realm(scope, cid).persisted_state_controls(doc);
    rv.set(crate::dom::nodes_value(scope, cid, &controls));
}

// __dom.persistedFormState(docNid) -> what each of those remembers (`persisted_state`), in their order: null for
// nothing, a value as a string, a checkedness as a boolean, a select's selected options' values as an array of strings.
fn persisted_form_state(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let states: Vec<PersistedState> = arena.persisted_state_controls(doc).into_iter().map(|c| arena.persisted_state(c)).collect();
    let items: Vec<v8::Local<v8::Value>> = states
        .iter()
        .map(|s| match s {
            PersistedState::None => v8::null(scope).into(),
            PersistedState::Value(v) => crate::dom::utf16_value(scope, v),
            PersistedState::Checked(on) => v8::Boolean::new(scope, *on).into(),
            PersistedState::Selected(values) => {
                let values: Vec<v8::Local<v8::Value>> = values.iter().map(|v| crate::dom::utf16_value(scope, v)).collect();
                v8::Array::new_with_elements(scope, &values).into()
            }
        })
        .collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.restoreSelected(selectNid, values) -> the options whose selectedness changed (`restore_selected`).
fn restore_selected(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(select) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let values: Vec<Vec<u16>> = match v8::Local::<v8::Array>::try_from(args.get(1)) {
        Ok(list) => (0..list.length()).filter_map(|i| list.get_index(scope, i).map(|v| crate::dom::utf16_arg(scope, v))).collect(),
        Err(_) => Vec::new(),
    };
    let changed = realm(scope, cid).restore_selected(select, &values);
    rv.set(crate::dom::nodes_value(scope, cid, &changed));
}
