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
// (`srcset="big 99x"` still fetches `src` at a device pixel ratio of 1). Width-described candidates (`Nw`) take their
// density from the source size its `sizes` gives (`source_size`), a density-described one in the same set dropped (HTML
// "parse a srcset attribute": a set with a width descriptor is one of widths). The candidate chosen is the smallest
// density at or above 1 (the display's ratio), else the largest — with its density. None where it names nothing.
pub(crate) fn select(arena: &RealmArena, img: NodeId, viewport: (f32, f32), media_matches: &dyn Fn(&str) -> bool) -> Option<(String, f64)> {
    let node = arena.get(img)?;
    let picked = picture_source(arena, img, media_matches);
    let (srcset, sizes) = match picked.and_then(|s| arena.get(s)) {
        Some(s) => (s.plain_attr("srcset"), s.plain_attr("sizes")),
        None => (node.plain_attr("srcset"), node.plain_attr("sizes")),
    };
    let src = node.plain_attr("src");
    let mut candidates = parse_srcset(srcset.unwrap_or(""));
    if candidates.is_empty() {
        return src.map(|s| (s.to_owned(), 1.0));
    }
    if candidates.iter().any(|c| c.width.is_some()) {
        let size = source_size(sizes.unwrap_or(""), viewport, media_matches);
        candidates.retain(|c| c.width.is_some());
        for c in &mut candidates {
            c.density = c.width.unwrap_or(0) as f64 / size;
        }
    } else if picked.is_none() && !candidates.iter().any(|c| c.density == 1.0) {
        if let Some(src) = src.filter(|s| !s.is_empty()) {
            candidates.push(Candidate { url: src, density: 1.0, width: None });
        }
    }
    candidates.retain(|c| c.density.is_finite() && c.density > 0.0);
    candidates.sort_by(|a, b| a.density.total_cmp(&b.density));
    let chosen = candidates.iter().find(|c| c.density >= 1.0).or(candidates.last())?;
    Some((chosen.url.to_owned(), chosen.density))
}

