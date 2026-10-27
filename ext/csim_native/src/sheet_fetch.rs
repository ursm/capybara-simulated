// A style sheet as fetched for a URL — a `<link>`'s and an `<?xml-stylesheet?>`'s, the cascade's sheets and `@import`s —
// and a `<link rel=stylesheet>`'s load: the engine's ladder (subresource_obtain.rs's host steps reach past it).
//   - a `data:` URL of CSS, a `blob:` URL's blob;
//   - the preload its request takes (preload_map.rs), its owner's once for the sheet it obtains;
//   - a controlling service worker's answer (destination `style`), one dispatch per request for the sheet its owner
//     obtains — the cascade, `.sheet` and the link's load share it — an `@import`'s per document and controller;
//   - the network's, through the asset cache the host keeps per document, a failure its owner's for the sheet it obtains
//     (the cache keeps none: Chrome's memory cache keeps no error).
// Judged by the engine (subresource_judge.rs `judge`, J_SHEET: a style sheet's type, its integrity against its owner's
// request's metadata, kept per what answered for the sheet), and decoded as CSS Syntax "decode" has it (text_codec.rs
// `stylesheet_encoding`), the encoding it decoded in kept by URL — an `@import`'s environment.
//
// A sheet owner's request (`SheetRequest`) is the one of the sheet it obtains (`NodeData::sheet_gen`): its integrity as it
// obtained it — a change of it after is no trigger to fetch again — and what its readers share. Kept by the owner
// (`RealmArena::sheet_requests`) until it goes; a realm's own (`RealmSheets`) until its page goes (`sheetsForget`).

use std::collections::HashMap;
use std::rc::Rc;

use crate::dom::{realm, realm_id, register, NodeId};
use crate::font_files::Terminated;
use crate::subresource_judge::{facts_of, judge, Consumer, Facts, J_SHEET, SRC_ASSET, SRC_NETWORK, SRC_SCHEME, SRC_SW_SYNC, S_NO_BODY, V_CROSS_ORIGIN, V_FETCHED, V_OK};
use crate::subresource_obtain::{call, H_ASSET, H_CHARSET, H_CONTROLLER, H_DOCUMENT, H_SW_ANSWER};
use crate::subresource_plan::{plan_in, PLAN_REQUEST};

// A sheet's owner, and its node document (its request's client's).
#[derive(Clone, Copy)]
pub(crate) struct Owner {
    pub(crate) id: NodeId,
    pub(crate) doc: Option<NodeId>,
}

#[derive(Default)]
pub(crate) struct SheetRequest {
    sheet_gen: u32,
    integrity: String,
    verdicts: HashMap<u32, u32>,
    // (…the preload it took, by request — `"{plan & PLAN_REQUEST} {url}"` — None for a network error)
    preload: Option<(String, Option<Rc<crate::preload_map::Response>>)>,
    // (…a controlling service worker's answers, by request: none where it let the request through)
    answers: HashMap<String, Option<v8::Global<v8::Value>>>,
    // (…a fetch through the asset cache that failed, and what it answered)
    failed: Option<(String, Option<v8::Global<v8::Value>>)>,
    // (…a `blob:` URL's sheet texts, by URL, `charset` and integrity)
    blob_texts: HashMap<String, Option<String>>,
}

// A realm's own: the encodings its sheets decoded in, by URL; an `@import`'s service worker answers, by controller and
// request; an `@import`'s `blob:` sheets' texts.
#[derive(Default)]
pub(crate) struct RealmSheets {
    encodings: HashMap<String, &'static str>,
    answers: HashMap<String, Option<v8::Global<v8::Value>>>,
    blob_texts: HashMap<String, Option<String>>,
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "fetchStyleSheet", fetch_style_sheet_op, context_id);
    register(scope, ns, "sheetIntegrity", sheet_integrity_op, context_id);
    register(scope, ns, "sheetEncodingOf", sheet_encoding_of_op, context_id);
    register(scope, ns, "sheetsForget", sheets_forget_op, context_id);
}

