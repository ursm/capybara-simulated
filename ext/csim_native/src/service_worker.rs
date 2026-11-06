// Service Workers' rules for a registration (Service Workers §8): the URLs a register() names (Start Register), and
// whether a scope is one its script may control — the Update algorithm's max scope check, after the script's fetch.

use ada_url::Url;

// Start Register: a register()'s script URL and scope (none: the script's directory), parsed against `base`, their
// fragments dropped — or the error it rejects with, `[name, message]`: a TypeError for a URL that does not parse, one
// whose scheme is not HTTP(S) or whose path holds an encoded slash or backslash (checked before origins: a data: scope is
// a TypeError, not a SecurityError — registration-scope), a SecurityError for one not of the client's `origin` (which,
// opaque, no URL's is).
pub(crate) fn start_register(script: &str, scope: Option<&str>, base: &str, origin: &str) -> Result<(String, String), (&'static str, &'static str)> {
    const INVALID: &str = "Failed to register a ServiceWorker: An invalid URL was provided.";
    let parse = |input: &str, base: &str| {
        let mut url = Url::parse(input, Some(base)).map_err(|_| ("TypeError", INVALID))?;
        url.set_hash(None);
        Ok::<Url, (&'static str, &'static str)>(url)
    };
    let script_url = parse(script, base)?;
    let scope_url = parse(scope.unwrap_or("./"), if scope.is_some() { base } else { script_url.href() })?;
    for url in [&script_url, &scope_url] {
        if !matches!(url.protocol(), "http:" | "https:") {
            return Err(("TypeError", "Failed to register a ServiceWorker: The URL protocol of the current origin is not supported."));
        }
        let path = url.pathname().to_ascii_lowercase();
        if path.contains("%2f") || path.contains("%5c") {
            return Err(("TypeError", "Failed to register a ServiceWorker: The provided URL contains a URL-encoded slash or backslash."));
        }
    }
    if script_url.origin() != origin || origin == "null" {
        return Err(("SecurityError", "The origin of the provided scriptURL does not match the current origin"));
    }
    if scope_url.origin() != origin {
        return Err(("SecurityError", "The origin of the provided scope does not match the current origin"));
    }
    Ok((script_url.href().to_owned(), scope_url.href().to_owned()))
}
// …for the host: `["ok", script URL, scope]`, or `[error name, message]`.
pub(crate) fn start_register_for_ruby(script: String, scope: Option<String>, base: String, origin: String) -> Vec<String> {
    match start_register(&script, scope.as_deref(), &base, &origin) {
        Ok((script, scope)) => vec!["ok".to_owned(), script, scope],
        Err((name, message)) => vec![name.to_owned(), message.to_owned()],
    }
}

// The Update algorithm's max scope: the script's directory, or — given a `Service-Worker-Allowed` header — the path the
// header names against the script's URL, where that is of the script's origin (one of another none at all); the scope
// allowed where its path starts with it.
pub(crate) fn scope_allowed(scope: &str, script: &str, service_worker_allowed: Option<&str>) -> bool {
    let (Ok(scope), Ok(script_url)) = (Url::parse(scope, None), Url::parse(script, None)) else { return false };
    let max = match service_worker_allowed {
        None => Url::parse("./", Some(script)).ok(),
        Some(allowed) => Url::parse(allowed, Some(script)).ok().filter(|u| u.origin() == script_url.origin()),
    };
    max.is_some_and(|max| scope.pathname().starts_with(max.pathname()))
}

// …of a response whose `Service-Worker-Allowed` is `service_worker_allowed`, combined: none where it passes, else why: "scope"
// (a SecurityError), or "network" where the header is more than one value ("extracting header list values" fails).
fn max_scope_failure(scope: &str, script: &str, service_worker_allowed: Option<&str>) -> Option<&'static str> {
    let values = service_worker_allowed.map(crate::headers::decode_split);
    if values.as_ref().is_some_and(|v| v.len() > 1) {
        return Some("network");
    }
    let allowed = values.as_ref().and_then(|v| v.first()).map(String::as_str);
    (!scope_allowed(scope, script, allowed)).then_some("scope")
}

