// An `<easing-function>` (CSS Easing 1 and 2) as Web Animations takes one — an effect's or a keyframe's `easing` — in the
// form it reads back: a keyword, `cubic-bezier()`, `steps()` (its default position, `end` or `jump-end`, left out) or
// `linear()` with every stop's position filled in. Not the style engine's parse (style.rs `easing`, which the timing
// runs on): CSS's numbers are f32, and a page's numbers keep their double precision here, as Chrome reports them
// (`cubic-bezier(0, 0.43333333333333335, …)`) — a plain number is read off the text the page wrote; one a `calc()`
// gives (Chrome takes those too) is the style engine's.

use cssparser::{Parser, ParserInput, Token};
use style::parser::{Parse, ParserContext};

use crate::numbers::to_js_string;

// The canonical text of `text`'s easing function, or None where it is none.
pub(crate) fn canonical(text: &str) -> Option<String> {
    let url = crate::cssom_decl::url_data("about:blank");
    let context = crate::cssom_decl::rule_context(&url, style::stylesheets::CssRuleType::Style, false);
    let mut input = ParserInput::new(text);
    let mut parser = Parser::new(&mut input);
    parser.parse_entirely(|p| function(&context, p).map_err(|()| p.new_custom_error::<(), ()>(()))).ok()
}

fn function(context: &ParserContext<'_>, p: &mut Parser<'_, '_>) -> Result<String, ()> {
    let token = p.next().map_err(|_| ())?.clone();
    match token {
        Token::Ident(name) => {
            let keyword = match_ignore_ascii_case(&name, &["linear", "ease", "ease-in", "ease-out", "ease-in-out", "step-start", "step-end"])?;
            Ok(match keyword {
                "step-start" => "steps(1, start)".into(),
                "step-end" => "steps(1)".into(),
                k => k.into(),
            })
        }
        Token::Function(name) => {
            let name = match_ignore_ascii_case(&name, &["cubic-bezier", "steps", "linear"])?;
            p.parse_nested_block(|p| {
                let out = match name {
                    "cubic-bezier" => cubic_bezier(context, p),
                    "steps" => steps(context, p),
                    _ => linear(context, p),
                };
                out.map_err(|()| p.new_custom_error::<(), ()>(()))
            })
            .map_err(|_| ())
        }
        _ => Err(()),
    }
}

fn match_ignore_ascii_case<'a>(name: &str, names: &[&'a str]) -> Result<&'a str, ()> {
    names.iter().copied().find(|n| n.eq_ignore_ascii_case(name)).ok_or(())
}

// A `<number>`: a plain one at the precision the page wrote it in (its text read from where the token starts, past the
// whitespace and comments before it), a `calc()` resolved.
fn number(context: &ParserContext<'_>, p: &mut Parser<'_, '_>) -> Result<f64, ()> {
    p.skip_whitespace();
    let start = p.position();
    if p.try_parse(|p| match p.next() {
        Ok(Token::Number { .. }) => Ok(()),
        _ => Err(()),
    })
    .is_ok()
    {
        return p.slice_from(start).trim().parse().map_err(|_| ());
    }
    let n = style::values::specified::Number::parse(context, p).map_err(|_| ())?;
    let n = n.resolve().ok_or(())?;
    shortest(n)
}
// …a `<percentage>`'s number of percent, likewise.
fn percentage(context: &ParserContext<'_>, p: &mut Parser<'_, '_>) -> Result<f64, ()> {
    p.skip_whitespace();
    let start = p.position();
    if p.try_parse(|p| match p.next() {
        Ok(Token::Percentage { .. }) => Ok(()),
        _ => Err(()),
    })
    .is_ok()
    {
        return p.slice_from(start).trim().trim_end_matches('%').parse().map_err(|_| ());
    }
    let n = style::values::specified::Percentage::parse(context, p).map_err(|_| ())?;
    Ok(shortest(n.resolve().ok_or(())?)? * 100.0)
}
// …an `<integer>` of at least `min` — a plain one below it none, a `calc()` clamped to it (CSS Values: a calc()'s result
// is clamped to the range the context allows; Chrome: `steps(calc(-1))` reads `steps(1)`).
fn integer(context: &ParserContext<'_>, p: &mut Parser<'_, '_>, min: i64) -> Result<i64, ()> {
    if let Ok(v) = p.try_parse(|p| match p.next() {
        Ok(&Token::Number { int_value: Some(v), .. }) => Ok(v),
        _ => Err(()),
    }) {
        return if i64::from(v) < min { Err(()) } else { Ok(i64::from(v)) };
    }
    let n = style::values::specified::Integer::parse(context, p).map_err(|_| ())?;
    Ok(i64::from(n.resolve().ok_or(())?).max(min))
}
// (…an f32 a calc() resolved to, as the shortest decimal that reads back as it — `0.1`, not its double's digits)
fn shortest(n: f32) -> Result<f64, ()> {
    if !n.is_finite() {
        return Err(());
    }
    n.to_string().parse().map_err(|_| ())
}