// A sheet as a response of it makes it: its text — None where it failed (none, or none to use), '' where it is no style
// sheet, a sheet with no rules (what the CSSOM exposes for one: Chrome, Firefox, and what the cascade keeps rather than
// fetch it again) — whether it is CORS-same-origin, which makes the sheet origin-clean (CSSOM; HTML's link "process the
// linked resource": a response of type `basic` or `cors`, an HTTP error's too, none of another origin nor a network
// error), its location (the URL its response came from — a redirect's last, a worker's answer's — `url` for a
// scheme's), its `Referrer-Policy`, the host's facts of the response (`meta`) and the worker's answer (`answer`), and
// whether the network answered.
struct Sheet {
    text: Option<String>,
    clean: bool,
    location: String,
    policy: Option<String>,
    meta: Option<v8::Global<v8::Value>>,
    answer: Option<v8::Global<v8::Value>>,
    network: bool,
}
impl Sheet {
    fn none(url: &str) -> Sheet {
        Sheet { text: None, clean: false, location: url.to_owned(), policy: None, meta: None, answer: None, network: false }
    }
    // …of `verdict` on a response whose text is `text`.
    fn of_verdict(verdict: u32, text: Option<String>, location: String) -> Sheet {
        let text = text.map(|t| if verdict & V_OK != 0 { t } else { String::new() });
        Sheet { text, clean: verdict & (V_FETCHED | V_CROSS_ORIGIN) == V_FETCHED, location, policy: None, meta: None, answer: None, network: false }
    }
}

fn text_value<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
}
fn member<'s>(scope: &mut v8::PinScope<'s, '_>, obj: v8::Local<'_, v8::Object>, k: &str) -> Option<v8::Local<'s, v8::Value>> {
    let k = v8::String::new(scope, k)?;
    obj.get(scope, k.into()).filter(|v| !v.is_null_or_undefined())
}
fn string_member(scope: &mut v8::PinScope<'_, '_>, obj: Option<v8::Local<'_, v8::Object>>, k: &str) -> Option<String> {
    obj.and_then(|o| member(scope, o, k)).map(|v| v.to_rust_string_lossy(scope))
}
// …a body's bytes: a view's, or a text's UTF-8.
fn bytes_of(scope: &mut v8::PinScope<'_, '_>, v: Option<v8::Local<'_, v8::Value>>) -> Option<Vec<u8>> {
    let v = v?;
    if v.is_string() {
        return Some(v.to_rust_string_lossy(scope).into_bytes());
    }
    crate::subresource_obtain::view_bytes(scope, v)
}
// …a response object's header `name` (its `headers`, a plain object).
fn header(scope: &mut v8::PinScope<'_, '_>, obj: Option<v8::Local<'_, v8::Object>>, name: &str) -> Option<String> {
    let headers = obj.and_then(|o| member(scope, o, "headers")).and_then(|h| v8::Local::<v8::Object>::try_from(h).ok())?;
    crate::fetch_rules::response_header(scope, headers, name)
}

// The owner `id`'s request of the sheet it obtains now, made where it has none of its sheet's count.
fn request_of(arena: &mut crate::dom::RealmArena, id: NodeId) -> &mut SheetRequest {
    let (sheet_gen, integrity) = arena.get(id).map_or((0, String::new()), |n| (n.sheet_gen, n.plain_attr("integrity").unwrap_or("").to_owned()));
    if arena.sheet_requests.get(&id).is_none_or(|r| r.sheet_gen != sheet_gen) {
        arena.sheet_requests.insert(id, SheetRequest { sheet_gen, integrity, ..Default::default() });
    }
    arena.sheet_requests.get_mut(&id).expect("just made")
}

// What the realm's sheets are judged and decoded in: its document (its mode a quirks one's), and the encoding it is in.
struct Env {
    doc: Option<NodeId>,
    charset: String,
}
fn env(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>) -> Result<Env, Terminated> {
    let doc = call(scope, host, H_DOCUMENT, &[])?.and_then(|d| v8::Local::new(scope, d).integer_value(scope)).and_then(NodeId::from_i64);
    let charset = call(scope, host, H_CHARSET, &[])?;
    let charset = crate::subresource_obtain::text_of(scope, charset).unwrap_or_default();
    Ok(Env { doc, charset })
}

