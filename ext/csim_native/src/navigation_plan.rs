// What a realm's document planned for its navigable (HTML "plan to navigate"), which the host takes as the task — or the
// user's action — ends: a navigation (a hyperlink followed, its target and opener, the referrer policy its `rel` sets,
// a `blob:` one's bytes taken as it is planned for a new window, whose page may revoke the URL first), a form's
// submission (its request as it was submitted: HTML "submit" builds it before it plans the navigation, so a page that
// changes the form or moves it to another document after `submit()` changes nothing it sends), and a download. A navigation of
// the top-level document supersedes the navigation or submission planned before it: the later is taken (Chrome navigates
// to `/b` for `form.submit(); location.href = '/b'`, to the form's for the other order). A frame's are its container's
// (frame_navigation.rs).

use crate::dom::{realm, realm_id, register};

pub(crate) struct Navigation {
    url: String,
    target: String,
    opener: bool,
    referrer_policy: String,
    blob: Option<v8::Global<v8::Value>>,
}

// (…its request the bindings' record of it — action, method, enctype, target, rel, encoding and entries — held as made)
pub(crate) struct Submission(v8::Global<v8::Value>);

#[derive(Default)]
pub(crate) struct NavigationPlan {
    navigation: Option<Navigation>,
    submission: Option<Submission>,
    download: Option<(String, String)>,
}

impl NavigationPlan {
    fn supersede(&mut self) {
        self.navigation = None;
        self.submission = None;
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
}

fn plan<'a>(scope: &'a mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> &'a mut NavigationPlan {
    let cid = realm_id(scope, args);
    &mut realm(scope, cid).navigation_plan
}

// __dom.planNavigation(url, target, opener, referrerPolicy, blob): a hyperlink's navigation planned — `blob` a `blob:`
// URL's bytes and type taken for a new window, or undefined — after `supersedePlanned` where it navigates the top-level
// document.
fn plan_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let text = |scope: &mut v8::PinScope<'_, '_>, i: i32| args.get(i).to_rust_string_lossy(scope);
    let (url, target, referrer_policy) = (text(scope, 0), text(scope, 1), text(scope, 3));
    let opener = args.get(2).is_true();
    let blob = (!args.get(4).is_null_or_undefined()).then(|| v8::Global::new(scope, args.get(4)));
    plan(scope, &args).navigation = Some(Navigation { url, target, opener, referrer_policy, blob });
}

// __dom.planSubmission(request): a form's submission planned, its request as the bindings made it as it was submitted
// (form-fields.js `__csimFormSerialize`) — after `supersedePlanned` where it navigates the top-level document.
fn plan_submission(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if !args.get(0).is_object() {
        return;
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

// __dom.supersedePlanned(): a navigation of the top-level document planned elsewhere (a location's) — the navigation
// and the submission planned before it taken by none.
fn supersede_planned(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    plan(scope, &args).supersede();
}

// __dom.navigationPlanned() -> whether a navigation or a submission is planned, which the host is yet to take: one a
// javascript: URL's script planned outranks the document its string result would make (url-parse.js `runJavascriptURL`).
fn navigation_planned(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let plan = plan(scope, &args);
    rv.set_bool(plan.navigation.is_some() || plan.submission.is_some());
}

// __dom.takeNavigation(newWindowOnly) -> [url, target, opener, referrerPolicy, blob] of the navigation planned, which the
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
    rv.set(v8::Array::new_with_elements(scope, &[url.into(), target.into(), opener, policy.into(), blob]).into());
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
