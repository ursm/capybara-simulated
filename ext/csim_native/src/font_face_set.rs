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

// A face it holds: its FontFace's object and its state's. Boxed, as a traced reference keeps its place.
struct Member {
    face: UnsafeCell<v8::TracedReference<v8::Object>>,
    state: UnsafeCell<v8::TracedReference<v8::Object>>,
}

impl Member {
    fn new(scope: &mut v8::PinScope<'_, '_>, face: v8::Local<'_, v8::Object>, state: v8::Local<'_, v8::Object>) -> Box<Member> {
        let member = Box::new(Member { face: UnsafeCell::new(v8::TracedReference::empty()), state: UnsafeCell::new(v8::TracedReference::empty()) });
        // SAFETY: the main thread, which alone writes the references; the assignment runs TracedReference's barrier, the
        // member at the place it keeps.
        unsafe {
            (*member.face.get()).reset(scope, Some(face));
            (*member.state.get()).reset(scope, Some(state));
        }
        member
    }
    // SAFETY (both): the main thread; the reference is read, not written.
    fn face<'s>(&self, scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Object>> {
        unsafe { (*self.face.get()).get(scope) }
    }
    fn state<'s>(&self, scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Object>> {
        unsafe { (*self.state.get()).get(scope) }
    }
}

pub(crate) struct SetHandle {
    // The FontFaceSet it is the state of, which a face it holds names (`ffSets`).
    owner: UnsafeCell<v8::TracedReference<v8::Object>>,
    css: RefCell<Vec<(u32, Box<Member>)>>,
    // What its CSS-connected faces were last connected for: the generation of its realm's rule list
    // (`RealmArena::rule_rows_gen`), or `NO_RULES` for a document no engine styles; none before.
    css_at: Cell<Option<u64>>,
    members: RefCell<Vec<Box<Member>>>,
    generation: Cell<u32>,
    pending: RefCell<Vec<(Box<Member>, bool)>>,
    cycle_queued: Cell<bool>,
}
const NO_RULES: u64 = u64::MAX;

unsafe impl GarbageCollected for SetHandle {
    fn trace(&self, visitor: &mut Visitor) {
        // SAFETY: the collector traces on the main thread between ops, none of which holds the list borrowed then; it
        // reads each reference as TracedReference's barriers allow, and nothing here hands one out.
        visitor.trace(unsafe { &*self.owner.get() });
        let css = unsafe { &*self.css.as_ptr() }.iter().map(|(_, m)| m);
        let pending = unsafe { &*self.pending.as_ptr() }.iter().map(|(m, _)| m);
        for m in css.chain(unsafe { &*self.members.as_ptr() }).chain(pending) {
            visitor.trace(unsafe { &*m.face.get() });
            visitor.trace(unsafe { &*m.state.get() });
        }
    }
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"FontFaceSetHandle"
    }
}

impl SetHandle {
    fn touch(&self) {
        self.generation.set(self.generation.get().wrapping_add(1));
    }
    // The face script added whose FontFace is `face`, by its place.
    fn position(&self, scope: &mut v8::PinScope<'_, '_>, face: v8::Local<'_, v8::Object>) -> Option<usize> {
        self.members.borrow().iter().position(|m| m.face(scope).is_some_and(|f| f.strict_equals(face.into())))
    }
    // Each face script added's FontFace (`state` false) or state (true), in order.
    fn objects<'s>(&self, scope: &mut v8::PinScope<'s, '_>, state: bool) -> v8::Local<'s, v8::Array> {
        let items: Vec<v8::Local<v8::Value>> = self.members.borrow().iter().filter_map(|m| {
            if state { m.state(scope) } else { m.face(scope) }.map(Into::into)
        }).collect();
        v8::Array::new_with_elements(scope, &items)
    }
    // Its CSS-connected faces' FontFaces, in their rules' order.
    fn css_faces<'s>(&self, scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Array> {
        let items: Vec<v8::Local<v8::Value>> = self.css.borrow().iter().filter_map(|(_, m)| m.face(scope).map(Into::into)).collect();
        v8::Array::new_with_elements(scope, &items)
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
        owner: UnsafeCell::new(v8::TracedReference::empty()),
        css: RefCell::new(Vec::new()),
        css_at: Cell::new(None),
        members: RefCell::new(Vec::new()),
        generation: Cell::new(0),
        pending: RefCell::new(Vec::new()),
        cycle_queued: Cell::new(false),
    };
    if let Ok(owner) = v8::Local::<v8::Object>::try_from(args.get(0)) {
        // SAFETY: the main thread, which alone writes the reference; the assignment runs TracedReference's barrier.
        unsafe { (*handle.owner.get()).reset(scope, Some(owner)) };
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
    let states = s.objects(scope, true);
    crate::font_face_state::listed(scope, states.into())
}

