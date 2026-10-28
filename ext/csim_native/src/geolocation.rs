// The Geolocation API's steps (W3C Geolocation §6.5 "request a position", §6.6 "acquire a position") and the
// Permissions API's states (W3C Permissions §5): a realm's watch ids, and what a request answers from the position the
// driver emulates — `{"coords": {latitude, longitude, accuracy, …}}`, `{"denied": true}` or none (browser.rb
// `set_geolocation`, the WebDriver BiDi "set emulated position data" it stands for, a denial the permission's state), as
// JSON. The bindings call back with what it answers in a task (geolocation.js).

use std::collections::BTreeSet;

use crate::dom::{realm, realm_id, register};

// A position: its coordinates, as GeolocationCoordinates has them, and when it was acquired (an EpochTimeStamp, ms).
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Position {
    accuracy: f64,
    latitude: f64,
    longitude: f64,
    altitude: Option<f64>,
    altitude_accuracy: Option<f64>,
    heading: Option<f64>,
    speed: Option<f64>,
    timestamp: f64,
}

// A realm's: its `[[watchIDs]]` (the ids `watchPosition` handed out and neither `clearWatch` nor a denial has cleared),
// and the id the next takes — from 1, as Chrome's do. (No `[[cachedPosition]]`: only a position acquired from the
// system is cached, and the driver's is emulated — none comes from a system here.)
#[derive(Default)]
pub(crate) struct Geolocation {
    watches: BTreeSet<i32>,
    last_watch: i32,
}

// The emulated source: a position — its coordinates, timed when acquired — the permission denied, or none.
#[derive(Debug, PartialEq)]
enum Source {
    None,
    Denied,
    At([f64; 3], [Option<f64>; 4]),
}
// …read off its JSON: a `latitude` and `longitude` it lacks, none.
fn source(json: &str) -> Source {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else { return Source::None };
    if value.get("denied").and_then(serde_json::Value::as_bool) == Some(true) {
        return Source::Denied;
    }
    let coords = value.get("coords").unwrap_or(&value);
    let number = |k: &str| coords.get(k).and_then(serde_json::Value::as_f64);
    let (Some(latitude), Some(longitude)) = (number("latitude"), number("longitude")) else { return Source::None };
    Source::At([number("accuracy").unwrap_or(10.0), latitude, longitude], [number("altitude"), number("altitudeAccuracy"), number("heading"), number("speed")])
}

// GeolocationPositionError's codes.
const PERMISSION_DENIED: u32 = 1;
const POSITION_UNAVAILABLE: u32 = 2;
const TIMEOUT: u32 = 3;

impl Geolocation {
    // "Request a position" — `watch` its watch's id, 0 for none — at `now` (its acquisition time), with PositionOptions'
    // `timeout` (ms): the permission denied, an error, the watch's id removed from the watch ids; the emulated position,
    // timed now; else — the system acquiring nothing — a TIMEOUT where `timeout` is 0, which has elapsed before any
    // attempt ends (Chrome's, measured), and POSITION_UNAVAILABLE where it is not.
    fn request(&mut self, source: Source, watch: i32, timeout: u32, now: f64) -> Result<Position, u32> {
        match source {
            Source::Denied => {
                self.watches.remove(&watch);
                Err(PERMISSION_DENIED)
            }
            Source::At([accuracy, latitude, longitude], [altitude, altitude_accuracy, heading, speed]) => {
                Ok(Position { accuracy, latitude, longitude, altitude, altitude_accuracy, heading, speed, timestamp: now })
            }
            Source::None if timeout == 0 => Err(TIMEOUT),
            Source::None => Err(POSITION_UNAVAILABLE),
        }
    }
}

