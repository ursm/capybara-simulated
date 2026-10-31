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
    // another top-level traversable's a name found (its navigation not modeled: a new one all the same) — the host
    // opens, named (but for `_blank`) by its target.
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
    traversal: Option<Traversal>,
    planned: u64,
}

// A traversal of a window's session history that makes its document again (session_history.rs `applyWindowTraversal`):
// the step it goes to, and the URL of the entry the window is at there, with the Referer its request sent and a POST's
// body and content type — the request a traversal makes it with again (HTML "apply the history step": the entry's
// document state's resource).
pub(crate) struct Traversal {
    pub(crate) step: i64,
    pub(crate) url: String,
    pub(crate) referrer: Option<String>,
    pub(crate) post: Option<crate::session_history::Post>,
}

// …and one that keeps its document, moving a frame of it: the step it goes to, each navigable whose active entry the step
// moves with the entry and whether that is of the document it is at — what the host applies as it applies the page's
// (browser.rb `traverse_navigables`), the traversals queued after it applied then, from the step it went to. No ongoing
// navigation of the window's own: HTML "apply the history step" sets that of the navigables whose documents it changes
// alone (the host cancels the frames').
pub(crate) struct FrameTraversal {
    pub(crate) step: i64,
    pub(crate) changes: Vec<crate::session_history::Change>,
}

// A reload: whether the document had transient activation as it began, and — one of a document at a `blob:` URL — the
// blob it was made of, taken then (a window's, whose document no session history entry of the host keeps).
pub(crate) struct Reload {
    activated: bool,
    blob: Option<v8::Global<v8::Value>>,
    // …and the mark of the document's tasks queued by the time the task that planned it ended — as the host first came
    // to take it (timers.rs `task_mark`): those its history step unloads the document after (`queued_count`, which the
    // host runs first). The traversal queue runs in parallel with the document's tasks: one of them that navigates begins
    // a navigation before the reload's history step is taken, which that navigation supersedes (`planLocation`) —
    // Chrome 156 and Firefox 159 measured: `setTimeout(() => location.href = x, 0); location.reload()` goes to `x`,
    // reloading nothing, on the page and in a pop-up.
    mark: Option<(u64, f64)>,
}

static PLANNED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub(crate) fn next_planned() -> u64 {
    PLANNED.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
}

