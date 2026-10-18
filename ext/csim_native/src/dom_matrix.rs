// DOMMatrix's algebra (Geometry Interfaces 1 §6): a 4×4 matrix, column-major (`m11, m12, m13, m14, m21, …, m44`, the
// order `toFloat64Array()` gives), and whether it is 2D; what each of its methods post-multiplies it by, and a CSS
// transform list read into one ("parse a string into an abstract matrix"). The page side keeps the sixteen numbers.

pub(crate) type M = [f64; 16];

const IDENTITY: M = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];

// The entries that are 0 in every 2D matrix, and the two that are 1.
const ZERO_IN_2D: [usize; 8] = [2, 3, 6, 7, 8, 9, 11, 14];
const ONE_IN_2D: [usize; 2] = [10, 15];
// The entries the 2D aliases `a` … `f` name.
const ALIASES: [usize; 6] = [0, 1, 4, 5, 12, 13];

// Whether a 2D matrix stays one with entry `i` set to `v`: an entry 0 (or 1) in every 2D matrix set to anything else
// makes it 3D (the DOMMatrix setters).
pub(crate) fn keeps_2d(i: usize, v: f64) -> bool {
    !(ZERO_IN_2D.contains(&i) && v != 0.0 || ONE_IN_2D.contains(&i) && v != 1.0)
}

pub(crate) fn is_identity(m: &M) -> bool {
    m == &IDENTITY
}

// "Create a DOMMatrix from a 2D sequence or a 3D sequence": 6 numbers the 2D matrix `a` … `f`, 16 a 3D one in column-major
// order — None for any other count (a TypeError).
pub(crate) fn from_sequence(a: &[f64]) -> Option<(M, bool)> {
    match *a {
        [m11, m12, m21, m22, m41, m42] => Some(([m11, m12, 0.0, 0.0, m21, m22, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, m41, m42, 0.0, 1.0], true)),
        _ => Some((a.try_into().ok()?, false)),
    }
}

// Why "validate and fix up" refuses a DOMMatrixInit.
#[derive(Debug, PartialEq)]
pub(crate) enum FixUp {
    // An alias and the entry it names disagree (SameValueZero), by the alias's index (`a` 0 … `f` 5).
    Disagree(usize),
    // `is2D` true with an entry set that no 2D matrix has.
    Not2D,
}

// "Validate and fix up" a DOMMatrixInit (Geometry Interfaces 1 §6.1): its sixteen entries, its six aliases and `is2D`,
// each None where the dictionary has none — the matrix it makes and whether it is 2D.
pub(crate) fn fix_up(entries: &[Option<f64>; 16], aliases: &[Option<f64>; 6], is_2d: Option<bool>) -> Result<(M, bool), FixUp> {
    let same_value_zero = |x: f64, y: f64| x == y || (x.is_nan() && y.is_nan());
    let mut m = IDENTITY;
    for (k, &i) in ALIASES.iter().enumerate() {
        if let (Some(a), Some(e)) = (aliases[k], entries[i]) {
            if !same_value_zero(a, e) {
                return Err(FixUp::Disagree(k));
            }
        }
        m[i] = entries[i].or(aliases[k]).unwrap_or(IDENTITY[i]);
    }
    let mut three_d = false;
    for i in ZERO_IN_2D.into_iter().chain(ONE_IN_2D) {
        if let Some(e) = entries[i] {
            m[i] = e;
            three_d |= e != IDENTITY[i];
        }
    }
    match is_2d {
        Some(true) if three_d => Err(FixUp::Not2D),
        Some(is_2d) => Ok((m, is_2d)),
        None => Ok((m, !three_d)),
    }
}

// A · B: B applied first, then A (what transformPoint does with the product).
pub(crate) fn mul(a: &M, b: &M) -> M {
    let mut r = [0.0; 16];
    for col in 0..4 {
        let (bx, by, bz, bw) = (b[col * 4], b[col * 4 + 1], b[col * 4 + 2], b[col * 4 + 3]);
        for row in 0..4 {
            r[col * 4 + row] = a[row] * bx + a[4 + row] * by + a[8 + row] * bz + a[12 + row] * bw;
        }
    }
    r
}