// The verdict on a sheet's response (`judge`, J_SHEET) from `source` — `body` its bytes, hashed where its owner's request
// has integrity metadata — kept per source for the sheet its owner obtains.
fn judge_sheet(scope: &mut v8::PinScope<'_, '_>, cid: i32, env: &Env, owner: Option<Owner>, facts: &Facts, source: u32, body: &dyn Fn() -> Vec<u8>) -> u32 {
    let quirks = realm(scope, cid).document_mode(env.doc).0;
    let verdict = |integrity: &str| {
        let bytes = if integrity.is_empty() { Vec::new() } else { body() };
        let consumer = Consumer { kind: J_SHEET, obtains: 0, module_destination: "", preload_destination: "", integrity, body: &bytes, mode: "no-cors", quirks };
        judge(&consumer, source, facts)
    };
    let Some(owner) = owner else { return verdict("") };
    let request = request_of(realm(scope, cid), owner.id);
    if request.integrity.is_empty() {
        return verdict("");
    }
    if let Some(&v) = request.verdicts.get(&source) {
        return v;
    }
    let integrity = request.integrity.clone();
    let v = verdict(&integrity);
    request_of(realm(scope, cid), owner.id).verdicts.insert(source, v);
    v
}

// CSS Syntax "decode" of a sheet's bytes (text_codec.rs `stylesheet_encoding`): by its Content-Type's charset, an opening
// `@charset`, its environment's encoding — its owner's `charset`, else the importing sheet's or its document's — else
// UTF-8, a BOM's over all; the encoding it decoded with kept by `url`.
fn decode(scope: &mut v8::PinScope<'_, '_>, cid: i32, env: &Env, url: &str, bytes: &[u8], content_type: &str, owner: Option<Owner>, environment: Option<&str>) -> String {
    let charset = owner.and_then(|o| realm(scope, cid).get(o.id).and_then(|n| n.plain_attr("charset")).map(str::to_owned)).unwrap_or_default();
    let (text, encoding) = crate::text_codec::decode_stylesheet(bytes, content_type, &charset, environment.unwrap_or(&env.charset));
    if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
        s.sheet_fetches.encodings.insert(url.to_owned(), encoding);
    }
    text
}

// __dom.fetchStyleSheet(owner, ownerDoc, url, environment, referrer, host) -> `{text, clean, meta, location, policy,
// network, answer}` (`Sheet`) of the sheet at `url`: `owner` its `<link>`, whose request it is, of document `ownerDoc` —
// null for none (an `@import`'s, an `<?xml-stylesheet?>`'s); `environment` the encoding of the sheet importing it, `referrer` that sheet's location. Its
// referrer policy noted at its location, which the requests it is responsible for are made under (url_ops.rs
// `note_sheet_policy`).
fn fetch_style_sheet_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(5)) else { return };
    let owner = crate::dom::nid_arg(scope, &args, 0).map(|id| Owner { id, doc: crate::dom::nid_arg(scope, &args, 1) });
    let url = args.get(2).to_rust_string_lossy(scope);
    let text_arg = |scope: &mut v8::PinScope<'_, '_>, i: i32| args.get(i).is_string().then(|| args.get(i).to_rust_string_lossy(scope));
    let (environment, referrer) = (text_arg(scope, 3), text_arg(scope, 4));
    let cid = realm_id(scope, &args);
    let Ok(sheet) = style_sheet(scope, cid, host, owner, &url, environment.as_deref(), referrer.as_deref()) else { return };
    realm(scope, cid).note_sheet_policy(&sheet.location, sheet.policy.as_deref());
    let obj = v8::Object::new(scope);
    let text = match &sheet.text {
        Some(t) => text_value(scope, t),
        None => v8::null(scope).into(),
    };
    let policy = match &sheet.policy {
        Some(p) => text_value(scope, p),
        None => v8::null(scope).into(),
    };
    let meta = match &sheet.meta {
        Some(g) => v8::Local::new(scope, g),
        None => v8::null(scope).into(),
    };
    let answer = match &sheet.answer {
        Some(g) => v8::Local::new(scope, g),
        None => v8::null(scope).into(),
    };
    let fields = [
        ("text", text),
        ("clean", v8::Boolean::new(scope, sheet.clean).into()),
        ("meta", meta),
        ("location", text_value(scope, &sheet.location)),
        ("policy", policy),
        ("network", v8::Boolean::new(scope, sheet.network).into()),
        ("answer", answer),
    ];
    for (k, v) in fields {
        let k = text_value(scope, k);
        obj.set(scope, k, v);
    }
    rv.set(obj.into());
}

