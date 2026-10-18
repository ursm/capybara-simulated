// Web Animations' "processing a keyframes argument" (§6.6.2) — from what the bindings READ of the page's argument, in
// the order the spec reads it (that order a page observes through its getters, so it is the bindings'): each offset,
// easing and composite validated — an offset null or in [0, 1], an easing an `<easing-function>` (easing.rs), a
// composite an operation or `auto` — a TypeError the first that is not; a declaration kept where it parses (a keyframe
// is a declaration, so `{ lineHeight: '-1' }` makes none); the offsets loosely sorted; the missing ones spaced evenly
// ("computing missing keyframe offsets"). A list of keyframes keeps each one it is written; a property-indexed keyframe
// spreads each property's list over the whole effect on its own and merges them by offset — none at all where no value
// animates. The keyframes keep what the page wrote (`Written`), which `getKeyframes()` reports.

use crate::animation_ops::Item;
use crate::numbers::to_js_string;

// A keyframe as processed: its computed offset, and what the page wrote.
pub(crate) struct Processed {
    pub(crate) computed: f64,
    pub(crate) written: Written,
}

// What the page wrote of a keyframe: its offset (None: spaced), its easing, canonical (None: the effect's), its composite
// (None: absent, as `auto`), and its declarations as written — under the property's CSS name, the value verbatim.
#[derive(Clone, Debug, Default)]
pub(crate) struct Written {
    pub(crate) offset: Option<f64>,
    pub(crate) easing: Option<String>,
    pub(crate) composite: Option<String>,
    pub(crate) declared: Vec<(String, String)>,
}

// Why the argument is no keyframes: a TypeError, of what it names.
pub(crate) enum Refusal {
    Offset(f64),
    Unsorted(f64),
    Easing(String),
    Composite(String),
}

impl Refusal {
    pub(crate) fn message(&self) -> String {
        match self {
            Refusal::Offset(o) => format!("Offsets must be null or a number in [0, 1]: {}", to_js_string(*o)),
            Refusal::Unsorted(o) => format!("Offsets must be monotonically non-decreasing: {}", to_js_string(*o)),
            Refusal::Easing(e) => format!("Invalid easing: {e}"),
            Refusal::Composite(c) => format!("Invalid composite operation: {c}"),
        }
    }
}

// The argument as the bindings read it: [0, count, then per keyframe: offset (a number, or nothing), easing (text, or
// nothing: absent), composite (likewise), declaration count, (property, value)…] for a list of keyframes; [1, then the
// offset list, the easing list and the composite list, each its count and its entries, then the property count and per
// property: its name, its value count, its values…] for a property-indexed one.
pub(crate) fn process(items: &[Item]) -> Result<Vec<Processed>, Refusal> {
    let mut at = Cursor { items, at: 1 };
    match items.first().and_then(Item::number) {
        Some(n) if n == 1.0 => property_indexed(&mut at),
        _ => listed(&mut at),
    }
}

struct Cursor<'a> {
    items: &'a [Item],
    at: usize,
}

impl Cursor<'_> {
    fn next(&mut self) -> Option<&Item> {
        let item = self.items.get(self.at);
        self.at += 1;
        item
    }
    fn count(&mut self) -> usize {
        self.next().and_then(Item::number).unwrap_or(0.0) as usize
    }
    fn offset(&mut self) -> Option<f64> {
        self.next().and_then(Item::number)
    }
    fn text(&mut self) -> Option<String> {
        self.next().and_then(Item::text).map(str::to_owned)
    }
}

fn offset(o: Option<f64>) -> Result<Option<f64>, Refusal> {
    match o {
        Some(n) if !(0.0..=1.0).contains(&n) => Err(Refusal::Offset(n)),
        o => Ok(o),
    }
}
fn easing(e: Option<String>) -> Result<Option<String>, Refusal> {
    e.map(|e| crate::easing::canonical(&e).ok_or(Refusal::Easing(e))).transpose()
}
fn composite(c: Option<String>) -> Result<Option<String>, Refusal> {
    match c {
        Some(c) if !matches!(c.as_str(), "replace" | "add" | "accumulate" | "auto") => Err(Refusal::Composite(c)),
        c => Ok(c),
    }
}
// (…a declaration, where it parses — a custom property's whatever its value)
fn declare(written: &mut Written, name: String, value: String) {
    if name.starts_with("--") || crate::cssom_decl::supports(&name, &value) {
        written.declared.push((name, value));
    }
}