// The inverse, None where it is singular.
pub(crate) fn inverse(m: &M) -> Option<M> {
    let b00 = m[0] * m[5] - m[1] * m[4];
    let b01 = m[0] * m[6] - m[2] * m[4];
    let b02 = m[0] * m[7] - m[3] * m[4];
    let b03 = m[1] * m[6] - m[2] * m[5];
    let b04 = m[1] * m[7] - m[3] * m[5];
    let b05 = m[2] * m[7] - m[3] * m[6];
    let b06 = m[8] * m[13] - m[9] * m[12];
    let b07 = m[8] * m[14] - m[10] * m[12];
    let b08 = m[8] * m[15] - m[11] * m[12];
    let b09 = m[9] * m[14] - m[10] * m[13];
    let b10 = m[9] * m[15] - m[11] * m[13];
    let b11 = m[10] * m[15] - m[11] * m[14];
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if det == 0.0 || det.is_nan() {
        return None;
    }
    let d = 1.0 / det;
    Some([
        (m[5] * b11 - m[6] * b10 + m[7] * b09) * d,
        (m[2] * b10 - m[1] * b11 - m[3] * b09) * d,
        (m[13] * b05 - m[14] * b04 + m[15] * b03) * d,
        (m[10] * b04 - m[9] * b05 - m[11] * b03) * d,
        (m[6] * b08 - m[4] * b11 - m[7] * b07) * d,
        (m[0] * b11 - m[2] * b08 + m[3] * b07) * d,
        (m[14] * b02 - m[12] * b05 - m[15] * b01) * d,
        (m[8] * b05 - m[10] * b02 + m[11] * b01) * d,
        (m[4] * b10 - m[5] * b08 + m[7] * b06) * d,
        (m[1] * b08 - m[0] * b10 - m[3] * b06) * d,
        (m[12] * b04 - m[13] * b02 + m[15] * b00) * d,
        (m[9] * b02 - m[8] * b04 - m[11] * b00) * d,
        (m[5] * b07 - m[4] * b09 - m[6] * b06) * d,
        (m[0] * b09 - m[1] * b07 + m[2] * b06) * d,
        (m[13] * b01 - m[12] * b03 - m[14] * b00) * d,
        (m[8] * b03 - m[9] * b01 + m[10] * b00) * d,
    ])
}

// …of a 2D matrix: `a b c d e f` inverted as the affine transform they are.
fn inverse_2d(m: &M) -> Option<M> {
    let (a, b, c, d, e, f) = (m[0], m[1], m[4], m[5], m[12], m[13]);
    let det = a * d - b * c;
    if det == 0.0 || det.is_nan() {
        return None;
    }
    let mut r = IDENTITY;
    (r[0], r[1], r[4], r[5]) = (d / det, -b / det, -c / det, a / det);
    (r[12], r[13]) = ((c * f - d * e) / det, (b * e - a * f) / det);
    Some(r)
}