// __dom.fsAdd(set, face, state) -> whether the face of FontFace `face`, its state `state`, was added: script's own (a
// CSS-connected face is in the set already, font_face_state.rs `connected`), and once.
fn add_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(false);
    let (Some(s), Ok(face), Ok(state)) = (set(scope, args.get(0)), v8::Local::<v8::Object>::try_from(args.get(1)), v8::Local::<v8::Object>::try_from(args.get(2))) else { return };
    if crate::font_face_state::connected(scope, state.into()) || s.position(scope, face).is_some() {
        return;
    }
    let member = Member::new(scope, face, state);
    s.members.borrow_mut().push(member);
    s.touch();
    if let Ok(me) = v8::Local::<v8::Object>::try_from(args.get(0)) {
        crate::font_face_state::link(scope, state.into(), me, true);
    }
    rv.set_bool(true);
}

// __dom.fsDelete(set, face) -> whether FontFace `face` was one script added, and is no more.
fn delete_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(false);
    let (Some(s), Ok(face)) = (set(scope, args.get(0)), v8::Local::<v8::Object>::try_from(args.get(1))) else { return };
    let Some(k) = s.position(scope, face) else { return };
    let member = s.members.borrow_mut().remove(k);
    s.touch();
    unlink(scope, &args, &member);
    rv.set_bool(true);
}

// The face of `member` no longer held by the set `args[0]`: its link dropped.
fn unlink(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, member: &Member) {
    if let (Ok(me), Some(state)) = (v8::Local::<v8::Object>::try_from(args.get(0)), member.state(scope)) {
        crate::font_face_state::link(scope, state.into(), me, false);
    }
}

// __dom.fsClear(set) -> the FontFaces script added, now none.
fn clear_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = set(scope, args.get(0)) else { return };
    let faces = s.objects(scope, false);
    let members = s.members.take();
    if !members.is_empty() {
        s.touch();
    }
    for member in &members {
        unlink(scope, &args, member);
    }
    rv.set(faces.into());
}

// __dom.fsAdded(set) -> the FontFaces script added, in the order they were.
fn added_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = set(scope, args.get(0)) else { return };
    rv.set(s.objects(scope, false).into());
}

// __dom.fsConnect(set, styled, make) -> [faces, made, dropped]: its CSS-connected faces, in their rules' order (CSS Font
// Loading §2.2) — once per list of its realm's `@font-face` rules (`RealmArena::rule_rows`: the style engine's, where
// `styled`, its document the one its realm's engine styles; else none) — and those made and dropped by this call: a
// face per rule that is a face at all (`RuleFace::is_face`), the one it had while its rule names the font it was made of
// (its identity: a rule whose family or sources CSSOM rewrote is a face of its own), its attributes reflecting the rule's
// descriptors as they are now (font_face_state.rs `connect`); a new one made by `make(family, src, descriptors)` ->
// `[face, state]`, the bindings' FontFace.
fn connect_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = set(scope, args.get(0)) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    let styled = args.get(1).is_true();
    let arena = crate::dom::realm(scope, cid);
    let at = if styled { u64::from(arena.rule_rows_gen) } else { NO_RULES };
    if s.css_at.get() == Some(at) {
        let (faces, empty) = (s.css_faces(scope), v8::Array::new(scope, 0));
        return rv.set(v8::Array::new_with_elements(scope, &[faces.into(), empty.into(), empty.into()]).into());
    }
    let arena = crate::dom::realm(scope, cid);
    let rows: Vec<_> = if styled { arena.rule_rows.iter().filter(|(_, rule, _)| rule.is_face).cloned().collect() } else { Vec::new() };
    let make = v8::Local::<v8::Function>::try_from(args.get(2)).ok();
    // Each rule's face kept (its place in the list) or made — made first, the list left as it is while the bindings run:
    // what it holds stays traced.
    let kept: Vec<Option<usize>> = rows.iter().map(|(id, rule, _)| {
        let css = s.css.borrow();
        let k = css.iter().position(|(key, _)| key == id)?;
        let state = css[k].1.state(scope)?;
        (crate::font_face_state::identity(scope, state.into()).as_deref() == Some(rule.identity.as_str())).then_some(k)
    }).collect();
    let mut made: Vec<Option<(v8::Local<v8::Object>, v8::Local<v8::Object>)>> = Vec::with_capacity(rows.len());
    for ((_, rule, _), kept) in rows.iter().zip(&kept) {
        made.push(match (kept, make) {
            (None, Some(make)) => {
                let attributes: Vec<v8::Local<v8::Value>> = rule.attributes.iter().map(|a| v8::String::new(scope, a).map_or_else(|| v8::undefined(scope).into(), Into::into)).collect();
                let call = [
                    v8::String::new(scope, &rule.family).map_or_else(|| v8::undefined(scope).into(), Into::into),
                    v8::String::new(scope, &rule.src).map_or_else(|| v8::undefined(scope).into(), Into::into),
                    v8::Array::new_with_elements(scope, &attributes).into(),
                ];
                let recv = v8::undefined(scope).into();
                let pair = make.call(scope, recv, &call).and_then(|v| v8::Local::<v8::Array>::try_from(v).ok());
                let objects = pair.and_then(|p| Some((p.get_index(scope, 0)?, p.get_index(scope, 1)?)));
                objects.and_then(|(f, st)| Some((v8::Local::<v8::Object>::try_from(f).ok()?, v8::Local::<v8::Object>::try_from(st).ok()?)))
            }
            _ => None,
        });
    }
    let mut old: Vec<Option<(u32, Box<Member>)>> = s.css.take().into_iter().map(Some).collect();
    let mut css = Vec::with_capacity(rows.len());
    let mut fresh: Vec<v8::Local<v8::Value>> = Vec::new();
    for (((id, rule, referrer), kept), made) in rows.into_iter().zip(kept).zip(made) {
        let referrer = Some(referrer).filter(|r| !r.is_empty());
        let (member, identity) = match (kept.and_then(|k| old[k].take()), made) {
            (Some((_, member)), _) => (member, None),
            (None, Some((face, state))) => {
                fresh.push(face.into());
                if let Ok(me) = v8::Local::<v8::Object>::try_from(args.get(0)) {
                    crate::font_face_state::link(scope, state.into(), me, true);
                }
                (Member::new(scope, face, state), Some(rule.identity.clone()))
            }
            (None, None) => continue,
        };
        if let Some(state) = member.state(scope) {
            crate::font_face_state::connect(scope, state.into(), id, identity, rule.attributes, rule.family, referrer);
        }
        css.push((id, member));
    }
    let old: Vec<(u32, Box<Member>)> = old.into_iter().flatten().collect();
    for (_, member) in &old {
        unlink(scope, &args, member);
    }
    let dropped: Vec<v8::Local<v8::Value>> = old.iter().filter_map(|(_, m)| m.face(scope).map(Into::into)).collect();
    *s.css.borrow_mut() = css;
    s.css_at.set(Some(at));
    let faces = s.css_faces(scope);
    let fresh = v8::Array::new_with_elements(scope, &fresh);
    let dropped = v8::Array::new_with_elements(scope, &dropped);
    rv.set(v8::Array::new_with_elements(scope, &[faces.into(), fresh.into(), dropped.into()]).into());
}

