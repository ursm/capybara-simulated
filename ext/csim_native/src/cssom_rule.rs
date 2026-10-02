// CSSOM's rules where the engine decides: a style rule's `selectorText` is the selector list stylo parses for the sheet —
// under the sheet's `@namespace` prefixes and default namespace, relative to the parent rule's when nested — serialized
// as Gecko serializes it, and a selector the engine does not parse is no selector a rule can have; an `@namespace`
// rule's prefix and URL, and an `@counter-style` rule's descriptors, are what the engine reads of them.

use cssparser::{Parser, ParserInput, ToCss};
use selectors::parser::{ParseRelative, SelectorList};
use style::counter_style::{parse_counter_style_body, parse_counter_style_name_definition, DescriptorId};
use style::selector_parser::SelectorParser;
use style::shared_lock::{SharedRwLock, ToCssWithGuard};
use style::stylesheets::{CssRuleType, Namespaces, Origin, UrlExtraData};
use style::{Namespace, Prefix};
use style_traits::{CssWriter, ToCss as _};

pub(crate) fn selector_text(text: &str, default_namespace: Option<&str>, prefixes: &[(String, String)], nested: bool) -> Option<String> {
    let mut namespaces = Namespaces::default();
    namespaces.default = default_namespace.map(Namespace::from);
    for (prefix, uri) in prefixes {
        namespaces.prefixes.insert(Prefix::from(prefix.as_str()), Namespace::from(uri.as_str()));
    }
    thread_local! {
        static URL: UrlExtraData = UrlExtraData::from(url::Url::parse("about:blank").unwrap());
    }
    URL.with(|url| {
        let parser = SelectorParser { stylesheet_origin: Origin::Author, namespaces: &namespaces, url_data: url, for_supports_rule: false };
        let mut input = ParserInput::new(text);
        let relative = if nested { ParseRelative::ForNesting } else { ParseRelative::No };
        let list = SelectorList::parse(&parser, &mut Parser::new(&mut input), relative).ok()?;
        Some(list.to_css_string())
    })
}

// An `@namespace` rule's prelude — `[<prefix>] [<url> | <string>]` — as its prefix ('' for none, unescaped) and namespace
// URL, or None where it does not parse.
pub(crate) fn namespace_prelude(text: &str) -> Option<(String, String)> {
    let mut input = ParserInput::new(text);
    Parser::new(&mut input)
        .parse_entirely(|p| {
            let prefix = p.try_parse(|p| p.expect_ident_cloned()).map_or_else(|_| String::new(), |i| i.as_ref().to_owned());
            let url = p.expect_url_or_string()?.as_ref().to_owned();
            Ok::<_, cssparser::ParseError<'_, ()>>((prefix, url))
        })
        .ok()
}

// The descriptors of an `@counter-style` rule, in the order its CSSOM attributes list them.
pub(crate) const COUNTER_STYLE_DESCRIPTORS: [&str; 10] =
    ["system", "symbols", "additive-symbols", "negative", "prefix", "suffix", "range", "pad", "speak-as", "fallback"];

// An `@counter-style` rule — the name its prelude gives and the body inside its braces — as the engine parses it: its
// `cssText`, its body as the engine serializes it, and each descriptor's value ('' for one it does not give); or None
// where the engine drops the rule (a name no counter style can have, a system without the symbols it needs, …). With a
// `write`, the rule after CSSOM sets that descriptor to that value — None where the engine refuses the write (a value
// that does not parse, another kind of system, symbols for an `extends` one) or it changes nothing.
pub(crate) fn counter_style_rule(name: &str, body: &str, write: Option<(&str, &str)>) -> Option<(String, String, Vec<String>)> {
    let descriptor = |name: &str| {
        let mut input = ParserInput::new(name);
        Parser::new(&mut input).parse_entirely(|p| DescriptorId::parse(p)).ok()
    };
    let mut input = ParserInput::new(name);
    let name = Parser::new(&mut input).parse_entirely(|p| parse_counter_style_name_definition(p)).ok()?;
    let url = crate::cssom_decl::url_data("about:blank");
    let context = crate::cssom_decl::rule_context(&url, CssRuleType::CounterStyle, false);
    let mut input = ParserInput::new(body);
    let mut parser = Parser::new(&mut input);
    let location = parser.current_source_location();
    let mut rule = parse_counter_style_body(name, &context, &mut parser, location).ok()?;
    if let Some((id, value)) = write {
        let mut input = ParserInput::new(value);
        if !rule.set_descriptor(descriptor(id)?, &context, &mut Parser::new(&mut input)).ok()? {
            return None;
        }
    }
    let lock = SharedRwLock::new();
    let mut css = String::new();
    rule.to_css(&lock.read(), &mut css).ok()?;
    let mut body = String::new();
    rule.descriptors().to_css(&mut CssWriter::new(&mut body)).ok()?;
    let values = COUNTER_STYLE_DESCRIPTORS
        .iter()
        .map(|name| {
            let mut out = String::new();
            if let Some(id) = descriptor(name) {
                let _ = rule.descriptors().get(id, &mut out);
            }
            out
        })
        .collect();
    Some((css, body.trim_end().to_owned(), values))
}