fn listed(at: &mut Cursor<'_>) -> Result<Vec<Processed>, Refusal> {
    let mut frames = Vec::new();
    for _ in 0..at.count() {
        let o = offset(at.offset())?;
        let e = easing(at.text())?;
        let c = composite(at.text())?;
        let mut written = Written { offset: o, easing: e, composite: c, declared: Vec::new() };
        for _ in 0..at.count() {
            let (Some(name), Some(value)) = (at.text(), at.text()) else { continue };
            declare(&mut written, name, value);
        }
        // (…no computed offset until they are spaced)
        frames.push(Processed { computed: f64::NAN, written });
    }
    require_sorted(&frames)?;
    space(&mut frames);
    Ok(frames)
}

fn property_indexed(at: &mut Cursor<'_>) -> Result<Vec<Processed>, Refusal> {
    let offsets: Vec<Option<f64>> = (0..at.count()).map(|_| at.offset()).collect();
    let easings: Vec<Option<String>> = (0..at.count()).map(|_| at.text()).collect();
    let composites: Vec<Option<String>> = (0..at.count()).map(|_| at.text()).collect();
    // (…each property's values spread over the whole effect on its own: one value a to-keyframe, at 1)
    let mut pending = Vec::new();
    for _ in 0..at.count() {
        let name = at.text().unwrap_or_default();
        let values: Vec<String> = (0..at.count()).map(|_| at.text().unwrap_or_default()).collect();
        let last = values.len().saturating_sub(1).max(1) as f64;
        let single = values.len() == 1;
        for (i, value) in values.into_iter().enumerate() {
            pending.push((if single { 1.0 } else { i as f64 / last }, i, name.clone(), value));
        }
    }
    // (…every list entry validated, those no keyframe reaches included, once every property was read)
    let checked_offsets = offsets.iter().map(|&o| offset(o)).collect::<Result<Vec<_>, _>>()?;
    let checked_easings = easings.into_iter().map(easing).collect::<Result<Vec<_>, _>>()?;
    let checked_composites = composites.into_iter().map(composite).collect::<Result<Vec<_>, _>>()?;
    // (…a keyframe at each computed offset a value lands at, made with the list entries at the index of the first)
    let mut frames: Vec<Processed> = Vec::new();
    for (computed, index, name, value) in pending {
        let found = frames.iter().position(|f| f.computed == computed);
        let frame = match found {
            Some(f) => f,
            None => {
                let pick = |list: &Vec<Option<String>>| if list.is_empty() { None } else { list[index % list.len()].clone() };
                let written = Written {
                    offset: checked_offsets.get(index).copied().flatten(),
                    easing: pick(&checked_easings),
                    composite: pick(&checked_composites),
                    declared: Vec::new(),
                };
                frames.push(Processed { computed, written });
                frames.len() - 1
            }
        };
        declare(&mut frames[frame].written, name, value);
    }
    frames.sort_by(|a, b| a.computed.total_cmp(&b.computed));
    require_sorted(&frames)?;
    // (…and with no value that animates left anywhere, no keyframes — where a list keeps each one it is written)
    if frames.iter().all(|f| f.written.declared.is_empty()) {
        return Ok(Vec::new());
    }
    // (…an explicit offset list overriding the computed positions, in keyframe order — a null in it spaced, not 0)
    if !checked_offsets.is_empty() {
        for (frame, &o) in frames.iter_mut().zip(&checked_offsets) {
            if let Some(o) = o {
                frame.written.offset = Some(o);
                frame.computed = o;
            }
        }
        frames.sort_by(|a, b| a.computed.total_cmp(&b.computed));
        require_sorted(&frames)?;
        space(&mut frames);
    }
    Ok(frames)
}

// The offsets written loosely sorted: one that goes backwards is a TypeError, not a list a browser reorders.
fn require_sorted(frames: &[Processed]) -> Result<(), Refusal> {
    let mut previous = f64::NEG_INFINITY;
    for o in frames.iter().filter_map(|f| f.written.offset) {
        if o < previous {
            return Err(Refusal::Unsorted(o));
        }
        previous = o;
    }
    Ok(())
}

