// Native DOM (Stage 2): the node arena + per-instance V8 binding.
//
// This is the load-bearing core of the DOM-in-Rust rewrite. It lives in
// capybara-simulated's OWN native extension (not in rusty_racer, which stays a
// pure V8 binding). rusty_racer is linked as a library and exposes one generic
// seam — set_realm_init_hook — which calls `install` in every realm. The DOM's
// state lives in the isolate's OWN typed slot (`Dom`, reached via `dom(scope)`),
// keyed by TypeId independently of rusty_racer's internal IsolateState.
//
// The document tree lives in THIS Rust structure, and app JS touches it through
// native-backed V8 objects: ObjectTemplates whose accessors, methods and
// interceptors read the arena directly in a C callback — no GVL, no host-fn
// marshalling, the Blink/Deno binding shape.
//
// What is proven so far:
//   - slice 1: per-instance binding — NodeId in internal field 0, shared arena,
//     reflected-string reads (~21 ns hardcoded probe → ~35 ns real).
//   - slice 2: the tree + WRAPPER IDENTITY (each node caches its ONE JS object, so
//     el.parentNode === parent and childNodes[i] === child) + childNodes as a
//     native NodeList via an INDEXED interceptor.
//   - slice 2b (here): the remaining binding primitives —
//       * a generic attribute model (className/id reflect the class/id attributes,
//         not dedicated fields — no library-shaped shortcut);
//       * reflected-attribute SETTERS (el.className = x) via an accessor setter;
//       * METHODS via FunctionTemplate reading args.this() — getAttribute /
//         setAttribute / appendChild / querySelector / querySelectorAll;
//       * a NAMED interceptor — el.dataset.fooBar <-> the data-foo-bar attribute.
//
// Still to come (slice 3 = integration): text nodes, GC-aware (weak) wrappers, and
// the real question of how this replaces / bridges the JS DOM in bridge.js. Today's
// wrappers are strong Globals — they root every node for the isolate's life, which
// is fine while the arena only grows. The selector matcher here is deliberately
// minimal (tag / #id / .class compounds + descendant combinator); the real cascade
// selector engine is wired at integration.


// One node's data. Attributes are the source of truth (ordered, as the DOM keeps
// them); className/id read and write the "class"/"id" attributes through it.
pub(crate) struct NodeData {
    // tagName as returned to JS (upper-case for HTML). `local_name` is the ASCII-
    // lowercased name the selector engine matches on (tagName vs localName in the DOM).
    pub(crate) tag_name: String,
    pub(crate) local_name: String,
    // Element namespace URL ("" = HTML). Read by the selector engine's namespace matching.
    pub(crate) ns: String,
    pub(crate) attributes: Vec<(String, String)>,
    pub(crate) parent: Option<usize>,
    pub(crate) children: Vec<usize>,
    // Position within `parent.children`, kept current on every link/unlink, so the
    // selector engine's prev/next-sibling nav is O(1) — without it `:nth-child` is
    // O(n²) per query on a wide parent (a 500-sibling list measured 2.5x slower than
    // css-select; O(1) flips it).
    pub(crate) child_index: usize,
    // Whether the node has any text/comment child content — so `:empty` is correct even
    // though the arena is element-only (children holds only elements).
    pub(crate) has_text: bool,
    // The node's one JS object (identity). Strong Global for now — roots every
    // wrapper for the isolate life; weak/GC-aware wrappers are a later slice.
    wrapper: Option<v8::Global<v8::Object>>,
    // The node's one childNodes list (live: re-reads children on each index access).
    child_nodes_wrapper: Option<v8::Global<v8::Object>>,
    // The node's one dataset object (a named-interceptor view over data-* attrs).
    dataset_wrapper: Option<v8::Global<v8::Object>>,
}

