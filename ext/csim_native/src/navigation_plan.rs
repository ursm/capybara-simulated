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
    // Whether the navigable its target chose as it was followed is a new top-level one — `_blank`, a name none has, or
    // another top-level traversable's a name found, which a hyperlink does not navigate: one the host opens, named (but
    // for `_blank`) by its target.
    opens_window: bool,
    name: String,
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

// A top-level document's location navigation, reload and a frame's submission to it — of the page, or of a window
// `window.open` made in this isolate (whose frames' submissions to it are not modeled) — as a flush of the page's tasks
// stashes them (`flushBegin`); and when the later of them was planned (`PLANNED`), which orders the windows' as the host
// takes them.
#[derive(Default)]
struct Own {
    location: Option<Location>,
    reload: Option<Reload>,
    submission: Option<FrameSubmission>,
    planned: u64,
}

// A reload: whether the document had transient activation as it began, and — one of a document at a `blob:` URL — the
// blob it was made of, taken then (a window's, whose document no session history entry of the host keeps).
pub(crate) struct Reload {
    activated: bool,
    blob: Option<v8::Global<v8::Value>>,
}

static PLANNED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub(crate) fn next_planned() -> u64 {
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

// A form's submission a frame's document made that the host routes, as the task ends, to the navigable its target
// chooses (`Route`) — its own, another frame (the page's its own plan holds instead: `routeFrameSubmission`) — in the
// order they were made: by the frame's realm, its request held in that realm's plan until the frame's navigable is navigated
// otherwise — its own `location`, a reload, a form of its parent's document — where it is taken out with its route then
// (its document there to ask), one targeting its own navigable let go. A realm's later submission replaces its earlier
// (the realm's plan holds one). (Its target its form's, per HTML "plan to navigate": the realm's is a coarser key.)
#[derive(Default)]
pub(crate) struct RoutedSubmissions {
    entries: Vec<RoutedSubmission>,
    saved: Option<Vec<RoutedSubmission>>,
    flushed: Option<Vec<RoutedSubmission>>,
}
struct RoutedSubmission {
    planned: u64,
    source: i32,
    // …whether its target chose the frame's own navigable, as it was made.
    own: bool,
    taken: Option<(v8::Global<v8::Value>, Route, (String, String))>,
}
impl RoutedSubmissions {
    pub(crate) fn any(&self) -> bool {
        !self.entries.is_empty()
    }
}

// Where a frame's form submission goes (`route`): its own navigable, the top-level traversable, another frame's — by its
// container, whatever document it has by the time the host navigates it (none made yet: the host makes it one) — a
// window's of this isolate or a new one (neither modeled), or none its sandbox lets it navigate.
#[derive(Clone, Copy)]
pub(crate) enum Route {
    SelfTarget,
    Top,
    Frame(crate::dom::NodeId),
    Window,
    NewWindow,
    Blocked,
}

// The navigable target `target` chooses from frame realm `realm`'s document (HTML "the rules for choosing a navigable":
// navigables.rs `choose_navigable`) — the top-level traversable of a frame of a window that window's.
fn route(arena: &crate::dom::RealmArena, realm: i32, target: &[u16]) -> Route {
    use crate::navigables::Choice;
    match arena.choose_navigable(realm, target) {
        Choice::Current => Route::SelfTarget,
        Choice::Frame(container) => Route::Frame(container),
        Choice::TopLevel(0) => Route::Top,
        // (…a window's of this isolate, its own tree's — or a discarded frame's own)
        Choice::TopLevel(_) => Route::Window,
        // (…another top-level traversable a name found, which a form's submission does not navigate: a new one)
        Choice::Window(_) | Choice::New => Route::NewWindow,
        Choice::Blocked => Route::Blocked,
    }
}
// …a form's of realm `realm`'s document with target `target` and link types `rel`, and the Referer it sends: that
// document's, `no-referrer` for its `rel=noreferrer`.
fn target_route(arena: &mut crate::dom::RealmArena, realm: i32, target: &[u16], rel: &str) -> (Route, (String, String)) {
    let policy = if crate::token_list::link_types(rel) & crate::token_list::LINK_NOREFERRER != 0 { "no-referrer" } else { "" };
    let referrer = crate::referrer::navigation_referrer(arena, realm, policy);
    (route(arena, realm, target), referrer)
}
// …its request's (the bindings' record of it: its `target`, its `rel`).
fn request_route(scope: &mut v8::PinScope<'_, '_>, realm: i32, request: &v8::Global<v8::Value>) -> (Route, (String, String)) {
    let local = v8::Local::new(scope, request);
    let request = v8::Local::<v8::Object>::try_from(local).ok();
    let target = request.and_then(|o| crate::dom::member(scope, o, "target")).map_or_else(Vec::new, |v| crate::dom::utf16_arg(scope, v));
    let rel = request.and_then(|o| crate::dom::member(scope, o, "rel")).map_or_else(String::new, |v| v.to_rust_string_lossy(scope));
    target_route(&mut crate::dom::dom(scope).arena, realm, &target, &rel)
}
// Frame realm `realm`'s navigable navigated otherwise (its own `location`, a reload, a form of its parent's document, a
// traversal): the submission it made that the host routes taken out of its plan with its route — let go where it targets
// that navigable itself, which the later navigation replaces.
pub(crate) fn supersede_routed(scope: &mut v8::PinScope<'_, '_>, realm: i32) {
    let pending = crate::dom::dom(scope).arena.routed_submissions.entries.iter().any(|e| e.source == realm && e.taken.is_none());
    if !pending {
        return;
    }
    let request = crate::dom::dom(scope).arena.enter_known(realm).and_then(|a| a.navigation_plan.submission.take());
    let taken = request.map(|Submission(request)| {
        let (route, referrer) = request_route(scope, realm, &request);
        (request, route, referrer)
    });
    let entries = &mut crate::dom::dom(scope).arena.routed_submissions.entries;
    match taken {
        Some((_, Route::SelfTarget, _)) | None => entries.retain(|e| !(e.source == realm && e.taken.is_none())),
        Some(taken) => {
            if let Some(e) = entries.iter_mut().find(|e| e.source == realm && e.taken.is_none()) {
                e.taken = Some(taken);
            }
        }
    }
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
    register(scope, ns, "routeFrameSubmission", route_frame_submission, context_id);
    register(scope, ns, "takeRoutedSubmission", take_routed_submission, context_id);
    register(scope, ns, "holdRoutedSubmission", hold_routed_submission, context_id);
    register(scope, ns, "submissionRoute", submission_route, context_id);
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
// URL's bytes and type taken as it was followed, or undefined — the navigable its target chooses chosen now (HTML
// "follow the hyperlink"), superseding what the page planned before where that is the page's own.
fn plan_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    use crate::navigables::{target_keyword, Choice, TARGET_BLANK};
    let text = |scope: &mut v8::PinScope<'_, '_>, i: i32| args.get(i).to_rust_string_lossy(scope);
    let (url, referrer_policy) = (text(scope, 0), text(scope, 3));
    let target = crate::dom::utf16_arg(scope, args.get(1));
    let opener = args.get(2).is_true();
    let blob = (!args.get(4).is_null_or_undefined()).then(|| v8::Global::new(scope, args.get(4)));
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let opens_window = matches!(arena.choose_navigable(cid, &target), Choice::New | Choice::Window(_));
    let target = String::from_utf16_lossy(&target);
    let name = if target_keyword(&target) == TARGET_BLANK { String::new() } else { target };
    let page = arena.top_level_realm(cid) == cid && !arena.realm_state(cid).is_some_and(|s| s.identity.is_window());
    let activated = arena.transiently_activated(cid);
    let plan = &mut arena.navigation_plan;
    if page && !opens_window {
        plan.supersede();
    }
    plan.navigation = Some(Navigation { url, opens_window, name, opener, referrer_policy, blob, activated });
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

// __dom.navigationPlanned() -> whether a navigation or a submission of its navigable is planned, which the host is yet
// to take (a frame's submission routed to another navigable none): one a
// javascript: URL's script planned outranks the document its string result would make (url-parse.js `runJavascriptURL`).
fn navigation_planned(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    // (…a frame's submission the host routes to another navigable none of its own)
    let elsewhere = crate::dom::dom(scope).arena.routed_submissions.entries.iter().any(|e| e.source == cid && !e.own);
    let plan = plan(scope, &args);
    rv.set_bool(plan.navigation.is_some() || (plan.submission.is_some() && !elsewhere));
}

// __dom.takeNavigation(newWindowOnly) -> [url, opensWindow, name, opener, referrerPolicy, blob, activated] of the
// navigation planned, which the realm plans no more — or, `newWindowOnly`, only where it opens a new window (what a
// script's `click()` with no user action behind it opens mid-task) — or null.
fn take_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let new_window_only = args.get(0).is_true();
    let plan = plan(scope, &args);
    if new_window_only && !plan.navigation.as_ref().is_some_and(|n| n.opens_window) {
        return;
    }
    let Some(n) = plan.navigation.take() else { return };
    let blob = n.blob.map_or_else(|| v8::undefined(scope).into(), |b| v8::Local::new(scope, b));
    let (Some(url), Some(name), Some(policy)) = (v8::String::new(scope, &n.url), v8::String::new(scope, &n.name), v8::String::new(scope, &n.referrer_policy))
    else {
        return;
    };
    let opens_window = v8::Boolean::new(scope, n.opens_window).into();
    let opener = v8::Boolean::new(scope, n.opener).into();
    let activated = v8::Boolean::new(scope, n.activated).into();
    rv.set(v8::Array::new_with_elements(scope, &[url.into(), opens_window, name.into(), opener, policy.into(), blob, activated]).into());
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
// __dom.planReload(activated, blob): the calling realm's document's reload planned, superseding what it planned before —
// `activated` whether its window had transient activation as it began, `blob` its document's blob where that is at a
// `blob:` URL, else undefined (`Reload`).
fn plan_reload(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let activated = args.get(0).is_true();
    let blob = (!args.get(1).is_null_or_undefined()).then(|| v8::Global::new(scope, args.get(1)));
    let plan = plan(scope, &args);
    plan.supersede();
    plan.own.reload = Some(Reload { activated, blob });
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
// in the order they were planned, which they plan no more: `[realm, "location", …takeLocation's]` and `[realm,
// "reload", activated, blob]`. A window closed is stepped no more, and plans none the host takes.
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
            (Some(l), _) => [vec![realm, v8::String::new(scope, "location").unwrap().into()], location_items(scope, l)].concat(),
            (None, Some(r)) => vec![
                realm,
                v8::String::new(scope, "reload").unwrap().into(),
                v8::Boolean::new(scope, r.activated).into(),
                r.blob.map_or_else(|| v8::undefined(scope).into(), |b| v8::Local::new(scope, b)),
            ],
            (None, None) => continue,
        };
        items.push(v8::Array::new_with_elements(scope, &item).into());
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.takeReload() -> whether the document had transient activation as the reload planned began, which it plans no
// more — undefined for none.
fn take_reload(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    if let Some(reload) = plan(scope, &args).own.reload.take() {
        rv.set_bool(reload.activated);
    }
}
// __dom.routeFrameSubmission(): the submission the calling frame realm's document just planned routed by the host —
// replacing the one it planned before and, where it targets its own navigable, the host's navigation of it
// (frame_navigation.rs `HostNavigation`) and a form's of its parent's document — or, one whose target is
// the top-level document (`_top`, a `_parent` that is it), handed to the page's plan (`FrameSubmission`), superseding
// what that planned before, its Referer the frame's document's taken now.
fn route_frame_submission(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let arena = &mut crate::dom::dom(scope).arena;
    arena.routed_submissions.entries.retain(|e| e.source != cid);
    let container = arena.live_container(cid);
    let Some(request) = arena.enter_known(cid).and_then(|a| a.navigation_plan.submission.as_ref().map(|Submission(r)| v8::Global::clone(r))) else {
        return;
    };
    let (route, referrer) = request_route(scope, cid, &request);
    let arena = &mut crate::dom::dom(scope).arena;
    // (…one targeting its own navigable replacing what that planned: the host's navigation of it, a parent's form)
    let own = matches!(route, Route::SelfTarget) || matches!((route, container), (Route::Frame(c), Some(own)) if c == own);
    if let (true, Some(c)) = (own, container) {
        arena.frame_navigations.cancel_form(c);
        if let Some(host) = arena.frame_navigations.host_mut(c) {
            *host = None;
        }
    }
    if matches!(route, Route::Top) {
        realm(scope, cid).navigation_plan.submission = None;
        let top = &mut realm(scope, 0).navigation_plan;
        top.supersede();
        top.own.submission = Some(FrameSubmission { realm: cid, request, referrer });
        return;
    }
    arena.routed_submissions.entries.push(RoutedSubmission { planned: next_planned(), source: cid, own, taken: None });
}
// __dom.holdRoutedSubmission(): the calling frame realm's document about to make way for another in place (a
// javascript: URL's string result) — the submission it made that the host routes taken out of its plan with its route
// (`supersede_routed`), as the frame's navigable navigated otherwise takes it.
fn hold_routed_submission(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    supersede_routed(scope, cid);
}
// A route as the host takes it: [kind, realm, container] — "self", "top", "window" (a window's of this isolate),
// "new_window", "blocked", or for another frame's "frame" and the realm of the document its container's navigable has
// now, or "unbuilt" and the realm of the container's own document and the container, its navigable with none made yet;
// else null.
fn route_items<'s>(scope: &mut v8::PinScope<'s, '_>, route: Route) -> [v8::Local<'s, v8::Value>; 3] {
    let arena = &crate::dom::dom(scope).arena;
    let (kind, at, container) = match route {
        Route::SelfTarget => ("self", None, None),
        Route::Top => ("top", None, None),
        Route::Frame(c) => match (arena.frame_realm(c), arena.get(c).map(|n| n.realm)) {
            (Some(r), _) => ("frame", Some(r), None),
            (None, Some(parent)) => ("unbuilt", Some(parent), Some(c)),
            (None, None) => ("new_window", None, None),
        },
        Route::Window => ("window", None, None),
        Route::NewWindow => ("new_window", None, None),
        Route::Blocked => ("blocked", None, None),
    };
    let at: v8::Local<v8::Value> = match at {
        Some(r) => v8::Integer::new(scope, r).into(),
        None => v8::null(scope).into(),
    };
    let container = match (container, at.int32_value(scope)) {
        (Some(c), Some(parent)) => crate::dom::nodes_value(scope, parent, &[c]),
        _ => v8::null(scope).into(),
    };
    [v8::String::new(scope, kind).unwrap().into(), at, container]
}
// __dom.submissionRoute(realm, target, rel) -> [kind, realm, container, referrerSource, referrerPolicy]: where a form's
// submission of realm `realm`'s document with target `target` and link types `rel` goes (`route`, `route_items`) and
// the Referer it sends — what the host asks of a submission it makes for the user (an entered frame's form submitted).
fn submission_route(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = args.get(0).int32_value(scope).unwrap_or(0);
    let target = crate::dom::utf16_arg(scope, args.get(1));
    let rel = args.get(2).to_rust_string_lossy(scope);
    let arena = &mut crate::dom::dom(scope).arena;
    let (route, referrer) = target_route(arena, realm, &target, &rel);
    let [kind, at, container] = route_items(scope, route);
    let items = [kind, at, container, v8::String::new(scope, &referrer.0).unwrap().into(), v8::String::new(scope, &referrer.1).unwrap().into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.takeRoutedSubmission() -> the first of the submissions frames' documents made that the host routes, in the order
// they were made, which none plans any more: `[realm, request, kind, realm, container, referrerSource,
// referrerPolicy]` (`route_items`). None whose frame is gone (no container: its navigable discarded with its document,
// HTML "plan to navigate" queueing on a document no longer fully active), nor whose request no realm holds any more (a
// click that took it); null where none is left. One at a time: the one before may have given the frame chosen a new
// document.
fn take_routed_submission(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    loop {
        let arena = &mut crate::dom::dom(scope).arena;
        let entries = &mut arena.routed_submissions.entries;
        let Some(first) = entries.iter().enumerate().min_by_key(|(_, e)| e.planned).map(|(i, _)| i) else { return };
        let e = entries.remove(first);
        let taken = match e.taken {
            Some(taken) => Some(taken),
            None if arena.live_container(e.source).is_none() => None,
            None => arena.enter_known(e.source).and_then(|a| a.navigation_plan.submission.take()).map(|Submission(request)| {
                let (route, referrer) = request_route(scope, e.source, &request);
                (request, route, referrer)
            }),
        };
        let Some((request, route, referrer)) = taken else { continue };
        // (…its navigation begun now, as the task that planned it ended — HTML "plan to navigate" queues it — sandboxed as
        // the chosen frame's container says then: frame_navigation.rs `begin_submission`)
        let arena = &mut crate::dom::dom(scope).arena;
        match (route, arena.live_container(e.source)) {
            (Route::SelfTarget, Some(c)) | (Route::Frame(c), _) => crate::frame_navigation::FrameNavigations::begin_submission(arena, c),
            _ => {}
        }
        let [kind, at, container] = route_items(scope, route);
        let item = [
            v8::Integer::new(scope, e.source).into(),
            v8::Local::new(scope, request),
            kind,
            at,
            container,
            v8::String::new(scope, &referrer.0).unwrap().into(),
            v8::String::new(scope, &referrer.1).unwrap().into(),
        ];
        return rv.set(v8::Array::new_with_elements(scope, &item).into());
    }
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
// none — and whether the host plans a navigation of a frame (8: frame_navigation.rs `HostNavigation`) or routes a
// frame's submission (16: `RoutedSubmissions`).
fn own_planned(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let arena = &crate::dom::dom(scope).arena;
    let frames = (u32::from(arena.frame_navigations.hosted()) << 3) | (u32::from(arena.routed_submissions.any()) << 4);
    let own = &plan(scope, &args).own;
    let bits = u32::from(own.location.is_some()) | (u32::from(own.reload.is_some()) << 1) | (u32::from(own.submission.is_some()) << 2);
    rv.set_uint32(bits | frames);
}
// __dom.flushBegin(): the tasks due before a navigation of the page about to run — what it planned kept apart, so they
// plan anew, and what each window `window.open` made in this isolate planned, and the host of its frames (they run on
// the page's event loop).
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
    let arena = &mut crate::dom::dom(scope).arena;
    arena.frame_navigations.flush_begin();
    arena.routed_submissions.saved = Some(std::mem::take(&mut arena.routed_submissions.entries));
}
fn flush_end(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    for r in traversables(scope, &args) {
        let plan = &mut realm(scope, r).navigation_plan;
        let saved = plan.saved.take().unwrap_or_default();
        plan.flushed = Some(std::mem::replace(&mut plan.own, saved));
    }
    let arena = &mut crate::dom::dom(scope).arena;
    arena.frame_navigations.flush_end();
    let routed = &mut arena.routed_submissions;
    routed.flushed = Some(std::mem::replace(&mut routed.entries, routed.saved.take().unwrap_or_default()));
}
fn flush_restore(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let drop = args.get(0).is_true();
    let mut restored = false;
    for r in traversables(scope, &args) {
        let plan = &mut realm(scope, r).navigation_plan;
        let Some(flushed) = plan.flushed.take().filter(|_| !drop) else { continue };
        restored |= plan.own.restore(flushed);
    }
    let arena = &mut crate::dom::dom(scope).arena;
    restored |= arena.frame_navigations.flush_restore(drop);
    // (…a frame's routed submission put back where its realm routes none since)
    if let Some(flushed) = arena.routed_submissions.flushed.take().filter(|_| !drop) {
        let routed = &mut arena.routed_submissions;
        for e in flushed {
            if !routed.entries.iter().any(|c| c.source == e.source) {
                routed.entries.push(e);
                restored = true;
            }
        }
    }
    rv.set_bool(restored);
}
