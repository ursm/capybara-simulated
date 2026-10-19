// A Blob's bytes (File API §3): an immutable run of a byte buffer only the engine holds, on a handle the bindings' Blob
// keeps in its slots (blob.js) — made of its parts once, sliced without a copy (a slice is the same buffer, another run
// of it), and read as a script asks for them. The buffer is an ArrayBuffer no script is handed, so the collector counts
// it as any array, and it lives while some blob's handle does.

use std::cell::UnsafeCell;

use v8::cppgc::{GarbageCollected, Visitor};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (webcrypto.rs' KEY_TAG 17).
const TAG: u16 = 18;

// What marks an object as a blob's bytes (its internal field 0).
static BRAND: u8 = 0;

pub(crate) struct BlobHandle {
    buffer: UnsafeCell<v8::TracedReference<v8::Object>>,
    start: usize,
    len: usize,
}

unsafe impl GarbageCollected for BlobHandle {
    fn trace(&self, visitor: &mut Visitor) {
        // SAFETY: the collector reads the reference as TracedReference's barriers allow; nothing here hands one out.
        visitor.trace(unsafe { &*self.buffer.get() });
    }
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"BlobHandle"
    }
}

impl BlobHandle {
    // Its bytes, copied out.
    fn bytes(&self, scope: &mut v8::PinScope<'_, '_>) -> Vec<u8> {
        // SAFETY: the main thread reads the reference; nothing else writes it meanwhile.
        let buffer = unsafe { (*self.buffer.get()).get(scope) }.and_then(|b| v8::Local::<v8::ArrayBuffer>::try_from(b).ok());
        let Some(buffer) = buffer else { return Vec::new() };
        let store = buffer.get_backing_store();
        store.get(self.start..self.start + self.len).map_or_else(Vec::new, |run| run.iter().map(std::cell::Cell::get).collect())
    }
}

// A blob's bytes object over the run `start..start + len` of `buffer`.
fn blob_object<'s>(scope: &mut v8::PinScope<'s, '_>, buffer: v8::Local<'_, v8::Object>, start: usize, len: usize) -> v8::Local<'s, v8::Value> {
    let kept = crate::dom::dom(scope).blob_data_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::ObjectTemplate::new(scope);
            t.set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).blob_data_template = Some(global);
            t
        }
    };
    let Some(obj) = template.new_instance(scope) else { return v8::undefined(scope).into() };
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let handle = BlobHandle { buffer: UnsafeCell::new(v8::TracedReference::empty()), start, len };
    // SAFETY: the reference is the handle's own, written before anything else can read it.
    unsafe { (*handle.buffer.get()).reset(scope, Some(buffer)) };
    let heap = scope.get_cpp_heap().expect("a blob's bytes are made only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, BlobHandle>(scope, obj, &ptr);
    }
    obj.into()
}

// The handle `value` wraps, or None for anything that is no blob's bytes object (the brand first: `unwrap` reads garbage
// from an object it never wrapped).
fn handle<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h BlobHandle> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `blob_object`, which wrapped a BlobHandle under TAG; the handle lives while its
    // object, the argument, does — through this op.
    let ptr = unsafe { v8::Object::unwrap::<TAG, BlobHandle>(scope, obj)? };
    Some(unsafe { &*(ptr.as_ref() as *const BlobHandle) })
}

// A blob's bytes object holding `bytes`, in a buffer of their own.
fn owning<'s>(scope: &mut v8::PinScope<'s, '_>, bytes: Vec<u8>) -> v8::Local<'s, v8::Value> {
    let len = bytes.len();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
    blob_object(scope, buffer.into(), 0, len)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "blobMake", make_op, context_id);
    crate::dom::register(scope, ns, "blobSlice", slice_op, context_id);
    crate::dom::register(scope, ns, "blobSize", size_op, context_id);
    crate::dom::register(scope, ns, "blobBytes", bytes_op, context_id);
    crate::dom::register(scope, ns, "blobLatin1", latin1_op, context_id);
}

// __dom.blobMake(parts, native) -> a blob's bytes, its parts' (§3.1 "process blob parts") in order: a string's UTF-8
// (blob_rules.rs `blob_text`, its line endings the native ones where `native`), another blob's bytes object's as they
// are, a buffer's or a view's — none of a detached one's. One blob's bytes alone are that blob's, its buffer shared.
fn make_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(parts) = v8::Local::<v8::Array>::try_from(args.get(0)) else { return };
    let native = args.get(1).is_true();
    if parts.length() == 1 {
        if let Some(part) = parts.get_index(scope, 0).filter(|p| handle(scope, *p).is_some()) {
            return rv.set(part);
        }
    }
    let mut bytes = Vec::new();
    for i in 0..parts.length() {
        let Some(part) = parts.get_index(scope, i) else { continue };
        if part.is_string() {
            bytes.extend(crate::blob_rules::blob_text(&crate::dom::utf16_arg(scope, part), native));
        } else if let Some(h) = handle(scope, part) {
            bytes.extend(h.bytes(scope));
        } else if let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(part) {
            let mut run = vec![0; view.byte_length()];
            let copied = view.copy_contents(&mut run);
            bytes.extend(&run[..copied]);
        } else if let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(part) {
            let store = buffer.get_backing_store();
            bytes.extend(store.iter().take(buffer.byte_length()).map(std::cell::Cell::get));
        }
    }
    rv.set(owning(scope, bytes));
}

// __dom.blobSlice(bytes, start, len) -> the run `start..start + len` of a blob's bytes (blob_rules.rs `slice_range`'s,
// within them), its buffer shared.
fn slice_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let start = (args.get(1).number_value(scope).unwrap_or(0.0) as usize).min(h.len);
    let len = (args.get(2).number_value(scope).unwrap_or(0.0) as usize).min(h.len - start);
    // SAFETY: the main thread reads the reference; nothing else writes it meanwhile.
    let Some(buffer) = (unsafe { (*h.buffer.get()).get(scope) }) else { return };
    rv.set(blob_object(scope, buffer, h.start + start, len));
}

// __dom.blobSize(bytes) -> how many there are.
fn size_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_double(handle(scope, args.get(0)).map_or(0.0, |h| h.len as f64));
}

// __dom.blobBytes(bytes) -> a Uint8Array of a copy of them, a script's to keep.
fn bytes_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let bytes = handle(scope, args.get(0)).map_or_else(Vec::new, |h| h.bytes(scope));
    let len = bytes.len();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
    if let Some(array) = v8::Uint8Array::new(scope, buffer, 0, len) {
        rv.set(array.into());
    }
}

// __dom.blobLatin1(bytes) -> them as a byte string (each byte a code unit), for the modules that take one; a RangeError
// past the longest string V8 makes.
fn latin1_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let bytes = handle(scope, args.get(0)).map_or_else(Vec::new, |h| h.bytes(scope));
    match v8::String::new_from_one_byte(scope, &bytes, v8::NewStringType::Normal) {
        Some(s) => rv.set(s.into()),
        None => {
            if let Some(message) = v8::String::new(scope, "Invalid string length") {
                let error = v8::Exception::range_error(scope, message);
                scope.throw_exception(error);
            }
        }
    }
}
