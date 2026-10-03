// What `getComputedStyle` reports: a property's RESOLVED value (CSSOM §9). For most properties that is the computed
// value the style engine serializes; for the ones whose resolved value is a USED value it is the box the last layout
// placed — a size, a margin, a padding, an inset, in px — and an origin resolves against that box's border box, and
// `transform` is the matrix the function list comes to on it. A shorthand of any of those is its longhands' resolved
// values, serialized as the shorthand. One geometry: `getComputedStyle(el).width` and `getBoundingClientRect()` are two
// views of the same box.

use crate::dom::{NodeId, RealmArena};
use crate::geometry::{box_style, inline_by_display, is_boxless, placed_box, used_value};
use crate::style::StyleEngine;
use style::properties::{ComputedValues, LonghandId, PropertyDeclarationId, PropertyId, ShorthandId};

// What a read answers: the value, none at all (no style, no such property, a used value that cannot be told), or that
// the property's resolved value is layout's and the layout has to be brought up to date first.
pub(crate) enum Resolved {
    Value(String),
    None,
    NeedsLayout,
}

// The longhands whose resolved value layout gives: the box's size, margins, padding, borders and insets, in either
// spelling, the origins, and `transform`.
fn layouts(longhand: LonghandId) -> bool {
    use LonghandId::*;
    used(longhand)
        || matches!(
            longhand,
            TransformOrigin | PerspectiveOrigin | Transform | BorderBlockStartWidth | BorderBlockEndWidth | BorderInlineStartWidth | BorderInlineEndWidth
        )
}
// …of which these are the box's own used figures (geometry.rs `used_value`).
fn used(longhand: LonghandId) -> bool {
    use LonghandId::*;
    matches!(
        longhand,
        Width | Height | InlineSize | BlockSize
            | PaddingTop | PaddingRight | PaddingBottom | PaddingLeft
            | PaddingBlockStart | PaddingBlockEnd | PaddingInlineStart | PaddingInlineEnd
            | BorderTopWidth | BorderRightWidth | BorderBottomWidth | BorderLeftWidth
            | MarginTop | MarginRight | MarginBottom | MarginLeft
            | MarginBlockStart | MarginBlockEnd | MarginInlineStart | MarginInlineEnd
            | Top | Right | Bottom | Left
            | InsetBlockStart | InsetBlockEnd | InsetInlineStart | InsetInlineEnd
    )
}
// …and those whose COMPUTED value, where no used one stands, is reported in px where it is a length — and, for a box
// that has one, not as a percentage or a keyword it computes to (the used value it owes cannot be told then).
fn px_reportable(longhand: LonghandId) -> bool {
    use LonghandId::*;
    sized(longhand)
        || matches!(
            longhand,
            Width | Height | InlineSize | BlockSize
                | Top | Right | Bottom | Left | InsetBlockStart | InsetBlockEnd | InsetInlineStart | InsetInlineEnd
                | MarginTop | MarginRight | MarginBottom | MarginLeft
                | MarginBlockStart | MarginBlockEnd | MarginInlineStart | MarginInlineEnd
                | PaddingTop | PaddingRight | PaddingBottom | PaddingLeft
                | PaddingBlockStart | PaddingBlockEnd | PaddingInlineStart | PaddingInlineEnd
        )
}
// The ones whose keywords and percentages ARE their resolved value, box or not: `max-width: none` is `none` in Chrome
// whether the element is rendered or not — and the insets, whose used value layout answers for every positioned box,
// so that one reaching the computed value belongs to a static box, where the computed value is the resolved one.
fn keyword_resolves(longhand: LonghandId) -> bool {
    sized(longhand) || inset(longhand)
}
fn inset(longhand: LonghandId) -> bool {
    use LonghandId::*;
    matches!(longhand, Top | Right | Bottom | Left | InsetBlockStart | InsetBlockEnd | InsetInlineStart | InsetInlineEnd)
}
fn sized(longhand: LonghandId) -> bool {
    use LonghandId::*;
    matches!(longhand, MinWidth | MinHeight | MaxWidth | MaxHeight | MinInlineSize | MinBlockSize | MaxInlineSize | MaxBlockSize)
}