#[derive(Default)]
pub(crate) struct NavigationPlan {
    navigation: Option<Navigation>,
    submission: Option<Submission>,
    // (…a download's URL, file name, and the referrer policy its hyperlink's `rel` / `referrerpolicy` set, '' none)
    download: Option<(String, String, String)>,
    // (…its own: a location navigation, a reload, a frame's submission to it)
    own: Own,
    // (…a window's: a traversal of its session history moving a frame of it, which none of those lets go — `FrameTraversal`)
    frame_traversal: Option<FrameTraversal>,
    // What the plan was as the host began running the tasks due before a navigation of the document — kept apart while
    // they run (`flushBegin`) — and what they planned, kept once they ran (`flushEnd`): for the host to put back where
    // the navigation commits no document after all (`flushRestore`).
    saved: Option<Own>,
    flushed: Option<Own>,
    // How many times a navigation planned superseded what was planned before it: what a `javascript:` URL's task, which
    // one planned after it ends, asks (`javascriptOngoing`).
    superseded: u64,
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

// Where a form's submission goes (`route`) — the page's, a frame's: its own navigable, the top-level traversable,
// another frame's — by its container, whatever document it has by the time the host navigates it (none made yet: the
// host makes it one) — a window's of this isolate, by the realm of its document, or a new one — named by its target, ''
// for `_blank` — or none its sandbox lets it navigate.
pub(crate) enum Route {
    SelfTarget,
    Top,
    Frame(crate::dom::NodeId),
    Window(i32),
    NewWindow(Vec<u16>),
    Blocked,
}

// The navigable target `target` chooses from realm `realm`'s document (HTML "the rules for choosing a navigable":
// navigables.rs `choose_navigable`) — the top-level traversable of a frame of a window that window's.
fn route(arena: &crate::dom::RealmArena, realm: i32, target: &[u16]) -> Route {
    use crate::navigables::Choice;
    match arena.choose_navigable(realm, target) {
        Choice::Current => Route::SelfTarget,
        Choice::Frame(container) => Route::Frame(container),
        // (…the page's: its own tree's, or the one a name found from a window's)
        Choice::TopLevel(0) | Choice::Window(0) => Route::Top,
        // (…a window's of this isolate: its own tree's — or a discarded frame's own — or the one a name found from
        // another tree)
        Choice::TopLevel(window) | Choice::Window(window) => Route::Window(window),
        // (…`_blank`'s, named none; a name no navigable of this isolate has — another isolate's window's, whose navigation
        // by a form is the host's to plan, or none — a new one of its name)
        Choice::New if crate::navigables::target_keyword(&String::from_utf16_lossy(target)) == crate::navigables::TARGET_BLANK => {
            Route::NewWindow(Vec::new())
        }
        Choice::New => Route::NewWindow(target.to_vec()),
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
        if self.traversal.is_none() && flushed.traversal.is_some() {
            self.traversal = flushed.traversal;
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
        self.let_go();
        self.superseded += 1;
    }
    // …what was planned let go, by a reload (`planReload`): which is no navigation that ends a `javascript:` URL's —
    // HTML "reload a navigable" sets no ongoing navigation, its "apply the reload history step" queued on the traversal
    // queue instead.
    fn let_go(&mut self) {
        self.navigation = None;
        self.submission = None;
        self.own = Own::default();
    }
    // A traversal of the document's window that makes its document again planned (`Traversal`): the navigation planned
    // before it let go — HTML "apply the history step" sets the ongoing navigation to "traversal".
    // …and whether one is planned: a location navigation or a reload planned after it is ignored, HTML "navigate"
    // returning for a navigable whose ongoing navigation is "traversal".
    pub(crate) fn traversal_planned(&self) -> bool {
        self.own.traversal.is_some()
    }
    pub(crate) fn plan_traversal(&mut self, traversal: Traversal) {
        self.supersede();
        self.own.traversal = Some(traversal);
        self.own.planned = next_planned();
    }
    pub(crate) fn plan_frame_traversal(&mut self, traversal: FrameTraversal) {
        self.frame_traversal = Some(traversal);
    }
    // …and whether a traversal of either kind waits for the host to apply it: those queued after it wait for it, their
    // steps judged from the one it goes to (session_history.rs `applyWindowTraversal`).
    pub(crate) fn traversal_waiting(&self) -> bool {
        self.own.traversal.is_some() || self.frame_traversal.is_some()
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
    register(scope, ns, "planJavascript", plan_javascript, context_id);
    register(scope, ns, "javascriptOngoing", javascript_ongoing, context_id);
    register(scope, ns, "navigationBegun", navigation_begun, context_id);
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
// "follow the hyperlink"): its own navigable or one of its tree's top (superseding what the page planned before where
// that is the page's own), or a new top-level one. None for a frame's — the bindings navigate a frame they reach
// (dom-nodes.js `namedFrameNavigate`), and one they cannot build (past the nesting limit, deferred by an activating
// service worker) is navigated by nothing — nor for one its sandbox keeps it from navigating.
fn plan_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    use crate::navigables::{target_keyword, Choice, TARGET_BLANK};
    let text = |scope: &mut v8::PinScope<'_, '_>, i: i32| args.get(i).to_rust_string_lossy(scope);
    let (url, referrer_policy) = (text(scope, 0), text(scope, 3));
    let target = crate::dom::utf16_arg(scope, args.get(1));
    let opener = args.get(2).is_true();
    let blob = (!args.get(4).is_null_or_undefined()).then(|| v8::Global::new(scope, args.get(4)));
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let opens_window = match arena.choose_navigable(cid, &target) {
        Choice::Current | Choice::TopLevel(_) => false,
        Choice::New => true,
        // (…another top-level traversable's routed before it is planned: navigables.rs `linkRoute`)
        Choice::Frame(_) | Choice::Window(_) | Choice::Blocked => return,
    };
    let target = String::from_utf16_lossy(&target);
    let name = if target_keyword(&target) == TARGET_BLANK { String::new() } else { target };
    let page = arena.is_page(cid);
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

// __dom.planDownload(url, filename, policy): a hyperlink's download planned, under the referrer policy the hyperlink sets
// (url_ops.rs `hyperlinkReferrerPolicy`, '' none).
fn plan_download(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let url = args.get(0).to_rust_string_lossy(scope);
    let filename = args.get(1).to_rust_string_lossy(scope);
    let policy = if args.get(2).is_null_or_undefined() { String::new() } else { args.get(2).to_rust_string_lossy(scope) };
    plan(scope, &args).download = Some((url, filename, policy));
}

// __dom.supersedePlanned(pageOnly): a navigation of the top-level document planned elsewhere (a traversal making its
// document again, a location's, a click's) — the navigation, the submission, the location navigation, the reload and a
// frame's submission planned before it taken by none; with `pageOnly` (a form's submitted), nothing where the calling
// realm is no page's (a frame's are its container's to plan, a window's its own).
fn supersede_planned(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let page_only = args.get(0).is_true();
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    if !page_only || arena.is_page(cid) {
        arena.navigation_plan.supersede();
    }
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

// __dom.takeDownload() -> [url, filename, realm, policy] of the download the calling realm's document planned — `realm`
// its own, whose document the download's initiator is (each realm keeps its own plan) — which it plans no more, or null.
fn take_download(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_null();
    let cid = realm_id(scope, &args);
    let Some((url, filename, policy)) = plan(scope, &args).download.take() else { return };
    let (Some(url), Some(filename), Some(policy)) = (v8::String::new(scope, &url), v8::String::new(scope, &filename), v8::String::new(scope, &policy)) else {
        return;
    };
    let realm = v8::Integer::new(scope, cid);
    rv.set(v8::Array::new_with_elements(scope, &[url.into(), filename.into(), realm.into(), policy.into()]).into());
}

// __dom.planLocation(url, replace, initiatorRealm, policy, activated, blob): the calling realm's document's own
// navigation planned by its `location` (`Location`), superseding what it planned before — `initiatorRealm` the realm
// whose script began it, undefined for the document's own, whose Referer under `policy` (a link's, '' its document's) is
// taken now (referrer.rs `navigation_referrer`); `blob` a `blob:` URL's bytes and type, or undefined. None while a
// traversal is planned (`traversal_planned`).
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
    if plan.traversal_planned() {
        return;
    }
    plan.supersede();
    plan.own.location = Some(Location { url, replace, initiator, activated, blob });
    plan.own.planned = next_planned();
}
// __dom.planJavascript() -> a navigation of the calling realm's navigable — its page's, a window's of this isolate, a
// frame's — to a `javascript:` URL begun, its task to come (url-parse.js `runJavascriptURL`), and the count of
// supersessions it is to be judged by (`javascriptOngoing`); -1, none, while a traversal is planned. It is the navigable's
// ongoing navigation from now on (HTML "navigate", step 20 before step 21's `javascript:` branch: "Set the ongoing
// navigation for navigable to navigationId."), which ends the one before it, whichever document began it: a location
// navigation, a hyperlink's of this navigable, another `javascript:` URL's ("navigate to a javascript: URL" step 2: "If
// targetNavigable's ongoing navigation is no longer navigationId, then return."). Not a form's submission, whose
// navigation HTML "plan to navigate" begins in a task after this one, ending this one instead; nor a hyperlink's that
// opens a new window, whose navigation is that navigable's; nor a reload, which HTML "reload a navigable" queues on the
// traversal queue as "apply the reload history step" and is no ongoing navigation until that step applies (step 8.4,
// "traversal") — the host's, once the tasks queued on the document's event loop by then have run, this one's among them
// (`Reload::mark`). (Chrome and Firefox go on with a location navigation set before it — whatwg/html#2590 — the spec's
// text the ruling here.)
fn plan_javascript(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let plan = plan(scope, &args);
    if plan.traversal_planned() {
        return rv.set_double(-1.0);
    }
    let (submission, reload) = (plan.own.submission.take(), plan.own.reload.take());
    plan.navigation = plan.navigation.take().filter(|n| n.opens_window);
    plan.own = Own { submission, reload, ..Own::default() };
    plan.superseded += 1;
    rv.set_double(plan.superseded as f64);
}
// __dom.navigationBegun() — a navigation of the calling realm's navigable planned elsewhere than in its plan (a frame's,
// whose container's plan holds it: frame_navigation.rs), which ends a `javascript:` URL's begun before it as the ones its
// plan holds do (`supersede`).
fn navigation_begun(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    plan(scope, &args).superseded += 1;
}
// __dom.javascriptOngoing(at) -> whether a `javascript:` URL's navigation begun at supersession count `at` goes on as
// its task runs: no navigation planned since superseded it ("if targetNavigable's ongoing navigation is no longer
// navigationId, then return").
fn javascript_ongoing(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let at = args.get(0).number_value(scope).map_or(0, |n| n as u64);
    rv.set_bool(plan(scope, &args).superseded == at);
}
// __dom.planReload(activated, blob): the calling realm's document's reload planned, superseding what it planned before —
// `activated` whether its window had transient activation as it began, `blob` its document's blob where that is at a
// `blob:` URL, else undefined (`Reload`). None while a traversal is planned. (…which ends a location navigation or a
// hyperlink's before it as its history step is applied — "apply the history step" step 8.4: "Set navigable's ongoing
// navigation to "traversal"" — but no `javascript:` URL's, which a reload never makes the ongoing navigation of: `let_go`)
fn plan_reload(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let activated = args.get(0).is_true();
    let blob = (!args.get(1).is_null_or_undefined()).then(|| v8::Global::new(scope, args.get(1)));
    let plan = plan(scope, &args);
    if plan.traversal_planned() {
        return;
    }
    plan.let_go();
    plan.own.reload = Some(Reload { activated, blob, mark: None });
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
// …a POST's body (a Uint8Array) and content type, or nothing for a GET's.
fn post_items<'s>(scope: &mut v8::PinScope<'s, '_>, post: Option<crate::session_history::Post>) -> Vec<v8::Local<'s, v8::Value>> {
    let Some((body, content_type)) = post else { return Vec::new() };
    vec![crate::dom::u8_array(scope, body.to_vec()), text_or_null(scope, content_type)]
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
// in the order they were planned, which they plan no more: `[realm, "location", …takeLocation's]`, `[realm, "reload",
// activated, blob]` and `[realm, "traverse", step, url, referrer, body, contentType]` (`Traversal`) — after the
// traversals that move a frame of one, whose tasks ran before them: `[realm, "traverse_navigables", step,
// navigable, entry, same document, …]` (`FrameTraversal`). A window closed is stepped no more,
// and plans none the host takes — nor one closing, whose navigation the task its close queued aborts (HTML "destroy a
// top-level traversable"): taken, and let go.
fn take_window_navigations(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let windows = crate::dom::dom(scope).arena.stepped_windows();
    let mut taken = Vec::new();
    let mut waiting = Vec::new();
    let mut frames = Vec::new();
    for w in windows {
        let closing = crate::dom::dom(scope).arena.window_closing(w);
        if let Some(t) = realm(scope, w).navigation_plan.frame_traversal.take().filter(|_| !closing) {
            frames.push((w, t));
        }
        let mut own = std::mem::take(&mut realm(scope, w).navigation_plan.own);
        // (…a location's or a reload's let go where a traversal its window queued makes its document again: its task,
        // which plans that traversal, goes ahead of them — HTML "apply the history step" sets the ongoing navigation to
        // "traversal", as the page's does: browser.rb `apply_planned_traversals_before_navigations` — not one that makes
        // a frame's document again alone)
        let arena = &crate::dom::dom(scope).arena;
        if own.traversal.is_none() && arena.window_history(w).is_some_and(|(h, _)| h.queued_replacing()) {
            own = Own::default();
        }
        // (…a reload's left planned while a task queued on the window's event loop before it is still to run — which the
        // host runs first: `[realm, "queued", count]` in its place — as the page's is: `take_reload`)
        if own.location.is_none() && own.reload.is_some() {
            let arena = realm(scope, w);
            arena.navigation_plan.own = own;
            let queued = reload_queued(arena, w);
            if queued > 0 {
                waiting.push((w, queued));
                continue;
            }
            own = std::mem::take(&mut realm(scope, w).navigation_plan.own);
        }
        if (own.location.is_some() || own.reload.is_some() || own.traversal.is_some()) && !crate::dom::dom(scope).arena.window_closing(w) {
            taken.push((own.planned, w, own));
        }
    }
    taken.sort_by_key(|&(planned, ..)| planned);
    let mut items = Vec::new();
    for (w, t) in frames {
        let mut item = vec![
            v8::Integer::new(scope, w).into(),
            v8::String::new(scope, "traverse_navigables").unwrap().into(),
            v8::Number::new(scope, t.step as f64).into(),
        ];
        for (nav, id, same_document) in t.changes {
            item.push(v8::Integer::new_from_unsigned(scope, nav).into());
            item.push(v8::Number::new(scope, id as f64).into());
            item.push(v8::Boolean::new(scope, same_document).into());
        }
        items.push(v8::Array::new_with_elements(scope, &item).into());
    }
    for (w, queued) in waiting {
        let item = [v8::Integer::new(scope, w).into(), v8::String::new(scope, "queued").unwrap().into(), v8::Integer::new_from_unsigned(scope, queued).into()];
        items.push(v8::Array::new_with_elements(scope, &item).into());
    }
    for (_, w, own) in taken {
        let realm = v8::Integer::new(scope, w).into();
        let item: Vec<v8::Local<v8::Value>> = match (own.location, own.reload, own.traversal) {
            (Some(l), ..) => [vec![realm, v8::String::new(scope, "location").unwrap().into()], location_items(scope, l)].concat(),
            (None, Some(r), _) => vec![
                realm,
                v8::String::new(scope, "reload").unwrap().into(),
                v8::Boolean::new(scope, r.activated).into(),
                r.blob.map_or_else(|| v8::undefined(scope).into(), |b| v8::Local::new(scope, b)),
            ],
            (None, None, Some(t)) => [
                vec![
                    realm,
                    v8::String::new(scope, "traverse").unwrap().into(),
                    v8::Number::new(scope, t.step as f64).into(),
                    v8::String::new(scope, &t.url).unwrap().into(),
                    text_or_null(scope, t.referrer),
                ],
                post_items(scope, t.post),
            ]
            .concat(),
            (None, None, None) => continue,
        };
        items.push(v8::Array::new_with_elements(scope, &item).into());
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// A text for the bindings, null for none.
fn text_or_null<'s>(scope: &mut v8::PinScope<'s, '_>, text: Option<String>) -> v8::Local<'s, v8::Value> {
    match text.and_then(|t| v8::String::new(scope, &t)) {
        Some(s) => s.into(),
        None => v8::null(scope).into(),
    }
}
// __dom.takeReload() -> whether the document had transient activation as the reload planned began, which it plans no
// more — undefined for none.
// How many tasks queued on realm `cid`'s document's event loop the reload its plan holds waits on: those queued by the
// time the host first comes to take it, its mark taken then (`Reload::mark`) — 0 for none, or no reload.
fn reload_queued(arena: &mut crate::dom::RealmArena, cid: i32) -> u32 {
    let now = arena.task_mark(cid);
    let Some(reload) = arena.navigation_plan.own.reload.as_mut() else { return 0 };
    let mark = *reload.mark.get_or_insert(now);
    arena.queued_count(cid, mark)
}
// (…`[count]` instead while tasks queued on its document's event loop before it are still to run: `reload_queued`, which
// the host runs first)
fn take_reload(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let queued = reload_queued(realm(scope, cid), cid);
    if queued > 0 {
        let count = v8::Integer::new_from_unsigned(scope, queued).into();
        return rv.set(v8::Array::new_with_elements(scope, &[count]).into());
    }
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
    let own = matches!(route, Route::SelfTarget) || matches!((&route, container), (Route::Frame(c), Some(own)) if *c == own);
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
// A route as the host takes it: [kind, at, container] — "self", "top", "window" and the realm of a window's of this
// isolate's document, "new_window" and the name it opens under ('' for `_blank`), "blocked", or for another frame's
// "frame" and the realm of
// the document its container's navigable has now, or "unbuilt" and the realm of the container's own document and the
// container, its navigable with none made yet ("none" where the container is gone); else null.
fn route_items<'s>(scope: &mut v8::PinScope<'s, '_>, route: Route) -> [v8::Local<'s, v8::Value>; 3] {
    let arena = &crate::dom::dom(scope).arena;
    let (kind, realm, container) = match route {
        Route::SelfTarget => ("self", None, None),
        Route::Top => ("top", None, None),
        Route::Frame(c) => match (arena.frame_realm(c), arena.get(c).map(|n| n.realm)) {
            (Some(r), _) => ("frame", Some(r), None),
            (None, Some(parent)) => ("unbuilt", Some(parent), Some(c)),
            // (…a container gone with its document: nothing to navigate)
            (None, None) => ("none", None, None),
        },
        Route::Window(window) => ("window", Some(window), None),
        Route::NewWindow(name) => {
            let name = crate::dom::utf16_value(scope, &name);
            return [v8::String::new(scope, "new_window").unwrap().into(), name, v8::null(scope).into()];
        }
        Route::Blocked => ("blocked", None, None),
    };
    let at: v8::Local<v8::Value> = match realm {
        Some(r) => v8::Integer::new(scope, r).into(),
        None => v8::null(scope).into(),
    };
    let container = match (container, realm) {
        (Some(c), Some(parent)) => crate::dom::nodes_value(scope, parent, &[c]),
        _ => v8::null(scope).into(),
    };
    [v8::String::new(scope, kind).unwrap().into(), at, container]
}
// __dom.submissionRoute(realm, target, rel) -> [kind, realm, container, referrerSource, referrerPolicy]: where a form's
// submission of realm `realm`'s document with target `target` and link types `rel` goes (`route`, `route_items`) and
// the Referer it sends — what the host asks of a submission it makes for the user (the page's or an entered frame's
// form submitted).
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
        match (&route, arena.live_container(e.source)) {
            (Route::SelfTarget, Some(c)) | (&Route::Frame(c), _) => crate::frame_navigation::FrameNavigations::begin_submission(arena, c),
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
