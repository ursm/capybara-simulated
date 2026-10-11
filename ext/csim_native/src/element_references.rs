// HTML §2.6.1's reflected element references — an `Element` or a `FrozenArray<Element>` IDL attribute reflecting a
// content attribute: ARIA's `aria-activedescendant` and its seven IDREF lists, a button's `commandfor`, a popover
// invoker's `popovertarget`. An element set through the IDL attribute is its "explicitly set attr-element(s)", which
// the content attribute — set to "" as they are — stands for; a write of the content attribute itself forgets them
// (`forget_explicit_elements`, the attribute's change steps). Held by slot, as the spec holds them weakly: one that is
// gone is none. The getter answers the explicitly set ones that are still valid — in a tree that is a
// shadow-including inclusive ancestor of the element's — or the elements the content attribute's IDREFs name in the
// element's own tree.

use std::collections::HashMap;

use crate::dom::{nid_arg, node_value, nodes_value, realm, realm_id, NodeId, NodeKind, RealmArena};

// The content attributes that reflect as element references, by the index the map keys them by.
const ATTRIBUTES: [&str; 10] = [
    "aria-activedescendant",
    "commandfor",
    "popovertarget",
    "aria-controls",
    "aria-describedby",
    "aria-details",
    "aria-errormessage",
    "aria-flowto",
    "aria-labelledby",
    "aria-owns",
];

// The explicitly set attr-elements of each element that has any, by (element, attribute).
pub(crate) type ExplicitElements = HashMap<(NodeId, u8), Vec<NodeId>>;

fn attribute_index(name: &str) -> Option<u8> {
    ATTRIBUTES.iter().position(|&a| a == name).map(|i| i as u8)
}

impl RealmArena {
    // The content attributes `names` were written: what was set of them through the IDL attribute is forgotten.
    pub(crate) fn forget_explicit_elements(&mut self, id: NodeId, names: &[&str]) {
        if self.explicit_elements.is_empty() {
            return;
        }
        for index in names.iter().filter_map(|n| attribute_index(n)) {
            self.explicit_elements.remove(&(id, index));
        }
    }

    // Whether `candidate` is a valid explicitly set reference of `host`: an element whose tree is a shadow-including
    // inclusive ancestor of `host`'s — the same tree, or one reached up through shadow hosts (not one in a shadow tree
    // below, a detached subtree while `host` is connected, another document).
    fn valid_reference(&self, host: NodeId, candidate: NodeId) -> bool {
        if self.get(candidate).is_none_or(|n| n.kind != NodeKind::Element) {
            return false;
        }
        let target = self.root_of(candidate);
        let mut at = Some(host);
        while let Some(node) = at {
            let root = self.root_of(node);
            if root == target {
                return true;
            }
            at = self.get(root).and_then(|r| r.host);
        }
        false
    }

    // The element(s) `host`'s reference attribute `attribute` reflects as: the explicitly set ones still valid, where
    // the content attribute is "" — the IDL setter's — else those its IDREFs (one, or a list split on ASCII white space)
    // name in `host`'s tree, any naming none left out; None where the content attribute is absent (or, one reference,
    // empty).
    fn attr_associated(&self, host: NodeId, attribute: u8, list: bool) -> Option<Vec<NodeId>> {
        let node = self.get(host)?;
        let raw = node.plain_attr_units(ATTRIBUTES[attribute as usize])?;
        if raw.is_empty() {
            if let Some(explicit) = self.explicit_elements.get(&(host, attribute)) {
                let valid: Vec<NodeId> = explicit.iter().copied().filter(|&c| self.valid_reference(host, c)).collect();
                return if list { Some(valid) } else { valid.first().map(|&e| vec![e]) };
            }
            if !list {
                return None;
            }
        }
        let root = self.root_of(host);
        if !list {
            return self.element_by_id(root, &raw).map(|e| vec![e]);
        }
        let ascii_ws = |c: &u16| matches!(*c, 0x09 | 0x0A | 0x0C | 0x0D | 0x20);
        Some(raw.split(ascii_ws).filter(|id| !id.is_empty()).filter_map(|id| self.element_by_id(root, id)).collect())
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "referencedElements", referenced_elements, context_id);
    crate::dom::register(scope, ns, "setReferencedElements", set_referenced_elements, context_id);
}

// __dom.referencedElements(nid, attribute, list) -> the element `attribute` reflects as (null for none), or with `list`
// the elements (`nodes_value`; undefined for none) — `attr_associated`.
fn referenced_elements(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(host) = nid_arg(scope, &args, 0) else { return rv.set_null() };
    let name = args.get(1).to_rust_string_lossy(scope);
    let list = args.get(2).is_true();
    let Some(attribute) = attribute_index(&name) else { return rv.set_null() };
    let cid = realm_id(scope, &args);
    match realm(scope, cid).attr_associated(host, attribute, list) {
        Some(elements) if list => {
            let value = nodes_value(scope, cid, &elements);
            rv.set(value);
        }
        Some(elements) => {
            let value = node_value(scope, elements.first().copied());
            rv.set(value);
        }
        None if list => {}
        None => rv.set_null(),
    }
}

// __dom.setReferencedElements(nid, attribute, elements) — the elements set through the IDL attribute (an array of
// element objects; null forgets them), after the bindings wrote its content attribute.
fn set_referenced_elements(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(host) = nid_arg(scope, &args, 0) else { return };
    let name = args.get(1).to_rust_string_lossy(scope);
    let Some(attribute) = attribute_index(&name) else { return };
    let elements: Option<Vec<NodeId>> = v8::Local::<v8::Array>::try_from(args.get(2)).ok().map(|list| {
        let mut ids = Vec::with_capacity(list.length() as usize);
        for i in 0..list.length() {
            if let Some(id) = list.get_index(scope, i).and_then(|e| crate::node_handle::nid_of(scope, e)) {
                ids.push(id);
            }
        }
        ids
    });
    let map = &mut crate::dom::dom(scope).arena.explicit_elements;
    match elements {
        Some(ids) => map.insert((host, attribute), ids),
        None => map.remove(&(host, attribute)),
    };
}
