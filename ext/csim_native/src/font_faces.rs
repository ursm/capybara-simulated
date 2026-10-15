// The document's `@font-face`s (CSS Fonts 4 §4) and the face a family takes from them (§5.2, font matching): each
// face's descriptors parsed by the engine — its sources in order, its weight range, whether it is slanted, its
// `unicode-range`, its `size-adjust` and metric overrides — and, for a family stack and a weight / style bucket, the
// face (or the ordered faces a `unicode-range` split picks from) that matches. Which of a face's sources loads is the
// page side's to find out (it fetches); everything about WHICH face is native's.

use crate::dom::RealmArena;

// A face's source, in `src` order: a downloaded file's absolute URL, or the name of an installed font.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum FaceSource {
    Url(String),
    Local(String),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FaceRecord {
    // The family it is a face of, ASCII-lowercased.
    family: String,
    pub(crate) sources: Vec<FaceSource>,
    weight: (f64, f64),
    // Its `font-stretch` range, in percent.
    stretch: (f64, f64),
    slanted: bool,
    // The code points it covers, None for every one.
    pub(crate) ranges: Option<Vec<(u32, u32)>>,
    // Its `size-adjust` (1 for none) and its `ascent-override` / `descent-override` / `line-gap-override`, em fractions.
    pub(crate) size_adjust: f64,
    pub(crate) overrides: [Option<f64>; 3],
}

// How far a face is from a style, each of §5.2's steps in turn: stretch, slant, weight — compared in that order.
#[derive(Clone, Copy, PartialEq)]
struct Distance([f64; 3]);
impl Distance {
    fn cmp(&self, other: &Distance) -> std::cmp::Ordering {
        self.0.iter().zip(&other.0).map(|(a, b)| a.total_cmp(b)).find(|o| o.is_ne()).unwrap_or(std::cmp::Ordering::Equal)
    }
}

impl FaceRecord {
    // A face of `family` with every descriptor at its initial value.
    fn of(family: String) -> FaceRecord {
        FaceRecord { family, sources: Vec::new(), weight: (400.0, 400.0), stretch: (100.0, 100.0), slanted: false, ranges: None, size_adjust: 1.0, overrides: [None; 3] }
    }
    // How far it is from what a style asks for (CSS Fonts 4 §5.2): the nearest stretch first, then the same slant, then
    // the nearest weight.
    fn distance(&self, stretch: f64, weight: f64, slanted: bool) -> Distance {
        Distance([stretch_distance(stretch, self.stretch), f64::from(u8::from(self.slanted != slanted)), weight_distance(weight, self.weight)])
    }
    // Whether its `unicode-range` covers `c`.
    fn covers(&self, c: u32) -> bool {
        self.ranges.as_ref().is_none_or(|r| r.iter().any(|&(lo, hi)| (lo..=hi).contains(&c)))
    }
}