// The resolved value of `name` on `id` — or on its `pseudo`-element — as `getComputedStyle` reports it. `laid_out` says
// the layout is up to date; where it is not and the property is one layout answers, the answer is to lay it out first.
pub(crate) fn resolved_value(engine: &mut StyleEngine, arena: &RealmArena, id: NodeId, pseudo: Option<&str>, name: &str, laid_out: bool, now: f64) -> Resolved {
    let Ok(property) = PropertyId::parse_enabled_for_all_content(name) else { return Resolved::None };
    let layout_bound = match property.as_shorthand() {
        Ok(shorthand) => shorthand.longhands().any(layouts),
        Err(PropertyDeclarationId::Longhand(longhand)) => layouts(longhand),
        Err(_) => false,
    };
    if !layout_bound {
        return engine.value(arena, id, name, pseudo, now).map_or(Resolved::None, Resolved::Value);
    }
    let Some(style) = engine.computed_style(arena, id, pseudo, now) else { return Resolved::None };
    // (…a STATIC box's insets are their computed values, told with nothing laid out: on a page nothing has laid out
    // yet, reading `top` would otherwise lay the whole of it out to answer with the value it started from)
    let static_insets = style.get_box().clone_position() == style::computed_values::position::T::Static
        && match property.as_shorthand() {
            Ok(shorthand) => shorthand.longhands().all(inset),
            Err(PropertyDeclarationId::Longhand(longhand)) => inset(longhand),
            Err(_) => false,
        };
    if !laid_out && !static_insets {
        return Resolved::NeedsLayout;
    }
    let reader = Reader { engine, arena, id, style: &style, boxed: box_of(arena, id, pseudo) };
    let value = match property.as_shorthand() {
        Ok(shorthand) => reader.shorthand(shorthand),
        Err(PropertyDeclarationId::Longhand(longhand)) => reader.longhand(longhand),
        Err(_) => None,
    };
    value.map_or(Resolved::None, Resolved::Value)
}

// The node whose box a read measures: the element's, or the one its `::before` / `::after` generates (none for another
// pseudo-element, which no box holds).
fn box_of(arena: &RealmArena, id: NodeId, pseudo: Option<&str>) -> Option<NodeId> {
    match pseudo.map(str::to_ascii_lowercase).as_deref() {
        None => Some(id),
        Some("before") => arena.get(id)?.pseudo_boxes[0],
        Some("after") => arena.get(id)?.pseudo_boxes[1],
        Some(_) => None,
    }
}

struct Reader<'a> {
    engine: &'a StyleEngine,
    arena: &'a RealmArena,
    id: NodeId,
    style: &'a ComputedValues,
    boxed: Option<NodeId>,
}

