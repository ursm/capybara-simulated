// A service worker's static router (ServiceWorker Static Routing API): the rules `InstallEvent.addRoutes` registers —
// each a condition and a source — verified and kept here, for the worker's realm, and the source of the first one a
// request matches chosen as Handle Fetch evaluates them, before any fetch event exists. A rule's URL pattern is a
// URLPattern (url_pattern.rs), the worker's script URL its base URL.

use std::borrow::Cow;

use urlpattern::quirks::StringOrInit;

// The spec's limits: the rules a worker registers in all, and how deep a condition nests.
const MAX_RULES: usize = 1024;
const MAX_CONDITION_DEPTH: usize = 10;

enum Condition {
    Or(Vec<Condition>),
    Not(Box<Condition>),
    // (…every member given matching; a running status always "running" for the worker evaluating its own rules)
    Match {
        url_pattern: Option<crate::url_pattern::Pattern>,
        method: Option<String>,
        mode: Option<String>,
        destination: Option<String>,
        running_status: Option<String>,
    },
}

enum Source {
    Named(String),
    Cache(String),
}

pub(crate) struct Rule {
    condition: Condition,
    source: Source,
}

fn throw_type_error(scope: &mut v8::PinScope<'_, '_>, message: &str) {
    if let Some(message) = v8::String::new(scope, &format!("addRoutes: {message}")) {
        let error = v8::Exception::type_error(scope, message);
        scope.throw_exception(error);
    }
}

// The member `key` of a converted dictionary, None where it is not given.
fn member<'s>(scope: &mut v8::PinScope<'s, '_>, dict: v8::Local<'_, v8::Object>, key: &str) -> Option<v8::Local<'s, v8::Value>> {
    let k = v8::String::new(scope, key)?;
    dict.get(scope, k.into()).filter(|v| !v.is_undefined())
}
fn text(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> String {
    value.to_rust_string_lossy(scope)
}

// "Verify a router condition" of a converted RouterCondition at `depth`: at most the depth limit, one member at least,
// `or` and `not` each alone; a URL pattern built from a URLPatternCompatible — a URLPattern as it is, a string or a
// URLPatternInit against the worker's script URL `base` (an explicit `baseURL` winning) — with no regular expression
// group, whose cost per request is unbounded; a method a token, no forbidden one, normalized.
fn condition(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>, depth: usize, base: &str) -> Result<Condition, &'static str> {
    if depth > MAX_CONDITION_DEPTH {
        return Err("condition exceeds the depth limit");
    }
    let dict = v8::Local::<v8::Object>::try_from(value).map_err(|_| "condition has no members")?;
    let or = member(scope, dict, "or");
    let not = member(scope, dict, "not");
    let url_pattern = member(scope, dict, "urlPattern");
    let method = member(scope, dict, "requestMethod");
    let [mode, destination, running_status] =
        ["requestMode", "requestDestination", "runningStatus"].map(|k| member(scope, dict, k).map(|v| text(scope, v)));
    let members = [or.is_some(), not.is_some(), url_pattern.is_some(), method.is_some(), mode.is_some(), destination.is_some(), running_status.is_some()]
        .iter()
        .filter(|&&m| m)
        .count();
    if members == 0 {
        return Err("condition has no members");
    }
    if (or.is_some() || not.is_some()) && members > 1 {
        return Err("or/not cannot be combined with other conditions");
    }
    if let Some(or) = or {
        let list = v8::Local::<v8::Array>::try_from(or).map_err(|_| "condition has no members")?;
        let mut conditions = Vec::with_capacity(list.length() as usize);
        for i in 0..list.length() {
            let item = list.get_index(scope, i).ok_or("condition has no members")?;
            conditions.push(condition(scope, item, depth + 1, base)?);
        }
        return Ok(Condition::Or(conditions));
    }
    if let Some(not) = not {
        return Ok(Condition::Not(Box::new(condition(scope, not, depth + 1, base)?)));
    }
    let url_pattern = match url_pattern {
        None => None,
        Some(value) => {
            let pattern = match crate::url_pattern::pattern(scope, value) {
                Some(pattern) => pattern.clone(),
                None => {
                    let input = match crate::url_pattern::pattern_input(scope, value) {
                        StringOrInit::Init(mut init) => {
                            init.base_url.get_or_insert_with(|| base.to_owned());
                            StringOrInit::Init(init)
                        }
                        input => input,
                    };
                    let string_base = matches!(input, StringOrInit::String(_)).then_some(base);
                    crate::url_pattern::create(scope, input, string_base, false).map_err(|_| "invalid urlPattern")?
                }
            };
            if pattern.has_regexp_groups() {
                return Err("urlPattern with regexp groups is not allowed");
            }
            Some(pattern)
        }
    };
    let method = match method {
        None => None,
        Some(value) => {
            let shown = text(scope, value);
            let bytes = crate::fetch_rules::byte_string(scope, value);
            if !crate::fetch_rules::is_token(&bytes) {
                return Err("requestMethod is not a valid HTTP method");
            }
            if crate::fetch_rules::forbidden_method(&bytes) {
                return Err("requestMethod is a forbidden method");
            }
            Some(crate::fetch_rules::normalized_method(&bytes).map_or(shown, str::to_owned))
        }
    };
    Ok(Condition::Match { url_pattern, method, mode, destination, running_status })
}

