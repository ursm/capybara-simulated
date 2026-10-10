// Intersection Observer's geometry (§3.2.8 "run the update intersection observations steps"): the root intersection
// rectangle — the viewport for a document root, a root element's padding box where it clips its content, else its
// border box, grown by the observer's margin — and each target's intersection with it, "computed" as the spec says:
// the target's bounding box clipped by every box up its containing-block chain that clips its overflow, up to the root
// (none where the root is an element the target is not under), then by the root's rectangle — edge-adjacent rectangles
// intersecting, with no area. The ratio of that area to the target's, and the threshold index it reaches. What the
// bindings keep — each target's previous index and state, the entries, the callbacks — they keep.

use crate::dom::{nid_arg, NodeId, RealmArena};

// A margin side: a length (px) or a percentage of the root rectangle's width (left, right) or height (top, bottom).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Margin {
    pub(crate) value: f64,
    pub(crate) percent: bool,
}

// One target's observation.
#[derive(Debug, PartialEq)]
pub(crate) struct Observation {
    pub(crate) target: Option<[f64; 4]>,
    pub(crate) intersection: Option<[f64; 4]>,
    pub(crate) ratio: f64,
    pub(crate) threshold_index: usize,
}

fn intersect(a: [f64; 4], b: [f64; 4]) -> Option<[f64; 4]> {
    let (x, y) = (a[0].max(b[0]), a[1].max(b[1]));
    let (right, bottom) = ((a[0] + a[2]).min(b[0] + b[2]), (a[1] + a[3]).min(b[1] + b[3]));
    (right >= x && bottom >= y).then_some([x, y, right - x, bottom - y])
}

// IntersectionObserver "parse a margin" (rootMargin / scrollMargin): one to four tokens separated by whitespace, CSS
// comments dropped — each a number with `px`, another absolute length unit (converted) or `%`, ASCII case-insensitive —
// mirrored top / right / bottom / left; none at all 0px. None for anything else (a SyntaxError).
pub(crate) fn parse_margin(text: &str) -> Option<[Margin; 4]> {
    let mut plain = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("/*") {
        plain.push_str(&rest[..at]);
        plain.push(' ');
        rest = rest[at + 2..].find("*/").map_or("", |end| &rest[at + 2 + end + 2..]);
    }
    plain.push_str(rest);
    let tokens: Vec<&str> = plain.split(|c| matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0C')).filter(|t| !t.is_empty()).collect();
    if tokens.len() > 4 {
        return None;
    }
    let side = |token: &str| -> Option<Margin> {
        let (value, unit) = split_number(token)?;
        let px_per = match unit.to_ascii_lowercase().as_str() {
            "%" => return Some(Margin { value, percent: true }),
            "px" => 1.0,
            "cm" => 96.0 / 2.54,
            "mm" => 96.0 / 25.4,
            "q" => 96.0 / 101.6,
            "in" => 96.0,
            "pt" => 4.0 / 3.0,
            "pc" => 16.0,
            _ => return None,
        };
        Some(Margin { value: value * px_per + 0.0, percent: false })
    };
    let sides: Vec<Margin> = if tokens.is_empty() { vec![Margin { value: 0.0, percent: false }] } else { tokens.into_iter().map(side).collect::<Option<_>>()? };
    let top = sides[0];
    let right = sides.get(1).copied().unwrap_or(top);
    let bottom = sides.get(2).copied().unwrap_or(top);
    let left = sides.get(3).copied().unwrap_or(right);
    Some([top, right, bottom, left])
}

// A token's leading number — a sign, digits with a fraction (or a fraction alone), an exponent where digits follow it —
// and the rest.
fn split_number(token: &str) -> Option<(f64, &str)> {
    let b = token.as_bytes();
    let digits = |mut i: usize| {
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        i
    };
    let mut i = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let whole = digits(i);
    let mut end = whole;
    if b.get(whole) == Some(&b'.') && digits(whole + 1) > whole + 1 {
        end = digits(whole + 1);
    } else if whole == i {
        return None;
    }
    i = end;
    if matches!(b.get(i), Some(b'e' | b'E')) {
        let j = i + 1 + usize::from(matches!(b.get(i + 1), Some(b'+' | b'-')));
        if digits(j) > j {
            end = digits(j);
        }
    }
    Some((token[..end].parse().ok()?, &token[end..]))
}

impl RealmArena {
    // The root intersection rectangle of `root` (None: the document's viewport) grown by `margin` — None where the root
    // element has no box.
    pub(crate) fn root_intersection_rect(&self, root: Option<NodeId>, margin: &[Margin; 4]) -> Option<[f64; 4]> {
        let base = match root {
            None => [0.0, 0.0, self.viewport[0], self.viewport[1]],
            Some(r) => {
                let clips = self.get(r).and_then(|n| crate::geometry::laid(self, n)).is_some_and(|b| b.clip != 0);
                if clips { crate::hit_test::clip_rect(self, r)? } else { crate::geometry::rendered_box(self, r)? }
            }
        };
        let side = |m: &Margin, basis: f64| if m.percent { m.value / 100.0 * basis } else { m.value };
        let [t, r, b, l] = [side(&margin[0], base[3]), side(&margin[1], base[2]), side(&margin[2], base[3]), side(&margin[3], base[2])];
        Some([base[0] - l, base[1] - t, base[2] + l + r, base[3] + t + b])
    }

    // One target's observation against `root_rect` (`root_intersection_rect`) of `root`, its thresholds ascending.
    pub(crate) fn observe_intersection(&self, target: NodeId, root: Option<NodeId>, root_rect: Option<[f64; 4]>, thresholds: &[f64]) -> Observation {
        let bounds = crate::geometry::rendered_box(self, target);
        let mut rect = bounds;
        let mut reached_root = root.is_none();
        if rect.is_some() {
            crate::hit_test::clipping_ancestors(self, target, |at, clip| {
                if Some(at) == root {
                    reached_root = true;
                    return false;
                }
                if clip != 0 {
                    rect = rect.zip(crate::hit_test::clip_rect(self, at)).and_then(|(r, c)| {
                        let (cx, cw) = if clip & crate::layout::CLIP_X != 0 { (c[0], c[2]) } else { (f64::NEG_INFINITY, f64::INFINITY) };
                        let (cy, ch) = if clip & crate::layout::CLIP_Y != 0 { (c[1], c[3]) } else { (f64::NEG_INFINITY, f64::INFINITY) };
                        intersect(r, [cx, cy, cw, ch])
                    });
                }
                rect.is_some()
            });
        }
        let intersection = if reached_root { rect.zip(root_rect).and_then(|(r, root)| intersect(r, root)) } else { None };
        let area = bounds.map_or(0.0, |b| b[2] * b[3]);
        let ratio = match intersection {
            Some(i) if area > 0.0 => i[2] * i[3] / area,
            Some(_) => 1.0,
            None => 0.0,
        };
        Observation { target: bounds, intersection, ratio, threshold_index: thresholds.iter().filter(|&&t| t <= ratio).count() }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "parseMargin", parse_margin_op, context_id);
    crate::dom::register(scope, ns, "observeIntersections", observe_intersections_op, context_id);
}

// __dom.parseMargin(text) -> [top, topPercent, right, …] (`parse_margin`: a side's value, and 1 for a percentage), or
// null for a margin that does not parse.
fn parse_margin_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    match parse_margin(&text) {
        Some(sides) => {
            let flat: Vec<f64> = sides.iter().flat_map(|m| [m.value, f64::from(u8::from(m.percent))]).collect();
            rv.set(crate::dom::f64_array(scope, &flat).into());
        }
        None => rv.set_null(),
    }
}

