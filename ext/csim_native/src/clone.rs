// HTML's StructuredSerialize and StructuredDeserialize, by V8's own ValueSerializer: the JavaScript values — primitives
// and their wrappers, Dates, RegExps, Maps, Sets, ArrayBuffers and their views, errors, arrays and ordinary objects,
// cycles and shared references kept — written to bytes and read back, in any realm, in any isolate.
//
// A platform object is the bindings' to say, through a hook each way. Serializing, the hook is asked of every object
// that is no ordinary one: undefined for none (a page's class instance, an error), else what the object serializes to —
// plain data — or a throw, a DataCloneError, for one that is not [Serializable]. What it says is kept in a list beside
// the value, and the value holds the object's place in it. Deserializing — where no script may run while V8 reads —
// that list is read first and handed to the hook, which makes the platform objects; the value is read after, each
// place the object made for it.

use std::cell::RefCell;
use std::rc::Rc;

use v8::{ValueDeserializerHelper, ValueSerializerHelper};

use crate::dom::register;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "structuredSerialize", structured_serialize, context_id);
    register(scope, ns, "structuredDeserialize", structured_deserialize, context_id);
    register(scope, ns, "structuredClone", structured_clone, context_id);
}

type Descriptions = Rc<RefCell<Vec<v8::Global<v8::Value>>>>;
// The SharedArrayBuffers a value holds, by their places: what a structured clone shares rather than copies — where it
// may share them at all (an agent cluster that is cross-origin isolated), and only within the isolate.
type Shared = Rc<RefCell<Vec<v8::SharedRef<v8::BackingStore>>>>;

// The serializer's delegate: the bindings' hook (none for plain data), what it said of the object V8 last asked about —
// V8 asks whether an object is a host object, then has it written, one after the other — and every description written.
struct Serializer<'h> {
    hook: Option<v8::Local<'h, v8::Function>>,
    asked: RefCell<Option<v8::Global<v8::Value>>>,
    described: Descriptions,
    shared: Option<Shared>,
}

impl v8::ValueSerializerImpl for Serializer<'_> {
    fn throw_data_clone_error<'s>(&self, scope: &mut v8::PinScope<'s, '_>, message: v8::Local<'s, v8::String>) {
        throw_dom_exception(scope, message, "DataCloneError");
    }

    fn has_custom_host_object(&self, _isolate: &v8::Isolate) -> bool {
        self.hook.is_some()
    }

    // (…a SharedArrayBuffer kept by its place where it may be shared, else a DataCloneError)
    fn get_shared_array_buffer_id<'s>(
        &self,
        scope: &mut v8::PinScope<'s, '_>,
        buffer: v8::Local<'s, v8::SharedArrayBuffer>,
    ) -> Option<u32> {
        let Some(shared) = &self.shared else {
            let message = v8::String::new(scope, "A SharedArrayBuffer could not be cloned.")?;
            throw_dom_exception(scope, message, "DataCloneError");
            return None;
        };
        let mut shared = shared.borrow_mut();
        shared.push(buffer.get_backing_store());
        Some(shared.len() as u32 - 1)
    }

    // An ordinary object — one whose prototype is its realm's %Object.prototype%, or null — is no platform object, and
    // the hook is not asked.
    fn is_host_object<'s>(&self, scope: &mut v8::PinScope<'s, '_>, object: v8::Local<'s, v8::Object>) -> Option<bool> {
        let hook = self.hook?;
        let proto = object.get_prototype(scope)?;
        if proto.is_null() || is_object_prototype(scope, object, proto) {
            return Some(false);
        }
        let undefined = v8::undefined(scope).into();
        let description = hook.call(scope, undefined, &[object.into()])?;
        if description.is_undefined() {
            return Some(false);
        }
        *self.asked.borrow_mut() = Some(v8::Global::new(scope, description));
        Some(true)
    }

    // (…an object of V8's own — a native legacy platform object, a FileList — is written without V8 asking first: the
    // hook is asked here, and one it has nothing for is no structured-clone value)
    fn write_host_object<'s>(
        &self,
        scope: &mut v8::PinScope<'s, '_>,
        object: v8::Local<'s, v8::Object>,
        serializer: &dyn v8::ValueSerializerHelper,
    ) -> Option<bool> {
        let asked = self.asked.borrow_mut().take();
        let description = match asked {
            Some(description) => description,
            None => {
                let undefined = v8::undefined(scope).into();
                let description = self.hook?.call(scope, undefined, &[object.into()])?;
                if description.is_undefined() {
                    let message = v8::String::new(scope, "An object could not be cloned.")?;
                    throw_dom_exception(scope, message, "DataCloneError");
                    return None;
                }
                v8::Global::new(scope, description)
            }
        };
        let mut described = self.described.borrow_mut();
        serializer.write_uint32(described.len() as u32);
        described.push(description);
        Some(true)
    }
}