fn style_sheet(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, owner: Option<Owner>, url: &str, environment: Option<&str>, referrer: Option<&str>) -> Result<Sheet, Terminated> {
    use crate::fetch_rules::{fetch_route, ROUTE_BLOB, ROUTE_DATA};
    let env = env(scope, host)?;
    match fetch_route(url, 0, "") {
        ROUTE_DATA => return Ok(Sheet { text: data_sheet_text(scope, cid, &env, url, owner, environment), clean: true, ..Sheet::none(url) }),
        ROUTE_BLOB => return Ok(Sheet { text: blob_sheet_text(scope, cid, host, &env, url, owner, environment)?, clean: true, ..Sheet::none(url) }),
        _ => {}
    }
    if let Some(sheet) = preloaded_sheet(scope, cid, host, &env, url, owner, environment, referrer)? {
        return Ok(sheet);
    }
    if let Some(sheet) = worker_sheet(scope, cid, host, &env, url, owner, referrer)? {
        return Ok(sheet);
    }
    Ok(Sheet { network: true, ..network_sheet(scope, cid, host, &env, url, owner, environment, referrer)? })
}

// The plan of a sheet's request: its owner's (its `crossorigin`, its `referrerpolicy`), else the importing sheet's policy.
fn sheet_plan(scope: &mut v8::PinScope<'_, '_>, cid: i32, owner: Option<Owner>, referrer: Option<&str>) -> u32 {
    plan_in(realm(scope, cid), J_SHEET, owner.map(|o| o.id), owner.and_then(|o| o.doc), referrer)
}

// …a `data:` URL's: its body where its MIME type is `text/css` — none where it fails its owner's integrity (a network
// error) — decoded.
fn data_sheet_text(scope: &mut v8::PinScope<'_, '_>, cid: i32, env: &Env, url: &str, owner: Option<Owner>, environment: Option<&str>) -> Option<String> {
    let (mime, body) = crate::data_url::process(url)?;
    if crate::mime::parse(&mime).is_none_or(|m| m.essence != "text/css") {
        return None;
    }
    if owner.is_some() {
        let facts = Facts { response_type: "default".to_owned(), content_type: mime.clone(), ..Default::default() };
        if judge_sheet(scope, cid, env, owner, &facts, SRC_SCHEME, &|| body.clone()) == 0 {
            return None;
        }
    }
    Some(decode(scope, cid, env, url, &body, &mime, owner, environment))
}

// …a `blob:` URL's: its blob's bytes, as their type makes them a sheet (`judge`), decoded — once per URL, `charset` and
// integrity for its owner, per URL and environment for an `@import`.
#[allow(clippy::too_many_arguments)]
fn blob_sheet_text(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, env: &Env, url: &str, owner: Option<Owner>, environment: Option<&str>) -> Result<Option<String>, Terminated> {
    let key = match owner {
        Some(o) => {
            let charset = realm(scope, cid).get(o.id).and_then(|n| n.plain_attr("charset")).unwrap_or("").to_owned();
            let integrity = request_of(realm(scope, cid), o.id).integrity.clone();
            format!("{url}\0{charset}\0{integrity}")
        }
        None => format!("{url}\0{}\0", environment.unwrap_or("")),
    };
    let known = match owner {
        Some(o) => request_of(realm(scope, cid), o.id).blob_texts.get(&key).cloned(),
        None => realm(scope, cid).realm_state_mut(cid).and_then(|s| s.sheet_fetches.blob_texts.get(&key).cloned()),
    };
    if let Some(text) = known {
        return Ok(text);
    }
    let Some((bytes, content_type)) = crate::subresource_obtain::scheme_response(scope, host, url)? else { return Ok(None) };
    let facts = crate::subresource_obtain::scheme_facts(content_type.clone());
    let verdict = judge_sheet(scope, cid, env, owner, &facts, SRC_SCHEME, &|| bytes.clone());
    let text = if verdict == 0 {
        None
    } else if verdict & V_OK != 0 {
        Some(decode(scope, cid, env, url, &bytes, &content_type, owner, environment))
    } else {
        Some(String::new())
    };
    match owner {
        Some(o) => {
            request_of(realm(scope, cid), o.id).blob_texts.insert(key, text.clone());
        }
        None => {
            if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
                s.sheet_fetches.blob_texts.insert(key, text.clone());
            }
        }
    }
    Ok(text)
}

