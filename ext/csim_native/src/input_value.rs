// An `<input>`'s value algorithms (HTML §4.10.5.1): each type's value sanitization, its value as a number and a
// number written back as its value (`valueAsNumber`, `valueAsDate`), and the step `stepUp()` / `stepDown()` take —
// what constraint validation (validity.rs) and the page's `value` accessors read alike.

use crate::dom::NodeData;
use crate::numbers::{to_js_string, to_precision};

pub(crate) const MS_PER_DAY: f64 = 86_400_000.0;
// The largest time value a Date holds.
const MAX_TIME: f64 = 8.64e15;
const MS_PER_WEEK: f64 = 7.0 * MS_PER_DAY;

fn is_ascii_ws(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\x0C' | '\r' | ' ')
}
fn trim_ascii_ws(s: &str) -> &str {
    s.trim_matches(is_ascii_ws)
}

// HTML "valid floating-point number" (and finite), as its number.
pub(crate) fn parse_float(s: &str) -> Option<f64> {
    crate::element_state::is_valid_floating_point(s).then(|| s.parse::<f64>().ok()).flatten()
}

// ── the temporal types ──
// The number a temporal `type` gives `s` — ms since the epoch for a date / datetime-local / week (that week's Monday),
// ms since midnight for a time, months since 1970-01 for a month — or None when `s` is not a valid one.
fn temporal_number(ty: &str, s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let digits = |from: usize, to: usize| -> Option<i64> {
        let part = s.get(from..to)?;
        (!part.is_empty() && part.bytes().all(|c| c.is_ascii_digit())).then(|| part.parse().ok()).flatten()
    };
    // A year: four or more digits, then `-`.
    let year_end = b.iter().position(|&c| c == b'-')?;
    if year_end < 4 {
        return None;
    }
    let year = digits(0, year_end)?;
    // (…a year from 1 to the last a Date holds: 8.64e15 ms past the epoch is 275760-09-13)
    if !(1..=275_760).contains(&year) {
        return None;
    }
    let rest = &s[year_end + 1..];
    let within = |ms: f64| (ms <= MAX_TIME).then_some(ms);
    match ty {
        "month" => {
            let m = (rest.len() == 2).then(|| digits(year_end + 1, s.len())).flatten()?;
            if !(1..=12).contains(&m) {
                return None;
            }
            within(days_from_civil(year, m, 1) as f64 * MS_PER_DAY)?;
            Some(((year - 1970) * 12 + (m - 1)) as f64)
        }
        "week" => {
            let w = (rest.len() == 3 && rest.starts_with('W')).then(|| digits(year_end + 2, s.len())).flatten()?;
            if w < 1 || w > iso_weeks_in_year(year) {
                return None;
            }
            within((week1_monday(year) + (w - 1) * 7) as f64 * MS_PER_DAY)
        }
        "date" => {
            if rest.len() != 5 || rest.as_bytes()[2] != b'-' {
                return None;
            }
            let (m, d) = (digits(year_end + 1, year_end + 3)?, digits(year_end + 4, s.len())?);
            valid_day(year, m, d).then(|| days_from_civil(year, m, d) as f64 * MS_PER_DAY).and_then(within)
        }
        "datetime-local" => {
            if rest.len() < 11 || rest.as_bytes()[2] != b'-' || !matches!(rest.as_bytes()[5], b'T' | b' ') {
                return None;
            }
            let (m, d) = (digits(year_end + 1, year_end + 3)?, digits(year_end + 4, year_end + 6)?);
            let time = time_of_day(&rest[6..])?;
            valid_day(year, m, d).then(|| days_from_civil(year, m, d) as f64 * MS_PER_DAY + time).and_then(within)
        }
        _ => None,
    }
}
// A time of day `HH:MM[:SS[.fff]]` (one to three fraction digits) in ms, or None.
fn time_of_day(s: &str) -> Option<f64> {
    let two = |p: &str| (p.len() == 2 && p.bytes().all(|c| c.is_ascii_digit())).then(|| p.parse::<u32>().ok()).flatten();
    let (hm, sec) = match s.len() {
        5 => (s, None),
        n if n >= 8 && s.as_bytes()[5] == b':' => (&s[..5], Some(&s[6..])),
        _ => return None,
    };
    if hm.as_bytes()[2] != b':' {
        return None;
    }
    let (h, mi) = (two(&hm[..2])?, two(&hm[3..])?);
    let (se, ms) = match sec {
        None => (0, 0),
        Some(sec) => {
            let se = two(sec.get(..2)?)?;
            let ms = match sec.get(2..) {
                Some("") => 0,
                Some(f) if f.starts_with('.') && (2..=4).contains(&f.len()) && f[1..].bytes().all(|c| c.is_ascii_digit()) => {
                    format!("{:0<3}", &f[1..]).parse::<u32>().ok()?
                }
                _ => return None,
            };
            (se, ms)
        }
    };
    (h <= 23 && mi <= 59 && se <= 59).then(|| f64::from(((h * 60 + mi) * 60 + se) * 1000 + ms))
}
fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}
fn valid_day(y: i64, m: i64, d: i64) -> bool {
    let days = [31, if is_leap(y) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    (1..=12).contains(&m) && d >= 1 && d <= days[(m - 1) as usize]
}
fn iso_weeks_in_year(y: i64) -> i64 {
    let jan1 = (days_from_civil(y, 1, 1) + 4).rem_euclid(7); // 0 = Sunday
    if jan1 == 4 || (is_leap(y) && jan1 == 3) { 53 } else { 52 }
}
// The day (since 1970-01-01) of the Monday of ISO week 1 of `y`: the week with the year's first Thursday, 4 January's.
fn week1_monday(y: i64) -> i64 {
    let jan4 = days_from_civil(y, 1, 4);
    jan4 - (jan4 + 3).rem_euclid(7) // 0 = Monday (1970-01-01 was a Thursday)
}
// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's days_from_civil)…
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
// …and back.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

// A type's step scale (its step's unit in its number's) and default step.
pub(crate) fn step_scale(ty: &str) -> Option<(f64, f64)> {
    Some(match ty {
        "number" | "range" => (1.0, 1.0),
        "date" => (MS_PER_DAY, 1.0),
        "datetime-local" | "time" => (1000.0, 60.0),
        "month" => (1.0, 1.0),
        "week" => (MS_PER_WEEK, 1.0),
        _ => return None,
    })
}
// The value `s` as the number `ty` gives it ("convert a string to a number"), None where it is not a valid one.
pub(crate) fn number_of(ty: &str, s: &str) -> Option<f64> {
    match ty {
        "number" | "range" => parse_float(s),
        "time" => time_of_day(s),
        _ => temporal_number(ty, s),
    }
}
// A number written back as `ty`'s value ("convert a number to a string") — the empty string where it is no valid
// one of the type (a date before year 1, or past what a Date holds).
pub(crate) fn value_of(ty: &str, n: f64) -> String {
    if matches!(ty, "number" | "range") {
        return to_js_string(n);
    }
    if !n.is_finite() {
        return String::new();
    }
    let year = |y: i64| if y >= 1 { Some(format!("{y:04}")) } else { None };
    let s = match ty {
        "time" => Some(time_value(n)),
        "month" => {
            let idx = (n + 0.5).floor() as i64;
            year(1970 + idx.div_euclid(12)).map(|y| format!("{y}-{:02}", idx.rem_euclid(12) + 1))
        }
        _ => {
            // (…a Date's time value: whole ms, within ±8.64e15)
            let t = n.trunc();
            if t.abs() > 8.64e15 {
                return String::new();
            }
            let day = (t / MS_PER_DAY).floor();
            let (y, m, d) = civil_from_days(day as i64);
            match ty {
                "date" => year(y).map(|y| format!("{y}-{m:02}-{d:02}")),
                "datetime-local" => year(y).map(|y| format!("{y}-{m:02}-{d:02}T{}", time_value(t - day * MS_PER_DAY))),
                "week" => {
                    // (…the week the day is in, Monday to Sunday, of the ISO year its Thursday is in)
                    let day = day as i64;
                    let monday = day - (day + 3).rem_euclid(7);
                    let (iso_year, _, _) = civil_from_days(monday + 3);
                    let w = (monday - week1_monday(iso_year)) / 7 + 1;
                    year(iso_year).map(|y| format!("{y}-W{w:02}"))
                }
                _ => Some(to_js_string(n)),
            }
        }
    };
    s.unwrap_or_default()
}
// A time of day of `ms` (ms past a midnight) as a time's value: seconds only where there are any, the fraction in as
// few digits as it takes (.5, .04, .111).
fn time_value(ms: f64) -> String {
    // (…to the whole ms a time's value can say: Chrome writes 1.5 ms as `00:00:00.001`)
    let ms = ms.floor().rem_euclid(MS_PER_DAY);
    let (h, rest) = ((ms / 3_600_000.0).floor(), ms % 3_600_000.0);
    let (mi, rest) = ((rest / 60_000.0).floor(), rest % 60_000.0);
    let (s, frac) = ((rest / 1000.0).floor(), rest % 1000.0);
    let mut out = format!("{:02}:{:02}", h as i64, mi as i64);
    if s != 0.0 || frac != 0.0 {
        out.push_str(&format!(":{:02}", s as i64));
    }
    if frac != 0.0 {
        out.push_str(&to_js_string(frac / 1000.0)[1..]);
    }
    out
}
// `valueAsDate`'s time value of `s` — a month's its first day's — None where it has none.
pub(crate) fn date_of(ty: &str, s: &str) -> Option<f64> {
    let n = number_of(ty, s)?;
    if ty != "month" {
        return Some(n);
    }
    let idx = n as i64;
    Some(days_from_civil(1970 + idx.div_euclid(12), idx.rem_euclid(12) + 1, 1) as f64 * MS_PER_DAY)
}
// …and a Date's time value written back as a `month`'s value: its UTC year and month.
pub(crate) fn month_of_date(ms: f64) -> String {
    let t = ms.trunc();
    if !t.is_finite() || t.abs() > 8.64e15 {
        return String::new();
    }
    let (y, m, _) = civil_from_days((t / MS_PER_DAY).floor() as i64);
    if y < 1 { String::new() } else { format!("{y:04}-{m:02}") }
}

// ── sanitization ──
// What an `<input>`'s value sanitization reads of its attributes.
pub(crate) struct Attrs<'a> {
    min: Option<&'a str>,
    max: Option<&'a str>,
    step: Option<&'a str>,
    value: Option<&'a str>,
    multiple: bool,
}
impl<'a> Attrs<'a> {
    pub(crate) fn of(n: &'a NodeData) -> Attrs<'a> {
        Attrs {
            min: n.plain_attr("min"),
            max: n.plain_attr("max"),
            step: n.plain_attr("step"),
            value: n.plain_attr("value"),
            multiple: n.plain_attr("multiple").is_some(),
        }
    }
}

// The value sanitization algorithm of `ty` (§4.10.5.1.x) over `v`: newlines stripped from a line of text, a URL or an
// e-mail address trimmed too and an address's domain made ASCII (IDNA), a number or a date that is no valid one
// emptied, a datetime-local written in its normalized form, a range's value clamped into its range and snapped onto
// its step, a colour (`colour`, the style engine's) as `#rrggbb`. Anything else is left as it is. Over UTF-16 code
// units, as a DOMString is: what is only stripped or trimmed keeps a lone surrogate it holds.
pub(crate) fn sanitize_units(ty: &str, v: &[u16], attrs: &Attrs<'_>, colour: &dyn Fn(&str) -> String) -> Vec<u16> {
    let is_ws = |u: &u16| matches!(*u, 0x09 | 0x0A | 0x0C | 0x0D | 0x20);
    let trim = |u: &[u16]| -> Vec<u16> {
        let start = u.iter().position(|c| !is_ws(c)).unwrap_or(u.len());
        let end = u.iter().rposition(|c| !is_ws(c)).map_or(start, |e| e + 1);
        u[start..end.max(start)].to_vec()
    };
    let strip = |u: &[u16]| -> Vec<u16> { u.iter().copied().filter(|&c| c != 0x0A && c != 0x0D).collect() };
    let text = |u: &[u16]| String::from_utf16(u).ok();
    let units = |s: String| s.encode_utf16().collect::<Vec<u16>>();
    match ty {
        "text" | "search" | "tel" | "password" => strip(v),
        "url" => trim(&strip(v)),
        "email" => {
            let one = |a: &[u16]| {
                let a = trim(a);
                text(&a).map_or(a, |s| units(ascii_email(&s)))
            };
            if attrs.multiple {
                let parts: Vec<Vec<u16>> = v.split(|&c| c == u16::from(b',')).map(one).collect();
                parts.join(&u16::from(b','))
            } else {
                one(&strip(v))
            }
        }
        // (…a lone surrogate is no number, date or colour: these read the value as text)
        _ => {
            let s = text(v);
            let s = s.as_deref();
            match ty {
                "number" => s.filter(|s| parse_float(s).is_some()).map_or_else(Vec::new, |s| units(s.to_string())),
                "range" => units(to_js_string(range_value(s.unwrap_or(""), attrs))),
                "color" => units(colour(&String::from_utf16_lossy(v))),
                "date" | "month" | "week" | "time" => {
                    s.filter(|s| number_of(ty, s).is_some()).map_or_else(Vec::new, |s| units(s.to_string()))
                }
                "datetime-local" => s.and_then(|s| number_of(ty, s)).map_or_else(Vec::new, |n| units(value_of(ty, n))),
                _ => v.to_vec(),
            }
        }
    }
}
// …over a string.
pub(crate) fn sanitize(ty: &str, v: &str, attrs: &Attrs<'_>, colour: &dyn Fn(&str) -> String) -> String {
    String::from_utf16_lossy(&sanitize_units(ty, &v.encode_utf16().collect::<Vec<_>>(), attrs, colour))
}
// An e-mail address with its domain (after the LAST `@`) converted to ASCII — `user@お.com` is `user@xn--t8j.com`, as a
// browser has it; a domain the URL parser refuses left as written.
fn ascii_email(addr: &str) -> String {
    let Some(at) = addr.rfind('@') else { return addr.to_string() };
    let domain = &addr[at + 1..];
    if domain.is_ascii() {
        return addr.to_string();
    }
    match ada_url::Url::parse(format!("http://{domain}/").as_str(), None) {
        Ok(url) if !url.hostname().is_empty() => format!("{}{}", &addr[..=at], url.hostname()),
        _ => addr.to_string(),
    }
}
// A range's value: its number (the middle of the range where it has none), clamped into [min, max] (a reversed range
// is min alone), and — unless its step is `any` — rounded onto its step from min, a tie to the larger, within the
// range.
fn range_value(v: &str, a: &Attrs<'_>) -> f64 {
    let min = a.min.and_then(parse_float).unwrap_or(0.0);
    let max = a.max.and_then(parse_float).unwrap_or(100.0).max(min);
    let n = parse_float(v).unwrap_or(min + (max - min) / 2.0).clamp(min, max);
    if a.step.is_some_and(|s| s.eq_ignore_ascii_case("any")) {
        return n;
    }
    let step = a.step.and_then(parse_float).filter(|&s| s > 0.0).unwrap_or(1.0);
    let mut snapped = min + ((n - min) / step + 0.5).floor() * step;
    if snapped < min {
        snapped += step;
    }
    if snapped > max {
        snapped -= step;
    }
    to_precision(snapped, 15)
}

// ── stepping ──
// What `stepUp(delta)` / `stepDown(-delta)` make of the value `v` (§4.10.5.4): Err where the type has no allowed step
// (no numeric type, or step `any`) — an InvalidStateError; Ok(None) where nothing changes (a reversed range, or a
// step that clamping would turn back); else the new value. From the step base (min, else the value attribute, else
// the type's default), a value on the step grid moves `delta` steps, one off it to the next grid point that way — an
// empty one starting from 0 (or min / max where 0 is outside them) — clamped onto the grid within [min, max].
pub(crate) fn step(ty: &str, v: &str, a: &Attrs<'_>, delta: f64) -> Result<Option<String>, ()> {
    let Some((scale, default_step)) = step_scale(ty) else { return Err(()) };
    if a.step.is_some_and(|s| s.eq_ignore_ascii_case("any")) {
        return Err(());
    }
    let step = a.step.and_then(parse_float).filter(|&s| s > 0.0).unwrap_or(default_step) * scale;
    let min = a.min.and_then(|m| number_of(ty, m));
    let max = a.max.and_then(|m| number_of(ty, m));
    if let (Some(lo), Some(hi)) = (min, max) {
        if lo > hi {
            return Ok(None);
        }
    }
    let base = min
        .or_else(|| a.value.and_then(|v| number_of(ty, v)))
        .unwrap_or_else(|| if ty == "week" { number_of("week", "1970-W01").unwrap_or(0.0) } else { 0.0 });
    const EPS: f64 = 1e-9;
    let cur = number_of(ty, v).unwrap_or_else(|| match (min, max) {
        (Some(lo), _) if lo > 0.0 => lo,
        (_, Some(hi)) if hi < 0.0 => hi,
        _ => 0.0,
    });
    let k = (cur - base) / step;
    let on_grid = (k - (k + 0.5).floor()).abs() < EPS;
    let mut next = if on_grid {
        cur + step * delta
    } else {
        base + if delta > 0.0 { (k - EPS).ceil() } else { (k + EPS).floor() } * step
    };
    if let Some(hi) = max.filter(|&hi| next > hi) {
        next = base + ((hi - base) / step + EPS).floor() * step;
    }
    if let Some(lo) = min.filter(|&lo| next < lo) {
        next = base + ((lo - base) / step - EPS).ceil() * step;
    }
    // (…from on the grid, a step that clamping turned back past where it started is none)
    if on_grid && ((delta < 0.0 && next > cur) || (delta > 0.0 && next < cur)) {
        return Ok(None);
    }
    if matches!(ty, "number" | "range") {
        next = to_precision(next, 15);
    }
    Ok(Some(value_of(ty, next)))
}

// A number field's value as the USER typed it (§4.10.5.1.12, the user agent's own rule): a valid floating-point number
// as typed ("001.50", "1e2" stay so), an editing intermediate that still converts as its number ("1." shows 1), and
// anything else ("1.e") as nothing — the field suffers from bad input then (validity.rs).
pub(crate) fn typed_number(raw: &str) -> String {
    if parse_float(raw).is_some() {
        return raw.to_string();
    }
    crate::validity::parse_number_field(raw).map_or_else(String::new, to_js_string)
}

// ── the ops ──
pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "inputSanitize", input_sanitize, context_id);
    crate::dom::register(scope, ns, "inputTypedNumber", input_typed_number, context_id);
    crate::dom::register(scope, ns, "inputNumber", input_number, context_id);
    crate::dom::register(scope, ns, "inputValue", input_value, context_id);
    crate::dom::register(scope, ns, "inputDate", input_date, context_id);
    crate::dom::register(scope, ns, "inputStep", input_step, context_id);
}

