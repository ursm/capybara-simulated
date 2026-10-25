// A FontFaceSet as the engine holds it (CSS Font Loading §3): its CSS-connected faces, one per `@font-face` rule its
// document's sheets hold that applies (§2.2), by the rule's identity, connected once per list of them; the faces script
// added to it, in the order they were — its set entries after the CSS-connected ones — each as its FontFace's object and
// its state's (font_face_state.rs); and the generation of what script made it hold, which moves as a face is added or
// deleted or one of its descriptors is rewritten: what a document's face list keys on — on a handle the bindings'
// object wraps (`__dom.FontFaceSetStateBase`) — and its loading cycle: the faces whose fetch it is waiting on, each with
// whether it gave a file, and whether the cycle's task is queued, which make it `loading`. The cycle's tasks, its events
// and its promises are the bindings'; the face's own link to the sets that hold it, font_face_state.rs's.

use std::cell::{Cell, RefCell, UnsafeCell};

use v8::cppgc::{GarbageCollected, Visitor};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (font_face_state.rs' 19).
const TAG: u16 = 20;

// What marks an object as a set's (its internal field 0).
static BRAND: u8 = 0;

// A list of objects a handle holds: a JS array behind one traced reference, replaced whole as the list changes. The
// collector marks concurrently with the main thread (node_handle.rs), so what it reads is V8's own array, written
// through V8's barriers, and the one reference the handle keeps, reset through TracedReference's — never a Rust
// vector the main thread grows or empties as it marks.
pub(crate) struct List(UnsafeCell<v8::TracedReference<v8::Object>>);

impl List {
    pub(crate) fn new() -> List {
        List(UnsafeCell::new(v8::TracedReference::empty()))
    }
    pub(crate) fn trace(&self, visitor: &mut Visitor) {
        // SAFETY: the collector reads the reference as TracedReference's barriers allow; nothing here hands one out.
        visitor.trace(unsafe { &*self.0.get() });
    }
    // Its objects, in order.
    pub(crate) fn get<'s>(&self, scope: &mut v8::PinScope<'s, '_>) -> Vec<v8::Local<'s, v8::Object>> {
        // SAFETY: the main thread; the reference is read, not written.
        let array = unsafe { (*self.0.get()).get(scope) }.and_then(|a| v8::Local::<v8::Array>::try_from(a).ok());
        let Some(array) = array else { return Vec::new() };
        (0..array.length()).filter_map(|k| array.get_index(scope, k).and_then(|v| v8::Local::<v8::Object>::try_from(v).ok())).collect()
    }
    // …made `items`.
    pub(crate) fn set(&self, scope: &mut v8::PinScope<'_, '_>, items: &[v8::Local<'_, v8::Object>]) {
        let values: Vec<v8::Local<v8::Value>> = items.iter().map(|&o| o.into()).collect();
        let array: v8::Local<v8::Object> = v8::Array::new_with_elements(scope, &values).into();
        // SAFETY: the main thread, which alone writes the reference; the assignment runs TracedReference's barrier.
        unsafe { (*self.0.get()).reset(scope, Some(array)) };
    }
}

// A map a handle holds — a FontFace to its state, in the order they were entered — as a JS Map behind one traced
// reference, made when first written: V8's own table, entered and deleted through its barriers (`List`'s reasoning),
// each in constant time, as a set of thousands of added faces needs.
struct Pairs(UnsafeCell<v8::TracedReference<v8::Object>>);

impl Pairs {
    fn new() -> Pairs {
        Pairs(UnsafeCell::new(v8::TracedReference::empty()))
    }
    fn trace(&self, visitor: &mut Visitor) {
        // SAFETY: the collector reads the reference as TracedReference's barriers allow; nothing here hands one out.
        visitor.trace(unsafe { &*self.0.get() });
    }
    fn map<'s>(&self, scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Map> {
        // SAFETY: the main thread; the reference is read here, and written below by the main thread alone, through
        // TracedReference's barrier.
        if let Some(map) = unsafe { (*self.0.get()).get(scope) }.and_then(|m| v8::Local::<v8::Map>::try_from(m).ok()) {
            return map;
        }
        let map = v8::Map::new(scope);
        unsafe { (*self.0.get()).reset(scope, Some(map.into())) };
        map
    }
    fn len(&self, scope: &mut v8::PinScope<'_, '_>) -> usize {
        // SAFETY: as `map`'s read.
        unsafe { (*self.0.get()).get(scope) }.and_then(|m| v8::Local::<v8::Map>::try_from(m).ok()).map_or(0, |m| m.size())
    }
    // Its entries' keys (`values` false) or values (true), in order.
    fn column<'s>(&self, scope: &mut v8::PinScope<'s, '_>, values: bool) -> Vec<v8::Local<'s, v8::Object>> {
        let flat = self.map(scope).as_array(scope);
        (u32::from(values)..flat.length()).step_by(2).filter_map(|k| flat.get_index(scope, k).and_then(|v| v8::Local::<v8::Object>::try_from(v).ok())).collect()
    }
}

// The faces of a list of pairs `[face, state, face, state, …]`.
fn faces_of<'s>(pairs: &[v8::Local<'s, v8::Object>]) -> Vec<v8::Local<'s, v8::Object>> {
    pairs.chunks_exact(2).map(|p| p[0]).collect()
}
fn values<'s>(objects: Vec<v8::Local<'s, v8::Object>>) -> Vec<v8::Local<'s, v8::Value>> {
    objects.into_iter().map(Into::into).collect()
}