// A face of the descriptor block `text` (`font-family: …; src: …; …`), its `url()`s resolved against `base` — None
// where it names no family. A face with no source (one script built of a buffer) has none, and the page side knows its
// file.
pub(crate) fn parse(text: &str, base: &str) -> Option<FaceRecord> {
    use style::font_face::{FontStyleRange, Source};
    use style::stylesheets::CssRuleType;
    let url = crate::cssom_decl::url_data(base);
    let context = crate::cssom_decl::rule_context(&url, CssRuleType::FontFace, false);
    let mut input = cssparser::ParserInput::new(text);
    let mut parser = cssparser::Parser::new(&mut input);
    let rule = style::font_face::parse_font_face_block(&context, &mut parser, cssparser::SourceLocation { line: 0, column: 0 });
    let d = rule.descriptors;
    let family = d.font_family.as_ref()?.name.to_string().to_ascii_lowercase();
    let mut sources = Vec::new();
    for source in d.src.as_ref().map_or(&[][..], |s| &s.0[..]) {
        match source {
            Source::Url(u) => {
                // (…a container no decoder here reads — EOT, an SVG font — is passed over, as a browser passes over a
                // format it does not support)
                if unreadable_format(u) {
                    continue;
                }
                // (…one its base cannot resolve — a blob: worker's — as written, which the host resolves against the page)
                sources.push(FaceSource::Url(u.url.url().map_or_else(|| u.url.original().unwrap_or_default().to_owned(), |url| url.as_str().to_owned())));
            }
            Source::Local(name) => sources.push(FaceSource::Local(name.name.to_string())),
        }
    }
    let stretch = d
        .font_stretch
        .as_ref()
        .and_then(|s| s.compute())
        .map_or((100.0, 100.0), |s| (f64::from(s.0.to_percentage().0) * 100.0, f64::from(s.1.to_percentage().0) * 100.0));
    let weight = d
        .font_weight
        .as_ref()
        .and_then(|w| w.compute())
        .map_or((400.0, 400.0), |w| (f64::from(w.0.value()), f64::from(w.1.value())));
    let slanted = match &d.font_style {
        Some(FontStyleRange::Italic) => true,
        Some(FontStyleRange::Oblique(a, b)) => a.degrees().unwrap_or(0.0) != 0.0 || b.degrees().unwrap_or(0.0) != 0.0,
        None => false,
    };
    let ranges = d.unicode_range.as_ref().map(|r| r.iter().map(|u| (u.start, u.end)).collect::<Vec<_>>());
    let ranges = ranges.filter(|r| !r.iter().any(|&(lo, hi)| lo == 0 && hi >= 0x10ffff));
    let size_adjust = d.size_adjust.as_ref().and_then(|p| p.compute()).map_or(1.0, |p| decimal(p.0));
    let over = |o: &Option<style::values::specified::font::MetricsOverride>| {
        o.as_ref().and_then(|o| o.compute()).map(|p| decimal(p.0)).filter(|&p| p >= 0.0)
    };
    Some(FaceRecord {
        sources,
        weight,
        stretch,
        slanted,
        ranges,
        size_adjust,
        overrides: [over(&d.ascent_override), over(&d.descent_override), over(&d.line_gap_override)],
        ..FaceRecord::of(family)
    })
}
// An f32 the engine holds a percentage in, as the decimal it was written as: `90%` is 0.9, not 0.8999999761581421.
fn decimal(x: f32) -> f64 {
    x.to_string().parse().unwrap_or(f64::from(x))
}
// A `url()` source whose `format()` (or, with none, its extension) names a container no decoder here reads: EOT or an
// SVG font.
fn unreadable_format(u: &style::font_face::UrlSource) -> bool {
    use style::font_face::{FontFaceSourceFormat, FontFaceSourceFormatKeyword as K};
    match &u.format_hint {
        Some(FontFaceSourceFormat::Keyword(K::EmbeddedOpentype | K::Svg)) => true,
        Some(FontFaceSourceFormat::String(s)) => matches!(s.to_ascii_lowercase().as_str(), "embedded-opentype" | "svg"),
        Some(_) => false,
        None => u.url.url().is_some_and(|url| {
            let path = url.path().to_ascii_lowercase();
            path.ends_with(".eot") || path.ends_with(".svg")
        }),
    }
}