impl NodeData {
    pub(crate) fn get_attr(&self, name: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    fn set_attr(&mut self, name: &str, value: String) {
        match self.attributes.iter_mut().find(|(k, _)| k == name) {
            Some(slot) => slot.1 = value,
            None => self.attributes.push((name.to_string(), value)),
        }
    }
}

// The per-isolate DOM: the node arena plus the cached instance templates every
// wrapper is stamped from. Stored in the isolate's own TypeId-keyed slot, reached
// from any callback via dom(scope). Templates are isolate-scoped (one serves every
// realm).
#[derive(Default)]
pub(crate) struct Dom {
    pub(crate) nodes: Vec<NodeData>,
    element_template: Option<v8::Global<v8::ObjectTemplate>>,
    nodelist_template: Option<v8::Global<v8::ObjectTemplate>>,
    dataset_template: Option<v8::Global<v8::ObjectTemplate>>,
}

// Element-tree navigation for the selector engine. The arena is element-only, so
// children/siblings are already element nodes (no text/comment to skip).
impl Dom {
    pub(crate) fn parent_of(&self, idx: usize) -> Option<usize> {
        self.nodes.get(idx).and_then(|n| n.parent)
    }
    pub(crate) fn first_child(&self, idx: usize) -> Option<usize> {
        self.nodes.get(idx).and_then(|n| n.children.first().copied())
    }
    pub(crate) fn prev_sibling(&self, idx: usize) -> Option<usize> {
        let node = self.nodes.get(idx)?;
        let parent = node.parent?;
        let pos = node.child_index.checked_sub(1)?;
        self.nodes.get(parent).and_then(|p| p.children.get(pos).copied())
    }
    pub(crate) fn next_sibling(&self, idx: usize) -> Option<usize> {
        let node = self.nodes.get(idx)?;
        let parent = node.parent?;
        self.nodes
            .get(parent)
            .and_then(|p| p.children.get(node.child_index + 1).copied())
    }
}

// Borrow the isolate's Dom, lazily creating the slot on first touch. rusty_v8
// stores slots in a TypeId->value map, so this `Dom` coexists with rusty_racer's
// own IsolateState slot without either knowing about the other. Used in SHORT
// bursts (the borrow is released before any V8 call), the same discipline
// rusty_racer's istate! macro follows — and, like it, the borrow checker enforces
// it: get_slot_mut borrows the scope, which every V8 call also needs.
fn dom<'s>(scope: &'s mut v8::PinScope<'_, '_>) -> &'s mut Dom {
    if scope.get_slot::<Dom>().is_none() {
        scope.set_slot(Dom::default());
    }
    scope
        .get_slot_mut::<Dom>()
        .expect("Dom slot was just set")
}

// Install globalThis.__dom = { createElement } into |ctx|, building the templates
// on first call. Mirrors install_host_namespace's shape (its own HandleScope +
// ContextScope, safe to re-run per realm). A later slice folds this into the real
// document / Node surface.
pub(crate) fn install(scope: &mut v8::PinScope<'_, '_, ()>, ctx: &v8::Global<v8::Context>) {
    v8::scope!(let scope, &mut *scope);
    let context = v8::Local::new(scope, ctx);
    let scope = &mut v8::ContextScope::new(scope, context);

    ensure_templates(scope);

    let ns = v8::Object::new(scope);
    register(scope, ns, "createElement", create_element);
    // Bulk import + id-level query: the measurement / eventual parse-time population
    // path (build the arena from an already-parsed page and match natively), distinct
    // from createElement's per-node wrapper path.
    register(scope, ns, "importNode", import_node);
    register(scope, ns, "queryIds", query_ids);
    register(scope, ns, "resetArena", reset_arena);
    register(scope, ns, "nowNanos", now_nanos);
    if let Some(key) = v8::String::new(scope, "__dom") {
        let global = context.global(scope);
        global.set(scope, key.into(), ns.into());
    }
}

fn register(
    scope: &mut v8::PinScope<'_, '_>,
    ns: v8::Local<'_, v8::Object>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    if let (Some(f), Some(k)) = (v8::Function::new(scope, callback), v8::String::new(scope, name)) {
        ns.set(scope, k.into(), f.into());
    }
}

