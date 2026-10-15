// A document's pending scroll event targets and pending scrollend event targets (CSSOM View §17, "Scrolling events"):
// each box scrolled since the document's last "run the scroll steps" — the document itself for its viewport — in the
// order first scrolled, each once however many times it moved; the rendering update takes them, firing `scroll` (and
// then `scrollend`) at each. A document's own, which a box of another document is never in.

use std::collections::HashMap;

use crate::dom::{nid_arg, realm_id, NodeId, RealmArena};

#[derive(Default)]
pub(crate) struct PendingScrollEvents(HashMap<NodeId, [Vec<NodeId>; 2]>);

impl RealmArena {
    // `target` scrolled in `doc` (`end`: settled, for its scrollend).
    pub(crate) fn queue_scroll_event(&mut self, doc: NodeId, target: NodeId, end: bool) {
        let list = &mut self.pending_scroll_events.0.entry(doc).or_default()[end as usize];
        if !list.contains(&target) {
            list.push(target);
        }
    }
    pub(crate) fn take_scroll_events(&mut self, doc: NodeId, end: bool) -> Vec<NodeId> {
        self.pending_scroll_events.0.get_mut(&doc).map(|lists| std::mem::take(&mut lists[end as usize])).unwrap_or_default()
    }
    // …and those of documents freed with their realm let go of.
    pub(crate) fn forget_freed_scroll_events(&mut self) {
        let freed: Vec<NodeId> = self.pending_scroll_events.0.keys().copied().filter(|&d| self.get(d).is_none()).collect();
        for doc in freed {
            self.pending_scroll_events.0.remove(&doc);
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "queueScrollEvent", queue_scroll_event, context_id);
    crate::dom::register(scope, ns, "takeScrollEvents", take_scroll_events, context_id);
}

// __dom.queueScrollEvent(docNid, targetNid, end) — the target (the document, for its viewport) scrolled: one of the
// document's pending scroll (`end`: scrollend) event targets.
fn queue_scroll_event(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(doc), Some(target)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return };
    let end = args.get(2).is_true();
    let cid = realm_id(scope, &args);
    crate::dom::realm(scope, cid).queue_scroll_event(doc, target, end);
}

// __dom.takeScrollEvents(docNid, end) -> the document's pending scroll (`end`: scrollend) event targets, in order, as
// `nodes_value` answers — none pending after.
fn take_scroll_events(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let end = args.get(1).is_true();
    let cid = realm_id(scope, &args);
    let targets = crate::dom::realm(scope, cid).take_scroll_events(doc, end);
    rv.set(crate::dom::nodes_value(scope, cid, &targets));
}
