// The fetches the engine makes for a consumer of its own — the images a rendering update owes (rendered.rs) — in the
// order of Fetch "fetch": the request planned (subresource_plan.rs), a preload of it taken first (preload_map.rs: no
// fetch then, and no entry of its own), else a controlling service worker's answer, else the network's, and the Resource
// Timing entry of what answered filed. What reaches past the engine the bindings do, through one host function
// `host(step, …)` (subresource-host.js): the clock, a pending preload's fetch, a service worker's answer, the network's
// and the filing of an entry.

use crate::dom::{realm, realm_id, register, NodeId};
use crate::font_files::Terminated;
use crate::subresource_plan::{plan_in, J_CSS_IMAGE};

// The host's steps (subresource-host.js `H_*`).
const H_NOW: u32 = 0;
const H_RUN_PRELOAD: u32 = 1;
const H_SW_ANSWER: u32 = 2;
const H_NETWORK: u32 = 3;
const H_FILE: u32 = 4;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "fetchCssImages", fetch_css_images_op, context_id);
}

// `host(step, …args)` on the page side: what it answers, none for null or undefined, or where it throws — Terminated
// where the script was.
fn call(scope: &mut v8::PinScope<'_, '_>, host: v8::Local<'_, v8::Function>, step: u32, args: &[v8::Local<'_, v8::Value>]) -> Result<Option<v8::Global<v8::Value>>, Terminated> {
    let mut all = Vec::with_capacity(args.len() + 1);
    all.push(v8::Integer::new_from_unsigned(scope, step).into());
    all.extend_from_slice(args);
    let undefined = v8::undefined(scope).into();
    v8::tc_scope!(let tc, scope);
    let answer = host.call(tc, undefined, &all);
    if tc.has_terminated() {
        return Err(Terminated);
    }
    Ok(answer.filter(|v| !v.is_null_or_undefined()).map(|v| v8::Global::new(tc, v)))
}

fn text<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
}
fn text_or_null<'s>(scope: &mut v8::PinScope<'s, '_>, s: Option<&str>) -> v8::Local<'s, v8::Value> {
    match s {
        Some(s) => text(scope, s),
        None => v8::null(scope).into(),
    }
}

// __dom.fetchCssImages(doc, host): the images the rendering update owes (rendered.rs `take_owed_css_images`) fetched for
// `doc`, each for its `css` (or `body`) Resource Timing entry — none where `doc` is none (a document with no root now,
// the images let go all the same). A browser fetches a `background-image` / `cursor` / `list-style-image` `url()` when a
// rendered element uses it; the driver paints no background yet, so the fetch is for what a page observes of it: its
// service worker's `fetch` event (destination `image`) and its entry.
fn fetch_css_images_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(host) = v8::Local::<v8::Function>::try_from(args.get(1)) else { return };
    let doc = crate::dom::nid_arg(scope, &args, 0);
    let owed = crate::rendered::take_owed_css_images(scope, &args);
    let Some(doc) = doc else { return };
    let cid = realm_id(scope, &args);
    for (initiator, url, referrer) in owed {
        if fetch_css_image(scope, cid, doc, host, initiator, &url, referrer.as_deref()).is_err() {
            return;
        }
    }
}

// …one of them, referred by the sheet that declared it — `referrer` its location, None its document's (CSS Values 4 "fetch
// a style resource": no-cors, credentials `include`, under that sheet's referrer policy where its response set one —
// Referrer Policy §7). Its answer is a controlling service worker's first, whose network error is no image and whose
// fall-through goes to the network; the network's is fetched for its entry alone: nothing paints it, so nothing decodes
// it.
fn fetch_css_image(scope: &mut v8::PinScope<'_, '_>, cid: i32, doc: NodeId, host: v8::Local<'_, v8::Function>, initiator: &str, url: &str, referrer: Option<&str>) -> Result<(), Terminated> {
    let started = call(scope, host, H_NOW, &[])?;
    let plan = plan_in(realm(scope, cid), J_CSS_IMAGE, None, Some(doc), referrer);
    let run = |scope: &mut v8::PinScope<'_, '_>, token: u32| {
        let token = v8::Integer::new_from_unsigned(scope, token).into();
        call(scope, host, H_RUN_PRELOAD, &[token]).map(drop)
    };
    if crate::preload_map::consume(scope, cid, (doc, url, "image", plan), "", run)?.is_some() {
        return Ok(());
    }
    let request = [text(scope, url), v8::Integer::new_from_unsigned(scope, plan).into(), text_or_null(scope, referrer)];
    let (field, answered) = match call(scope, host, H_SW_ANSWER, &request)? {
        Some(answer) => ("answer", Some(answer)),
        None => ("resp", call(scope, host, H_NETWORK, &request)?),
    };
    let desc = v8::Object::new(scope);
    let answered = match answered {
        Some(a) => v8::Local::new(scope, a),
        None => v8::null(scope).into(),
    };
    let started = match started {
        Some(t) => v8::Local::new(scope, t),
        None => v8::undefined(scope).into(),
    };
    let fields = [
        ("name", text(scope, url)),
        ("kind", v8::Integer::new_from_unsigned(scope, J_CSS_IMAGE).into()),
        ("plan", v8::Integer::new_from_unsigned(scope, plan).into()),
        ("initiatorType", text(scope, initiator)),
        ("startTime", started),
        (field, answered),
    ];
    for (k, v) in fields {
        let k = text(scope, k);
        desc.set(scope, k, v);
    }
    call(scope, host, H_FILE, &[desc.into()]).map(drop)
}
