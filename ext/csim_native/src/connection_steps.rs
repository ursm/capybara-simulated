// HTML's post-connection steps, as an inserted subtree is connected (dom-nodes.js / bridge.entry.js `fireCEConnect`):
// which of its elements have one — a script to prepare, a frame's browsing context, a stylesheet's load, an option's
// selectedness, a media element's resource, a `nonce` to hide, a custom element to upgrade or call back — so the
// bindings run each step for those and walk none of the rest.

use crate::dom::{nid_arg, realm_id, NodeData, NodeId, RealmArena, STATE_UPGRADED};

// The elements whose local name (ASCII-lowercased, in any namespace — the steps tell an SVG `<script>` or `<use>` by
// it) gives them a connection step.
const STEP_TAGS: [&str; 15] = [
    "option", "select", "selectedcontent", "video", "audio", "embed", "object", "use", "script", "link", "style", "source",
    "iframe", "frame", "meta",
];

// Whether connecting `n` runs a step of its own: a tag that has one; a `nonce` to hide; an inline style with a `url()`,
// which a controlled document fetches; a custom element or a customized built-in to upgrade (a valid custom element
// name has a hyphen; a built-in an `is` value), or one an upgrade was tried on, to call back.
pub(crate) fn has_connection_step(n: &NodeData) -> bool {
    let name: &str = &n.local_name;
    STEP_TAGS.iter().any(|t| name.eq_ignore_ascii_case(t))
        || name.contains('-')
        || n.is_value.is_some()
        || n.state & STATE_UPGRADED != 0
        || n.plain_attr("is").is_some()
        || n.plain_attr("nonce").is_some_and(|v| !v.is_empty())
        || n.plain_attr("style").is_some_and(|v| v.contains("url("))
}

impl RealmArena {
    // The elements of `root`'s shadow-including subtree with a connection step, in shadow-including tree order.
    pub(crate) fn connection_step_elements(&self, root: NodeId) -> Vec<NodeId> {
        self.shadow_including_elements(root, has_connection_step)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "connectionStepElements", connection_step_elements, context_id);
    crate::dom::register_fast(scope, ns, "hasConnectionStep", has_connection_step_op, HAS_CONNECTION_STEP_FAST, context_id);
}

// __dom.connectionStepElements(rootNid) -> the elements of its subtree with a connection step
// (`connection_step_elements`), as `nodes_value` answers.
fn connection_step_elements(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let ids = crate::dom::realm(scope, cid).connection_step_elements(root);
    rv.set(crate::dom::nodes_value(scope, cid, root, &ids));
}

// __dom.hasConnectionStep(nid) -> whether connecting the element runs a step of its own (`has_connection_step`) — a
// fast call, asked of each element the parser connects.
fn has_connection_step_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let step = nid_arg(scope, &args, 0).and_then(|id| crate::dom::dom(scope).arena.get(id).map(has_connection_step));
    rv.set_bool(step.unwrap_or(false));
}
fn has_connection_step_fast(_receiver: v8::Local<v8::Value>, nid: f64, options: *mut v8::fast_api::FastApiCallbackOptions) -> bool {
    let id = if nid >= 0.0 { NodeId::from_i64(nid as i64) } else { None };
    crate::dom::fast_dom(options).and_then(|d| d.arena.get(id?)).is_some_and(has_connection_step)
}
const HAS_CONNECTION_STEP_FAST: &[v8::fast_api::CFunction] = &[v8::fast_api::CFunction::new(
    has_connection_step_fast as _,
    &v8::fast_api::CFunctionInfo::new(
        v8::fast_api::Type::Bool.as_info(),
        &[v8::fast_api::Type::V8Value.as_info(), v8::fast_api::Type::Float64.as_info(), v8::fast_api::Type::CallbackOptions.as_info()],
        v8::fast_api::Int64Representation::Number,
    ),
)];
