// A DataTransfer's drag data store (HTML §6.11.2 "the drag data store"), the engine's: its item list — each item a
// string of a type or a file, kept in the order it was added — and its mode: read/write where its data is written (a
// script's own DataTransfer, a drag's `dragstart`), read-only where it is read (a `drop`, a paste), protected while it
// is carried over the page (the other drag events) — its formats listed, its data none — and gone once the drag is over
// ("no longer associated"). Beside it, the DataTransfer's dropEffect and effectAllowed and the current drag operation,
// which "fire a DND event" sets before and after each drag event (§6.11.5). A DataTransfer's object holds a handle on
// V8's C++ heap (`__dom.DragDataStoreBase`, as a canvas state's does: canvas_state.rs) that owns the store. The bindings
// (data-transfer.js) keep each file item's File and each item's DataTransferItem object, by the item's number.

use std::cell::RefCell;

use v8::cppgc::{GarbageCollected, Visitor};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (a node's is 1, … a selection's 6, a header list's 7).
const TAG: u16 = 8;
// What marks an object as a drag data store's (its internal field 0).
static BRAND: u8 = 0;

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Gone,
    ReadWrite,
    ReadOnly,
    Protected,
}
impl Mode {
    fn readable(self) -> bool {
        matches!(self, Mode::ReadWrite | Mode::ReadOnly)
    }
    fn name(self) -> Option<&'static str> {
        match self {
            Mode::Gone => None,
            Mode::ReadWrite => Some("read/write"),
            Mode::ReadOnly => Some("read-only"),
            Mode::Protected => Some("protected"),
        }
    }
    fn named(name: &str) -> Mode {
        match name {
            "read/write" => Mode::ReadWrite,
            "read-only" => Mode::ReadOnly,
            "protected" => Mode::Protected,
            _ => Mode::Gone,
        }
    }
}

// (…its type and data as the DOMStrings they were given, UTF-16: a lone surrogate is a character of one)
struct Item {
    number: u32,
    file: bool,
    kind_type: Vec<u16>,
    // (…a string item's; a file item's File is the bindings')
    data: Vec<u16>,
}

// dropEffect's values, and effectAllowed's — each the index of one.
const DROP_EFFECTS: [&str; 4] = ["none", "copy", "link", "move"];
const EFFECTS_ALLOWED: [&str; 9] = ["none", "copy", "copyLink", "copyMove", "link", "linkMove", "move", "all", "uninitialized"];
const NONE: u8 = 0;
const COPY: u8 = 1;
const LINK: u8 = 2;

struct Store {
    mode: Mode,
    items: Vec<Item>,
    next: u32,
    // (…bumped as the item list changes or the store goes: when HTML makes the `types` array anew)
    version: u32,
    drop_effect: u8,
    effect_allowed: u8,
    operation: u8,
}

fn ascii_lower(units: &[u16]) -> Vec<u16> {
    units.iter().map(|&u| if (u16::from(b'A')..=u16::from(b'Z')).contains(&u) { u + 32 } else { u }).collect()
}
fn is(units: &[u16], ascii: &str) -> bool {
    units.iter().copied().eq(ascii.bytes().map(u16::from))
}
// HTML: a format ASCII-lowercased, "text" as "text/plain" and "url" as "text/uri-list".
fn normalize_format(format: &[u16]) -> Vec<u16> {
    let f = ascii_lower(format);
    if is(&f, "text") {
        "text/plain".encode_utf16().collect()
    } else if is(&f, "url") {
        "text/uri-list".encode_utf16().collect()
    } else {
        f
    }
}