impl Reader<'_> {
    // A shorthand: its longhands' resolved values, serialized as the shorthand — none where any has none.
    fn shorthand(&self, shorthand: ShorthandId) -> Option<String> {
        self.engine.serialize_shorthand(shorthand, |longhand| self.longhand(longhand).filter(|v| !v.is_empty()))
    }

    fn longhand(&self, longhand: LonghandId) -> Option<String> {
        let computed = self.engine.longhand_value(self.arena, self.id, self.style, PropertyDeclarationId::Longhand(longhand));
        if !layouts(longhand) {
            return Some(computed);
        }
        match longhand {
            LonghandId::TransformOrigin | LonghandId::PerspectiveOrigin => return Some(self.origin(longhand, computed)),
            LonghandId::Transform => return Some(self.transform(computed)),
            _ => {}
        }
        if used(longhand) && !self.skips_used(longhand) {
            if let Some(px) = self.boxed.and_then(|b| used_value(self.arena, b, longhand.name())) {
                return Some(px_text(px));
            }
        }
        if px_reportable(longhand) {
            return self.unused(longhand, computed);
        }
        Some(computed)
    }

    // Does the box owe no used value of `longhand`? A non-replaced INLINE box has no used width or height — they do
    // not apply to it — and a `display: contents` element no box at all: both report the computed value, as a browser
    // does (`display: inline; width: 10em` is `160px`). An inline box's margins and padding do apply, and are used.
    fn skips_used(&self, longhand: LonghandId) -> bool {
        use LonghandId::*;
        if !matches!(longhand, Width | Height | InlineSize | BlockSize) {
            return false;
        }
        let Some(b) = self.boxed else { return true };
        let Some(style) = box_style(self.arena, b) else { return true };
        is_boxless(self.arena, b, &style) || inline_by_display(self.arena, b, &style)
    }

    // Whether the box has a used size at all: a rendered one does, which owes a used value where a property applies.
    fn has_used_box(&self) -> bool {
        self.boxed.is_some_and(|b| used_value(self.arena, b, "width").is_some())
    }

    // A size, margin, padding or inset with no used value: its computed value where that is a length (`max-width:
    // 30em` is `480px` with or without a box) — and where it is a percentage, a keyword or a math function of one, that
    // value only for an element with NO box, or one the property has no used value for; a rendered box owes the used
    // value, which cannot be told, and reads as none.
    fn unused(&self, longhand: LonghandId, computed: String) -> Option<String> {
        let text = decimal_px(computed.trim());
        if is_px(&text) {
            return Some(text);
        }
        if text.parse::<f64>().is_ok_and(|n| n == 0.0) {
            return Some("0px".to_owned());
        }
        let keyword = matches!(text.to_ascii_lowercase().as_str(), "auto" | "none" | "min-content" | "max-content" | "fit-content");
        let percentage = text.strip_suffix('%').is_some_and(|n| n.parse::<f64>().is_ok());
        if keyword || percentage {
            let owes = !keyword_resolves(longhand) && !self.skips_used(longhand) && self.has_used_box();
            return (!owes).then(|| text.to_ascii_lowercase());
        }
        if !text.contains('(') {
            return None;
        }
        let owes = !keyword_resolves(longhand) && self.has_used_box();
        (!owes).then_some(text)
    }

    // A `<position>`-valued origin as the px its offsets land on against the element's BORDER box (Chrome:
    // `transform-origin: center` on a 100x20 box is `50px 10px`, with `padding: 10px; border: 5px` `65px 25px`), a zero
    // z not reported. A non-replaced inline box, which `transform` does not apply to, resolves against nothing — `0px
    // 0px` in Chrome — and an SVG element other than the root, whose reference box (`transform-box`) is not modelled,
    // reports its computed offsets; so does an element with no box to resolve a percentage against.
    fn origin(&self, longhand: LonghandId, computed: String) -> String {
        use style::values::computed::LengthPercentage;
        let (x, y, z): (&LengthPercentage, &LengthPercentage, f64) = match longhand {
            LonghandId::TransformOrigin => {
                let o = &self.style.get_box().transform_origin;
                (&o.horizontal, &o.vertical, f64::from(o.depth.px()))
            }
            _ => {
                let o = &self.style.get_box().perspective_origin;
                (&o.horizontal, &o.vertical, 0.0)
            }
        };
        let basis = self.origin_box();
        let resolve = |lp: &LengthPercentage, extent: Option<f64>| match extent {
            Some(e) => Some(f64::from(lp.resolve(style::values::computed::Length::new(e as f32)).px())),
            None => (!lp.has_percentage()).then(|| f64::from(lp.resolve(style::values::computed::Length::new(0.0)).px())),
        };
        let (Some(px), Some(py)) = (resolve(x, basis.map(|b| b[0])), resolve(y, basis.map(|b| b[1]))) else {
            // (…a zero z dropped, as a resolved one is: the computed `50% 50% 0px` reads `50% 50%`)
            return computed.strip_suffix(" 0px").map_or(computed.clone(), str::to_owned);
        };
        let mut out = format!("{} {}", px_text(px), px_text(py));
        if z != 0.0 {
            out = format!("{out} {}", px_text(z));
        }
        out
    }
    // The box an origin resolves against, `[width, height]`: the border box, a non-replaced inline's none, an SVG
    // element's (but the root's) none that is modelled.
    fn origin_box(&self) -> Option<[f64; 2]> {
        let b = self.boxed?;
        let node = self.arena.get(b)?;
        if node.ns == web_atoms::ns!(svg) && &*node.local_name != "svg" {
            return None;
        }
        let style = box_style(self.arena, b)?;
        if inline_by_display(self.arena, b, &style) {
            return Some([0.0, 0.0]);
        }
        let [_, _, w, h] = placed_box(self.arena, b)?;
        Some([w, h])
    }

    // `transform` as the matrix its function list composes to on the element's border box, written the way a browser
    // writes one (`matrix()`, or `matrix3d()` for a 3D one) — `none` for none, and the computed list itself where a
    // percentage in it has no box to resolve against.
    fn transform(&self, computed: String) -> String {
        let transform = &self.style.get_box().transform;
        if transform.0.is_empty() {
            return "none".to_owned();
        }
        let [w, h] = if computed.contains('%') {
            match self.boxed.and_then(|b| placed_box(self.arena, b)) {
                Some([_, _, w, h]) => [w, h],
                None => return computed,
            }
        } else {
            [0.0, 0.0]
        };
        use style::values::computed::Length;
        let reference = euclid::default::Rect::new(euclid::default::Point2D::origin(), euclid::default::Size2D::new(Length::new(w as f32), Length::new(h as f32)));
        match transform.to_transform_3d_matrix_f64(Some(&reference)) {
            Ok((m, _)) => serialize_matrix(&m.to_array()),
            Err(_) => computed,
        }
    }
}

