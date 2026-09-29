// HTML's presentational hints (§15 Rendering): the declarations an element's own attributes contribute to the
// cascade, at the origin just below the author's — `<td bgcolor>`, `<img width>`, `<font color>`, `<br clear>`. Each
// is written here as CSS text in the attribute's own terms (the HTML microsyntaxes below parse it), which the style
// engine parses into the element's hint block. The mappings a selector can state alone (`ol[type=a s]`, `[dir]`,
// `table[rules]`) are rules of the user-agent sheet instead.

use std::fmt::Write;

use web_atoms::ns;

use crate::dom::{NodeData, NodeId, RealmArena};

// `id`'s hints that its own attributes decide, appended to `out` as declarations. `input_image` says whether it is an
// `<input type=image>` (the one input that is embedded content).
pub(crate) fn own_hints(node: &NodeData, out: &mut String) {
    if !node.is_html() {
        return;
    }
    let attr = |name: &str| node.plain_attr(name);
    let tag: &str = &node.local_name;
    let input_image = tag == "input" && attr("type").is_some_and(|t| t.eq_ignore_ascii_case("image"));
    let mut decl = |prop: &str, value: &str| {
        let _ = write!(out, "{prop}: {value};");
    };

    // §15.3.2 The page: `<body>`'s margins, colours and background.
    if tag == "body" {
        for (props, attrs) in [
            (["margin-top", "margin-bottom"], ["marginheight", "topmargin"]),
            (["margin-left", "margin-right"], ["marginwidth", "leftmargin"]),
        ] {
            if let Some(px) = attrs.iter().find_map(|a| attr(a)).and_then(pixel_length) {
                for p in props {
                    decl(p, &px);
                }
            }
        }
        if let Some(c) = attr("text").and_then(legacy_color) {
            decl("color", &c);
        }
    }

    // `bgcolor` and `background`, on the page and the table family.
    if matches!(tag, "body" | "table" | "thead" | "tbody" | "tfoot" | "tr" | "td" | "th" | "marquee") {
        if let Some(c) = attr("bgcolor").and_then(legacy_color) {
            decl("background-color", &c);
        }
    }
    if matches!(tag, "body" | "table" | "thead" | "tbody" | "tfoot" | "tr" | "td" | "th") {
        if let Some(url) = attr("background").filter(|u| !u.trim().is_empty()) {
            decl("background-image", &format!("url({})", css_string(url.trim())));
        }
    }

    // §15.3.3 Flow content: `align` on a block is its text alignment.
    if matches!(tag, "div" | "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "caption") {
        if let Some(a) = attr("align") {
            match a.to_ascii_lowercase().as_str() {
                "left" => decl("text-align", "left"),
                "right" => decl("text-align", "right"),
                "center" | "middle" => decl("text-align", "center"),
                "justify" => decl("text-align", "justify"),
                "top" | "bottom" if tag == "caption" => decl("caption-side", &a.to_ascii_lowercase()),
                _ => {}
            }
        }
    }

    // `<br clear>` — an attribute selector's whole value, ASCII case-folded.
    if tag == "br" {
        if let Some(c) = attr("clear") {
            match c.to_ascii_lowercase().as_str() {
                "left" => decl("clear", "left"),
                "right" => decl("clear", "right"),
                "all" | "both" => decl("clear", "both"),
                "none" => decl("clear", "none"),
                _ => {}
            }
        }
    }

    // `<font>`.
    if tag == "font" {
        if let Some(c) = attr("color").and_then(legacy_color) {
            decl("color", &c);
        }
        if let Some(face) = attr("face") {
            decl("font-family", face);
        }
        if let Some(size) = attr("size").and_then(legacy_font_size) {
            decl("font-size", size);
        }
    }

    // §15.3.8 Tables.
    if tag == "table" {
        if let Some(px) = attr("cellspacing").and_then(pixel_length) {
            decl("border-spacing", &px);
        }
        if let Some(b) = attr("border") {
            // Absent or zero draws no frame; present but no number draws a 1px one.
            let px = pixel_length(b).unwrap_or_else(|| "1px".into());
            if px != "0px" {
                decl("border-width", &px);
                decl("border-style", "outset");
            }
        }
        if let Some(c) = attr("bordercolor").and_then(legacy_color) {
            decl("border-color", &c);
        }
        match attr("align").map(str::to_ascii_lowercase).as_deref() {
            Some("left") => decl("float", "left"),
            Some("right") => decl("float", "right"),
            Some("center") => {
                decl("margin-inline-start", "auto");
                decl("margin-inline-end", "auto");
            }
            _ => {}
        }
    }
    if matches!(tag, "td" | "th" | "tr" | "thead" | "tbody" | "tfoot") {
        if let Some(a) = attr("align") {
            match a.to_ascii_lowercase().as_str() {
                "left" => decl("text-align", "left"),
                "right" => decl("text-align", "right"),
                "center" | "middle" => decl("text-align", "center"),
                "justify" => decl("text-align", "justify"),
                _ => {}
            }
        }
    }
    if matches!(tag, "td" | "th" | "tr" | "thead" | "tbody" | "tfoot" | "col" | "colgroup") {
        if let Some(v) = attr("valign") {
            match v.to_ascii_lowercase().as_str() {
                "top" => decl("vertical-align", "top"),
                "middle" | "center" => decl("vertical-align", "middle"),
                "bottom" => decl("vertical-align", "bottom"),
                "baseline" => decl("vertical-align", "baseline"),
                _ => {}
            }
        }
    }
    if matches!(tag, "td" | "th") && attr("nowrap").is_some() {
        decl("white-space", "nowrap");
    }

    // §15.4 and the table family: the "maps to the dimension property" attributes. `(width, height)` says which of
    // the two an element maps and whether a parsed zero counts ("ignoring zero": it does not).
    let dims: Option<(Option<bool>, Option<bool>)> = match tag {
        "iframe" | "video" | "img" | "object" | "embed" | "marquee" => Some((Some(true), Some(true))),
        "input" if input_image => Some((Some(true), Some(true))),
        "td" | "th" => Some((Some(false), Some(false))),
        "table" => Some((Some(false), Some(true))),
        "col" => Some((Some(true), Some(true))),
        "colgroup" | "hr" => Some((Some(true), None)),
        "tr" | "thead" | "tbody" | "tfoot" => Some((None, Some(true))),
        _ => None,
    };
    if let Some((w, h)) = dims {
        for (prop, zero_ok) in [("width", w), ("height", h)] {
            if let Some(zero_ok) = zero_ok {
                if let Some(v) = attr(prop).and_then(|v| dimension(v, zero_ok)) {
                    decl(prop, &v);
                }
            }
        }
    }
    if matches!(tag, "img" | "object" | "embed" | "marquee") || input_image {
        if let Some(v) = attr("hspace").and_then(|v| dimension(v, true)) {
            decl("margin-left", &v);
            decl("margin-right", &v);
        }
        if let Some(v) = attr("vspace").and_then(|v| dimension(v, true)) {
            decl("margin-top", &v);
            decl("margin-bottom", &v);
        }
    }
    // `border` on an image draws a solid border of that many pixels — a value that is no length draws a 0px one.
    if matches!(tag, "img" | "object") || input_image {
        if let Some(b) = attr("border") {
            decl("border-width", &pixel_length(b).unwrap_or_else(|| "0px".into()));
            decl("border-style", "solid");
        }
    }
    // `align` on embedded content: `left` / `right` float it, the rest are its vertical alignment.
    if matches!(tag, "embed" | "iframe" | "img" | "object") || input_image {
        if let Some(a) = attr("align") {
            match a.to_ascii_lowercase().as_str() {
                "left" => decl("float", "left"),
                "right" => decl("float", "right"),
                "top" => decl("vertical-align", "top"),
                "middle" | "center" => decl("vertical-align", "-moz-middle-with-baseline"),
                "baseline" | "bottom" => decl("vertical-align", "baseline"),
                "texttop" => decl("vertical-align", "text-top"),
                "absmiddle" | "abscenter" => decl("vertical-align", "middle"),
                "absbottom" => decl("vertical-align", "bottom"),
                _ => {}
            }
        }
    }
    // …and the width / height pair is its natural aspect ratio (§15.4.1 "maps to the aspect-ratio property").
    if matches!(tag, "img" | "video" | "canvas") || input_image {
        let pair = (attr("width").and_then(number_dimension), attr("height").and_then(number_dimension));
        if let (Some(w), Some(h)) = pair {
            decl("aspect-ratio", &format!("auto {w} / {h}"));
        }
    }
    if tag == "iframe" && attr("frameborder").is_some_and(|f| f == "0" || f.eq_ignore_ascii_case("no")) {
        decl("border", "none");
    }

    // `<hr>`: `align` places it, `color` / `noshade` make it a solid block, `size` is its thickness.
    if tag == "hr" {
        match attr("align").map(str::to_ascii_lowercase).as_deref() {
            Some("left") => {
                decl("margin-left", "0");
                decl("margin-right", "auto");
            }
            Some("right") => {
                decl("margin-left", "auto");
                decl("margin-right", "0");
            }
            Some("center") => {
                decl("margin-left", "auto");
                decl("margin-right", "auto");
            }
            _ => {}
        }
        let size = attr("size").and_then(integer).filter(|&s| s > 0);
        let color = attr("color").and_then(legacy_color);
        if color.is_some() || attr("noshade").is_some() {
            decl("border-style", "solid");
            if let Some(c) = &color {
                decl("border-color", c);
                decl("background-color", c);
            }
            if let Some(s) = size {
                decl("border-width", &format!("{}px", s as f64 / 2.0));
            }
        } else if let Some(s) = size {
            if s == 1 {
                decl("border-bottom-width", "0");
            } else {
                decl("box-sizing", "border-box");
                decl("height", &format!("{s}px"));
            }
        }
    }

    // Lists: an `<li value>` sets its number, an `<ol start>` the first one.
    if tag == "li" {
        if let Some(n) = attr("value").and_then(integer) {
            decl("counter-set", &format!("list-item {n}"));
        }
    }
    // …and an `<ol reversed>` counts down, from `start` or else from its item count, which the counter finds itself.
    if tag == "ol" {
        let start = attr("start").and_then(integer);
        match (attr("reversed").is_some(), start) {
            (true, Some(n)) => decl("counter-reset", &format!("reversed(list-item) {}", n.saturating_add(1))),
            (true, None) => decl("counter-reset", "reversed(list-item)"),
            (false, Some(n)) => decl("counter-reset", &format!("list-item {}", n.saturating_sub(1))),
            (false, None) => {}
        }
    }
}