// …the preload its request takes (Fetch "fetch": "consume a preloaded resource") — its owner's taken once for the sheet
// it obtains, so its every reader has the one response — judged and decoded as the network's is: None where none
// matched.
#[allow(clippy::too_many_arguments)]
fn preloaded_sheet(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, env: &Env, url: &str, owner: Option<Owner>, environment: Option<&str>, referrer: Option<&str>) -> Result<Option<Sheet>, Terminated> {
    let Some(response) = sheet_preload(scope, cid, host, env, url, owner, referrer)? else { return Ok(None) };
    let Some(resp) = response else { return Ok(Some(Sheet::none(url))) };
    let facts = resp.facts();
    let verdict = judge_sheet(scope, cid, env, owner, &facts, SRC_NETWORK, &|| resp.body().to_vec());
    let text = if verdict & V_OK != 0 { decode(scope, cid, env, url, resp.body(), resp.header("content-type").unwrap_or(""), owner, environment) } else { String::new() };
    let location = if resp.url().is_empty() { url.to_owned() } else { resp.url().to_owned() };
    let mut sheet = Sheet::of_verdict(verdict, Some(text), location);
    sheet.policy = resp.header("referrer-policy").map(str::to_owned);
    Ok(Some(sheet))
}
// …the response itself: Some(None) for a network error, None where none matched.
fn sheet_preload(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, env: &Env, url: &str, owner: Option<Owner>, referrer: Option<&str>) -> Result<Option<Option<Rc<crate::preload_map::Response>>>, Terminated> {
    let plan = sheet_plan(scope, cid, owner, referrer);
    let Some(owner) = owner else {
        let Some(doc) = env.doc else { return Ok(None) };
        return Ok(crate::preload_map::consume(scope, cid, (doc, url, "style", plan), "", host)?.map(|r| r.map(Rc::new)));
    };
    owner_preload(scope, cid, host, owner, url, plan)
}
// …an owner's, taken once for the sheet it obtains (by its request, `plan`) — kept where one matched.
pub(crate) fn owner_preload(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, owner: Owner, url: &str, plan: u32) -> Result<Option<Option<Rc<crate::preload_map::Response>>>, Terminated> {
    let key = format!("{} {url}", plan & PLAN_REQUEST);
    let request = request_of(realm(scope, cid), owner.id);
    if let Some((k, resp)) = &request.preload {
        if *k == key {
            return Ok(Some(resp.clone()));
        }
    }
    let integrity = request.integrity.clone();
    let Some(doc) = owner.doc else { return Ok(None) };
    let taken = crate::preload_map::consume(scope, cid, (doc, url, "style", plan), &integrity, host)?.map(|r| r.map(Rc::new));
    if let Some(resp) = &taken {
        request_of(realm(scope, cid), owner.id).preload = Some((key, resp.clone()));
    }
    Ok(taken)
}