// ── the transforms a method post-multiplies by (CSS Transforms 1 / 2's functions) ──
fn translation(x: f64, y: f64, z: f64) -> M {
    let mut m = IDENTITY;
    (m[12], m[13], m[14]) = (x, y, z);
    m
}
fn scaling(x: f64, y: f64, z: f64) -> M {
    let mut m = IDENTITY;
    (m[0], m[5], m[10]) = (x, y, z);
    m
}
// The sine and cosine of an angle in degrees, exact at a multiple of 90° (Blink's `SinCosDegrees`: a quarter turn is
// `matrix(0, 1, -1, 0, 0, 0)`, not one with 6.123233995736766e-17 for its zeros).
fn sin_cos_deg(deg: f64) -> (f64, f64) {
    if deg % 90.0 == 0.0 {
        return match (deg / 90.0).rem_euclid(4.0) as i32 {
            0 => (0.0, 1.0),
            1 => (1.0, 0.0),
            2 => (0.0, -1.0),
            _ => (-1.0, 0.0),
        };
    }
    deg.to_radians().sin_cos()
}
// rotate3d(x, y, z, angle), the axis normalized; a zero axis is no rotation.
fn rotation(x: f64, y: f64, z: f64, deg: f64) -> M {
    let len = (x * x + y * y + z * z).sqrt();
    if len == 0.0 {
        return IDENTITY;
    }
    let (x, y, z) = (x / len, y / len, z / len);
    let (s, c) = sin_cos_deg(deg);
    let t = 1.0 - c;
    [
        t * x * x + c,
        t * x * y + s * z,
        t * x * z - s * y,
        0.0,
        t * x * y - s * z,
        t * y * y + c,
        t * y * z + s * x,
        0.0,
        t * x * z + s * y,
        t * y * z - s * x,
        t * z * z + c,
        0.0,
        0.0,
        0.0,
        0.0,
        1.0,
    ]
}
// rotate(angle) about Z, exact on the axis: the 2D rotation a CSS `rotate()` is.
fn rotation_z(deg: f64) -> M {
    let (s, c) = sin_cos_deg(deg);
    let mut m = IDENTITY;
    (m[0], m[1], m[4], m[5]) = (c, s, -s, c);
    m
}
fn rotation_y(deg: f64) -> M {
    let (s, c) = sin_cos_deg(deg);
    let mut m = IDENTITY;
    (m[0], m[2], m[8], m[10]) = (c, -s, s, c);
    m
}
fn rotation_x(deg: f64) -> M {
    let (s, c) = sin_cos_deg(deg);
    let mut m = IDENTITY;
    (m[5], m[6], m[9], m[10]) = (c, s, -s, c);
    m
}
fn skewing(x_deg: f64, y_deg: f64) -> M {
    let mut m = IDENTITY;
    (m[4], m[1]) = (x_deg.to_radians().tan(), y_deg.to_radians().tan());
    m
}
fn perspective(d: f64) -> M {
    let mut m = IDENTITY;
    m[11] = -1.0 / d;
    m
}

// ── the methods ──
// Each a DOMMatrix method's "post-multiply", from `m` (2D where `is_2d`) and its arguments, defaulted as its IDL has
// them: the result and whether it is 2D.
pub(crate) fn method(m: &M, is_2d: bool, name: &str, a: &[f64]) -> Option<(M, bool)> {
    let arg = |i: usize| a.get(i).copied().unwrap_or(f64::NAN);
    Some(match name {
        "translate" => {
            let (x, y, z) = (arg(0), arg(1), arg(2));
            (mul(m, &translation(x, y, z)), is_2d && z == 0.0)
        }
        // scale(sx, sy, sz, ox, oy, oz): about the origin, which a translation either side moves.
        "scale" => {
            let (sx, sy, sz, ox, oy, oz) = (arg(0), arg(1), arg(2), arg(3), arg(4), arg(5));
            let origin = ox != 0.0 || oy != 0.0 || oz != 0.0;
            let mut r = *m;
            if origin {
                r = mul(&r, &translation(ox, oy, oz));
            }
            r = mul(&r, &scaling(sx, sy, sz));
            if origin {
                r = mul(&r, &translation(-ox, -oy, -oz));
            }
            (r, is_2d && sz == 1.0 && oz == 0.0)
        }
        // rotate(rx, ry, rz): Z, then Y, then X.
        "rotate" => {
            let (rx, ry, rz) = (arg(0), arg(1), arg(2));
            let mut r = *m;
            if rz != 0.0 {
                r = mul(&r, &rotation_z(rz));
            }
            if ry != 0.0 {
                r = mul(&r, &rotation_y(ry));
            }
            if rx != 0.0 {
                r = mul(&r, &rotation_x(rx));
            }
            (r, is_2d && rx == 0.0 && ry == 0.0)
        }
        "rotateAxisAngle" => {
            let (x, y, z, angle) = (arg(0), arg(1), arg(2), arg(3));
            (mul(m, &rotation(x, y, z, angle)), is_2d && x == 0.0 && y == 0.0)
        }
        "skewX" => (mul(m, &skewing(arg(0), 0.0)), is_2d),
        "skewY" => (mul(m, &skewing(0.0, arg(0))), is_2d),
        "flipX" => (mul(m, &scaling(-1.0, 1.0, 1.0)), is_2d),
        "flipY" => (mul(m, &scaling(1.0, -1.0, 1.0)), is_2d),
        // (…one that cannot be inverted is all NaN, and not 2D; a 2D one is inverted as the 2D matrix it is, so the
        // entries no 2D matrix has stay exactly 0 and 1)
        "inverse" => match if is_2d { inverse_2d(m) } else { inverse(m) } {
            Some(inv) => (inv, is_2d),
            None => ([f64::NAN; 16], false),
        },
        _ => return None,
    })
}