impl Store {
    fn changed(&mut self) {
        self.version = self.version.wrapping_add(1);
    }
    fn held(&self, number: u32) -> Option<&Item> {
        self.items.iter().find(|i| i.number == number)
    }
    // An item added in read/write mode — a string under its type ASCII-lowercased, a second string of that type refused
    // (the spec's NotSupportedError; Chrome adds it under the type as written) — its number.
    fn add(&mut self, file: bool, kind_type: &[u16], data: Vec<u16>) -> Result<u32, Refused> {
        if self.mode != Mode::ReadWrite {
            return Err(Refused::NotEditable);
        }
        let kind_type = ascii_lower(kind_type);
        if !file && self.items.iter().any(|i| !i.file && i.kind_type == kind_type) {
            return Err(Refused::Duplicate);
        }
        self.next += 1;
        self.items.push(Item { number: self.next, file, kind_type, data });
        self.changed();
        Ok(self.next)
    }
    // setData(): in read/write mode, the format's one string replaced — moved to the end of the list.
    fn set_data(&mut self, format: &[u16], data: Vec<u16>) {
        if self.mode != Mode::ReadWrite {
            return;
        }
        let kind_type = normalize_format(format);
        self.items.retain(|i| i.file || i.kind_type != kind_type);
        self.next += 1;
        self.items.push(Item { number: self.next, file: false, kind_type, data });
        self.changed();
    }
    // clearData(): in read/write mode, the format's string — or with no format every string, the files staying.
    fn clear_data(&mut self, format: Option<&[u16]>) {
        if self.mode != Mode::ReadWrite {
            return;
        }
        let kind_type = format.map(normalize_format);
        self.items.retain(|i| i.file || kind_type.as_ref().is_some_and(|t| *t != i.kind_type));
        self.changed();
    }
    // getData(): none once the store is gone or while protected; a "url" the first URL of its text/uri-list.
    fn get_data(&self, format: &[u16]) -> &[u16] {
        if !self.mode.readable() {
            return &[];
        }
        let kind_type = normalize_format(format);
        let Some(item) = self.items.iter().find(|i| !i.file && i.kind_type == kind_type) else { return &[] };
        if !is(&ascii_lower(format), "url") {
            return &item.data;
        }
        const LF: u16 = b'\n' as u16;
        const CR: u16 = b'\r' as u16;
        item.data.split(|&u| u == LF).map(|l| l.strip_suffix(&[CR]).unwrap_or(l)).find(|l| !l.is_empty() && l[0] != u16::from(b'#')).unwrap_or(&[])
    }
    // The `types` array: its strings' types, then "Files" for any file — none once the store is gone.
    fn types(&self) -> Vec<Vec<u16>> {
        if self.mode == Mode::Gone {
            return Vec::new();
        }
        let mut types: Vec<Vec<u16>> = self.items.iter().filter(|i| !i.file).map(|i| i.kind_type.clone()).collect();
        if self.items.iter().any(|i| i.file) {
            types.push("Files".encode_utf16().collect());
        }
        types
    }
    // "Fire a DND event" of `kind`, before it: the store's mode for it, and its dropEffect — "none" for dragstart, drag
    // and dragleave; for dragenter and dragover the effectAllowed's own (its first choice, "copy" where it allows any,
    // "link" for a link's drag of none in particular); for drop and dragend the current drag operation.
    fn begin(&mut self, kind: &str, link: bool) {
        self.mode = match kind {
            "dragstart" => Mode::ReadWrite,
            "drop" => Mode::ReadOnly,
            _ => Mode::Protected,
        };
        self.drop_effect = match kind {
            "dragenter" | "dragover" => match EFFECTS_ALLOWED[self.effect_allowed as usize] {
                "none" => NONE,
                "copy" | "copyLink" | "copyMove" | "all" => COPY,
                "link" | "linkMove" => LINK,
                "move" => 3,
                _ if link => LINK,
                _ => COPY,
            },
            "drop" | "dragend" => self.operation,
            _ => NONE,
        };
    }
    // …and after it: a dragover canceled makes the current drag operation its dropEffect where its effectAllowed allows
    // that ("none" otherwise), one not canceled — or a dragleave — makes it "none": the operation a drop happens on; a
    // drop canceled makes it the drop's dropEffect as it stood after, one not canceled "none" (no editable target takes
    // a default drop here) — what dragend reports. (A dragenter's cancellation picks the target, no operation.)
    fn end(&mut self, kind: &str, canceled: bool) {
        self.operation = match kind {
            "dragleave" => NONE,
            "dragover" if canceled && self.allows(self.drop_effect) => self.drop_effect,
            "dragover" => NONE,
            "drop" if canceled => self.drop_effect,
            "drop" => NONE,
            _ => self.operation,
        };
    }
    fn allows(&self, op: u8) -> bool {
        let allowed = EFFECTS_ALLOWED[self.effect_allowed as usize];
        op != NONE && (matches!(allowed, "all" | "uninitialized") || allowed.to_ascii_lowercase().contains(DROP_EFFECTS[op as usize]))
    }
}

enum Refused {
    NotEditable,
    Duplicate,
}