// __dom.observeIntersections(rootNid | -1, margin, thresholds, targetNid, …) -> Float64Array: the root rectangle (x, y,
// w, h — NaN for none), then for each target its bounding box, its intersection (NaN for none), the ratio and the
// threshold index — ten numbers each. `margin` as `parseMargin` gives it; `thresholds` ascending.
fn observe_intersections_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let root = nid_arg(scope, &args, 0);
    let numbers = |scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>| -> Vec<f64> {
        let Ok(list) = v8::Local::<v8::Object>::try_from(value) else { return Vec::new() };
        let len = list.get(scope, v8::String::new(scope, "length").unwrap().into()).and_then(|l| l.uint32_value(scope)).unwrap_or(0);
        (0..len).filter_map(|i| list.get_index(scope, i).and_then(|v| v.number_value(scope))).collect()
    };
    let flat = numbers(scope, args.get(1));
    let thresholds = numbers(scope, args.get(2));
    let targets: Vec<Option<NodeId>> = (3..args.length()).map(|i| nid_arg(scope, &args, i)).collect();
    let margin: [Margin; 4] = std::array::from_fn(|i| Margin { value: flat.get(i * 2).copied().unwrap_or(0.0), percent: flat.get(i * 2 + 1).is_some_and(|&p| p != 0.0) });
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let root_rect = arena.root_intersection_rect(root, &margin);
    let rect = |r: Option<[f64; 4]>| r.unwrap_or([f64::NAN; 4]);
    let mut out: Vec<f64> = rect(root_rect).to_vec();
    for target in targets {
        let o = match target {
            Some(t) => arena.observe_intersection(t, root, root_rect, &thresholds),
            None => Observation { target: None, intersection: None, ratio: 0.0, threshold_index: 0 },
        };
        out.extend(rect(o.target));
        out.extend(rect(o.intersection));
        out.push(o.ratio);
        out.push(o.threshold_index as f64);
    }
    rv.set(crate::dom::f64_array(scope, &out).into());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn margins() {
        let px = |value| Margin { value, percent: false };
        assert_eq!(parse_margin(""), Some([px(0.0); 4]));
        assert_eq!(parse_margin("10px /* c */ 5%"), Some([px(10.0), Margin { value: 5.0, percent: true }, px(10.0), Margin { value: 5.0, percent: true }]));
        assert_eq!(parse_margin("1in 0PX 2px 3px"), Some([px(96.0), px(0.0), px(2.0), px(3.0)]));
        assert_eq!(parse_margin("10"), None);
        assert_eq!(parse_margin("1px 1px 1px 1px 1px"), None);
        assert_eq!(parse_margin("1em"), None);
        assert_eq!(parse_margin("1e1px"), Some([px(10.0); 4]));
        assert_eq!(parse_margin(".5px"), Some([px(0.5); 4]));
        assert_eq!(parse_margin("5.px"), None);
        assert_eq!(intersect([0.0, 0.0, 10.0, 10.0], [10.0, 0.0, 5.0, 5.0]), Some([10.0, 0.0, 0.0, 5.0]));
        assert_eq!(intersect([0.0, 0.0, 10.0, 10.0], [11.0, 0.0, 5.0, 5.0]), None);
    }
}