// A service worker's script resource map (SW "script resource map"), as far as an update is judged by it: the bytes of its
// main script and of each script it imported, by URL, in the order it first imported them. A worker's isolate writes the
// imports from its own thread as it evaluates (`sw_note_import`) while a job on the main thread may read them: they are
// the registry's, behind its lock, a job taking its copy of them as it begins.
#[derive(Clone, Default)]
pub(crate) struct ScriptResources {
    pub(crate) script: Vec<u8>,
    pub(crate) imports: Vec<(String, Vec<u8>)>,
}

impl ScriptResources {
    pub(crate) fn note_import(&mut self, url: String, body: Vec<u8>) {
        match self.imports.iter_mut().find(|(u, _)| *u == url) {
            Some((_, kept)) => *kept = body,
            None => self.imports.push((url, body)),
        }
    }
}

// What a job's fetch of its script knows beside the host's responses: SW "Update", the fetch hook and its byte check.
pub(crate) struct UpdateCheck {
    pub(crate) scope: String,
    pub(crate) script_url: String,
    // The registration's update via cache mode, or the Register job's own, not stored until its worker evaluates.
    pub(crate) update_via_cache: String,
    pub(crate) module: bool,
    // The newest worker's map, where that runs this script under this type — none otherwise, which is an update already.
    pub(crate) newest: Option<ScriptResources>,
}

impl UpdateCheck {
    // The main script's request's cache mode: "no-cache" unless the mode is "all". (`registration is stale` not modelled: a
    // test's session never gets 24 h old by its wall clock)
    fn script_cache_mode(&self) -> &'static str {
        if self.update_via_cache == "all" { "default" } else { "no-cache" }
    }
    // …an import's: "no-cache" where the mode is "none". A classic worker's a `script` request; a module worker's graph is of
    // its worker's destination, a CORS request (HTML "fetch a module worker script graph").
    fn import_request(&self) -> (&'static str, Option<&'static str>, &'static str) {
        let cache = if self.update_via_cache == "none" { "no-cache" } else { "default" };
        if self.module { (cache, Some("cors"), "serviceworker") } else { (cache, None, "script") }
    }
    // The main script's response: whether its bytes make it an update, or what is wrong with it: "network" (a response that
    // never came, or of a status not ok), "redirect" (its redirect mode "error"), "mime" (no JavaScript MIME type: a
    // SecurityError), then the max scope's. The status comes before the MIME type, where SW's hook checks the MIME type with
    // no word of the status: a 404's HTML page rejects with a TypeError (WPT registration-script, Chrome and Firefox).
    fn script_response(&self, response: &ScriptResponse) -> Result<bool, &'static str> {
        if !response.loaded {
            return Err("network");
        }
        if response.redirected {
            return Err("redirect");
        }
        if !response.ok() {
            return Err("network");
        }
        if !response.javascript() {
            return Err("mime");
        }
        if let Some(failure) = max_scope_failure(&self.scope, &self.script_url, response.service_worker_allowed.as_deref()) {
            return Err(failure);
        }
        Ok(self.newest.as_ref().is_none_or(|newest| newest.script != response.body))
    }
    // The imports the byte check goes over, from the one numbered `from`: each of the newest worker's but its main script
    // ("If importUrl is url, then continue") — every one of them, the loop not stopping at the first that differs, "to
    // populate the cache" (SW's note): the new version runs from the responses this got.
    fn import_at(&self, from: usize) -> Option<(usize, &(String, Vec<u8>))> {
        let imports = &self.newest.as_ref()?.imports;
        imports.iter().enumerate().skip(from).find(|(_, (url, _))| *url != self.script_url)
    }
    // Whether the newest worker imported its own main script, whose entry in the new version's map is that response.
    fn imports_itself(&self) -> bool {
        self.newest.as_ref().is_some_and(|n| n.imports.iter().any(|(url, _)| *url == self.script_url))
    }
}

// A response as the host hands it over (browser.rb `rack_fetch`), what the check and the new version's map read of it.
#[derive(Default)]
struct ScriptResponse {
    loaded: bool,
    redirected: bool,
    status: i64,
    kind: Option<String>,
    tainted: bool,
    headers: Vec<(String, String)>,
    content_type: Option<String>,
    service_worker_allowed: Option<String>,
    body: Vec<u8>,
}