// __dom.importNode(tagName, localName, ns, hasText, parentId, attrsFlat) -> nativeId.
// Adds an arena node with NO V8 wrapper — the bulk path that builds the arena from an
// already-parsed document. `attrsFlat` is a flat [name, value, name, value, …] array.
// `parentId` < 0 makes a root; otherwise the node is appended under that parent.
fn import_node(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let tag_name = args.get(0).to_rust_string_lossy(scope);
    let local_name = args.get(1).to_rust_string_lossy(scope);
    let ns = args.get(2).to_rust_string_lossy(scope);
    let has_text = args.get(3).boolean_value(scope);
    let parent = match args.get(4).integer_value(scope) {
        Some(p) if p >= 0 => Some(p as usize),
        _ => None,
    };
    let mut attributes = Vec::new();
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(args.get(5)) {
        let len = arr.length();
        let mut i = 0;
        while i + 1 < len {
            let name = arr.get_index(scope, i).map(|v| v.to_rust_string_lossy(scope));
            let value = arr.get_index(scope, i + 1).map(|v| v.to_rust_string_lossy(scope));
            if let (Some(name), Some(value)) = (name, value) {
                attributes.push((name, value));
            }
            i += 2;
        }
    }
    let st = dom(scope);
    let new_id = st.nodes.len();
    st.nodes.push(NodeData {
        tag_name,
        local_name,
        ns,
        attributes,
        parent,
        children: Vec::new(),
        child_index: 0,
        has_text,
        wrapper: None,
        child_nodes_wrapper: None,
        dataset_wrapper: None,
    });
    if let Some(p) = parent {
        link_child(&mut st.nodes, p, new_id);
    }
    rv.set_uint32(new_id as u32);
}

// __dom.queryIds(rootId, selector) -> [nativeId, …] when native matching answers the selector;
// `undefined` when it needs the JS engine (a live-state selector like `:hover` / `:checked`);
// `null` for an invalid selector. Returns NodeIds (not wrappers) so the query layer can map
// results back to the JS tree cheaply, and lets it distinguish "defer to css-select" (undefined)
// from "SyntaxError" (null) — this is the shape the host-query layer uses.
fn query_ids(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let root = match args.get(0).integer_value(scope) {
        Some(r) if r >= 0 => r as usize,
        _ => return,
    };
    let selector = args.get(1).to_rust_string_lossy(scope);
    match crate::selector::query_text(dom(scope), root, &selector, false) {
        crate::selector::QueryOutcome::Matched(ids) => {
            let array = v8::Array::new(scope, ids.len() as i32);
            for (i, id) in ids.iter().enumerate() {
                let v: v8::Local<v8::Value> = v8::Integer::new_from_unsigned(scope, *id as u32).into();
                array.set_index(scope, i as u32, v);
            }
            rv.set(array.into());
        }
        crate::selector::QueryOutcome::NeedsJsFallback => {
            let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
            rv.set(undef);
        }
        crate::selector::QueryOutcome::Invalid => rv.set_null(),
    }
}

// __dom.resetArena() — drop all arena nodes (and their cached wrappers). For the
// measurement harness, which rebuilds the arena per page.
fn reset_arena(
    scope: &mut v8::PinScope<'_, '_>,
    _args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    dom(scope).nodes.clear();
}

// __dom.nowNanos() -> a process-monotonic wall time in nanoseconds (as a Number).
// The measurement path times native matching against css-select from INSIDE JS, but
// csim's own clock (Date.now / performance.now) is the VIRTUAL event-loop clock,
// frozen for the whole of a synchronous JS turn — so it can't separate the two.
// This is a REAL monotonic clock, exposed only for the shadow-measurement harness
// (not a web API). Anchored to the first call so the value stays a small integer that
// an f64 represents exactly (nanos fit exactly below 2^53 ≈ 104 days of uptime).
fn now_nanos(
    scope: &mut v8::PinScope<'_, '_>,
    _args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    static ORIGIN: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let origin = ORIGIN.get_or_init(std::time::Instant::now);
    let ns = origin.elapsed().as_nanos() as f64;
    rv.set(v8::Number::new(scope, ns).into());
}

