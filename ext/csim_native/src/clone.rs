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
//
// A serialization is kept here, by its number, until it is read back or let go: between the two the bindings run
// StructuredSerializeWithTransfer's own steps — the transfer list checked again, each transferable moved.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, LazyLock, Mutex};

use v8::{ValueDeserializerHelper, ValueSerializerHelper};

use crate::dom::{dom, realm_id, register};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "structuredSerialize", structured_serialize, context_id);
    register(scope, ns, "structuredTransfer", structured_transfer, context_id);
    register(scope, ns, "structuredDeserialize", structured_deserialize, context_id);
    register(scope, ns, "structuredDiscard", structured_discard, context_id);
    register(scope, ns, "structuredExport", structured_export, context_id);
    register(scope, ns, "structuredImport", structured_import, context_id);
}

// A value serialized: its bytes — the descriptions' length (four bytes, little-endian) and serialization, none where
// it holds no platform object, then the value's — the memory of the SharedArrayBuffers it shares, by their places, and
// the ArrayBuffers its transfer list names: until they are detached (`structuredTransfer`) the buffers, then their
// memory, which the value read back is made new buffers over — in whatever realm reads it — and the compiled modules
// of the WebAssembly.Modules it shares, by their places.
#[derive(Default)]
pub(crate) struct Serialized {
    bytes: Vec<u8>,
    shared: Vec<v8::SharedRef<v8::BackingStore>>,
    buffers: Vec<v8::Global<v8::ArrayBuffer>>,
    transferred: Vec<v8::SharedRef<v8::BackingStore>>,
    modules: Vec<Arc<v8::CompiledWasmModule>>,
    // (…and, where it shares any, the key of the agent cluster it was serialized in: realm_location.rs
    // `agent_cluster_key`)
    cluster: Option<String>,
}

type Descriptions = Rc<RefCell<Vec<v8::Global<v8::Value>>>>;
type Shared = Rc<RefCell<Vec<v8::SharedRef<v8::BackingStore>>>>;
type Modules = Rc<RefCell<Vec<Arc<v8::CompiledWasmModule>>>>;

// The serializer's delegate: the bindings' hook (none for plain data), what it said of the object V8 last asked about —
// V8 asks whether an object is a host object, then has it written, one after the other — every description written,
// the SharedArrayBuffers kept where they may be shared (an agent cluster that is cross-origin isolated), the
// WebAssembly.Modules' compiled modules kept where they may be shared (`ModuleRule`), and this realm's
// %Object.prototype%, which an ordinary object of it has.
struct Serializer<'h> {
    hook: Option<v8::Local<'h, v8::Function>>,
    asked: RefCell<Option<v8::Global<v8::Value>>>,
    described: Descriptions,
    shared: Option<Shared>,
    modules: ModuleRule,
    object_prototype: Option<v8::Local<'h, v8::Value>>,
}

// What a WebAssembly.Module serialized becomes (the WebAssembly JS API's serialization steps): its compiled module,
// shared — within the isolate, or across to another (`structuredExport`) — or a DataCloneError serialized for storage
// (a session history entry's state, an IndexedDB record).
#[derive(Clone)]
enum ModuleRule {
    Share(Modules),
    Refuse(&'static str),
}

impl ModuleRule {
    // …as `__dom.structuredSerialize` names it: 'storage', or anything else (shared).
    fn named(name: &str) -> Self {
        match name {
            "storage" => ModuleRule::Refuse("A WebAssembly.Module can not be serialized for storage."),
            _ => ModuleRule::Share(Modules::default()),
        }
    }
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

    // (…a WebAssembly.Module its compiled module, kept by its place, where it is shared: `ModuleRule`)
    fn get_wasm_module_transfer_id(&self, scope: &mut v8::PinScope<'_, '_>, module: v8::Local<v8::WasmModuleObject>) -> Option<u32> {
        let modules = match &self.modules {
            ModuleRule::Share(modules) => modules,
            ModuleRule::Refuse(words) => {
                let message = v8::String::new(scope, words)?;
                throw_dom_exception(scope, message, "DataCloneError");
                return None;
            }
        };
        let mut modules = modules.borrow_mut();
        modules.push(Arc::new(module.get_compiled_module()));
        Some(modules.len() as u32 - 1)
    }