impl ScriptResponse {
    fn read(ruby: &magnus::Ruby, response: Option<magnus::RHash>) -> Result<Self, magnus::Error> {
        use magnus::value::ReprValue;
        use magnus::{TryConvert, Value};
        let Some(response) = response else { return Ok(Self::default()) };
        let field = |key: &str| response.get(ruby.str_new(key)).filter(|v: &Value| !v.is_nil());
        let mut out = ScriptResponse {
            loaded: field("body_error").is_none_or(|v| !v.to_bool()),
            redirected: field("redirect_loc").is_some() || field("redirect_status").is_some(),
            status: field("status").map_or(Ok(0), |v| v.funcall("to_i", ()))?,
            kind: field("type").map(String::try_convert).transpose()?,
            tainted: field("tainted").is_some_and(|v| v.to_bool()),
            body: field("body").map(magnus::RString::try_convert).transpose()?.map(crate::fetch_rules::ruby_bytes).unwrap_or_default(),
            ..Self::default()
        };
        if let Some(headers) = field("headers").map(magnus::RHash::try_convert).transpose()? {
            headers.foreach(|name: Value, value: Value| {
                out.headers.push((name.funcall("to_s", ())?, value.funcall("to_s", ())?));
                Ok(magnus::r_hash::ForEach::Continue)
            })?;
        }
        out.content_type = out.header("content-type");
        out.service_worker_allowed = out.header("service-worker-allowed");
        Ok(out)
    }
    fn header(&self, name: &str) -> Option<String> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())
    }
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
    fn javascript(&self) -> bool {
        self.content_type.as_deref().is_some_and(crate::script::javascript_content)
    }
    // Whether it is an import's that the check ignores, SW's "bad import script response": one that never came, of a status
    // not ok, or of no JavaScript MIME type.
    fn bad_import(&self) -> bool {
        !self.loaded || !self.ok() || !self.javascript()
    }
    // Whether, the response to import `stored`, it makes an update.
    fn differs_from(&self, stored: &[u8]) -> bool {
        !self.bad_import() && stored != self.body
    }
    // Its entry in the new version's script resource map, what its importScripts is answered with instead of a fetch — one
    // that never came or of a status not ok as a 404, which stays what that import sees (update-import-scripts "missing the
    // other"), not a lucky re-fetch. The body crosses into the isolate as JSON, so as UTF-8: a non-UTF-8 one with replacement
    // characters, as a real browser runs it. (…its tainting kept, for the new version's import to mute an opaque one's errors
    // as the first did)
    fn map_entry(&self, ruby: &magnus::Ruby) -> Result<magnus::RHash, magnus::Error> {
        let entry = ruby.hash_new();
        let headers = ruby.hash_new();
        if !self.loaded || !self.ok() {
            entry.aset("status", 404)?;
            entry.aset("headers", headers)?;
            entry.aset("body", "")?;
            return Ok(entry);
        }
        for (name, value) in &self.headers {
            headers.aset(name.as_str(), value.as_str())?;
        }
        entry.aset("status", self.status)?;
        entry.aset("type", self.kind.as_deref())?;
        entry.aset("tainted", self.tainted)?;
        entry.aset("headers", headers)?;
        entry.aset("body", String::from_utf8_lossy(&self.body).as_ref())?;
        Ok(entry)
    }
}

// How far it has got: why the script failed, `hasUpdatedResources`, the next import to probe, the main script's response, and
// the imports' as they came.
#[derive(Default)]
struct UpdateProgress {
    failure: Option<&'static str>,
    changed: bool,
    next: usize,
    script: Option<ScriptResponse>,
    imports: Vec<(String, ScriptResponse)>,
}

// Native::ServiceWorkerUpdate — a job's fetch of its worker's script, as the host makes it (browser.rb `sw_update_fetch`):
// what to request, what each response makes of it; the host's the requests themselves.
#[magnus::wrap(class = "Capybara::Simulated::Native::ServiceWorkerUpdate", free_immediately)]
pub(crate) struct ServiceWorkerUpdate {
    check: UpdateCheck,
    progress: std::cell::RefCell<UpdateProgress>,
}

