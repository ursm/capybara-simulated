// Indexed Database's storage (§2.1-2.7): keys and their order, an object store's records sorted by key with its key
// generator, an index's records sorted by key and then primary key, ranges of them, what a request retrieves and where a
// cursor moves next — and a store's state as a transaction found it, which an abort puts back. The bindings (idb.js) keep
// the schema's names and key paths, the transactions, requests and events; they convert a page's values to keys and
// evaluate key paths (both read the page's objects), and a value reaches here serialized (clone.rs): its bytes.
//
// Each store and index is named by a number its bindings object holds, which lets it go (`idbStoreFree` /
// `idbIndexFree`) once that object is collected.

use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ops::Bound;
use std::sync::Arc;

use crate::dom::register;

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

#[derive(Clone)]
struct Index {
    unique: bool,
    entries: BTreeSet<(Key, Key)>,
}

// An object store: its records, its key generator's current number (none without one; infinite past 2^53), its indexes.
#[derive(Clone)]
struct Store {
    records: BTreeMap<Key, Record>,
    current: Option<f64>,
    indexes: HashMap<u32, Index>,
}

#[derive(Default)]
struct Stores {
    stores: HashMap<u32, Store>,
    snapshots: HashMap<u32, Store>,
    next: u32,
}

thread_local! {
    static STORES: RefCell<Stores> = RefCell::new(Stores::default());
}

fn with<R>(f: impl FnOnce(&mut Stores) -> R) -> R {
    STORES.with(|s| f(&mut s.borrow_mut()))
}
fn next_id(s: &mut Stores) -> u32 {
    s.next = s.next.wrapping_add(1);
    s.next
}

const MAX_GENERATED: f64 = 9_007_199_254_740_992.0; // 2^53

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "idbCompare", compare_op, context_id);
    register(scope, ns, "idbStoreNew", store_new, context_id);
    register(scope, ns, "idbStoreFree", store_free, context_id);
    register(scope, ns, "idbIndexNew", index_new, context_id);
    register(scope, ns, "idbIndexFree", index_free, context_id);
    register(scope, ns, "idbGenerator", generator, context_id);
    register(scope, ns, "idbPut", put, context_id);
    register(scope, ns, "idbDelete", delete, context_id);
    register(scope, ns, "idbRetrieve", retrieve, context_id);
    register(scope, ns, "idbCount", count, context_id);
    register(scope, ns, "idbCursor", cursor, context_id);
    register(scope, ns, "idbPopulate", populate, context_id);
    register(scope, ns, "idbSnapshot", snapshot, context_id);
    register(scope, ns, "idbRestore", restore, context_id);
    register(scope, ns, "idbSnapshotFree", snapshot_free, context_id);
}

// ── Keys as the bindings hold them ──────────────────────────────────────────────────────────────────────────────────
// A number, a string, `{ date: ms }`, `{ binary: Uint8Array }`, or an array of keys; anything else (undefined) none.
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
    let date = v8::String::new(scope, "date")?;
    let d = object.get(scope, date.into())?;
    if d.is_number() {
        return d.number_value(scope).map(Key::Date);
    }
    let binary = v8::String::new(scope, "binary")?;
    let b = object.get(scope, binary.into())?;
    let view = v8::Local::<v8::ArrayBufferView>::try_from(b).ok()?;
    let mut bytes = vec![0u8; view.byte_length()];
    view.copy_contents(&mut bytes);
    Some(Key::Binary(bytes))
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
            let object = v8::Object::new(scope);
            let name = v8::String::new(scope, "date").expect("a short string");
            let value = v8::Number::new(scope, *ms);
            object.create_data_property(scope, name.into(), value.into());
            object.into()
        }
        Key::Binary(bytes) => {
            let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes.clone()).make_shared();
            let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
            let view = v8::Uint8Array::new(scope, buffer, 0, bytes.len()).map_or_else(|| v8::undefined(scope).into(), Into::into);
            let object = v8::Object::new(scope);
            let name = v8::String::new(scope, "binary").expect("a short string");
            object.create_data_property(scope, name.into(), view);
            object.into()
        }
        Key::Min | Key::Max => v8::undefined(scope).into(),
    }
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

// __dom.idbCompare(a, b) -> -1, 0 or 1: "compare two keys".
fn compare_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(a), Some(b)) = (key_arg(scope, args.get(0)), key_arg(scope, args.get(1))) else { return };
    rv.set_int32(a.cmp(&b) as i32);
}

// ── Stores and indexes ──────────────────────────────────────────────────────────────────────────────────────────────
// __dom.idbStoreNew(generator) -> a new store's number: no records, a key generator at 1 where it has one.
fn store_new(_scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let generator = args.get(0).is_true();
    let id = with(|s| {
        let id = next_id(s);
        s.stores.insert(id, Store { records: BTreeMap::new(), current: generator.then_some(1.0), indexes: HashMap::new() });
        id
    });
    rv.set_uint32(id);
}
// __dom.idbStoreFree(store): its bindings object is gone.
fn store_free(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, &args, 0);
    with(|s| s.stores.remove(&id));
}
// __dom.idbIndexNew(store, unique) -> a new index's number: no records yet (`idbPopulate` fills it).
fn index_new(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let store = id_arg(scope, &args, 0);
    let unique = args.get(1).is_true();
    let id = with(|s| {
        let id = next_id(s);
        if let Some(st) = s.stores.get_mut(&store) {
            st.indexes.insert(id, Index { unique, entries: BTreeSet::new() });
        }
        id
    });
    rv.set_uint32(id);
}
// __dom.idbIndexFree(store, index): its bindings object is gone.
fn index_free(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (store, index) = (id_arg(scope, &args, 0), id_arg(scope, &args, 1));
    with(|s| {
        if let Some(st) = s.stores.get_mut(&store) {
            st.indexes.remove(&index);
        }
    });
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
        st.remove(&key);
        for (index, keys) in &indexed {
            if let Some(i) = st.indexes.get_mut(index) {
                for k in keys {
                    i.entries.insert((k.clone(), key.clone()));
                }
            }
        }
        st.records.insert(key, Record { value: bytes.into(), indexed });
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

// __dom.idbRetrieve(store, index, range, direction, count, type) -> [key, primaryKey, value, …]: a store's records — or
// an index's, each with the store record it references — in the range, in the direction, at most `count` (0: all), as
// `type` asks: its primary key (`READ_KEY`), its value (`READ_VALUE`, a serialization's number), or both and its key; a
// unique direction one record of each key — `prevunique` the first of it.
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
        items.push(key_value(scope, key));
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
        true
    });
    rv.set_bool(took);
}

// __dom.idbSnapshot(store) -> a snapshot's number: the store as it is — its records, key generator and indexes — which
// `idbRestore` puts back (an aborted transaction's) and `idbSnapshotFree` lets go.
fn snapshot(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let store = id_arg(scope, &args, 0);
    let id = with(|s| {
        let copy = s.stores.get(&store)?.clone();
        let id = next_id(s);
        s.snapshots.insert(id, copy);
        Some(id)
    });
    rv.set_uint32(id.unwrap_or(0));
}
fn restore(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (store, snapshot) = (id_arg(scope, &args, 0), id_arg(scope, &args, 1));
    with(|s| {
        if let Some(copy) = s.snapshots.remove(&snapshot) {
            s.stores.insert(store, copy);
        }
    });
}
fn snapshot_free(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let snapshot = id_arg(scope, &args, 0);
    with(|s| s.snapshots.remove(&snapshot));
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
}