// The powerful features a descriptor may name — the names Chrome's PermissionName holds, with the state headless Chrome
// answers for each (measured), `geolocation`'s the emulated source's: "denied" where it denies, "granted" where it has a
// position — each with what its descriptor must say (`Needs`), or the TypeError Chrome rejects one whose feature it
// has not enabled with.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Needs {
    Nothing,
    // (…a PushPermissionDescriptor's `userVisibleOnly`, a FullscreenPermissionDescriptor's `allowWithoutGesture`: true)
    True(&'static str),
    // (…a TopLevelStorageAccessPermissionDescriptor's `requestedOrigin`: a URL of a tuple origin)
    Origin(&'static str),
    // (…a feature not enabled: a TypeError of these words)
    Disabled(&'static str),
}
const PERMISSIONS: &[(&str, &str, Needs)] = &[
    ("accelerometer", "granted", Needs::Nothing),
    ("ambient-light-sensor", "prompt", Needs::Disabled("GenericSensorExtraClasses flag is not enabled.")),
    ("background-fetch", "granted", Needs::Nothing),
    ("background-sync", "granted", Needs::Nothing),
    ("camera", "prompt", Needs::Nothing),
    ("captured-surface-control", "prompt", Needs::Nothing),
    ("clipboard-read", "prompt", Needs::Nothing),
    ("clipboard-write", "granted", Needs::Nothing),
    ("display-capture", "prompt", Needs::Nothing),
    ("fullscreen", "denied", Needs::True("allowWithoutGesture")),
    ("geolocation", "prompt", Needs::Nothing),
    ("gyroscope", "granted", Needs::Nothing),
    ("idle-detection", "prompt", Needs::Nothing),
    ("keyboard-lock", "granted", Needs::Nothing),
    ("local-fonts", "prompt", Needs::Nothing),
    ("local-network", "prompt", Needs::Nothing),
    ("local-network-access", "prompt", Needs::Nothing),
    ("loopback-network", "prompt", Needs::Nothing),
    ("magnetometer", "granted", Needs::Nothing),
    ("microphone", "prompt", Needs::Nothing),
    ("midi", "prompt", Needs::Nothing),
    ("nfc", "prompt", Needs::Disabled("Web NFC is not enabled.")),
    ("notifications", "prompt", Needs::Nothing),
    ("payment-handler", "granted", Needs::Nothing),
    ("periodic-background-sync", "denied", Needs::Nothing),
    ("persistent-storage", "prompt", Needs::Nothing),
    ("pointer-lock", "granted", Needs::Nothing),
    ("push", "prompt", Needs::True("userVisibleOnly")),
    ("screen-wake-lock", "granted", Needs::Nothing),
    ("speaker-selection", "prompt", Needs::Disabled("The Speaker Selection API is not enabled.")),
    ("storage-access", "granted", Needs::Nothing),
    ("system-wake-lock", "prompt", Needs::Disabled("System Wake Lock is not enabled.")),
    ("top-level-storage-access", "prompt", Needs::Origin("requestedOrigin")),
    ("web-app-installation", "prompt", Needs::Disabled("The Web App Install API is not enabled.")),
    ("window-management", "prompt", Needs::Nothing)
];
fn permission(name: &str) -> Option<(&'static str, Needs)> {
    PERMISSIONS.iter().find(|(n, ..)| *n == name).map(|&(_, state, needs)| (state, needs))
}
// The state of a permission whose descriptor says `member` of what it needs, or the error it is rejected with — a
// TypeError's words, or (`push`'s) a NotSupportedError's: `Err((false, words))`, `Err((true, words))`.
fn permission_state(name: &str, member: Option<&str>, source: &Source) -> Result<&'static str, (bool, &'static str)> {
    let Some((state, needs)) = permission(name) else { return Err((false, "")) };
    match needs {
        Needs::Disabled(words) => return Err((false, words)),
        Needs::True("userVisibleOnly") if member != Some("true") => return Err((true, "Push Permission without userVisibleOnly:true isn't supported yet.")),
        Needs::True(_) if member != Some("true") => return Err((false, "Fullscreen Permission only supports allowWithoutGesture:true.")),
        Needs::Origin(_) if member.and_then(|m| ada_url::Url::parse(m, None).ok()).is_none_or(|u| u.origin() == "null") => {
            return Err((false, "The requested origin is invalid."))
        }
        _ => {}
    }
    Ok(match (name, source) {
        ("geolocation", Source::Denied) => "denied",
        ("geolocation", Source::At(..)) => "granted",
        _ => state,
    })
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "geolocationRequest", request_op, context_id);
    register(scope, ns, "geolocationWatch", watch_op, context_id);
    register(scope, ns, "geolocationClearWatch", clear_watch_op, context_id);
    register(scope, ns, "geolocationWatches", watches_op, context_id);
    register(scope, ns, "permissionMember", permission_member_op, context_id);
    register(scope, ns, "permissionState", permission_state_op, context_id);
}

