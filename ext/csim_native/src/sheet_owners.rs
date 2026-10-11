// The sheet an owner has — an HTML or SVG `<style>`, an HTML `<link>`, an `<?xml-stylesheet?>` — is a new one each time
// HTML says it obtains one: its style block updated (its children or their text changed, "update a style block"), the
// owner inserted or removed (it is then in another document, or none), and the attribute changes that select its
// resource. Each owner counts the sheets it has had (`NodeData::sheet_gen`); the bindings make the CSSOM sheet of the one
// it counts now, and one of a count before has no owner node (CSSOM: the old sheet is removed from the document), and
// its `@font-face` rules are new FontFaces. The tree changes are counted here, as the edges are written, by whatever path
// writes them; the attribute changes by the bindings' change steps (`renewSheet`).

use web_atoms::ns;

use crate::dom::{nid_arg, NodeData, NodeId, NodeKind, RealmArena};

// A node that owns a style sheet: an HTML or SVG `<style>`, an HTML `<link>` (the elements of the cascade's list of them,
// collections.rs `SheetOwners`), an `<?xml-stylesheet?>`.
pub(crate) fn is_sheet_owner(n: &NodeData) -> bool {
    match n.kind {
        NodeKind::Element => match &*n.local_name {
            "style" => n.ns == ns!(html) || n.ns == ns!(svg),
            "link" => n.ns == ns!(html),
            _ => false,
        },
        NodeKind::ProcessingInstruction => &*n.local_name == "xml-stylesheet",
        _ => false,
    }
}

impl RealmArena {
    // The owner obtains a new sheet. (Quietly: which sheet it has is no input to the arena's memos, nor to a layout.)
    pub(crate) fn renew_sheet(&mut self, id: NodeId) -> bool {
        let Some(n) = self.get_mut_quietly(id).filter(|n| is_sheet_owner(n)) else { return false };
        n.sheet_gen = n.sheet_gen.wrapping_add(1);
        true
    }

    // `nodes` were inserted into `parent` or removed from it: every owner among their shadow-including inclusive
    // descendants obtains a new sheet, and so does `parent`, a style element whose block changed.
    pub(crate) fn sheet_owners_moved(&mut self, parent: NodeId, nodes: &[NodeId]) {
        let mut renewed = self.style_block_changed(parent);
        let mut stack: Vec<NodeId> = nodes.to_vec();
        while let Some(id) = stack.pop() {
            let Some(n) = self.get(id) else { continue };
            stack.extend(n.children.iter().copied());
            stack.extend(n.shadow_root);
            renewed |= self.renew_sheet(id);
        }
        if renewed {
            self.sheet_renewals.bump();
        }
    }

    // `parent`'s children or their text changed: a style element's block is updated.
    pub(crate) fn style_block_changed(&mut self, parent: NodeId) -> bool {
        self.get(parent).is_some_and(|n| &*n.local_name == "style") && self.renew_sheet(parent)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "sheetGen", sheet_gen_op, context_id);
    crate::dom::register(scope, ns, "renewSheet", renew_sheet_op, context_id);
    // (…and how many tree changes renewed one: `RealmArena::sheet_renewals`)
    let renewals = crate::dom::dom(scope).arena.sheet_renewals.store();
    crate::dom::view_counter(scope, ns, "sheetRenewals", renewals);
}

// __dom.sheetGen(nid) -> how many sheets the owner has had (`NodeData::sheet_gen`): its sheet is the one of this count.
fn sheet_gen_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    rv.set_uint32(crate::dom::dom(scope).arena.get(id).map_or(0, |n| n.sheet_gen));
}

// __dom.renewSheet(nid): an attribute change of the owner's obtains it a new sheet.
fn renew_sheet_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    crate::dom::dom(scope).arena.renew_sheet(id);
}