impl ServiceWorkerUpdate {
    // ServiceWorkerUpdate.new(partition, job) -> its fetch; an error for a job that is gone, which the host just read.
    fn new(ruby: &magnus::Ruby, partition: u64, job: u32) -> Result<Self, magnus::Error> {
        let check = crate::sw_registry::update_check(partition, job).ok_or_else(|| magnus::Error::new(ruby.exception_arg_error(), "no such job"))?;
        Ok(ServiceWorkerUpdate { check, progress: Default::default() })
    }
    // #cache_mode -> the main script's request's.
    fn cache_mode(&self) -> &'static str {
        self.check.script_cache_mode()
    }
    // #script_response(response): the main script's, nil for none.
    fn script_response(ruby: &magnus::Ruby, rb_self: &Self, response: Option<magnus::RHash>) -> Result<(), magnus::Error> {
        let response = ScriptResponse::read(ruby, response)?;
        let mut progress = rb_self.progress.borrow_mut();
        match rb_self.check.script_response(&response) {
            Ok(changed) => progress.changed = changed,
            Err(failure) => progress.failure = Some(failure),
        }
        progress.script = Some(response);
        Ok(())
    }
    // #next_import -> the next import to probe, `[URL, cache mode, CORS mode, destination]` — nil when none is left, and for an
    // update its main script's bytes already made, or that failed.
    fn next_import(&self) -> Option<(String, &'static str, Option<&'static str>, &'static str)> {
        let mut progress = self.progress.borrow_mut();
        if progress.failure.is_some() || (progress.changed && progress.next == 0) {
            return None;
        }
        let (at, (url, _)) = self.check.import_at(progress.next)?;
        progress.next = at + 1;
        let (cache, cors, dest) = self.check.import_request();
        Some((url.clone(), cache, cors, dest))
    }
    // #import_response(response): the response to the import `next_import` gave, nil for none.
    fn import_response(ruby: &magnus::Ruby, rb_self: &Self, response: Option<magnus::RHash>) -> Result<(), magnus::Error> {
        let response = ScriptResponse::read(ruby, response)?;
        let mut progress = rb_self.progress.borrow_mut();
        let Some((url, stored)) = progress.next.checked_sub(1).and_then(|at| rb_self.check.newest.as_ref()?.imports.get(at)) else { return Ok(()) };
        progress.changed |= response.differs_from(stored);
        progress.imports.push((url.clone(), response));
        Ok(())
    }
    // #outcome -> what the job does with it (`job_fetched`): `{'error' => class}` — 'network', 'redirect' (TypeErrors), 'mime',
    // 'scope' (SecurityErrors), which update() rejects with — or `{'changed' => false}`, or `{'changed' => true, 'body' => the
    // main script's bytes, 'imports' => the new version's script resource map}`, nil where nothing is in it.
    fn outcome(ruby: &magnus::Ruby, rb_self: &Self) -> Result<magnus::RHash, magnus::Error> {
        let progress = rb_self.progress.borrow();
        let out = ruby.hash_new();
        if let Some(failure) = progress.failure {
            out.aset("error", failure)?;
            return Ok(out);
        }
        out.aset("changed", progress.changed)?;
        if progress.changed {
            let script = progress.script.as_ref();
            out.aset("body", ruby.str_from_slice(script.map_or(&[][..], |s| &s.body)))?;
            let imports = ruby.hash_new();
            for (url, response) in &progress.imports {
                imports.aset(url.as_str(), response.map_entry(ruby)?)?;
            }
            // (…one that imported its own main script finding it there: that response, not a second fetch)
            if let Some(script) = script.filter(|_| rb_self.check.imports_itself() && !progress.imports.is_empty()) {
                imports.aset(rb_self.check.script_url.as_str(), script.map_entry(ruby)?)?;
            }
            if !imports.is_empty() {
                out.aset("imports", imports)?;
            }
        }
        Ok(out)
    }
}