// The faces of a family stack (a computed `font-family`, as its value serializes) at a weight / style bucket
// (`bold`, `italic`, `bold:italic`, ``), as indices into `faces`: with `all`, every face of every family of the stack
// in the order a character picks from them — family by family, each family's best match first (a tie to the later
// rule) — else the one face of the first family that has any. CSS Fonts 4 §5.2: the same style first, then the nearest
// weight.
pub(crate) fn pick(faces: &[FaceRecord], stack: &str, bucket: &str, all: bool) -> Vec<usize> {
    let want = if bucket.contains("bold") { 700.0 } else { 400.0 };
    let italic = bucket.contains("italic");
    let mut out = Vec::new();
    for family in families(stack) {
        let mut scored: Vec<(Distance, usize)> = faces
            .iter()
            .enumerate()
            .filter(|(_, f)| f.family == family)
            .map(|(i, f)| (f.distance(100.0, want, italic), i))
            .collect();
        if scored.is_empty() {
            continue;
        }
        // (…best first, and of equal ones the LATER rule)
        scored.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
        if !all {
            return vec![scored[0].1];
        }
        out.extend(scored.into_iter().map(|(_, i)| i));
    }
    out
}
// CSS Font Loading's "find the matching font faces" (§2.4) among `faces`: for each family the `font` shorthand names,
// the faces font matching picks (CSS Fonts 4 §5.2) — its style and weight decide among ALL the family's faces first
// (`distance`), and only of the faces that match best, a `unicode-range` split, are the ones covering a character of
// `text` taken (a character none of them covers is the next family's) — each once, in the order picked. None where
// `font` is no `font` value.
pub(crate) fn matching(faces: &[FaceRecord], font: &str, text: &str) -> Option<Vec<usize>> {
    let (families, stretch, weight, slanted) = crate::cssom_decl::font_shorthand_match(font)?;
    let mut out = Vec::new();
    for family in families.iter().map(|f| f.to_ascii_lowercase()) {
        let of_family: Vec<(Distance, usize)> =
            faces.iter().enumerate().filter(|(_, f)| f.family == family).map(|(i, f)| (f.distance(stretch, weight, slanted), i)).collect();
        let Some(best) = of_family.iter().map(|&(d, _)| d).min_by(Distance::cmp) else { continue };
        for c in text.chars().map(u32::from) {
            // (…of the best ones covering it, the later rule)
            let picked = of_family.iter().rev().find(|&&(d, i)| d == best && faces[i].covers(c));
            if let Some(&(_, i)) = picked.filter(|(_, i)| !out.contains(i)) {
                out.push(i);
            }
        }
    }
    Some(out)
}
// The families of a `font-family` value, unquoted and ASCII-lowercased.
fn families(stack: &str) -> Vec<String> {
    family_list(stack).into_iter().map(|(f, _)| f.to_ascii_lowercase()).collect()
}
// …as written: CSS Fonts 4 §2.1's `<family-name>#` — each a string, or identifiers joined by single spaces (a comma inside
// a string no separator: `"Foo, Bar"` is one family), and whether it was the string — a family that is neither skipped.
pub(crate) fn family_list(stack: &str) -> Vec<(String, bool)> {
    let mut input = cssparser::ParserInput::new(stack);
    let mut parser = cssparser::Parser::new(&mut input);
    let mut out = Vec::new();
    loop {
        let item: Result<(String, bool), cssparser::ParseError<'_, ()>> = parser.parse_until_before(cssparser::Delimiter::Comma, |p| {
            if let Ok(s) = p.try_parse(|p| p.expect_string().map(|s| s.as_ref().to_owned())) {
                p.expect_exhausted()?;
                return Ok((s, true));
            }
            let mut words = vec![p.expect_ident()?.as_ref().to_owned()];
            while let Ok(w) = p.try_parse(|p| p.expect_ident().map(|w| w.as_ref().to_owned())) {
                words.push(w);
            }
            p.expect_exhausted()?;
            Ok((words.join(" "), false))
        });
        if let Some(family) = item.ok().filter(|(f, _)| !f.is_empty()) {
            out.push(family);
        }
        if parser.next().is_err() {
            return out;
        }
    }
}
// …each written back as a stack of that one family: a string quoted (its escapes kept), identifiers as identifiers — so
// a family handed on as a stack is the family it was (`"x, A"` stays one; `serif` stays the generic).
pub(crate) fn serialized_family_list(stack: &str) -> Vec<String> {
    family_list(stack)
        .into_iter()
        .map(|(f, string)| {
            let mut out = String::new();
            if string {
                let _ = cssparser::serialize_string(&f, &mut out);
                return out;
            }
            for (k, word) in f.split(' ').enumerate() {
                if k > 0 {
                    out.push(' ');
                }
                let _ = cssparser::serialize_identifier(word, &mut out);
            }
            out
        })
        .collect()
}
// Capybara::Simulated::Native.font_family_list(stack) -> the families, unquoted (`family_list`): the host's system-font
// lookup.
pub(crate) fn family_list_for_ruby(stack: String) -> Vec<String> {
    family_list(&stack).into_iter().map(|(f, _)| f).collect()
}
// How far a face's weight range is from the weight wanted, in the order CSS Fonts 4 §5.2 prefers them: 0 inside it;
// for a wanted 400 or 500, heavier faces up to 500 ascending, then lighter ones descending, then heavier past 500; for
// less, lighter descending then heavier; for more, heavier ascending then lighter.
// How far a stretch range is from the stretch asked for (CSS Fonts 4 §5.2 step 4a): at or below 100%, the narrower ones
// first, nearest first, then the wider; above it, the wider first.
fn stretch_distance(want: f64, (lo, hi): (f64, f64)) -> f64 {
    if (lo..=hi).contains(&want) {
        return 0.0;
    }
    let (narrower, wider) = (want - hi, lo - want);
    match want <= 100.0 {
        true if narrower > 0.0 => narrower,
        true => 1000.0 + wider,
        false if wider > 0.0 => wider,
        false => 1000.0 + narrower,
    }
}
fn weight_distance(want: f64, (lo, hi): (f64, f64)) -> f64 {
    if (lo..=hi).contains(&want) {
        return 0.0;
    }
    let (below, above) = (want - hi, lo - want);
    if want < 400.0 {
        if below > 0.0 { below } else { 100_000.0 + above }
    } else if want <= 500.0 {
        if above > 0.0 {
            if above <= 500.0 - want { above } else { 100_000.0 + above }
        } else {
            50_000.0 + below
        }
    } else if above > 0.0 {
        above
    } else {
        50_000.0 + below
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "fontFacesSet", font_faces_set, context_id);
    crate::dom::register(scope, ns, "fontFacePick", font_face_pick, context_id);
    crate::dom::register(scope, ns, "fontFaceInfo", font_face_info, context_id);
    crate::dom::register(scope, ns, "fontFaceSources", font_face_sources, context_id);
    crate::dom::register(scope, ns, "fontFaceDescriptor", font_face_descriptor, context_id);
    crate::dom::register(scope, ns, "fontFamilyList", font_family_list_op, context_id);
    crate::dom::register(scope, ns, "fontFacesMatching", font_faces_matching, context_id);
}
// __dom.fontFamilyList(stack) -> the families of a `font-family` value, each as a stack of that one family
// (`serialized_family_list`).
fn font_family_list_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let stack = args.get(0).to_rust_string_lossy(scope);
    let items: Vec<v8::Local<v8::Value>> = serialized_family_list(&stack).iter().filter_map(|f| v8::String::new(scope, f)).map(Into::into).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// A `@font-face` descriptor's value as the engine parses and serializes it (CSS Fonts 4 §4, CSS Font Loading's FontFace
