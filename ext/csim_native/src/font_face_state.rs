// A FontFace as the engine holds it (CSS Font Loading §2): its family and its descriptors, parsed and serialized by
// their `@font-face` grammars, its sources — its `src` string's, or the file a buffer's bytes decoded to — its status, the
// error its constructor's arguments gave it, and for a CSS-connected face the rule it is of — on a handle the bindings'
// object wraps (`__dom.FontFaceStateBase`). What font matching reads of it (`record`) is kept until a descriptor moves;
// the face's promise, the loading cycle's tasks and its events are the bindings'.

use std::cell::RefCell;

use v8::cppgc::{GarbageCollected, Visitor};

use crate::font_faces::{FaceRecord, FaceSource, FACE_ATTRIBUTE_DESCRIPTORS};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (blob_data.rs' 18).
const TAG: u16 = 19;

// What marks an object as a face's (its internal field 0).
static BRAND: u8 = 0;

// Its status (FontFaceLoadStatus), by number: font-face.js names them.
const UNLOADED: u32 = 0;
const LOADING: u32 = 1;
const LOADED: u32 = 2;
const ERROR: u32 = 3;

struct Face {
    // Its family as its descriptor serializes it, and each attribute's descriptor (`FACE_ATTRIBUTE_DESCRIPTORS`' order).
    family: String,
    descriptors: [String; 11],
    // The sources its `src` string names, its `url()`s resolved — none for a buffer's face, whose file is `file`.
    sources: Option<Vec<FaceSource>>,
    file: Option<String>,
    status: u32,
    // The message its constructor's arguments errored it with.
    error: Option<String>,
    // A CSS-connected face's: its rule's identity (style.rs `FaceIds`), what makes it the same face (its family and its
    // sources, `RuleFace::identity`) and what its rule's descriptors were when last reflected.
    rule: Option<u32>,
    identity: Option<String>,
    reflected: Option<[String; 11]>,
    // …and the referrer its downloads are requested with, its rule's (`FaceRecord::referrer`): none for a script's face.
    referrer: Option<String>,
    // What font matching reads of it, while its family and descriptors hold.
    record: Option<FaceRecord>,
}

impl Face {
    fn record(&mut self) -> &FaceRecord {
        if self.record.is_none() {
            let mut block = format!("font-family: {};", self.family);
            for (name, value) in FACE_ATTRIBUTE_DESCRIPTORS.iter().zip(&self.descriptors) {
                block.push_str(&format!(" {name}: {value};"));
            }
            let mut record = crate::font_faces::parse(&block, "about:blank").unwrap_or_default();
            record.sources = self.sources.clone().unwrap_or_default();
            record.referrer = self.referrer.clone();
            self.record = Some(record);
        }
        self.record.as_ref().expect("made above")
    }
    // …and in a document's face list: none for a face with nothing to read — a buffer that decoded to no font, a face
    // its arguments errored (Chrome lays the text out with the fallback) — which holds its place all the same.
    fn listed(&mut self) -> FaceRecord {
        if self.status == ERROR || (self.sources.is_none() && self.file.is_none()) {
            return FaceRecord::default();
        }
        let mut record = self.record().clone();
        record.file = self.file.clone();
        record
    }
    // Its rule's descriptors written over it once they CHANGE: each attribute what the rule declares now, or its default.
    // A rule that says what it did leaves the face alone — script may have set an attribute since, which it keeps
    // (Chrome; the setters reach no rule here).
    fn reflect(&mut self, declared: [String; 11]) {
        if self.reflected.as_ref() == Some(&declared) {
            return;
        }
        for (k, value) in declared.iter().enumerate() {
            let name = FACE_ATTRIBUTE_DESCRIPTORS[k];
            let parsed = (!value.is_empty()).then(|| crate::font_faces::descriptor(name, value)).flatten();
            self.descriptors[k] = parsed.unwrap_or_else(|| crate::font_faces::descriptor_default(name).unwrap_or_default().to_owned());
        }
        self.reflected = Some(declared);
        self.record = None;
    }
}

pub(crate) struct FaceHandle {
    face: RefCell<Face>,
}

unsafe impl GarbageCollected for FaceHandle {
    fn trace(&self, _visitor: &mut Visitor) {}
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"FaceHandle"
    }
}