pub(crate) fn define(native: magnus::RModule, ruby: &magnus::Ruby) -> Result<(), magnus::Error> {
    use magnus::{function, method, Module, Object};
    let class = native.define_class("ServiceWorkerUpdate", ruby.class_object())?;
    class.define_singleton_method("new", function!(ServiceWorkerUpdate::new, 2))?;
    class.define_method("cache_mode", method!(ServiceWorkerUpdate::cache_mode, 0))?;
    class.define_method("script_response", method!(ServiceWorkerUpdate::script_response, 1))?;
    class.define_method("next_import", method!(ServiceWorkerUpdate::next_import, 0))?;
    class.define_method("import_response", method!(ServiceWorkerUpdate::import_response, 1))?;
    class.define_method("outcome", method!(ServiceWorkerUpdate::outcome, 0))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(mode: &str, module: bool, newest: Option<ScriptResources>) -> UpdateCheck {
        UpdateCheck { scope: "https://a.test/app/".into(), script_url: "https://a.test/app/sw.js".into(), update_via_cache: mode.into(), module, newest }
    }
    fn js(status: i64, body: &[u8]) -> ScriptResponse {
        ScriptResponse { loaded: true, status, content_type: Some("text/javascript".to_owned()), body: body.to_vec(), ..ScriptResponse::default() }
    }
    fn resources() -> ScriptResources {
        let mut map = ScriptResources { script: b"main".to_vec(), imports: Vec::new() };
        map.note_import("https://a.test/a.js".into(), b"a".to_vec());
        map.note_import("https://a.test/app/sw.js".into(), b"main".to_vec());
        map.note_import("https://a.test/b.js".into(), b"b".to_vec());
        map
    }

    #[test]
    fn a_script_s_response_fails_in_the_hook_s_order() {
        let c = check("imports", false, None);
        assert_eq!(c.script_response(&ScriptResponse { loaded: false, ..js(200, b"") }), Err("network"));
        assert_eq!(c.script_response(&ScriptResponse { redirected: true, ..js(302, b"") }), Err("redirect"));
        assert_eq!(c.script_response(&ScriptResponse { content_type: Some("text/html".to_owned()), ..js(404, b"") }), Err("network"));
        assert_eq!(c.script_response(&ScriptResponse { content_type: Some("text/html".to_owned()), ..js(200, b"") }), Err("mime"));
        assert_eq!(c.script_response(&ScriptResponse { content_type: None, ..js(200, b"") }), Err("mime"));
        let outside = UpdateCheck { scope: "https://a.test/other/".into(), ..check("imports", false, None) };
        assert_eq!(outside.script_response(&js(200, b"")), Err("scope"));
        assert_eq!(outside.script_response(&ScriptResponse { service_worker_allowed: Some("/".to_owned()), ..js(200, b"") }), Ok(true));
        assert_eq!(outside.script_response(&ScriptResponse { service_worker_allowed: Some("/a, /b".to_owned()), ..js(200, b"") }), Err("network"));
    }

    #[test]
    fn a_script_is_an_update_where_no_worker_runs_it_or_its_bytes_differ() {
        assert_eq!(check("imports", false, None).script_response(&js(200, b"main")), Ok(true));
        assert_eq!(check("imports", false, Some(resources())).script_response(&js(200, b"main")), Ok(false));
        assert_eq!(check("imports", false, Some(resources())).script_response(&js(200, b"main2")), Ok(true));
    }

    #[test]
    fn the_cache_modes_are_the_update_via_cache_mode_s() {
        assert_eq!(check("all", false, None).script_cache_mode(), "default");
        assert_eq!(check("imports", false, None).script_cache_mode(), "no-cache");
        assert_eq!(check("none", false, None).script_cache_mode(), "no-cache");
        assert_eq!(check("all", false, None).import_request(), ("default", None, "script"));
        assert_eq!(check("none", false, None).import_request(), ("no-cache", None, "script"));
        assert_eq!(check("imports", true, None).import_request(), ("default", Some("cors"), "serviceworker"));
    }

    #[test]
    fn the_byte_check_goes_over_every_import_but_the_main_script() {
        let c = check("imports", false, Some(resources()));
        assert!(c.imports_itself());
        let (at, (url, _)) = c.import_at(0).unwrap();
        assert_eq!((at, url.as_str()), (0, "https://a.test/a.js"));
        let (at, (url, _)) = c.import_at(1).unwrap();
        assert_eq!((at, url.as_str()), (2, "https://a.test/b.js"));
        assert!(c.import_at(3).is_none());
        assert!(check("imports", false, None).import_at(0).is_none());
    }

    #[test]
    fn a_bad_import_script_response_is_no_change() {
        assert!(!js(200, b"a").differs_from(b"a"));
        assert!(js(200, b"a2").differs_from(b"a"));
        assert!(!js(404, b"a2").differs_from(b"a"));
        assert!(!ScriptResponse { loaded: false, ..js(200, b"a2") }.differs_from(b"a"));
        assert!(!ScriptResponse { content_type: Some("text/html".to_owned()), ..js(200, b"a2") }.differs_from(b"a"));
    }

    #[test]
    fn an_import_noted_again_keeps_its_place_with_its_last_bytes() {
        let mut map = resources();
        map.note_import("https://a.test/a.js".into(), b"a2".to_vec());
        assert_eq!(map.imports[0], ("https://a.test/a.js".to_owned(), b"a2".to_vec()));
        assert_eq!(map.imports.len(), 3);
    }

    #[test]
    fn starts_a_register_from_its_urls() {
        let base = "https://a.test/dir/page.html";
        let origin = "https://a.test";
        assert_eq!(
            start_register("sw.js#x", None, base, origin),
            Ok(("https://a.test/dir/sw.js".into(), "https://a.test/dir/".into()))
        );
        assert_eq!(start_register("sw.js", Some("/s#f"), base, origin), Ok(("https://a.test/dir/sw.js".into(), "https://a.test/s".into())));
        assert_eq!(start_register("sw.js", Some("data:,x"), base, origin).unwrap_err().0, "TypeError");
        assert_eq!(start_register("a%2Fb.js", None, base, origin).unwrap_err().0, "TypeError");
        assert_eq!(start_register("https://b.test/sw.js", None, base, origin).unwrap_err().0, "SecurityError");
        assert_eq!(start_register("sw.js", Some("https://b.test/"), base, origin).unwrap_err().0, "SecurityError");
        assert_eq!(start_register("sw.js", None, base, "null").unwrap_err().0, "SecurityError");
        assert_eq!(start_register("http://[", None, base, origin).unwrap_err().0, "TypeError");
    }

    #[test]
    fn a_scope_within_its_max_scope() {
        let script = "https://a.test/w/resources/sw.js?x";
        assert!(scope_allowed("https://a.test/w/resources/sub/", script, None));
        assert!(!scope_allowed("https://a.test/w/", script, None));
        assert!(scope_allowed("https://a.test/allowed-path", script, Some("/allowed-path")));
        assert!(!scope_allowed("https://a.test/disallowed-path", script, Some("../allowed-path")));
        assert!(scope_allowed("https://a.test/w/allowed-path-with-parent", script, Some("../allowed-path-with-parent")));
        assert!(!scope_allowed("https://a.test/w/resources/x", script, Some("https://b.test/")));
        assert_eq!(crate::headers::decode_split("/a, \"/b,c\" ,/d"), ["/a", "\"/b,c\"", "/d"]);
        assert_eq!(max_scope_failure("https://a.test/", script, Some("/x, /")), Some("network"));
        assert_eq!(max_scope_failure("https://a.test/", script, Some("/")), None);
        assert_eq!(max_scope_failure("https://a.test/", script, None), Some("scope"));
    }
}

