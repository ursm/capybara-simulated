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

// __dom.tokenListEdit(nid, name, op, tokens, force) -> [result, value]: `add` (op 0) / `remove` (1) of `tokens`, `toggle`
// (2) of `tokens[0]` — `force` true, false or undefined — or `replace` (3) of `tokens[0]` by `tokens[1]`, the tokens
// checked already; `result` the method's (toggle's and replace's booleans), `value` what the update steps write, or
// undefined where they write nothing (an absent attribute and an empty set; a replace of a token the set lacks).
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
    fn a_replace_keeps_the_first_instance_of_either_token() {
        let mut s = set("a b c");
        replace_at(&mut s, 2, &u("a"));
        assert_eq!(serialize(&s), u("a b"));
        let mut s = set("a b c");
        replace_at(&mut s, 0, &u("c"));
        assert_eq!(serialize(&s), u("c b"));
    }
}