// A RouterSource: a RouterSourceEnum, or a RouterSourceDict naming its cache.
fn source(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Result<Source, &'static str> {
    if value.is_string() {
        return Ok(Source::Named(text(scope, value)));
    }
    let dict = v8::Local::<v8::Object>::try_from(value).map_err(|_| "invalid source")?;
    match member(scope, dict, "cacheName") {
        Some(name) => Ok(Source::Cache(text(scope, name))),
        None => Err("invalid source"),
    }
}

// A converted RouterRule: its source, then its condition, verified.
fn rule(scope: &mut v8::PinScope<'_, '_>, rule: v8::Local<'_, v8::Object>, has_fetch_handler: bool, base: &str) -> Result<Rule, &'static str> {
    let given = member(scope, rule, "source").ok_or("invalid source")?;
    let source = source(scope, given)?;
    if let Source::Named(name) = &source {
        if !has_fetch_handler {
            match name.as_str() {
                "fetch-event" => return Err("the fetch-event source requires a fetch event handler"),
                "race-network-and-fetch-handler" => return Err("the race-network-and-fetch-handler source requires a fetch event handler"),
                _ => {}
            }
        }
    }
    let given = member(scope, rule, "condition").ok_or("condition has no members")?;
    let condition = condition(scope, given, 1, base)?;
    Ok(Rule { condition, source })
}

impl Condition {
    // Whether a request of `url`, `method`, `mode` and `destination` matches.
    fn matches(&self, scope: &mut v8::PinScope<'_, '_>, url: &str, method: &str, mode: &str, destination: &str) -> bool {
        match self {
            Condition::Or(conditions) => conditions.iter().any(|c| c.matches(scope, url, method, mode, destination)),
            Condition::Not(condition) => !condition.matches(scope, url, method, mode, destination),
            Condition::Match { url_pattern, method: m, mode: md, destination: d, running_status } => {
                url_pattern.as_ref().is_none_or(|p| p.matched(scope, StringOrInit::String(Cow::Borrowed(url)), None).is_ok_and(|r| r.is_some()))
                    && m.as_deref().is_none_or(|m| m == method)
                    && md.as_deref().is_none_or(|m| m == mode)
                    && d.as_deref().is_none_or(|d| d == destination)
                    && running_status.as_deref().is_none_or(|s| s == "running")
            }
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "swAddRoutes", add_routes_op, context_id);
    crate::dom::register(scope, ns, "swRouterSource", router_source_op, context_id);
}

// __dom.swAddRoutes(rules, hasFetchHandler, scriptURL) — `InstallEvent.addRoutes` of `rules` the bindings converted: each
// verified (`condition`, `source`; a "fetch-event" or "race-network-and-fetch-handler" source only where the worker has a
// fetch handler), and all of them added to the realm's rules, or — a TypeError where one is refused, or where they would
// pass the limit — none.
fn add_routes_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(0)) else { return };
    let has_fetch_handler = args.get(1).boolean_value(scope);
    let base = text(scope, args.get(2));
    let mut rules = Vec::with_capacity(list.length() as usize);
    for i in 0..list.length() {
        let Some(item) = list.get_index(scope, i).and_then(|r| v8::Local::<v8::Object>::try_from(r).ok()) else { continue };
        match rule(scope, item, has_fetch_handler, &base) {
            Ok(rule) => rules.push(rule),
            Err(message) => return throw_type_error(scope, message),
        }
    }
    let cid = crate::dom::realm_id(scope, &args);
    let kept = crate::dom::dom(scope).sw_router_rules.entry(cid).or_default();
    if kept.len() + rules.len() > MAX_RULES {
        return throw_type_error(scope, "the number of router rules exceeds the limit");
    }
    kept.extend(rules);
}

// __dom.swRouterSource(url, method, mode, destination) -> the source of the realm's first rule a request of these
// matches — its RouterSourceEnum, or `{cacheName}` — or null for none (the fetch event, as without a router).
fn router_source_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let [url, method, mode, destination] = [0, 1, 2, 3].map(|i| text(scope, args.get(i)));
    let cid = crate::dom::realm_id(scope, &args);
    let Some(rules) = crate::dom::dom(scope).sw_router_rules.remove(&cid) else { return rv.set_null() };
    let found = rules.iter().find(|r| r.condition.matches(scope, &url, &method, &mode, &destination)).map(|r| match &r.source {
        Source::Named(name) => (name.clone(), false),
        Source::Cache(name) => (name.clone(), true),
    });
    crate::dom::dom(scope).sw_router_rules.insert(cid, rules);
    let Some((name, cache)) = found else { return rv.set_null() };
    let Some(name) = v8::String::new(scope, &name) else { return };
    if !cache {
        return rv.set(name.into());
    }
    let dict = v8::Object::new(scope);
    if let Some(key) = v8::String::new(scope, "cacheName") {
        dict.create_data_property(scope, key.into(), name.into());
    }
    rv.set(dict.into());
}