// attributes): `name` its CSS name (`font-weight`, `unicode-range`, `size-adjust`, …) — none where the value is no value
// of its grammar, or the name no descriptor's. (OPEN: a `@font-face` rule's own `font-weight: auto` the style system still
// drops — its range grammars have no `auto`; a change for the ursm/stylo fork.)
pub(crate) fn descriptor(name: &str, value: &str) -> Option<String> {
    // (…`auto` for `font-weight`, `font-style` and `font-stretch` — CSS Fonts 4's grammar, Chrome's too — which the
    // style system's descriptor grammar does not have)
    if matches!(name, "font-weight" | "font-style" | "font-stretch") {
        let mut input = cssparser::ParserInput::new(value);
        if cssparser::Parser::new(&mut input).parse_entirely(|i| i.expect_ident_matching("auto").map_err(cssparser::ParseError::<()>::from)).is_ok() {
            return Some("auto".to_owned());
        }
    }
    use style::properties::font_face::{DescriptorId, Descriptors};
    use style::stylesheets::CssRuleType;
    let url = crate::cssom_decl::url_data("about:blank");
    let context = crate::cssom_decl::rule_context(&url, CssRuleType::FontFace, false);
    let mut name_input = cssparser::ParserInput::new(name);
    let id = cssparser::Parser::new(&mut name_input).parse_entirely(DescriptorId::parse).ok()?;
    let mut value_input = cssparser::ParserInput::new(value);
    let mut descriptors = Descriptors::default();
    descriptors.set(id, &context, &mut cssparser::Parser::new(&mut value_input)).ok()?;
    let mut out = String::new();
    descriptors.get(id, &mut out).ok()?;
    Some(out)
}
// __dom.fontFaceDescriptor(name, value) -> the value serialized, or null where it is invalid (`descriptor`).
fn font_face_descriptor(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (name, value) = (args.get(0).to_rust_string_lossy(scope), args.get(1).to_rust_string_lossy(scope));
    match descriptor(&name, &value).and_then(|v| v8::String::new(scope, &v)) {
        Some(v) => rv.set(v.into()),
        None => rv.set_null(),
    }
}

