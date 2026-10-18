// Indexed Database's storage (§2.1-2.7): keys and their order, an object store's records sorted by key with its key
// generator, an index's records sorted by key and then primary key, ranges of them, what a request retrieves and where a
// cursor moves next — and what a transaction wrote, which an abort puts back; and each store's and index's schema, its
// name and key path. The stores are their databases' (idb_databases.rs), in the one registry, each named by a number.
// The bindings (idb.js) keep the transactions, requests and events; they convert a page's values to keys and evaluate
// key paths (both read the page's objects), and a value reaches here serialized (clone.rs): its bytes.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ops::Bound;
use std::sync::Arc;

use crate::dom::register;
use crate::idb_databases::{lock, DbKey, Name, Registry};

// A key (§2.7): a number, a date (its time value), a string (UTF-16), binary, or an array of keys — and the two bounds a
// range of pairs is read between, which no key is.
#[derive(Clone, Debug)]
pub(crate) enum Key {
    Min,
    Number(f64),
    Date(f64),
    String(Vec<u16>),
    Binary(Vec<u8>),
    Array(Vec<Key>),
    Max,
}

impl Key {
    // "Compare two keys": by type — array > binary > string > date > number — then by value.
    fn rank(&self) -> u8 {
        match self {
            Key::Min => 0,
            Key::Number(_) => 1,
            Key::Date(_) => 2,
            Key::String(_) => 3,
            Key::Binary(_) => 4,
            Key::Array(_) => 5,
            Key::Max => 6,
        }
    }
}
impl Ord for Key {
    fn cmp(&self, other: &Key) -> Ordering {
        match (self, other) {
            (Key::Number(a), Key::Number(b)) | (Key::Date(a), Key::Date(b)) => a.partial_cmp(b).unwrap_or(Ordering::Equal),
            (Key::String(a), Key::String(b)) => a.cmp(b),
            (Key::Binary(a), Key::Binary(b)) => a.cmp(b),
            (Key::Array(a), Key::Array(b)) => a.cmp(b),
            _ => self.rank().cmp(&other.rank()),
        }
    }
}
impl PartialOrd for Key {
    fn partial_cmp(&self, other: &Key) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl PartialEq for Key {
    fn eq(&self, other: &Key) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Key {}

// A key range (§2.8): its bounds (none: unbounded) and whether each is open.
#[derive(Clone, Debug, Default)]
struct Range {
    lower: Option<Key>,
    upper: Option<Key>,
    lower_open: bool,
    upper_open: bool,
}

impl Range {
    // Whether `key` is in it ("in a key range"): not below an open lower bound or at it, nor above an upper.
    fn contains(&self, key: &Key) -> bool {
        let above_lower = self.lower.as_ref().is_none_or(|l| if self.lower_open { l < key } else { l <= key });
        let below_upper = self.upper.as_ref().is_none_or(|u| if self.upper_open { key < u } else { key <= u });
        above_lower && below_upper
    }
    // (…its lower and upper bounds as bounds of (key, primary key) pairs)
    fn lower_pair(&self) -> Bound<(Key, Key)> {
        match &self.lower {
            None => Bound::Unbounded,
            Some(l) if self.lower_open => Bound::Excluded((l.clone(), Key::Max)),
            Some(l) => Bound::Included((l.clone(), Key::Min)),
        }
    }
    fn upper_pair(&self) -> Bound<(Key, Key)> {
        match &self.upper {
            None => Bound::Unbounded,
            Some(u) if self.upper_open => Bound::Excluded((u.clone(), Key::Min)),
            Some(u) => Bound::Included((u.clone(), Key::Max)),
        }
    }
}

// A record: its value's bytes, and the keys it is indexed under in each index it is in — what deleting it takes out.
#[derive(Clone)]
struct Record {
    value: Arc<[u8]>,
    indexed: Vec<(u32, Vec<Key>)>,
}

// An index: its name, key path, `unique` and `multiEntry`, whether it holds the store's records yet (an index an
// upgrade makes is filled in its transaction's order, `idbPopulate`), and its records.
#[derive(Clone)]
struct Index {
    name: Name,
    key_path: KeyPath,
    unique: bool,
    multi_entry: bool,
    populated: bool,
    entries: BTreeSet<(Key, Key)>,
}

// A key path (§2.5): none, a string, or a list of strings.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum KeyPath {
    None,
    Path(Name),
    List(Vec<Name>),
}

// An object store: its database, name and key path, its records, its key generator's current number (none without one;
// infinite past 2^53), its indexes — those it has by name, and those deleted whose deletion has yet to run in their
// transaction's order (a write before it still kept to them) — and the journal of the transaction writing it.
pub(crate) struct Store {
    pub(crate) db: DbKey,
    pub(crate) name: Name,
    key_path: KeyPath,
    records: BTreeMap<Key, Record>,
    current: Option<f64>,
    indexes: HashMap<u32, Index>,
    index_names: BTreeMap<Name, u32>,
    journal: Option<Journal>,
}

impl Store {
    pub(crate) fn new(db: DbKey, name: Name, key_path: KeyPath, auto_increment: bool) -> Store {
        Store {
            db,
            name,
            key_path,
            records: BTreeMap::new(),
            current: auto_increment.then_some(1.0),
            indexes: HashMap::new(),
            index_names: BTreeMap::new(),
            journal: None,
        }
    }
}

// What a transaction found of a store before it wrote it, which an abort puts back: its key generator's number, and each
// record it wrote as it was (none: no record at that key) — the record's index entries with it. Only what the transaction
// touched is kept, so a write costs what it changes, not what the store holds.
struct Journal {
    tx: u32,
    current: Option<f64>,
    prior: BTreeMap<Key, Option<Record>>,
}

impl Journal {
    // (…begun on `st` by transaction `tx`: nothing written yet)
    fn of(st: &Store, tx: u32) -> Journal {
        Journal { tx, current: st.current, prior: BTreeMap::new() }
    }
}

// (…a copy — an upgrade's start — begins with no journal: what it puts back is the whole store)
impl Clone for Store {
    fn clone(&self) -> Store {
        Store {
            db: self.db.clone(),
            name: self.name.clone(),
            key_path: self.key_path.clone(),
            records: self.records.clone(),
            current: self.current,
            indexes: self.indexes.clone(),
            index_names: self.index_names.clone(),
            journal: None,
        }
    }
}

fn with<R>(f: impl FnOnce(&mut Registry) -> R) -> R {
    f(&mut lock())
}

const MAX_GENERATED: f64 = 9_007_199_254_740_992.0; // 2^53

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "idbKey", key_op, context_id);
    register(scope, ns, "idbCompare", compare_op, context_id);
    register(scope, ns, "idbInRange", in_range_op, context_id);
    register(scope, ns, "idbStore", store_info, context_id);
    register(scope, ns, "idbStoreLive", store_live, context_id);
    register(scope, ns, "idbIndexCreate", index_create, context_id);
    register(scope, ns, "idbIndexDelete", index_delete, context_id);
    register(scope, ns, "idbIndexRetire", index_retire, context_id);
    register(scope, ns, "idbIndexRename", index_rename, context_id);
    register(scope, ns, "idbIndexId", index_id, context_id);
    register(scope, ns, "idbIndex", index_info, context_id);
    register(scope, ns, "idbIndexLive", index_live, context_id);
    register(scope, ns, "idbWriteIndexes", write_indexes, context_id);
    register(scope, ns, "idbGenerator", generator, context_id);
    register(scope, ns, "idbPut", put, context_id);
    register(scope, ns, "idbDelete", delete, context_id);
    register(scope, ns, "idbRetrieve", retrieve, context_id);
    register(scope, ns, "idbCount", count, context_id);
    register(scope, ns, "idbCursor", cursor, context_id);
    register(scope, ns, "idbPopulate", populate, context_id);
    register(scope, ns, "idbJournal", journal, context_id);
}

