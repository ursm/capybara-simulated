// The script element (HTML §4.12.1): what its type is — "prepare the script element" steps 8-12, which decide whether
// and as what it runs — the engine's to say from its attributes. Running it, fetching it, the bindings'.

use crate::dom::{dom, nid_arg, NodeData};

// What a script element's type is: none it runs as (a data block), a classic script, a module script, an import map,
// speculation rules.
pub(crate) const DATA_BLOCK: u32 = 0;
pub(crate) const CLASSIC: u32 = 1;
pub(crate) const MODULE: u32 = 2;
pub(crate) const IMPORT_MAP: u32 = 3;
pub(crate) const SPECULATION_RULES: u32 = 4;

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

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "scriptType", script_type_op, context_id);
}

// __dom.scriptType(nid) -> what the script element's type is (`script_type`: `DATA_BLOCK`, `CLASSIC`, …).
fn script_type_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_uint32(DATA_BLOCK) };
    rv.set_uint32(dom(scope).arena.get(id).map_or(DATA_BLOCK, script_type));
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