// Whether `clients.claim()` of the registration at `scope` claims a client whose URL is `href` (Service Workers §4.3.4):
// the client's in that scope — its URL starts with it — and that is its LONGEST matching registration: where a strictly
// longer one of `scopes`, the origin's registrations, covers it too, a more specific worker controls it, not the claiming
// one (claim-not-using-registration).
pub(crate) fn claims(href: &str, scope: &str, scopes: &[String]) -> bool {
    !scope.is_empty() && href.starts_with(scope) && !scopes.iter().any(|s| s.len() > scope.len() && href.starts_with(s.as_str()))
}

// What a service worker's realm is spawned with (the host's, `run_worker`): its registration's scope, its updateViaCache
// mode, the version active beside it as it installs (its script URL and handle), and the Update probe's responses of
// the scripts it imports (its script resource map's — Service Workers §3.1.4 "Update", each a JSON record), which its
// `importScripts` take, each once, in place of a fetch — and whether it is past installing (`swInstalled`), after which
// it imports what its script resource map holds alone.
#[derive(Default)]
pub(crate) struct ServiceWorkerGlobal {
    scope: String,
    update_via_cache: String,
    previous_active: Option<(String, u32)>,
    probed_imports: std::collections::HashMap<String, String>,
    installed: bool,
}

