// HTML's structured clone: StructuredSerializeWithTransfer and StructuredDeserializeWithTransfer, StructuredSerialize-
// ForStorage, and a serialization carried out of its isolate to another one.
//
// V8's own ValueSerializer writes the JavaScript values — primitives and their wrappers, Dates, RegExps, Maps, Sets,
// ArrayBuffers and their views, errors, arrays and ordinary objects, cycles and shared references kept — to bytes any
// realm of any isolate reads back. A platform object is the bindings' to say (structured-clone.js `cloneDescribe`), asked
// of every object that is no ordinary one: undefined for none (a page's class instance, which V8 writes as an ordinary
// object), what the object's serialization steps make of it — plain data, or, where it names platform objects (a
// FileList its Files), the pair `[data, named]`, each of `named` put there as its place among the value's, so a File the
// value holds besides, or another FileList names too, is one object read back — or a throw, a DataCloneError, for one that is not
// [Serializable]. The value is written with each platform object's place, and their data after it. Reading — where no
// script may run while V8 reads — their data is read back, and handed to the bindings (`cloneMake`), which make the
// platform objects of the reading realm, each after those it names; and then the value, each place the object made.
//
// The transfer list is the engine's to check and move: each a transferable — an ArrayBuffer, or one the bindings say is
// (`transferCheck`) — listed once, and not detached; the value serialized, an ArrayBuffer it lists written by its place
// in the list, and any other object it lists that the value holds; each checked again, and then moved, in the list's
// order — an ArrayBuffer's memory taken and the buffer detached, any other moved by the bindings (`transferMove`: a
// MessagePort onto a new port, the source neutered) — its counterpart held with the serialization. Reading it back,
// each is made the reading realm's (`transferReceive`) before the value is read.
//
// A serialization is kept here, by its number, until it is read back or let go of; one carried out of the isolate
// (`structuredExport`) is the process's, by its token, until another isolate brings it in (`structuredImport`) or the
// session it was made in ends (`clear`).

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};

use v8::{ValueDeserializerHelper, ValueSerializerHelper};

use crate::dom::{dom, host_step, realm, realm_id, register};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "structuredSerialize", structured_serialize, context_id);
    register(scope, ns, "structuredDeserialize", structured_deserialize, context_id);
    register(scope, ns, "structuredDiscard", structured_discard, context_id);
    register(scope, ns, "structuredBytes", structured_bytes, context_id);
    register(scope, ns, "structuredFromBytes", structured_from_bytes, context_id);
    register(scope, ns, "structuredExport", structured_export, context_id);
    register(scope, ns, "structuredImport", structured_import, context_id);
    register(scope, ns, "platformBrand", platform_brand_op, context_id);
}

// The brand of the bindings' platform objects: a private key (`Dom::platform_brand`), the isolate's, set on each as its
// slots are made (webidl.js `stampSlots`) — which a structured clone reads to tell one whose prototype a page set to
// %Object.prototype% or null from the ordinary object it then looks like, as Chrome and Firefox tell it by its internal
// slots. (A V8 private on a Proxy is refused: a legacy platform object's brand is its target's.)
fn platform_brand<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Private>> {
    if let Some(brand) = dom(scope).platform_brand.as_ref() {
        let brand = brand as *const v8::Global<v8::Private>;
        // SAFETY: the Dom keeps the global for the isolate's life.
        return Some(v8::Local::new(scope, unsafe { &*brand }));
    }
    let name = v8::String::new(scope, "csim#platform")?;
    let brand = v8::Private::for_api(scope, Some(name));
    dom(scope).platform_brand = Some(v8::Global::new(scope, brand));
    Some(brand)
}
// __dom.platformBrand(object): `object` branded a platform object.
fn platform_brand_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(object) = v8::Local::<v8::Object>::try_from(args.get(0)) else { return };
    if object.is_proxy() {
        return;
    }
    let Some(brand) = platform_brand(scope) else { return };
    let yes = v8::Boolean::new(scope, true).into();
    object.set_private(scope, brand, yes);
}

// What a serialization is for, as the bindings number it (`structuredSerialize`'s `mode`) — which says what it may
// share and transfer.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    // A value read back in its own agent — a structuredClone(), a message to a realm of the isolate: its
    // SharedArrayBuffers shared where the agent cluster is cross-origin isolated (else a DataCloneError), its
    // WebAssembly.Modules shared.
    Agent,
    // A message to another agent, a worker's or another window's isolate: no SharedArrayBuffer, nor a ReadableStream
    // transferred (the bindings' `transferCheck`); its WebAssembly.Modules shared, read back in the agent cluster it was
    // serialized in alone.
    //
    // (…no SharedArrayBuffer, though HTML shares one with a dedicated worker of a cross-origin isolated agent cluster:
    // a deliberate gap for now. Its memory could ride the registry as a transferred buffer's does, but a worker here is
    // run in lockstep with its window's virtual clock (worker_records.rs): a window's step waits for its workers to
    // catch up, so a worker parked in `Atomics.wait` for its page to `notify` — the very use a shared buffer is for —
    // never catches up, and the window waits on it, both stalled till the lockstep's guard. Its timeout would be real
    // time on a virtual clock besides. Sharing one needs the wait seen by the lockstep first — V8's atomics-wait
    // callback marking the worker parked, as a worker waiting on its inbox is — not the memory alone.)
    Across,
    // StructuredSerializeForStorage — a session history entry's state, an IndexedDB record, a document's persisted form
    // state: no SharedArrayBuffer and no WebAssembly.Module, nothing transferred.
    Storage,
}

impl Mode {
    fn numbered(n: u32) -> Self {
        match n {
            1 => Mode::Across,
            2 => Mode::Storage,
            _ => Mode::Agent,
        }
    }
}

// A value serialized: its bytes (`Written`); the memory of the SharedArrayBuffers it shares and the compiled modules of the
// WebAssembly.Modules it shares, by their places, with the key of the agent cluster it was serialized in where it
// shares any (realm_location.rs `agent_cluster_key`); and its transfer data holders, in the transfer list's order — of
// the realm that serialized it, whose counterparts the moved objects are: its context, not its number, which the next
// document of a navigable takes on.
#[derive(Default)]
pub(crate) struct Serialized {
    written: Written,
    shared: Vec<v8::SharedRef<v8::BackingStore>>,
    modules: Vec<Arc<v8::CompiledWasmModule>>,
    cluster: Option<String>,
    held: Vec<Held>,
    realm: Option<v8::Global<v8::Context>>,
}

impl Serialized {
    // The MessagePorts it moved.
    fn ports<'s>(&self, scope: &mut v8::PinScope<'s, '_>) -> Vec<v8::Local<'s, v8::Value>> {
        self.held
            .iter()
            .filter_map(|h| match h {
                Held::Moved { object, port: true } => Some(v8::Local::new(scope, object)),
                _ => None,
            })
            .collect()
    }
}

