// The sheet an owner has — an HTML or SVG `<style>`, an HTML `<link>` — is a new one each time HTML says it obtains one:
// a style block updated (its children or their text changed, HTML "update a style block"), the owner inserted or removed
// (it is then in another document, or none), and the attribute changes that select its resource. Each owner counts the
// sheets it has had (`NodeData::sheet_gen`); the bindings make the CSSOM sheet of the one it counts now, and a sheet of
// one before has no owner node (CSSOM: the old sheet is removed from the document). The tree changes are counted here, as
// the edges are written, by whatever path writes them; the attribute changes by the bindings' change steps (`renewSheet`).

use web_atoms::ns;

use crate::dom::{nid_arg, NodeData, NodeId, NodeKind, RealmArena};

#[derive(Default)]
pub(crate) struct SheetOwners {
    // The buffer every realm's bindings share (`sheetsHeld`, a view each, read and written with no call): [0] whether a
    // script has ever been handed an owner's sheet, which the bindings set — before one has, an owner deep in an inserted
    // or removed subtree need not be looked for: a sheet nobody holds is the same sheet again — and [1] whether such a
    // deep owner obtained a new sheet since the bindings last asked, which they clear.
    flag: Option<v8::SharedRef<v8::BackingStore>>,
}

impl SheetOwners {
    fn held(&self) -> bool {
        self.flag.as_ref().is_some_and(|f| f[0].get() != 0)
    }
    fn note_deep_renewal(&self) {
        if let Some(flag) = &self.flag {
            flag[1].set(1);
        }
    }
}

// An element that owns a style sheet: an HTML or SVG `<style>`, an HTML `<link>` (the cascade's list of them too,
// collections.rs `SheetOwners`).
pub(crate) fn is_sheet_owner(n: &NodeData) -> bool {
    n.kind == NodeKind::Element
        && match &*n.local_name {
            "style" => n.ns == ns!(html) || n.ns == ns!(svg),
            "link" => n.ns == ns!(html),
            _ => false,
        }
}

impl RealmArena {
    // The owner obtains a new sheet. (Quietly: which sheet it has is no input to the arena's memos, nor to a layout.)
    pub(crate) fn renew_sheet(&mut self, id: NodeId) {
        if let Some(n) = self.get_mut_quietly(id).filter(|n| is_sheet_owner(n)) {
            n.sheet_gen = n.sheet_gen.wrapping_add(1);
        }
    }

    // `nodes` were inserted into `parent` or removed from it: each owner among them obtains a new sheet — and each among
    // their descendants, once a script holds any sheet — and so does `parent`, a style element whose block changed.
    pub(crate) fn sheet_owners_moved(&mut self, parent: NodeId, nodes: &[NodeId]) {
        self.style_block_changed(parent);
        let deep = self.sheet_owners.held();
        for &node in nodes {
            let Some(n) = self.get(node) else { continue };
            if is_sheet_owner(n) {
                self.renew_sheet(node);
            } else if deep && !n.children.is_empty() {
                let mut stack: Vec<NodeId> = n.children.clone();
                let mut renewed = false;
                while let Some(id) = stack.pop() {
                    let Some(d) = self.get(id) else { continue };
                    if is_sheet_owner(d) {
                        renewed = true;
                        self.renew_sheet(id);
                    } else {
                        stack.extend(d.children.iter().copied());
                    }
                }
                if renewed {
                    self.sheet_owners.note_deep_renewal();
                }
            }
        }
    }

    // `parent`'s children or their text changed: a style element's block is updated.
    pub(crate) fn style_block_changed(&mut self, parent: NodeId) {
        if self.get(parent).is_some_and(|n| &*n.local_name == "style") {
            self.renew_sheet(parent);
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "sheetGen", sheet_gen_op, context_id);
    crate::dom::register(scope, ns, "renewSheet", renew_sheet_op, context_id);
    // (…and the flags, a view on the isolate's one buffer)
    let store = crate::dom::dom(scope)
        .arena
        .sheet_owners
        .flag
        .get_or_insert_with(|| v8::ArrayBuffer::new_backing_store_from_vec(vec![0u8, 0]).make_shared())
        .clone();
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
    if let (Some(view), Some(key)) = (v8::Uint8Array::new(scope, buffer, 0, 2), v8::String::new(scope, "sheetsHeld")) {
        ns.set(scope, key.into(), view.into());
    }
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
