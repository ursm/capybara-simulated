// A URLPattern (the URL Pattern Standard): its components — each its pattern string, the regular expression it
// compiles to and that expression's group names — on a handle the bindings' object wraps (`__dom.URLPatternBase`),
// parsed and canonicalized by rust-urlpattern (its `quirks` interface, a browser's) and each compiled as the page's own
// RegExp is, with the "v" flag ("vi" for `ignoreCase`): what `test` and `exec` match a URL's components against, and
// what a service worker's static router (sw_router.rs) matches a request's URL by.

use std::borrow::Cow;

use urlpattern::quirks::{self, StringOrInit};
use v8::cppgc::{GarbageCollected, Visitor};

// The wrapper tag `Object::wrap` / `unwrap` file the handle under (request_state.rs' 11).
const TAG: u16 = 12;

// What marks an object as a pattern's (its internal field 0).
static BRAND: u8 = 0;

// The components, in the order the standard lists them: the getters' and a result's.
const COMPONENTS: [&str; 8] = ["protocol", "username", "password", "hostname", "port", "pathname", "search", "hash"];

#[derive(Clone)]
struct Component {
    pattern: String,
    regexp: v8::Global<v8::RegExp>,
    groups: Vec<String>,
}

#[derive(Clone)]
pub(crate) struct Pattern {
    components: Vec<Component>,
    has_regexp_groups: bool,
}

pub(crate) struct PatternHandle {
    pattern: Pattern,
}

unsafe impl GarbageCollected for PatternHandle {
    fn trace(&self, _visitor: &mut Visitor) {}
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"PatternHandle"
    }
}

fn throw_type_error(scope: &mut v8::PinScope<'_, '_>, message: &str) {
    if let Some(message) = v8::String::new(scope, message) {
        let error = v8::Exception::type_error(scope, message);
        scope.throw_exception(error);
    }
}

