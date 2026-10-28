// What a realm's document planned for its navigable (HTML "plan to navigate"), which the host takes as the task — or the
// user's action — ends: a navigation (a hyperlink followed, its target and opener, the referrer policy its `rel` sets,
// a `blob:` one's bytes taken as it is planned for a new window, whose page may revoke the URL first), a form's
// submission (its request as it was submitted: HTML "submit" builds it before it plans the navigation, so a page that
// changes the form or moves it to another document after `submit()` changes nothing it sends), a download — and, a
// top-level document's own (the page's, a window's `window.open` made in this isolate), a navigation its `location`
// began (its URL, whether it replaces the current entry, the document that began it and the Referer that one sends, a
// `blob:` one's blob), a reload, and a frame's form submission that navigates it. A navigation of a top-level document
// supersedes the navigation, submission, location navigation, reload or frame's submission planned before it: the later
// is taken (Chrome navigates to `/b` for `form.submit(); location.href = '/b'`, to the form's for the other order, and
// reloads for `location.href = '/b'; location.reload()`). A frame's are its container's (frame_navigation.rs).

use crate::dom::{realm, realm_id, register};

pub(crate) struct Navigation {
    url: String,
    target: String,
    opener: bool,
    referrer_policy: String,
    blob: Option<v8::Global<v8::Value>>,
    // Whether the realm's window had transient activation as it was planned: HTML's source snapshot params' "has
    // transient activation", which the navigation's request carries (its user-activation: Fetch's `Sec-Fetch-User`).
    activated: bool,
}

// (…its request the bindings' record of it — action, method, enctype, target, rel, encoding and entries — held as made)
pub(crate) struct Submission(v8::Global<v8::Value>);

// A navigation of the top-level document its `location` began: its URL; whether it replaces the current entry (a
// `location.replace`); the realm whose script began it where that is another's than the document's own (a frame's
// `open(url, '_top')`, a `_top` link), with the Referer that document sends — its URL and policy, taken as the navigation
// began, when it is there to ask (HTML: the source document snapshotted); whether the source document had transient
// activation; and a `blob:` URL's blob, taken as it began (a revoke after it does not take it back).
pub(crate) struct Location {
    url: String,
    replace: bool,
    initiator: Option<(i32, String, String)>,
    activated: bool,
    blob: Option<v8::Global<v8::Value>>,
}

// A form's submission a frame's document made that navigates the top-level document (its target `_top`, or a `_parent`
// that is it): the frame's realm, the request as it was submitted, and the Referer it sends — the frame's document's
// under its policy, `no-referrer` for its `rel=noreferrer` — taken as it was planned. The page's navigation planned last,
// as its own are (Chrome: `location.href = …; frames[0].f.submit()` submits, the other order navigates).
pub(crate) struct FrameSubmission {
    realm: i32,
    request: v8::Global<v8::Value>,
    referrer: (String, String),
}

// A top-level document's location navigation, reload and a frame's submission to it — the page's, or a window's
// `window.open` made in this isolate — as a flush of the page's tasks stashes them (`flushBegin`); and when the later of
// them was planned (`PLANNED`), which orders the windows' as the host takes them.
#[derive(Default)]
struct Own {
    location: Option<Location>,
    reload: Option<bool>,
    submission: Option<FrameSubmission>,
    planned: u64,
}
static PLANNED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn next_planned() -> u64 {
    PLANNED.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
}

#[derive(Default)]
pub(crate) struct NavigationPlan {
    navigation: Option<Navigation>,
    submission: Option<Submission>,
    download: Option<(String, String)>,
    // (…its own: a location navigation, a reload, a frame's submission to it)
    own: Own,
    // What the plan was as the host began running the tasks due before a navigation of the document — kept apart while
    // they run (`flushBegin`) — and what they planned, kept once they ran (`flushEnd`): for the host to put back where
    // the navigation commits no document after all (`flushRestore`).
    saved: Option<Own>,
    flushed: Option<Own>,
}

impl Own {
    // What a flush planned, `flushed`, put back where nothing was planned since — whether any was.
    fn restore(&mut self, flushed: Own) -> bool {
        let mut restored = false;
        if self.location.is_none() && flushed.location.is_some() {
            self.location = flushed.location;
            restored = true;
        }
        if self.reload.is_none() && flushed.reload.is_some() {
            self.reload = flushed.reload;
            restored = true;
        }
        if self.submission.is_none() && flushed.submission.is_some() {
            self.submission = flushed.submission;
            restored = true;
        }
        if restored {
            self.planned = self.planned.max(flushed.planned);
        }
        restored
    }
}