pub(crate) struct SetHandle {
    // The FontFaceSet it is the state of, which a face it holds names (`ffSets`).
    owner: List,
    // Its CSS-connected faces as `[face, state, …]` pairs, and each one's rule's identity, by place.
    css: List,
    css_rules: RefCell<Vec<u32>>,
    // What its CSS-connected faces were last connected for: the generation of its realm's rule list
    // (`RealmArena::rule_rows_gen`), or `NO_RULES` for a document no engine styles; none before. And whether they are
    // being connected now: the bindings make a face mid-connect.
    css_at: Cell<Option<u64>>,
    connecting: Cell<bool>,
    // The faces script added.
    added: Pairs,
    generation: Cell<u32>,
    // Its loading cycle's faces, and whether each gave a file, by place.
    pending: Pairs,
    pending_ok: RefCell<Vec<bool>>,
    cycle_queued: Cell<bool>,
}
const NO_RULES: u64 = u64::MAX;

unsafe impl GarbageCollected for SetHandle {
    fn trace(&self, visitor: &mut Visitor) {
        self.owner.trace(visitor);
        self.css.trace(visitor);
        self.added.trace(visitor);
        self.pending.trace(visitor);
    }
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"FontFaceSetHandle"
    }
}

impl SetHandle {
    // The generation of what script made it hold.
    pub(crate) fn generation(&self) -> u32 {
        self.generation.get()
    }
    fn touch(&self) {
        self.generation.set(self.generation.get().wrapping_add(1));
    }
}

// `new __dom.FontFaceSetStateBase(owner)`: the state of the FontFaceSet `owner`, holding nothing.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let handle = SetHandle {
        owner: List::new(),
        css: List::new(),
        css_rules: RefCell::new(Vec::new()),
        css_at: Cell::new(None),
        connecting: Cell::new(false),
        added: Pairs::new(),
        generation: Cell::new(0),
        pending: Pairs::new(),
        pending_ok: RefCell::new(Vec::new()),
        cycle_queued: Cell::new(false),
    };
    if let Ok(owner) = v8::Local::<v8::Object>::try_from(args.get(0)) {
        handle.owner.set(scope, &[owner]);
    }
    let heap = scope.get_cpp_heap().expect("FontFaceSetStateBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, SetHandle>(scope, obj, &ptr);
    }
}

// The set `value` wraps, or None for anything that is no set's object (the brand first: `unwrap` reads garbage from an
// object it never wrapped).
pub(crate) fn set<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h SetHandle> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped a SetHandle under TAG; the handle lives while its
    // object, the argument, does — through this op.
    let handle = unsafe { v8::Object::unwrap::<TAG, SetHandle>(scope, obj)? };
    Some(unsafe { &*(handle.as_ref() as *const SetHandle) })
}

