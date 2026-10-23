// HTML's post-connection steps, as an inserted subtree is connected (dom-nodes.js / bridge.entry.js `fireCEConnect`):
// which of its elements have one — a script to prepare, a frame's browsing context, a stylesheet's load, an option's
// selectedness, a media element's resource, a `nonce` to hide, a custom element to upgrade or call back — so the
// bindings run each step for those and walk none of the rest.

use web_atoms::ns;
use crate::dom::{nid_arg, realm_id, NodeData, NodeId, NodeKind, RealmArena, STATE_UPGRADED};

// What connecting an element runs (`connection_steps`), a bit each: an option's selectedness initialised, a select's
// run once its options are, an open dialog back on its document's open dialogs list (its removing steps took it off), a
// `<selectedcontent>` filled from its select, a media or plugin element's resource and an SVG `<use>`'s external
// document fetched, a script prepared, a `<link>`'s resource obtained and a `<style>`'s sheet loaded, a `<source>`'s
// media element told of it, a frame's browsing context made, a `<meta http-equiv=default-style>`'s stylesheet set
// chosen, a `<meta name="referrer">`'s policy set (url_ops.rs `meta_referrer_steps`), a `nonce` hidden (nonce.rs), a
// custom element upgraded or called back. Each is an element of its exact local
// name in its own namespace — HTML's, a `<use>` SVG's, a `<script>` or `<style>` either — as Chrome fires no `load` for
// a MathML `<style>` or an HTML `STYLE`.
pub(crate) const CONNECT_OPTION: u32 = 1;
pub(crate) const CONNECT_SELECT: u32 = 1 << 1;
pub(crate) const CONNECT_DIALOG: u32 = 1 << 2;
pub(crate) const CONNECT_SELECTEDCONTENT: u32 = 1 << 3;
pub(crate) const CONNECT_MEDIA: u32 = 1 << 4;
pub(crate) const CONNECT_USE: u32 = 1 << 5;
pub(crate) const CONNECT_SCRIPT: u32 = 1 << 6;
pub(crate) const CONNECT_LINK: u32 = 1 << 7;
pub(crate) const CONNECT_STYLE: u32 = 1 << 8;
pub(crate) const CONNECT_SOURCE: u32 = 1 << 10;
pub(crate) const CONNECT_FRAME: u32 = 1 << 11;
pub(crate) const CONNECT_DEFAULT_STYLE: u32 = 1 << 12;
pub(crate) const CONNECT_NONCE: u32 = 1 << 13;
pub(crate) const CONNECT_CUSTOM: u32 = 1 << 14;
pub(crate) const CONNECT_META_REFERRER: u32 = 1 << 15;

// What connecting `n` runs (`CONNECT_*`); none for a node that is no element.
pub(crate) fn connection_steps(n: &NodeData) -> u32 {
    if n.kind != NodeKind::Element {
        return 0;
    }
    let name: &str = &n.local_name;
    let html = n.ns == ns!(html);
    let flag = |on: bool, step: u32| if on { step } else { 0 };
    let tag = match name {
        _ if crate::attributes::is_script(n) => CONNECT_SCRIPT,
        "style" if html || n.ns == ns!(svg) => CONNECT_STYLE,
        "use" if n.ns == ns!(svg) => CONNECT_USE,
        _ if !html => 0,
        "option" => CONNECT_OPTION,
        "select" => CONNECT_SELECT,
        "dialog" if n.plain_attr("open").is_some() => CONNECT_DIALOG,
        "selectedcontent" => CONNECT_SELECTEDCONTENT,
        "video" | "audio" | "embed" | "object" => CONNECT_MEDIA,
        "link" => CONNECT_LINK,
        "source" => CONNECT_SOURCE,
        "iframe" | "frame" => CONNECT_FRAME,
        "meta" => {
            flag(n.plain_attr("http-equiv").is_some_and(|v| v.eq_ignore_ascii_case("default-style")), CONNECT_DEFAULT_STYLE)
                | flag(crate::url_ops::names_referrer(n), CONNECT_META_REFERRER)
        }
        _ => 0,
    };
    // (…a valid custom element name has a hyphen; a customized built-in an `is` value)
    let custom = name.contains('-') || n.is_value.is_some() || n.state & STATE_UPGRADED != 0 || n.plain_attr("is").is_some();
    tag | flag(crate::nonce::hides_nonce(n), CONNECT_NONCE) | flag(custom, CONNECT_CUSTOM)
}
// …whether it runs any.
pub(crate) fn has_connection_step(n: &NodeData) -> bool {
    connection_steps(n) != 0
}

impl RealmArena {
    // The elements of `root`'s shadow-including subtree with a connection step, in shadow-including tree order.
    pub(crate) fn connection_step_elements(&self, root: NodeId) -> Vec<NodeId> {
        self.shadow_including_elements(root, has_connection_step)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "connectionStepElements", connection_step_elements, context_id);
    crate::dom::register_fast(scope, ns, "connectionSteps", connection_steps_op, CONNECTION_STEPS_FAST, context_id);
}

// __dom.connectionStepElements(rootNid) -> the elements of its subtree with a connection step
// (`connection_step_elements`), as `nodes_value` answers.
fn connection_step_elements(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let ids = crate::dom::realm(scope, cid).connection_step_elements(root);
    rv.set(crate::dom::nodes_value(scope, cid, &ids));
}

// __dom.connectionSteps(nid) -> what connecting the element runs (`CONNECT_*`) — a fast call, asked of each element a
// connection walk or the parser connects.
fn connection_steps_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let steps = nid_arg(scope, &args, 0).and_then(|id| crate::dom::dom(scope).arena.get(id).map(connection_steps));
    rv.set_uint32(steps.unwrap_or(0));
}
fn connection_steps_fast(_receiver: v8::Local<v8::Value>, nid: f64, options: *mut v8::fast_api::FastApiCallbackOptions) -> u32 {
    let id = if nid >= 0.0 { NodeId::from_i64(nid as i64) } else { None };
    crate::dom::fast_dom(options).and_then(|d| d.arena.get(id?)).map_or(0, connection_steps)
}
const CONNECTION_STEPS_FAST: &[v8::fast_api::CFunction] = &[v8::fast_api::CFunction::new(
    connection_steps_fast as _,
    &v8::fast_api::CFunctionInfo::new(
        v8::fast_api::Type::Uint32.as_info(),
        &[v8::fast_api::Type::V8Value.as_info(), v8::fast_api::Type::Float64.as_info(), v8::fast_api::Type::CallbackOptions.as_info()],
        v8::fast_api::Int64Representation::Number,
    ),
)];