// Build the element / NodeList / dataset instance templates once per isolate. Each
// reserves internal field 0 for a NodeId (the element's own id; the NodeList's and
// dataset's owner id).
fn ensure_templates(scope: &mut v8::PinScope<'_, '_>) {
    if dom(scope).element_template.is_none() {
        let tmpl = v8::ObjectTemplate::new(scope);
        tmpl.set_internal_field_count(1);
        set_reflected(scope, tmpl, "className", class_name_getter, class_name_setter);
        set_reflected(scope, tmpl, "id", id_getter, id_setter);
        set_reader(scope, tmpl, "tagName", tag_name_getter);
        set_reader(scope, tmpl, "parentNode", parent_node_getter);
        set_reader(scope, tmpl, "childNodes", child_nodes_getter);
        set_reader(scope, tmpl, "dataset", dataset_getter);
        set_method(scope, tmpl, "getAttribute", get_attribute);
        set_method(scope, tmpl, "setAttribute", set_attribute);
        set_method(scope, tmpl, "appendChild", append_child);
        set_method(scope, tmpl, "querySelector", query_selector);
        set_method(scope, tmpl, "querySelectorAll", query_selector_all);
        let global = v8::Global::new(scope, tmpl);
        dom(scope).element_template = Some(global);
    }
    if dom(scope).nodelist_template.is_none() {
        let tmpl = v8::ObjectTemplate::new(scope);
        tmpl.set_internal_field_count(1);
        set_reader(scope, tmpl, "length", nodelist_length_getter);
        tmpl.set_indexed_property_handler(
            v8::IndexedPropertyHandlerConfiguration::new().getter(nodelist_index_getter),
        );
        let global = v8::Global::new(scope, tmpl);
        dom(scope).nodelist_template = Some(global);
    }
    if dom(scope).dataset_template.is_none() {
        let tmpl = v8::ObjectTemplate::new(scope);
        tmpl.set_internal_field_count(1);
        tmpl.set_named_property_handler(
            v8::NamedPropertyHandlerConfiguration::new()
                .getter(dataset_getter_named)
                .setter(dataset_setter_named),
        );
        let global = v8::Global::new(scope, tmpl);
        dom(scope).dataset_template = Some(global);
    }
}

// All IDL members are installed DONT_ENUM: in a real browser they live
// non-enumerably on prototypes, so Object.keys(el) / for...in must not surface
// them. (Prototype placement proper is a slice-3 refinement; DONT_ENUM on the
// instance template blunts the observable difference in the meantime.)
fn set_reader(
    scope: &mut v8::PinScope<'_, '_>,
    tmpl: v8::Local<'_, v8::ObjectTemplate>,
    name: &str,
    getter: impl v8::MapFnTo<v8::AccessorNameGetterCallback>,
) {
    if let Some(key) = v8::String::new(scope, name) {
        tmpl.set_accessor_with_configuration(
            key.into(),
            v8::AccessorConfiguration::new(getter)
                .property_attribute(v8::PropertyAttribute::DONT_ENUM),
        );
    }
}

fn set_reflected(
    scope: &mut v8::PinScope<'_, '_>,
    tmpl: v8::Local<'_, v8::ObjectTemplate>,
    name: &str,
    getter: impl v8::MapFnTo<v8::AccessorNameGetterCallback>,
    setter: impl v8::MapFnTo<v8::AccessorNameSetterCallback>,
) {
    if let Some(key) = v8::String::new(scope, name) {
        tmpl.set_accessor_with_configuration(
            key.into(),
            v8::AccessorConfiguration::new(getter)
                .setter(setter)
                .property_attribute(v8::PropertyAttribute::DONT_ENUM),
        );
    }
}

fn set_method(
    scope: &mut v8::PinScope<'_, '_>,
    tmpl: v8::Local<'_, v8::ObjectTemplate>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let function = v8::FunctionTemplate::new(scope, callback);
    if let Some(key) = v8::String::new(scope, name) {
        tmpl.set_with_attr(key.into(), function.into(), v8::PropertyAttribute::DONT_ENUM);
    }
}

// __dom.createElement(tagName, id, className, parent?) -> a native-backed element.
// id / className are stored as the "id" / "class" attributes (skipped when empty),
// the element is linked under `parent` when one is given, and its (cached) wrapper
// is returned.
fn create_element(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let tag_name = args.get(0).to_rust_string_lossy(scope);
    let id = args.get(1).to_rust_string_lossy(scope);
    let class_name = args.get(2).to_rust_string_lossy(scope);
    let parent = node_id_of(scope, args.get(3));

    let mut attributes = Vec::new();
    if !id.is_empty() {
        attributes.push(("id".to_string(), id));
    }
    if !class_name.is_empty() {
        attributes.push(("class".to_string(), class_name));
    }

    let local_name = tag_name.to_ascii_lowercase();
    let node_id = {
        let st = dom(scope);
        let new_id = st.nodes.len();
        st.nodes.push(NodeData {
            tag_name,
            local_name,
            ns: String::new(),
            attributes,
            parent,
            children: Vec::new(),
            child_index: 0,
            has_text: false,
            wrapper: None,
            child_nodes_wrapper: None,
            dataset_wrapper: None,
        });
        if let Some(p) = parent {
            link_child(&mut st.nodes, p, new_id);
        }
        new_id
    };
    if let Some(obj) = element_wrapper(scope, node_id) {
        rv.set(obj.into());
    }
}

