// Whether a nested document's origin is sandboxed to an opaque one (HTML §7.6.5 "sandboxing flag set", CSP 3 `sandbox`):
// its container's `sandbox` attribute and every `sandbox` directive of its response's Content-Security-Policy restrict
// it, so it keeps its own origin only where every one of them that sandboxes it grants `allow-same-origin`.

const ASCII_WS: [char; 5] = ['\t', '\n', '\x0c', '\r', ' '];

// A sandbox token list (the attribute's value, a directive's value): whether it grants `allow-same-origin`, its tokens
// split on ASCII whitespace and compared ASCII case-insensitively.
fn allows_same_origin(tokens: &str) -> bool {
    tokens.split(ASCII_WS).any(|t| t.eq_ignore_ascii_case("allow-same-origin"))
}

// The `sandbox` directives a Content-Security-Policy header value declares: one per policy — its comma-separated
// policies all apply — the first `sandbox` of its `;`-separated directives, its value ('' for a bare one: every
// restriction, nothing granted).
fn csp_sandbox_directives(header: &str) -> Vec<&str> {
    header
        .split(',')
        .filter_map(|policy| {
            policy.split(';').find_map(|directive| {
                let directive = directive.trim_matches(ASCII_WS);
                let (name, value) = directive.split_once(ASCII_WS).unwrap_or((directive, ""));
                name.eq_ignore_ascii_case("sandbox").then(|| value.trim_matches(ASCII_WS))
            })
        })
        .collect()
}

// Whether a document its container's `sandbox` attribute (None for none) and its response's CSP (None for none)
// sandbox has an opaque origin.
pub(crate) fn opaque_origin(csp: Option<&str>, attribute: Option<&str>) -> bool {
    let mut sources = csp.map(csp_sandbox_directives).unwrap_or_default();
    sources.extend(attribute);
    !sources.is_empty() && !sources.iter().all(|s| allows_same_origin(s))
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "sandboxedOpaque", opaque_op, context_id);
}
// __dom.sandboxedOpaque(cspHeader, sandboxAttribute) -> `opaque_origin` (null for either none).
fn opaque_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = |scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>| (!v.is_null_or_undefined()).then(|| v.to_rust_string_lossy(scope));
    let csp = text(scope, args.get(0));
    let attribute = text(scope, args.get(1));
    rv.set_bool(opaque_origin(csp.as_deref(), attribute.as_deref()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sandbox_restricts_unless_every_source_grants_the_origin() {
        assert!(!opaque_origin(None, None));
        assert!(opaque_origin(None, Some("")));
        assert!(!opaque_origin(None, Some("allow-scripts ALLOW-SAME-ORIGIN")));
        assert!(opaque_origin(Some("default-src 'self'; SANDBOX allow-scripts"), None));
        assert!(!opaque_origin(Some("sandbox allow-same-origin; sandbox"), None));
        assert!(opaque_origin(Some("sandbox allow-same-origin, sandbox"), Some("allow-same-origin")));
        assert!(!opaque_origin(Some("script-src 'none'"), None));
    }
}