fn comma(p: &mut Parser<'_, '_>) -> Result<(), ()> {
    p.expect_comma().map_err(|_| ())
}

// `cubic-bezier(x1, y1, x2, y2)`: the two X coordinates are progress values, and one outside [0, 1] is none.
fn cubic_bezier(context: &ParserContext<'_>, p: &mut Parser<'_, '_>) -> Result<String, ()> {
    let mut n = [0.0; 4];
    for (i, slot) in n.iter_mut().enumerate() {
        if i > 0 {
            comma(p)?;
        }
        *slot = number(context, p)?;
    }
    if !(0.0..=1.0).contains(&n[0]) || !(0.0..=1.0).contains(&n[2]) {
        return Err(());
    }
    Ok(format!("cubic-bezier({})", n.map(to_js_string).join(", ")))
}

// `steps(count[, position])`: at least one step — two where they jump at neither end (`jump-none`) — and the default
// position, `end` or `jump-end`, not reported back (Chrome: `steps(2, jump-end)` reads `steps(2)`).
fn steps(context: &ParserContext<'_>, p: &mut Parser<'_, '_>) -> Result<String, ()> {
    let count = integer(context, p, 1)?;
    let position = if p.try_parse(comma).is_ok() {
        let name = p.expect_ident().map_err(|_| ())?.clone();
        match_ignore_ascii_case(&name, &["jump-start", "jump-end", "jump-none", "jump-both", "start", "end"])?
    } else {
        "end"
    };
    // (…two steps where they jump at neither end — a rule of its own, past a calc()'s clamping: Chrome refuses
    // `steps(calc(1), jump-none)`)
    if position == "jump-none" && count < 2 {
        return Err(());
    }
    Ok(match position {
        "end" | "jump-end" => format!("steps({count})"),
        position => format!("steps({count}, {position})"),
    })
}

// `linear(stop, …)`: each stop a number with up to two positions — a stop with two is two stops — the first position
// 0% where it has none and the last 100%, a gap spaced evenly between the known positions around it, and a position
// never before the largest seen so far (Chrome: `linear(1 100%, 0 0%)` reads `linear(1 100%, 0 100%)`). Its numbers
// to six decimals, as Chrome reports them.
fn linear(context: &ParserContext<'_>, p: &mut Parser<'_, '_>) -> Result<String, ()> {
    let mut stops: Vec<(f64, Option<f64>)> = Vec::new();
    loop {
        let value = number(context, p)?;
        let mut positions = 0;
        while positions < 2 {
            let Ok(at) = p.try_parse(|p| percentage(context, p)) else { break };
            stops.push((value, Some(at)));
            positions += 1;
        }
        if positions == 0 {
            stops.push((value, None));
        }
        if p.try_parse(comma).is_err() {
            break;
        }
    }
    if stops.len() < 2 {
        return Err(());
    }
    let last = stops.len() - 1;
    stops[0].1.get_or_insert(0.0);
    stops[last].1.get_or_insert(100.0);
    let mut largest = stops[0].1.unwrap_or(0.0);
    for stop in &mut stops {
        if let Some(at) = &mut stop.1 {
            *at = at.max(largest);
            largest = *at;
        }
    }
    let mut i = 1;
    while i < last {
        if stops[i].1.is_some() {
            i += 1;
            continue;
        }
        let end = (i..=last).find(|&k| stops[k].1.is_some()).unwrap_or(last);
        let (from, to) = (stops[i - 1].1.unwrap_or(0.0), stops[end].1.unwrap_or(100.0));
        let span = (end - (i - 1)) as f64;
        for k in i..end {
            stops[k].1 = Some(from + (to - from) * ((k - (i - 1)) as f64 / span));
        }
        i = end;
    }
    let six = |n: f64| to_js_string(((n * 1e6) + 0.5).floor() / 1e6);
    let stops: Vec<String> = stops.iter().map(|&(v, at)| format!("{} {}%", six(v), six(at.unwrap_or(0.0)))).collect();
    Ok(format!("linear({})", stops.join(", ")))
}