// __dom.fsCssFace(set, rule) -> its CSS-connected face of the rule `rule` (its identity), as last connected — undefined
// for none.
fn css_face_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = set(scope, args.get(0)) else { return };
    let Some(rule) = args.get(1).uint32_value(scope) else { return };
    let face = s.css.borrow().iter().find(|(key, _)| *key == rule).and_then(|(_, m)| m.face(scope));
    if let Some(face) = face {
        rv.set(face.into());
    }
}

// __dom.fsFetched(set, face, state, ok) -> the face of FontFace `face` (its state `state`) fetched — `ok` whether it gave a
// file — in the set's loading cycle: 0 where it settled already (nothing to wait for), else 1 — or 2 where this begins a
// cycle, whose task the bindings queue (`loading`, then the settling of what it waited on). A face is waited on once
// per cycle (the document's face list handed over anew asks for its file again).
fn fetched_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_uint32(0);
    let (Some(s), Ok(face), Ok(state)) = (set(scope, args.get(0)), v8::Local::<v8::Object>::try_from(args.get(1)), v8::Local::<v8::Object>::try_from(args.get(2))) else { return };
    if crate::font_face_state::status(scope, state.into()).is_none_or(crate::font_face_state::settled) {
        return;
    }
    let begins = s.pending.borrow().is_empty() && !s.cycle_queued.get();
    if begins {
        s.cycle_queued.set(true);
    }
    let waited = s.pending.borrow().iter().any(|(m, _)| m.face(scope).is_some_and(|f| f.strict_equals(face.into())));
    if !waited {
        let member = Member::new(scope, face, state);
        s.pending.borrow_mut().push((member, args.get(3).is_true()));
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
    let mut items: Vec<v8::Local<v8::Value>> = Vec::new();
    for (member, ok) in s.pending.take() {
        if let Some(face) = member.face(scope) {
            items.push(face.into());
            items.push(v8::Boolean::new(scope, ok).into());
        }
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.fsLoading(set) -> whether it is `loading`: a cycle queued, or faces it waits on.
fn loading_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(set(scope, args.get(0)).is_some_and(|s| s.cycle_queued.get() || !s.pending.borrow().is_empty()));
}

// __dom.ffSets(state) -> the FontFaceSets that hold the face of state `state`, of whichever realm.
fn face_sets_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let states = crate::font_face_state::sets(scope, args.get(0));
    let mut owners: Vec<v8::Local<v8::Value>> = Vec::new();
    for state in states {
        // SAFETY: the main thread; the reference is read, not written.
        if let Some(owner) = set(scope, state.into()).and_then(|s| unsafe { (*s.owner.get()).get(scope) }) {
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