fn set_string(scope: &mut v8::PinScope<'_, '_>, rv: &mut v8::ReturnValue<'_, v8::Value>, s: &str) {
    if let Some(s) = v8::String::new(scope, s) {
        rv.set(s.into());
    }
}
const NO_ATTRS: Attrs<'static> = Attrs { min: None, max: None, step: None, value: None, multiple: false };

// __dom.inputSanitize(nid, type, value) -> the input's value sanitized as `type` (`sanitize`), by its attributes; a
// colour by the style engine, opaque sRGB `#rrggbb`, `#000000` for no colour.
fn input_sanitize(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let id = crate::dom::nid_arg(scope, &args, 0);
    let ty = args.get(1).to_rust_string_lossy(scope);
    let value = crate::dom::utf16_arg(scope, args.get(2));
    let d = crate::dom::dom(scope);
    let arena: &crate::dom::RealmArena = d.realms.entry(cid).or_default();
    let engine = d.styles.get(&cid);
    let colour = |v: &str| {
        let Some(c) = crate::style::parse_color(engine, arena, trim_ascii_ws(v), "") else { return "#000000".to_string() };
        let [r, g, b, _] = *c.to_color_space(style::color::ColorSpace::Srgb).raw_components();
        let hex = |x: f32| ((f64::from(x).clamp(0.0, 1.0) * 255.0 + 0.5).floor()) as u8;
        format!("#{:02x}{:02x}{:02x}", hex(r), hex(g), hex(b))
    };
    let attrs = id.and_then(|id| arena.get(id)).map_or(NO_ATTRS, Attrs::of);
    let out = sanitize_units(&ty, &value, &attrs, &colour);
    let out = crate::dom::utf16_value(scope, &out);
    rv.set(out);
}