impl NavigationPlan {
    fn supersede(&mut self) {
        self.navigation = None;
        self.submission = None;
        self.own = Own::default();
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "planNavigation", plan_navigation, context_id);
    register(scope, ns, "planSubmission", plan_submission, context_id);
    register(scope, ns, "planDownload", plan_download, context_id);
    register(scope, ns, "supersedePlanned", supersede_planned, context_id);
    register(scope, ns, "navigationPlanned", navigation_planned, context_id);
    register(scope, ns, "takeNavigation", take_navigation, context_id);
    register(scope, ns, "takeSubmission", take_submission, context_id);
    register(scope, ns, "takeDownload", take_download, context_id);
    register(scope, ns, "planLocation", plan_location, context_id);
    register(scope, ns, "planReload", plan_reload, context_id);
    register(scope, ns, "takeLocation", take_location, context_id);
    register(scope, ns, "takeReload", take_reload, context_id);
    register(scope, ns, "takeWindowNavigations", take_window_navigations, context_id);
    register(scope, ns, "submitToTop", submit_to_top, context_id);
    register(scope, ns, "takeFrameSubmission", take_frame_submission, context_id);
    register(scope, ns, "ownPlanned", own_planned, context_id);
    register(scope, ns, "flushBegin", flush_begin, context_id);
    register(scope, ns, "flushEnd", flush_end, context_id);
    register(scope, ns, "flushRestore", flush_restore, context_id);
}

fn plan<'a>(scope: &'a mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> &'a mut NavigationPlan {
    let cid = realm_id(scope, args);
    &mut realm(scope, cid).navigation_plan
}

// __dom.planNavigation(url, target, opener, referrerPolicy, blob): a hyperlink's navigation planned — `blob` a `blob:`
// URL's bytes and type taken as it was followed, or undefined — after `supersedePlanned` where it navigates the top-level
// document.
fn plan_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let text = |scope: &mut v8::PinScope<'_, '_>, i: i32| args.get(i).to_rust_string_lossy(scope);
    let (url, target, referrer_policy) = (text(scope, 0), text(scope, 1), text(scope, 3));
    let opener = args.get(2).is_true();
    let blob = (!args.get(4).is_null_or_undefined()).then(|| v8::Global::new(scope, args.get(4)));
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let activated = arena.transiently_activated(cid);
    arena.navigation_plan.navigation = Some(Navigation { url, target, opener, referrer_policy, blob, activated });
}

// __dom.planSubmission(request): a form's submission planned, its request as the bindings made it as it was submitted
// (form-fields.js `__csimFormSerialize`) — after `supersedePlanned` where it navigates the top-level document — told
// whether the realm's window has transient activation now (its `userActivated`: `Navigation::activated`'s).
fn plan_submission(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(object) = v8::Local::<v8::Object>::try_from(args.get(0)) else { return };
    let cid = realm_id(scope, &args);
    let activated = realm(scope, cid).transiently_activated(cid);
    if let Some(key) = v8::String::new(scope, "userActivated") {
        let value = v8::Boolean::new(scope, activated);
        object.set(scope, key.into(), value.into());
    }
    let request = v8::Global::new(scope, args.get(0));
    plan(scope, &args).submission = Some(Submission(request));
}

// __dom.planDownload(url, filename): a hyperlink's download planned.
fn plan_download(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let url = args.get(0).to_rust_string_lossy(scope);
    let filename = args.get(1).to_rust_string_lossy(scope);
    plan(scope, &args).download = Some((url, filename));
}

// __dom.supersedePlanned(): a navigation of the top-level document planned elsewhere (a traversal making its document
// again, a location's) — the navigation, the submission, the location navigation, the reload and a frame's submission
// planned before it taken by none.
fn supersede_planned(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    plan(scope, &args).supersede();
}

// __dom.navigationPlanned() -> whether a navigation or a submission is planned, which the host is yet to take: one a
// javascript: URL's script planned outranks the document its string result would make (url-parse.js `runJavascriptURL`).
fn navigation_planned(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let plan = plan(scope, &args);
    rv.set_bool(plan.navigation.is_some() || plan.submission.is_some());
}

