// A 2D context's text (HTML §4.12.5.1.4, "the text preparation algorithm"): `measureText()` and `fillText()` /
// `strokeText()` under the context's drawing state (canvas_state.rs) — its font, kerning and capitals, its alignment,
// baseline and direction, its letter and word spacing — the line shaped and drawn by text.rs `line`, through the
// rasterizer (canvas.rs `draw`). The bindings answer what only they can: the face the font's family resolves to
// (font-metrics.js, which knows the document's `@font-face`s), the canvas element's inherited direction and the root's
// font size, each a style read.

use std::cell::RefCell;
use std::collections::HashMap;

use crate::canvas_state::{CanvasStateHandle, ALIGNS, KERNINGS};
use crate::text::{line, Baseline, Placement};

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "canvasMeasureText", canvas_measure_text, context_id);
    crate::dom::register(scope, ns, "canvasDrawText", canvas_draw_text, context_id);
}

// What a line of text is set with: the face (font.rs's handle, -1 for none) at `size` px, its kerning, its small
// capitals, its direction, the fraction of its advance `textAlign` puts left of the anchor, its baseline, and its letter
// and word spacing in px.
struct Setting {
    face: i32,
    size: f64,
    kerning: bool,
    small_caps: bool,
    rtl: bool,
    align: f64,
    baseline: Baseline,
    letter: f64,
    word: f64,
}

impl Setting {
    // The state's — `inherited_rtl` the canvas element's direction, which `direction: inherit` takes, `root_size` the
    // root's font size, which a `rem` spacing is of.
    fn of(h: &CanvasStateHandle, face: i32, inherited_rtl: bool, root_size: f64) -> Setting {
        let s = h.state();
        let rtl = match s.direction {
            0 => false,
            1 => true,
            _ => inherited_rtl,
        };
        // (…`start` and `end` the line's own edges: its right one, right-to-left, for `start`)
        let align = match (ALIGNS[s.align as usize], rtl) {
            ("center", _) => 0.5,
            ("right", _) | ("start", true) | ("end", false) => 1.0,
            _ => 0.0,
        };
        let spacing = |v: &str| if v == "0px" { 0.0 } else { crate::cssom_decl::canvas_spacing(v, s.font.px, root_size).map_or(0.0, |(_, px)| px) };
        Setting {
            face,
            size: s.font.px,
            kerning: KERNINGS[s.kerning as usize] != "none",
            small_caps: s.font.small_caps || s.variant_caps != 0,
            rtl,
            align,
            baseline: Baseline::from_index(i32::from(s.baseline)),
            letter: spacing(&s.letter_spacing),
            word: spacing(&s.word_spacing),
        }
    }
}

// The canvas text preparation's white space: each tab, line feed, form feed and carriage return a space — a canvas line
// is one line.
fn prepared(text: &str) -> String {
    text.replace(['\t', '\n', '\u{c}', '\r'], " ")
}

// A line's metrics, in user-space px, unspaced and from its start: `[advance, inkLeft, inkRight, inkAscent,
// inkDescent, ascent, descent, emAscent, emDescent, hangingBaseline, ideographicBaseline]` — a face native reads none of
// measured as an unknown font is (a 6px advance a character, 8 and 2 high); the baselines off the face's `BASE` table,
// else its vertical metrics, as Chrome derives them. Kept for the next measure of the same line: they depend on the face,
// size, kerning, capitals, direction and text alone.
type Metrics = [f64; 11];
type MetricsKey = (i32, u64, bool, bool, bool, String);
thread_local! {
    static MEASURED: RefCell<HashMap<MetricsKey, Metrics>> = RefCell::new(HashMap::new());
}
fn metrics(text: &str, s: &Setting) -> Metrics {
    let key = (s.face, s.size.to_bits(), s.kerning, s.small_caps, s.rtl, text.to_owned());
    if let Some(m) = MEASURED.with(|c| c.borrow().get(&key).copied()) {
        return m;
    }
    let measured = std::panic::catch_unwind(|| line(text, s.face, s.size, s.kerning, s.small_caps, s.rtl, None)).ok().flatten();
    let m = match measured {
        Some(l) => {
            let (hanging, ideographic) = l.baselines.unwrap_or((l.ascent * 0.8, -l.descent));
            [l.advance, l.ink[0], l.ink[1], l.ink[2], l.ink[3], l.ascent, l.descent, l.em.0, l.em.1, hanging, ideographic]
        }
        None => {
            let width = text.encode_utf16().count() as f64 * 6.0;
            [width, 0.0, width, 8.0, 2.0, 8.0, 2.0, s.size * 0.8, s.size * 0.2, 8.0 * 0.8, -2.0]
        }
    };
    MEASURED.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() > 4000 {
            c.clear();
        }
        c.insert(key, m);
    });
    m
}
// …and what letter and word spacing add to it: letter spacing after each character, word spacing at each space.
fn spacing_width(text: &str, s: &Setting) -> f64 {
    if s.letter == 0.0 && s.word == 0.0 {
        return 0.0;
    }
    let (chars, spaces) = text.chars().fold((0, 0), |(c, sp), ch| (c + 1, sp + usize::from(ch == ' ')));
    s.letter * chars as f64 + s.word * spaces as f64
}