// __dom.inputTypedNumber(raw) -> a number field's value as the user typed it (`typed_number`).
fn input_typed_number(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let raw = args.get(0).to_rust_string_lossy(scope);
    set_string(scope, &mut rv, &typed_number(&raw));
}

// __dom.inputNumber(type, value) -> the value as `type`'s number (`number_of`), NaN for none.
fn input_number(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let ty = args.get(0).to_rust_string_lossy(scope);
    let value = args.get(1).to_rust_string_lossy(scope);
    rv.set_double(number_of(&ty, &value).unwrap_or(f64::NAN));
}

// __dom.inputValue(type, n, fromDate) -> `n` written as `type`'s value (`value_of`) — with `fromDate`, a Date's time
// value as a month's (`month_of_date`).
fn input_value(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let ty = args.get(0).to_rust_string_lossy(scope);
    let n = args.get(1).number_value(scope).unwrap_or(f64::NAN);
    let out = if args.get(2).is_true() && ty == "month" { month_of_date(n) } else { value_of(&ty, n) };
    set_string(scope, &mut rv, &out);
}

// __dom.inputDate(type, value) -> `valueAsDate`'s time value of the value (`date_of`), NaN for none.
fn input_date(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let ty = args.get(0).to_rust_string_lossy(scope);
    let value = args.get(1).to_rust_string_lossy(scope);
    rv.set_double(date_of(&ty, &value).unwrap_or(f64::NAN));
}