// ── Names and key paths as the bindings hold them ───────────────────────────────────────────────────────────────────
// A name: a string's code units.
pub(crate) fn name_arg(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<Name> {
    let s = v8::Local::<v8::String>::try_from(value).ok()?;
    let mut units = vec![0u16; s.length()];
    s.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
    Some(units)
}
pub(crate) fn name_value<'s>(scope: &mut v8::PinScope<'s, '_>, name: &[u16]) -> v8::Local<'s, v8::Value> {
    v8::String::new_from_two_byte(scope, name, v8::NewStringType::Normal).map_or_else(|| v8::undefined(scope).into(), Into::into)
}
// …a key path: null, a string, or an array of strings.
pub(crate) fn key_path_arg(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> KeyPath {
    if let Ok(list) = v8::Local::<v8::Array>::try_from(value) {
        let names = (0..list.length()).filter_map(|i| list.get_index(scope, i).and_then(|v| name_arg(scope, v))).collect();
        return KeyPath::List(names);
    }
    name_arg(scope, value).map_or(KeyPath::None, KeyPath::Path)
}
fn key_path_value<'s>(scope: &mut v8::PinScope<'s, '_>, key_path: &KeyPath) -> v8::Local<'s, v8::Value> {
    match key_path {
        KeyPath::None => v8::null(scope).into(),
        KeyPath::Path(name) => name_value(scope, name),
        KeyPath::List(names) => {
            let items: Vec<v8::Local<v8::Value>> = names.iter().map(|n| name_value(scope, n)).collect();
            v8::Array::new_with_elements(scope, &items).into()
        }
    }
}
fn names_value<'s>(scope: &mut v8::PinScope<'s, '_>, names: Vec<Name>) -> v8::Local<'s, v8::Value> {
    let items: Vec<v8::Local<v8::Value>> = names.iter().map(|n| name_value(scope, n)).collect();
    v8::Array::new_with_elements(scope, &items).into()
}

// ── Keys as the bindings hold them ──────────────────────────────────────────────────────────────────────────────────
// A number, a string, `{ date: ms }`, `{ binary: Uint8Array }` — a holder of no prototype, its own property read, so
// nothing a page puts on `Object.prototype` makes one of another type — or an array of keys; anything else (undefined)
// none.
fn key_arg(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<Key> {
    if value.is_number() {
        return value.number_value(scope).map(Key::Number);
    }
    if let Ok(s) = v8::Local::<v8::String>::try_from(value) {
        let mut units = vec![0u16; s.length()];
        s.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
        return Some(Key::String(units));
    }
    if let Ok(array) = v8::Local::<v8::Array>::try_from(value) {
        let mut keys = Vec::with_capacity(array.length() as usize);
        for i in 0..array.length() {
            let item = array.get_index(scope, i)?;
            keys.push(key_arg(scope, item)?);
        }
        return Some(Key::Array(keys));
    }
    let object = v8::Local::<v8::Object>::try_from(value).ok()?;
    if let Some(d) = own(scope, object, "date") {
        return d.number_value(scope).map(Key::Date);
    }
    let b = own(scope, object, "binary")?;
    let view = v8::Local::<v8::ArrayBufferView>::try_from(b).ok()?;
    let mut bytes = vec![0u8; view.byte_length()];
    view.copy_contents(&mut bytes);
    Some(Key::Binary(bytes))
}
fn own<'s>(scope: &mut v8::PinScope<'s, '_>, object: v8::Local<'_, v8::Object>, name: &str) -> Option<v8::Local<'s, v8::Value>> {
    let name = v8::String::new(scope, name)?;
    if object.has_own_property(scope, name.into())? { object.get(scope, name.into()) } else { None }
}
fn key_value<'s>(scope: &mut v8::PinScope<'s, '_>, key: &Key) -> v8::Local<'s, v8::Value> {
    match key {
        Key::Number(n) => v8::Number::new(scope, *n).into(),
        Key::String(units) => v8::String::new_from_two_byte(scope, units, v8::NewStringType::Normal).map_or_else(|| v8::undefined(scope).into(), Into::into),
        Key::Array(keys) => {
            let items: Vec<v8::Local<v8::Value>> = keys.iter().map(|k| key_value(scope, k)).collect();
            v8::Array::new_with_elements(scope, &items).into()
        }
        Key::Date(ms) => {
            let value = v8::Number::new(scope, *ms).into();
            holder(scope, "date", value)
        }
        Key::Binary(bytes) => {
            let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes.clone()).make_shared();
            let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
            let view = v8::Uint8Array::new(scope, buffer, 0, bytes.len()).map_or_else(|| v8::undefined(scope).into(), Into::into);
            holder(scope, "binary", view)
        }
        Key::Min | Key::Max => v8::undefined(scope).into(),
    }
}
// (…a holder: of no prototype)
fn holder<'s>(scope: &mut v8::PinScope<'s, '_>, name: &str, value: v8::Local<'s, v8::Value>) -> v8::Local<'s, v8::Value> {
    let name = v8::String::new(scope, name).expect("a short string").into();
    let null = v8::null(scope).into();
    v8::Object::with_prototype_and_properties(scope, null, &[name], &[value]).into()
}
// …a range: `{ lower, upper, lowerOpen, upperOpen }`, an undefined bound unbounded.
fn range_arg(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Range {
    let Ok(object) = v8::Local::<v8::Object>::try_from(value) else { return Range::default() };
    let field = |name: &str| {
        let key = v8::String::new(scope, name).expect("a short string");
        object.get(scope, key.into()).unwrap_or_else(|| v8::undefined(scope).into())
    };
    let (lower, upper, lower_open, upper_open) = (field("lower"), field("upper"), field("lowerOpen"), field("upperOpen"));
    Range {
        lower: (!lower.is_undefined()).then(|| key_arg(scope, lower)).flatten(),
        upper: (!upper.is_undefined()).then(|| key_arg(scope, upper)).flatten(),
        lower_open: lower_open.is_true(),
        upper_open: upper_open.is_true(),
    }
}
fn id_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, i: i32) -> u32 {
    args.get(i).uint32_value(scope).unwrap_or(0)
}
// (…an index's number, where the source is one: -1 none)
fn index_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, i: i32) -> Option<u32> {
    let v = args.get(i).int32_value(scope).unwrap_or(-1);
    (v >= 0).then_some(v as u32)
}