// HTML "parse a sizes attribute" (§4.8.4.3.11), its source size: the first `<source-size>` of the comma-separated list
// whose `<media-condition>` matches (one with none always does), its `<source-size-value>` — a length, `calc()` among
// them — in CSS pixels on a `viewport`; 100vw where none does, or one is invalid (a negative one, a percentage), or the
// list says `auto` (a lazy image's concrete width, which only layout knows: 100vw as HTML has it where none is taken).
pub(crate) fn source_size(sizes: &str, viewport: (f32, f32), media_matches: &dyn Fn(&str) -> bool) -> f64 {
    let vw = f64::from(viewport.0);
    for item in split_top_level(sizes) {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        let (condition, value) = split_last_value(item);
        if value.eq_ignore_ascii_case("auto") {
            continue;
        }
        let Some(px) = css_length(value, viewport).filter(|v| *v >= 0.0) else { continue };
        let condition = condition.trim();
        if condition.is_empty() || media_matches(condition) {
            return px;
        }
    }
    vw
}
// …its list's items: split on commas outside parentheses.
fn split_top_level(s: &str) -> Vec<&str> {
    let (mut depth, mut start, mut out) = (0i32, 0, Vec::new());
    for (i, c) in s.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth <= 0 => {
                out.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&s[start..]);
    out
}
// …an item's last component value — a function with its parenthesised arguments (`calc(…)`), else its last token — and
// what comes before it, the media condition.
fn split_last_value(item: &str) -> (&str, &str) {
    if item.ends_with(')') {
        let mut depth = 0;
        for (i, c) in item.char_indices().rev() {
            match c {
                ')' => depth += 1,
                '(' => {
                    depth -= 1;
                    if depth == 0 {
                        let name = item[..i].rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '-')).map_or(0, |at| at + 1);
                        // (…a bare parenthesised group is the media condition's own, no value at all)
                        return if name == i { (item, "") } else { (&item[..name], &item[name..]) };
                    }
                }
                _ => {}
            }
        }
        return (item, "");
    }
    match item.rfind(|c: char| c.is_ascii_whitespace()) {
        Some(at) => (&item[..at], &item[at + 1..]),
        None => ("", item),
    }
}
// A CSS `<length>` in px on a `viewport` — an absolute unit, a font-relative one at the initial 16px (ex and ch half of it),
// a viewport-relative one, a unitless 0, or a `calc()` of them (`+`, `-` between lengths, `*` and `/` by numbers) — none
// for anything else.
fn css_length(text: &str, viewport: (f32, f32)) -> Option<f64> {
    let mut p = LengthParser { s: text.trim().as_bytes(), at: 0, viewport: (f64::from(viewport.0), f64::from(viewport.1)) };
    let value = p.value()?;
    p.ws();
    (p.at == p.s.len()).then_some(value)
}
struct LengthParser<'a> {
    s: &'a [u8],
    at: usize,
    viewport: (f64, f64),
}
impl LengthParser<'_> {
    fn ws(&mut self) {
        while self.s.get(self.at).is_some_and(u8::is_ascii_whitespace) {
            self.at += 1;
        }
    }
    fn eat(&mut self, text: &str) -> bool {
        let end = self.at + text.len();
        let hit = self.s.get(self.at..end).is_some_and(|t| t.eq_ignore_ascii_case(text.as_bytes()));
        if hit {
            self.at = end;
        }
        hit
    }
    // A top-level value: a `calc()` or a dimension.
    fn value(&mut self) -> Option<f64> {
        self.ws();
        if self.eat("calc(") {
            let v = self.sum()?;
            self.ws();
            return self.eat(")").then_some(v);
        }
        self.dimension()?.1
    }
    // `a + b - c`: lengths; `*` / `/` by numbers (`term`).
    fn sum(&mut self) -> Option<f64> {
        let mut total = self.term()?.filter_length()?;
        loop {
            self.ws();
            let sign = if self.eat("+") { 1.0 } else if self.eat("-") { -1.0 } else { return Some(total) };
            total += sign * self.term()?.filter_length()?;
        }
    }
    fn term(&mut self) -> Option<Term> {
        let mut t = self.factor()?;
        loop {
            self.ws();
            if self.eat("*") {
                t = t.times(self.factor()?)?;
            } else if self.eat("/") {
                let Term::Number(d) = self.factor()? else { return None };
                t = t.times(Term::Number(1.0 / d))?;
            } else {
                return Some(t);
            }
        }
    }
    fn factor(&mut self) -> Option<Term> {
        self.ws();
        if self.eat("(") || self.eat("calc(") {
            let v = self.sum()?;
            self.ws();
            return self.eat(")").then_some(Term::Length(v));
        }
        let (number, length) = self.dimension()?;
        Some(length.map_or(Term::Number(number), Term::Length))
    }
    // A number and its unit: (the number, its length in px — None for a bare number but 0).
    fn dimension(&mut self) -> Option<(f64, Option<f64>)> {
        self.ws();
        let start = self.at;
        let digit = |p: &Self, at: usize| p.s.get(at).is_some_and(u8::is_ascii_digit);
        if matches!(self.s.get(self.at), Some(b'+' | b'-')) {
            self.at += 1;
        }
        while digit(self, self.at) || self.s.get(self.at) == Some(&b'.') {
            self.at += 1;
        }
        // (…an exponent, where an `e` is followed by digits — else it starts a unit: `em`, `ex`)
        if matches!(self.s.get(self.at), Some(b'e' | b'E')) {
            let signed = matches!(self.s.get(self.at + 1), Some(b'+' | b'-'));
            let first = self.at + 1 + usize::from(signed);
            if digit(self, first) {
                self.at = first;
                while digit(self, self.at) {
                    self.at += 1;
                }
            }
        }
        let number: f64 = std::str::from_utf8(&self.s[start..self.at]).ok()?.parse().ok()?;
        let unit_start = self.at;
        while self.s.get(self.at).is_some_and(u8::is_ascii_alphabetic) {
            self.at += 1;
        }
        let unit = std::str::from_utf8(&self.s[unit_start..self.at]).ok()?.to_ascii_lowercase();
        let (vw, vh) = (self.viewport.0 / 100.0, self.viewport.1 / 100.0);
        let px = match unit.as_str() {
            "" => return Some((number, (number == 0.0).then_some(0.0))),
            "px" => 1.0,
            "em" | "rem" => 16.0,
            "ex" | "ch" => 8.0,
            "in" => 96.0,
            "cm" => 96.0 / 2.54,
            "mm" => 96.0 / 25.4,
            "q" => 96.0 / 101.6,
            "pt" => 96.0 / 72.0,
            "pc" => 16.0,
            "vw" | "svw" | "lvw" | "dvw" => vw,
            "vh" | "svh" | "lvh" | "dvh" => vh,
            "vmin" => vw.min(vh),
            "vmax" => vw.max(vh),
            _ => return None,
        };
        Some((number, Some(number * px)))
    }
}
enum Term {
    Number(f64),
    Length(f64),
}
impl Term {
    fn filter_length(self) -> Option<f64> {
        match self {
            Term::Length(v) => Some(v),
            Term::Number(_) => None,
        }
    }
    fn times(self, other: Term) -> Option<Term> {
        match (self, other) {
            (Term::Number(a), Term::Number(b)) => Some(Term::Number(a * b)),
            (Term::Length(a), Term::Number(b)) | (Term::Number(b), Term::Length(a)) => Some(Term::Length(a * b)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_first_matching_source_size() {
        let matches = |m: &str| m == "(min-width: 500px)";
        assert_eq!(source_size("(min-width: 500px) 50vw, 100px", (800.0, 600.0), &matches), 400.0);
        assert_eq!(source_size("(max-width: 1px) 10px, calc(100vw - 2 * 10px)", (800.0, 600.0), &matches), 780.0);
        assert_eq!(source_size("auto, 2em", (800.0, 600.0), &matches), 32.0);
        assert_eq!(source_size("-5px, bogus", (800.0, 600.0), &matches), 800.0);
        assert_eq!(source_size("", (800.0, 600.0), &matches), 800.0);
    }

    #[test]
    fn parses_candidates() {
        let c = parse_srcset(" a.png 2x , data:image/png;base64,AA== 1.5x,b.png 100w,c.png,, d.png");
        let got: Vec<(&str, f64, Option<u64>)> = c.iter().map(|c| (c.url, c.density, c.width)).collect();
        assert_eq!(got, vec![("a.png", 2.0, None), ("data:image/png;base64,AA==", 1.5, None), ("b.png", 1.0, Some(100)), ("c.png", 1.0, None), ("d.png", 1.0, None)]);
        assert!(parse_srcset(" , ").is_empty());
    }
}