// A URLPatternInput the bindings converted — a USVString, or a URLPatternInit dictionary, its members those given — as
// rust-urlpattern takes it.
pub(crate) fn pattern_input(scope: &mut v8::PinScope<'_, '_>, input: v8::Local<'_, v8::Value>) -> StringOrInit<'static> {
    let Ok(init) = v8::Local::<v8::Object>::try_from(input) else {
        return StringOrInit::String(Cow::Owned(crate::url_ops::usv(scope, input)));
    };
    let mut member = |key: &str| {
        let k = v8::String::new(scope, key)?;
        init.get(scope, k.into()).filter(|v| !v.is_undefined()).map(|v| crate::url_ops::usv(scope, v))
    };
    StringOrInit::Init(quirks::UrlPatternInit {
        protocol: member("protocol"),
        username: member("username"),
        password: member("password"),
        hostname: member("hostname"),
        port: member("port"),
        pathname: member("pathname"),
        search: member("search"),
        hash: member("hash"),
        base_url: member("baseURL"),
    })
}
// …and an optional USVString argument (a base URL), None where it is not given.
fn optional(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<String> {
    (!value.is_undefined()).then(|| crate::url_ops::usv(scope, value))
}

// URL Pattern "create" a URL pattern: `input` processed (against `base` for a string), each component parsed and its
// regular expression compiled — a TypeError's message where any of it fails.
pub(crate) fn create(scope: &mut v8::PinScope<'_, '_>, input: StringOrInit<'_>, base: Option<&str>, ignore_case: bool) -> Result<Pattern, String> {
    let init = quirks::process_construct_pattern_input(input, base).map_err(|e| e.to_string())?;
    let options = urlpattern::UrlPatternOptions { regex_syntax: urlpattern::RegexSyntax::EcmaScript, ignore_case };
    let parsed = quirks::parse_pattern::<quirks::EcmaRegexp>(init, options).map_err(|e| e.to_string())?;
    let mut flags = v8::RegExpCreationFlags::UNICODE_SETS;
    if ignore_case {
        flags |= v8::RegExpCreationFlags::IGNORE_CASE;
    }
    let mut components = Vec::with_capacity(COMPONENTS.len());
    for component in [parsed.protocol, parsed.username, parsed.password, parsed.hostname, parsed.port, parsed.pathname, parsed.search, parsed.hash] {
        let source = v8::String::new(scope, &component.regexp_string).ok_or_else(String::new)?;
        v8::tc_scope!(let tc, scope);
        let Some(regexp) = v8::RegExp::new(tc, source, flags) else {
            return Err(format!("Invalid regular expression '{}' in the pattern '{}'.", component.regexp_string, component.pattern_string));
        };
        let regexp = v8::Global::new(tc, regexp);
        components.push(Component { pattern: component.pattern_string, regexp, groups: component.group_name_list });
    }
    Ok(Pattern { components, has_regexp_groups: parsed.has_regexp_groups })
}

// The constructor a URLPattern object is made with — `Reflect.construct(__dom.URLPatternBase, [input, baseURL,
// ignoreCase], newTarget)`, `baseURL` undefined for none (`create`): a TypeError where the pattern is none.
fn construct(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if args.new_target().is_undefined() {
        return;
    }
    let input = pattern_input(scope, args.get(0));
    let base = optional(scope, args.get(1));
    let ignore_case = args.get(2).boolean_value(scope);
    let handle = match create(scope, input, base.as_deref(), ignore_case) {
        Ok(pattern) => PatternHandle { pattern },
        Err(message) => return throw_type_error(scope, &format!("Failed to construct 'URLPattern': {message}")),
    };
    let obj = args.this();
    let brand = v8::External::new(scope, std::ptr::addr_of!(BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let heap = scope.get_cpp_heap().expect("URLPatternBase is installed only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, handle);
        v8::Object::wrap::<TAG, PatternHandle>(scope, obj, &ptr);
    }
}

// The pattern `value` wraps — a URLPattern object is the wrapper itself — or None for anything that is no pattern's
// object (the brand first: `unwrap` reads garbage from an object it never wrapped).
pub(crate) fn pattern<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h Pattern> {
    let obj = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1)?;
    let field = obj.get_internal_field(scope, 0)?;
    let brand = v8::Local::<v8::Value>::try_from(field).ok().and_then(|v| v8::Local::<v8::External>::try_from(v).ok())?;
    if brand.value() as *const u8 != std::ptr::addr_of!(BRAND) {
        return None;
    }
    // SAFETY: a branded object was made by `construct`, which wrapped a PatternHandle under TAG; the handle lives while
    // its object, the argument, does — through this op.
    let handle = unsafe { v8::Object::unwrap::<TAG, PatternHandle>(scope, obj)? };
    Some(unsafe { &(*(handle.as_ref() as *const PatternHandle)).pattern })
}

impl Pattern {
    // Whether it has a regular expression group — what a static route may not have.
    pub(crate) fn has_regexp_groups(&self) -> bool {
        self.has_regexp_groups
    }
    // URL Pattern "match": `input` (against `base`, for a string) — none where it is no URL — its components each
    // matched against this pattern's: each one's input and the values its groups captured (None for a group that took
    // part in no match), or None where one does not match. Err for a base URL given with a URLPatternInit.
    pub(crate) fn matched(&self, scope: &mut v8::PinScope<'_, '_>, input: StringOrInit<'_>, base: Option<&str>) -> Result<Option<Vec<(String, Vec<Option<String>>)>>, String> {
        let Some((input, _)) = quirks::process_match_input(input, base).map_err(|e| e.to_string())? else { return Ok(None) };
        let Some(input) = quirks::parse_match_input(input) else { return Ok(None) };
        let texts = [input.protocol, input.username, input.password, input.hostname, input.port, input.pathname, input.search, input.hash];
        let mut out = Vec::with_capacity(texts.len());
        for (component, text) in self.components.iter().zip(texts) {
            let Some(subject) = v8::String::new(scope, &text) else { return Ok(None) };
            let regexp = v8::Local::new(scope, &component.regexp);
            let Some(found) = regexp.exec(scope, subject) else { return Ok(None) };
            if found.is_null_or_undefined() {
                return Ok(None);
            }
            let groups = (0..component.groups.len() as u32)
                .map(|i| found.get_index(scope, i + 1).filter(|v| !v.is_undefined()).map(|v| v.to_rust_string_lossy(scope)))
                .collect();
            out.push((text, groups));
        }
        Ok(Some(out))
    }
}

// `__dom.URLPatternBase`: the constructor of the isolate's template, made once per isolate.
fn base_function<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    scope.get_cpp_heap()?;
    let kept = crate::dom::dom(scope).url_pattern_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::FunctionTemplate::new(scope, construct);
            t.set_class_name(v8::String::new(scope, "URLPatternBase")?);
            t.instance_template(scope).set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).url_pattern_template = Some(global);
            t
        }
    };
    template.get_function(scope)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    if let (Some(base), Some(name)) = (base_function(scope), v8::String::new(scope, "URLPatternBase")) {
        ns.set(scope, name.into(), base.into());
    }
    crate::dom::register(scope, ns, "urlPatternBrand", brand_op, context_id);
    crate::dom::register(scope, ns, "urlPatternComponent", component_op, context_id);
    crate::dom::register(scope, ns, "urlPatternHasRegExpGroups", has_regexp_groups_op, context_id);
    crate::dom::register(scope, ns, "urlPatternMatch", match_op, context_id);
}

