// Which image an `<img>` fetches (HTML §4.8.4.3, "update the image data" / "select an image source"): the `<source>`
// of a `<picture>` it takes its candidates from, an image candidate string parsed (`srcset`), and the candidate chosen
// — what the page loads, and (hints.rs) the source whose dimensions a picture's box reserves.

use crate::dom::{NodeId, RealmArena};

// The `<source>` of the `<picture>` around `img` that it selects: the picture's children UP TO the img (a source written
// after it is never a candidate — Chrome), a source whose `media` does not match or whose `type` names nothing
// decodable skipped, the first with a candidate in its `srcset` taken; None where it is in no picture or none is.
pub(crate) fn picture_source(arena: &RealmArena, img: NodeId, media_matches: &dyn Fn(&str) -> bool) -> Option<NodeId> {
    let picture = arena.parent_of(img).and_then(|p| arena.get(p)).filter(|p| p.is_html_named("picture"))?;
    for &c in &picture.children {
        if c == img {
            return None;
        }
        let Some(source) = arena.get(c).filter(|n| n.is_html_named("source")) else { continue };
        if source.plain_attr("media").is_some_and(|m| !media_matches(m)) {
            continue;
        }
        // (…an empty `type` names no format to refuse: the source is taken, as Chrome and Firefox take it)
        if source.plain_attr("type").map(str::trim).is_some_and(|t| !t.is_empty() && !decodable_image_type(t)) {
            continue;
        }
        if !parse_srcset(source.plain_attr("srcset").unwrap_or("")).is_empty() {
            return Some(c);
        }
    }
    None
}
// A `type` naming an image format the decoder reads (image_decode.rs: as Chrome, no TIFF or HEIF), told apart from the
// `image/bogus` a page uses to force the fallback.
fn decodable_image_type(t: &str) -> bool {
    let t = t.to_ascii_lowercase();
    matches!(
        t.strip_prefix("image/").unwrap_or(""),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "svg+xml" | "bmp" | "x-icon" | "vnd.microsoft.icon"
    )
}

// An image candidate: its URL, its density (`Nx`, 1 by default) and its width (`Nw`), if it has one.
#[derive(Debug, PartialEq)]
pub(crate) struct Candidate<'a> {
    pub(crate) url: &'a str,
    density: f64,
    width: Option<u64>,
}

// "Parse a srcset attribute" (§4.8.4.3.10): candidates separated by commas BETWEEN them, a URL being a run of
// non-whitespace (a `data:` URL keeps its own commas, a trailing one ends it), each followed by its descriptors up to
// the next comma.
pub(crate) fn parse_srcset(s: &str) -> Vec<Candidate<'_>> {
    let is_ws = |c: u8| matches!(c, b' ' | b'\t' | b'\n' | b'\x0C' | b'\r');
    let b = s.as_bytes();
    let (n, mut i) = (b.len(), 0);
    let mut out = Vec::new();
    while i < n {
        while i < n && (is_ws(b[i]) || b[i] == b',') {
            i += 1;
        }
        if i >= n {
            break;
        }
        let start = i;
        while i < n && !is_ws(b[i]) {
            i += 1;
        }
        let mut url = &s[start..i];
        let mut descriptors = "";
        if url.ends_with(',') {
            url = url.trim_end_matches(',');
        } else {
            while i < n && is_ws(b[i]) {
                i += 1;
            }
            let from = i;
            while i < n && b[i] != b',' {
                i += 1;
            }
            descriptors = s[from..i].trim_matches(|c: char| c.is_ascii() && is_ws(c as u8));
            if i < n {
                i += 1;
            }
        }
        if url.is_empty() {
            continue;
        }
        let (mut density, mut width) = (1.0, None);
        for token in descriptors.split(|c: char| c.is_ascii() && is_ws(c as u8)).filter(|t| !t.is_empty()) {
            if let Some(x) = token.strip_suffix('x').filter(|x| !x.is_empty() && x.bytes().all(|c| c.is_ascii_digit() || c == b'.')) {
                density = leading_float(x);
            } else if let Some(w) = token.strip_suffix('w').filter(|w| !w.is_empty() && w.bytes().all(|c| c.is_ascii_digit())) {
                width = w.parse().ok();
            }
        }
        out.push(Candidate { url, density, width });
    }
    out
}
// Script's parseFloat of digits and dots: the longest leading run that is a number (`1.5.2` is 1.5), NaN for none.
fn leading_float(s: &str) -> f64 {
    let mut end = s.len();
    while end > 0 {
        if let Ok(v) = s[..end].parse::<f64>() {
            return v;
        }
        end -= 1;
    }
    f64::NAN
}

// The URL `img` fetches ("select an image source", in brief): its picture's selected source's candidates, else its
// own `srcset`'s, over its `src`. Where its own srcset has only densities and no `1x`, `src` joins it as `1x`
// (`srcset="big 99x"` still fetches `src` at a device pixel ratio of 1). A candidate with a width is chosen first-come
// (exact for one); else the smallest density at or above 1, else the largest. None where it names nothing.
pub(crate) fn select(arena: &RealmArena, img: NodeId, media_matches: &dyn Fn(&str) -> bool) -> Option<String> {
    let node = arena.get(img)?;
    let picked = picture_source(arena, img, media_matches);
    let srcset = match picked {
        Some(s) => arena.get(s).and_then(|n| n.plain_attr("srcset")),
        None => node.plain_attr("srcset"),
    };
    let src = node.plain_attr("src");
    let mut candidates = parse_srcset(srcset.unwrap_or(""));
    if candidates.is_empty() {
        return src.map(str::to_owned);
    }
    let by_width = candidates.iter().any(|c| c.width.is_some());
    if by_width {
        return Some(candidates[0].url.to_owned());
    }
    if picked.is_none() && !candidates.iter().any(|c| c.density == 1.0) {
        if let Some(src) = src.filter(|s| !s.is_empty()) {
            candidates.push(Candidate { url: src, density: 1.0, width: None });
        }
    }
    candidates.sort_by(|a, b| a.density.total_cmp(&b.density));
    let chosen = candidates.iter().find(|c| c.density >= 1.0).or(candidates.last())?;
    Some(chosen.url.to_owned())
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "imageSource", image_source, context_id);
}

// __dom.imageSource(nid, viewportWidth, viewportHeight) -> the URL the `<img>` fetches (`select`), a `media` judged on a
// viewport of that size; undefined where it names none.
fn image_source(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let viewport = [1, 2].map(|i| args.get(i).number_value(scope).unwrap_or(0.0) as f32);
    let d = crate::dom::dom(scope);
    let screen = crate::style::Screen { viewport: (viewport[0], viewport[1]), touch: d.touch_input };
    let Some(arena) = d.realms.get(&cid) else { return };
    let engine = d.styles.get(&cid);
    let url = select(arena, id, &|media| crate::style::media_matches(engine, arena, screen, media));
    if let Some(s) = url.and_then(|u| v8::String::new(scope, &u)) {
        rv.set(s.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_candidates() {
        let c = parse_srcset(" a.png 2x , data:image/png;base64,AA== 1.5x,b.png 100w,c.png,, d.png");
        let got: Vec<(&str, f64, Option<u64>)> = c.iter().map(|c| (c.url, c.density, c.width)).collect();
        assert_eq!(got, vec![("a.png", 2.0, None), ("data:image/png;base64,AA==", 1.5, None), ("b.png", 1.0, Some(100)), ("c.png", 1.0, None), ("d.png", 1.0, None)]);
        assert!(parse_srcset(" , ").is_empty());
    }
}