// The hints a table cell takes from its TABLE: `cellpadding` pads every cell of it.
pub(crate) fn cell_hints(arena: &RealmArena, id: NodeId, out: &mut String) {
    let Some(node) = arena.get(id) else { return };
    if !(node.is_html_named("td") || node.is_html_named("th")) {
        return;
    }
    let mut cur = arena.parent_of(id);
    while let Some(p) = cur {
        let Some(n) = arena.get(p) else { return };
        if n.ns != ns!(html) {
            return;
        }
        if &*n.local_name == "table" {
            if let Some(px) = n.plain_attr("cellpadding").and_then(pixel_length) {
                let _ = write!(out, "padding: {px};");
            }
            return;
        }
        if !matches!(&*n.local_name, "tr" | "thead" | "tbody" | "tfoot") {
            return;
        }
        cur = arena.parent_of(p);
    }
}

// HTML "rules for parsing integers": leading ASCII whitespace, an optional sign, digits; the rest is ignored.
fn integer(text: &str) -> Option<i32> {
    let t = text.trim_start_matches([' ', '\t', '\n', '\x0c', '\r']);
    let (neg, t) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let digits = t.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let n: i64 = t[..digits].parse().ok().filter(|&n: &i64| n <= i32::MAX as i64)?;
    Some(if neg { -n as i32 } else { n as i32 })
}