// __dom.takeNavigation(newWindowOnly) -> [url, target, opener, referrerPolicy, blob, activated] of the navigation planned, which the
// realm plans no more — or, `newWindowOnly`, only where it opens a new window (its target `_blank` or a name: what a
// script's `click()` with no user action behind it opens mid-task) — or null.
fn take_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let new_window_only = args.get(0).is_true();
    let plan = plan(scope, &args);
    let opens_window = |n: &Navigation| {
        matches!(crate::navigables::target_keyword(&n.target), crate::navigables::TARGET_NAME | crate::navigables::TARGET_BLANK)
    };
    if new_window_only && !plan.navigation.as_ref().is_some_and(opens_window) {
        return;
    }
    let Some(n) = plan.navigation.take() else { return };
    let blob = n.blob.map_or_else(|| v8::undefined(scope).into(), |b| v8::Local::new(scope, b));
    let (Some(url), Some(target), Some(policy)) =
        (v8::String::new(scope, &n.url), v8::String::new(scope, &n.target), v8::String::new(scope, &n.referrer_policy))
    else {
        return;
    };
    let opener = v8::Boolean::new(scope, n.opener).into();
    let activated = v8::Boolean::new(scope, n.activated).into();
    rv.set(v8::Array::new_with_elements(scope, &[url.into(), target.into(), opener, policy.into(), blob, activated]).into());
}

// __dom.takeSubmission() -> the request of the submission planned, which the realm plans no more, or null.
fn take_submission(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Some(Submission(request)) = plan(scope, &args).submission.take() else { return };
    rv.set(v8::Local::new(scope, request));
}

// __dom.takeDownload() -> [url, filename] of the download planned, which the realm plans no more, or null.
fn take_download(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Some((url, filename)) = plan(scope, &args).download.take() else { return };
    let (Some(url), Some(filename)) = (v8::String::new(scope, &url), v8::String::new(scope, &filename)) else { return };
    rv.set(v8::Array::new_with_elements(scope, &[url.into(), filename.into()]).into());
}

