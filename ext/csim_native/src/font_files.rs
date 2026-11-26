// The font files a realm's faces are read from, as its sources came to them: a downloaded face's URL fetched once, a
// `local()` name looked up once per weight / style — each the file it gave, or none (a 404, a broken file, no such
// font on this machine), so a relayout neither fetches nor asks fontconfig again. A download is made in parallel (CSS
// Font Loading "load()"): under way, the faces reading from it have no file yet — text is laid out with the fallback —
// until it lands as a task (`fontFetchLand`, font_resolve.rs), which the document's load waits for. The realm's for as
// long as its context lives; which face a family takes is font_resolve.rs's.

use std::collections::HashMap;

use crate::dom::realm;
use crate::font_faces::FaceSource;
use crate::subresource_obtain::{FontFetch, FontFlight};

// A source, by its kind (`URL`, `LOCAL`) and its key: the URL, or the name and the weight / style it was asked under.
#[derive(Default)]
pub(crate) struct FontFiles {
    files: HashMap<(u32, String), Option<String>>,
    // The downloads under way, by URL: each its flight, when it began on the clock, and the FontFaces whose `load()` waits
    // for it — `[face, state]`, script's faces (`ffFile`).
    flights: HashMap<String, Flight>,
    // …and how long each that came in took, past its beginning, in ms — none for a file there at once: what a face's
    // `font-display` periods are held against (`FaceRecord::usable_for`), with the time of the sources it tried before.
    took: HashMap<String, f64>,
    // …and those its document's abort cancelled: a face reading from one failed, none of its other sources tried.
    cancelled: std::collections::HashSet<String>,
    // The generation of what the realm's faces are read from, which moves as a download lands: what the faces a family
    // resolves to are keyed on beside the rules and the FontFaceSet (font-metrics.js `natFontGen`).
    pub(crate) generation: u32,
}
struct Flight {
    fetch: FontFlight,
    began: f64,
    waiters: Vec<(v8::Global<v8::Object>, v8::Global<v8::Object>)>,
}

// A source's kind, by number: what its file is kept under, beside its key.
const URL: u32 = 0;
const LOCAL: u32 = 1;

// The script was terminated while the page side was asked: nothing it answered is kept.
pub(crate) struct Terminated;

// What a face's sources came to: its download under way, or settled — the file it is read from (none where it gives
// none, or where it came in past its `font-display` periods), and whether it loaded (its FontFace's status: a face whose
// file came too late is `loaded` all the same, Chrome's `g_fallback_3500`).
#[derive(Clone, PartialEq)]
pub(crate) enum FaceFile {
    Pending,
    Settled { file: Option<String>, loaded: bool },
}
impl FaceFile {
    pub(crate) fn file(&self) -> Option<String> {
        match self {
            FaceFile::Settled { file, .. } => file.clone(),
            FaceFile::Pending => None,
        }
    }
}

// …and one source's: a file, or none, each with how long its download took (0 for one there at once); its download under
// way; or cancelled by its document's abort.
enum Got {
    File(String, f64),
    None(f64),
    Pending,
    Cancelled,
}