// Append `child` at the end of `parent`'s children, recording its position so
// prev/next-sibling nav is O(1). The one place children are linked (create / import
// / appendChild), so child_index can never drift from the list.
fn link_child(nodes: &mut Vec<NodeData>, parent: usize, child: usize) {
    let pos = match nodes.get(parent) {
        Some(p) => p.children.len(),
        None => return,
    };
    nodes[parent].children.push(child);
    if let Some(c) = nodes.get_mut(child) {
        c.child_index = pos;
    }
}

// The cached wrapper for an element node, created on first request from the element
// template with its NodeId stamped into internal field 0.
fn element_wrapper<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    node_id: usize,
) -> Option<v8::Local<'s, v8::Object>> {
    cached_wrapper(
        scope,
        node_id,
        |node| node.wrapper.clone(),
        |dom| dom.element_template.clone(),
        |node, global| node.wrapper = Some(global),
    )
}

// The cached childNodes list for a node (owner id in internal field 0).
fn node_list_wrapper<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    owner_id: usize,
) -> Option<v8::Local<'s, v8::Object>> {
    cached_wrapper(
        scope,
        owner_id,
        |node| node.child_nodes_wrapper.clone(),
        |dom| dom.nodelist_template.clone(),
        |node, global| node.child_nodes_wrapper = Some(global),
    )
}

// The cached dataset view for a node (owner id in internal field 0).
fn dataset_wrapper<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    owner_id: usize,
) -> Option<v8::Local<'s, v8::Object>> {
    cached_wrapper(
        scope,
        owner_id,
        |node| node.dataset_wrapper.clone(),
        |dom| dom.dataset_template.clone(),
        |node, global| node.dataset_wrapper = Some(global),
    )
}

// Return a node's cached wrapper of some kind, building it from the matching
// template (with the NodeId stamped in) and caching it on first request. One helper
// for all three wrapper kinds so identity + the stamp live in exactly one place.
fn cached_wrapper<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    node_id: usize,
    get_cached: impl Fn(&NodeData) -> Option<v8::Global<v8::Object>>,
    get_template: impl Fn(&Dom) -> Option<v8::Global<v8::ObjectTemplate>>,
    store: impl Fn(&mut NodeData, v8::Global<v8::Object>),
) -> Option<v8::Local<'s, v8::Object>> {
    if let Some(cached) = dom(scope).nodes.get(node_id).and_then(&get_cached) {
        return Some(v8::Local::new(scope, &cached));
    }
    let template = get_template(&*dom(scope))?;
    let template = v8::Local::new(scope, &template);
    let obj = template.new_instance(scope)?;
    let id_value: v8::Local<v8::Value> = v8::Integer::new_from_unsigned(scope, node_id as u32).into();
    obj.set_internal_field(0, id_value.into());
    let global = v8::Global::new(scope, obj);
    if let Some(node) = dom(scope).nodes.get_mut(node_id) {
        store(node, global);
    }
    Some(obj)
}

// ── reflected string attributes (className / id) ────────────────────────────

fn class_name_getter(
    scope: &mut v8::PinScope<'_, '_>,
    _key: v8::Local<'_, v8::Name>,
    args: v8::PropertyCallbackArguments<'_>,
    rv: v8::ReturnValue<'_, v8::Value>,
) {
    reflect_get(scope, &args, rv, "class");
}

fn class_name_setter(
    scope: &mut v8::PinScope<'_, '_>,
    _key: v8::Local<'_, v8::Name>,
    value: v8::Local<'_, v8::Value>,
    args: v8::PropertyCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, ()>,
) {
    reflect_set(scope, &args, value, "class");
}

fn id_getter(
    scope: &mut v8::PinScope<'_, '_>,
    _key: v8::Local<'_, v8::Name>,
    args: v8::PropertyCallbackArguments<'_>,
    rv: v8::ReturnValue<'_, v8::Value>,
) {
    reflect_get(scope, &args, rv, "id");
}

fn id_setter(
    scope: &mut v8::PinScope<'_, '_>,
    _key: v8::Local<'_, v8::Name>,
    value: v8::Local<'_, v8::Value>,
    args: v8::PropertyCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, ()>,
) {
    reflect_set(scope, &args, value, "id");
}