// "Maps to the pixel length property": a non-negative integer, in px (a `-0` is zero).
fn pixel_length(text: &str) -> Option<String> {
    let n = integer(text)?;
    (n >= 0 || text.trim_start().starts_with("-0")).then(|| format!("{}px", n.max(0)))
}

// "Rules for parsing dimension values": digits, an optional fraction, an optional `%`; the rest is ignored. With
// `zero_ok` false, a parsed zero is no value at all ("non-zero dimension values").
fn dimension(text: &str, zero_ok: bool) -> Option<String> {
    let (num, pct) = dimension_parts(text)?;
    if !zero_ok && num.parse::<f64>().ok()? == 0.0 {
        return None;
    }
    Some(format!("{num}{}", if pct { "%" } else { "px" }))
}

// A dimension value that is a number of pixels (not a percentage) — what an aspect ratio is made of.
fn number_dimension(text: &str) -> Option<String> {
    let (num, pct) = dimension_parts(text)?;
    (!pct).then_some(num)
}

fn dimension_parts(text: &str) -> Option<(String, bool)> {
    let t = text.trim_start_matches([' ', '\t', '\n', '\x0c', '\r']);
    let int = t.bytes().take_while(u8::is_ascii_digit).count();
    if int == 0 {
        return None;
    }
    let mut end = int;
    if t.as_bytes().get(end) == Some(&b'.') {
        end += 1 + t[end + 1..].bytes().take_while(u8::is_ascii_digit).count();
    }
    // As CSSOM serializes a number: no leading zeros, no trailing fraction zeros, no bare point.
    let raw = &t[..end];
    let mut num = raw.trim_start_matches('0').to_owned();
    if num.is_empty() || num.starts_with('.') {
        num.insert(0, '0');
    }
    if num.contains('.') {
        num = num.trim_end_matches('0').trim_end_matches('.').to_owned();
    }
    Some((num, t.as_bytes().get(end) == Some(&b'%')))
}