// What a document's face list holds of the faces script added to its set `value` (font_face_state.rs `listed`), in order
// — none for no set.
pub(crate) fn added_records(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Vec<crate::font_faces::FaceRecord> {
    let Some(s) = set(scope, value) else { return Vec::new() };
    let states = s.added.column(scope, true);
    states.into_iter().map(|state| crate::font_face_state::listed_one(scope, state.into())).collect()
}

// __dom.fsAdd(set, face, state) -> whether the face of FontFace `face`, its state `state`, was added: script's own (a
// CSS-connected face is in the set already, font_face_state.rs `connected`), and once.
fn add_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(false);
    let (Some(s), Ok(me), Ok(face)) = (set(scope, args.get(0)), v8::Local::<v8::Object>::try_from(args.get(0)), v8::Local::<v8::Object>::try_from(args.get(1))) else { return };
    let Ok(state) = v8::Local::<v8::Object>::try_from(args.get(2)) else { return };
    let added = s.added.map(scope);
    if crate::font_face_state::connected(scope, state.into()) || added.has(scope, face.into()) == Some(true) {
        return;
    }
    added.set(scope, face.into(), state.into());
    s.touch();
    crate::font_face_state::link(scope, state.into(), me, true);
    rv.set_bool(true);
}

// __dom.fsDelete(set, face) -> whether FontFace `face` was one script added, and is no more.
fn delete_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(false);
    let (Some(s), Ok(me), Ok(face)) = (set(scope, args.get(0)), v8::Local::<v8::Object>::try_from(args.get(0)), v8::Local::<v8::Object>::try_from(args.get(1))) else { return };
    let added = s.added.map(scope);
    let Some(state) = added.get(scope, face.into()).filter(|v| v.is_object()) else { return };
    added.delete(scope, face.into());
    s.touch();
    crate::font_face_state::link(scope, state, me, false);
    rv.set_bool(true);
}

// __dom.fsClear(set) -> the FontFaces script added, now none.
fn clear_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = set(scope, args.get(0)) else { return };
    let Ok(me) = v8::Local::<v8::Object>::try_from(args.get(0)) else { return };
    let (faces, states) = (s.added.column(scope, false), s.added.column(scope, true));
    if !faces.is_empty() {
        s.added.map(scope).clear();
        s.touch();
    }
    for state in states {
        crate::font_face_state::link(scope, state.into(), me, false);
    }
    rv.set(v8::Array::new_with_elements(scope, &values(faces)).into());
}

// __dom.fsAdded(set) -> the FontFaces script added, in the order they were.
fn added_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = set(scope, args.get(0)) else { return };
    let faces = s.added.column(scope, false);
    rv.set(v8::Array::new_with_elements(scope, &values(faces)).into());
}