fn tag_name_getter(
    scope: &mut v8::PinScope<'_, '_>,
    _key: v8::Local<'_, v8::Name>,
    args: v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = holder_node_id(scope, &args) else {
        return;
    };
    let tag = dom(scope).nodes.get(id).map(|n| n.tag_name.clone());
    if let Some(tag) = tag
        && let Some(js) = v8::String::new(scope, &tag)
    {
        rv.set(js.into());
    }
}

// A reflected IDL string attribute reads "" (not undefined) when the content
// attribute is absent, matching className / id.
fn reflect_get(
    scope: &mut v8::PinScope<'_, '_>,
    args: &v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
    attr: &str,
) {
    let Some(id) = holder_node_id(scope, args) else {
        return;
    };
    let value = {
        let st = dom(scope);
        st.nodes
            .get(id)
            .map(|n| n.get_attr(attr).unwrap_or("").to_string())
            .unwrap_or_default()
    };
    if let Some(js) = v8::String::new(scope, &value) {
        rv.set(js.into());
    }
}

fn reflect_set(
    scope: &mut v8::PinScope<'_, '_>,
    args: &v8::PropertyCallbackArguments<'_>,
    value: v8::Local<'_, v8::Value>,
    attr: &str,
) {
    let Some(id) = holder_node_id(scope, args) else {
        return;
    };
    let value = value.to_rust_string_lossy(scope);
    if let Some(node) = dom(scope).nodes.get_mut(id) {
        node.set_attr(attr, value);
    }
}

// ── navigation (parentNode / childNodes) ────────────────────────────────────

fn parent_node_getter(
    scope: &mut v8::PinScope<'_, '_>,
    _key: v8::Local<'_, v8::Name>,
    args: v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = holder_node_id(scope, &args) else {
        return;
    };
    let parent = dom(scope).nodes.get(id).and_then(|n| n.parent);
    match parent {
        Some(parent_id) => {
            if let Some(obj) = element_wrapper(scope, parent_id) {
                rv.set(obj.into());
            }
        }
        None => rv.set_null(),
    }
}

fn child_nodes_getter(
    scope: &mut v8::PinScope<'_, '_>,
    _key: v8::Local<'_, v8::Name>,
    args: v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = holder_node_id(scope, &args) else {
        return;
    };
    if let Some(obj) = node_list_wrapper(scope, id) {
        rv.set(obj.into());
    }
}

fn nodelist_length_getter(
    scope: &mut v8::PinScope<'_, '_>,
    _key: v8::Local<'_, v8::Name>,
    args: v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(owner) = holder_node_id(scope, &args) else {
        return;
    };
    let len = dom(scope)
        .nodes
        .get(owner)
        .map(|n| n.children.len())
        .unwrap_or(0);
    rv.set_uint32(len as u32);
}

// list[index] -> the child wrapper, or fall through (kNo) for an out-of-range index
// so `length` and other named props still resolve normally.
fn nodelist_index_getter(
    scope: &mut v8::PinScope<'_, '_>,
    index: u32,
    args: v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) -> v8::Intercepted {
    let Some(owner) = holder_node_id(scope, &args) else {
        return v8::Intercepted::kNo;
    };
    let child = dom(scope)
        .nodes
        .get(owner)
        .and_then(|n| n.children.get(index as usize).copied());
    match child {
        Some(child_id) => match element_wrapper(scope, child_id) {
            Some(obj) => {
                rv.set(obj.into());
                v8::Intercepted::kYes
            }
            None => v8::Intercepted::kNo,
        },
        None => v8::Intercepted::kNo,
    }
}

// ── methods (FunctionTemplate, reading args.this()) ─────────────────────────

fn get_attribute(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = object_node_id(scope, args.this()) else {
        return;
    };
    // HTML lowercases the qualified name on getAttribute / setAttribute.
    let name = args.get(0).to_rust_string_lossy(scope).to_ascii_lowercase();
    let value = {
        let st = dom(scope);
        st.nodes
            .get(id)
            .and_then(|n| n.get_attr(&name).map(str::to_string))
    };
    match value {
        Some(s) => {
            if let Some(js) = v8::String::new(scope, &s) {
                rv.set(js.into());
            }
        }
        None => rv.set_null(),
    }
}