pub(crate) struct DragDataStoreHandle {
    store: RefCell<Store>,
}

unsafe impl GarbageCollected for DragDataStoreHandle {
    fn trace(&self, _visitor: &mut Visitor) {}
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"DragDataStoreHandle"
    }
}

// The constructor a DataTransfer's store object is made with (`__dom.DragDataStoreBase`): branded, a wrapper of a
// fresh handle — an empty store in read/write mode, dropEffect and effectAllowed "none".
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let store = Store { mode: Mode::ReadWrite, items: Vec::new(), next: 0, version: 0, drop_effect: NONE, effect_allowed: NONE, operation: NONE };
    let handle = DragDataStoreHandle { store: RefCell::new(store) };
    let heap = scope.get_cpp_heap().expect("DragDataStoreBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, DragDataStoreHandle>(scope, obj, &ptr);
    }
}

// The handle of a store argument (the brand first: `unwrap` reads garbage from an object it never wrapped).
fn handle<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h DragDataStoreHandle> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped a DragDataStoreHandle under TAG; the handle lives
    // while its object, the argument, does — through this op.
    unsafe { v8::Object::unwrap::<TAG, DragDataStoreHandle>(scope, obj) }.map(|p| unsafe { &*(p.as_ref() as *const DragDataStoreHandle) })
}

// `__dom.DragDataStoreBase`: the constructor of the isolate's template, made once per isolate.
fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let kept = crate::dom::dom(scope).drag_data_store_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "DragDataStoreBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).drag_data_store_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if let (Some(base), Some(name)) = (base_function(scope), v8::String::new(scope, "DragDataStoreBase")) {
        ns.set(scope, name.into(), base.into());
    }
    crate::dom::register(scope, ns, "dragStoreLength", length, context_id);
    crate::dom::register(scope, ns, "dragStoreSetMode", set_mode, context_id);
    crate::dom::register(scope, ns, "dragStoreItemAt", item_at, context_id);
    crate::dom::register(scope, ns, "dragStoreItem", item, context_id);
    crate::dom::register(scope, ns, "dragStoreText", text, context_id);
    crate::dom::register(scope, ns, "dragStoreAdd", add, context_id);
    crate::dom::register(scope, ns, "dragStoreRemove", remove, context_id);
    crate::dom::register(scope, ns, "dragStoreSetData", set_data, context_id);
    crate::dom::register(scope, ns, "dragStoreClearData", clear_data, context_id);
    crate::dom::register(scope, ns, "dragStoreGetData", get_data, context_id);
    crate::dom::register(scope, ns, "dragStoreTypes", types, context_id);
    crate::dom::register(scope, ns, "dragStoreFiles", files, context_id);
    crate::dom::register(scope, ns, "dragStoreEffect", effect, context_id);
    crate::dom::register(scope, ns, "dragStoreSetEffect", set_effect, context_id);
    crate::dom::register(scope, ns, "dragStoreBegin", begin, context_id);
    crate::dom::register(scope, ns, "dragStoreEnd", end, context_id);
}

fn string<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
}
fn mode_value<'s>(scope: &mut v8::PinScope<'s, '_>, mode: Mode) -> v8::Local<'s, v8::Value> {
    match mode.name() {
        Some(n) => string(scope, n),
        None => v8::null(scope).into(),
    }
}

// __dom.dragStoreLength(store) -> how many items it holds, none once it is gone.
fn length(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return rv.set_uint32(0) };
    let store = h.store.borrow();
    rv.set_uint32(if store.mode == Mode::Gone { 0 } else { store.items.len() as u32 });
}
// __dom.dragStoreSetMode(store, mode): the store put in `mode` (null: gone, the drag over).
fn set_mode(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let mode = args.get(1);
    let mode = if mode.is_null_or_undefined() { Mode::Gone } else { Mode::named(&mode.to_rust_string_lossy(scope)) };
    let mut store = h.store.borrow_mut();
    store.mode = mode;
    if mode == Mode::Gone {
        store.changed();
    }
}
// __dom.dragStoreItemAt(store, index) -> the number of the item at `index`, -1 for none (or the store gone).
fn item_at(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return rv.set_int32(-1) };
    let index = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let store = h.store.borrow();
    let number = if store.mode == Mode::Gone { None } else { store.items.get(index as usize).map(|i| i.number) };
    rv.set_double(number.map_or(-1.0, f64::from));
}
// __dom.dragStoreItem(store, number) -> [mode, file, type] of the item the store holds as `number`, null for one it no
// longer holds (or a store gone): a DataTransferItem's mode — disabled — and what it reads.
fn item(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return rv.set_null() };
    let number = args.get(1).uint32_value(scope).unwrap_or(0);
    let store = h.store.borrow();
    let Some(item) = store.held(number).filter(|_| store.mode != Mode::Gone) else { return rv.set_null() };
    let items = [mode_value(scope, store.mode), v8::Boolean::new(scope, item.file).into(), crate::dom::utf16_value(scope, &item.kind_type)];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.dragStoreText(store, number) -> the string item `number`'s data where the store's can be read, null otherwise.