// The state, the face, the inherited direction and the root's font size of an op's arguments from `at`: `state`, then
// `face`, `inheritedRtl`, `rootFontSize`.
fn setting_args(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, h: &CanvasStateHandle, at: i32) -> Setting {
    let face = args.get(at).int32_value(scope).unwrap_or(-1);
    let inherited_rtl = args.get(at + 1).is_true();
    let root_size = args.get(at + 2).number_value(scope).filter(|v| v.is_finite()).unwrap_or(16.0);
    Setting::of(h, face, inherited_rtl, root_size)
}
fn handle<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<&'h CanvasStateHandle> {
    // SAFETY: the handle lives while its object, the argument, does — through this op.
    crate::canvas_state::handle_of(scope, value).map(|p| unsafe { &*(p.as_ref() as *const CanvasStateHandle) })
}

// __dom.canvasMeasureText(state, text, face, inheritedRtl, rootFontSize) -> a TextMetrics' members, a Float64Array in
// the IDL's order — `width`, the actual bounding box's left, right, ascent and descent, the font bounding box's ascent
// and descent, the em height's, the hanging, alphabetic and ideographic baselines: the line's metrics, its advance
// widened by its spacing, and its bounding box measured from the anchor `textAlign` puts it at.
fn canvas_measure_text(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let text = prepared(&args.get(1).to_rust_string_lossy(scope));
    let s = setting_args(scope, &args, h, 2);
    let [advance, ink_left, ink_right, ink_ascent, ink_descent, ascent, descent, em_ascent, em_descent, hanging, ideographic] = metrics(&text, &s);
    let width = advance + spacing_width(&text, &s);
    let shift = width * s.align;
    let members = [
        width,
        -ink_left + shift,
        ink_right - shift,
        ink_ascent,
        ink_descent,
        ascent,
        descent,
        em_ascent,
        em_descent,
        hanging,
        0.0,
        ideographic,
    ];
    rv.set(crate::dom::f64_array(scope, &members).into());
}

// The draw of a text op: what it paints with and where.
struct TextDraw<'s> {
    bitmap: v8::Local<'s, v8::Value>,
    size: [f64; 2],
    p3: bool,
    paint: Vec<f64>,
    pixels: v8::Local<'s, v8::Value>,
}

// __dom.canvasDrawText(state, w, h, p3, text, x, y, maxWidth, paint, pixels, face, inheritedRtl, rootFontSize):
// `fillText()` / `strokeText()` on the context's `w` × `h` bitmap (`canvasBitmap`) — `paint` as `canvasDraw` takes it, the fill style's or the stroke
// style's — the line placed at (x, y) through the CTM by `textAlign` and `textBaseline`, condensed to `maxWidth` (one
// given that is not above 0 drawing nothing, undefined none), spaced a character at a time where letter or word spacing
// opens gaps a line's single mask has no room for.
fn canvas_draw_text(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(h) = handle(scope, args.get(0)) else { return };
    let size = [1, 2].map(|i| args.get(i).number_value(scope).unwrap_or(0.0));
    let p3 = args.get(3).is_true();
    let text = prepared(&args.get(4).to_rust_string_lossy(scope));
    let [x, y] = [5, 6].map(|i| args.get(i).number_value(scope).unwrap_or(f64::NAN));
    let max_width = (!args.get(7).is_undefined()).then(|| args.get(7).number_value(scope).unwrap_or(f64::NAN));
    if text.is_empty() || !x.is_finite() || !y.is_finite() || max_width.is_some_and(|m| !(m > 0.0)) {
        return;
    }
    let given = v8::Local::new(scope, args.get(9));
    let (paint, pixels) = crate::canvas::paint_arg(scope, h, args.get(8), given);
    let s = setting_args(scope, &args, h, 10);
    let bitmap = h.bitmap(scope);
    let draw = TextDraw { bitmap, size, p3, paint, pixels };
    if (s.letter != 0.0 || s.word != 0.0) && spaced(scope, h, &draw, &s, &text, x, y, max_width) {
        return;
    }
    draw_line(scope, h, &draw, &s, &text, x, y, max_width, s.align);
}