fn set_attribute(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = object_node_id(scope, args.this()) else {
        return;
    };
    // HTML lowercases the qualified name on getAttribute / setAttribute.
    let name = args.get(0).to_rust_string_lossy(scope).to_ascii_lowercase();
    let value = args.get(1).to_rust_string_lossy(scope);
    if let Some(node) = dom(scope).nodes.get_mut(id) {
        node.set_attr(&name, value);
    }
}

// appendChild(child): detach the child from its current parent, re-parent it here,
// and return it. Slice 2b ignores the document-fragment / text-node cases.
//
// A browser throws HierarchyRequestError when the new child is the parent itself
// or an ancestor of it — and here that is not just a spec nicety: an accepted
// cycle would make the selector engine's tree walk / ancestor traversal loop
// forever with no V8 interrupt point, hanging or aborting the isolate. So the
// check is load-bearing. (Thrown as a generic Error naming HierarchyRequestError;
// it becomes a real DOMException once the realm exposes that constructor.)
fn append_child(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(parent) = object_node_id(scope, args.this()) else {
        return;
    };
    let Some(child) = node_id_of(scope, args.get(0)) else {
        return;
    };
    // Reject if `child` is `parent` or one of its ancestors (walking up from
    // `parent` includes `parent` itself, so child == parent is covered).
    let creates_cycle = {
        let st = dom(scope);
        let mut ancestor = Some(parent);
        let mut found = false;
        while let Some(node_id) = ancestor {
            if node_id == child {
                found = true;
                break;
            }
            ancestor = st.nodes.get(node_id).and_then(|n| n.parent);
        }
        found
    };
    if creates_cycle {
        throw_error(
            scope,
            "Failed to execute 'appendChild': The new child is an ancestor of \
             the parent. (HierarchyRequestError)",
        );
        return;
    }
    {
        let st = dom(scope);
        if let Some(old_parent) = st.nodes.get(child).and_then(|n| n.parent) {
            if let Some(old) = st.nodes.get_mut(old_parent) {
                old.children.retain(|&c| c != child);
            }
            // Detaching shifts every later sibling down one — reindex so child_index
            // stays exact (prev/next-sibling nav depends on it).
            reindex_children(&mut st.nodes, old_parent);
        }
        if let Some(node) = st.nodes.get_mut(child) {
            node.parent = Some(parent);
        }
        link_child(&mut st.nodes, parent, child);
    }
    if let Some(obj) = element_wrapper(scope, child) {
        rv.set(obj.into());
    }
}

// Rewrite child_index for every child of `parent` from its list position. Called
// after a removal, which shifts the positions of the siblings that followed.
fn reindex_children(nodes: &mut Vec<NodeData>, parent: usize) {
    let kids: Vec<usize> = match nodes.get(parent) {
        Some(p) => p.children.clone(),
        None => return,
    };
    for (i, &k) in kids.iter().enumerate() {
        if let Some(node) = nodes.get_mut(k) {
            node.child_index = i;
        }
    }
}

fn throw_error(scope: &mut v8::PinScope<'_, '_>, message: &str) {
    if let Some(msg) = v8::String::new(scope, message) {
        let exception = v8::Exception::error(scope, msg);
        scope.throw_exception(exception);
    }
}

fn query_selector(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(root) = object_node_id(scope, args.this()) else {
        return;
    };
    let selector = args.get(0).to_rust_string_lossy(scope);
    // The native element-wrapper probe has no JS engine to defer to, so a live-state selector
    // (NeedsJsFallback) or an invalid one both yield null here. Production state-pseudo handling
    // is on the queryIds → css-select path.
    let first = match crate::selector::query_text(dom(scope), root, &selector, true) {
        crate::selector::QueryOutcome::Matched(ids) => ids.into_iter().next(),
        crate::selector::QueryOutcome::NeedsJsFallback | crate::selector::QueryOutcome::Invalid => None,
    };
    match first {
        Some(id) => {
            if let Some(obj) = element_wrapper(scope, id) {
                rv.set(obj.into());
            }
        }
        None => rv.set_null(),
    }
}