impl ServiceWorkerGlobal {
    // Whether it is past installing — its install event's lifetime promises settled, whatever came of them: an
    // `importScripts` of a URL its script resource map does not hold a NetworkError then (Service Workers §4.3
    // "importScripts(urls)": its state past `parsed` and `installing`).
    pub(crate) fn installed(&self) -> bool {
        self.installed
    }
    // The cache mode its `importScripts` fetches in: `no-cache` under an updateViaCache of `none` (every import
    // revalidated), else none (the HTTP cache read).
    pub(crate) fn import_cache_mode(&self) -> Option<&'static str> {
        (self.update_via_cache == "none").then_some("no-cache")
    }
    // The Update probe's record of the script at `url`, as JSON — taken: a second import of it fetches.
    pub(crate) fn take_probed_import(&mut self, url: &str) -> Option<String> {
        self.probed_imports.remove(url)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "swGlobalInit", global_init_op, context_id);
    crate::dom::register(scope, ns, "swGlobal", global_op, context_id);
    crate::dom::register(scope, ns, "swInstalled", installed_op, context_id);
    crate::dom::register(scope, ns, "swClaims", claims_op, context_id);
}

// __dom.swGlobalInit(scope, updateViaCache, importsJson, previousUrl, previousHandle): the calling realm a service worker's,
// spawned with these (`ServiceWorkerGlobal`) — `importsJson` an object of the probe's records by URL, or null.
fn global_init_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let text = |scope: &mut v8::PinScope<'_, '_>, i| (!args.get(i).is_null_or_undefined()).then(|| args.get(i).to_rust_string_lossy(scope));
    let probed_imports = text(scope, 2)
        .and_then(|json| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json).ok())
        .map(|map| map.into_iter().map(|(url, record)| (url, record.to_string())).collect())
        .unwrap_or_default();
    let previous_active = text(scope, 3).map(|url| (url, args.get(4).uint32_value(scope).unwrap_or(0)));
    let global = ServiceWorkerGlobal { scope: text(scope, 0).unwrap_or_default(), update_via_cache: text(scope, 1).unwrap_or_default(), previous_active, probed_imports, ..Default::default() };
    let cid = crate::dom::realm_id(scope, &args);
    if let Some(s) = crate::dom::realm(scope, cid).realm_state_mut(cid) {
        s.service_worker = Some(global);
    }
}
// __dom.swGlobal() -> `[scope, updateViaCache, previousUrl, previousHandle]` of the calling service worker's realm
// ('' for a scope or a mode it was given none of, nulls for no previous version), or undefined for another realm.
fn global_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(g) = crate::dom::realm(scope, cid).realm_state(cid).and_then(|s| s.service_worker.as_ref()) else { return };
    let (sw_scope, uvc, previous) = (g.scope.clone(), g.update_via_cache.clone(), g.previous_active.clone());
    fn string<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
        v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
    }
    let items: [v8::Local<'_, v8::Value>; 4] = [
        string(scope, &sw_scope),
        string(scope, &uvc),
        match &previous { Some((url, _)) => string(scope, url), None => v8::null(scope).into() },
        match previous { Some((_, handle)) => v8::Integer::new_from_unsigned(scope, handle).into(), None => v8::null(scope).into() },
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.swInstalled(): the calling service worker past installing — its install event's lifetime promises settled,
// whatever came of them.
fn installed_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    if let Some(g) = crate::dom::realm(scope, cid).realm_state_mut(cid).and_then(|s| s.service_worker.as_mut()) {
        g.installed = true;
    }
}
// __dom.swClaims(href, scope, scopes) -> `claims`.
fn claims_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let href = args.get(0).to_rust_string_lossy(scope);
    let claiming = args.get(1).to_rust_string_lossy(scope);
    let mut scopes = Vec::new();
    if let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(2)) {
        for i in 0..list.length() {
            if let Some(s) = list.get_index(scope, i) {
                scopes.push(s.to_rust_string_lossy(scope));
            }
        }
    }
    rv.set_bool(claims(&href, &claiming, &scopes));
}