// `new __dom.FontFaceStateBase(family, source, base, descriptors)` — the constructor's steps (CSS Font Loading §2.1):
// `family` parsed as the `font-family` descriptor, its serialization kept (one that is none, or does not write back as
// given, a quoted string of it: font_faces.rs `constructed_family`, csswg-drafts#6236); each of `descriptors` (in
// `FACE_ATTRIBUTE_DESCRIPTORS`' order, undefined for one not given) parsed by its grammar — one that does not, the empty
// string, and the face errored; `source` a `src` string (null: a buffer's) that is not one `src` value whole errored too
// (`font_faces::face_sources`), its `url()`s resolved against `base`. An
// errored face's status is `error` from the start.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let family = crate::font_faces::constructed_family(&args.get(0).to_rust_string_lossy(scope)).1;
    let source = (!args.get(1).is_null_or_undefined()).then(|| args.get(1).to_rust_string_lossy(scope));
    let base = args.get(2).to_rust_string_lossy(scope);
    let given = v8::Local::<v8::Array>::try_from(args.get(3)).ok();
    let mut error = None;
    let mut descriptors: [String; 11] = Default::default();
    for (k, name) in FACE_ATTRIBUTE_DESCRIPTORS.iter().enumerate() {
        let raw = given.and_then(|a| a.get_index(scope, k as u32)).filter(|v| !v.is_undefined());
        let value = match raw {
            Some(v) => {
                let v = v.to_rust_string_lossy(scope);
                crate::font_faces::descriptor(name, &v)
            }
            None => crate::font_faces::descriptor_default(name).map(str::to_owned),
        };
        if value.is_none() {
            error = Some("The provided descriptor value is invalid.".to_owned());
        }
        descriptors[k] = value.unwrap_or_default();
    }
    // (…Chrome: `new FontFace('a', {})` is an error face, in these words)
    let sources = source.as_deref().map(|src| crate::font_faces::face_sources(src, &base));
    if let (Some(src), Some(None)) = (&source, &sources) {
        error = Some(format!("The source provided ('{src}') could not be parsed as a value list."));
    }
    let sources = sources.map(Option::unwrap_or_default);
    let status = if error.is_some() { ERROR } else { UNLOADED };
    let face = Face { family, descriptors, sources, file: None, status, error, rule: None, identity: None, reflected: None, referrer: None, record: None };
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let handle = FaceHandle { face: RefCell::new(face) };
    let heap = scope.get_cpp_heap().expect("FontFaceStateBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, FaceHandle>(scope, obj, &ptr);
    }
}

// The face `value` wraps, or None for anything that is no face's object (the brand first: `unwrap` reads garbage from an
// object it never wrapped).
fn face<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h RefCell<Face>> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped a FaceHandle under TAG; the handle lives while its
    // object, the argument, does — through this op.
    let handle = unsafe { v8::Object::unwrap::<TAG, FaceHandle>(scope, obj)? };
    Some(unsafe { &(*(handle.as_ref() as *const FaceHandle)).face })
}

// The faces of an array of states, in order (none for an entry that is no face's).
fn faces_in<'h>(scope: &mut v8::PinScope<'_, '_>, list: v8::Local<'_, v8::Value>) -> Vec<Option<&'h RefCell<Face>>> {
    let Ok(list) = v8::Local::<v8::Array>::try_from(list) else { return Vec::new() };
    (0..list.length()).map(|k| list.get_index(scope, k).and_then(|v| face(scope, v))).collect()
}
// …what a document's face list holds of each (`Face::listed`), and what font matching reads of each.
pub(crate) fn listed(scope: &mut v8::PinScope<'_, '_>, list: v8::Local<'_, v8::Value>) -> Vec<FaceRecord> {
    faces_in(scope, list).into_iter().map(|f| f.map_or_else(FaceRecord::default, |f| f.borrow_mut().listed())).collect()
}
pub(crate) fn records(scope: &mut v8::PinScope<'_, '_>, list: v8::Local<'_, v8::Value>) -> Vec<FaceRecord> {
    faces_in(scope, list).into_iter().map(|f| f.map_or_else(FaceRecord::default, |f| f.borrow_mut().record().clone())).collect()
}

