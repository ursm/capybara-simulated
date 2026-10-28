// The Geolocation API's steps (W3C Geolocation §6.2 "request a position") and the Permissions API's states (W3C
// Permissions §5): a realm's watch ids and the position it last acquired, and what a request answers from the position
// the driver emulates — `{"coords": {latitude, longitude, accuracy, …}, "timestamp"?}`, `{"denied": true}` or none
// (browser.rb `set_geolocation`, the CDP `Emulation.setGeolocationOverride` it stands for), as JSON. The bindings call
// back with what it answers in a task (navigator.js).

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

// A realm's: its `watchIDs` (the ids `watchPosition` handed out and `clearWatch` has not cleared), the id the next takes
// — from 1, as Chrome's do — and its `cachedPosition`.
#[derive(Default)]
pub(crate) struct Geolocation {
    watches: BTreeSet<i32>,
    last_watch: i32,
    cached: Option<Position>,
}

// The emulated source: a position, a permission denied, or none.
#[derive(Debug, PartialEq)]
enum Source {
    None,
    Denied,
    At(Position),
}
// …read off its JSON (`now` the timestamp of a position that names none): a `latitude` and `longitude` it lacks, none.
fn source(json: &str, now: f64) -> Source {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else { return Source::None };
    if value.get("denied").and_then(serde_json::Value::as_bool) == Some(true) {
        return Source::Denied;
    }
    let coords = value.get("coords").unwrap_or(&value);
    let number = |k: &str| coords.get(k).and_then(serde_json::Value::as_f64);
    let (Some(latitude), Some(longitude)) = (number("latitude"), number("longitude")) else { return Source::None };
    Source::At(Position {
        accuracy: number("accuracy").unwrap_or(10.0),
        latitude,
        longitude,
        altitude: number("altitude"),
        altitude_accuracy: number("altitudeAccuracy"),
        heading: number("heading"),
        speed: number("speed"),
        timestamp: value.get("timestamp").and_then(serde_json::Value::as_f64).unwrap_or(now),
    })
}

// GeolocationPositionError's codes.
const PERMISSION_DENIED: u32 = 1;
const POSITION_UNAVAILABLE: u32 = 2;
const TIMEOUT: u32 = 3;

impl Geolocation {
    // "Request a position" at `now`, with PositionOptions' `timeout` and `maximumAge` (ms): the permission denied, an
    // error; a cached position no older than `maximumAge` where that is not 0, it; a `timeout` of 0, which expires
    // before anything is acquired, a TIMEOUT; else the source's position, acquired at once — and cached — or
    // POSITION_UNAVAILABLE where it has none.
    fn request(&mut self, source: Source, timeout: u32, maximum_age: u32, now: f64) -> Result<Position, u32> {
        if source == Source::Denied {
            return Err(PERMISSION_DENIED);
        }
        if let Some(cached) = self.cached.filter(|c| maximum_age > 0 && now - c.timestamp <= f64::from(maximum_age)) {
            return Ok(cached);
        }
        if timeout == 0 {
            return Err(TIMEOUT);
        }
        let Source::At(position) = source else { return Err(POSITION_UNAVAILABLE) };
        self.cached = Some(position);
        Ok(position)
    }
}

// The powerful features a descriptor may name (the Permissions Registry's, and the specs' that define one): the states
// of all but `geolocation` "prompt" — no prompt is answered here — and its the emulated source's: "denied" where it
// denies, "granted" where it has a position.
const PERMISSION_NAMES: &[&str] = &[
    "accelerometer",
    "ambient-light-sensor",
    "background-fetch",
    "background-sync",
    "bluetooth",
    "camera",
    "clipboard-read",
    "clipboard-write",
    "display-capture",
    "geolocation",
    "gyroscope",
    "local-fonts",
    "magnetometer",
    "microphone",
    "midi",
    "nfc",
    "notifications",
    "persistent-storage",
    "push",
    "screen-wake-lock",
    "speaker-selection",
    "storage-access",
    "top-level-storage-access",
    "window-management",
    "xr-spatial-tracking"
];
fn permission_state(name: &str, source: &Source) -> Option<&'static str> {
    if !PERMISSION_NAMES.contains(&name) {
        return None;
    }
    Some(match (name, source) {
        ("geolocation", Source::Denied) => "denied",
        ("geolocation", Source::At(_)) => "granted",
        _ => "prompt",
    })
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "geolocationRequest", request_op, context_id);
    register(scope, ns, "geolocationWatch", watch_op, context_id);
    register(scope, ns, "geolocationClearWatch", clear_watch_op, context_id);
    register(scope, ns, "geolocationWatches", watches_op, context_id);
    register(scope, ns, "permissionState", permission_state_op, context_id);
}