// querySelectorAll returns a plain Array for now (the spec's static NodeList is a
// slice-3 refinement); the point here is a method returning many node wrappers.
fn query_selector_all(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(root) = object_node_id(scope, args.this()) else {
        return;
    };
    let selector = args.get(0).to_rust_string_lossy(scope);
    // Same probe limitation as querySelector: no JS fallback here, so a live-state or invalid
    // selector yields an empty list.
    let found = match crate::selector::query_text(dom(scope), root, &selector, false) {
        crate::selector::QueryOutcome::Matched(ids) => ids,
        crate::selector::QueryOutcome::NeedsJsFallback | crate::selector::QueryOutcome::Invalid => Vec::new(),
    };
    let array = v8::Array::new(scope, found.len() as i32);
    for (i, id) in found.into_iter().enumerate() {
        if let Some(obj) = element_wrapper(scope, id) {
            array.set_index(scope, i as u32, obj.into());
        }
    }
    rv.set(array.into());
}

// ── dataset (named interceptor over data-* attributes) ──────────────────────

fn dataset_getter(
    scope: &mut v8::PinScope<'_, '_>,
    _key: v8::Local<'_, v8::Name>,
    args: v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = holder_node_id(scope, &args) else {
        return;
    };
    if let Some(obj) = dataset_wrapper(scope, id) {
        rv.set(obj.into());
    }
}

// dataset.fooBar -> the data-foo-bar attribute. A non-string key (a Symbol) or a
// missing attribute falls through (kNo) so normal lookup (→ undefined) applies.
fn dataset_getter_named(
    scope: &mut v8::PinScope<'_, '_>,
    key: v8::Local<'_, v8::Name>,
    args: v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) -> v8::Intercepted {
    let Some(owner) = holder_node_id(scope, &args) else {
        return v8::Intercepted::kNo;
    };
    let Some(attr) = data_attr_name(scope, key) else {
        return v8::Intercepted::kNo;
    };
    let value = {
        let st = dom(scope);
        st.nodes
            .get(owner)
            .and_then(|n| n.get_attr(&attr).map(str::to_string))
    };
    match value {
        Some(s) => {
            if let Some(js) = v8::String::new(scope, &s) {
                rv.set(js.into());
            }
            v8::Intercepted::kYes
        }
        None => v8::Intercepted::kNo,
    }
}

fn dataset_setter_named(
    scope: &mut v8::PinScope<'_, '_>,
    key: v8::Local<'_, v8::Name>,
    value: v8::Local<'_, v8::Value>,
    args: v8::PropertyCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, ()>,
) -> v8::Intercepted {
    let Some(owner) = holder_node_id(scope, &args) else {
        return v8::Intercepted::kNo;
    };
    let Some(attr) = data_attr_name(scope, key) else {
        return v8::Intercepted::kNo;
    };
    let value = value.to_rust_string_lossy(scope);
    if let Some(node) = dom(scope).nodes.get_mut(owner) {
        node.set_attr(&attr, value);
    }
    v8::Intercepted::kYes
}

// Map a dataset key to its content-attribute name: fooBar -> data-foo-bar. Returns
// None for a non-string key (Symbol), which the interceptor treats as a miss. The
// full DOMStringMap rules (digit / "-x" edge cases) are left for a later slice.
fn data_attr_name(scope: &mut v8::PinScope<'_, '_>, key: v8::Local<'_, v8::Name>) -> Option<String> {
    let key: v8::Local<v8::Value> = key.into();
    if !key.is_string() {
        return None;
    }
    let key = key.to_rust_string_lossy(scope);
    let mut attr = String::from("data-");
    for ch in key.chars() {
        if ch.is_ascii_uppercase() {
            attr.push('-');
            attr.push(ch.to_ascii_lowercase());
        } else {
            attr.push(ch);
        }
    }
    Some(attr)
}

// ── NodeId plumbing ─────────────────────────────────────────────────────────

// The NodeId stamped into the accessor holder's internal field 0.
fn holder_node_id(
    scope: &mut v8::PinScope<'_, '_>,
    args: &v8::PropertyCallbackArguments<'_>,
) -> Option<usize> {
    object_node_id(scope, args.holder())
}

// The NodeId carried by a native-backed object (internal field 0), or None if the
// value is not such an object (a plain JS value, or one built off-template).
fn node_id_of(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<usize> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok()?;
    if obj.internal_field_count() == 0 {
        return None;
    }
    object_node_id(scope, obj)
}

fn object_node_id(scope: &mut v8::PinScope<'_, '_>, obj: v8::Local<'_, v8::Object>) -> Option<usize> {
    let data = obj.get_internal_field(scope, 0)?;
    let value = v8::Local::<v8::Value>::try_from(data).ok()?;
    Some(value.uint32_value(scope)? as usize)
}
