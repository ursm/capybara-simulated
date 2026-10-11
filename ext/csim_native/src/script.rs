// The script element (HTML §4.12.1): what its type is — "prepare the script element" steps 8-12, which decide whether
// and as what it runs — the engine's to say from its attributes, and its flags the engine's to keep. Running it, fetching
// it, the bindings'.

use crate::dom::{dom, nid_arg, NodeData, NodeId, NodeKind, RealmArena};

// What a script element's type is: none it runs as (a data block), a classic script, a module script, an import map,
// speculation rules.
pub(crate) const DATA_BLOCK: u32 = 0;
pub(crate) const CLASSIC: u32 = 1;
pub(crate) const MODULE: u32 = 2;
pub(crate) const IMPORT_MAP: u32 = 3;
pub(crate) const SPECULATION_RULES: u32 = 4;

// A script element's flags (`NodeData::script_flags`): HTML's "already started", its parser document (parser-inserted),
// "force async" — which it is made with, so the bit says it is not — and whether the driver's after-parse pass has run it.
pub(crate) const SCRIPT_ALREADY_STARTED: u8 = 1;
pub(crate) const SCRIPT_PARSER_INSERTED: u8 = 1 << 1;
pub(crate) const SCRIPT_NOT_FORCE_ASYNC: u8 = 1 << 2;
pub(crate) const SCRIPT_RUN: u8 = 1 << 3;

// The JavaScript MIME type essences (MIME Sniffing §4.6), each matched ASCII case-insensitively.
const JAVASCRIPT_MIME_TYPES: [&str; 16] = [
    "application/ecmascript",
    "application/javascript",
    "application/x-ecmascript",
    "application/x-javascript",
    "text/ecmascript",
    "text/javascript",
    "text/javascript1.0",
    "text/javascript1.1",
    "text/javascript1.2",
    "text/javascript1.3",
    "text/javascript1.4",
    "text/javascript1.5",
    "text/jscript",
    "text/livescript",
    "text/x-ecmascript",
    "text/x-javascript",
];

// HTML "prepare the script element" steps 8-12: the script block's type string — `text/javascript` for an empty `type`,
// or none with an empty or no `language`; the `type`, else `text/` and the `language` — its ASCII whitespace stripped,
// then what it is.
pub(crate) fn script_type(n: &NodeData) -> u32 {
    let given = match (n.plain_attr("type"), n.plain_attr("language")) {
        (Some(""), _) | (None, None | Some("")) => return CLASSIC,
        (Some(t), _) => t.to_owned(),
        (None, Some(l)) => format!("text/{l}"),
    };
    let ty = given.trim_matches(|c: char| matches!(c, '\t' | '\n' | '\x0c' | '\r' | ' '));
    if JAVASCRIPT_MIME_TYPES.iter().any(|m| m.eq_ignore_ascii_case(ty)) {
        CLASSIC
    } else if ty.eq_ignore_ascii_case("module") {
        MODULE
    } else if ty.eq_ignore_ascii_case("importmap") {
        IMPORT_MAP
    } else if ty.eq_ignore_ascii_case("speculationrules") {
        SPECULATION_RULES
    } else {
        DATA_BLOCK
    }
}

// What preparing a script element (`prepare`) found it is to do: nothing; fire `error` (an empty `src`); run as a classic
// script; run as a module script — inline, or from its `src`, which the bindings fetch.
pub(crate) const PREPARE_NONE: u32 = 0;
pub(crate) const PREPARE_ERROR: u32 = 1;
pub(crate) const PREPARE_CLASSIC: u32 = 2;
pub(crate) const PREPARE_MODULE: u32 = 3;