// A serialization's number as the bindings pass it — none for anything but a number (undefined is no serialization 0).
fn number_arg(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<u32> {
    if value.is_number() { value.uint32_value(scope) } else { None }
}

// A transfer data holder: an ArrayBuffer's memory, or the counterpart a transferable of the bindings' was moved onto —
// whether it is a MessagePort, which a message event lists in its `ports`.
enum Held {
    Buffer(v8::SharedRef<v8::BackingStore>),
    Moved { object: v8::Global<v8::Value>, port: bool },
}

type Shared = RefCell<Vec<v8::SharedRef<v8::BackingStore>>>;
type Modules = RefCell<Vec<Arc<v8::CompiledWasmModule>>>;

// A step of the bindings' (engine.js `hostSteps`, structured-clone.js) — looked up as it is first called, once per
// serialization: most values hold no platform object and transfer nothing.
struct Step {
    name: &'static str,
    function: RefCell<Option<v8::Global<v8::Function>>>,
}

impl Step {
    fn named(name: &'static str) -> Self {
        Step { name, function: RefCell::new(None) }
    }

    // …called with `args`: its answer, or None where it threw (or the realm has no such step: an Error thrown).
    fn call<'s>(&self, scope: &mut v8::PinScope<'s, '_>, args: &[v8::Local<'_, v8::Value>]) -> Option<v8::Local<'s, v8::Value>> {
        let known = self.function.borrow().as_ref().map(|f| v8::Local::new(scope, f));
        let function = match known {
            Some(function) => function,
            None => {
                let Some(function) = host_step(scope, self.name) else {
                    let message = v8::String::new(scope, &format!("No structured clone step {}.", self.name))?;
                    let error = v8::Exception::error(scope, message);
                    scope.throw_exception(error);
                    return None;
                };
                *self.function.borrow_mut() = Some(v8::Global::new(scope, function));
                function
            }
        };
        let undefined = v8::undefined(scope).into();
        function.call(scope, undefined, args)
    }
}

// How a platform object is written in the value's place: the place of the transferable it is in the transfer list, or
// its place among the value's platform objects (`Platform`).
const TRANSFERRED: u32 = 0;
const PLATFORM: u32 = 1;

// What V8 asked last of an object it found to be a platform object — V8 asks whether an object is one, then has it
// written, one after the other.
enum Asked {
    Transferred(u32),
    Platform(u32),
}

// The platform objects a value holds, by their places in the order they were found — each with what its serialization
// steps made of it; and their places by identity hash, for an
// object named again (`place_of`) — made as the first is looked for: an object's identity hash is made as it is first
// asked for, which most values, naming none again, never need.
#[derive(Default)]
struct Platform {
    objects: Vec<v8::Global<v8::Object>>,
    described: Vec<v8::Global<v8::Value>>,
    by_hash: Option<HashMap<i32, Vec<u32>>>,
    // (…the places of those whose data names others: a description `[data, named]`)
    naming: Vec<u32>,
}

impl Platform {
    // (…the place of an object found before — one the value holds, named again by another's data, a FileList's every
    // File — by its identity hash, those of the same hash compared)
    fn place_of(&mut self, scope: &mut v8::PinScope<'_, '_>, object: v8::Local<'_, v8::Object>) -> Option<u32> {
        if self.by_hash.is_none() {
            let mut by_hash: HashMap<i32, Vec<u32>> = HashMap::new();
            for (place, found) in self.objects.iter().enumerate() {
                by_hash.entry(v8::Local::new(scope, found).get_identity_hash().get()).or_default().push(place as u32);
            }
            self.by_hash = Some(by_hash);
        }
        let places = self.by_hash.as_ref()?.get(&object.get_identity_hash().get())?;
        places.iter().copied().find(|&place| v8::Local::new(scope, &self.objects[place as usize]) == object)
    }

    // …and a new one found, at the next place.
    fn add(&mut self, scope: &mut v8::PinScope<'_, '_>, object: v8::Local<'_, v8::Object>, description: v8::Local<'_, v8::Value>) -> u32 {
        let place = self.objects.len() as u32;
        self.objects.push(v8::Global::new(scope, object));
        self.described.push(v8::Global::new(scope, description));
        if let Some(by_hash) = self.by_hash.as_mut() {
            by_hash.entry(object.get_identity_hash().get()).or_default().push(place);
        }
        if description.is_array() {
            self.naming.push(place);
        }
        place
    }
}

// The serializer's delegate: the bindings' step that describes a platform object, what was found of the object V8 last
// asked about, the objects the transfer list holds other than ArrayBuffers by their places, the platform objects found,
// the SharedArrayBuffers kept where they may be shared, the WebAssembly.Modules' compiled modules kept where they may be
// shared (`ModuleRule`), this realm's %Object.prototype%, which an ordinary object of it has, and the bindings' brand —
// and whether what it writes is platform objects' data, which names none but in its `named`, each a place by then.
struct Serializer<'h> {
    describe: &'h Step,
    asked: RefCell<Option<Asked>>,
    listed: &'h [(u32, v8::Local<'h, v8::Object>)],
    platform: &'h RefCell<Platform>,
    data: bool,
    shared: Option<&'h Shared>,
    modules: ModuleRule<'h>,
    object_prototype: Option<v8::Local<'h, v8::Value>>,
    brand: Option<v8::Local<'h, v8::Private>>,
}

impl Serializer<'_> {
    // The place of platform object `object`, described now at a new one — V8 hands the value's each once; none where it
    // is none (its description undefined), or describing it threw. Platform objects' data names none in place.
    fn platform_place(&self, scope: &mut v8::PinScope<'_, '_>, object: v8::Local<'_, v8::Object>) -> Option<Option<u32>> {
        if self.data {
            throw_data_clone_error(scope, "A platform object's data names a platform object but in its `[data, named]`.");
            return None;
        }
        let description = self.describe.call(scope, &[object.into()])?;
        if description.is_undefined() {
            return Some(None);
        }
        Some(Some(self.platform.borrow_mut().add(scope, object, description)))
    }
}

// What a WebAssembly.Module serialized becomes (the WebAssembly JS API's serialization steps): its compiled module,
// shared — within the isolate, or across to another — or a DataCloneError serialized for storage.
enum ModuleRule<'h> {
    Share(&'h Modules),
    Refuse,
}