// An array argument's strings.
fn strings(scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>) -> Vec<String> {
    let Ok(list) = v8::Local::<v8::Array>::try_from(v) else { return Vec::new() };
    (0..list.length()).map(|k| list.get_index(scope, k).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default()).collect()
}

fn faces_of<'a>(scope: &'a mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> &'a mut Vec<FaceRecord> {
    let cid = crate::dom::realm_id(scope, args);
    let arena: &mut RealmArena = crate::dom::realm(scope, cid);
    &mut arena.font_faces
}

// __dom.fontFacesSet(texts, bases) -> whether any face restricts its `unicode-range`: the document's faces, each a
// descriptor block and the base its `url()`s resolve against (`parse`), in order — the realm's from now on. A block
// that names no family holds a place all the same.
fn font_faces_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let texts = strings(scope, args.get(0));
    let bases = strings(scope, args.get(1));
    let faces: Vec<FaceRecord> = texts
        .iter()
        .enumerate()
        .map(|(k, text)| {
            parse(text, bases.get(k).map_or("about:blank", String::as_str)).unwrap_or_else(|| FaceRecord::of(String::new()))
        })
        .collect();
    let restricted = faces.iter().any(|f| f.ranges.is_some());
    *faces_of(scope, &args) = faces;
    rv.set_bool(restricted);
}

// __dom.fontFacesMatching(font, text, families, descriptors) -> the indices of the faces `font` and `text` match among
// a font face set's (`matching`) — each face its family and its other descriptors' block (`font-weight: …; …`) — or
// null where `font` is no `font` value.
fn font_faces_matching(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (font, text) = (args.get(0).to_rust_string_lossy(scope), args.get(1).to_rust_string_lossy(scope));
    let (families, blocks) = (strings(scope, args.get(2)), strings(scope, args.get(3)));
    let faces: Vec<FaceRecord> = families
        .iter()
        .zip(&blocks)
        .map(|(family, block)| {
            let family = family.trim_matches(|c| c == '"' || c == '\'').to_ascii_lowercase();
            let face = parse(&format!("font-family: x; {block}"), "about:blank").unwrap_or_else(|| FaceRecord::of(String::new()));
            FaceRecord { family, ..face }
        })
        .collect();
    match matching(&faces, &font, &text) {
        Some(picked) => rv.set(crate::dom::f64_array(scope, &picked.into_iter().map(|i| i as f64).collect::<Vec<_>>()).into()),
        None => rv.set_null(),
    }
}

