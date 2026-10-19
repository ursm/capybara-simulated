// What a realm's navigator says of the user agent (HTML §8.9.1.1 NavigatorID, §8.9.1.6 NavigatorOnLine): its user agent
// string — the driver's (`USER_AGENT`), or the one a session configured — the version its `appVersion` takes from it,
// and whether it is online, which the driver flips (its `online` / `offline` events the bindings fire).

use crate::dom::{realm_id, register};

// Leads with `Mozilla/5.0` so server-side bot detectors (the `browser` gem, ahoy_matey's `Browser.new(ua).bot?`) take
// the driver for a regular client, not a crawler. The Ruby side sends it as every request's `HTTP_USER_AGENT`
// (`Browser::USER_AGENT`, `Native.user_agent`).
pub(crate) const USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 capybara-simulated";
// …for the host.
pub(crate) fn user_agent_for_ruby() -> String {
    USER_AGENT.to_owned()
}

// A realm's: the user agent string a session configured, where one did, and whether it is offline.
#[derive(Default)]
pub(crate) struct Navigator {
    user_agent: Option<String>,
    offline: bool,
}

impl Navigator {
    fn user_agent(&self) -> &str {
        self.user_agent.as_deref().unwrap_or(USER_AGENT)
    }
    // …what `appVersion` takes from it: what follows its `Mozilla/`, the whole of one without.
    fn app_version(&self) -> &str {
        let ua = self.user_agent();
        ua.strip_prefix("Mozilla/").unwrap_or(ua)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "userAgent", user_agent_op, context_id);
    register(scope, ns, "setUserAgent", set_user_agent_op, context_id);
    register(scope, ns, "onLine", on_line_op, context_id);
    register(scope, ns, "setOnLine", set_on_line_op, context_id);
}

// The two strings NavigatorID takes from the user agent: the string itself, and `appVersion`'s — what follows its
// `Mozilla/`.
const USER_AGENT_STRING: u32 = 0;
const APP_VERSION: u32 = 1;

// __dom.userAgent(which) -> the realm's user agent string (`USER_AGENT_STRING`), or its `appVersion` (`APP_VERSION`).
fn user_agent_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let which = args.get(0).uint32_value(scope).unwrap_or(USER_AGENT_STRING);
    let navigator = &crate::dom::realm(scope, cid).navigator;
    let text = if which == APP_VERSION { navigator.app_version() } else { navigator.user_agent() }.to_owned();
    if let Some(s) = v8::String::new(scope, &text) {
        rv.set(s.into());
    }
}

// __dom.setUserAgent(ua): the user agent string a session configured, from now on.
fn set_user_agent_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let ua = args.get(0).to_rust_string_lossy(scope);
    crate::dom::realm(scope, cid).navigator.user_agent = Some(ua);
}

// __dom.onLine() -> whether the realm's navigator is online.
fn on_line_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_bool(!crate::dom::realm(scope, cid).navigator.offline);
}

// __dom.setOnLine(online) -> whether that changed it (the bindings fire `online` / `offline` where it did).
fn set_on_line_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let offline = !args.get(0).is_true();
    let state = &mut crate::dom::realm(scope, cid).navigator;
    rv.set_bool(std::mem::replace(&mut state.offline, offline) != offline);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_agent() {
        let mut n = Navigator::default();
        assert_eq!(n.user_agent(), USER_AGENT);
        assert!(n.app_version().starts_with("5.0 (X11;"));
        n.user_agent = Some("Other/2.0".into());
        assert_eq!(n.app_version(), "Other/2.0");
    }
}