impl v8::ValueSerializerImpl for Serializer<'_> {
    fn throw_data_clone_error<'s>(&self, scope: &mut v8::PinScope<'s, '_>, message: v8::Local<'s, v8::String>) {
        throw_dom_exception(scope, message, "DataCloneError");
    }

    fn has_custom_host_object(&self, _isolate: &v8::Isolate) -> bool {
        true
    }

    // (…a SharedArrayBuffer kept by its place where it may be shared, else a DataCloneError)
    fn get_shared_array_buffer_id<'s>(
        &self,
        scope: &mut v8::PinScope<'s, '_>,
        buffer: v8::Local<'s, v8::SharedArrayBuffer>,
    ) -> Option<u32> {
        let Some(shared) = self.shared else {
            throw_data_clone_error(scope, "A SharedArrayBuffer could not be cloned.");
            return None;
        };
        let mut shared = shared.borrow_mut();
        shared.push(buffer.get_backing_store());
        Some(shared.len() as u32 - 1)
    }

    // (…a WebAssembly.Module its compiled module, kept by its place, where it is shared: `ModuleRule`)
    fn get_wasm_module_transfer_id(&self, scope: &mut v8::PinScope<'_, '_>, module: v8::Local<v8::WasmModuleObject>) -> Option<u32> {
        let ModuleRule::Share(modules) = self.modules else {
            throw_data_clone_error(scope, "A WebAssembly.Module can not be serialized for storage.");
            return None;
        };
        let mut modules = modules.borrow_mut();
        modules.push(Arc::new(module.get_compiled_module()));
        Some(modules.len() as u32 - 1)
    }

    // A transferable the list holds is a platform object, written by its place — whatever its prototype was set to; an
    // ordinary object of this realm — one whose prototype is its %Object.prototype%, or null — is none, and the
    // bindings are not asked; any other object is the bindings' to tell (another realm's ordinary object among them).
    fn is_host_object<'s>(&self, scope: &mut v8::PinScope<'s, '_>, object: v8::Local<'s, v8::Object>) -> Option<bool> {
        let asked = match self.listed.iter().find(|(_, listed)| *listed == object) {
            Some(&(place, _)) => Asked::Transferred(place),
            None => {
                let proto = object.get_prototype(scope)?;
                if proto.is_null() || self.object_prototype.is_some_and(|p| p == proto) {
                    // (…but a platform object whose prototype a page set so, which its brand tells — not its prototype,
                    // as Chrome and Firefox tell it by its internal slots: the bindings' (`platform_brand`), or a Node's
                    // handle)
                    if self.brand.is_some_and(|brand| object.has_private(scope, brand) == Some(true)) {
                        return match self.platform_place(scope, object)? {
                            Some(place) => {
                                *self.asked.borrow_mut() = Some(Asked::Platform(place));
                                Some(true)
                            }
                            None => Some(false),
                        };
                    }
                    if object.internal_field_count() > 0 && crate::node_handle::handle_of(scope, object.into()).is_some() {
                        throw_data_clone_error(scope, "A Node could not be cloned.");
                        return None;
                    }
                    return Some(false);
                }
                match self.platform_place(scope, object)? {
                    Some(place) => Asked::Platform(place),
                    None => return Some(false),
                }
            }
        };
        *self.asked.borrow_mut() = Some(asked);
        Some(true)
    }

    // (…an object of V8's own — a native legacy platform object, a FileList — is written without V8 asking first: the
    // bindings are asked here, and one they have nothing for is no structured-clone value)
    fn write_host_object<'s>(
        &self,
        scope: &mut v8::PinScope<'s, '_>,
        object: v8::Local<'s, v8::Object>,
        serializer: &dyn v8::ValueSerializerHelper,
    ) -> Option<bool> {
        let asked = self.asked.borrow_mut().take();
        let asked = match asked {
            Some(asked) => asked,
            None => match self.platform_place(scope, object)? {
                Some(place) => Asked::Platform(place),
                None => {
                    throw_data_clone_error(scope, "An object could not be cloned.");
                    return None;
                }
            },
        };
        match asked {
            Asked::Transferred(place) => {
                serializer.write_uint32(TRANSFERRED);
                serializer.write_uint32(place);
            }
            Asked::Platform(place) => {
                serializer.write_uint32(PLATFORM);
                serializer.write_uint32(place);
            }
        }
        Some(true)
    }
}

// The deserializer's delegate: the transferables' counterparts in this realm by their places (none for an ArrayBuffer's),
// the platform objects made by theirs (none yet as their data is read), and the SharedArrayBuffers' memory and the
// WebAssembly.Modules' compiled modules by theirs.
struct Deserializer<'a> {
    received: &'a [Option<v8::Global<v8::Value>>],
    made: Option<v8::Local<'a, v8::Array>>,
    shared: Vec<v8::SharedRef<v8::BackingStore>>,
    modules: Vec<Arc<v8::CompiledWasmModule>>,
}

impl v8::ValueDeserializerImpl for Deserializer<'_> {
    fn read_host_object<'s>(
        &self,
        scope: &mut v8::PinScope<'s, '_>,
        deserializer: &dyn v8::ValueDeserializerHelper,
    ) -> Option<v8::Local<'s, v8::Object>> {
        let (mut how, mut place) = (0, 0);
        if !deserializer.read_uint32(&mut how) || !deserializer.read_uint32(&mut place) {
            return None;
        }
        let object = if how == TRANSFERRED {
            v8::Local::new(scope, self.received.get(place as usize)?.as_ref()?)
        } else {
            self.made?.get_index(scope, place)?
        };
        v8::Local::<v8::Object>::try_from(object).ok()
    }

    fn get_shared_array_buffer_from_id<'s>(&self, scope: &mut v8::PinScope<'s, '_>, place: u32) -> Option<v8::Local<'s, v8::SharedArrayBuffer>> {
        let store = self.shared.get(place as usize)?;
        Some(v8::SharedArrayBuffer::with_backing_store(scope, store))
    }

    fn get_wasm_module_from_id<'s>(&self, scope: &mut v8::PinScope<'s, '_>, place: u32) -> Option<v8::Local<'s, v8::WasmModuleObject>> {
        v8::WasmModuleObject::from_compiled_module(scope, self.modules.get(place as usize)?)
    }
}

// A DOMException of this realm's, thrown — made by its bindings' own constructor (dom-exception.js `newDOMException`), not
// whatever a page has put at `globalThis.DOMException`; an Error where the realm has no bindings.
pub(crate) fn throw_dom_exception(scope: &mut v8::PinScope<'_, '_>, message: v8::Local<'_, v8::String>, name: &str) {
    let exception = match (host_step(scope, "newDOMException"), v8::String::new(scope, name)) {
        (Some(make), Some(name)) => {
            let undefined = v8::undefined(scope).into();
            // (…a step that threw, its exception the one thrown)
            let Some(exception) = make.call(scope, undefined, &[message.into(), name.into()]) else { return };
            exception
        }
        _ => v8::Exception::error(scope, message),
    };
    scope.throw_exception(exception);
}
// …a DataCloneError in `words`.
fn throw_data_clone_error(scope: &mut v8::PinScope<'_, '_>, words: &str) {
    if let Some(message) = v8::String::new(scope, words) {
        throw_dom_exception(scope, message, "DataCloneError");
    }
}

// The bytes of a value with its platform objects (`write`): each platform object's data — how many there are and the
// length of their stream (four bytes each, little-endian), the order they are made in (their places, four bytes each:
// each after those its data names), and the stream, each one's data one V8 value after another, in the order they were
// found; none at all for a value that holds no platform object — and the value's own, as V8's serializer wrote them,
// kept apart: no copy of them made to join the two but for storage (`joined`).
#[derive(Default)]
struct Written {
    entries: Vec<u8>,
    main: Vec<u8>,
}

impl Written {
    // …as one run of bytes, as storage keeps them: the entries — a count of none for no platform object — then the value.
    fn joined(self) -> Vec<u8> {
        let entries = if self.entries.is_empty() { 0u32.to_le_bytes().to_vec() } else { self.entries };
        let mut out = Vec::with_capacity(entries.len() + self.main.len());
        out.extend_from_slice(&entries);
        out.extend_from_slice(&self.main);
        out
    }

    // …and such a run apart again (None for one too short to hold what it says it does).
    fn split(bytes: &[u8]) -> Option<Self> {
        let word = |at: usize| -> Option<usize> { Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?) as usize) };
        let count = word(0)?;
        let at = if count == 0 { 4 } else { 8 + 4 * count + word(4)? };
        let entries = if count == 0 { Vec::new() } else { bytes.get(..at)?.to_vec() };
        Some(Written { entries, main: bytes.get(at..)?.to_vec() })
    }
}

