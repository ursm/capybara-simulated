// A number as script writes it (ECMAScript Number::toString, radix 10): the shortest digits that read back as it — the
// nearest such where several are — placed by its exponent: `0.000001`, `1e-7`, `123456789012345680000`, `1e+21`, `-0`
// as `0`, `NaN`, `Infinity`. ryu-js is Ryu with these rules.
pub(crate) fn to_js_string(n: f64) -> String {
    if n == 0.0 {
        return "0".into();
    }
    ryu_js::Buffer::new().format(n).to_string()
}

// A number rounded to `p` significant digits and read back (script's `Number(x.toPrecision(p))`): binary noise
// trimmed off a computed value — `0 + 3 × 0.1` is 0.3. Rounded as toPrecision rounds, from the number's EXACT
// decimal expansion, a tie away from zero.
pub(crate) fn to_precision(x: f64, p: usize) -> f64 {
    if !x.is_finite() || x == 0.0 || p == 0 {
        return x;
    }
    // (…from 17 significant digits, correctly rounded, where they settle it — where the digits past the `p`th are
    // not a 5 and zeros, the exact expansion lies on the same side of the halfway point; else from the exact expansion
    // itself, which every double's fits in 800 significant digits)
    let near = format!("{:.16e}", x.abs());
    let tail: Vec<u8> = near.split('e').next().unwrap_or("").bytes().filter(u8::is_ascii_digit).skip(p).collect();
    let tie = tail.first() == Some(&b'5') && tail[1..].iter().all(|&d| d == b'0');
    let exact = if p < 17 && !tie { near } else { format!("{:.800e}", x.abs()) };
    let (mantissa, exp) = exact.split_once('e').unwrap_or((&exact, "0"));
    let digits: Vec<u8> = mantissa.bytes().filter(u8::is_ascii_digit).map(|d| d - b'0').collect();
    let mut exp: i32 = exp.parse().unwrap_or(0);
    let mut kept = digits[..p.min(digits.len())].to_vec();
    if digits.get(p).is_some_and(|&d| d >= 5) {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, 1);
                kept.pop();
                exp += 1;
                break;
            }
            i -= 1;
            if kept[i] == 9 {
                kept[i] = 0;
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let text: String = kept.iter().map(|d| char::from(b'0' + d)).collect();
    let v: f64 = format!("{}.{}e{exp}", &text[..1], &text[1..]).parse().unwrap_or(x.abs());
    v.copysign(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_numbers_as_script_does() {
        let cases = [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (0.000001, "0.000001"),
            (0.0000001, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e21, "1e+21"),
            (1.25e22, "1.25e+22"),
            (100.0, "100"),
            (212684238611834.62, "212684238611834.62"),
            (f64::NAN, "NaN"),
            (f64::NEG_INFINITY, "-Infinity"),
        ];
        for (n, want) in cases {
            assert_eq!(to_js_string(n), want, "{n}");
        }
    }

    #[test]
    fn rounds_as_to_precision_does() {
        assert_eq!(to_precision(0.1 * 3.0, 15), 0.3);
        // (…a tie away from zero, where half-to-even would go down)
        assert_eq!(to_precision(100000000000000.5, 15), 100000000000001.0);
        assert_eq!(to_precision(-2.5, 1), -3.0);
        assert_eq!(to_precision(9.99, 2), 10.0);
        assert_eq!(to_precision(0.30000000000000004, 15), 0.3);
        assert_eq!(to_precision(1.0000000000000002, 16), 1.0);
    }
}