// The file a source gives that native reads (`font::register_path`, which keeps what it parsed), or none — a download
// (subresource_obtain.rs `font_fetch_begin`), requested with the face's `referrer` where it has one (a rule's:
// `FaceRecord::referrer`), or the font installed under a `local()` name at the weight / style `bucket`, which the page
// side's `host` names (subresource-host.js) — once per source per realm, which a relayout asks again of no one. A
// download begun here lands as a task the host queues (`H_FONT_LAND`) as many ms later as its server took.
fn source_file(scope: &mut v8::PinScope<'_, '_>, cid: i32, source: &FaceSource, bucket: &str, referrer: Option<&str>, host: v8::Local<'_, v8::Function>) -> Result<Got, Terminated> {
    let (kind, value) = match source {
        FaceSource::Url(url) => (URL, url.as_str()),
        FaceSource::Local(name) => (LOCAL, name.as_str()),
    };
    let key = (kind, if kind == LOCAL { format!("{value}|{bucket}") } else { value.to_owned() });
    let files = &realm(scope, cid).font_files;
    if kind == URL && files.flights.contains_key(value) {
        return Ok(Got::Pending);
    }
    if kind == URL && files.cancelled.contains(value) {
        return Ok(Got::Cancelled);
    }
    let path = match files.files.get(&key).cloned() {
        Some(path) => path,
        None => {
            let got = match source {
                FaceSource::Url(url) => match crate::subresource_obtain::font_fetch_begin(scope, cid, url, referrer, host)? {
                    FontFetch::Done(path) => path,
                    FontFetch::Flight(fetch) => {
                        let arena = realm(scope, cid);
                        let (id, due, began) = (fetch.id, fetch.due, arena.event_loop.clock);
                        arena.font_files.flights.insert(url.clone(), Flight { fetch, began, waiters: Vec::new() });
                        let args = [v8::Integer::new_from_unsigned(scope, id).into(), v8::Number::new(scope, due).into()];
                        crate::subresource_obtain::call(scope, host, crate::subresource_obtain::H_FONT_LAND, &args)?;
                        return Ok(Got::Pending);
                    }
                },
                FaceSource::Local(name) => {
                    let (Some(v), Some(b)) = (v8::String::new(scope, name), v8::String::new(scope, bucket)) else { return Ok(Got::None(0.0)) };
                    let got = crate::subresource_obtain::call(scope, host, crate::subresource_obtain::H_LOCAL_FONT, &[v.into(), b.into()])?;
                    crate::subresource_obtain::text_of(scope, got)
                }
            };
            realm(scope, cid).font_files.files.insert(key, got.clone());
            got
        }
    };
    let took = if kind == URL { realm(scope, cid).font_files.took.get(value).copied().unwrap_or(0.0) } else { 0.0 };
    Ok(path.filter(|p| crate::font::register_path(p) >= 0).map_or(Got::None(took), |p| Got::File(p, took)))
}
// …and what a face's sources come to: a buffer face's own `file`, else the first of its `sources` that gives one — a
// browser tries each in turn: a `src` listing woff2, then woff, then ttf takes the first that comes; a `local()` name
// looked up at the weight / style `bucket` its descriptors name — the face read from it where it came within `usable_for`
// ms of the face's load beginning (its `font-display` periods: CSS Fonts 4 §4.9.1, the font display timeline starts as
// the face is first used — the downloads of the sources it tried before counted in, Firefox `d1`; Chrome times the last
// alone). Under way where the first source not yet known is a download under way — the FontFace `waiter`
// (`[face, state]`), where given, waiting for it; failed, its other sources untried, where its document's abort cancelled
// that download.
#[allow(clippy::too_many_arguments)]
pub(crate) fn face_file(
    scope: &mut v8::PinScope<'_, '_>,
    cid: i32,
    file: Option<&str>,
    sources: &[FaceSource],
    bucket: &str,
    referrer: Option<&str>,
    usable_for: f64,
    host: v8::Local<'_, v8::Function>,
    waiter: Option<(v8::Local<'_, v8::Object>, v8::Local<'_, v8::Object>)>,
) -> Result<FaceFile, Terminated> {
    if let Some(file) = file {
        let file = Some(file.to_owned()).filter(|p| crate::font::register_path(p) >= 0);
        return Ok(FaceFile::Settled { loaded: file.is_some(), file });
    }
    let mut tried = 0.0;
    for source in sources {
        match source_file(scope, cid, source, bucket, referrer, host)? {
            Got::File(path, took) => return Ok(FaceFile::Settled { file: (tried + took <= usable_for).then_some(path), loaded: true }),
            Got::None(took) => tried += took,
            Got::Cancelled => break,
            Got::Pending => {
                if let (Some((face, state)), FaceSource::Url(url)) = (waiter, source) {
                    let (face, state) = (v8::Global::new(scope, face), v8::Global::new(scope, state));
                    if let Some(flight) = realm(scope, cid).font_files.flights.get_mut(url) {
                        flight.waiters.push((face, state));
                    }
                }
                return Ok(FaceFile::Pending);
            }
        }
    }
    Ok(FaceFile::Settled { file: None, loaded: false })
}
// A download landed (`fontFetchLand`): the flight of the host's slot `slot` taken — the file it gave kept, how long it took,
// the generation moved — its URL, and the FontFaces whose `load()` waited for it, `[face, state]`, handed back; none
// where no flight is the slot's (let go of: its document went).
pub(crate) struct Landed {
    pub(crate) url: String,
    pub(crate) waiters: Vec<(v8::Global<v8::Object>, v8::Global<v8::Object>)>,
}
pub(crate) fn land(scope: &mut v8::PinScope<'_, '_>, cid: i32, id: u32, host: v8::Local<'_, v8::Function>) -> Result<Option<Landed>, Terminated> {
    let files = &mut realm(scope, cid).font_files;
    let Some(url) = files.flights.iter().find(|(_, f)| f.fetch.id == id).map(|(u, _)| u.clone()) else { return Ok(None) };
    let flight = files.flights.remove(&url).expect("just found");
    let cancelled = flight.fetch.cancelled();
    let path = crate::subresource_obtain::font_fetch_land(scope, host, flight.fetch)?;
    let arena = realm(scope, cid);
    let took = arena.event_loop.clock - flight.began;
    let files = &mut arena.font_files;
    if cancelled {
        files.cancelled.insert(url.clone());
    } else {
        files.files.insert((URL, url.clone()), path);
        files.took.insert(url.clone(), took);
    }
    files.generation = files.generation.wrapping_add(1);
    Ok(Some(Landed { url, waiters: flight.waiters }))
}
// …and every download under way let go of: a new document begins in the realm, whose faces are its own to load
// (`cancel` false: nothing lands them) — or its document's abort cancels them (`cancel`: each lands as a network error,
// its landing task to run at once), their numbers.
pub(crate) fn drop_flights(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, cancel: bool) -> Result<Vec<u32>, Terminated> {
    let files = &mut realm(scope, cid).font_files;
    let mut flights: Vec<(String, Flight)> = files.flights.drain().collect();
    let mut ids = Vec::with_capacity(flights.len());
    for (_, flight) in &mut flights {
        crate::subresource_obtain::font_fetch_drop(scope, host, &mut flight.fetch, cancel)?;
        ids.push(flight.fetch.id);
    }
    let files = &mut realm(scope, cid).font_files;
    if cancel {
        files.flights.extend(flights);
    } else {
        files.cancelled.clear();
    }
    Ok(ids)
}
// …the answer an op gives of a face's file: the path, null for none, undefined while it is under way — nothing at all
// once the script is terminated.
pub(crate) fn answer_file(scope: &mut v8::PinScope<'_, '_>, rv: &mut v8::ReturnValue<'_, v8::Value>, file: Result<FaceFile, Terminated>) {
    match file {
        Ok(FaceFile::Settled { file: Some(path), .. }) => match v8::String::new(scope, &path) {
            Some(path) => rv.set(path.into()),
            None => rv.set_null(),
        },
        Ok(FaceFile::Settled { file: None, .. }) => rv.set_null(),
        Ok(FaceFile::Pending) => rv.set_undefined(),
        Err(Terminated) => {}
    }
}
// …what a `url()` source came to so far: its download under way (`Some(None)`), one that came and gave none
// (`Some(Some(false))`), one that gave a file native reads (`Some(Some(true))`) — or it was never asked (None).
pub(crate) fn source_tried(arena: &crate::dom::RealmArena, value: &str) -> Option<Option<bool>> {
    if arena.font_files.flights.contains_key(value) {
        return Some(None);
    }
    let path = arena.font_files.files.get(&(URL, value.to_owned()))?;
    Some(Some(path.as_deref().is_some_and(|p| crate::font::register_path(p) >= 0)))
}
