// A URLSearchParams object's list (URL Standard §6): its name-value pairs, in order, on a handle the bindings' object
// wraps (`__dom.SearchParamsBase`) — appended, deleted, set and sorted here, read by name, and serialized as the
// application/x-www-form-urlencoded serializer has them. Where the object is a URL's `searchParams`, the bindings write
// the serialization back to the URL's query after a change (its update steps) and hand the list the query a change of
// the URL made (`searchParamsReplace`). Names and values are USVStrings: the bindings converted them, so no lone
// surrogate reaches a pair.

use std::cell::RefCell;

use v8::cppgc::{GarbageCollected, Visitor};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (headers.rs' 7, a drag data store's 8, an XHR's 9).
const TAG: u16 = 10;

// What marks an object as a search params list's (its internal field 0).
static BRAND: u8 = 0;

#[derive(Default)]
pub(crate) struct ParamsList(Vec<(String, String)>);

impl ParamsList {
    // The application/x-www-form-urlencoded parser's pairs of `query`.
    fn parse(query: &str) -> Self {
        ParamsList(url::form_urlencoded::parse(query.as_bytes()).map(|(n, v)| (n.into_owned(), v.into_owned())).collect())
    }
    fn serialize(&self) -> String {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        for (name, value) in &self.0 {
            serializer.append_pair(name, value);
        }
        serializer.finish()
    }
    // (…`value` given, only the pairs of both)
    fn matches(pair: &(String, String), name: &str, value: Option<&str>) -> bool {
        pair.0 == name && value.is_none_or(|v| pair.1 == v)
    }
    // "set": the first pair of `name` takes `value`, the others of it gone; one appended where there is none.
    fn set(&mut self, name: &str, value: &str) {
        let mut found = false;
        self.0.retain_mut(|pair| {
            if pair.0 != name {
                return true;
            }
            if found {
                return false;
            }
            found = true;
            pair.1 = value.to_owned();
            true
        });
        if !found {
            self.0.push((name.to_owned(), value.to_owned()));
        }
    }
    // "sort": a stable sort by name, in code units.
    fn sort(&mut self) {
        self.0.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    }
}

pub(crate) struct ParamsHandle {
    list: RefCell<ParamsList>,
}

unsafe impl GarbageCollected for ParamsHandle {
    fn trace(&self, _visitor: &mut Visitor) {}
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"ParamsHandle"
    }
}

// The constructor a URLSearchParams object's list is made with (`__dom.SearchParamsBase(query)`): branded, a wrapper of
// the pairs `query` parses to — none for undefined.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let query = args.get(0);
    let list = if query.is_undefined() { ParamsList::default() } else { ParamsList::parse(&query.to_rust_string_lossy(scope)) };
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let handle = ParamsHandle { list: RefCell::new(list) };
    let heap = scope.get_cpp_heap().expect("SearchParamsBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, ParamsHandle>(scope, obj, &ptr);
    }
}

// The list `value` wraps, or None for anything that is no search params list's object (the brand first: `unwrap` reads
// garbage from an object it never wrapped).
fn list<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h RefCell<ParamsList>> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped a ParamsHandle under TAG; the handle lives while
    // its object, the argument, does — through this op.
    let handle = unsafe { v8::Object::unwrap::<TAG, ParamsHandle>(scope, obj)? };
    Some(unsafe { &(*(handle.as_ref() as *const ParamsHandle)).list })
}

// `__dom.SearchParamsBase`: the constructor of the isolate's template, made once per isolate.
fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let kept = crate::dom::dom(scope).search_params_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "SearchParamsBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).search_params_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if let (Some(base), Some(name)) = (base_function(scope), v8::String::new(scope, "SearchParamsBase")) {
        ns.set(scope, name.into(), base.into());
    }
    crate::dom::register(scope, ns, "searchParamsSize", size_op, context_id);
    crate::dom::register(scope, ns, "searchParamsAppend", append_op, context_id);
    crate::dom::register(scope, ns, "searchParamsDelete", delete_op, context_id);
    crate::dom::register(scope, ns, "searchParamsGet", get_op, context_id);
    crate::dom::register(scope, ns, "searchParamsGetAll", get_all_op, context_id);
    crate::dom::register(scope, ns, "searchParamsHas", has_op, context_id);
    crate::dom::register(scope, ns, "searchParamsSet", set_op, context_id);
    crate::dom::register(scope, ns, "searchParamsSort", sort_op, context_id);
    crate::dom::register(scope, ns, "searchParamsSerialize", serialize_op, context_id);
    crate::dom::register(scope, ns, "searchParamsPairs", pairs_op, context_id);
    crate::dom::register(scope, ns, "searchParamsReplace", replace_op, context_id);
}