// __dom.inputStep(nid, type, value, delta) -> the value `stepUp(delta)` makes (`step`): a string, null for no change,
// undefined where the type has no allowed step.
fn input_step(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let id = crate::dom::nid_arg(scope, &args, 0);
    let ty = args.get(1).to_rust_string_lossy(scope);
    let value = args.get(2).to_rust_string_lossy(scope);
    let delta = args.get(3).number_value(scope).unwrap_or(0.0);
    let arena = crate::dom::realm(scope, cid);
    let attrs = id.and_then(|id| arena.get(id)).map_or(NO_ATTRS, Attrs::of);
    let answer = step(&ty, &value, &attrs, delta);
    match answer {
        Ok(Some(next)) => set_string(scope, &mut rv, &next),
        Ok(None) => rv.set_null(),
        Err(()) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attrs<'a>(min: Option<&'a str>, max: Option<&'a str>, step: Option<&'a str>) -> Attrs<'a> {
        Attrs { min, max, step, value: None, multiple: false }
    }

    #[test]
    fn writes_numbers_back_as_values() {
        for (ty, s) in [("date", "2024-02-29"), ("month", "1969-12"), ("week", "2020-W53"), ("time", "13:05:07.5"), ("datetime-local", "2001-01-01T00:00:00.04")] {
            assert_eq!(value_of(ty, number_of(ty, s).unwrap()), s, "{ty}");
        }
        assert_eq!(value_of("time", 43_200_000.0), "12:00");
        assert_eq!(value_of("time", 1.5), "00:00:00.001");
        assert_eq!(value_of("week", days_from_civil(2021, 1, 1) as f64 * MS_PER_DAY), "2020-W53");
        assert_eq!(value_of("week", days_from_civil(2024, 1, 5) as f64 * MS_PER_DAY), "2024-W01");
        assert_eq!(number_of("date", "275760-09-13"), Some(MAX_TIME));
        assert_eq!(number_of("date", "275760-09-14"), None);
        assert_eq!(number_of("month", "922337203685477580-01"), None);
        assert_eq!(number_of("date", "922337203685477580-01-01"), None);
        assert_eq!(value_of("date", -1e17), "");
        assert_eq!(value_of("number", 1e21), "1e+21");
        assert_eq!(month_of_date(number_of("date", "2024-03-15").unwrap()), "2024-03");
    }

    #[test]
    fn sanitizes() {
        let none = attrs(None, None, None);
        let keep = |v: &str| v.to_string();
        assert_eq!(sanitize("text", "a\r\nb", &none, &keep), "ab");
        assert_eq!(sanitize("email", " user@お.com ", &none, &keep), "user@xn--t8j.com");
        assert_eq!(sanitize("datetime-local", "2001-01-01 10:00:00", &none, &keep), "2001-01-01T10:00");
        assert_eq!(sanitize("range", "", &none, &keep), "50");
        assert_eq!(sanitize("range", "0.31", &attrs(Some("0"), Some("1"), Some("0.1")), &keep), "0.3");
        assert_eq!(sanitize("number", "1.", &none, &keep), "");
    }

    #[test]
    fn steps() {
        let a = attrs(Some("0"), Some("10"), Some("3"));
        assert_eq!(step("number", "4", &a, 1.0), Ok(Some("6".into())));
        assert_eq!(step("number", "9", &a, 1.0), Ok(Some("9".into())));
        assert_eq!(step("number", "", &attrs(None, None, Some("0.1")), 3.0), Ok(Some("0.3".into())));
        assert_eq!(step("text", "", &a, 1.0), Err(()));
        assert_eq!(step("date", "2024-01-31", &attrs(None, None, None), 1.0), Ok(Some("2024-02-01".into())));
    }
}