// Whether `proto` is the %Object.prototype% of `object`'s realm.
fn is_object_prototype(scope: &mut v8::PinScope<'_, '_>, object: v8::Local<'_, v8::Object>, proto: v8::Local<'_, v8::Value>) -> bool {
    let Some(context) = object.get_creation_context(scope) else { return false };
    let global = context.global(scope);
    let constructor = v8::String::new(scope, "Object")
        .and_then(|k| global.get(scope, k.into()))
        .and_then(|c| v8::Local::<v8::Object>::try_from(c).ok());
    let Some(constructor) = constructor else { return false };
    let Some(key) = v8::String::new(scope, "prototype") else { return false };
    constructor.get(scope, key.into()).is_some_and(|p| p == proto)
}

// The deserializer's delegate: the platform objects the hook made, and the SharedArrayBuffers' memory, by their places.
struct Deserializer {
    objects: Vec<v8::Global<v8::Object>>,
    shared: Vec<v8::SharedRef<v8::BackingStore>>,
}

impl v8::ValueDeserializerImpl for Deserializer {
    fn read_host_object<'s>(
        &self,
        scope: &mut v8::PinScope<'s, '_>,
        deserializer: &dyn v8::ValueDeserializerHelper,
    ) -> Option<v8::Local<'s, v8::Object>> {
        let mut place = 0;
        if !deserializer.read_uint32(&mut place) {
            return None;
        }
        self.objects.get(place as usize).map(|o| v8::Local::new(scope, o))
    }

    fn get_shared_array_buffer_from_id<'s>(&self, scope: &mut v8::PinScope<'s, '_>, place: u32) -> Option<v8::Local<'s, v8::SharedArrayBuffer>> {
        let store = self.shared.get(place as usize)?;
        Some(v8::SharedArrayBuffer::with_backing_store(scope, store))
    }
}

// A DOMException of this realm's, thrown.
fn throw_dom_exception(scope: &mut v8::PinScope<'_, '_>, message: v8::Local<'_, v8::String>, name: &str) {
    let context = scope.get_current_context();
    let global = context.global(scope);
    let constructor = v8::String::new(scope, "DOMException")
        .and_then(|k| global.get(scope, k.into()))
        .and_then(|c| v8::Local::<v8::Function>::try_from(c).ok());
    let name = v8::String::new(scope, name);
    let exception = match (constructor, name) {
        (Some(constructor), Some(name)) => constructor.new_instance(scope, &[message.into(), name.into()]).map(Into::into),
        _ => None,
    };
    let exception = exception.unwrap_or_else(|| v8::Exception::error(scope, message));
    scope.throw_exception(exception);
}