// __dom.fsConnect(set, styled, make) -> [faces, made]: its CSS-connected faces, in their rules' order (CSS Font Loading
// §2.2) — once per list of its realm's `@font-face` rules (`RealmArena::rule_rows`: the style engine's, where `styled`,
// its document the one its realm's engine styles; else none) — and those this call made: a face per rule that is a face
// at all (`RuleFace::is_face`), the one it had while its rule names the font it was made of (its identity: a rule whose
// family or sources CSSOM rewrote is a face of its own), its attributes reflecting the rule's descriptors as they are
// now (font_face_state.rs `connect`); a new one made by `make(family, src, descriptors)` -> `[face, state]`, the
// bindings' FontFace. Asked again while one is made, it answers the faces it had: it is connecting them.
fn connect_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = set(scope, args.get(0)) else { return };
    let Ok(me) = v8::Local::<v8::Object>::try_from(args.get(0)) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    let styled = args.get(1).is_true();
    let arena = crate::dom::realm(scope, cid);
    let at = if styled { u64::from(arena.rule_rows_gen) } else { NO_RULES };
    let mut pairs = s.css.get(scope);
    if s.css_at.get() == Some(at) || s.connecting.get() {
        let made = v8::Array::new(scope, 0);
        let faces = v8::Array::new_with_elements(scope, &values(faces_of(&pairs)));
        return rv.set(v8::Array::new_with_elements(scope, &[faces.into(), made.into()]).into());
    }
    let arena = crate::dom::realm(scope, cid);
    let rows: Vec<_> = if styled { arena.rule_rows.iter().filter(|(_, rule, _)| rule.is_face).cloned().collect() } else { Vec::new() };
    let rules = s.css_rules.borrow().clone();
    let make = v8::Local::<v8::Function>::try_from(args.get(2)).ok();
    s.connecting.set(true);
    let mut connected: Vec<v8::Local<v8::Object>> = Vec::with_capacity(2 * rows.len());
    let mut connected_rules = Vec::with_capacity(rows.len());
    let mut made: Vec<v8::Local<v8::Value>> = Vec::new();
    for (id, rule, referrer) in rows {
        let referrer = Some(referrer).filter(|r| !r.is_empty());
        // (…the face it had for the rule, where it still names the font it was made of)
        let had = rules.iter().position(|r| *r == id).map(|k| (pairs[2 * k], pairs[2 * k + 1]));
        let had = had.filter(|(_, state)| crate::font_face_state::identity(scope, (*state).into()).as_deref() == Some(rule.identity.as_str()));
        let (face, state, identity) = match had {
            Some((face, state)) => (face, state, None),
            None => {
                // (…none where the bindings threw: what it has connected so far is what it has)
                let Some((face, state)) = make.and_then(|make| make_face(scope, make, &rule)) else { break };
                made.push(face.into());
                crate::font_face_state::link(scope, state.into(), me, true);
                (face, state, Some(rule.identity.clone()))
            }
        };
        crate::font_face_state::connect(scope, state.into(), id, identity, rule.attributes, rule.family, referrer);
        connected.extend([face, state]);
        connected_rules.push(id);
    }
    s.connecting.set(false);
    // (…and the faces it no longer has unlinked)
    pairs.retain(|o| !connected.iter().any(|c| c.strict_equals((*o).into())));
    for p in pairs.chunks_exact(2) {
        crate::font_face_state::link(scope, p[1].into(), me, false);
    }
    s.css.set(scope, &connected);
    *s.css_rules.borrow_mut() = connected_rules;
    s.css_at.set(Some(at));
    let faces = v8::Array::new_with_elements(scope, &values(faces_of(&connected)));
    let made = v8::Array::new_with_elements(scope, &made);
    rv.set(v8::Array::new_with_elements(scope, &[faces.into(), made.into()]).into());
}
// …a face made for `rule` by the bindings' `make`, as `[face, state]`.
fn make_face<'s>(scope: &mut v8::PinScope<'s, '_>, make: v8::Local<'_, v8::Function>, rule: &crate::font_faces::RuleFace) -> Option<(v8::Local<'s, v8::Object>, v8::Local<'s, v8::Object>)> {
    let attributes: Vec<v8::Local<v8::Value>> = rule.attributes.iter().map(|a| v8::String::new(scope, a).map_or_else(|| v8::undefined(scope).into(), Into::into)).collect();
    let call = [v8::String::new(scope, &rule.family)?.into(), v8::String::new(scope, &rule.src)?.into(), v8::Array::new_with_elements(scope, &attributes).into()];
    let recv = v8::undefined(scope).into();
    let pair = v8::Local::<v8::Array>::try_from(make.call(scope, recv, &call)?).ok()?;
    let (face, state) = (pair.get_index(scope, 0)?, pair.get_index(scope, 1)?);
    Some((v8::Local::<v8::Object>::try_from(face).ok()?, v8::Local::<v8::Object>::try_from(state).ok()?))
}

// __dom.fsCssFace(set, rule) -> its CSS-connected face of the rule `rule` (its identity), as last connected — undefined
// for none.
fn css_face_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = set(scope, args.get(0)) else { return };
    let Some(rule) = args.get(1).uint32_value(scope) else { return };
    let Some(k) = s.css_rules.borrow().iter().position(|r| *r == rule) else { return };
    if let Some(face) = s.css.get(scope).get(2 * k) {
        rv.set((*face).into());
    }
}