// A value's bytes with its platform objects, by V8's serializer: each ArrayBuffer of `buffers` written as its place in
// the transfer list — in a platform object's data too (an ImageData's pixels: HTML's sub-serialization of its `data`
// with the value's memory, so a transferred buffer is the one the object is read back over, as Firefox has it; Chrome
// copies) — and each object of `listed` as its own. None where it threw.
fn write(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
    buffers: &[(u32, v8::Local<'_, v8::ArrayBuffer>)],
    listed: &[(u32, v8::Local<'_, v8::Object>)],
    shared: Option<&Shared>,
    modules: ModuleRule<'_>,
) -> Option<Written> {
    let describe = Step::named("cloneDescribe");
    let platform = RefCell::new(Platform::default());
    let object_prototype = v8::Object::new(scope).get_prototype(scope);
    let brand = platform_brand(scope);
    let delegate = |modules, data| Serializer { describe: &describe, asked: RefCell::new(None), listed, platform: &platform, data, shared, modules, object_prototype, brand };
    let serializer = v8::ValueSerializer::new(scope, Box::new(delegate(modules, false)));
    serializer.write_header();
    for &(place, buffer) in buffers {
        serializer.transfer_array_buffer(place, buffer);
    }
    let context = scope.get_current_context();
    serializer.write_value(context, value)?;
    let main = serializer.release();
    if platform.borrow().objects.is_empty() {
        return Some(Written { entries: Vec::new(), main });
    }
    let mut named: Vec<Vec<u32>> = Vec::new();
    // (…the platform objects each one's data names put as their places — one not found before described at a new one,
    // whose own may name more)
    let mut at = 0;
    loop {
        // (…the borrow let go of before the next is described: `place_named` adds)
        let next = platform.borrow().naming.get(at).copied();
        let Some(place) = next else { break };
        let description = v8::Local::new(scope, &platform.borrow().described[place as usize]);
        let description = v8::Local::<v8::Array>::try_from(description).ok()?;
        let places = place_named(scope, description, &platform)?;
        named.resize(platform.borrow().objects.len(), Vec::new());
        named[place as usize] = places;
        at += 1;
    }
    named.resize(platform.borrow().objects.len(), Vec::new());
    let serializer = v8::ValueSerializer::new(scope, Box::new(delegate(ModuleRule::Refuse, true)));
    serializer.write_header();
    for &(place, buffer) in buffers {
        serializer.transfer_array_buffer(place, buffer);
    }
    for place in 0..named.len() as u32 {
        let description = v8::Local::new(scope, &platform.borrow().described[place as usize]);
        let context = scope.get_current_context();
        serializer.write_value(context, description)?;
    }
    let stream = serializer.release();
    let mut order = Vec::with_capacity(named.len());
    let mut placed = vec![false; named.len()];
    for place in 0..named.len() {
        make_order(&named, place, &mut placed, &mut order);
    }
    let mut entries = Vec::with_capacity(8 + 4 * order.len() + stream.len());
    entries.extend_from_slice(&(order.len() as u32).to_le_bytes());
    entries.extend_from_slice(&(stream.len() as u32).to_le_bytes());
    for place in order {
        entries.extend_from_slice(&place.to_le_bytes());
    }
    entries.extend_from_slice(&stream);
    Some(Written { entries, main })
}
// (…the platform objects a description `[data, named]` names, each put in `named` as its place — found before, or
// described at a new one, all those not found described in one call of the bindings' (`cloneDescribeAll`); a
// DataCloneError for anything that is no [Serializable] platform object — and those places)
fn place_named(scope: &mut v8::PinScope<'_, '_>, description: v8::Local<'_, v8::Array>, platform: &RefCell<Platform>) -> Option<Vec<u32>> {
    let Ok(list) = v8::Local::<v8::Array>::try_from(description.get_index(scope, 1)?) else { return Some(Vec::new()) };
    let mut places: Vec<Option<u32>> = Vec::with_capacity(list.length() as usize);
    let mut unknown = Vec::new();
    for i in 0..list.length() {
        let Some(object) = list.get_index(scope, i).and_then(|o| v8::Local::<v8::Object>::try_from(o).ok()) else {
            throw_data_clone_error(scope, "An object could not be cloned.");
            return None;
        };
        let found = platform.borrow_mut().place_of(scope, object);
        if found.is_none() {
            unknown.push(object.into());
        }
        places.push(found);
    }
    if !unknown.is_empty() {
        let objects = v8::Array::new_with_elements(scope, &unknown);
        let described = Step::named("cloneDescribeAll").call(scope, &[objects.into()])?;
        let described = v8::Local::<v8::Array>::try_from(described).ok()?;
        let mut next = 0;
        for i in 0..list.length() {
            if places[i as usize].is_some() {
                continue;
            }
            let object = v8::Local::<v8::Object>::try_from(objects.get_index(scope, next)?).ok()?;
            let description = described.get_index(scope, next)?;
            next += 1;
            // (…one the same `named` lists again found once it is described)
            let found = platform.borrow_mut().place_of(scope, object);
            places[i as usize] = Some(match found {
                Some(place) => place,
                None if description.is_undefined() => {
                    throw_data_clone_error(scope, "An object could not be cloned.");
                    return None;
                }
                None => platform.borrow_mut().add(scope, object, description),
            });
        }
    }
    let places: Vec<u32> = places.into_iter().map(|p| p.unwrap_or(0)).collect();
    for (i, &place) in places.iter().enumerate() {
        list.set_index(scope, i as u32, v8::Integer::new_from_unsigned(scope, place).into());
    }
    Some(places)
}
// (…the order the platform objects are made in as they are read back: each after those its data names, each once — a
// cycle among them, which no data a platform object's steps make holds, made as it is reached)
fn make_order(named: &[Vec<u32>], place: usize, placed: &mut [bool], order: &mut Vec<u32>) {
    if placed[place] {
        return;
    }
    placed[place] = true;
    for &n in &named[place] {
        make_order(named, n as usize, placed, order);
    }
    order.push(place as u32);
}

// One value read from bytes, by V8's deserializer — each transferred ArrayBuffer the one `buffers` has at its place,
// each other transferable the one `received` has, each platform object the one `made` has.
fn read_value<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    bytes: &[u8],
    buffers: &[(u32, v8::Local<'_, v8::ArrayBuffer>)],
    received: &[Option<v8::Global<v8::Value>>],
    made: Option<v8::Local<'_, v8::Array>>,
    shared: Vec<v8::SharedRef<v8::BackingStore>>,
    modules: Vec<Arc<v8::CompiledWasmModule>>,
) -> Option<v8::Local<'s, v8::Value>> {
    let delegate = Deserializer { received, made, shared, modules };
    let deserializer = v8::ValueDeserializer::new(scope, Box::new(delegate), bytes);
    let context = scope.get_current_context();
    deserializer.read_header(context)?;
    for &(place, buffer) in buffers {
        deserializer.transfer_array_buffer(place, buffer);
    }
    deserializer.read_value(context)
}

// …and a value with its platform objects (`write`'s bytes): their data read back — one stream, no script run while V8
// reads it — then made objects of this realm by the bindings, in one call (`cloneMake`: each in the order written, its
// `named` places the objects made of them); then the value.
fn read<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    written: &Written,
    buffers: &[(u32, v8::Local<'_, v8::ArrayBuffer>)],
    received: &[Option<v8::Global<v8::Value>>],
    shared: Vec<v8::SharedRef<v8::BackingStore>>,
    modules: Vec<Arc<v8::CompiledWasmModule>>,
) -> Option<v8::Local<'s, v8::Value>> {
    let mut made = None;
    if !written.entries.is_empty() {
        let bytes = &written.entries;
        let word = |at: usize| -> Option<u32> { Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?)) };
        let count = word(0)? as usize;
        let order: Vec<u32> = (0..count).map(|i| word(8 + 4 * i)).collect::<Option<_>>()?;
        let mut described = Vec::with_capacity(count);
        {
            let delegate = Deserializer { received, made: None, shared: Vec::new(), modules: Vec::new() };
            let deserializer = v8::ValueDeserializer::new(scope, Box::new(delegate), bytes.get(8 + 4 * count..)?);
            let context = scope.get_current_context();
            deserializer.read_header(context)?;
            for &(place, buffer) in buffers {
                deserializer.transfer_array_buffer(place, buffer);
            }
            for _ in 0..count {
                described.push(deserializer.read_value(context)?);
            }
        }
        let described = v8::Array::new_with_elements(scope, &described);
        // (…the objects made kept in an array with no hole — each place undefined till its object is made — so no page's
        // indexed setter on Array.prototype is met as one is put in, and it is read back as fast as it is written)
        let undefined: v8::Local<v8::Value> = v8::undefined(scope).into();
        let objects = v8::Array::new_with_elements(scope, &vec![undefined; count]);
        // (…the order written passed but where it is another than the one they were found in: no data names one)
        let order: v8::Local<v8::Value> = if order.iter().enumerate().all(|(i, &p)| p as usize == i) {
            v8::undefined(scope).into()
        } else {
            let order: Vec<v8::Local<v8::Value>> = order.into_iter().map(|p| v8::Integer::new_from_unsigned(scope, p).into()).collect();
            v8::Array::new_with_elements(scope, &order).into()
        };
        Step::named("cloneMake").call(scope, &[described.into(), order, objects.into()])?;
        made = Some(objects);
    }
    read_value(scope, &written.main, buffers, received, made, shared, modules)
}

// A transferable of the transfer list: an ArrayBuffer, or an object the bindings move — a MessagePort or another.
enum Listed<'s> {
    Buffer(v8::Local<'s, v8::ArrayBuffer>),
    Object { object: v8::Local<'s, v8::Object>, port: bool },
}

// What the bindings' `transferCheck` answers of a transferable of theirs: a MessagePort, or another.
const PORT: u32 = 1;

// StructuredSerializeWithTransfer's checks of the transfer list `list` (an array, none for anything else), before the
// value is serialized: each a transferable — not a SharedArrayBuffer — listed once, and not detached; None where one is
// not (a DataCloneError thrown).
fn listed<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    list: v8::Local<'_, v8::Value>,
    across: bool,
    check: &Step,
) -> Option<Vec<Listed<'s>>> {
    let Ok(list) = v8::Local::<v8::Array>::try_from(list) else { return Some(Vec::new()) };
    let mut checked: Vec<Listed<'s>> = Vec::with_capacity(list.length() as usize);
    for i in 0..list.length() {
        let item = list.get_index(scope, i)?;
        let Ok(object) = v8::Local::<v8::Object>::try_from(item) else {
            throw_data_clone_error(scope, "Value is not a transferable object.");
            return None;
        };
        let twice = checked.iter().any(|c| match c {
            Listed::Buffer(buffer) => *buffer == object,
            Listed::Object { object: o, .. } => *o == object,
        });
        if twice {
            throw_data_clone_error(scope, "A transferable was listed more than once.");
            return None;
        }
        if let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(item) {
            if buffer.was_detached() {
                throw_data_clone_error(scope, "An ArrayBuffer is detached and could not be transferred.");
                return None;
            }
            checked.push(Listed::Buffer(buffer));
        } else {
            let across = v8::Boolean::new(scope, across).into();
            let kind = check.call(scope, &[item, across])?;
            checked.push(Listed::Object { object, port: kind.uint32_value(scope) == Some(PORT) });
        }
    }
    Some(checked)
}

// …and the transfer itself, once the value is serialized: each checked again — a getter of the value's may have moved
// or detached one — and moved, in the list's order: an ArrayBuffer's memory taken and the buffer detached (DetachArray-
// Buffer's TypeError for one that cannot be, a WebAssembly.Memory's), any other moved by the bindings onto its
// counterpart. One that fails leaves those before it moved, and those after it not.
fn transfer(scope: &mut v8::PinScope<'_, '_>, list: Vec<Listed<'_>>, across: bool, check: &Step) -> Option<Vec<Held>> {
    let moving = Step::named("transferMove");
    let mut held = Vec::with_capacity(list.len());
    for listed in list {
        match listed {
            Listed::Buffer(buffer) => {
                if buffer.was_detached() {
                    throw_data_clone_error(scope, "An ArrayBuffer is detached and could not be transferred.");
                    return None;
                }
                if !buffer.is_detachable() {
                    let message = v8::String::new(scope, "An ArrayBuffer that cannot be detached could not be transferred.")?;
                    let error = v8::Exception::type_error(scope, message);
                    scope.throw_exception(error);
                    return None;
                }
                let store = buffer.get_backing_store();
                buffer.detach(None);
                held.push(Held::Buffer(store));
            }
            Listed::Object { object, port } => {
                let across = v8::Boolean::new(scope, across).into();
                check.call(scope, &[object.into(), across])?;
                let moved = moving.call(scope, &[object.into()])?;
                held.push(Held::Moved { object: v8::Global::new(scope, moved), port });
            }
        }
    }
    Some(held)
}

// __dom.structuredSerialize(value, transfer, mode) -> the serialization's number: StructuredSerializeWithTransfer of
// `value` with the transfer list `transfer` (none where it is no array), as `mode` says (`Mode`: 0 within the agent, 1
// to another, 2 for storage). The number is the isolate's: any realm of it may read the value back — one sharing
// SharedArrayBuffers or WebAssembly.Modules a realm of the agent cluster it was serialized in alone.
fn structured_serialize(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let mode = Mode::numbered(args.get(2).uint32_value(scope).unwrap_or(0));
    let across = mode == Mode::Across;
    let check = Step::named("transferCheck");
    let Some(list) = listed(scope, args.get(1), across, &check) else { return };
    let buffers: Vec<(u32, v8::Local<v8::ArrayBuffer>)> = list
        .iter()
        .enumerate()
        .filter_map(|(place, l)| match l {
            Listed::Buffer(buffer) => Some((place as u32, *buffer)),
            Listed::Object { .. } => None,
        })
        .collect();
    let objects: Vec<(u32, v8::Local<v8::Object>)> = list
        .iter()
        .enumerate()
        .filter_map(|(place, l)| match l {
            Listed::Object { object, .. } => Some((place as u32, *object)),
            Listed::Buffer(_) => None,
        })
        .collect();
    let shared = (mode == Mode::Agent && realm(scope, cid).location.cross_origin_isolated()).then(Shared::default);
    let modules = Modules::default();
    let rule = if mode == Mode::Storage { ModuleRule::Refuse } else { ModuleRule::Share(&modules) };
    let Some(written) = write(scope, args.get(0), &buffers, &objects, shared.as_ref(), rule) else { return };
    let Some(held) = transfer(scope, list, across, &check) else { return };
    let shared = shared.map(RefCell::into_inner).unwrap_or_default();
    let modules = modules.into_inner();
    let cluster = (!modules.is_empty() || !shared.is_empty()).then(|| crate::realm_location::agent_cluster_key(scope, cid));
    let realm = Some(v8::Global::new(scope, scope.get_current_context()));
    let number = keep(scope, Serialized { written, shared, modules, cluster, held, realm });
    rv.set(v8::Integer::new_from_unsigned(scope, number).into());
}

// A serialization kept, by its new number.
fn keep(scope: &mut v8::PinScope<'_, '_>, serialized: Serialized) -> u32 {
    let d = dom(scope);
    let number = d.next_serialized;
    d.next_serialized = number.wrapping_add(1);
    d.serialized.insert(number, serialized);
    number
}

// The MessagePorts a serialization moved let go of — closed, through the bindings — as it is read back in no realm.
fn abandon(scope: &mut v8::PinScope<'_, '_>, ports: &[v8::Local<'_, v8::Value>]) {
    let abandon = Step::named("transferAbandon");
    for &port in ports {
        abandon.call(scope, &[port]);
    }
}

// __dom.structuredDeserialize(number, ports) -> the value serialization `number` holds, made in this realm — and, where
// `ports`, `[value, ports]`: the MessagePorts it transferred, in the transfer list's order, a message event's `ports` —
// StructuredDeserializeWithTransfer: each transferable made this realm's first, an ArrayBuffer a new one over its
// memory, any other by the bindings (`transferReceive`, told whether this is the realm that moved it). The serialization
// is gone. One that cannot be read back here throws, the ports it moved closed: a WebAssembly.Module's compiled module,
// and a SharedArrayBuffer's memory, read back in another agent cluster than it was serialized in — the WebAssembly JS
// API's deserialization steps, HTML StructuredDeserialize's for a SharedArrayBuffer ("if targetRealm's corresponding
// agent cluster is not serialized.[[AgentCluster]]") — a message's `messageerror`.
fn structured_deserialize(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(number) = number_arg(scope, args.get(0)) else { return };
    let with_ports = args.get(1).boolean_value(scope);
    let cid = realm_id(scope, &args);
    let Some(serialized) = dom(scope).serialized.remove(&number) else { return };
    if let Some(cluster) = &serialized.cluster {
        if crate::realm_location::agent_cluster_key(scope, cid) != *cluster {
            let ports = serialized.ports(scope);
            abandon(scope, &ports);
            let what = if serialized.modules.is_empty() { "SharedArrayBuffer" } else { "WebAssembly.Module" };
            return throw_data_clone_error(scope, &format!("A {what} could not be read back in another agent cluster."));
        }
    }
    // (…a step that throws leaves the ports received so far to be closed — after it, with its exception caught: no
    // script runs with one pending — and then its exception thrown again; a script terminated meanwhile, none run)
    let mut ports = Vec::new();
    let read = {
        v8::tc_scope!(let tc, scope);
        let read = receive_and_read(tc, serialized, &mut ports).map(|value| v8::Global::new(tc, value));
        if read.is_none() && !tc.has_terminated() {
            let held: Vec<v8::Local<v8::Value>> = ports.iter().map(|p| v8::Local::new(tc, p)).collect();
            abandon(tc, &held);
        }
        if read.is_none() {
            tc.rethrow();
        }
        read
    };
    let Some(value) = read else { return };
    let value = v8::Local::new(scope, value);
    let ports: Vec<v8::Local<v8::Value>> = ports.iter().map(|p| v8::Local::new(scope, p)).collect();
    if with_ports {
        let ports = v8::Array::new_with_elements(scope, &ports).into();
        rv.set(v8::Array::new_with_elements(scope, &[value, ports]).into());
    } else {
        rv.set(value);
    }
}
// …its transferables received, each MessagePort put in `ports` as it is, and the value read.
fn receive_and_read<'s>(scope: &mut v8::PinScope<'s, '_>, serialized: Serialized, ports: &mut Vec<v8::Global<v8::Value>>) -> Option<v8::Local<'s, v8::Value>> {
    let context = scope.get_current_context();
    let here = serialized.realm.as_ref().is_some_and(|realm| v8::Local::new(scope, realm) == context);
    let here = v8::Boolean::new(scope, here).into();
    let receive = Step::named("transferReceive");
    let mut buffers = Vec::new();
    let mut received = Vec::with_capacity(serialized.held.len());
    for (place, held) in serialized.held.into_iter().enumerate() {
        match held {
            Held::Buffer(store) => {
                buffers.push((place as u32, v8::ArrayBuffer::with_backing_store(scope, &store)));
                received.push(None);
            }
            Held::Moved { object, port } => {
                let object = v8::Local::new(scope, object);
                let object = receive.call(scope, &[object, here])?;
                let object = v8::Global::new(scope, object);
                if port {
                    ports.push(object.clone());
                }
                received.push(Some(object));
            }
        }
    }
    read(scope, &serialized.written, &buffers, &received, serialized.shared, serialized.modules)
}

// __dom.structuredDiscard(number): a serialization let go of unread — a message the target origin turned away, one held
// for a port that went on — the ports it moved closed.
fn structured_discard(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(number) = number_arg(scope, args.get(0)) else { return };
    if let Some(serialized) = dom(scope).serialized.remove(&number) {
        let ports = serialized.ports(scope);
        abandon(scope, &ports);
    }
}

// A serialization's bytes taken out of the isolate's keeping — one serialized for storage, which shares and transfers
// nothing — and bytes kept again as one, to be read back by its number: an IndexedDB record's value (idb.rs), and
// (`structuredBytes`, `structuredFromBytes`) what the host keeps of a session history entry's state and a document's
// persisted form state.
pub(crate) fn take_bytes(scope: &mut v8::PinScope<'_, '_>, number: u32) -> Option<Vec<u8>> {
    let serialized = dom(scope).serialized.remove(&number)?;
    Some(serialized.written.joined())
}
pub(crate) fn keep_bytes(scope: &mut v8::PinScope<'_, '_>, bytes: &[u8]) -> u32 {
    let written = Written::split(bytes).unwrap_or_default();
    keep(scope, Serialized { written, ..Default::default() })
}

// __dom.structuredBytes(number) -> the bytes of a serialization for storage, as a Uint8Array; it is gone.
fn structured_bytes(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(number) = number_arg(scope, args.get(0)) else { return };
    let Some(bytes) = take_bytes(scope, number) else { return };
    let length = bytes.len();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
    if let Some(view) = v8::Uint8Array::new(scope, buffer, 0, length) {
        rv.set(view.into());
    }
}

// __dom.structuredFromBytes(bytes) -> the number of the serialization `bytes` (a Uint8Array) are, kept to be read back.
fn structured_from_bytes(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(args.get(0)) else { return };
    let mut bytes = vec![0; view.byte_length()];
    view.copy_contents(&mut bytes);
    let number = keep_bytes(scope, &bytes);
    rv.set(v8::Integer::new_from_unsigned(scope, number).into());
}

// A serialization carried out of its isolate, to be brought into another — the process's, as the isolates it crosses
// between are: its bytes, the compiled modules of the WebAssembly.Modules it shares with the agent cluster it was
// serialized in, and what it transferred — an ArrayBuffer's memory, or the form a transferable of the bindings' crosses
// in (`transferForm`: a MessagePort's channel end, an ImageBitmap's pixels), all of them written in `forms`, by their
// places, as data. Of the session's partition (lib.rs `session_partition_new`), let go of with it; read once.
struct Exported {
    partition: u64,
    written: Written,
    modules: Vec<Arc<v8::CompiledWasmModule>>,
    cluster: Option<String>,
    carried: Vec<Carried>,
    forms: Written,
}

enum Carried {
    Buffer(SendStore),
    Form { port: bool },
}

// An ArrayBuffer's memory between isolates. A SharedRef<BackingStore> is not Send — a BackingStore is Send but not Sync
// — but the registry only moves it between threads under its lock, the exporter's thread putting it in and the
// importer's taking it out, never sharing a reference to it across them; and a shared_ptr's count is atomic, so it may
// be dropped on either.
struct SendStore(v8::SharedRef<v8::BackingStore>);
unsafe impl Send for SendStore {}

#[derive(Default)]
struct Exports {
    last: u64,
    by_token: HashMap<u64, Exported>,
}
static EXPORTS: LazyLock<Mutex<Exports>> = LazyLock::new(Default::default);
fn exports() -> MutexGuard<'static, Exports> {
    EXPORTS.lock().unwrap_or_else(PoisonError::into_inner)
}

// __dom.structuredExport(number, partition, broadcast) -> the token of serialization `number` carried out of the
// isolate, of session `partition`: each transferable it moved but an ArrayBuffer given the form it crosses in. It shares
// no SharedArrayBuffer (`Mode::Across`: a deliberate gap, see there). A broadcast's (`broadcast`) — read by however many
// channels, whenever each is reached, which no registry here could count off — is no token but the serialization itself,
// the wire's to hold and let go of (`broadcast_wire`).
//
// The forms are made those of the transferables but MessagePorts first — the steps that can fail — and each port's
// channel end last, which gives the port up to the host: a step that fails before closes the ports, one after takes each
// end given back into this isolate and closes it, so no end is left with the host that no isolate will take; its
// exception thrown again (a script terminated meanwhile, nothing run).
fn structured_export(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(number) = number_arg(scope, args.get(0)) else { return };
    let partition = args.get(1).integer_value(scope).unwrap_or(0) as u64;
    let broadcast = args.get(2).boolean_value(scope);
    let Some(serialized) = dom(scope).serialized.remove(&number) else { return };
    if broadcast {
        return broadcast_wire(scope, serialized, &mut rv);
    }
    let Serialized { written, modules, cluster, held, .. } = serialized;
    let made = {
        v8::tc_scope!(let tc, scope);
        let mut forms: Vec<Option<v8::Global<v8::Value>>> = (0..held.len()).map(|_| None).collect();
        let made = export_forms(tc, &held, &mut forms);
        if made.is_none() {
            if !tc.has_terminated() {
                take_back(tc, &held, &forms);
            }
            tc.rethrow();
        }
        made
    };
    let Some(forms) = made else { return };
    let carried = held
        .into_iter()
        .map(|h| match h {
            Held::Buffer(store) => Carried::Buffer(SendStore(store)),
            Held::Moved { port, .. } => Carried::Form { port },
        })
        .collect();
    let exported = Exported { partition, written, modules, cluster, carried, forms };
    let token = {
        let mut exports = exports();
        exports.last += 1;
        let token = exports.last;
        exports.by_token.insert(token, exported);
        token
    };
    rv.set(v8::Number::new(scope, token as f64).into());
}
// …the forms, as `structured_export` makes them, written; each made put in `forms` by its place as it is.
fn export_forms(scope: &mut v8::PinScope<'_, '_>, held: &[Held], forms: &mut [Option<v8::Global<v8::Value>>]) -> Option<Written> {
    if held.iter().all(|h| matches!(h, Held::Buffer(_))) {
        return Some(Written::default());
    }
    let form = Step::named("transferForm");
    for ports in [false, true] {
        for (place, h) in held.iter().enumerate() {
            if let Held::Moved { object, port } = h {
                if *port == ports {
                    let object = v8::Local::new(scope, object);
                    let made = form.call(scope, &[object])?;
                    forms[place] = Some(v8::Global::new(scope, made));
                }
            }
        }
    }
    let forms: Vec<v8::Local<v8::Value>> =
        forms.iter().map(|f| f.as_ref().map_or_else(|| v8::null(scope).into(), |f| v8::Local::new(scope, f))).collect();
    let forms = v8::Array::new_with_elements(scope, &forms).into();
    write(scope, forms, &[], &[], None, ModuleRule::Refuse)
}
// …and, where they could not all be made, each MessagePort closed: one whose channel end was given up taken back first.
fn take_back(scope: &mut v8::PinScope<'_, '_>, held: &[Held], forms: &[Option<v8::Global<v8::Value>>]) {
    let from_form = Step::named("transferFromForm");
    let mut ports = Vec::new();
    for (h, form) in held.iter().zip(forms) {
        let Held::Moved { object, port: true } = h else { continue };
        let port = match form {
            Some(form) => {
                let form = v8::Local::new(scope, form);
                from_form.call(scope, &[form])
            }
            None => Some(v8::Local::new(scope, object)),
        };
        ports.extend(port);
    }
    abandon(scope, &ports);
}

// A broadcast's wire (`structured_export`): its serialization as one run of bytes, base64 — the key of the agent cluster
// it was serialized in (its length, four bytes little-endian, then its UTF-8; none for one sharing no WebAssembly.Module),
// how many WebAssembly.Modules it shares, each one's wire bytes (length, then bytes), compiled again where it is read
// back — and then the value's (`Written::joined`). A DataCloneError where it is too long for a string.
fn broadcast_wire(scope: &mut v8::PinScope<'_, '_>, serialized: Serialized, rv: &mut v8::ReturnValue<'_, v8::Value>) {
    debug_assert!(serialized.held.is_empty(), "a broadcast transfers nothing");
    let cluster = serialized.cluster.unwrap_or_default();
    let mut out = Vec::new();
    out.extend_from_slice(&(cluster.len() as u32).to_le_bytes());
    out.extend_from_slice(cluster.as_bytes());
    out.extend_from_slice(&(serialized.modules.len() as u32).to_le_bytes());
    for module in &serialized.modules {
        let wire = module.get_wire_bytes_ref();
        out.extend_from_slice(&(wire.len() as u32).to_le_bytes());
        out.extend_from_slice(wire);
    }
    out.extend_from_slice(&serialized.written.joined());
    let Some(text) = v8::String::new(scope, &crate::data_url::base64_encode(&out)) else {
        return throw_data_clone_error(scope, "The message is too large to be broadcast.");
    };
    rv.set(text.into());
}
// …and one read back in this isolate: the serialization, its modules compiled here; None for bytes no broadcast wrote.
fn broadcast_read(scope: &mut v8::PinScope<'_, '_>, text: &str) -> Option<Serialized> {
    let bytes = data_url::forgiving_base64::decode_to_vec(text.as_bytes()).ok()?;
    let mut rest: &[u8] = &bytes;
    let mut take = |length: usize| -> Option<&[u8]> {
        let (part, after) = (rest.get(..length)?, rest.get(length..)?);
        rest = after;
        Some(part)
    };
    let length = u32::from_le_bytes(take(4)?.try_into().ok()?) as usize;
    let cluster = String::from_utf8(take(length)?.to_vec()).ok().filter(|c| !c.is_empty());
    let count = u32::from_le_bytes(take(4)?.try_into().ok()?) as usize;
    let mut modules = Vec::with_capacity(count);
    for _ in 0..count {
        let length = u32::from_le_bytes(take(4)?.try_into().ok()?) as usize;
        let module = v8::WasmModuleObject::compile(scope, take(length)?)?;
        modules.push(Arc::new(module.get_compiled_module()));
    }
    let written = Written::split(rest)?;
    let realm = Some(v8::Global::new(scope, scope.get_current_context()));
    Some(Serialized { written, modules, cluster, realm, ..Default::default() })
}

// __dom.structuredImport(token) -> the number of the serialization another isolate carried out under `token` (a
// broadcast's, its wire's own text: `broadcast_read`), brought into this one as if this realm had made it: its
// transferred ArrayBuffers' memory, and each other transferable made of the form it crossed in (`transferFromForm`) —
// MessagePorts last, each taking its channel end: one that fails closes every port, taking the end of each not made
// yet, so none is left with the host. -1 for a token no longer held — read already, or its session ended — which is a
// message that cannot be read back.
fn structured_import(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    if args.get(0).is_string() {
        let text = args.get(0).to_rust_string_lossy(scope);
        let Some(serialized) = broadcast_read(scope, &text) else { return rv.set_int32(-1) };
        let number = keep(scope, serialized);
        return rv.set(v8::Integer::new_from_unsigned(scope, number).into());
    }
    let token = args.get(0).number_value(scope).unwrap_or(0.0) as u64;
    let Some(exported) = exports().by_token.remove(&token) else { return rv.set_int32(-1) };
    let Exported { written, modules, cluster, carried, forms, .. } = exported;
    let held = {
        v8::tc_scope!(let tc, scope);
        let mut made: Vec<Option<v8::Global<v8::Value>>> = (0..carried.len()).map(|_| None).collect();
        let forms = if forms.main.is_empty() { None } else { read(tc, &forms, &[], &[], Vec::new(), Vec::new()) };
        let forms = forms.and_then(|f| v8::Local::<v8::Array>::try_from(f).ok());
        let complete = import_forms(tc, &carried, forms, &mut made);
        if complete.is_none() {
            if !tc.has_terminated() {
                close_imported(tc, &carried, forms, &made);
            }
            tc.rethrow();
            return;
        }
        carried
            .into_iter()
            .zip(made)
            .map(|(c, made)| match (c, made) {
                (Carried::Buffer(store), _) => Held::Buffer(store.0),
                (Carried::Form { port }, Some(object)) => Held::Moved { object, port },
                (Carried::Form { .. }, None) => unreachable!("every form is made once import_forms completes"),
            })
            .collect()
    };
    let realm = Some(v8::Global::new(scope, scope.get_current_context()));
    let number = keep(scope, Serialized { written, shared: Vec::new(), modules, cluster, held, realm });
    rv.set(v8::Integer::new_from_unsigned(scope, number).into());
}
// …each transferable but an ArrayBuffer made of its form, those not MessagePorts first; each put in `made` as it is.
fn import_forms(
    scope: &mut v8::PinScope<'_, '_>,
    carried: &[Carried],
    forms: Option<v8::Local<'_, v8::Array>>,
    made: &mut [Option<v8::Global<v8::Value>>],
) -> Option<()> {
    let from_form = Step::named("transferFromForm");
    for ports in [false, true] {
        for (place, c) in carried.iter().enumerate() {
            if let Carried::Form { port } = c {
                if *port == ports {
                    let form = forms?.get_index(scope, place as u32)?;
                    let object = from_form.call(scope, &[form])?;
                    made[place] = Some(v8::Global::new(scope, object));
                }
            }
        }
    }
    Some(())
}
// …and, where they could not all be made, every MessagePort closed — one not made yet first taking its end.
fn close_imported(
    scope: &mut v8::PinScope<'_, '_>,
    carried: &[Carried],
    forms: Option<v8::Local<'_, v8::Array>>,
    made: &[Option<v8::Global<v8::Value>>],
) {
    let from_form = Step::named("transferFromForm");
    let mut ports = Vec::new();
    for (place, (c, made)) in carried.iter().zip(made).enumerate() {
        if !matches!(c, Carried::Form { port: true }) {
            continue;
        }
        let port = match made {
            Some(port) => Some(v8::Local::new(scope, port)),
            None => forms.and_then(|f| f.get_index(scope, place as u32)).and_then(|form| from_form.call(scope, &[form])),
        };
        ports.extend(port);
    }
    abandon(scope, &ports);
}

// A message's wire let go of unread — at a closed port's end, in the inbox of a worker that ended, to a service worker
// client that is gone: the serialization its token holds let go of with it, where it is session `partition`'s. A wire
// is workers.js `encodeMessage`'s, `{"k":<token>,"a":<time>}` — its token first, nothing else read of it; one whose
// token is a broadcast's text holds its serialization itself, and nothing here.
pub(crate) fn drop_wire(partition: u64, wire: &str) {
    let Some(token) = wire.strip_prefix("{\"k\":").map(|rest| rest.split(|c: char| !c.is_ascii_digit()).next().unwrap_or("")) else { return };
    let Ok(token) = token.parse::<u64>() else { return };
    let mut exports = exports();
    if exports.by_token.get(&token).is_some_and(|e| e.partition == partition) {
        exports.by_token.remove(&token);
    }
}

// The serializations session `partition`'s isolates carried out and none brought in — a message to a worker that ended
// first — let go of, as the session's other registries are (lib.rs `session_partition_clear`).
pub(crate) fn clear(partition: u64) {
    exports().by_token.retain(|_, exported| exported.partition != partition);
}

// — for the host — Native.structured_exports_held(partition) -> how many serializations session `partition`'s isolates
// carried out and none brought in yet: none, once every message is read or let go of.
pub(crate) fn exports_held_for_ruby(partition: u64) -> usize {
    exports().by_token.values().filter(|e| e.partition == partition).count()
}
// — for the host — Native.structured_drop(partition, wire): `drop_wire`.
pub(crate) fn drop_wire_for_ruby(partition: u64, wire: String) {
    drop_wire(partition, &wire);
}

#[cfg(test)]
mod tests {
    use super::make_order;

    // The order `make_order` makes the platform objects in.
    fn order(named: &[Vec<u32>]) -> Vec<u32> {
        let mut out = Vec::new();
        let mut placed = vec![false; named.len()];
        for place in 0..named.len() {
            make_order(named, place, &mut placed, &mut out);
        }
        out
    }

    #[test]
    fn makes_a_platform_object_after_the_objects_its_data_names() {
        // A FileList (0) naming a File (1) the value holds besides, and another FileList (2) naming it again.
        assert_eq!(order(&[vec![1], vec![], vec![1]]), vec![1, 0, 2]);
    }

    #[test]
    fn makes_each_once_whatever_names_it() {
        assert_eq!(order(&[vec![1, 2], vec![2], vec![], vec![0]]), vec![2, 1, 0, 3]);
    }
}