// ── a string ──
// "Parse a string into an abstract matrix": a CSS <transform-list> (or `none`, or nothing) composed into one matrix,
// 2D unless one of its functions is a 3D one — None where it is no transform list, or a length in it is not absolute
// (a percentage, an `em`).
pub(crate) fn parse(text: &str) -> Option<(M, bool)> {
    use style::parser::Parse;
    use style::values::generics::transform::GenericPerspectiveFunction;
    use style::values::specified::transform::{Transform, TransformOperation as Op};
    use style::values::specified::{Angle, Length, LengthPercentage, Number};
    // (…the empty string is the identity; one of whitespace alone is no transform list)
    if text.is_empty() {
        return Some((IDENTITY, true));
    }
    let url = crate::cssom_decl::url_data("about:blank");
    let context = crate::cssom_decl::rule_context(&url, style::stylesheets::CssRuleType::Style, false);
    let mut input = cssparser::ParserInput::new(text);
    let mut parser = cssparser::Parser::new(&mut input);
    let list = parser.parse_entirely(|p| Transform::parse(&context, p)).ok()?;
    // (…the engine holds a value in an f32, widened as it is, as Chrome has it — but a `matrix()` / `matrix3d()` is
    // read at double precision, as Chrome reads it: it is what getComputedStyle hands back)
    let num = |n: &Number| n.get().map(f64::from);
    let deg = |a: &Angle| a.degrees().map(f64::from);
    let len = |l: &Length| l.to_computed_pixel_length_without_context().ok().map(f64::from);
    let lp = |l: &LengthPercentage| match l {
        LengthPercentage::Length(l) => l.to_px_if_absolute().map(f64::from),
        LengthPercentage::Calc(c) => c.to_computed_pixel_length_without_context().ok().map(f64::from),
        LengthPercentage::Percentage(_) => None,
    };
    let mut matrices = matrix_arguments(text).into_iter();
    let (mut m, mut is_2d) = (IDENTITY, true);
    for op in list.0.iter() {
        let (step, three_d) = match op {
            Op::Matrix(x) => {
                let mut s = IDENTITY;
                (s[0], s[1], s[4], s[5], s[12], s[13]) = match matrices.next().flatten().filter(|a| a.len() == 6) {
                    Some(a) => (a[0], a[1], a[2], a[3], a[4], a[5]),
                    None => (num(&x.a)?, num(&x.b)?, num(&x.c)?, num(&x.d)?, num(&x.e)?, num(&x.f)?),
                };
                (s, false)
            }
            Op::Matrix3D(x) => {
                let s = [
                    &x.m11, &x.m12, &x.m13, &x.m14, &x.m21, &x.m22, &x.m23, &x.m24, &x.m31, &x.m32, &x.m33, &x.m34, &x.m41,
                    &x.m42, &x.m43, &x.m44,
                ];
                let mut out = [0.0; 16];
                match matrices.next().flatten().filter(|a| a.len() == 16) {
                    Some(a) => out.copy_from_slice(&a),
                    None => {
                        for (o, n) in out.iter_mut().zip(s) {
                            *o = num(n)?;
                        }
                    }
                }
                (out, true)
            }
            Op::Skew(x, y) => (skewing(deg(x)?, deg(y)?), false),
            Op::SkewX(x) => (skewing(deg(x)?, 0.0), false),
            Op::SkewY(y) => (skewing(0.0, deg(y)?), false),
            Op::Translate(x, y) => (translation(lp(x)?, lp(y)?, 0.0), false),
            Op::TranslateX(x) => (translation(lp(x)?, 0.0, 0.0), false),
            Op::TranslateY(y) => (translation(0.0, lp(y)?, 0.0), false),
            Op::TranslateZ(z) => (translation(0.0, 0.0, len(z)?), true),
            Op::Translate3D(x, y, z) => (translation(lp(x)?, lp(y)?, len(z)?), true),
            Op::Scale(x, y) => (scaling(num(x)?, num(y)?, 1.0), false),
            Op::ScaleX(x) => (scaling(num(x)?, 1.0, 1.0), false),
            Op::ScaleY(y) => (scaling(1.0, num(y)?, 1.0), false),
            Op::ScaleZ(z) => (scaling(1.0, 1.0, num(z)?), true),
            Op::Scale3D(x, y, z) => (scaling(num(x)?, num(y)?, num(z)?), true),
            Op::Rotate(a) | Op::RotateZ(a) => (rotation_z(deg(a)?), matches!(op, Op::RotateZ(_))),
            Op::RotateX(a) => (rotation_x(deg(a)?), true),
            Op::RotateY(a) => (rotation_y(deg(a)?), true),
            Op::Rotate3D(x, y, z, a) => (rotation(num(x)?, num(y)?, num(z)?, deg(a)?), true),
            Op::Perspective(GenericPerspectiveFunction::Length(d)) => (perspective(len(d)?.max(1.0)), true),
            Op::Perspective(GenericPerspectiveFunction::None) => (IDENTITY, true),
            _ => return None,
        };
        m = mul(&m, &step);
        is_2d &= !three_d;
    }
    Some((m, is_2d))
}

