// A FontFaceSet as the engine holds it (CSS Font Loading §3): the faces script added to it, in the order they were — its
// set entries after the CSS-connected ones — each as its FontFace's object and its state's (font_face_state.rs), and the
// generation of what it holds, which moves as a face is added or deleted or one of its descriptors is rewritten: what a
// document's face list keys on — on a handle the bindings' object wraps (`__dom.FontFaceSetStateBase`). The set's
// CSS-connected faces, its loading cycle, its promises and its events are the bindings'.

use std::cell::{Cell, RefCell, UnsafeCell};

use v8::cppgc::{GarbageCollected, Visitor};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (font_face_state.rs' 19).
const TAG: u16 = 20;

// What marks an object as a set's (its internal field 0).
static BRAND: u8 = 0;

// A face script added: its FontFace's object and its state's. Boxed, as a traced reference keeps its place.
struct Member {
    face: UnsafeCell<v8::TracedReference<v8::Object>>,
    state: UnsafeCell<v8::TracedReference<v8::Object>>,
}

pub(crate) struct SetHandle {
    members: RefCell<Vec<Box<Member>>>,
    generation: Cell<u32>,
}

unsafe impl GarbageCollected for SetHandle {
    fn trace(&self, visitor: &mut Visitor) {
        // SAFETY: the collector traces on the main thread between ops, none of which holds the list borrowed then; it
        // reads each reference as TracedReference's barriers allow, and nothing here hands one out.
        for m in unsafe { &*self.members.as_ptr() } {
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
    // The member whose FontFace is `face`, by its place.
    fn position(&self, scope: &mut v8::PinScope<'_, '_>, face: v8::Local<'_, v8::Object>) -> Option<usize> {
        // SAFETY: the main thread; the references are read, not written.
        self.members.borrow().iter().position(|m| unsafe { (*m.face.get()).get(scope) }.is_some_and(|f| f.strict_equals(face.into())))
    }
    // Each member's FontFace (`state` false) or state (true), in order.
    fn objects<'s>(&self, scope: &mut v8::PinScope<'s, '_>, state: bool) -> v8::Local<'s, v8::Array> {
        let items: Vec<v8::Local<v8::Value>> = self.members.borrow().iter().filter_map(|m| {
            let r = if state { &m.state } else { &m.face };
            // SAFETY: the main thread; the reference is read, not written.
            unsafe { (*r.get()).get(scope) }.map(Into::into)
        }).collect();
        v8::Array::new_with_elements(scope, &items)
    }
}

// `new __dom.FontFaceSetStateBase()`: a set holding nothing script added.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let handle = SetHandle { members: RefCell::new(Vec::new()), generation: Cell::new(0) };
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
    let member = Box::new(Member { face: UnsafeCell::new(v8::TracedReference::empty()), state: UnsafeCell::new(v8::TracedReference::empty()) });
    // SAFETY: the main thread, which alone writes the references; the assignment runs TracedReference's barrier, the
    // member at the place it keeps.
    unsafe {
        (*member.face.get()).reset(scope, Some(face));
        (*member.state.get()).reset(scope, Some(state));
    }
    s.members.borrow_mut().push(member);
    s.touch();
    rv.set_bool(true);
}

// __dom.fsDelete(set, face) -> whether FontFace `face` was one script added, and is no more.
fn delete_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(false);
    let (Some(s), Ok(face)) = (set(scope, args.get(0)), v8::Local::<v8::Object>::try_from(args.get(1))) else { return };
    let Some(k) = s.position(scope, face) else { return };
    s.members.borrow_mut().remove(k);
    s.touch();
    rv.set_bool(true);
}

// __dom.fsClear(set) -> the FontFaces script added, now none.
fn clear_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = set(scope, args.get(0)) else { return };
    let faces = s.objects(scope, false);
    if !s.members.borrow().is_empty() {
        s.members.borrow_mut().clear();
        s.touch();
    }
    rv.set(faces.into());
}

// __dom.fsAdded(set) -> the FontFaces script added, in the order they were.
fn added_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(s) = set(scope, args.get(0)) else { return };
    rv.set(s.objects(scope, false).into());
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
    crate::dom::register(scope, ns, "fsGeneration", generation_op, context_id);
    crate::dom::register(scope, ns, "fsTouch", touch_op, context_id);
}