// One value's bytes, by V8's serializer — the header, then the value — and the descriptions its platform objects took;
// None where it threw.
fn write(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
    hook: Option<v8::Local<'_, v8::Function>>,
    shared: Option<Shared>,
    transfer: &[v8::Local<'_, v8::ArrayBuffer>],
) -> Option<(Vec<u8>, Vec<v8::Global<v8::Value>>)> {
    let described = Descriptions::default();
    let delegate = Serializer { hook, asked: RefCell::new(None), described: described.clone(), shared };
    let serializer = v8::ValueSerializer::new(scope, Box::new(delegate));
    serializer.write_header();
    for (place, buffer) in transfer.iter().enumerate() {
        serializer.transfer_array_buffer(place as u32, *buffer);
    }
    let context = scope.get_current_context();
    serializer.write_value(context, value)?;
    let bytes = serializer.release();
    Some((bytes, described.take()))
}

// StructuredSerialize `value` into bytes, `hook` answering for each object no ordinary one — None where it threw
// (V8's DataCloneError for a function or a symbol, the hook's for a platform object; a SharedArrayBuffer's but where
// `shared` keeps them) — each of the ArrayBuffers `transfer` lists written as its place in the list, not its bytes. The
// bytes: the descriptions' length (four bytes, little-endian) and serialization, then the value's.
pub(crate) fn serialize(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
    hook: v8::Local<'_, v8::Function>,
    shared: Option<Shared>,
    transfer: &[v8::Local<'_, v8::ArrayBuffer>],
) -> Option<Vec<u8>> {
    let (bytes, described) = write(scope, value, Some(hook), shared, transfer)?;
    let descriptions: Vec<v8::Local<v8::Value>> = described.into_iter().map(|d| v8::Local::new(scope, d)).collect();
    let descriptions = v8::Array::new_with_elements(scope, &descriptions);
    let (head, _) = write(scope, descriptions.into(), None, None, &[])?;
    let mut out = Vec::with_capacity(4 + head.len() + bytes.len());
    out.extend_from_slice(&(head.len() as u32).to_le_bytes());
    out.extend_from_slice(&head);
    out.extend_from_slice(&bytes);
    Some(out)
}

// One value read from bytes, by V8's deserializer.
fn read<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    bytes: &[u8],
    objects: Vec<v8::Global<v8::Object>>,
    shared: Vec<v8::SharedRef<v8::BackingStore>>,
    transferred: &[v8::Local<'_, v8::ArrayBuffer>],
) -> Option<v8::Local<'s, v8::Value>> {
    let deserializer = v8::ValueDeserializer::new(scope, Box::new(Deserializer { objects, shared }), bytes);
    let context = scope.get_current_context();
    deserializer.read_header(context)?;
    for (place, buffer) in transferred.iter().enumerate() {
        deserializer.transfer_array_buffer(place as u32, *buffer);
    }
    deserializer.read_value(context)
}

// StructuredDeserialize `bytes` in the current realm, `hook(descriptions)` making the platform objects — an array of
// them, in the descriptions' order — the SharedArrayBuffers over `shared`'s memory, and each transferred ArrayBuffer
// the one `transferred` has at its place.
pub(crate) fn deserialize<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    bytes: &[u8],
    hook: v8::Local<'_, v8::Function>,
    shared: Vec<v8::SharedRef<v8::BackingStore>>,
    transferred: &[v8::Local<'_, v8::ArrayBuffer>],
) -> Option<v8::Local<'s, v8::Value>> {
    let split = 4 + u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
    let (head, body) = (bytes.get(4..split)?, bytes.get(split..)?);
    let descriptions = read(scope, head, Vec::new(), Vec::new(), &[])?;
    let mut objects = Vec::new();
    if v8::Local::<v8::Array>::try_from(descriptions).is_ok_and(|a| a.length() > 0) {
        let undefined = v8::undefined(scope).into();
        let made = v8::Local::<v8::Array>::try_from(hook.call(scope, undefined, &[descriptions])?).ok()?;
        for i in 0..made.length() {
            let object = made.get_index(scope, i).and_then(|o| v8::Local::<v8::Object>::try_from(o).ok())?;
            objects.push(v8::Global::new(scope, object));
        }
    }
    read(scope, body, objects, shared, transferred)
}

// __dom.structuredSerialize(value, hook) -> an ArrayBuffer of its serialization.
fn structured_serialize(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(hook) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let Some(bytes) = serialize(scope, args.get(0), hook, None, &[]) else { return };
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    rv.set(v8::ArrayBuffer::with_backing_store(scope, &store).into());
}

// __dom.structuredDeserialize(buffer, hook) -> the value it holds, made in this realm.
fn structured_deserialize(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(args.get(0)) else { return };
    let Ok(hook) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let length = buffer.byte_length();
    let bytes = match buffer.data() {
        Some(data) if length > 0 => unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, length) }.to_vec(),
        _ => Vec::new(),
    };
    if let Some(value) = deserialize(scope, &bytes, hook, Vec::new(), &[]) {
        rv.set(value);
    }
}

// __dom.structuredClone(value, serializeHook, deserializeHook, mayShare, buffers) -> StructuredDeserializeWithTransfer
// (StructuredSerializeWithTransfer(value)) in this realm: its SharedArrayBuffers shared where `mayShare` (a
// cross-origin isolated agent cluster's), and the ArrayBuffers `buffers` lists transferred — each detached once the
// value is serialized, its memory a new one's.
fn structured_clone(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(serialize_hook) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let Ok(deserialize_hook) = v8::Local::<v8::Function>::try_from(args.get(2)) else { return };
    let shared = args.get(3).boolean_value(scope).then(Shared::default);
    let mut buffers = Vec::new();
    if let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(4)) {
        for i in 0..list.length() {
            let Some(buffer) = list.get_index(scope, i).and_then(|b| v8::Local::<v8::ArrayBuffer>::try_from(b).ok()) else { return };
            buffers.push(buffer);
        }
    }
    let Some(bytes) = serialize(scope, args.get(0), serialize_hook, shared.clone(), &buffers) else { return };
    let mut transferred = Vec::with_capacity(buffers.len());
    for buffer in &buffers {
        let store = buffer.get_backing_store();
        buffer.detach(None);
        transferred.push(v8::ArrayBuffer::with_backing_store(scope, &store));
    }
    let shared = shared.map(|s| s.take()).unwrap_or_default();
    if let Some(value) = deserialize(scope, &bytes, deserialize_hook, shared, &transferred) {
        rv.set(value);
    }
}