// The arguments of each `matrix()` / `matrix3d()` of a transform list, in order, read at double precision — None for
// one with an argument that is no plain number (a `calc()`), which the engine's f32 reading answers instead.
fn matrix_arguments(text: &str) -> Vec<Option<Vec<f64>>> {
    use cssparser::Token;
    let mut input = cssparser::ParserInput::new(text);
    let mut parser = cssparser::Parser::new(&mut input);
    let mut out = Vec::new();
    while let Ok(token) = parser.next() {
        let Token::Function(name) = token else { continue };
        if !name.eq_ignore_ascii_case("matrix") && !name.eq_ignore_ascii_case("matrix3d") {
            let _ = parser.parse_nested_block(|p| -> Result<(), cssparser::ParseError<'_, ()>> {
                while p.next().is_ok() {}
                Ok(())
            });
            continue;
        }
        let args = parser.parse_nested_block(|p| -> Result<Option<Vec<f64>>, cssparser::ParseError<'_, ()>> {
            let mut args = Vec::new();
            loop {
                let start = p.position();
                match p.next() {
                    Ok(Token::Number { .. }) => match p.slice_from(start).trim().parse::<f64>() {
                        Ok(v) => args.push(v),
                        Err(_) => return Ok(None),
                    },
                    Ok(Token::Comma) => {}
                    Ok(_) => return Ok(None),
                    Err(_) => return Ok(Some(args)),
                }
            }
        });
        out.push(args.ok().flatten());
    }
    out
}

// ── the ops ──
pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "matrixParse", matrix_parse, context_id);
    crate::dom::register(scope, ns, "matrixMethod", matrix_method, context_id);
    crate::dom::register(scope, ns, "matrixMultiply", matrix_multiply, context_id);
    crate::dom::register(scope, ns, "matrixPoint", matrix_point, context_id);
    crate::dom::register(scope, ns, "matrixFromSequence", matrix_from_sequence, context_id);
    crate::dom::register(scope, ns, "matrixFixUp", matrix_fix_up, context_id);
    crate::dom::register(scope, ns, "matrixKeeps2D", matrix_keeps_2d, context_id);
    crate::dom::register(scope, ns, "matrixIsIdentity", matrix_is_identity, context_id);
}