// __dom.idbInRange(range, key) -> whether the key is in the range (`Range::contains`).
fn in_range_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let range = range_arg(scope, args.get(0));
    let Some(key) = key_arg(scope, args.get(1)) else { return };
    rv.set_bool(range.contains(&key));
}
// __dom.idbCompare(a, b) -> -1, 0 or 1: "compare two keys".
// __dom.idbKey(value, multiEntry) -> "convert a value to a key" (§2.7) — or, `multiEntry`, "… to a multiEntry key" — as
// the bindings hold one, undefined for "invalid"; whatever a Get of an Array's item throws thrown.
fn key_op<'s>(scope: &mut v8::PinScope<'s, '_>, args: v8::FunctionCallbackArguments<'s>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let input = args.get(0);
    let key = if args.get(1).is_true() { multi_entry_key(scope, input) } else { value_to_key(scope, input, &mut Vec::new()) };
    match key {
        Ok(Some(key)) => rv.set(key_value(scope, &key)),
        Ok(None) => rv.set_undefined(),
        Err(Thrown) => {}
    }
}
// (…an exception a page's getter threw, left pending for the caller)
struct Thrown;
// "Convert a value to a key": a number but NaN, a string, a date of a time value, a buffer source's bytes (a detached or
// shared one none), an Array exotic object's own items each converted — one missing, or the array among those it is
// inside (`seen`), invalid; anything else invalid (None).
fn value_to_key<'s>(scope: &mut v8::PinScope<'s, '_>, input: v8::Local<'s, v8::Value>, seen: &mut Vec<v8::Local<'s, v8::Value>>) -> Result<Option<Key>, Thrown> {
    if input.is_number() {
        let n = input.number_value(scope).unwrap_or(f64::NAN);
        return Ok((!n.is_nan()).then_some(Key::Number(n)));
    }
    if let Ok(s) = v8::Local::<v8::String>::try_from(input) {
        let mut units = vec![0u16; s.length()];
        s.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
        return Ok(Some(Key::String(units)));
    }
    if !input.is_object() || seen.iter().any(|v| v.strict_equals(input)) {
        return Ok(None);
    }
    if let Ok(date) = v8::Local::<v8::Date>::try_from(input) {
        let ms = date.value_of();
        return Ok((!ms.is_nan()).then_some(Key::Date(ms)));
    }
    if let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(input) {
        let buffer = view.buffer(scope);
        if buffer.is_none_or(|b| b.was_detached() || Into::<v8::Local<v8::Value>>::into(b).is_shared_array_buffer()) {
            return Ok(None);
        }
        let mut bytes = vec![0u8; view.byte_length()];
        view.copy_contents(&mut bytes);
        return Ok(Some(Key::Binary(bytes)));
    }
    if let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(input) {
        if buffer.was_detached() {
            return Ok(None);
        }
        let length = buffer.byte_length();
        let Some(view) = v8::Uint8Array::new(scope, buffer, 0, length) else { return Ok(None) };
        let mut bytes = vec![0u8; length];
        view.copy_contents(&mut bytes);
        return Ok(Some(Key::Binary(bytes)));
    }
    let Ok(array) = v8::Local::<v8::Array>::try_from(input) else { return Ok(None) };
    seen.push(input);
    let mut keys = Vec::with_capacity(array.length() as usize);
    for i in 0..array.length() {
        if !has_own_index(scope, array, i)? {
            return Ok(None);
        }
        let item = array.get_index(scope, i).ok_or(Thrown)?;
        let Some(key) = value_to_key(scope, item, seen)? else { return Ok(None) };
        keys.push(key);
    }
    seen.pop();
    Ok(Some(Key::Array(keys)))
}
// (…HasOwnProperty of an index, which a page's Proxy is not, an Array exotic object being none)
fn has_own_index(scope: &mut v8::PinScope<'_, '_>, array: v8::Local<'_, v8::Array>, i: u32) -> Result<bool, Thrown> {
    let name = v8::String::new(scope, &i.to_string()).ok_or(Thrown)?;
    array.has_own_property(scope, name.into()).ok_or(Thrown)
}
// …"convert a value to a multiEntry key": an Array exotic object's items each a key, the invalid and the repeated left
// out; anything else a key as above.
fn multi_entry_key<'s>(scope: &mut v8::PinScope<'s, '_>, input: v8::Local<'s, v8::Value>) -> Result<Option<Key>, Thrown> {
    let Ok(array) = v8::Local::<v8::Array>::try_from(input) else { return value_to_key(scope, input, &mut Vec::new()) };
    let mut seen = vec![input];
    let mut keys: Vec<Key> = Vec::new();
    for i in 0..array.length() {
        if !has_own_index(scope, array, i)? {
            continue;
        }
        let item = array.get_index(scope, i).ok_or(Thrown)?;
        if let Some(key) = value_to_key(scope, item, &mut seen)? {
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    Ok(Some(Key::Array(keys)))
}
fn compare_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(a), Some(b)) = (key_arg(scope, args.get(0)), key_arg(scope, args.get(1))) else { return };
    rv.set_int32(a.cmp(&b) as i32);
}