// A line drawn: its anchor (x, y) through the CTM, the fraction of it left of that `align` — at the CTM's scale, the
// larger of its two axes', so it stays sharp in device pixels — within the window the canvas and its shadow's offset
// make; a line with no ink on the canvas compositing all the same (a transparent source clears what a whole-canvas
// operator — copy, source-in, … — clears outside a shape).
#[allow(clippy::too_many_arguments)]
fn draw_line(scope: &mut v8::PinScope<'_, '_>, h: &CanvasStateHandle, d: &TextDraw<'_>, s: &Setting, text: &str, x: f64, y: f64, max_width: Option<f64>, align: f64) {
    let (m, shadow) = {
        let st = h.state();
        (st.m, (st.shadow.a > 0.0).then_some((st.shadow_x, st.shadow_y, st.shadow_blur)))
    };
    let scale = m[0].hypot(m[1]).max(m[2].hypot(m[3]));
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let (ox, oy, blur) = shadow.unwrap_or((0.0, 0.0, 0.0));
    let [w, hgt] = d.size;
    let place = Placement {
        anchor: (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]),
        align,
        baseline: s.baseline,
        max_width: max_width.map_or(0.0, |mw| mw * scale),
        window: [(-ox).min(0.0), (-oy).min(0.0), w.max(w - ox), hgt.max(hgt - oy)],
        shadow_blur: blur,
    };
    let Some(l) = std::panic::catch_unwind(|| line(text, s.face, s.size * scale, s.kerning, s.small_caps, s.rtl, Some(&place))).ok().flatten() else { return };
    let (shape, mask) = match l.mask {
        Some(mk) => (vec![2.0, mk.width as f64, mk.height as f64, mk.x as f64, mk.y as f64], mk.bytes),
        None => (vec![2.0, 1.0, 1.0, 0.0, 0.0], vec![0]),
    };
    crate::canvas::draw(scope, h, d.bitmap, d.size, d.p3, false, &shape, &mask, &d.paint, d.pixels);
}

// A spaced line drawn a character at a time, each at the pen position the previous one's advance plus the spacing
// leaves — which is what "add letter-spacing after each character" means in pixels — its alignment and `maxWidth`
// measured on the whole spaced advance, the condensing squashing glyph and gap alike; each character's advance the
// difference between the line's first i + 1 characters and its first i, as shaped, so a kerned pair keeps its kerning
// between the gaps. False — the ordinary line's to draw — where there is nothing to space (a single character, no
// letter spacing).
#[allow(clippy::too_many_arguments)]
fn spaced(scope: &mut v8::PinScope<'_, '_>, h: &CanvasStateHandle, d: &TextDraw<'_>, s: &Setting, text: &str, x: f64, y: f64, max_width: Option<f64>) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() < 2 && s.letter == 0.0 {
        return false;
    }
    let measure = |n: usize| metrics(&chars[..n].iter().collect::<String>(), s)[0];
    let gap = |ch: char| if ch == ' ' || ch == '\u{a0}' { s.word } else { 0.0 };
    let steps: Vec<f64> = (0..chars.len()).map(|i| measure(i + 1) - measure(i) + s.letter + gap(chars[i])).collect();
    let total: f64 = steps.iter().sum();
    let factor = max_width.filter(|&mw| total > mw).map_or(1.0, |mw| mw / total);
    let mut pen = x - total * factor * s.align;
    for (i, &ch) in chars.iter().enumerate() {
        if ch != ' ' && ch != '\u{a0}' {
            let own = metrics(&ch.to_string(), s)[0] * factor;
            draw_line(scope, h, d, s, &ch.to_string(), pen, y, (own > 0.0).then_some(own), 0.0);
        }
        pen += steps[i] * factor;
    }
    true
}