// __dom.planLocation(url, replace, initiatorRealm, policy, activated, blob): the calling realm's document's own
// navigation planned by its `location` (`Location`), superseding what it planned before — `initiatorRealm` the realm
// whose script began it, undefined for the document's own, whose Referer under `policy` (a link's, '' its document's) is
// taken now (referrer.rs `navigation_referrer`); `blob` a `blob:` URL's bytes and type, or undefined.
fn plan_location(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let url = args.get(0).to_rust_string_lossy(scope);
    let replace = args.get(1).is_true();
    let initiator = args.get(2).int32_value(scope).filter(|_| !args.get(2).is_null_or_undefined());
    let policy = args.get(3).to_rust_string_lossy(scope);
    let activated = args.get(4).is_true();
    let blob = (!args.get(5).is_null_or_undefined()).then(|| v8::Global::new(scope, args.get(5)));
    let cid = realm_id(scope, &args);
    let initiator = initiator.map(|r| {
        let (source, policy) = crate::referrer::navigation_referrer(&mut crate::dom::dom(scope).arena, r, &policy);
        (r, source, policy)
    });
    let plan = &mut realm(scope, cid).navigation_plan;
    plan.supersede();
    plan.own.location = Some(Location { url, replace, initiator, activated, blob });
    plan.own.planned = next_planned();
}
// __dom.planReload(activated): the calling realm's document's reload planned, superseding what it planned before —
// `activated` whether its window had transient activation as it began.
fn plan_reload(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let activated = args.get(0).is_true();
    let plan = plan(scope, &args);
    plan.supersede();
    plan.own.reload = Some(activated);
    plan.own.planned = next_planned();
}
// __dom.takeLocation() -> [url, replace, initiatorRealm, referrerSource, referrerPolicy, activated, blob] of the location
// navigation planned (initiatorRealm and the Referer null for the document's own, blob undefined for none), which it plans
// no more — or null.
fn take_location(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Some(l) = plan(scope, &args).own.location.take() else { return };
    let items = location_items(scope, l);
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
fn location_items<'s>(scope: &mut v8::PinScope<'s, '_>, l: Location) -> Vec<v8::Local<'s, v8::Value>> {
    let (realm, source, policy) = match l.initiator {
        Some((realm, source, policy)) => (
            v8::Integer::new(scope, realm).into(),
            v8::String::new(scope, &source).unwrap().into(),
            v8::String::new(scope, &policy).unwrap().into(),
        ),
        None => (v8::null(scope).into(), v8::null(scope).into(), v8::null(scope).into()),
    };
    vec![
        v8::String::new(scope, &l.url).unwrap().into(),
        v8::Boolean::new(scope, l.replace).into(),
        realm,
        source,
        policy,
        v8::Boolean::new(scope, l.activated).into(),
        l.blob.map_or_else(|| v8::undefined(scope).into(), |b| v8::Local::new(scope, b)),
    ]
}
// __dom.takeWindowNavigations() -> the navigations the windows `window.open` made in this isolate planned of their own,
// in the order they were planned, which they plan no more: `[realm, WINDOW_LOCATION (1), …takeLocation's]` and
// `[realm, WINDOW_RELOAD (2), activated]`. A window closed is stepped no more, and plans none the host takes.
fn take_window_navigations(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let windows = crate::dom::dom(scope).arena.stepped_windows();
    let mut taken = Vec::new();
    for w in windows {
        let own = std::mem::take(&mut realm(scope, w).navigation_plan.own);
        if own.location.is_some() || own.reload.is_some() {
            taken.push((own.planned, w, own));
        }
    }
    taken.sort_by_key(|&(planned, ..)| planned);
    let mut items = Vec::new();
    for (_, w, own) in taken {
        let realm = v8::Integer::new(scope, w).into();
        let item: Vec<v8::Local<v8::Value>> = match (own.location, own.reload) {
            (Some(l), _) => [vec![realm, v8::Integer::new(scope, 1).into()], location_items(scope, l)].concat(),
            (None, Some(activated)) => vec![realm, v8::Integer::new(scope, 2).into(), v8::Boolean::new(scope, activated).into()],
            (None, None) => continue,
        };
        items.push(v8::Array::new_with_elements(scope, &item).into());
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.takeReload() -> whether the document had transient activation as the reload planned began, which it plans no
// more — undefined for none.
fn take_reload(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    if let Some(activated) = plan(scope, &args).own.reload.take() {
        rv.set_bool(activated);
    }
}
// __dom.submitToTop(): the calling frame realm's planned submission handed to the page's plan, as its target is the
// top-level document (`FrameSubmission`) — superseding what that planned before — its Referer the frame's document's,
// `no-referrer` for its `rel=noreferrer` (referrer.rs `navigation_referrer`).
fn submit_to_top(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some(Submission(request)) = realm(scope, cid).navigation_plan.submission.take() else { return };
    let local = v8::Local::new(scope, &request);
    let rel = v8::Local::<v8::Object>::try_from(local)
        .ok()
        .and_then(|o| crate::dom::member(scope, o, "rel"))
        .map_or_else(String::new, |r| r.to_rust_string_lossy(scope));
    let policy = if crate::token_list::link_types(&rel) & crate::token_list::LINK_NOREFERRER != 0 { "no-referrer" } else { "" };
    let referrer = crate::referrer::navigation_referrer(&mut crate::dom::dom(scope).arena, cid, policy);
    let top = &mut realm(scope, 0).navigation_plan;
    top.supersede();
    top.own.submission = Some(FrameSubmission { realm: cid, request, referrer });
}
// __dom.takeFrameSubmission() -> [realm, request, referrerSource, referrerPolicy] of that submission, which it plans no
// more — or null.
fn take_frame_submission(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let Some(s) = plan(scope, &args).own.submission.take() else { return };
    let items = [
        v8::Integer::new(scope, s.realm).into(),
        v8::Local::new(scope, s.request),
        v8::String::new(scope, &s.referrer.0).unwrap().into(),
        v8::String::new(scope, &s.referrer.1).unwrap().into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.ownPlanned() -> which of a location navigation (1), a reload (2) and a frame's submission (4) is planned, 0 for
// none.
fn own_planned(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let own = &plan(scope, &args).own;
    rv.set_uint32(u32::from(own.location.is_some()) | (u32::from(own.reload.is_some()) << 1) | (u32::from(own.submission.is_some()) << 2));
}
// __dom.flushBegin(): the tasks due before a navigation of the page about to run — what it planned kept apart, so they
// plan anew, and what each window `window.open` made in this isolate planned (they run on the page's event loop).
// __dom.flushEnd(): …they ran — what they planned kept as flushed, what was planned before back.
// __dom.flushRestore(drop) -> whether any was: the navigation committed no document — what the flushed tasks planned
// put back where nothing was planned since — or (`drop`) what they planned let go. (One that commits a document drops
// the page's with the rest of its plan: the page load's reset.)
fn traversables(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> Vec<i32> {
    let cid = realm_id(scope, args);
    std::iter::once(cid).chain(crate::dom::dom(scope).arena.stepped_windows()).collect()
}
fn flush_begin(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    for r in traversables(scope, &args) {
        let plan = &mut realm(scope, r).navigation_plan;
        plan.saved = Some(std::mem::take(&mut plan.own));
    }
}
fn flush_end(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    for r in traversables(scope, &args) {
        let plan = &mut realm(scope, r).navigation_plan;
        let saved = plan.saved.take().unwrap_or_default();
        plan.flushed = Some(std::mem::replace(&mut plan.own, saved));
    }
}
fn flush_restore(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let drop = args.get(0).is_true();
    let mut restored = false;
    for r in traversables(scope, &args) {
        let plan = &mut realm(scope, r).navigation_plan;
        let Some(flushed) = plan.flushed.take().filter(|_| !drop) else { continue };
        restored |= plan.own.restore(flushed);
    }
    rv.set_bool(restored);
}