fn state<'s>(scope: &'s mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> Option<&'s mut Geolocation> {
    let cid = realm_id(scope, args);
    realm(scope, cid).realm_state_mut(cid).map(|s| &mut s.geolocation)
}
fn text_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, i: i32) -> Option<String> {
    let v = args.get(i);
    v.is_string().then(|| v.to_rust_string_lossy(scope))
}

// __dom.geolocationRequest(sourceJson, watchId, timeout, now) -> [accuracy, latitude, longitude, altitude,
// altitudeAccuracy, heading, speed, timestamp] of the position a request acquires (`Geolocation::request`) — null for
// each of the nullable coordinates it has none of — or the code of the error it meets.
fn request_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let json = text_arg(scope, &args, 0).unwrap_or_default();
    let watch = args.get(1).int32_value(scope).unwrap_or(0);
    let timeout = args.get(2).uint32_value(scope).unwrap_or(0);
    let now = args.get(3).number_value(scope).unwrap_or(0.0);
    let Some(geolocation) = state(scope, &args) else { return rv.set_uint32(POSITION_UNAVAILABLE) };
    let p = match geolocation.request(source(&json), watch, timeout, now) {
        Ok(p) => p,
        Err(code) => return rv.set_uint32(code),
    };
    let fields = [Some(p.accuracy), Some(p.latitude), Some(p.longitude), p.altitude, p.altitude_accuracy, p.heading, p.speed, Some(p.timestamp)];
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(fields.len());
    for n in fields {
        items.push(match n {
            Some(n) => v8::Number::new(scope, n).into(),
            None => v8::null(scope).into(),
        });
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.geolocationWatch() -> a new watch id, among the realm's watch ids.
fn watch_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(geolocation) = state(scope, &args) else { return };
    geolocation.last_watch = geolocation.last_watch.wrapping_add(1).max(1);
    geolocation.watches.insert(geolocation.last_watch);
    rv.set_int32(geolocation.last_watch);
}

// __dom.geolocationClearWatch(id): the id no longer among the realm's watch ids.
fn clear_watch_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).int32_value(scope).unwrap_or(0);
    if let Some(g) = state(scope, &args) {
        g.watches.remove(&id);
    }
}

// __dom.geolocationWatches([id]) -> the realm's watch ids, in the order they were handed out; with `id`, whether it is
// one.
fn watches_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let one = args.get(0).is_number().then(|| args.get(0).int32_value(scope).unwrap_or(0));
    let ids: Vec<i32> = state(scope, &args).map(|g| g.watches.iter().copied().collect()).unwrap_or_default();
    if let Some(id) = one {
        return rv.set_bool(ids.contains(&id));
    }
    let items: Vec<v8::Local<v8::Value>> = ids.into_iter().map(|id| v8::Integer::new(scope, id).into()).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.permissionMember(name) -> [member, boolean] of the member a descriptor naming `name` must say (`Needs`) and
