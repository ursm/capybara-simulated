// DOMTokenList (DOM §7.1): the ordered set of tokens an attribute holds — `class`, `rel`, `sandbox`, … — read from the
// arena's copy of the attribute, and the value the update steps would write back. The write itself is the page side's
// (`setAttribute`, whose mutation records and reactions are its callbacks): an edit answers the value to write, or none
// where the steps write nothing.
//
// Tokens are UTF-16 code units, as the attribute holds them (a lone surrogate included), split on ASCII whitespace.

use crate::dom::{nid_arg, realm_id, utf16_arg, utf16_value};
use crate::validity::is_ascii_ws_unit as ascii_whitespace;

// The attribute's ordered set: its tokens, each once, in the order they first appear.
fn ordered_set(value: &[u16]) -> Vec<Vec<u16>> {
    let mut out: Vec<Vec<u16>> = Vec::new();
    for token in value.split(|&u| ascii_whitespace(u)).filter(|t| !t.is_empty()) {
        if !out.iter().any(|t| t == token) {
            out.push(token.to_vec());
        }
    }
    out
}

// Ordered-set "replace" (Infra) of the token at `i` by `new`: the first instance of either is `new`, the others go.
fn replace_at(set: &mut Vec<Vec<u16>>, i: usize, new: &[u16]) {
    set[i] = new.to_vec();
    let mut seen = 0;
    set.retain(|t| t != new || {
        seen += 1;
        seen == 1
    });
}

// The ordered set serializer: the tokens joined by a space.
fn serialize(set: &[Vec<u16>]) -> Vec<u16> {
    let mut out = Vec::new();
    for (i, t) in set.iter().enumerate() {
        if i > 0 {
            out.push(0x20);
        }
        out.extend_from_slice(t);
    }
    out
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    use crate::dom::register;
    register(scope, ns, "tokenListLength", token_list_length, context_id);
    register(scope, ns, "tokenListItem", token_list_item, context_id);
    register(scope, ns, "tokenListContains", token_list_contains, context_id);
    register(scope, ns, "tokenListEdit", token_list_edit, context_id);
    register(scope, ns, "tokenListSupports", token_list_supports, context_id);
    register(scope, ns, "linkTypes", link_types_op, context_id);
    register(scope, ns, "linkNoopener", link_noopener_op, context_id);
}

// The link types a `rel` value names (HTML §4.6.7), ASCII case-insensitively, as `LINK_*` bits: what a `<link>`
// obtains (a style sheet, a prefetch, a preload, a module preload, a manifest), whether a sheet is an alternate one,
// and what following a hyperlink does with its opener and its referrer.
pub(crate) const LINK_STYLESHEET: u32 = 1;
pub(crate) const LINK_ALTERNATE: u32 = 1 << 1;
pub(crate) const LINK_PREFETCH: u32 = 1 << 2;
pub(crate) const LINK_PRELOAD: u32 = 1 << 3;
pub(crate) const LINK_MODULEPRELOAD: u32 = 1 << 4;
pub(crate) const LINK_MANIFEST: u32 = 1 << 5;
pub(crate) const LINK_OPENER: u32 = 1 << 6;
pub(crate) const LINK_NOOPENER: u32 = 1 << 7;
pub(crate) const LINK_NOREFERRER: u32 = 1 << 8;
const LINK_TYPES: [(&str, u32); 9] = [
    ("stylesheet", LINK_STYLESHEET),
    ("alternate", LINK_ALTERNATE),
    ("prefetch", LINK_PREFETCH),
    ("preload", LINK_PRELOAD),
    ("modulepreload", LINK_MODULEPRELOAD),
    ("manifest", LINK_MANIFEST),
    ("opener", LINK_OPENER),
    ("noopener", LINK_NOOPENER),
    ("noreferrer", LINK_NOREFERRER),
];
pub(crate) fn link_types(rel: &str) -> u32 {
    rel.split(|c: char| c.is_ascii_whitespace())
        .filter_map(|t| LINK_TYPES.iter().find(|(name, _)| name.eq_ignore_ascii_case(t)))
        .fold(0, |types, &(_, bit)| types | bit)
}
// HTML "get an element's noopener": whether a hyperlink or a form of link types `types` opening a browsing context named
// by `target` opens it with no opener — where its link types include `noopener` or `noreferrer`, or where they do not
// include `opener` and the target is `_blank` (a named target keeps its opener).
pub(crate) fn noopener(types: u32, target: &str) -> bool {
    types & (LINK_NOOPENER | LINK_NOREFERRER) != 0 || (types & LINK_OPENER == 0 && crate::navigables::target_keyword(target) == crate::navigables::TARGET_BLANK)
}
// …for the host: a `rel` value's, and whether it has `noreferrer` (a referrer, a Referer, none).
pub(crate) fn noopener_for_ruby(rel: String, target: String) -> bool {
    noopener(link_types(&rel), &target)
}
pub(crate) fn noreferrer_for_ruby(rel: String) -> bool {
    link_types(&rel) & LINK_NOREFERRER != 0
}
// __dom.linkTypes(rel) -> `link_types` of a `rel` value.
fn link_types_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let rel = args.get(0).to_rust_string_lossy(scope);
    rv.set_uint32(link_types(&rel));
}