// …a controlling service worker's answer — its sheet at the URL of the response it answered with, its text as it
// answered it — None where none controls the document, or none answered.
fn worker_sheet(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, env: &Env, url: &str, owner: Option<Owner>, referrer: Option<&str>) -> Result<Option<Sheet>, Terminated> {
    let plan = sheet_plan(scope, cid, owner, referrer);
    let integrity = owner.map(|o| request_of(realm(scope, cid), o.id).integrity.clone()).unwrap_or_default();
    let Some(answer) = worker_answer(scope, cid, host, url, plan, &integrity, referrer, owner)? else { return Ok(None) };
    let local = v8::Local::new(scope, &answer);
    let obj = v8::Local::<v8::Object>::try_from(local).ok();
    let body = string_member(scope, obj, "body");
    let raw = obj.and_then(|o| member(scope, o, "body_bytes").or_else(|| member(scope, o, "body")));
    let bytes = bytes_of(scope, raw).unwrap_or_default();
    let facts = facts_of(scope, obj, J_SHEET, SRC_SW_SYNC);
    let no_body = if body.is_none() { S_NO_BODY } else { 0 };
    let verdict = judge_sheet(scope, cid, env, owner, &facts, SRC_SW_SYNC | no_body, &|| bytes.clone());
    let location = string_member(scope, obj, "url").filter(|u| !u.is_empty()).unwrap_or_else(|| url.to_owned());
    let mut sheet = Sheet::of_verdict(verdict, body, location);
    sheet.policy = string_member(scope, obj, "referrerPolicy");
    sheet.answer = Some(answer);
    Ok(Some(sheet))
}
// …the answer itself, asked once per request: for the sheet its owner obtains, or (an `@import`'s) per controller,
// integrity and referrer in the realm — none asked of an uncontrolled document (a claim since may make it controlled:
// none kept then).
#[allow(clippy::too_many_arguments)]
pub(crate) fn worker_answer(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, url: &str, plan: u32, integrity: &str, referrer: Option<&str>, owner: Option<Owner>) -> Result<Option<v8::Global<v8::Value>>, Terminated> {
    let ctrl = call(scope, host, H_CONTROLLER, &[])?.and_then(|c| v8::Local::new(scope, c).uint32_value(scope)).unwrap_or(0);
    if ctrl == 0 {
        return Ok(None);
    }
    let key = match owner {
        Some(_) => format!("{} {url}", plan & PLAN_REQUEST),
        None => format!("{ctrl} {} {integrity} {} {url}", plan & PLAN_REQUEST, referrer.unwrap_or("")),
    };
    let known = match owner {
        Some(o) => request_of(realm(scope, cid), o.id).answers.get(&key).cloned(),
        None => realm(scope, cid).realm_state_mut(cid).and_then(|s| s.sheet_fetches.answers.get(&key).cloned()),
    };
    if let Some(answer) = known {
        return Ok(answer);
    }
    let r = match referrer {
        Some(r) => text_value(scope, r),
        None => v8::null(scope).into(),
    };
    let args = [text_value(scope, url), v8::Integer::new_from_unsigned(scope, plan).into(), r, v8::undefined(scope).into(), v8::Boolean::new(scope, false).into(), text_value(scope, integrity)];
    let answer = call(scope, host, H_SW_ANSWER, &args)?;
    match owner {
        Some(o) => {
            request_of(realm(scope, cid), o.id).answers.insert(key, answer.clone());
        }
        None => {
            if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
                s.sheet_fetches.answers.insert(key, answer.clone());
            }
        }
    }
    Ok(answer)
}