fn text(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> String {
    value.to_rust_string_lossy(scope)
}
// (…a value argument where the method was given one, `undefined` for none)
fn optional(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<String> {
    (!value.is_undefined()).then(|| text(scope, value))
}
fn string<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
}

// __dom.searchParamsSize(list) -> how many pairs it has.
fn size_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let size = list(scope, args.get(0)).map_or(0, |l| l.borrow().0.len());
    rv.set_uint32(size as u32);
}
// __dom.searchParamsAppend(list, name, value) — the pair appended.
fn append_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (name, value) = (text(scope, args.get(1)), text(scope, args.get(2)));
    if let Some(l) = list(scope, args.get(0)) {
        l.borrow_mut().0.push((name, value));
    }
}
// __dom.searchParamsDelete(list, name, value) — the pairs of `name` (and of `value`, where given) gone.
fn delete_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (name, value) = (text(scope, args.get(1)), optional(scope, args.get(2)));
    if let Some(l) = list(scope, args.get(0)) {
        l.borrow_mut().0.retain(|pair| !ParamsList::matches(pair, &name, value.as_deref()));
    }
}
// __dom.searchParamsGet(list, name) -> the value of its first pair of `name`, or null.
fn get_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = text(scope, args.get(1));
    let found = list(scope, args.get(0)).and_then(|l| l.borrow().0.iter().find(|(n, _)| *n == name).map(|(_, v)| v.clone()));
    match found {
        Some(value) => {
            let value = string(scope, &value);
            rv.set(value);
        }
        None => rv.set_null(),
    }
}
// __dom.searchParamsGetAll(list, name) -> the values of its pairs of `name`, in order.
fn get_all_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = text(scope, args.get(1));
    let values: Vec<String> = list(scope, args.get(0)).map_or_else(Vec::new, |l| {
        l.borrow().0.iter().filter(|(n, _)| *n == name).map(|(_, v)| v.clone()).collect()
    });
    let items: Vec<v8::Local<v8::Value>> = values.iter().map(|v| string(scope, v)).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.searchParamsHas(list, name, value) -> whether it has a pair of `name` (and of `value`, where given).
fn has_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (name, value) = (text(scope, args.get(1)), optional(scope, args.get(2)));
    let has = list(scope, args.get(0)).is_some_and(|l| l.borrow().0.iter().any(|pair| ParamsList::matches(pair, &name, value.as_deref())));
    rv.set_bool(has);
}
// __dom.searchParamsSet(list, name, value) — `ParamsList::set`.
fn set_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (name, value) = (text(scope, args.get(1)), text(scope, args.get(2)));
    if let Some(l) = list(scope, args.get(0)) {
        l.borrow_mut().set(&name, &value);
    }
}
// __dom.searchParamsSort(list) — `ParamsList::sort`.
fn sort_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if let Some(l) = list(scope, args.get(0)) {
        l.borrow_mut().sort();
    }
}
// __dom.searchParamsSerialize(list) -> the application/x-www-form-urlencoded serializer's string of its pairs.
fn serialize_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let serialized = list(scope, args.get(0)).map_or_else(String::new, |l| l.borrow().serialize());
    let serialized = string(scope, &serialized);
    rv.set(serialized);
}
// __dom.searchParamsPairs(list) -> its pairs, flat: [name, value, name, value, …] — what its iterator walks.
fn pairs_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let pairs: Vec<(String, String)> = list(scope, args.get(0)).map_or_else(Vec::new, |l| l.borrow().0.clone());
    let items: Vec<v8::Local<v8::Value>> = pairs.iter().flat_map(|(n, v)| [n, v]).map(|s| string(scope, s)).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.searchParamsReplace(list, query) — its pairs those `query` parses to (a URL's query moved under it).
fn replace_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let query = text(scope, args.get(1));
    if let Some(l) = list(scope, args.get(0)) {
        *l.borrow_mut() = ParamsList::parse(&query);
    }
}

#[cfg(test)]
mod tests {
    use super::ParamsList;

    fn list(query: &str) -> ParamsList {
        ParamsList::parse(query)
    }

    #[test]
    fn set_keeps_the_first_pair_and_sort_is_stable_by_code_units() {
        let mut l = list("a=1&b=2&a=3");
        l.set("a", "x");
        assert_eq!(l.serialize(), "a=x&b=2");
        l.set("c", "y");
        assert_eq!(l.serialize(), "a=x&b=2&c=y");
        // (…U+FFFD after U+1F600's surrogates in code units, though not in code points)
        let mut l = list("%EF%BF%BD=1&%F0%9F%98%80=2&z=3&z=4");
        l.sort();
        assert_eq!(l.serialize(), "z=3&z=4&%F0%9F%98%80=2&%EF%BF%BD=1");
    }
}