    // An ordinary object of this realm — one whose prototype is its %Object.prototype%, or null — is no platform
    // object, and the hook is not asked (another realm's is the hook's to tell, as any object with another prototype).
    fn is_host_object<'s>(&self, scope: &mut v8::PinScope<'s, '_>, object: v8::Local<'s, v8::Object>) -> Option<bool> {
        let hook = self.hook?;
        let proto = object.get_prototype(scope)?;
        if proto.is_null() || self.object_prototype.is_some_and(|p| p == proto) {
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

// The deserializer's delegate: the platform objects the hook made, the SharedArrayBuffers' memory and the
// WebAssembly.Modules' compiled modules, by their places.
struct Deserializer {
    objects: Vec<v8::Global<v8::Object>>,
    shared: Vec<v8::SharedRef<v8::BackingStore>>,
    modules: Vec<Arc<v8::CompiledWasmModule>>,
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

    fn get_wasm_module_from_id<'s>(&self, scope: &mut v8::PinScope<'s, '_>, place: u32) -> Option<v8::Local<'s, v8::WasmModuleObject>> {
        v8::WasmModuleObject::from_compiled_module(scope, self.modules.get(place as usize)?)
    }
}

// A DOMException of this realm's, thrown.
pub(crate) fn throw_dom_exception(scope: &mut v8::PinScope<'_, '_>, message: v8::Local<'_, v8::String>, name: &str) {
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
// None where it threw. Each ArrayBuffer `transfer` lists is written as its place in the list, not its bytes.
fn write(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
    hook: Option<v8::Local<'_, v8::Function>>,
    shared: Option<Shared>,
    modules: ModuleRule,
    transfer: &[v8::Local<'_, v8::ArrayBuffer>],
) -> Option<(Vec<u8>, Vec<v8::Global<v8::Value>>)> {
    let described = Descriptions::default();
    let object_prototype = hook.and_then(|_| v8::Object::new(scope).get_prototype(scope));
    let delegate = Serializer { hook, asked: RefCell::new(None), described: described.clone(), shared, modules, object_prototype };
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

// StructuredSerialize `value`, `hook` answering for each object no ordinary one — None where it threw (V8's
// DataCloneError for a function or a symbol, the hook's for a platform object; a SharedArrayBuffer's but where `shared`
// keeps them, a WebAssembly.Module's where `modules` refuses it).
fn serialize(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
    hook: v8::Local<'_, v8::Function>,
    shared: Option<Shared>,
    modules: ModuleRule,
    transfer: &[v8::Local<'_, v8::ArrayBuffer>],
) -> Option<Vec<u8>> {
    let (bytes, described) = write(scope, value, Some(hook), shared, modules, transfer)?;
    let head = if described.is_empty() {
        Vec::new()
    } else {
        let descriptions: Vec<v8::Local<v8::Value>> = described.into_iter().map(|d| v8::Local::new(scope, d)).collect();
        let descriptions = v8::Array::new_with_elements(scope, &descriptions);
        write(scope, descriptions.into(), None, None, ModuleRule::named("storage"), &[])?.0
    };
    let mut out = Vec::with_capacity(4 + head.len() + bytes.len());
    out.extend_from_slice(&(head.len() as u32).to_le_bytes());
    out.extend_from_slice(&head);
    out.extend_from_slice(&bytes);
    Some(out)
}

// One value read from bytes, by V8's deserializer — each transferred ArrayBuffer the one `transferred` has at its place.
fn read<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    bytes: &[u8],
    objects: Vec<v8::Global<v8::Object>>,
    shared: Vec<v8::SharedRef<v8::BackingStore>>,
    modules: Vec<Arc<v8::CompiledWasmModule>>,
    transferred: &[v8::Local<'_, v8::ArrayBuffer>],
) -> Option<v8::Local<'s, v8::Value>> {
    let deserializer = v8::ValueDeserializer::new(scope, Box::new(Deserializer { objects, shared, modules }), bytes);
    let context = scope.get_current_context();
    deserializer.read_header(context)?;
    for (place, buffer) in transferred.iter().enumerate() {
        deserializer.transfer_array_buffer(place as u32, *buffer);
    }
    deserializer.read_value(context)
}

// StructuredDeserialize `serialized` in the current realm, `hook(descriptions)` making the platform objects — an array
// of them, in the descriptions' order.
fn deserialize<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    serialized: Serialized,
    hook: v8::Local<'_, v8::Function>,
) -> Option<v8::Local<'s, v8::Value>> {
    let transferred: Vec<v8::Local<v8::ArrayBuffer>> =
        serialized.transferred.iter().map(|store| v8::ArrayBuffer::with_backing_store(scope, store)).collect();
    let bytes = &serialized.bytes;
    let split = 4 + u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
    let (head, body) = (bytes.get(4..split)?, bytes.get(split..)?);
    let mut objects = Vec::new();
    if !head.is_empty() {
        let descriptions = read(scope, head, Vec::new(), Vec::new(), Vec::new(), &[])?;
        let undefined = v8::undefined(scope).into();
        let made = v8::Local::<v8::Array>::try_from(hook.call(scope, undefined, &[descriptions])?).ok()?;
        for i in 0..made.length() {
            let object = made.get_index(scope, i).and_then(|o| v8::Local::<v8::Object>::try_from(o).ok())?;
            objects.push(v8::Global::new(scope, object));
        }
    }
    read(scope, body, objects, serialized.shared, serialized.modules, &transferred)
}

// The ArrayBuffers an array lists — None for anything else.
fn buffers<'s>(scope: &mut v8::PinScope<'s, '_>, list: v8::Local<'_, v8::Value>) -> Option<Vec<v8::Local<'s, v8::ArrayBuffer>>> {
    let Ok(list) = v8::Local::<v8::Array>::try_from(list) else { return Some(Vec::new()) };
    (0..list.length()).map(|i| list.get_index(scope, i).and_then(|b| v8::Local::<v8::ArrayBuffer>::try_from(b).ok())).collect()
}

// __dom.structuredSerialize(value, hook, mayShare, transfer, modules) -> the serialization's number: its
// SharedArrayBuffers shared where `mayShare`, its WebAssembly.Modules as `modules` names their rule (`ModuleRule`:
// 'storage', 'agent', else shared), and the ArrayBuffers `transfer` lists — none of them detached yet — written by their
// places. The number is the isolate's: any realm of it may read the value back, but one sharing modules a realm of the
// agent cluster it was serialized in alone (`structured_deserialize`).
fn structured_serialize(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(hook) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let shared = args.get(2).boolean_value(scope).then(Shared::default);
    let Some(transfer) = buffers(scope, args.get(3)) else { return };
    let rule = ModuleRule::named(&args.get(4).to_rust_string_lossy(scope));
    let Some(bytes) = serialize(scope, args.get(0), hook, shared.clone(), rule.clone(), &transfer) else { return };
    let shared = shared.map(|s| s.take()).unwrap_or_default();
    let modules = match rule {
        ModuleRule::Share(modules) => modules.take(),
        ModuleRule::Refuse(_) => Vec::new(),
    };
    let cluster = (!modules.is_empty()).then(|| {
        let cid = realm_id(scope, &args);
        crate::realm_location::agent_cluster_key(scope, cid)
    });
    let buffers = transfer.into_iter().map(|b| v8::Global::new(scope, b)).collect();
    let d = dom(scope);
    let number = d.next_serialized;
    d.next_serialized = number.wrapping_add(1);
    d.serialized.insert(number, Serialized { bytes, shared, buffers, modules, cluster, ..Default::default() });
    rv.set(v8::Integer::new_from_unsigned(scope, number).into());
}

// __dom.structuredTransfer(number, count): the ArrayBuffers its transfer list names detached — its first `count` of
// them, all for none given — their memory the serialization's: the bindings having checked again that each is still
// there to detach, and stopped at one that cannot be (a WebAssembly.Memory's).
fn structured_transfer(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(number) = args.get(0).uint32_value(scope) else { return };
    let count = if args.get(1).is_undefined() { None } else { args.get(1).uint32_value(scope) };
    let Some(serialized) = dom(scope).serialized.get_mut(&number) else { return };
    let mut buffers = std::mem::take(&mut serialized.buffers);
    buffers.truncate(count.map_or(buffers.len(), |c| c as usize));
    let mut transferred = Vec::with_capacity(buffers.len());
    for buffer in buffers {
        let buffer = v8::Local::new(scope, buffer);
        transferred.push(buffer.get_backing_store());
        buffer.detach(None);
    }
    if let Some(serialized) = dom(scope).serialized.get_mut(&number) {
        serialized.transferred = transferred;
    }
}

// __dom.structuredDeserialize(number, hook) -> the value that serialization holds, made in this realm, its transferred
// ArrayBuffers new ones over their memory; the serialization gone.
fn structured_deserialize(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(number) = args.get(0).uint32_value(scope) else { return };
    let Ok(hook) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let Some(serialized) = dom(scope).serialized.remove(&number) else { return };
    // (…a WebAssembly.Module's compiled module read back in the agent cluster it was serialized in alone: another's is
    // a DataCloneError — the WebAssembly JS API's deserialization steps — a message's `messageerror`)
    if let Some(cluster) = &serialized.cluster {
        let cid = realm_id(scope, &args);
        if crate::realm_location::agent_cluster_key(scope, cid) != *cluster {
            let Some(message) = v8::String::new(scope, "A WebAssembly.Module could not be read back in another agent cluster.") else { return };
            return throw_dom_exception(scope, message, "DataCloneError");
        }
    }
    if let Some(value) = deserialize(scope, serialized, hook) {
        rv.set(value);
    }
}

// __dom.structuredDiscard(number): a serialization let go unread (its transfer refused).
fn structured_discard(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if let Some(number) = args.get(0).uint32_value(scope) {
        dom(scope).serialized.remove(&number);
    }
}

// A serialization's bytes taken out of the isolate's keeping — one of plain data that shares and transfers nothing, as an
// IndexedDB record's value is (idb.rs) — and bytes kept again as one, to be read back by its number.
pub(crate) fn take_bytes(scope: &mut v8::PinScope<'_, '_>, number: u32) -> Option<Vec<u8>> {
    let serialized = dom(scope).serialized.remove(&number)?;
    Some(serialized.bytes)
}
pub(crate) fn keep_bytes(scope: &mut v8::PinScope<'_, '_>, bytes: Vec<u8>) -> u32 {
    let d = dom(scope);
    let number = d.next_serialized;
    d.next_serialized = number.wrapping_add(1);
    d.serialized.insert(number, Serialized { bytes, ..Default::default() });
    number
}

// The compiled modules of the WebAssembly.Modules serializations carried out of their isolates (`structuredExport`),
// by token: the process's, as the isolates they cross between are. Each is read by every import that names it — a
// broadcast's message is read once per channel — and let go of as the host drops it (`drop_modules_for_ruby`: a
// session's tokens, as its transfer tokens are, at its reset).
static MODULES: LazyLock<Mutex<(f64, HashMap<u64, Arc<v8::CompiledWasmModule>>)>> = LazyLock::new(Default::default);
fn modules() -> std::sync::MutexGuard<'static, (f64, HashMap<u64, Arc<v8::CompiledWasmModule>>)> {
    MODULES.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

// __dom.structuredExport(number) -> [bytes, buffers, modules, cluster]: a serialization taken out of the isolate — to
// another one, a worker's — its bytes an ArrayBuffer, its transferred ArrayBuffers new ones over their memory, and its
// WebAssembly.Modules' compiled modules by their tokens (`MODULES`) with the agent cluster it was serialized in, for the
// bindings to carry across (a message's own channel; RustyRacer.transferOut). It shares no SharedArrayBuffer, which no
// isolate here shares with another.
fn structured_export(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(number) = args.get(0).uint32_value(scope) else { return };
    let Some(serialized) = dom(scope).serialized.remove(&number) else { return };
    let store = v8::ArrayBuffer::new_backing_store_from_vec(serialized.bytes).make_shared();
    let bytes = v8::ArrayBuffer::with_backing_store(scope, &store).into();
    let buffers: Vec<v8::Local<v8::Value>> =
        serialized.transferred.iter().map(|store| v8::ArrayBuffer::with_backing_store(scope, store).into()).collect();
    let buffers = v8::Array::new_with_elements(scope, &buffers).into();
    let tokens: Vec<f64> = {
        let mut registry = modules();
        serialized
            .modules
            .into_iter()
            .map(|module| {
                registry.0 += 1.0;
                let token = registry.0;
                registry.1.insert(token as u64, module);
                token
            })
            .collect()
    };
    let tokens: Vec<v8::Local<v8::Value>> = tokens.into_iter().map(|t| v8::Number::new(scope, t).into()).collect();
    let tokens = v8::Array::new_with_elements(scope, &tokens).into();
    let cluster = match &serialized.cluster {
        Some(key) => v8::String::new(scope, key).map_or_else(|| v8::null(scope).into(), Into::into),
        None => v8::null(scope).into(),
    };
    rv.set(v8::Array::new_with_elements(scope, &[bytes, buffers, tokens, cluster]).into());
}

// __dom.structuredImport(bytes, buffers, modules, cluster, once) -> the number of a serialization another isolate
// exported: its bytes, its transferred ArrayBuffers' memory taken from `buffers` (each detached), and the compiled
// modules `modules` names by their tokens — let go of from `MODULES` where it is read `once` (a broadcast's is read by
// every channel) — of agent cluster `cluster`: to be read back as one serialized here (a token no longer held makes it
// one that cannot be).
fn structured_import(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(bytes) = v8::Local::<v8::ArrayBuffer>::try_from(args.get(0)) else { return };
    let Some(buffers) = buffers(scope, args.get(1)) else { return };
    let tokens = tokens(scope, args.get(2));
    let cluster = (!args.get(3).is_null_or_undefined()).then(|| args.get(3).to_rust_string_lossy(scope));
    let once = args.get(4).boolean_value(scope);
    let Some(modules) = ({
        let mut registry = modules();
        tokens.iter().map(|token| if once { registry.1.remove(token) } else { registry.1.get(token).cloned() }).collect::<Option<Vec<_>>>()
    }) else {
        return;
    };
    let length = bytes.byte_length();
    let bytes = match bytes.data() {
        Some(data) if length > 0 => unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, length) }.to_vec(),
        _ => Vec::new(),
    };
    let transferred = buffers
        .into_iter()
        .map(|buffer| {
            let store = buffer.get_backing_store();
            buffer.detach(None);
            store
        })
        .collect();
    let d = dom(scope);
    let number = d.next_serialized;
    d.next_serialized = number.wrapping_add(1);
    d.serialized.insert(number, Serialized { bytes, transferred, modules, cluster, ..Default::default() });
    rv.set(v8::Integer::new_from_unsigned(scope, number).into());
}

// The tokens an array lists, as numbers.
fn tokens(scope: &mut v8::PinScope<'_, '_>, list: v8::Local<'_, v8::Value>) -> Vec<u64> {
    let Ok(list) = v8::Local::<v8::Array>::try_from(list) else { return Vec::new() };
    (0..list.length()).filter_map(|i| list.get_index(scope, i)?.number_value(scope)).map(|n| n as u64).collect()
}

// — for the host — Native.wasm_modules_drop(tokens): the compiled modules exported under `tokens` let go of.
pub(crate) fn drop_modules_for_ruby(tokens: Vec<u64>) {
    let mut registry = modules();
    for token in tokens {
        registry.1.remove(&token);
    }
}