// The missing offsets spaced evenly between the ones written — the first 0 and the last 1 where they have none; a lone
// keyframe 1.
fn space(frames: &mut [Processed]) {
    let Some(last) = frames.len().checked_sub(1) else { return };
    if last == 0 {
        frames[0].computed = frames[0].written.offset.unwrap_or(1.0);
        return;
    }
    frames[0].computed = frames[0].written.offset.unwrap_or(0.0);
    frames[last].computed = frames[last].written.offset.unwrap_or(1.0);
    let mut anchor = 0;
    for i in 1..=last {
        if frames[i].written.offset.is_none() && i != last {
            continue;
        }
        // (…a keyframe with no computed offset yet takes the one it was written; a property-indexed one keeps where its
        // values put it)
        if frames[i].computed.is_nan() {
            frames[i].computed = frames[i].written.offset.unwrap_or(f64::NAN);
        }
        let (from, to) = (frames[anchor].computed, frames[i].computed);
        let span = (i - anchor) as f64;
        for j in anchor + 1..i {
            frames[j].computed = from + (to - from) * ((j - anchor) as f64 / span);
        }
        anchor = i;
    }
}

// The property a keyframe-like object's member `member` is a keyframe property of — its CSS name — or none, decided
// by the name alone (web-animations §Processing a keyframe-like object: a property that cannot be animated is no keyframe
// property, its getter never read). A member is an IDL attribute: a custom property its own name, `cssFloat` and
// `cssOffset` the renamed `float` and `offset`, a hyphenated name, `float` or `offset` none; an attribute names its
// property under its own camel-cased spelling, or an alias's where the alias is a legacy NAME (`gridColumnGap`,
// `wordWrap`: Chrome and Firefox take those) — not a vendor-prefixed one (`webkitTransform`, which Chrome ignores); and
// the property animates (a shorthand does where a longhand under it does).
pub(crate) fn keyframe_property(member: &str) -> Option<String> {
    use std::collections::HashMap;
    use std::sync::OnceLock;
    if member.starts_with("--") {
        return Some(member.to_owned());
    }
    // (…each attribute a page can write — a property's camel-cased name, an alias's that is no vendor's — and the
    // property it names, where it animates)
    static MEMBERS: OnceLock<HashMap<String, &'static str>> = OnceLock::new();
    let members = MEMBERS.get_or_init(|| {
        let mut members = HashMap::new();
        for p in crate::cssom_decl::properties() {
            let vendor = p.name != p.property && p.name.starts_with('-');
            if p.animatable && !vendor {
                members.insert(idl_attribute(p.name), p.property);
            }
        }
        // (…the two renamed: `float` a reserved word once, `offset` a keyframe's own member)
        members.remove("float");
        members.remove("offset");
        members.insert("cssFloat".to_owned(), "float");
        members.insert("cssOffset".to_owned(), "offset");
        members
    });
    members.get(member).map(|p| (*p).to_owned())
}
// CSSOM's "CSS property to IDL attribute": a `-` dropped and the letter after it uppercased.
fn idl_attribute(property: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in property.chars() {
        if c == '-' {
            upper = true;
        } else {
            out.push(if upper { c.to_ascii_uppercase() } else { c });
            upper = false;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_member_names_an_animatable_property() {
        assert_eq!(keyframe_property("blockSize").as_deref(), Some("block-size"));
        assert_eq!(keyframe_property("cssFloat").as_deref(), Some("float"));
        assert_eq!(keyframe_property("cssOffset").as_deref(), Some("offset"));
        assert_eq!(keyframe_property("--x").as_deref(), Some("--x"));
        assert_eq!(keyframe_property("gridColumnGap").as_deref(), Some("column-gap"));
        assert_eq!(keyframe_property("WebkitTransform").as_deref(), Some("-webkit-transform"));
        for none in ["float", "font-size", "Opacity", "webkitTransform", "WebkitTransformOrigin", "animationDelay", "writingMode", "offset"] {
            assert_eq!(keyframe_property(none), None, "{none}");
        }
    }
}
