// A `<select>`'s `<selectedcontent>` elements (HTML "update a select's selectedcontent"): each a snapshot of the select's
// selected option's content — every selected option's, each in a `<div>`, for a multiple select — its children replaced
// by clones of it, in one change. A snapshot: it follows the option's content only when the selection settles or the
// `<selectedcontent>` (re)connects, which the bindings decide; an update that would leave one as it is leaves it alone
// (no record), unless `force`d — a re-insertion, which re-clones (selectedcontent-mutations).

use crate::cloning::{clonable, BindingsSteps};
use crate::dom::{realm, realm_id, NodeId, RealmArena};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "updateSelectedContent", update_selected_content, context_id);
}

// The `<selectedcontent>` elements of `select`, in tree order.
fn selected_contents(arena: &RealmArena, select: NodeId) -> Vec<NodeId> {
    let mut found = Vec::new();
    let mut stack: Vec<NodeId> = arena.get(select).map_or_else(Vec::new, |n| n.children.iter().rev().copied().collect());
    while let Some(id) = stack.pop() {
        let Some(n) = arena.get(id) else { continue };
        if n.is_html_named("selectedcontent") {
            found.push(id);
        }
        stack.extend(n.children.iter().rev());
    }
    found
}

// __dom.updateSelectedContent(selectNid, force, steps) -> `[copies, copies…, changes…]` as `editInsert` answers them;
// undefined where it changed nothing, null where the engine does not clone the content (a shadow host in it — the
// bindings' to then, as `cloneNode`'s).
fn update_selected_content(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(select) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let force = args.get(1).is_true();
    let Ok(steps) = v8::Local::<v8::Array>::try_from(args.get(2)) else { return };
    let caller = realm_id(scope, &args);
    let Some(cid) = crate::dom::dom(scope).arena.get(select).map(|n| n.realm) else { return };
    let arena = realm(scope, cid);
    let targets = selected_contents(arena, select);
    if targets.is_empty() {
        return;
    }
    let multiple = arena.get(select).is_some_and(|n| n.plain_attr("multiple").is_some());
    let options: Vec<NodeId> = arena.selected_options(select, !multiple).into_iter().map(|(_, o)| o).collect();
    let sources: Vec<Vec<NodeId>> = options.iter().map(|&o| arena.get(o).map_or_else(Vec::new, |n| n.children.clone())).collect();
    if !sources.iter().flatten().all(|&c| clonable(arena, c, true)) {
        return rv.set_null();
    }
    // (…what one shows when it is as it should be: the content serialized, each option's in a `<div>` for a multiple
    // select)
    let units = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
    let mut want = Vec::new();
    for &o in &options {
        if multiple {
            want.extend(units("<div>"));
        }
        want.extend(crate::serialize::html(arena, o, false, &[]));
        if multiple {
            want.extend(units("</div>"));
        }
    }
    let steps = v8::Local::new(scope, steps);
    let (mut changes, mut copies, mut held): (Vec<crate::mutation::Change>, BindingsSteps, Vec<_>) = (Vec::new(), Vec::new(), Vec::new());
    for target in targets {
        // (…one an outer one's replacement took out, which the content model forbids anyway, skipped)
        let arena = realm(scope, cid);
        if arena.get(target).is_none_or(|n| n.parent.is_none()) || (!force && crate::serialize::html(arena, target, false, &[]) == want) {
            continue;
        }
        let doc = crate::editing::document_of(scope, target);
        let mut clones = Vec::new();
        for kids in &sources {
            let parent = if multiple {
                let (div, hold) = crate::editing::make_element(scope, cid, caller, target, "div");
                held.push(hold);
                clones.push(div);
                Some(div)
            } else {
                None
            };
            for &c in kids {
                let Some(copy) = crate::cloning::clone_into(scope, cid, caller, c, parent, true, doc, &mut held, &mut copies) else { return };
                if parent.is_none() {
                    clones.push(copy);
                }
            }
        }
        let Some(change) = crate::mutation::replace_all(scope, cid, caller, target, &clones, steps) else { return };
        changes.push(change);
    }
    if changes.is_empty() {
        return;
    }
    let mut out: Vec<v8::Local<'_, v8::Value>> = vec![v8::Integer::new_from_unsigned(scope, copies.len() as u32).into()];
    out.extend(crate::cloning::bindings_value(scope, cid, &copies));
    out.extend(crate::mutation::changes_value(scope, cid, &changes));
    if crate::dom::factory_threw(scope) {
        return;
    }
    drop(held);
    rv.set(v8::Array::new_with_elements(scope, &out).into());
}