// `__dom.FontFaceStateBase`: the constructor of the isolate's template, made once per isolate.
fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let kept = crate::dom::dom(scope).font_face_state_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "FontFaceStateBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).font_face_state_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if let (Some(base), Some(name)) = (base_function(scope), v8::String::new(scope, "FontFaceStateBase")) {
        ns.set(scope, name.into(), base.into());
    }
    crate::dom::register(scope, ns, "ffField", field_op, context_id);
    crate::dom::register(scope, ns, "ffSet", set_op, context_id);
    crate::dom::register(scope, ns, "ffSetFile", set_file_op, context_id);
    crate::dom::register(scope, ns, "ffStart", start_op, context_id);
    crate::dom::register(scope, ns, "ffSettle", settle_op, context_id);
    crate::dom::register(scope, ns, "ffConnect", connect_op, context_id);
    crate::dom::register(scope, ns, "ffSources", sources_op, context_id);
    crate::dom::register(scope, ns, "ffFile", file_op, context_id);
    crate::dom::register(scope, ns, "ffFetchedStatus", fetched_status_op, context_id);
}

// The fields `ffField` reads, by number (font-face.js names them): 0..10 the attributes' descriptors, then these.
const FAMILY: u32 = 11;
const STATUS: u32 = 12;
const ERROR_MESSAGE: u32 = 13;
const RULE: u32 = 14;
const IDENTITY: u32 = 15;

// __dom.ffField(state, field) -> the face's `field` (null for a text it has none of).
fn field_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(face) = face(scope, args.get(0)) else { return };
    let f = face.borrow();
    let field = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let text = match field {
        k if (k as usize) < f.descriptors.len() => Some(f.descriptors[k as usize].as_str()),
        FAMILY => Some(f.family.as_str()),
        STATUS => return rv.set_uint32(f.status),
        ERROR_MESSAGE => f.error.as_deref(),
        RULE => {
            match f.rule {
                Some(r) => rv.set_uint32(r),
                None => rv.set_null(),
            }
            return;
        }
        IDENTITY => f.identity.as_deref(),
        _ => return,
    };
    match text.and_then(|t| v8::String::new(scope, t)) {
        Some(t) => rv.set(t.into()),
        None => rv.set_null(),
    }
}

// __dom.ffSet(state, field, value) -> whether `value` parsed: the attribute's descriptor (0..10), or with `FAMILY` the
// family, set as its grammar parses and serializes it — strictly, the setter's steps, which #6236 left as they were.
fn set_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(face) = face(scope, args.get(0)) else { return };
    let field = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let value = args.get(2).to_rust_string_lossy(scope);
    let mut f = face.borrow_mut();
    let parsed = match field {
        FAMILY => crate::font_faces::family_descriptor(&value).map(|(_, serialized)| serialized),
        k => FACE_ATTRIBUTE_DESCRIPTORS.get(k as usize).and_then(|name| crate::font_faces::descriptor(name, &value)),
    };
    let Some(parsed) = parsed else { return rv.set_bool(false) };
    match field {
        FAMILY => f.family = parsed,
        k => f.descriptors[k as usize] = parsed,
    }
    f.record = None;
    rv.set_bool(true);
}

// __dom.ffSetFile(state, path) — the file a buffer's bytes decoded to (null: none).
fn set_file_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(face) = face(scope, args.get(0)) else { return };
    face.borrow_mut().file = (!args.get(1).is_null_or_undefined()).then(|| args.get(1).to_rust_string_lossy(scope));
}

// __dom.ffStart(state) -> whether the face was `unloaded`, and is `loading` now.
fn start_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(face) = face(scope, args.get(0)) else { return };
    let mut f = face.borrow_mut();
    let unloaded = f.status == UNLOADED;
    if unloaded {
        f.status = LOADING;
    }
    rv.set_bool(unloaded);
}

// __dom.ffSettle(state, ok) -> whether the face settled now: `loaded` or `error` by `ok`, where it was neither.
fn settle_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(face) = face(scope, args.get(0)) else { return };
    let mut f = face.borrow_mut();
    let open = f.status == UNLOADED || f.status == LOADING;
    if open {
        f.status = if args.get(1).is_true() { LOADED } else { ERROR };
    }
    rv.set_bool(open);
}