// __dom.fontFacePick(stack, bucket, all) -> the indices of the faces the stack takes (`pick`).
fn font_face_pick(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let stack = args.get(0).to_rust_string_lossy(scope);
    let bucket = args.get(1).to_rust_string_lossy(scope);
    let all = args.get(2).is_true();
    let picked: Vec<f64> = pick(faces_of(scope, &args), &stack, &bucket, all).into_iter().map(|i| i as f64).collect();
    rv.set(crate::dom::f64_array(scope, &picked).into());
}

// __dom.fontFaceInfo(index) -> `[sources, sizeAdjust, ascentOverride, descentOverride, lineGapOverride, ranges, weight,
// slanted]` of a face: its sources in order, flat `[kind, value, …]` (`url` / `local`), its overrides NaN where it has
// none, its ranges a flat `[lo, hi, …]` or null for every code point, the low end of its weight range and whether it is
// slanted.
fn font_face_info(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let index = args.get(0).int32_value(scope).unwrap_or(-1);
    let Some(face) = usize::try_from(index).ok().and_then(|i| faces_of(scope, &args).get(i).cloned()) else { return rv.set_null() };
    let sources = sources_array(scope, &face.sources);
    let mut items: Vec<v8::Local<v8::Value>> = vec![sources.into()];
    items.push(v8::Number::new(scope, face.size_adjust).into());
    for o in face.overrides {
        items.push(v8::Number::new(scope, o.unwrap_or(f64::NAN)).into());
    }
    items.push(match &face.ranges {
        Some(r) => crate::dom::f64_array(scope, &r.iter().flat_map(|&(lo, hi)| [f64::from(lo), f64::from(hi)]).collect::<Vec<_>>()).into(),
        None => v8::null(scope).into(),
    });
    items.push(v8::Number::new(scope, face.weight.0).into());
    items.push(v8::Boolean::new(scope, face.slanted).into());
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
fn sources_array<'s>(scope: &mut v8::PinScope<'s, '_>, list: &[FaceSource]) -> v8::Local<'s, v8::Array> {
    let mut items: Vec<v8::Local<v8::Value>> = Vec::new();
    for source in list {
        let (kind, value) = match source {
            FaceSource::Url(u) => ("url", u.as_str()),
            FaceSource::Local(n) => ("local", n.as_str()),
        };
        let (Some(kind), Some(value)) = (v8::String::new(scope, kind), v8::String::new(scope, value)) else { continue };
        items.push(kind.into());
        items.push(value.into());
    }
    v8::Array::new_with_elements(scope, &items)
}

// __dom.fontFaceSources(src, base) -> a `src` descriptor's sources in order, flat `[kind, value, …]`, each `url()`
// resolved against `base` — those a browser would try (`parse`); none where it does not parse.
fn font_face_sources(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let src = args.get(0).to_rust_string_lossy(scope);
    let base = args.get(1).to_rust_string_lossy(scope);
    let sources = parse(&format!("font-family: x; src: {src}"), &base).map_or(Vec::new(), |f| f.sources);
    let list = sources_array(scope, &sources);
    rv.set(list.into());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_font_face_set_matches_by_style_before_unicode_range() {
        let face = |block: &str| parse(block, "about:blank").unwrap();
        let faces = [
            face("font-family: Fa; font-weight: 400; unicode-range: U+0400-04FF"),
            face("font-family: Fa; font-weight: 700; unicode-range: U+0000-00FF"),
            face("font-family: Cn; font-stretch: condensed"),
            face("font-family: Cn"),
        ];
        assert_eq!(matching(&faces, "bold 16px Fa", "\u{416}"), Some(vec![]));
        assert_eq!(matching(&faces, "16px Fa", "\u{416}a"), Some(vec![0]));
        assert_eq!(matching(&faces, "bold 16px Fa", " "), Some(vec![1]));
        assert_eq!(matching(&faces, "condensed 16px Cn", " "), Some(vec![2]));
        assert_eq!(matching(&faces, "16px Cn", " "), Some(vec![3]));
        assert_eq!(matching(&faces, "Cn", " "), None);
    }

    #[test]
    fn a_family_list_parses_as_css_fonts_says() {
        let names = |s: &str| family_list(s).into_iter().map(|(f, _)| f).collect::<Vec<_>>();
        assert_eq!(names(r#""Foo, Bar", Times  New Roman,serif"#), ["Foo, Bar", "Times New Roman", "serif"]);
        assert_eq!(names("'A', , 1x, B"), ["A", "B"]);
        assert_eq!(serialized_family_list(r#"emoji, "x, A", "serif", Times New Roman"#), ["emoji", r#""x, A""#, r#""serif""#, "Times New Roman"]);
    }

    #[test]
    fn descriptors_parse_and_serialize_as_the_engine_does() {
        assert_eq!(descriptor("font-weight", "bold"), Some("bold".into()));
        assert_eq!(descriptor("font-display", "SWAP"), Some("swap".into()));
        assert_eq!(descriptor("size-adjust", "+50%"), Some("50%".into()));
        assert_eq!(descriptor("size-adjust", "-5%"), None);
        assert_eq!(descriptor("ascent-override", "normal"), Some("normal".into()));
        assert_eq!(descriptor("unicode-range", "U+0-7F, U+4??"), Some("U+0-7F, U+400-4FF".into()));
        assert_eq!(descriptor("font-weight", "heavy"), None);
        assert_eq!(descriptor("no-such", "x"), None);
        assert_eq!(descriptor("font-weight", " AUTO/**/"), Some("auto".into()));
        assert_eq!(descriptor("font-weight", "\u{a0}auto"), None);
        assert_eq!(descriptor("font-display", "auto"), Some("auto".into()));
    }

    fn face(family: &str, weight: (f64, f64), slanted: bool) -> FaceRecord {
        FaceRecord { weight, slanted, ..FaceRecord::of(family.to_owned()) }
    }

    #[test]
    fn picks_by_style_then_weight() {
        let faces = [face("a", (400.0, 400.0), false), face("a", (700.0, 700.0), false), face("a", (400.0, 400.0), true), face("b", (300.0, 300.0), false)];
        assert_eq!(pick(&faces, "A, b", "", false), vec![0]);
        assert_eq!(pick(&faces, "\"A\"", "bold", false), vec![1]);
        assert_eq!(pick(&faces, "a", "italic", false), vec![2]);
        assert_eq!(pick(&faces, "x, B", "bold", false), vec![3]);
        assert_eq!(pick(&faces, "a, b", "", true), vec![0, 1, 2, 3]);
        assert!(pick(&faces, "serif", "", false).is_empty());
    }

    #[test]
    fn parses_descriptors() {
        let f = parse(
            "font-family: \"My Face\"; src: url(a.eot) format('embedded-opentype'), local(Foo), url(b.woff2) format('woff2'); \
             font-weight: 300 600; font-style: oblique 10deg; unicode-range: U+41-5A; size-adjust: 150%; ascent-override: 90%",
            "https://example.com/css/x.css",
        )
        .unwrap();
        assert_eq!(f.family, "my face");
        assert_eq!(f.sources, vec![FaceSource::Local("Foo".to_owned()), FaceSource::Url("https://example.com/css/b.woff2".to_owned())]);
        assert_eq!(f.weight, (300.0, 600.0));
        assert!(f.slanted);
        assert_eq!(f.ranges, Some(vec![(0x41, 0x5a)]));
        assert_eq!(f.size_adjust, 1.5);
        assert_eq!(f.overrides[0], Some(0.9));
        assert_eq!(f.overrides[1], None);
    }
}