// __dom.urlPatternBrand(value) -> whether `value` is a URLPattern object (any realm's).
fn brand_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(pattern(scope, args.get(0)).is_some());
}

// __dom.urlPatternComponent(pattern, index) -> the pattern string of its component `index` (`COMPONENTS`' order).
fn component_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(p) = pattern(scope, args.get(0)) else { return };
    let index = args.get(1).uint32_value(scope).unwrap_or(0) as usize;
    if let Some(s) = p.components.get(index).and_then(|c| v8::String::new(scope, &c.pattern)) {
        rv.set(s.into());
    }
}

// __dom.urlPatternHasRegExpGroups(pattern) -> whether it has a regular expression group.
fn has_regexp_groups_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    if let Some(p) = pattern(scope, args.get(0)) {
        rv.set_bool(p.has_regexp_groups);
    }
}

// __dom.urlPatternMatch(pattern, input, baseURL, test) -> `test`'s answer, whether `input` (against `baseURL`, undefined
// for none) matches; else `exec`'s: a URLPatternResult — the inputs it was given, and each component's input and groups,
// a group that took part in no match undefined — or null where it does not match. A TypeError for a base URL given with
// a URLPatternInit.
fn match_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(p) = pattern(scope, args.get(0)) else { return };
    let input = pattern_input(scope, args.get(1));
    let base = optional(scope, args.get(2));
    let test = args.get(3).boolean_value(scope);
    let matched = match p.matched(scope, input, base.as_deref()) {
        Ok(matched) => matched,
        Err(message) => {
            let verb = if test { "test" } else { "exec" };
            return throw_type_error(scope, &format!("Failed to execute '{verb}' on 'URLPattern': {message}"));
        }
    };
    if test {
        return rv.set_bool(matched.is_some());
    }
    let Some(components) = matched else { return rv.set_null() };
    let result = v8::Object::new(scope);
    let mut inputs = vec![args.get(1)];
    if base.is_some() {
        inputs.push(args.get(2));
    }
    let inputs = v8::Array::new_with_elements(scope, &inputs);
    let set = |scope: &mut v8::PinScope<'_, '_>, obj: v8::Local<'_, v8::Object>, key: &str, value: v8::Local<'_, v8::Value>| {
        if let Some(k) = v8::String::new(scope, key) {
            obj.create_data_property(scope, k.into(), value);
        }
    };
    set(scope, result, "inputs", inputs.into());
    for ((name, (text, values)), component) in COMPONENTS.iter().zip(components).zip(&p.components) {
        let entry = v8::Object::new(scope);
        let text = v8::String::new(scope, &text).map_or_else(|| v8::undefined(scope).into(), Into::into);
        set(scope, entry, "input", text);
        let groups = v8::Object::new(scope);
        for (group, value) in component.groups.iter().zip(values) {
            let value = value.and_then(|v| v8::String::new(scope, &v)).map_or_else(|| v8::undefined(scope).into(), Into::into);
            set(scope, groups, group, value);
        }
        set(scope, entry, "groups", groups.into());
        set(scope, result, name, entry.into());
    }
    rv.set(result.into());
}