fn throw_type_error(scope: &mut v8::PinScope<'_, '_>, message: &str) {
    if let Some(message) = v8::String::new(scope, message) {
        let error = v8::Exception::type_error(scope, message);
        scope.throw_exception(error);
    }
}

fn matrix_arg(val: v8::Local<'_, v8::Value>) -> Option<M> {
    crate::dom::f64_arg(val).get(..16)?.try_into().ok()
}
// A matrix and its 2D-ness, as the page side takes one: `[…m, is2D]`.
fn answer(scope: &mut v8::PinScope<'_, '_>, rv: &mut v8::ReturnValue<'_, v8::Value>, (m, is_2d): (M, bool)) {
    let mut out = m.to_vec();
    out.push(f64::from(u8::from(is_2d)));
    rv.set(crate::dom::f64_array(scope, &out).into());
}

// __dom.matrixParse(text) -> `[…m, is2D]` of a transform list (`parse`), or null where it is none.
fn matrix_parse(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    match parse(&text) {
        Some(done) => answer(scope, &mut rv, done),
        None => rv.set_null(),
    }
}

// __dom.matrixMethod(m, is2D, name, args) -> `[…m, is2D]` after the method `name` (`method`).
fn matrix_method(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(m) = matrix_arg(args.get(0)) else { return };
    let is_2d = args.get(1).is_true();
    let name = args.get(2).to_rust_string_lossy(scope);
    let a = crate::dom::f64_arg(args.get(3)).to_vec();
    if let Some(done) = method(&m, is_2d, &name, &a) {
        answer(scope, &mut rv, done);
    }
}

// __dom.matrixMultiply(a, b) -> a · b.
fn matrix_multiply(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(a), Some(b)) = (matrix_arg(args.get(0)), matrix_arg(args.get(1))) else { return };
    rv.set(crate::dom::f64_array(scope, &mul(&a, &b)).into());
}

// __dom.matrixPoint(m, x, y, z, w) -> `[x, y, z, w]`: the point transformed by `m` ("transform a point with a matrix").
fn matrix_point(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(m) = matrix_arg(args.get(0)) else { return };
    let [x, y, z, w] = [1, 2, 3, 4].map(|i| args.get(i).number_value(scope).unwrap_or(f64::NAN));
    let p: Vec<f64> = (0..4).map(|row| m[row] * x + m[4 + row] * y + m[8 + row] * z + m[12 + row] * w).collect();
    rv.set(crate::dom::f64_array(scope, &p).into());
}

// __dom.matrixFromSequence(numbers) -> `[…m, is2D]` of a 6- or 16-number sequence (`from_sequence`); a TypeError for
// another count.
fn matrix_from_sequence(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    match from_sequence(&crate::dom::f64_arg(args.get(0))) {
        Some(done) => answer(scope, &mut rv, done),
        None => throw_type_error(scope, "DOMMatrix: a sequence must have 6 or 16 elements"),
    }
}

// The 2D aliases' names, for the TypeError `fix_up` throws.
const ALIAS_NAMES: [&str; 6] = ["a", "b", "c", "d", "e", "f"];
const ENTRY_NAMES: [&str; 6] = ["m11", "m12", "m21", "m22", "m41", "m42"];

// __dom.matrixFixUp(members) -> `[…m, is2D]` of a DOMMatrixInit (`fix_up`): `members` its sixteen entries, its six
// aliases and `is2D`, in that order, each undefined where the dictionary has none; a TypeError where it is refused.
fn matrix_fix_up(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(members) = v8::Local::<v8::Array>::try_from(args.get(0)) else { return };
    let member = |i: u32| members.get_index(scope, i).filter(|v| !v.is_undefined());
    let entries: [Option<f64>; 16] = std::array::from_fn(|i| member(i as u32).and_then(|v| v.number_value(scope)));
    let aliases: [Option<f64>; 6] = std::array::from_fn(|k| member(16 + k as u32).and_then(|v| v.number_value(scope)));
    let is_2d = member(22).map(|v| v.is_true());
    match fix_up(&entries, &aliases, is_2d) {
        Ok(done) => answer(scope, &mut rv, done),
        Err(FixUp::Disagree(k)) => throw_type_error(scope, &format!("DOMMatrix: {} and {} disagree", ALIAS_NAMES[k], ENTRY_NAMES[k])),
        Err(FixUp::Not2D) => throw_type_error(scope, "DOMMatrix: is2D is true but a 3D entry is set"),
    }
}

