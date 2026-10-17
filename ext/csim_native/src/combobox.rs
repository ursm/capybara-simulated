// Customizable-combobox filtering (open-ui, tentative): an `<input filter=ID>` filters the `<select id=ID>`'s options,
// an `<input list=ID>` the `<datalist id=ID>`'s, against its value — an option whose text, trimmed, does not start with
// the value (both lowercased) is `:filtered`, which the UA sheet's `option:filtered { display: none }` hides. The
// bindings fire the cancelable `beforefilter` between finding the list and filtering it.

use crate::dom::{nid_arg, node_value, realm, realm_id, NodeId, RealmArena, GEN_STYLE_STATE, STATE_FILTERED};

impl RealmArena {
    // The `<select>` or `<datalist>` a combobox `<input>` names: the element of its tree whose ID its `filter`
    // attribute is, else its `list` — None for neither, nor for an element of another kind.
    pub(crate) fn combobox_list(&self, input: NodeId) -> Option<NodeId> {
        let n = self.get(input)?;
        let id = n.plain_attr_units("filter").or_else(|| n.plain_attr_units("list"))?;
        let list = self.element_by_id(self.root_of(input), &id)?;
        self.get(list).filter(|l| l.is_html_named("select") || l.is_html_named("datalist")).map(|_| list)
    }
    // `list`'s options filtered by `input`'s value — a select's list of options, a datalist's descendant options — the
    // style state moved where any one's `:filtered` did (a cascade input no attribute stands behind).
    pub(crate) fn filter_combobox(&mut self, input: NodeId, list: NodeId) {
        let Some(l) = self.get(list) else { return };
        let options = if l.is_html_named("select") { self.list_of_options(list) } else { self.descendant_options(list) };
        let needle = self.get(input).map_or_else(String::new, |n| String::from_utf16_lossy(&self.relevant_value(n)).to_lowercase());
        let mut moved = false;
        for option in options {
            let text = String::from_utf16_lossy(&self.text_content(option));
            let filtered = !needle.is_empty() && !text.trim().to_lowercase().starts_with(&needle);
            let had = self.get(option).map_or(0, |o| o.state);
            let next = if filtered { had | STATE_FILTERED } else { had & !STATE_FILTERED };
            if next != had {
                self.set_state(option, next);
                moved = true;
            }
        }
        if moved {
            self.generations.bump(GEN_STYLE_STATE);
        }
    }
    fn descendant_options(&self, root: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut stack: Vec<NodeId> = self.get(root).map_or_else(Vec::new, |n| n.children.iter().rev().copied().collect());
        while let Some(c) = stack.pop() {
            let Some(n) = self.get(c) else { continue };
            if n.is_html_named("option") {
                out.push(c);
            }
            stack.extend(n.children.iter().rev());
        }
        out
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "comboboxList", combobox_list_op, context_id);
    crate::dom::register(scope, ns, "filterCombobox", filter_combobox_op, context_id);
}
// __dom.comboboxList(inputNid) -> the list it filters (`combobox_list`), or null.
fn combobox_list_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let list = nid_arg(scope, &args, 0).and_then(|input| realm(scope, cid).combobox_list(input));
    let list = node_value(scope, list);
    rv.set(list);
}
// __dom.filterCombobox(inputNid, listNid) — `filter_combobox`.
fn filter_combobox_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(input), Some(list)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return };
    let cid = realm_id(scope, &args);
    realm(scope, cid).filter_combobox(input, list);
}