// whether it is a boolean one (else a USVString), undefined for one that needs none.
fn permission_member_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = text_arg(scope, &args, 0).unwrap_or_default();
    let (member, boolean) = match permission(&name) {
        Some((_, Needs::True(m))) => (m, true),
        Some((_, Needs::Origin(m))) => (m, false),
        _ => return,
    };
    let Some(m) = v8::String::new(scope, member) else { return };
    let items = [m.into(), v8::Boolean::new(scope, boolean).into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.permissionState(name, sourceJson, member) -> the state of the permission `name` names, its descriptor saying
// `member` of what it needs ("true" / "false" for a boolean one) — or [isNotSupported, words] of the error it is
// rejected with (`permission_state`), words '' for a name that is no powerful feature's.
fn permission_state_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = text_arg(scope, &args, 0).unwrap_or_default();
    let json = text_arg(scope, &args, 1).unwrap_or_default();
    let member = text_arg(scope, &args, 2);
    match permission_state(&name, member.as_deref(), &source(&json)) {
        Ok(state) => {
            if let Some(s) = v8::String::new(scope, state) {
                rv.set(s.into());
            }
        }
        Err((not_supported, words)) => {
            let Some(w) = v8::String::new(scope, words) else { return };
            let items = [v8::Boolean::new(scope, not_supported).into(), w.into()];
            rv.set(v8::Array::new_with_elements(scope, &items).into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_source_is_read_off_its_json() {
        assert_eq!(source("null"), Source::None);
        assert_eq!(source(r#"{"denied":true}"#), Source::Denied);
        assert_eq!(source(r#"{"coords":{"latitude":1}}"#), Source::None);
        assert_eq!(source(r#"{"coords":{"latitude":1,"longitude":2,"speed":3}}"#), Source::At([10.0, 1.0, 2.0], [None, None, None, Some(3.0)]));
    }

    #[test]
    fn a_request_answers_by_permission_then_the_emulated_position_then_the_timeout() {
        let mut g = Geolocation::default();
        g.watches.extend([1, 2]);
        let here = || source(r#"{"coords":{"latitude":1,"longitude":2}}"#);
        assert_eq!(g.request(Source::Denied, 1, u32::MAX, 0.0), Err(PERMISSION_DENIED));
        assert_eq!(g.watches, BTreeSet::from([2]));
        assert_eq!(g.request(Source::None, 0, u32::MAX, 0.0), Err(POSITION_UNAVAILABLE));
        assert_eq!(g.request(Source::None, 0, 0, 0.0), Err(TIMEOUT));
        // (…an emulated position answers at once, whatever the timeout, timed when it was acquired)
        assert_eq!(g.request(here(), 0, 0, 150.0).map(|p| (p.latitude, p.timestamp)), Ok((1.0, 150.0)));
    }

    #[test]
    fn a_permission_is_one_of_chrome_s_names_its_descriptor_saying_what_it_needs() {
        assert_eq!(permission_state("foo", None, &Source::None), Err((false, "")));
        assert_eq!(permission_state("bluetooth", None, &Source::None), Err((false, "")));
        assert_eq!(permission_state("nfc", None, &Source::None), Err((false, "Web NFC is not enabled.")));
        assert_eq!(permission_state("push", Some("false"), &Source::None).map_err(|e| e.0), Err(true));
        assert_eq!(permission_state("push", Some("true"), &Source::None), Ok("prompt"));
        assert!(permission_state("fullscreen", None, &Source::None).is_err());
        assert_eq!(permission_state("fullscreen", Some("true"), &Source::None), Ok("denied"));
        assert!(permission_state("top-level-storage-access", Some("data:,x"), &Source::None).is_err());
        assert_eq!(permission_state("top-level-storage-access", Some("https://a.test"), &Source::None), Ok("prompt"));
        assert_eq!(permission_state("keyboard-lock", None, &Source::Denied), Ok("granted"));
        assert_eq!(permission_state("geolocation", None, &Source::Denied), Ok("denied"));
        assert_eq!(permission_state("geolocation", None, &source(r#"{"latitude":1,"longitude":2}"#)), Ok("granted"));
    }
}