// ── Stores and indexes ──────────────────────────────────────────────────────────────────────────────────────────────
// __dom.idbStore(store) -> [name, keyPath, autoIncrement, index names]: a store's schema (undefined for none; a deleted
// store has no index names).
fn store_info(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let store = id_arg(scope, &args, 0);
    // (…a deleted one's index names none)
    let found = with(|s| {
        let live = s.store_live(store);
        s.stores.get(&store).map(|st| (st.name.clone(), st.key_path.clone(), st.current.is_some(), if live { st.index_names.keys().cloned().collect() } else { Vec::new() }))
    });
    let Some((name, key_path, auto_increment, index_names)) = found else { return };
    let items = [name_value(scope, &name), key_path_value(scope, &key_path), v8::Boolean::new(scope, auto_increment).into(), names_value(scope, index_names)];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.idbStoreLive(store) -> whether it is its database's still (not deleted).
fn store_live(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let store = id_arg(scope, &args, 0);
    rv.set_bool(with(|s| s.store_live(store)));
}
// __dom.idbIndexCreate(store, name, keyPath, unique, multiEntry) -> a new index's number, empty until `idbPopulate` (0
// where the store has one of the name).
fn index_create(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let store = id_arg(scope, &args, 0);
    let Some(name) = name_arg(scope, args.get(1)) else { return rv.set_uint32(0) };
    let key_path = key_path_arg(scope, args.get(2));
    let (unique, multi_entry) = (args.get(3).is_true(), args.get(4).is_true());
    let id = with(|s| {
        if s.stores.get(&store).is_none_or(|st| st.index_names.contains_key(&name)) {
            return 0;
        }
        let id = s.next_id();
        let st = s.stores.get_mut(&store).expect("looked up");
        st.index_names.insert(name.clone(), id);
        st.indexes.insert(id, Index { name, key_path, unique, multi_entry, populated: false, entries: BTreeSet::new() });
        id
    });
    rv.set_uint32(id);
}
// __dom.idbIndexDelete(store, name) -> the number of the index of the name deleted (0 for none): the store has it no
// more, but a write before its deletion runs in the transaction's order still keeps to it (`idbIndexRetire`).
fn index_delete(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let store = id_arg(scope, &args, 0);
    let Some(name) = name_arg(scope, args.get(1)) else { return rv.set_uint32(0) };
    let id = with(|s| s.stores.get_mut(&store).and_then(|st| st.index_names.remove(&name)));
    rv.set_uint32(id.unwrap_or(0));
}
// __dom.idbIndexRetire(store, index): a deleted index's deletion run — its records gone.
fn index_retire(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (store, index) = (id_arg(scope, &args, 0), id_arg(scope, &args, 1));
    with(|s| {
        if let Some(st) = s.stores.get_mut(&store) {
            if !st.index_names.values().any(|&i| i == index) {
                st.indexes.remove(&index);
            }
        }
    });
}
// __dom.idbIndexRename(store, index, name) -> whether it took the name (none of the store's other indexes has it).
fn index_rename(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (store, index) = (id_arg(scope, &args, 0), id_arg(scope, &args, 1));
    let Some(name) = name_arg(scope, args.get(2)) else { return rv.set_bool(false) };
    let took = with(|s| {
        let Some(st) = s.stores.get_mut(&store) else { return false };
        let Some(old) = st.indexes.get(&index).map(|i| i.name.clone()) else { return false };
        if old == name {
            return true;
        }
        if st.index_names.contains_key(&name) {
            return false;
        }
        st.index_names.remove(&old);
        st.index_names.insert(name.clone(), index);
        if let Some(i) = st.indexes.get_mut(&index) {
            i.name = name;
        }
        true
    });
    rv.set_bool(took);
}
// __dom.idbIndexId(store, name) -> the number of the store's index of that name, or 0 for none.
fn index_id(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let store = id_arg(scope, &args, 0);
    let Some(name) = name_arg(scope, args.get(1)) else { return rv.set_uint32(0) };
    let id = with(|s| s.stores.get(&store).and_then(|st| st.index_names.get(&name).copied()));
    rv.set_uint32(id.unwrap_or(0));
}
// __dom.idbIndex(store, index) -> [name, keyPath, unique, multiEntry]: an index's schema (undefined for none).
fn index_info(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (store, index) = (id_arg(scope, &args, 0), id_arg(scope, &args, 1));
    let found = with(|s| s.stores.get(&store).and_then(|st| st.indexes.get(&index)).map(|i| (i.name.clone(), i.key_path.clone(), i.unique, i.multi_entry)));
    let Some((name, key_path, unique, multi_entry)) = found else { return };
    let items = [name_value(scope, &name), key_path_value(scope, &key_path), v8::Boolean::new(scope, unique).into(), v8::Boolean::new(scope, multi_entry).into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.idbIndexLive(store, index) -> whether the store has it (neither it nor its store deleted).
fn index_live(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (store, index) = (id_arg(scope, &args, 0), id_arg(scope, &args, 1));
    rv.set_bool(with(|s| s.store_live(store) && s.stores[&store].index_names.values().any(|&i| i == index)));
}
// __dom.idbWriteIndexes(store) -> [index, keyPath, multiEntry, …]: the indexes a record written into the store goes into —
// those holding its records, a deleted one whose deletion has yet to run among them.
fn write_indexes(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let store = id_arg(scope, &args, 0);
    let mut found: Vec<(u32, KeyPath, bool)> = with(|s| {
        s.stores.get(&store).map(|st| st.indexes.iter().filter(|(_, i)| i.populated).map(|(id, i)| (*id, i.key_path.clone(), i.multi_entry)).collect()).unwrap_or_default()
    });
    found.sort_by_key(|f| f.0);
    let mut items = Vec::with_capacity(found.len() * 3);
    for (id, key_path, multi_entry) in found {
        items.push(v8::Integer::new_from_unsigned(scope, id).into());
        items.push(key_path_value(scope, &key_path));
        items.push(v8::Boolean::new(scope, multi_entry).into());
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.idbGenerator(store) -> its key generator's current number (Infinity past 2^53), or null without one.
fn generator(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let store = id_arg(scope, &args, 0);
    match with(|s| s.stores.get(&store).and_then(|st| st.current)) {
        Some(n) => rv.set_double(n),
        None => rv.set_null(),
    }
}

// What a write is refused with: a record at the key already (`add`), or a unique index's key another record holds.
const STORED: u32 = 0;
const KEY_EXISTS: u32 = 1;
const UNIQUE_TAKEN: u32 = 2;

impl Store {
    // The record at `key` as it was before the transaction writing the store first wrote it, journaled.
    fn note(&mut self, key: &Key) {
        let Some(journal) = &mut self.journal else { return };
        if !journal.prior.contains_key(key) {
            journal.prior.insert(key.clone(), self.records.get(key).cloned());
        }
    }
    // A record put at `key`, and into its indexes.
    fn insert(&mut self, key: Key, record: Record) {
        for (index, keys) in &record.indexed {
            if let Some(i) = self.indexes.get_mut(index) {
                for k in keys {
                    i.entries.insert((k.clone(), key.clone()));
                }
            }
        }
        self.records.insert(key, record);
    }
    // What `journal` found put back.
    fn undo(&mut self, journal: Journal) {
        self.current = journal.current;
        for (key, prior) in journal.prior {
            self.remove(&key);
            if let Some(record) = prior {
                self.insert(key, record);
            }
        }
    }
    // The record at `key` taken out, and out of its indexes.
    fn remove(&mut self, key: &Key) {
        let Some(record) = self.records.remove(key) else { return };
        for (index, keys) in record.indexed {
            if let Some(index) = self.indexes.get_mut(&index) {
                for k in keys {
                    index.entries.remove(&(k, key.clone()));
                }
            }
        }
    }
    // Whether a unique index holds `k` for a record other than the one at `primary`.
    fn taken(&self, index: u32, k: &Key, primary: Option<&Key>) -> bool {
        let Some(index) = self.indexes.get(&index) else { return false };
        index
            .entries
            .range((Bound::Included((k.clone(), Key::Min)), Bound::Included((k.clone(), Key::Max))))
            .any(|(_, p)| primary.is_none_or(|primary| p != primary))
    }
}

// __dom.idbPut(store, key, value, indexed, noOverwrite, generated) -> `STORED`, `KEY_EXISTS`, or [UNIQUE_TAKEN, index]:
// "store a record into an object store" — the value a serialization's number (clone.rs), `indexed` [index, count,
// key…, …] the keys it is indexed under in each index it goes into; refused for an existing key with `noOverwrite`, or a
// unique index's key another record holds. Stored, the key generator moves past the key: a generated one, or a number
// given (2^53 and past it infinite).
fn put(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let store = id_arg(scope, &args, 0);
    let Some(key) = key_arg(scope, args.get(1)) else { return };
    let number = args.get(2).uint32_value(scope).unwrap_or(0);
    let no_overwrite = args.get(4).is_true();
    let generated = args.get(5).is_true();
    let mut indexed = Vec::new();
    if let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(3)) {
        let mut at = 0;
        while at + 1 < list.length() {
            let index = list.get_index(scope, at).and_then(|v| v.uint32_value(scope)).unwrap_or(0);
            let n = list.get_index(scope, at + 1).and_then(|v| v.uint32_value(scope)).unwrap_or(0);
            let mut keys = Vec::with_capacity(n as usize);
            for i in 0..n {
                if let Some(k) = list.get_index(scope, at + 2 + i).and_then(|v| key_arg(scope, v)) {
                    keys.push(k);
                }
            }
            indexed.push((index, keys));
            at += 2 + n;
        }
    }
    let refused = with(|s| {
        let st = s.stores.get(&store)?;
        if no_overwrite && st.records.contains_key(&key) {
            return Some((KEY_EXISTS, 0));
        }
        for (index, keys) in &indexed {
            let unique = st.indexes.get(index).is_some_and(|i| i.unique);
            if unique && keys.iter().any(|k| st.taken(*index, k, Some(&key))) {
                return Some((UNIQUE_TAKEN, *index));
            }
        }
        None
    });
    match refused {
        Some((KEY_EXISTS, _)) => return rv.set_uint32(KEY_EXISTS),
        Some((_, index)) => {
            let items = [v8::Integer::new_from_unsigned(scope, UNIQUE_TAKEN).into(), v8::Integer::new_from_unsigned(scope, index).into()];
            return rv.set(v8::Array::new_with_elements(scope, &items).into());
        }
        None => {}
    }
    let Some(bytes) = crate::clone::take_bytes(scope, number) else { return };
    with(|s| {
        let Some(st) = s.stores.get_mut(&store) else { return };
        if let Some(current) = st.current {
            let moved = if generated {
                Some(key_number(&key).unwrap_or(current))
            } else {
                key_number(&key).map(|n| n.min(MAX_GENERATED).floor()).filter(|&n| n >= current)
            };
            if let Some(n) = moved {
                st.current = Some(if n >= MAX_GENERATED { f64::INFINITY } else { n + 1.0 });
            }
        }
        st.note(&key);
        st.remove(&key);
        st.insert(key, Record { value: bytes.into(), indexed });
    });
    rv.set_uint32(STORED);
}
fn key_number(key: &Key) -> Option<f64> {
    if let Key::Number(n) = key { Some(*n) } else { None }
}

// __dom.idbDelete(store, range): the records in the range taken out, and out of their indexes.
fn delete(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let store = id_arg(scope, &args, 0);
    let range = range_arg(scope, args.get(1));
    with(|s| {
        let Some(st) = s.stores.get_mut(&store) else { return };
        let keys: Vec<Key> = Source::Store(st).in_range(&range).map(|(k, _)| k).collect();
        for k in keys {
            st.note(&k);
            st.remove(&k);
        }
    });
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Bounds of (key, primary key) pairs: the greater of two lower bounds (an excluded one at the same pair), the lesser of
// two upper bounds — and whether a lower and an upper bound leave any pair between them.
type PairBound = Bound<(Key, Key)>;
fn tighter(a: PairBound, b: PairBound, lower: bool) -> PairBound {
    use Bound::*;
    let (av, bv) = match (&a, &b) {
        (Unbounded, _) => return b,
        (_, Unbounded) => return a,
        (Included(x) | Excluded(x), Included(y) | Excluded(y)) => (x.clone(), y.clone()),
    };
    match av.cmp(&bv) {
        Ordering::Equal => if matches!(a, Excluded(_)) { a } else { b },
        Ordering::Greater => if lower { a } else { b },
        Ordering::Less => if lower { b } else { a },
    }
}
fn nonempty(lower: &PairBound, upper: &PairBound) -> bool {
    use Bound::*;
    match (lower, upper) {
        (Unbounded, _) | (_, Unbounded) => true,
        (Included(l), Included(u)) => l <= u,
        (Included(l) | Excluded(l), Included(u) | Excluded(u)) => l < u,
    }
}
// …a bound of a store's own pairs — each record's key twice — as one of its keys: `(a, MIN)` and `(a, MAX)` fall
// either side of every pair of key `a`.
fn key_bound(b: &PairBound, lower: bool) -> Bound<Key> {
    use Bound::*;
    match b {
        Unbounded => Unbounded,
        Included((a, Key::Min)) | Excluded((a, Key::Min)) if lower => Included(a.clone()),
        Included((a, Key::Max)) | Excluded((a, Key::Max)) if !lower => Included(a.clone()),
        Included((a, _)) | Excluded((a, _)) => Excluded(a.clone()),
    }
}

// What a request or a cursor reads: a store's records — each its key twice, as (key, primary key) — or an index's.
enum Source<'a> {
    Store(&'a Store),
    Index(&'a Index),
}
impl<'a> Source<'a> {
    fn of(st: &'a Store, index: Option<u32>) -> Option<Source<'a>> {
        match index {
            None => Some(Source::Store(st)),
            Some(i) => st.indexes.get(&i).map(Source::Index),
        }
    }
    // Its pairs between two bounds, ascending.
    fn between(&self, lower: PairBound, upper: PairBound) -> Box<dyn DoubleEndedIterator<Item = (Key, Key)> + 'a> {
        if !nonempty(&lower, &upper) {
            return Box::new(std::iter::empty());
        }
        match self {
            Source::Index(i) => Box::new(i.entries.range((lower, upper)).cloned()),
            Source::Store(st) => {
                let (lo, hi) = (key_bound(&lower, true), key_bound(&upper, false));
                let empty = match (&lo, &hi) {
                    (Bound::Included(l), Bound::Included(u)) => l > u,
                    (Bound::Included(l) | Bound::Excluded(l), Bound::Included(u) | Bound::Excluded(u)) => l >= u,
                    _ => false,
                };
                if empty {
                    return Box::new(std::iter::empty());
                }
                Box::new(st.records.range((lo, hi)).map(|(k, _)| (k.clone(), k.clone())))
            }
        }
    }
    fn in_range(&self, range: &Range) -> Box<dyn DoubleEndedIterator<Item = (Key, Key)> + 'a> {
        self.between(range.lower_pair(), range.upper_pair())
    }
}

// A request's directions and what it reads of each record.
const NEXT: u32 = 0;
const NEXT_UNIQUE: u32 = 1;
const PREV: u32 = 2;
const PREV_UNIQUE: u32 = 3;
const READ_KEY: u32 = 0;
const READ_VALUE: u32 = 1;
const READ_RECORD: u32 = 2;

// __dom.idbRetrieve(store, index, range, direction, count, type) -> [key, primaryKey, value, …]: a store's records — or
// an index's, each with the store record it references — in the range, in the direction, at most `count` (0: all), as
// `type` asks: its primary key (`READ_KEY`), that and its value (`READ_VALUE`, a serialization's number), or both and its
// key (`READ_RECORD`; undefined where not asked); a unique direction one record of each key — `prevunique` the first of
// it.
fn retrieve(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let store = id_arg(scope, &args, 0);
    let index = index_arg(scope, &args, 1);
    let range = range_arg(scope, args.get(2));
    let direction = args.get(3).uint32_value(scope).unwrap_or(NEXT);
    let count = args.get(4).uint32_value(scope).unwrap_or(0) as usize;
    let read = args.get(5).uint32_value(scope).unwrap_or(READ_VALUE);
    let found = with(|s| {
        let st = s.stores.get(&store)?;
        let source = Source::of(st, index)?;
        let unique = matches!(direction, NEXT_UNIQUE | PREV_UNIQUE);
        // (…no more read than asked for, where a count bounds them and no key repeats need folding)
        let take = if count > 0 && !unique { count } else { usize::MAX };
        let mut pairs: Vec<(Key, Key)> = if direction >= PREV {
            source.in_range(&range).rev().take(take).collect()
        } else {
            source.in_range(&range).take(take).collect()
        };
        if unique {
            let mut kept: Vec<(Key, Key)> = Vec::new();
            for p in pairs {
                match kept.last_mut() {
                    Some(last) if last.0 == p.0 => {
                        if direction == PREV_UNIQUE {
                            *last = p;
                        }
                    }
                    _ => kept.push(p),
                }
            }
            pairs = kept;
        }
        if count > 0 {
            pairs.truncate(count);
        }
        let values: Vec<Option<Arc<[u8]>>> = pairs.iter().map(|(_, p)| (read != READ_KEY).then(|| st.records.get(p).map(|r| r.value.clone())).flatten()).collect();
        Some((pairs, values))
    });
    let Some((pairs, values)) = found else { return rv.set(v8::Array::new(scope, 0).into()) };
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(pairs.len() * 3);
    for ((key, primary), value) in pairs.iter().zip(values) {
        items.push(if read == READ_RECORD { key_value(scope, key) } else { v8::undefined(scope).into() });
        items.push(key_value(scope, primary));
        items.push(match value {
            Some(bytes) => {
                let number = crate::clone::keep_bytes(scope, bytes.to_vec());
                v8::Integer::new_from_unsigned(scope, number).into()
            }
            None => v8::undefined(scope).into(),
        });
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.idbCount(store, index, range) -> how many records of it the range holds.
fn count(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let store = id_arg(scope, &args, 0);
    let index = index_arg(scope, &args, 1);
    let range = range_arg(scope, args.get(2));
    let n = with(|s| s.stores.get(&store).and_then(|st| Source::of(st, index)).map_or(0, |source| source.in_range(&range).count()));
    rv.set_uint32(n as u32);
}

// __dom.idbCursor(store, index, range, direction, position, objectStorePosition, key, primaryKey, count, keyOnly) ->
// [key, primaryKey, value] or null: "iterate a cursor" `count` times from its position (an index cursor's object store
// position too, in a direction that is no unique one), past `key` (and `primaryKey`, continuing by primary key) where
// given — the record it lands on, its value a serialization's number unless `keyOnly`; null past the range's end.
fn cursor(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let store = id_arg(scope, &args, 0);
    let index = index_arg(scope, &args, 1);
    let range = range_arg(scope, args.get(2));
    let direction = args.get(3).uint32_value(scope).unwrap_or(NEXT);
    let given = |scope: &mut v8::PinScope<'_, '_>, i: i32| {
        let v = args.get(i);
        (!v.is_undefined()).then(|| key_arg(scope, v)).flatten()
    };
    let (mut position, mut os_position) = (given(scope, 4), given(scope, 5));
    let (mut key, mut primary) = (given(scope, 6), given(scope, 7));
    let count = args.get(8).uint32_value(scope).unwrap_or(1).max(1);
    let key_only = args.get(9).is_true();
    let forward = matches!(direction, NEXT | NEXT_UNIQUE);
    let unique = matches!(direction, NEXT_UNIQUE | PREV_UNIQUE);
    let found = with(|s| {
        let st = s.stores.get(&store)?;
        let source = Source::of(st, index)?;
        let mut found = None;
        for _ in 0..count {
            let by_position = if unique || index.is_none() { None } else { os_position.clone() };
            found = if forward {
                // (…the first in the range at or past `key`, past the position)
                let mut lower = range.lower_pair();
                if let Some(k) = &key {
                    lower = tighter(lower, Bound::Included((k.clone(), primary.clone().unwrap_or(Key::Min))), true);
                }
                if let Some(pos) = &position {
                    lower = tighter(lower, Bound::Excluded((pos.clone(), by_position.clone().unwrap_or(Key::Max))), true);
                }
                source.between(lower, range.upper_pair()).next()
            } else {
                // (…the last in the range at or before `key`, before the position — `prevunique` the first of its key)
                let mut upper = range.upper_pair();
                if let Some(k) = &key {
                    upper = tighter(upper, Bound::Included((k.clone(), primary.clone().unwrap_or(Key::Max))), false);
                }
                if let Some(pos) = &position {
                    upper = tighter(upper, Bound::Excluded((pos.clone(), by_position.clone().unwrap_or(Key::Min))), false);
                }
                match source.between(range.lower_pair(), upper).next_back() {
                    Some((k, _)) if direction == PREV_UNIQUE => {
                        let first = tighter(range.lower_pair(), Bound::Included((k, Key::Min)), true);
                        source.between(first, range.upper_pair()).next()
                    }
                    last => last,
                }
            };
            let (k, p) = found.clone()?;
            position = Some(k);
            os_position = Some(p);
            key = None;
            primary = None;
        }
        let (k, p) = found?;
        let value = (!key_only).then(|| st.records.get(&p).map(|r| r.value.clone())).flatten();
        Some((k, p, value))
    });
    let Some((k, p, value)) = found else { return rv.set_null() };
    let key = key_value(scope, &k);
    let primary = key_value(scope, &p);
    let value: v8::Local<v8::Value> = match value {
        Some(bytes) => {
            let number = crate::clone::keep_bytes(scope, bytes.to_vec());
            v8::Integer::new_from_unsigned(scope, number).into()
        }
        None => v8::undefined(scope).into(),
    };
    rv.set(v8::Array::new_with_elements(scope, &[key, primary, value]).into());
}

// __dom.idbPopulate(store, index, [primaryKey, count, key…, …]) -> whether the index took them: its records, each the
// keys a store record is indexed under — refused (a ConstraintError) where a unique index would hold a key twice.
fn populate(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (store, index) = (id_arg(scope, &args, 0), id_arg(scope, &args, 1));
    let mut entries = Vec::new();
    if let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(2)) {
        let mut at = 0;
        while at + 1 < list.length() {
            let Some(primary) = list.get_index(scope, at).and_then(|v| key_arg(scope, v)) else { break };
            let n = list.get_index(scope, at + 1).and_then(|v| v.uint32_value(scope)).unwrap_or(0);
            let mut keys = Vec::with_capacity(n as usize);
            for i in 0..n {
                if let Some(k) = list.get_index(scope, at + 2 + i).and_then(|v| key_arg(scope, v)) {
                    keys.push(k);
                }
            }
            entries.push((primary, keys));
            at += 2 + n;
        }
    }
    let took = with(|s| {
        let Some(st) = s.stores.get_mut(&store) else { return false };
        for (primary, keys) in entries {
            let unique = st.indexes.get(&index).is_some_and(|i| i.unique);
            if unique && keys.iter().any(|k| st.taken(index, k, None)) {
                return false;
            }
            if let Some(i) = st.indexes.get_mut(&index) {
                for k in &keys {
                    i.entries.insert((k.clone(), primary.clone()));
                }
            }
            if let Some(record) = st.records.get_mut(&primary) {
                record.indexed.push((index, keys));
            }
        }
        if let Some(i) = st.indexes.get_mut(&index) {
            i.populated = true;
        }
        true
    });
    rv.set_bool(took);
}

// __dom.idbJournal(store, transaction): what transaction `tx` — the one transaction that may write the store — finds
// before its first write into it kept, which its abort puts back (`undo_transaction`) and its commit lets go
// (`keep_transaction`).
fn journal(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (store, tx) = (id_arg(scope, &args, 0), id_arg(scope, &args, 1));
    with(|s| {
        // (…once a transaction: its first write into the store journaled, every later one already in it)
        if let Some(st) = s.stores.get_mut(&store).filter(|st| st.journal.as_ref().is_none_or(|j| j.tx != tx)) {
            st.journal = Some(Journal::of(st, tx));
        }
    });
}
// …and kept: its journals let go (it committed).
pub(crate) fn keep_transaction(reg: &mut Registry, tx: u32) {
    for st in reg.stores.values_mut() {
        st.journal.take_if(|j| j.tx == tx);
    }
}
// What transaction `tx` wrote, put back in every store it wrote (its agent gone mid-transaction, or aborted).
pub(crate) fn undo_transaction(reg: &mut Registry, tx: u32) {
    for st in reg.stores.values_mut() {
        if let Some(journal) = st.journal.take_if(|j| j.tx == tx) {
            st.undo(journal);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // "Compare two keys": array > binary > string > date > number, then by value.
    #[test]
    fn keys_order_by_type_then_value() {
        let s = |t: &str| Key::String(t.encode_utf16().collect());
        let mut keys = vec![Key::Array(vec![]), Key::Binary(vec![1]), s("a"), Key::Date(0.0), Key::Number(1.0), Key::Number(-1.0)];
        keys.sort();
        assert_eq!(keys, vec![Key::Number(-1.0), Key::Number(1.0), Key::Date(0.0), s("a"), Key::Binary(vec![1]), Key::Array(vec![])]);
        assert!(Key::Array(vec![Key::Number(1.0)]) > Key::Array(vec![]));
        assert_eq!(Key::Number(0.0), Key::Number(-0.0));
        assert!(Key::Min < Key::Number(f64::NEG_INFINITY) && Key::Max > Key::Array(vec![]));
    }

    // An abort puts back each record a transaction wrote, its index entries and the key generator — and only those.
    #[test]
    fn a_journal_puts_back_what_was_written() {
        let n = Key::Number;
        let record = |i: f64| Record { value: Arc::from(vec![i as u8]), indexed: vec![(7, vec![n(i * 10.0)])] };
        let mut st = Store::new(DbKey::default(), Vec::new(), KeyPath::None, true);
        st.current = Some(3.0);
        st.indexes.insert(7, Index { name: Vec::new(), key_path: KeyPath::None, unique: true, multi_entry: false, populated: true, entries: BTreeSet::new() });
        st.insert(n(1.0), record(1.0));
        st.insert(n(2.0), record(2.0));
        let before = (st.records.keys().cloned().collect::<Vec<_>>(), st.indexes[&7].entries.clone());
        st.journal = Some(Journal::of(&st, 1));
        // (…an overwrite, a delete, a new record twice written, a generator moved)
        for (key, value) in [(1.0, 5.0), (3.0, 6.0), (3.0, 8.0)] {
            st.note(&n(key));
            st.remove(&n(key));
            st.insert(n(key), record(value));
        }
        st.note(&n(2.0));
        st.remove(&n(2.0));
        st.current = Some(9.0);
        let journal = st.journal.take().expect("begun");
        assert_eq!(journal.prior.len(), 3);
        st.undo(journal);
        assert_eq!((st.records.keys().cloned().collect::<Vec<_>>(), st.indexes[&7].entries.clone()), before);
        assert_eq!(&*st.records[&n(1.0)].value, &[1u8]);
        assert_eq!(st.current, Some(3.0));
    }
}