// "Rules for parsing a legacy colour value", as CSS.
fn legacy_color(text: &str) -> Option<String> {
    let c = style::servo::attr::parse_legacy_color(text).ok()?;
    Some(style_traits::ToCss::to_css_string(&c))
}

// "Rules for parsing a legacy font size": `size` 1-7, or relative to 3 with a sign.
fn legacy_font_size(text: &str) -> Option<&'static str> {
    let t = text.trim_start_matches([' ', '\t', '\n', '\x0c', '\r']);
    let (mode, t) = match t.as_bytes().first() {
        Some(b'+') => (1, &t[1..]),
        Some(b'-') => (-1, &t[1..]),
        _ => (0, t),
    };
    let digits = t.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let n: i64 = t[..digits].parse().unwrap_or(i64::MAX / 2);
    let value = match mode {
        1 => 3 + n,
        -1 => 3 - n,
        _ => n,
    };
    Some(match value.clamp(1, 7) {
        1 => "x-small",
        2 => "small",
        3 => "medium",
        4 => "large",
        5 => "x-large",
        6 => "xx-large",
        _ => "xxx-large",
    })
}

// `text` as a CSS string.
fn css_string(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            '\n' | '\r' | '\x0c' => {
                let _ = write!(out, "\\{:x} ", c as u32);
            }
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn microsyntaxes() {
        assert_eq!(integer("  +12abc"), Some(12));
        assert_eq!(integer("-3"), Some(-3));
        assert_eq!(integer("x1"), None);
        assert_eq!(integer("99999999999"), None);
        assert_eq!(pixel_length("200.7"), Some("200px".into()));
        assert_eq!(pixel_length("-5"), None);
        assert_eq!(pixel_length("-0"), Some("0px".into()));
        assert_eq!(dimension("00523.50%", true), Some("523.5%".into()));
        assert_eq!(dimension("200.", true), Some("200px".into()));
        assert_eq!(dimension("0", false), None);
        assert_eq!(dimension("0.0", true), Some("0px".into()));
        assert_eq!(dimension(".5", true), None);
        assert_eq!(legacy_font_size("+2"), Some("x-large"));
        assert_eq!(legacy_font_size("-9"), Some("x-small"));
        assert_eq!(legacy_font_size("9"), Some("xxx-large"));
    }
}