impl RealmArena {
    // HTML "prepare the script element" for one no parser is preparing — its children changed, it was connected, its
    // `src` set — as far as the element decides it: an "already started" one, one with neither a `src` nor child text, one
    // not connected, and one whose type runs as nothing here (a data block; an import map or speculation rules, which
    // only a parse registers) do nothing; any other is "already started" from here (and run by the after-parse pass's
    // reckoning), and does nothing as a classic script marked `nomodule`, fires `error` with an empty `src`, and else runs.
    // (…and, `scripting` false — its node document has no browsing context — "already started" and nothing more: step 19)
    pub(crate) fn prepare_script(&mut self, id: NodeId, scripting: bool) -> u32 {
        let Some(n) = self.get(id) else { return PREPARE_NONE };
        if n.script_flags & SCRIPT_ALREADY_STARTED != 0 {
            return PREPARE_NONE;
        }
        let src = n.plain_attr("src").map(str::is_empty);
        let has_text = n.children.iter().any(|&c| self.get(c).is_some_and(|t| t.kind == NodeKind::Text && !t.data.is_empty()));
        if (src.is_none() && !has_text) || !self.is_connected(id) {
            return PREPARE_NONE;
        }
        let Some(n) = self.get(id) else { return PREPARE_NONE };
        let ty = script_type(n);
        if ty != CLASSIC && ty != MODULE {
            return PREPARE_NONE;
        }
        let nomodule = ty == CLASSIC && n.plain_attr("nomodule").is_some();
        if let Some(n) = self.get_mut_quietly(id) {
            n.script_flags |= SCRIPT_ALREADY_STARTED | SCRIPT_RUN;
        }
        match (nomodule || !scripting, src, ty) {
            (true, _, _) => PREPARE_NONE,
            (_, Some(true), _) => PREPARE_ERROR,
            (_, _, MODULE) => PREPARE_MODULE,
            _ => PREPARE_CLASSIC,
        }
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "scriptType", script_type_op, context_id);
    crate::dom::register(scope, ns, "scriptFlags", script_flags_op, context_id);
    crate::dom::register(scope, ns, "setScriptFlags", set_script_flags_op, context_id);
    crate::dom::register(scope, ns, "prepareScript", prepare_script_op, context_id);
}

// __dom.scriptType(nid) -> what the script element's type is (`script_type`: `DATA_BLOCK`, `CLASSIC`, …).
fn script_type_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_uint32(DATA_BLOCK) };
    rv.set_uint32(dom(scope).arena.get(id).map_or(DATA_BLOCK, script_type));
}

// __dom.scriptFlags(nid) -> the script element's flags (`SCRIPT_*`).
fn script_flags_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_uint32(0) };
    rv.set_uint32(dom(scope).arena.get(id).map_or(0, |n| u32::from(n.script_flags)));
}

// __dom.setScriptFlags(nid, mask, bits) — the script element's flags under `mask` become `bits`.
fn set_script_flags_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let mask = args.get(1).uint32_value(scope).unwrap_or(0) as u8;
    let bits = args.get(2).uint32_value(scope).unwrap_or(0) as u8;
    // (…no input to any memo of the arena, nor to a layout: a write that moves none)
    if let Some(n) = dom(scope).arena.get_mut_quietly(id) {
        n.script_flags = (n.script_flags & !mask) | (bits & mask);
    }
}

// __dom.prepareScript(nid, scripting) -> what preparing the script element found it is to do (`prepare_script`: `PREPARE_NONE`, …).
fn prepare_script_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_uint32(PREPARE_NONE) };
    let cid = crate::dom::realm_id(scope, &args);
    let scripting = args.get(1).is_true();
    rv.set_uint32(crate::dom::realm(scope, cid).prepare_script(id, scripting));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::{NodeData, NodeKind};

    fn script(attrs: &[(&str, &str)]) -> NodeData {
        let mut n = NodeData::of_kind(NodeKind::Element, Vec::new());
        n.local_name = "script".into();
        n.attributes = attrs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        n
    }

    #[test]
    fn types_a_script_as_prepare_the_script_element_does() {
        assert_eq!(script_type(&script(&[])), CLASSIC);
        assert_eq!(script_type(&script(&[("type", "")])), CLASSIC);
        assert_eq!(script_type(&script(&[("language", "")])), CLASSIC);
        assert_eq!(script_type(&script(&[("type", " Text/JavaScript\\n")])), DATA_BLOCK);
        assert_eq!(script_type(&script(&[("type", " Text/JavaScript\n")])), CLASSIC);
        assert_eq!(script_type(&script(&[("type", "text/jscript")])), CLASSIC);
        assert_eq!(script_type(&script(&[("type", "text/javascript; charset=utf-8")])), DATA_BLOCK);
        assert_eq!(script_type(&script(&[("language", "JavaScript1.5")])), CLASSIC);
        assert_eq!(script_type(&script(&[("language", "vbscript")])), DATA_BLOCK);
        assert_eq!(script_type(&script(&[("type", "MODULE")])), MODULE);
        assert_eq!(script_type(&script(&[("type", "importmap")])), IMPORT_MAP);
        assert_eq!(script_type(&script(&[("type", "speculationrules")])), SPECULATION_RULES);
        assert_eq!(script_type(&script(&[("type", "text/template")])), DATA_BLOCK);
    }
}