fn state<'s>(scope: &'s mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> Option<&'s mut Geolocation> {
    let cid = realm_id(scope, args);
    realm(scope, cid).realm_state_mut(cid).map(|s| &mut s.geolocation)
}
fn text_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, i: i32) -> String {
    let v = args.get(i);
    if v.is_string() { v.to_rust_string_lossy(scope) } else { String::new() }
}

// __dom.geolocationRequest(sourceJson, timeout, maximumAge, now) -> [accuracy, latitude, longitude, altitude,
// altitudeAccuracy, heading, speed, timestamp] of the position a request acquires (`Geolocation::request`) — null for
// each of the nullable coordinates it has none of — or the code of the error it meets.
fn request_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let json = text_arg(scope, &args, 0);
    let [timeout, maximum_age] = [1, 2].map(|i| args.get(i).uint32_value(scope).unwrap_or(0));
    let now = args.get(3).number_value(scope).unwrap_or(0.0);
    let Some(geolocation) = state(scope, &args) else { return rv.set_uint32(POSITION_UNAVAILABLE) };
    let p = match geolocation.request(source(&json, now), timeout, maximum_age, now) {
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

// __dom.geolocationClearWatch(id) -> whether the id was among the realm's watch ids, which it no longer is.
fn clear_watch_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).int32_value(scope).unwrap_or(0);
    rv.set_bool(state(scope, &args).is_some_and(|g| g.watches.remove(&id)));
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

// __dom.permissionState(name, sourceJson) -> the state of the permission `name` names (`permission_state`), undefined
// for a name that is no powerful feature's.
fn permission_state_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = text_arg(scope, &args, 0);
    let json = text_arg(scope, &args, 1);
    let Some(state) = permission_state(&name, &source(&json, 0.0)) else { return };
    if let Some(s) = v8::String::new(scope, state) {
        rv.set(s.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(json: &str) -> Source {
        source(json, 5.0)
    }

    #[test]
    fn the_source_is_read_off_its_json() {
        assert_eq!(at("null"), Source::None);
        assert_eq!(at(r#"{"denied":true}"#), Source::Denied);
        assert_eq!(at(r#"{"coords":{"latitude":1}}"#), Source::None);
        let Source::At(p) = at(r#"{"coords":{"latitude":1,"longitude":2,"speed":3}}"#) else { panic!() };
        assert_eq!((p.latitude, p.longitude, p.accuracy, p.speed, p.heading, p.timestamp), (1.0, 2.0, 10.0, Some(3.0), None, 5.0));
    }

    #[test]
    fn a_request_answers_by_permission_cache_timeout_and_source() {
        let mut g = Geolocation::default();
        let here = r#"{"coords":{"latitude":1,"longitude":2},"timestamp":100}"#;
        assert_eq!(g.request(source(r#"{"denied":true}"#, 0.0), u32::MAX, 0, 0.0), Err(PERMISSION_DENIED));
        assert_eq!(g.request(Source::None, u32::MAX, 0, 0.0), Err(POSITION_UNAVAILABLE));
        assert_eq!(g.request(source(here, 0.0), 0, 0, 0.0), Err(TIMEOUT));
        assert_eq!(g.request(source(here, 0.0), u32::MAX, 0, 150.0).map(|p| p.timestamp), Ok(100.0));
        // (…a cached position young enough answers even a timeout of 0, a source gone since; an old one does not)
        assert_eq!(g.request(Source::None, 0, 60, 150.0).map(|p| p.latitude), Ok(1.0));
        assert_eq!(g.request(Source::None, 0, 10, 150.0), Err(TIMEOUT));
    }

    #[test]
    fn a_permission_is_a_powerful_feature_s_and_geolocation_s_follows_the_source() {
        assert_eq!(permission_state("foo", &Source::None), None);
        assert_eq!(permission_state("notifications", &Source::Denied), Some("prompt"));
        assert_eq!(permission_state("geolocation", &Source::None), Some("prompt"));
        assert_eq!(permission_state("geolocation", &Source::Denied), Some("denied"));
        assert_eq!(permission_state("geolocation", &at(r#"{"latitude":1,"longitude":2}"#)), Some("granted"));
    }
}