// A px figure as a resolved value writes it: four decimal places at most, no trailing zeros (`10.5px`, `0.3333px`) —
// and as a number prints in script past 1e21, in exponent form (an infinite `calc()` clamped to the largest f32 is
// `3.4028234663852886e+38px`).
fn px_text(px: f64) -> String {
    let rounded = if px.abs() < 1e21 { (px * 10_000.0).round() / 10_000.0 } else { px };
    if rounded == 0.0 {
        return "0px".to_owned();
    }
    if rounded.abs() < 1e21 {
        return format!("{rounded}px");
    }
    let sci = format!("{rounded:e}");
    let (mantissa, exponent) = sci.split_once('e').unwrap_or((&sci, "0"));
    format!("{mantissa}e{}{exponent}px", if exponent.starts_with('-') { "" } else { "+" })
}
fn is_px(text: &str) -> bool {
    text.strip_suffix("px").is_some_and(|n| !n.is_empty() && !n.contains(['e', 'E']) && n.parse::<f64>().is_ok())
}
// A px length written with an exponent (`1e-9px`) in the decimal form a browser reports (`0.000000001px`); anything
// else as it is.
fn decimal_px(text: &str) -> String {
    let Some(n) = text.strip_suffix("px").filter(|n| n.contains(['e', 'E'])).and_then(|n| n.parse::<f64>().ok()) else {
        return text.to_owned();
    };
    if n.abs() < 1.0 {
        let fixed = format!("{n:.20}");
        let fixed = fixed.trim_end_matches('0').trim_end_matches('.');
        format!("{fixed}px")
    } else {
        format!("{}px", n.round() as i128)
    }
}

// A 4x4 (CSS `matrix3d()` order) as `getComputedStyle` writes it: `matrix(a, b, c, d, e, f)` where it is a 2D affine —
// decided on the components ROUNDED, so a `rotateX(90deg) rotateX(-90deg)` whose off-axis terms are 1e-17 reads
// `matrix(1, 0, 0, 1, 0, 0)`, as Chrome's does — else `matrix3d()` of all sixteen.
pub(crate) fn serialize_matrix(m: &[f64; 16]) -> String {
    let r = m.map(round_component);
    let two_d = r[2] == 0.0 && r[3] == 0.0 && r[6] == 0.0 && r[7] == 0.0 && r[8] == 0.0 && r[9] == 0.0 && r[11] == 0.0 && r[14] == 0.0 && r[10] == 1.0 && r[15] == 1.0;
    let text = r.map(format_component);
    if two_d {
        format!("matrix({}, {}, {}, {}, {}, {})", text[0], text[1], text[4], text[5], text[12], text[13])
    } else {
        format!("matrix3d({})", text.join(", "))
    }
}
// Six SIGNIFICANT digits, which is what a browser reports (`Math.sqrt(2)` is `1.41421`); floating-point noise below
// 1e-6 is zero (`cos(90deg)` prints `0`).
fn round_component(n: f64) -> f64 {
    if !n.is_finite() || n.abs() < 1e-6 {
        return 0.0;
    }
    let r: f64 = format!("{n:.5e}").parse().unwrap_or(0.0);
    if r == 0.0 { 0.0 } else { r }
}
// …printed as a browser prints it: in EXPONENTIAL form once the decimal exponent leaves [-4, 6) — `perspective(20000px)`
// reports `-5e-05` — its exponent signed and at least two digits, as `%g` writes it.
fn format_component(r: f64) -> String {
    if r == 0.0 {
        return "0".to_owned();
    }
    let exp = r.abs().log10().floor() as i32;
    if (-4..6).contains(&exp) {
        return format!("{r}");
    }
    let sci = format!("{r:.5e}");
    let (mantissa, exponent) = sci.split_once('e').unwrap_or((&sci, "0"));
    let mantissa = if mantissa.contains('.') { mantissa.trim_end_matches('0').trim_end_matches('.') } else { mantissa };
    let (sign, digits) = match exponent.strip_prefix('-') {
        Some(d) => ('-', d),
        None => ('+', exponent),
    };
    format!("{mantissa}e{sign}{digits:0>2}")
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "resolvedValue", resolved_value_op, context_id);
}

// __dom.resolvedValue(nid, pseudo, name, laidOut, now) -> the resolved value (`resolved_value`): a string; null where
// the layout has to be brought up to date first; undefined where there is none, or the realm has no engine.
fn resolved_value_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let pseudo = (!args.get(1).is_null_or_undefined()).then(|| args.get(1).to_rust_string_lossy(scope));
    let name = args.get(2).to_rust_string_lossy(scope);
    let laid_out = args.get(3).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    let now = crate::dom::clock_arg(scope, &args, 4);
    let mut answer = None;
    crate::dom::style_op(scope, cid, |scope| {
        let d = crate::dom::dom(scope);
        let (Some(engine), Some(arena)) = (d.styles.get_mut(&cid), d.realms.get(&cid)) else { return };
        let out = resolved_value(engine, arena, id, pseudo.as_deref(), &name, laid_out, now);
        let failures = engine.take_verify_failures();
        if !crate::dom::threw_verify_failures(scope, failures) {
            answer = Some(out);
        }
    });
    match answer {
        Some(Resolved::Value(v)) => {
            if let Some(s) = v8::String::new(scope, &v) {
                rv.set(s.into());
            }
        }
        Some(Resolved::NeedsLayout) => rv.set_null(),
        Some(Resolved::None) | None => {}
    }
}