// __dom.fsFetched(set, face, state, ok) -> the face of FontFace `face` (its state `state`) fetched — `ok` whether it gave a
// file — in the set's loading cycle: 0 where it settled already (nothing to wait for), else 1 — or 2 where this begins a
// cycle, whose task the bindings queue (`loading`, then the settling of what it waited on). A face is waited on once
// per cycle (the document's face list handed over anew asks for its file again).
fn fetched_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(0);
    let (Some(s), Ok(face)) = (set(scope, args.get(0)), v8::Local::<v8::Object>::try_from(args.get(1))) else { return };
    let Ok(state) = v8::Local::<v8::Object>::try_from(args.get(2)) else { return };
    if crate::font_face_state::status(scope, state.into()).is_none_or(crate::font_face_state::settled) {
        return;
    }
    let pending = s.pending.map(scope);
    let begins = pending.size() == 0 && !s.cycle_queued.get();
    if begins {
        s.cycle_queued.set(true);
    }
    if pending.has(scope, face.into()) != Some(true) {
        pending.set(scope, face.into(), state.into());
        s.pending_ok.borrow_mut().push(args.get(3).is_true());
    }
    rv.set_uint32(if begins { 2 } else { 1 });
}

// __dom.fsCycleBegun(set): its cycle's task ran (`loading` fired). __dom.fsCycleTake(set) -> [face, ok, …]: what the
// cycle waited on, in the order it was fetched, now waited on no more.
fn cycle_begun_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if let Some(s) = set(scope, args.get(0)) {
        s.cycle_queued.set(false);
    }
}
fn cycle_take_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = set(scope, args.get(0)) else { return };
    let faces = s.pending.column(scope, false);
    s.pending.map(scope).clear();
    let oks = s.pending_ok.take();
    let mut items: Vec<v8::Local<v8::Value>> = Vec::new();
    for (face, ok) in faces.into_iter().zip(oks) {
        items.push(face.into());
        items.push(v8::Boolean::new(scope, ok).into());
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.fsLoading(set) -> whether it is `loading`: a cycle queued, or faces it waits on.
fn loading_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = set(scope, args.get(0)) else { return rv.set_bool(false) };
    rv.set_bool(s.cycle_queued.get() || s.pending.len(scope) > 0);
}

// __dom.ffSets(state) -> the FontFaceSets that hold the face of state `state`, of whichever realm.
fn face_sets_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let states = crate::font_face_state::sets(scope, args.get(0));
    let mut owners: Vec<v8::Local<v8::Value>> = Vec::new();
    for state in states {
        if let Some(owner) = set(scope, state.into()).and_then(|s| s.owner.get(scope).first().copied()) {
            owners.push(owner.into());
        }
    }
    rv.set(v8::Array::new_with_elements(scope, &owners).into());
}

// __dom.fsGeneration(set) -> the generation of what it holds; __dom.fsTouch(set) moves it (a descriptor of a face it holds
// rewritten).
fn generation_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(set(scope, args.get(0)).map_or(0, |s| s.generation.get()));
}
fn touch_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if let Some(s) = set(scope, args.get(0)) {
        s.touch();
    }
}

// `__dom.FontFaceSetStateBase`: the constructor of the isolate's template, made once per isolate.
fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let kept = crate::dom::dom(scope).font_face_set_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "FontFaceSetStateBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).font_face_set_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if let (Some(base), Some(name)) = (base_function(scope), v8::String::new(scope, "FontFaceSetStateBase")) {
        ns.set(scope, name.into(), base.into());
    }
    crate::dom::register(scope, ns, "fsAdd", add_op, context_id);
    crate::dom::register(scope, ns, "fsDelete", delete_op, context_id);
    crate::dom::register(scope, ns, "fsClear", clear_op, context_id);
    crate::dom::register(scope, ns, "fsAdded", added_op, context_id);
    crate::dom::register(scope, ns, "fsConnect", connect_op, context_id);
    crate::dom::register(scope, ns, "fsCssFace", css_face_op, context_id);
    crate::dom::register(scope, ns, "fsFetched", fetched_op, context_id);
    crate::dom::register(scope, ns, "fsCycleBegun", cycle_begun_op, context_id);
    crate::dom::register(scope, ns, "fsCycleTake", cycle_take_op, context_id);
    crate::dom::register(scope, ns, "fsLoading", loading_op, context_id);
    crate::dom::register(scope, ns, "ffSets", face_sets_op, context_id);
    crate::dom::register(scope, ns, "fsGeneration", generation_op, context_id);
    crate::dom::register(scope, ns, "fsTouch", touch_op, context_id);
}