fn text(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return rv.set_null() };
    let number = args.get(1).uint32_value(scope).unwrap_or(0);
    let store = h.store.borrow();
    match store.held(number).filter(|i| !i.file && store.mode.readable()) {
        Some(item) => rv.set(crate::dom::utf16_value(scope, &item.data)),
        None => rv.set_null(),
    }
}
// __dom.dragStoreAdd(store, file, type, data) -> the new item's number; -1 where the store is not read/write, -2 for a
// second string of a type.
fn add(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return rv.set_int32(-1) };
    let file = args.get(1).is_true();
    let kind_type = crate::dom::utf16_arg(scope, args.get(2));
    let data = if file { Vec::new() } else { crate::dom::utf16_arg(scope, args.get(3)) };
    match h.store.borrow_mut().add(file, &kind_type, data) {
        Ok(number) => rv.set_double(f64::from(number)),
        Err(Refused::NotEditable) => rv.set_int32(-1),
        Err(Refused::Duplicate) => rv.set_int32(-2),
    }
}
// __dom.dragStoreRemove(store, index) -> whether the store is read/write: the item at `index` removed (one past the end
// nothing) — or with no index, every item.
fn remove(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return rv.set_bool(false) };
    let index = args.get(1);
    let index = (!index.is_undefined()).then(|| index.uint32_value(scope).unwrap_or(u32::MAX) as usize);
    let mut store = h.store.borrow_mut();
    if store.mode != Mode::ReadWrite {
        return rv.set_bool(false);
    }
    match index {
        None => store.items.clear(),
        Some(i) if i < store.items.len() => {
            store.items.remove(i);
        }
        Some(_) => return rv.set_bool(true),
    }
    store.changed();
    rv.set_bool(true);
}
// __dom.dragStoreSetData(store, format, data): `Store::set_data`.
fn set_data(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let (format, data) = (crate::dom::utf16_arg(scope, args.get(1)), crate::dom::utf16_arg(scope, args.get(2)));
    h.store.borrow_mut().set_data(&format, data);
}
// __dom.dragStoreClearData(store, format): `Store::clear_data` (undefined: no format).
fn clear_data(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let format = args.get(1);
    let format = (!format.is_undefined()).then(|| crate::dom::utf16_arg(scope, format));
    h.store.borrow_mut().clear_data(format.as_deref());
}
// __dom.dragStoreGetData(store, format) -> `Store::get_data`.
fn get_data(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let format = crate::dom::utf16_arg(scope, args.get(1));
    let store = h.store.borrow();
    rv.set(crate::dom::utf16_value(scope, store.get_data(&format)));
}
// __dom.dragStoreTypes(store, version) -> the `types` array's strings, or null where `version` is the store's still
// (its array not made anew), and the version after: [version, …types].
fn types(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return rv.set_null() };
    let seen = args.get(1).uint32_value(scope);
    let store = h.store.borrow();
    if seen == Some(store.version) && args.get(1).is_number() {
        return rv.set_null();
    }
    let mut items: Vec<v8::Local<v8::Value>> = vec![v8::Integer::new_from_unsigned(scope, store.version).into()];
    for t in store.types() {
        items.push(crate::dom::utf16_value(scope, &t));
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.dragStoreFiles(store) -> the numbers of its file items, in order, where its data can be read; null otherwise.
fn files(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return rv.set_null() };
    let store = h.store.borrow();
    if !store.mode.readable() {
        return rv.set_null();
    }
    let items: Vec<v8::Local<v8::Value>> =
        store.items.iter().filter(|i| i.file).map(|i| v8::Integer::new_from_unsigned(scope, i.number).into()).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// What `__dom.dragStoreEffect` / `dragStoreSetEffect` name: dropEffect, effectAllowed, the current drag operation.
const DROP_EFFECT: u32 = 0;
const EFFECT_ALLOWED: u32 = 1;
const OPERATION: u32 = 2;
// __dom.dragStoreEffect(store, which) -> its value.
fn effect(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let which = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let store = h.store.borrow();
    let value = match which {
        DROP_EFFECT => DROP_EFFECTS[store.drop_effect as usize],
        EFFECT_ALLOWED => EFFECTS_ALLOWED[store.effect_allowed as usize],
        OPERATION => DROP_EFFECTS[store.operation as usize],
        _ => return,
    };
    rv.set(string(scope, value));
}
// __dom.dragStoreSetEffect(store, which, value, force): dropEffect set to one of its values, effectAllowed to one of its
// own in read/write mode (or `force`: a drag's own starts "uninitialized"); anything else ignored.
fn set_effect(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let which = args.get(1).uint32_value(scope).unwrap_or(u32::MAX);
    let value = args.get(2).to_rust_string_lossy(scope);
    let force = args.get(3).is_true();
    let mut store = h.store.borrow_mut();
    match which {
        DROP_EFFECT => {
            if let Some(i) = DROP_EFFECTS.iter().position(|v| *v == value) {
                store.drop_effect = i as u8;
            }
        }
        EFFECT_ALLOWED if force || store.mode == Mode::ReadWrite => {
            if let Some(i) = EFFECTS_ALLOWED.iter().position(|v| *v == value) {
                store.effect_allowed = i as u8;
            }
        }
        _ => {}
    }
}
// __dom.dragStoreBegin(store, type, link): `Store::begin`.
fn begin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let kind = args.get(1).to_rust_string_lossy(scope);
    h.store.borrow_mut().begin(&kind, args.get(2).is_true());
}
// __dom.dragStoreEnd(store, type, canceled): `Store::end`.
fn end(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let kind = args.get(1).to_rust_string_lossy(scope);
    h.store.borrow_mut().end(&kind, args.get(2).is_true());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store { mode: Mode::ReadWrite, items: Vec::new(), next: 0, version: 0, drop_effect: NONE, effect_allowed: NONE, operation: NONE }
    }

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn data_is_kept_by_format() {
        let mut s = store();
        s.set_data(&u("Text"), u("a"));
        s.set_data(&u("URL"), u("# c\r\nhttp://x/\r\nhttp://y/"));
        assert!(s.add(true, &u("IMAGE/PNG"), Vec::new()).is_ok());
        assert!(matches!(s.add(false, &u("TEXT/PLAIN"), u("b")), Err(Refused::Duplicate)));
        assert_eq!(s.types(), [u("text/plain"), u("text/uri-list"), u("Files")]);
        assert_eq!(s.get_data(&u("url")), u("http://x/"));
        assert_eq!(s.get_data(&u("text/uri-list")), u("# c\r\nhttp://x/\r\nhttp://y/"));
        // (…a lone surrogate kept as given)
        s.set_data(&[u16::from(b'x'), 0xdc00], vec![0xd800]);
        assert_eq!(s.get_data(&[u16::from(b'X'), 0xdc00]), [0xd800]);
        s.clear_data(None);
        assert_eq!(s.types(), [u("Files")]);
        s.mode = Mode::Protected;
        s.set_data(&u("text"), u("z"));
        assert!(s.get_data(&u("text")).is_empty());
        assert_eq!(s.types(), [u("Files")]);
    }

    #[test]
    fn a_drag_operation_follows_its_events() {
        let mut s = store();
        s.effect_allowed = 8;   // uninitialized
        s.begin("dragover", true);
        assert_eq!(s.drop_effect, LINK);
        s.drop_effect = COPY;
        s.end("dragover", true);
        assert_eq!(s.operation, COPY);
        s.effect_allowed = 6;   // move
        s.end("dragover", true);
        assert_eq!(s.operation, NONE);
        s.effect_allowed = 7;   // all
        s.end("dragover", true);
        s.begin("drop", false);
        assert!(s.mode == Mode::ReadOnly && s.drop_effect == COPY);
        s.end("drop", false);
        assert_eq!(s.operation, NONE);
    }
}