// __dom.linkNoopener(rel, target) -> `noopener` of a `rel` value and a target.
fn link_noopener_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (rel, target) = (args.get(0).to_rust_string_lossy(scope), args.get(1).to_rust_string_lossy(scope));
    rv.set_bool(noopener(link_types(&rel), &target));
}

// HTML's "supported tokens" of an element's attribute's DOMTokenList, by the element's local name: the keywords the
// engine registers (Chromium 148's, measured — a strict subset of those merely valid on the attribute, as a feature-detect
// must see: Vite's boot-time `link.relList.supports('modulepreload')`) — none where the attribute defines none
// (`class`), which `supports()` throws for.
fn supported_tokens(local_name: &str, attr: &str) -> Option<&'static [&'static str]> {
    match (attr, local_name) {
        ("rel", "link") => Some(&[
            "alternate", "canonical", "dns-prefetch", "icon", "manifest", "modulepreload", "next", "preconnect", "prefetch",
            "preload", "stylesheet", "apple-touch-icon",
        ]),
        // (…a / area / form relLists reflect the same three hyperlink keywords)
        ("rel", "a" | "area" | "form") => Some(&["noopener", "noreferrer", "opener"]),
        ("sandbox", "iframe") => Some(&[
            "allow-downloads", "allow-forms", "allow-modals", "allow-orientation-lock", "allow-pointer-lock", "allow-popups",
            "allow-popups-to-escape-sandbox", "allow-presentation", "allow-same-origin", "allow-scripts",
            "allow-storage-access-by-user-activation", "allow-top-navigation", "allow-top-navigation-by-user-activation",
        ]),
        // (…the `blocking` attribute's only one: render-blocking)
        ("blocking", "link" | "script" | "style") => Some(&["render"]),
        _ => None,
    }
}
// __dom.tokenListSupports(nid, name, token) -> whether the token, ASCII-lowercased, is one of the attribute's supported
// tokens — undefined where it has none (`supports()` throws).
fn token_list_supports(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let attr = args.get(1).to_rust_string_lossy(scope);
    let token = args.get(2).to_rust_string_lossy(scope).to_ascii_lowercase();
    let cid = realm_id(scope, &args);
    let Some(local) = crate::dom::realm(scope, cid).get(id).map(|n| n.local_name.to_string()) else { return };
    if let Some(supported) = supported_tokens(&local, &attr) {
        rv.set_bool(supported.contains(&token.as_str()));
    }
}

