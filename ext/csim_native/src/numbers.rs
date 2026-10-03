// A number as script writes it (ECMAScript Number::toString, radix 10): the shortest digits that read back as it,
// placed by its exponent — `0.000001`, `1e-7`, `123456789012345680000`, `1e+21`, `-0` as `0`, `NaN`, `Infinity`.
pub(crate) fn to_js_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if n == 0.0 {
        return "0".into();
    }
    let sign = if n < 0.0 { "-" } else { "" };
    // (…Rust's `{:e}` is the shortest round-trip digits too: `d.ddde±x`)
    let sci = format!("{:e}", n.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(|c| c.is_ascii_digit()).collect();
    let k = digits.len() as i32;
    // The decimal point's place: the value is 0.digits × 10^n.
    let n_exp = exp.parse::<i32>().unwrap_or(0) + 1;
    let body = if k <= n_exp && n_exp <= 21 {
        format!("{digits}{}", "0".repeat((n_exp - k) as usize))
    } else if 0 < n_exp && n_exp <= 21 {
        format!("{}.{}", &digits[..n_exp as usize], &digits[n_exp as usize..])
    } else if -6 < n_exp && n_exp <= 0 {
        format!("0.{}{digits}", "0".repeat((-n_exp) as usize))
    } else {
        let e = n_exp - 1;
        let e = if e >= 0 { format!("+{e}") } else { e.to_string() };
        if k == 1 { format!("{digits}e{e}") } else { format!("{}.{}e{e}", &digits[..1], &digits[1..]) }
    };
    format!("{sign}{body}")
}

// A number rounded to `p` significant digits and read back (script's `Number(x.toPrecision(p))`): binary noise
// trimmed off a computed value — `0 + 3 × 0.1` is 0.3.
pub(crate) fn to_precision(x: f64, p: usize) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    format!("{:.*e}", p.saturating_sub(1), x).parse().unwrap_or(x)
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
            (f64::NAN, "NaN"),
            (f64::NEG_INFINITY, "-Infinity"),
        ];
        for (n, want) in cases {
            assert_eq!(to_js_string(n), want, "{n}");
        }
        assert_eq!(to_precision(0.1 * 3.0, 15), 0.3);
    }
}