// __dom.ffConnect(state, rule, identity, declared, family, referrer) — the face is CSS-connected (CSS Font Loading
// §2.2): of the rule `rule`, made of its `declared` descriptors (`FACE_ATTRIBUTE_DESCRIPTORS`' order, empty for one the
// rule does not declare), what makes it that face `identity`, its family the rule's `family` as the style engine took
// and serialized it (`math` stays `math`, which the constructor's stricter reading would have quoted), its downloads
// referred by `referrer` (its sheet's location: CSS Values 4 "fetch a style resource"); with no `identity`, the rule
// it is of already declaring `declared` now — reflected where they changed since (`Face::reflect`).
fn connect_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(face) = face(scope, args.get(0)) else { return };
    let rule = args.get(1).uint32_value(scope);
    let identity = (!args.get(2).is_null_or_undefined()).then(|| args.get(2).to_rust_string_lossy(scope));
    let declared = v8::Local::<v8::Array>::try_from(args.get(3)).ok();
    let family = args.get(4).to_rust_string_lossy(scope);
    let referrer = args.get(5).is_string().then(|| args.get(5).to_rust_string_lossy(scope)).filter(|r| !r.is_empty());
    let mut values: [String; 11] = Default::default();
    for (k, value) in values.iter_mut().enumerate() {
        if let Some(v) = declared.and_then(|a| a.get_index(scope, k as u32)) {
            *value = v.to_rust_string_lossy(scope);
        }
    }
    let mut f = face.borrow_mut();
    if f.referrer != referrer {
        f.referrer = referrer;
        f.record = None;
    }
    match identity {
        // (…a face just made of its rule's descriptors has them already)
        Some(identity) => {
            f.family = family;
            f.record = None;
            f.rule = rule;
            f.identity = Some(identity);
            f.reflected = Some(values);
        }
        None => f.reflect(values),
    }
}

// __dom.ffSources(state) -> the face's sources a browser would try, in order, flat `[kind, value, …]` (`url` / `local`),
// each `url()` resolved against its base — none for a buffer's face.
fn sources_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(face) = face(scope, args.get(0)) else { return };
    let sources = face.borrow().sources.clone().unwrap_or_default();
    let list = crate::font_faces::sources_array(scope, &sources);
    rv.set(list.into());
}

// __dom.ffFile(state, fetch) -> the file the face is read from, or null where it has none native reads: a buffer face's
// own, else the first of its sources, in order, that gives one (font_files.rs `face_file`) — what `load()` loads.
fn file_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(face), Ok(fetch)) = (face(scope, args.get(0)), v8::Local::<v8::Function>::try_from(args.get(1))) else { return rv.set_null() };
    let (file, sources, bucket, referrer) = {
        let mut f = face.borrow_mut();
        let bucket = f.record().local_style();
        (f.file.clone(), f.sources.clone().unwrap_or_default(), bucket, f.referrer.clone())
    };
    let cid = crate::dom::realm_id(scope, &args);
    let file = crate::font_files::face_file(scope, cid, file.as_deref(), &sources, bucket, referrer.as_deref(), fetch);
    crate::font_files::answer_file(scope, &mut rv, file);
}

// __dom.ffFetchedStatus(state) -> what the face's downloads already went through, as a status: `loaded` where one of them
// came as a font native reads, `error` where every one came and none did, else `unloaded` (font_files.rs
// `source_tried`) — what a CSS-connected face whose file layout already fetched starts as.
fn fetched_status_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(face) = face(scope, args.get(0)) else { return };
    let urls: Vec<String> = face.borrow().sources.iter().flatten().filter_map(|s| match s {
        FaceSource::Url(u) => Some(u.clone()),
        FaceSource::Local(_) => None,
    }).collect();
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let tried: Vec<Option<bool>> = urls.iter().map(|u| crate::font_files::source_tried(arena, crate::font_files::URL, u)).collect();
    rv.set_uint32(if tried.contains(&Some(true)) {
        LOADED
    } else if !tried.is_empty() && tried.iter().all(Option::is_some) {
        ERROR
    } else {
        UNLOADED
    });
}