// …the network's, through the asset cache (its body, its facts, its bytes where they are not its text's UTF-8),
// judged on the facts of the response it got — a body the host kept no facts for a response all the same — decoded;
// its location the URL its response came from, which the encoding it decoded in is kept by too.
#[allow(clippy::too_many_arguments)]
fn network_sheet(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, env: &Env, url: &str, owner: Option<Owner>, environment: Option<&str>, referrer: Option<&str>) -> Result<Sheet, Terminated> {
    let plan = sheet_plan(scope, cid, owner, referrer);
    let Some(response) = asset(scope, cid, host, url, plan, owner, referrer)? else { return Ok(Sheet::none(url)) };
    let local = v8::Local::new(scope, &response);
    let Ok(array) = v8::Local::<v8::Array>::try_from(local) else { return Ok(Sheet::none(url)) };
    let mut at = [None; 3];
    for (k, slot) in at.iter_mut().enumerate() {
        *slot = array.get_index(scope, k as u32).filter(|v| !v.is_null_or_undefined());
    }
    let [body, meta, bytes] = at;
    let facts_obj = meta.and_then(|m| v8::Local::<v8::Object>::try_from(m).ok());
    let facts = facts_of(scope, facts_obj, J_SHEET, SRC_ASSET);
    let raw = bytes_of(scope, bytes.or(body)).unwrap_or_default();
    let no_body = if body.is_none() { S_NO_BODY } else { 0 };
    let verdict = judge_sheet(scope, cid, env, owner, &facts, SRC_ASSET | no_body, &|| raw.clone());
    let body_text = body.map(|b| b.to_rust_string_lossy(scope));
    let location = string_member(scope, facts_obj, "url").filter(|u| !u.is_empty()).unwrap_or_else(|| url.to_owned());
    let mut sheet = Sheet::of_verdict(verdict, body_text, location.clone());
    if sheet.text.as_ref().is_some_and(|t| !t.is_empty()) {
        let content_type = header(scope, facts_obj, "content-type").unwrap_or_default();
        sheet.text = Some(decode(scope, cid, env, url, &raw, &content_type, owner, environment));
    }
    if location != url {
        if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
            if let Some(&e) = s.sheet_fetches.encodings.get(url) {
                s.sheet_fetches.encodings.insert(location, e);
            }
        }
    }
    sheet.policy = header(scope, facts_obj, "referrer-policy");
    sheet.meta = facts_obj.map(|m| v8::Global::new(scope, v8::Local::<v8::Value>::from(m)));
    Ok(sheet)
}
// …the asset cache's response itself — an owner's fetch made once for the sheet it obtains where it failed (the cache
// keeps none: the readers of one sheet's fetch share its failure) — none where there is no cache.
pub(crate) fn asset(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, url: &str, plan: u32, owner: Option<Owner>, referrer: Option<&str>) -> Result<Option<v8::Global<v8::Value>>, Terminated> {
    let key = format!("{} {url}", plan & PLAN_REQUEST);
    if let Some(o) = owner {
        if let Some((k, failed)) = &request_of(realm(scope, cid), o.id).failed {
            if *k == key {
                return Ok(failed.clone());
            }
        }
    }
    let client = match owner.and_then(|o| realm(scope, cid).get(o.id).map(|n| n.realm)) {
        Some(c) => v8::Integer::new(scope, c).into(),
        None => v8::undefined(scope).into(),
    };
    let r = match referrer {
        Some(r) => text_value(scope, r),
        None => v8::null(scope).into(),
    };
    let args = [text_value(scope, url), v8::Integer::new_from_unsigned(scope, plan).into(), r, client];
    let response = call(scope, host, H_ASSET, &args)?;
    if let Some(o) = owner {
        let failed = response.as_ref().map(|r| v8::Local::new(scope, r)).and_then(|r| v8::Local::<v8::Array>::try_from(r).ok()).is_none_or(|a| a.get_index(scope, 0).is_none_or(|b| b.is_null_or_undefined()));
        if failed {
            request_of(realm(scope, cid), o.id).failed = Some((key, response.clone()));
        }
    }
    Ok(response)
}

// The integrity metadata of the owner `id`'s request of the sheet it obtains now (a `<link>`'s load takes it too).
pub(crate) fn owner_integrity(arena: &mut crate::dom::RealmArena, id: NodeId) -> String {
    request_of(arena, id).integrity.clone()
}

// __dom.sheetIntegrity(owner) -> the integrity metadata of the owner's request of the sheet it obtains now.
fn sheet_integrity_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(owner) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    let integrity = request_of(realm(scope, cid), owner).integrity.clone();
    rv.set(text_value(scope, &integrity));
}

// __dom.sheetEncodingOf(url) -> the encoding the realm's sheet at `url` decoded in, undefined for none.
fn sheet_encoding_of_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let url = args.get(0).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    let Some(e) = realm(scope, cid).realm_state_mut(cid).and_then(|s| s.sheet_fetches.encodings.get(&url).copied()) else { return };
    rv.set(text_value(scope, e));
}

// __dom.sheetsForget(): the realm's own let go of as its page goes (cascade.js `resetCascadeState`) — its owners' go with
// them, a new page's owners new nodes.
fn sheets_forget_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    if let Some(s) = realm(scope, cid).realm_state_mut(cid) {
        s.sheet_fetches = RealmSheets::default();
    }
}