// The element `nid`'s attribute `name` (arg 1), as written, or None where it has none.
fn value(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> Option<Vec<u16>> {
    let id = nid_arg(scope, args, 0)?;
    let name = args.get(1).to_rust_string_lossy(scope);
    let cid = realm_id(scope, args);
    crate::dom::realm(scope, cid).get(id)?.plain_attr_units(&name)
}

// __dom.tokenListLength(nid, name) -> how many tokens the attribute's set holds.
fn token_list_length(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let n = value(scope, &args).map_or(0, |v| ordered_set(&v).len());
    rv.set_uint32(n as u32);
}

// __dom.tokenListItem(nid, name, index) -> the set's token at `index`, or null past its end.
fn token_list_item(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let index = args.get(2).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    match value(scope, &args).and_then(|v| ordered_set(&v).into_iter().nth(index)) {
        Some(t) => {
            let s = utf16_value(scope, &t);
            rv.set(s);
        }
        None => rv.set_null(),
    }
}

// __dom.tokenListContains(nid, name, token) -> whether the set holds `token`.
fn token_list_contains(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let token = utf16_arg(scope, args.get(2));
    // (…never the empty token: the set holds none, however many separators the attribute runs)
    let yes = !token.is_empty() && value(scope, &args).is_some_and(|v| v.split(|&u| ascii_whitespace(u)).any(|t| t == &token[..]));
    rv.set_bool(yes);
}

const ADD: u32 = 0;
const REMOVE: u32 = 1;
const TOGGLE: u32 = 2;
const REPLACE: u32 = 3;

// Why an edit's tokens refuse it (DOM §7.1, each method's steps 1-2), with the index of the token that does: one that is
// the empty string (`EMPTY_TOKEN`, a SyntaxError), else one with ASCII whitespace in it (`SPACED_TOKEN`, an
// InvalidCharacterError) — each token in turn, but `replace`'s both for emptiness before either for whitespace.
const EMPTY_TOKEN: u32 = 1;
const SPACED_TOKEN: u32 = 2;
fn refusal(op: u32, tokens: &[Vec<u16>]) -> Option<(u32, usize)> {
    let why = |t: &Vec<u16>| if t.is_empty() { Some(EMPTY_TOKEN) } else if t.iter().any(|&u| ascii_whitespace(u)) { Some(SPACED_TOKEN) } else { None };
    if op == REPLACE {
        if let Some(i) = tokens.iter().position(Vec::is_empty) {
            return Some((EMPTY_TOKEN, i));
        }
    }
    tokens.iter().enumerate().find_map(|(i, t)| why(t).map(|w| (w, i)))
}
// __dom.tokenListEdit(nid, name, op, tokens, force) -> [result, value] — or [undefined, undefined, why, index] for tokens
// that refuse it (`refusal`): `add` (op 0) / `remove` (1) of `tokens`, `toggle` (2) of `tokens[0]` — `force` true, false
// or undefined — or `replace` (3) of `tokens[0]` by `tokens[1]`; `result` the method's (toggle's and replace's booleans),
// `value` what the update steps write, or undefined where they write nothing (an absent attribute and an empty set; a
// replace of a token the set lacks).
fn token_list_edit(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let op = args.get(2).uint32_value(scope).unwrap_or(ADD);
    let mut tokens: Vec<Vec<u16>> = Vec::new();
    if let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(3)) {
        for i in 0..list.length() {
            if let Some(v) = list.get_index(scope, i) {
                tokens.push(utf16_arg(scope, v));
            }
        }
    }
    let force = args.get(4);
    let force = if force.is_undefined() { None } else { Some(force.boolean_value(scope)) };
    if let Some((refused, index)) = refusal(op, &tokens) {
        let items = [v8::undefined(scope).into(), v8::undefined(scope).into(), v8::Integer::new_from_unsigned(scope, refused).into(), v8::Integer::new_from_unsigned(scope, index as u32).into()];
        return rv.set(v8::Array::new_with_elements(scope, &items).into());
    }
    let current = value(scope, &args);
    let present = current.is_some();
    let mut set = current.map_or(Vec::new(), |v| ordered_set(&v));
    let mut result = true;
    let mut write = true;
    match op {
        ADD => {
            for t in tokens {
                if !set.contains(&t) {
                    set.push(t);
                }
            }
        }
        REMOVE => set.retain(|t| !tokens.contains(t)),
        TOGGLE => {
            let Some(token) = tokens.into_iter().next() else { return };
            match set.iter().position(|t| *t == token) {
                Some(i) if force != Some(true) => {
                    set.remove(i);
                    result = false;
                }
                Some(_) => write = false,
                None if force != Some(false) => set.push(token),
                None => {
                    result = false;
                    write = false;
                }
            }
        }
        REPLACE => {
            let (Some(token), Some(new)) = (tokens.first(), tokens.get(1)) else { return };
            match set.iter().position(|t| t == token) {
                Some(i) => replace_at(&mut set, i, new),
                None => {
                    result = false;
                    write = false;
                }
            }
        }
        _ => return,
    }
    // (…and nothing written for an absent attribute whose set stays empty: update steps 1)
    if !present && set.is_empty() {
        write = false;
    }
    let result: v8::Local<v8::Value> = v8::Boolean::new(scope, result).into();
    let value: v8::Local<v8::Value> = if write { utf16_value(scope, &serialize(&set)) } else { v8::undefined(scope).into() };
    rv.set(v8::Array::new_with_elements(scope, &[result, value]).into());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }
    fn set(s: &str) -> Vec<Vec<u16>> {
        ordered_set(&u(s))
    }

    #[test]
    fn an_ordered_set_splits_on_ascii_whitespace_only_and_keeps_the_first_of_each() {
        assert_eq!(set("  a\tb a\u{a0}c  b "), vec![u("a"), u("b"), u("a\u{a0}c")]);
        assert!(set(" \n ").is_empty());
    }

    #[test]
    fn an_edit_is_refused_for_an_empty_token_then_a_spaced_one() {
        assert_eq!(refusal(ADD, &[u("a"), u("b c"), u("")]), Some((SPACED_TOKEN, 1)));
        assert_eq!(refusal(ADD, &[u("a"), u("")]), Some((EMPTY_TOKEN, 1)));
        // (…replace's both for emptiness first)
        assert_eq!(refusal(REPLACE, &[u(" "), u("")]), Some((EMPTY_TOKEN, 1)));
        assert_eq!(refusal(REPLACE, &[u("a"), u("b\tc")]), Some((SPACED_TOKEN, 1)));
        assert_eq!(refusal(TOGGLE, &[u("\u{a0}")]), None);
    }
    #[test]
    fn a_replace_keeps_the_first_instance_of_either_token() {
        let mut s = set("a b c");
        replace_at(&mut s, 2, &u("a"));
        assert_eq!(serialize(&s), u("a b"));
        let mut s = set("a b c");
        replace_at(&mut s, 0, &u("c"));
        assert_eq!(serialize(&s), u("c b"));
    }
}