// __dom.matrixKeeps2D(index, value) -> whether a 2D matrix stays one with that entry set (`keeps_2d`).
fn matrix_keeps_2d(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let i = args.get(0).uint32_value(scope).unwrap_or(0) as usize;
    let v = args.get(1).number_value(scope).unwrap_or(f64::NAN);
    rv.set_bool(keeps_2d(i, v));
}

// __dom.matrixIsIdentity(m) -> whether it is the identity matrix.
fn matrix_is_identity(_scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(matrix_arg(args.get(0)).is_some_and(|m| is_identity(&m)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixes_up_an_init() {
        let none = [None; 16];
        assert_eq!(fix_up(&none, &[None; 6], None), Ok((IDENTITY, true)));
        let mut entries = none;
        entries[0] = Some(2.0);
        assert_eq!(fix_up(&entries, &[Some(2.0), None, None, None, Some(5.0), None], None).map(|(m, d)| (m[0], m[12], d)), Ok((2.0, 5.0, true)));
        assert_eq!(fix_up(&entries, &[Some(3.0), None, None, None, None, None], None), Err(FixUp::Disagree(0)));
        entries[0] = Some(f64::NAN);
        assert!(fix_up(&entries, &[Some(f64::NAN), None, None, None, None, None], None).is_ok());
        let mut three = none;
        three[10] = Some(2.0);
        assert_eq!(fix_up(&three, &[None; 6], None).map(|(_, d)| d), Ok(false));
        assert_eq!(fix_up(&three, &[None; 6], Some(true)), Err(FixUp::Not2D));
        three[10] = Some(1.0);
        assert_eq!(fix_up(&three, &[None; 6], Some(true)).map(|(_, d)| d), Ok(true));
        assert_eq!(fix_up(&none, &[None; 6], Some(false)).map(|(_, d)| d), Ok(false));
    }

    #[test]
    fn makes_one_of_a_sequence_and_keeps_it_2d() {
        assert_eq!(from_sequence(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]).map(|(m, d)| (m[4], m[13], d)), Some((3.0, 6.0, true)));
        assert_eq!(from_sequence(&IDENTITY), Some((IDENTITY, false)));
        assert_eq!(from_sequence(&[1.0; 5]), None);
        assert!(keeps_2d(0, 7.0) && keeps_2d(10, 1.0) && !keeps_2d(10, 2.0) && !keeps_2d(14, 0.5));
    }

    #[test]
    fn parses_a_transform_list() {
        let (m, is_2d) = parse("translate(10px, 5px) scale(2)").unwrap();
        assert!(is_2d);
        assert_eq!((m[0], m[5], m[12], m[13]), (2.0, 2.0, 10.0, 5.0));
        let (m, is_2d) = parse("matrix(1.23456789012, 0, 0, 1, 123456789, 1e-50) translateZ(2px)").unwrap();
        assert!(!is_2d);
        assert_eq!((m[0], m[12], m[13], m[14]), (1.23456789012, 123456789.0, 1e-50, 2.0));
        assert_eq!(parse("none"), Some((IDENTITY, true)));
        assert_eq!(parse(""), Some((IDENTITY, true)));
        assert!(parse(" ").is_none());
        assert!(parse("translate(10%)").is_none());
        assert!(parse("translate(1em)").is_none());
        assert!(parse("bogus(1)").is_none());
    }

    #[test]
    fn inverts_and_multiplies() {
        let (m, _) = parse("translate(3px, 4px) rotate(30deg) scale(2, 3)").unwrap();
        let back = mul(&m, &inverse(&m).unwrap());
        assert!(back.iter().zip(IDENTITY).all(|(a, b)| (a - b).abs() < 1e-12));
        assert!(inverse(&[0.0; 16]).is_none());
    }
}
