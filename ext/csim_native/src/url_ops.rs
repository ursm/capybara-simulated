// URLs, parsed and set by the URL Standard's own algorithms: Ada (`ada-url`, Node.js's URL parser, which passes the
// standard's tests — Servo's `url` crate fails ~300 of them, file URLs and opaque paths mostly). The page side keeps a
// URL as the parts these return, read without a crossing, and crosses only to parse one or to set one of its parts.
//
// A URL's parts, in this order (`parts`): href, protocol, username, password, host, hostname, port, pathname, search,
// hash, origin — the interface's attributes.

use ada_url::Url;

use crate::dom::register;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "urlParse", url_parse, context_id);
    register(scope, ns, "urlSet", url_set, context_id);
    register(scope, ns, "urlIsFragmentNavigation", url_is_fragment_navigation, context_id);
    register(scope, ns, "urlCanRewrite", url_can_rewrite, context_id);
    register(scope, ns, "locationSet", location_set_op, context_id);
    register(scope, ns, "postMessageTarget", post_message_target_op, context_id);
    register(scope, ns, "postMessageReaches", post_message_reaches_op, context_id);
    register(scope, ns, "urlencodedParse", urlencoded_parse, context_id);
    register(scope, ns, "javascriptUrlSource", javascript_url_source_op, context_id);
    register(scope, ns, "metaReferrerPolicy", meta_referrer_policy_op, context_id);
    register(scope, ns, "hyperlinkReferrerPolicy", hyperlink_referrer_policy_op, context_id);
    register(scope, ns, "elementTarget", element_target_op, context_id);
    register(scope, ns, "formActionUrl", form_action_url, context_id);
}

// A URL's parts, in `parts`' order.
pub(crate) fn texts(url: &Url) -> [String; 11] {
    [
        url.href(),
        url.protocol(),
        url.username(),
        url.password(),
        url.host(),
        url.hostname(),
        url.port(),
        url.pathname(),
        url.search(),
        url.hash(),
        &url.origin(),
    ]
    .map(str::to_owned)
}

// The parts of the URL `input` parses to (against `base`, given one) — or nil where it does not parse: for the host,
// which resolves the URL a `visit` names, and reads the current one, as the page would (`|` kept in a query, a space in
// a path `%20`, …).
pub(crate) fn parts_for_ruby(input: String, base: Option<String>) -> Option<Vec<String>> {
    Url::parse(input.as_str(), base.as_deref()).ok().map(|url| texts(&url).into())
}

pub(crate) fn parts<'s>(scope: &mut v8::PinScope<'s, '_>, url: &Url) -> v8::Local<'s, v8::Array> {
    let items: Vec<v8::Local<v8::Value>> = texts(url)
        .iter()
        .map(|t| v8::String::new(scope, t).map_or_else(|| v8::undefined(scope).into(), Into::into))
        .collect();
    v8::Array::new_with_elements(scope, &items)
}

// The string a page's value is as a USVString: a lone surrogate is U+FFFD (WebIDL), which the lossy conversion does.
pub(crate) fn usv(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> String {
    value.to_rust_string_lossy(scope)
}

// __dom.urlParse(input, base, encoding) -> parts, or null when it does not parse (nor its base, given one). `encoding`
// (a label, null for UTF-8) is the document's: HTML's "encoding-parse a URL" percent-encodes the QUERY in it.
fn url_parse(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let input = usv(scope, args.get(0));
    let base = (!args.get(1).is_null_or_undefined()).then(|| usv(scope, args.get(1)));
    let label = (!args.get(2).is_null_or_undefined()).then(|| usv(scope, args.get(2)));
    let Some(url) = encoding_parse(&input, base.as_deref(), label.as_deref()) else { return rv.set_null() };
    let parts = parts(scope, &url);
    rv.set(parts.into());
}
// HTML's "encoding-parse a URL": `input` parsed against `base`, its query percent-encoded in the encoding `label` names
// (none, or UTF-8, as the parser does it).
pub(crate) fn encoding_parse(input: &str, base: Option<&str>, label: Option<&str>) -> Option<Url> {
    let mut url = Url::parse(input, base).ok()?;
    if let Some(encoding) = query_encoding(&url, label) {
        encode_query_in(&mut url, input, encoding);
    }
    Some(url)
}

// HTML "mutate action URL" of a GET form submission: `action` with its query the entry list's serialization `query` —
// set whatever query it had, so an empty list leaves a bare `?` (browsers navigate to `action?`) — and its fragment kept.
// On the text, which is an action's serialization (or, the host's, the attribute as written): the first `#` ends the
// part the query is set in, and the first `?` before it begins the query.
pub(crate) fn mutated_action_url(action: &str, query: &str) -> String {
    let (base, fragment) = action.split_once('#').map_or((action, None), |(b, f)| (b, Some(f)));
    let path = base.split_once('?').map_or(base, |(p, _)| p);
    match fragment {
        Some(fragment) => format!("{path}?{query}#{fragment}"),
        None => format!("{path}?{query}"),
    }
}
pub(crate) fn mutated_action_url_for_ruby(action: String, query: String) -> String {
    mutated_action_url(&action, &query)
}
// __dom.formActionUrl(action, query) -> `mutated_action_url`.
fn form_action_url(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (action, query) = (usv(scope, args.get(0)), usv(scope, args.get(1)));
    if let Some(s) = v8::String::new(scope, &mutated_action_url(&action, &query)) {
        rv.set(s.into());
    }
}

// The referrer policy tokens (Referrer Policy §3).
const POLICIES: [&str; 8] = [
    "no-referrer",
    "no-referrer-when-downgrade",
    "same-origin",
    "origin",
    "strict-origin",
    "origin-when-cross-origin",
    "strict-origin-when-cross-origin",
    "unsafe-url",
];

impl crate::dom::RealmArena {
    // The `target` of the first `<base>` with one in document `doc`'s tree, in tree order (a shadow tree's none) — what a
    // hyperlink or a form of that node document with no target of its own opens in (HTML "get an element's target").
    pub(crate) fn base_target(&self, doc: crate::dom::NodeId) -> Option<Vec<u16>> {
        let mut stack = vec![doc];
        while let Some(c) = stack.pop() {
            let n = self.get(c)?;
            if n.is_html_named("base") {
                if let Some(t) = n.plain_attr_units("target") {
                    return Some(t);
                }
            }
            stack.extend(n.children.iter().rev());
        }
        None
    }
}
// …of `id`'s node document — a detached element's and a shadow tree's too.
pub(crate) fn node_base_target(scope: &mut v8::PinScope<'_, '_>, id: crate::dom::NodeId) -> Option<Vec<u16>> {
    let doc = crate::editing::document_of(scope, id)?;
    let doc = crate::node_handle::nid_of(scope, doc.into())?;
    crate::dom::dom(scope).arena.base_target(doc)
}
// __dom.elementTarget(nid) -> HTML "get an element's target" of a hyperlink: its `target`, else its node document's base
// target (`node_base_target`), else ''.
fn element_target_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return rv.set(crate::dom::utf16_value(scope, &[])) };
    let own = crate::dom::dom(scope).arena.get(id).and_then(|n| n.plain_attr_units("target"));
    let target = own.or_else(|| node_base_target(scope, id)).unwrap_or_default();
    rv.set(crate::dom::utf16_value(scope, &target));
}

// The referrer policy a hyperlink is followed under (HTML "follow the hyperlink" steps 8-9): `no-referrer` where its
// link types include `noreferrer`, else its `referrerpolicy` attribute's state — a token matched ASCII
// case-insensitively, '' (the document's policy) for none or an invalid one.
pub(crate) fn hyperlink_referrer_policy(node: &crate::dom::NodeData) -> &'static str {
    if crate::token_list::link_types(node.plain_attr("rel").unwrap_or("")) & crate::token_list::LINK_NOREFERRER != 0 {
        return "no-referrer";
    }
    let attr = node.plain_attr("referrerpolicy").unwrap_or("");
    POLICIES.iter().find(|p| p.eq_ignore_ascii_case(attr)).copied().unwrap_or("")
}
// __dom.hyperlinkReferrerPolicy(nid) -> the policy the hyperlink is followed under (`hyperlink_referrer_policy`).
fn hyperlink_referrer_policy_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    let policy = crate::dom::realm(scope, cid).get(id).map_or("", hyperlink_referrer_policy);
    rv.set(v8::String::new(scope, policy).unwrap().into());
}

// The referrer policy a document's `<meta name="referrer">` elements set (HTML §4.2.5.3, the referrer metadata name):
// each one's `content` ASCII-lowercased — a legacy keyword mapped to its policy (`never`, `default`, `always`,
// `origin-when-crossorigin`) — the last that is a referrer policy token in tree order winning; '' for none.
pub(crate) fn meta_referrer_policy(arena: &crate::dom::RealmArena, doc: crate::dom::NodeId) -> &'static str {
    let mut policy = "";
    arena.find_in_tree(doc, |_, n| {
        if n.is_html_named("meta") && n.plain_attr("name").is_some_and(|v| v.eq_ignore_ascii_case("referrer")) {
            let content = n.plain_attr("content").unwrap_or("").to_ascii_lowercase();
            let content = match content.as_str() {
                "never" => "no-referrer",
                "default" => "no-referrer-when-downgrade",
                "always" => "unsafe-url",
                "origin-when-crossorigin" => "origin-when-cross-origin",
                other => other,
            };
            if let Some(&p) = POLICIES.iter().find(|&&p| p == content) {
                policy = p;
            }
        }
        false
    });
    policy
}
// __dom.metaReferrerPolicy(docNid) -> the policy its `<meta name="referrer">` sets (`meta_referrer_policy`), '' for none.
fn meta_referrer_policy_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(doc) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let cid = crate::dom::realm_id(scope, &args);
    let policy = meta_referrer_policy(crate::dom::realm(scope, cid), doc);
    rv.set(v8::String::new(scope, policy).unwrap().into());
}

// HTML "document base URL": the frozen base URL of the document's first `<base>` with an `href` (element_state.rs
// `base_element`) — its `href` encoding-parsed against the `fallback` base URL in the document's `encoding`, the fallback
// itself where it parses to no URL or to a `data:` or `javascript:` one — else the fallback.
pub(crate) fn document_base_url(arena: &crate::dom::RealmArena, doc: crate::dom::NodeId, fallback: &str, encoding: Option<&str>) -> String {
    let href = arena.base_element(doc).and_then(|b| arena.get(b)).and_then(|b| b.plain_attr("href").map(str::to_owned));
    href.and_then(|href| encoding_parse(&href, Some(fallback), encoding))
        .filter(|url| !matches!(url.protocol(), "data:" | "javascript:"))
        .map_or_else(|| fallback.to_owned(), |url| url.href().to_owned())
}

// The URL's query as the input wrote it, percent-encoded in `encoding` (the parser did it in UTF-8). A query is what
// follows the input's first `?` — no state before the query takes one — up to its `#`; a URL whose query came from its
// base (the input has none of its own) keeps it as it is.
fn encode_query_in(url: &mut Url, input: &str, encoding: &'static encoding_rs::Encoding) {
    if !url.has_search() {
        return;
    }
    // (…the input as the parser reads it: no leading or trailing C0 control or space, no tab or newline anywhere)
    let input: String =
        input.trim_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let Some(start) = input.find('?') else { return };
    if input[..start].contains('#') {
        return;
    }
    let query = input[start + 1..].split('#').next().unwrap_or_default();
    if let Some(encoded) = encoded_query(query, encoding) {
        url.set_search(Some(&encoded));
    }
}
// …`query` so, `?` first: None where it is what the parser's UTF-8 made of it already.
fn encoded_query(query: &str, encoding: &'static encoding_rs::Encoding) -> Option<String> {
    if query.is_ascii() && encoding.is_ascii_compatible() {
        return None;
    }
    let mut encoded = String::from("?");
    for byte in encode(encoding, query) {
        // (…the special-query percent-encode set: C0 controls, space, `"`, `#`, `<`, `>`, `'`, and above `~`)
        let escape = !(0x21..=0x7E).contains(&byte) || matches!(byte, b'"' | b'#' | b'<' | b'>' | b'\'');
        if escape {
            encoded.push_str(&format!("%{byte:02X}"));
        } else {
            encoded.push(byte as char);
        }
    }
    Some(encoded)
}
// …and the encoding a URL's query is in: `label`'s for a special URL, but not a `ws:` / `wss:` one — the query state
// takes UTF-8 for the others whatever the document's encoding (`mailto:…?subject=é` stays `%C3%A9`) — None for UTF-8.
fn query_encoding(url: &Url, label: Option<&str>) -> Option<&'static encoding_rs::Encoding> {
    if !matches!(url.protocol(), "http:" | "https:" | "ftp:" | "file:") {
        return None;
    }
    let encoding = encoding_rs::Encoding::for_label(label?.as_bytes())?.output_encoding();
    (encoding != encoding_rs::UTF_8).then_some(encoding)
}

// `text` in `encoding`, a character it cannot encode written `&#N;` — and that already percent-encoded, as the URL
// Standard's "percent-encode after encoding" has it: "%26%23", its number in decimal, "%3B" (`%` is in no
// percent-encode set, so the bytes pass through as they are).
fn encode(encoding: &'static encoding_rs::Encoding, text: &str) -> Vec<u8> {
    let mut encoder = encoding.new_encoder();
    let mut out = Vec::with_capacity(text.len() + 16);
    let mut rest = text;
    loop {
        let mut buf = [0u8; 256];
        let (result, read, written) = encoder.encode_from_utf8_without_replacement(rest, &mut buf, true);
        out.extend_from_slice(&buf[..written]);
        rest = &rest[read..];
        match result {
            encoding_rs::EncoderResult::InputEmpty => break,
            encoding_rs::EncoderResult::OutputFull => {}
            encoding_rs::EncoderResult::Unmappable(c) => {
                // (…ISO-2022-JP's encoder errors on SO, SI and ESC "with U+FFFD", the Encoding Standard has it)
                let n = if encoding == encoding_rs::ISO_2022_JP && matches!(c, '\u{E}' | '\u{F}' | '\u{1B}') { 0xFFFD } else { u32::from(c) };
                out.extend_from_slice(format!("%26%23{n}%3B").as_bytes());
            }
        }
    }
    out
}

// Whether a URL has an opaque path (URL Standard): one with no host whose path is no list — a pathname not starting
// with "/" (`mailto:x`, `foo:`), where `foo://` has an empty host and `foo:/x` a list.
fn has_opaque_path(url: &Url) -> bool {
    !url.has_hostname() && !url.pathname().starts_with('/')
}

// HTML "navigate" (step "navigate to a fragment"): whether a navigation to `url` from a document at `current` is one to a
// fragment of it — `url` has a fragment (an empty one too: `#`) and equals `current` but for their fragments. Not one
// without a fragment: `/a#x` → `/a` loads the document again, as does assigning a fragmentless URL its own.
pub(crate) fn is_fragment_navigation(current: &str, url: &str) -> bool {
    let (Ok(mut current), Ok(mut url)) = (Url::parse(current, None), Url::parse(url, None)) else { return false };
    if !url.has_hash() {
        return false;
    }
    current.set_hash(None);
    url.set_hash(None);
    current.href() == url.href()
}
fn url_is_fragment_navigation(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (current, url) = (usv(scope, args.get(0)), usv(scope, args.get(1)));
    rv.set_bool(is_fragment_navigation(&current, &url));
}
// …for the host.
pub(crate) fn is_fragment_navigation_for_ruby(current: String, url: String) -> bool {
    is_fragment_navigation(&current, &url)
}

// HTML "can have its URL rewritten": whether a document at `current` may have its URL replaced by `target` — by
// pushState / replaceState — the two alike in scheme, username, password, host and port; an HTTP(S) one in nothing
// more, a file: one in its path too, any other in its path and query as well (only its fragment may change).
pub(crate) fn can_rewrite(current: &str, target: &str) -> bool {
    let (Ok(current), Ok(target)) = (Url::parse(current, None), Url::parse(target, None)) else { return false };
    let same = |f: fn(&Url) -> &str| f(&current) == f(&target);
    if !(same(Url::protocol) && same(Url::username) && same(Url::password) && same(Url::host)) {
        return false;
    }
    match target.protocol() {
        "http:" | "https:" => true,
        "file:" => same(Url::pathname),
        _ => same(Url::pathname) && same(Url::search),
    }
}
// HTML "the Location interface" (§7.2.4): what setting the part `part` — "protocol", "host", "hostname", "port",
// "pathname", "search" or "hash" — of a location whose URL is `current` to `value` does, in a document of the encoding
// `label` names: the URL the location navigates to, as that part's setter steps set it on a copy (the URL Standard's
// state overrides, ada's setters), or none —
//   protocol: `value` and a colon taken as a scheme, which must parse (Err otherwise: a SyntaxError), and a navigation
//     only to an HTTP(S) URL;
//   host, hostname, pathname: none for a URL with an opaque path; port: none for one that cannot have a port (no host,
//     an empty one, or `file:`);
//   search: the query `value` makes, percent-encoded in the document's encoding;
//   hash: none where the fragment comes out what it was — a null one the empty string, so `location.hash = ''` on a URL
//     with none does not navigate (the note there: deployed content sets it redundantly).
pub(crate) fn location_set(current: &str, part: &str, value: &str, label: Option<&str>) -> Result<Option<String>, ()> {
    let Ok(mut url) = Url::parse(current, None) else { return Ok(None) };
    match part {
        "protocol" => {
            // (…the basic URL parser's input: no tab or newline; the scheme start state then the scheme state, which a
            // state override fails on anything but a scheme's characters before the colon)
            let scheme: String = value.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).take_while(|&c| c != ':').collect();
            let mut chars = scheme.chars();
            let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
                && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
            if !valid {
                return Err(());
            }
            // (…a scheme the setter refuses — a special one for a non-special URL or the reverse, `file:` for one with
            // credentials or a port — leaves the copy as it was: no failure, a navigation to the URL itself)
            drop(url.set_protocol(value));
            if !matches!(url.protocol(), "http:" | "https:") {
                return Ok(None);
            }
        }
        "host" | "hostname" | "pathname" if has_opaque_path(&url) => return Ok(None),
        "port" if !url.has_hostname() || url.hostname().is_empty() || url.protocol() == "file:" => return Ok(None),
        "host" => drop(url.set_host(Some(value))),
        "hostname" => drop(url.set_hostname(Some(value))),
        "port" => drop(url.set_port(Some(value))),
        "pathname" => drop(url.set_pathname(Some(value))),
        "search" if value.is_empty() => url.set_search(None),
        "search" => {
            // (…as the basic URL parser reads its input: no tab or newline — ada's setter drops them from what it takes)
            let query: String = value.strip_prefix('?').unwrap_or(value).chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
            match query_encoding(&url, label).and_then(|e| encoded_query(&query, e)) {
                Some(encoded) => url.set_search(Some(&encoded)),
                None => url.set_search(Some(value)),
            }
        }
        "hash" => {
            // (…`#` before the value, its own taken off: the URL interface's setter takes the empty string for no
            // fragment, which this one does not)
            let was = url.hash().to_owned();
            url.set_hash(Some(&format!("#{}", value.strip_prefix('#').unwrap_or(value))));
            if url.hash() == was {
                return Ok(None);
            }
        }
        _ => return Ok(None),
    }
    Ok(Some(url.href().to_owned()))
}
// __dom.locationSet(href, part, value, encoding) -> the URL `location_set` navigates to, null for none; a SyntaxError
// for a protocol that is none.
fn location_set_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (current, value) = (usv(scope, args.get(0)), usv(scope, args.get(2)));
    let part = args.get(1).to_rust_string_lossy(scope);
    let label = args.get(3).is_string().then(|| args.get(3).to_rust_string_lossy(scope));
    match location_set(&current, &part, &value, label.as_deref()) {
        Ok(Some(url)) => match v8::String::new(scope, &url) {
            Some(url) => rv.set(url.into()),
            None => rv.set_null(),
        },
        Ok(None) => rv.set_null(),
        Err(()) => {
            let message = format!("Failed to set the 'protocol' property on 'Location': '{value}' is an invalid protocol.");
            if let Some(message) = v8::String::new(scope, &message) {
                crate::clone::throw_dom_exception(scope, message, "SyntaxError");
            }
        }
    }
}

fn url_can_rewrite(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (current, target) = (usv(scope, args.get(0)), usv(scope, args.get(1)));
    rv.set_bool(can_rewrite(&current, &target));
}

// HTML "window post message steps": the target origin a `targetOrigin` names — "*" and "/" themselves, else the origin
// of the absolute URL it is (serialized: "null" for an opaque one) — None where it is no URL (a SyntaxError).
fn post_message_target(arg: &str) -> Option<String> {
    if arg == "*" || arg == "/" {
        return Some(arg.to_owned());
    }
    Url::parse(arg, None).ok().map(|u| u.origin())
}
// …and whether a message so targeted reaches a window of origin `target` from one of `sender` — origins as their keys:
// a tuple origin its serialization, an opaque one a token of its own, which the windows that share it (one created
// inheriting it) share: "*" any, "/" the sender's own origin, any other the origin it names — never an opaque one,
// which a URL names anew (a `data:` URL's).
fn post_message_reaches(arg: &str, sender: &str, target: &str) -> Option<bool> {
    let wanted = post_message_target(arg)?;
    Some(match wanted.as_str() {
        "*" => true,
        "/" => sender == target,
        origin => origin != "null" && origin == target,
    })
}
// __dom.postMessageTarget(targetOrigin) -> `post_message_target`, or null.
fn post_message_target_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let arg = usv(scope, args.get(0));
    match post_message_target(&arg).and_then(|t| v8::String::new(scope, &t)) {
        Some(t) => rv.set(t.into()),
        None => rv.set_null(),
    }
}
// __dom.postMessageReaches(targetOrigin, senderOriginKey, targetOriginKey) -> 1 it reaches, 0 it does not, -1 the target
// origin is no URL (`post_message_reaches`).
fn post_message_reaches_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (arg, sender, target) = (usv(scope, args.get(0)), usv(scope, args.get(1)), usv(scope, args.get(2)));
    rv.set_int32(post_message_reaches(&arg, &sender, &target).map_or(-1, i32::from));
}

// __dom.urlSet(href, part, value) -> the URL's parts once `part` is set to `value`, as the interface's setter sets it
// (a value it rejects leaves the URL as it was); null when `href` itself does not parse, or — for `href` — `value`
// does not. `part` "query" sets the query to the already-serialized `value` (null: none), the URLSearchParams update
// steps.
fn url_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let href = usv(scope, args.get(0));
    let Ok(mut url) = Url::parse(href.as_str(), None) else { return rv.set_null() };
    let part = args.get(1).to_rust_string_lossy(scope);
    let raw = args.get(2);
    let value = usv(scope, raw);
    let value = Some(value.as_str());
    match part.as_str() {
        "href" => {
            if url.set_href(value.unwrap_or_default()).is_err() {
                return rv.set_null();
            }
        }
        "protocol" => drop(url.set_protocol(value.unwrap_or_default())),
        "username" => drop(url.set_username(value)),
        "password" => drop(url.set_password(value)),
        "host" => drop(url.set_host(value)),
        "hostname" => drop(url.set_hostname(value)),
        "port" => drop(url.set_port(value)),
        "pathname" => drop(url.set_pathname(value)),
        "search" => url.set_search(value),
        "hash" => url.set_hash(value),
        "query" => {
            // (…prefixed with the `?` the setter takes off, so a query that starts with one keeps it)
            let query = (!raw.is_null_or_undefined()).then(|| format!("?{}", value.unwrap_or_default()));
            url.set_search(query.as_deref());
        }
        _ => {}
    }
    let parts = parts(scope, &url);
    rv.set(parts.into());
}

// __dom.urlencodedParse(input) -> [[name, value], …]: the application/x-www-form-urlencoded parser's tuples (URL
// Standard §5.1) of `input`'s UTF-8 bytes — `+` a space, each `%XX` its byte, the bytes UTF-8 decoded without BOM, an
// invalid sequence U+FFFD.
fn urlencoded_parse(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let input = usv(scope, args.get(0));
    let pairs = crate::search_params::parse_pairs(&input);
    rv.set(crate::search_params::pairs_value(scope, &pairs));
}

// The script a `javascript:` URL runs (HTML "evaluate a javascript: URL"): its serialization with the scheme taken off,
// percent-decoded and UTF-8 decoded — an escape that is no UTF-8 U+FFFD, a `%` without two hex digits after it itself.
pub(crate) fn javascript_url_source(href: &str) -> String {
    let encoded = href.get(..11).filter(|s| s.eq_ignore_ascii_case("javascript:")).map_or(href, |_| &href[11..]);
    percent_encoding::percent_decode_str(encoded).decode_utf8_lossy().into_owned()
}
// __dom.javascriptUrlSource(href) -> the script the `javascript:` URL `href` (serialized) runs (`javascript_url_source`).
fn javascript_url_source_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let href = usv(scope, args.get(0));
    if let Some(string) = v8::String::new(scope, &javascript_url_source(&href)) {
        rv.set(string.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_javascript_url_runs_its_percent_decoded_utf8() {
        assert_eq!(javascript_url_source("javascript:f('%41','%')"), "f('A','%')");
        assert_eq!(javascript_url_source("javascript:x=%22%C3%A9%22"), "x=\"é\"");
        assert_eq!(javascript_url_source("javascript:x=%FF%zz%4"), "x=\u{FFFD}%zz%4");
    }

    #[test]
    fn tells_a_url_a_document_may_rewrite_its_own_to() {
        assert!(can_rewrite("https://a.test/p?q#f", "https://a.test/other?z"));
        assert!(!can_rewrite("https://a.test/p", "https://b.test/p"));
        assert!(!can_rewrite("https://a.test/p", "http://a.test/p"));
        assert!(!can_rewrite("https://a.test/p", "https://a.test:8443/p"));
        assert!(!can_rewrite("https://a.test/p", "https://u@a.test/p"));
        assert!(can_rewrite("file:///x/a", "file:///x/a?q"));
        assert!(!can_rewrite("file:///x/a", "file:///x/b"));
        assert!(can_rewrite("about:blank", "about:blank#x"));
        assert!(!can_rewrite("about:blank", "about:blank?q"));
        assert!(!can_rewrite("data:text/html,a", "data:text/html,b"));
    }

    #[test]
    fn tells_a_navigation_to_a_fragment() {
        let at = "https://a.test/p?q#x";
        assert!(is_fragment_navigation(at, "https://a.test/p?q#y"));
        assert!(is_fragment_navigation(at, "https://a.test/p?q#x"));
        assert!(is_fragment_navigation(at, "https://a.test/p?q#"));
        assert!(!is_fragment_navigation(at, "https://a.test/p?q"));
        assert!(!is_fragment_navigation(at, "https://a.test/p?r#x"));
        assert!(!is_fragment_navigation("https://a.test/p", "https://a.test/p"));
        assert!(is_fragment_navigation("https://a.test/p", "https://a.test/p#z"));
    }

    #[test]
    fn a_location_setter_navigates_to_its_copy_with_the_part_set() {
        let at = "https://a.test/p?q#x";
        assert_eq!(location_set(at, "protocol", "http", None), Ok(Some("http://a.test/p?q#x".into())));
        assert_eq!(location_set(at, "protocol", "ftp:x", None), Ok(None));
        assert_eq!(location_set(at, "protocol", "1x", None), Err(()));
        assert_eq!(location_set(at, "protocol", "h\tt tp", None), Err(()));
        assert_eq!(location_set(at, "protocol", "", None), Err(()));
        assert_eq!(location_set(at, "host", "b.test:81", None), Ok(Some("https://b.test:81/p?q#x".into())));
        assert_eq!(location_set("mailto:x", "pathname", "y", None), Ok(None));
        assert_eq!(location_set("file:///p", "port", "81", None), Ok(None));
        assert_eq!(location_set(at, "port", "81", None), Ok(Some("https://a.test:81/p?q#x".into())));
        assert_eq!(location_set(at, "search", "", None), Ok(Some("https://a.test/p#x".into())));
        assert_eq!(location_set(at, "search", "??é#", None), Ok(Some("https://a.test/p??%C3%A9%23#x".into())));
        assert_eq!(location_set(at, "search", "?é", Some("windows-1252")), Ok(Some("https://a.test/p?%E9#x".into())));
        assert_eq!(location_set(at, "search", "\té\n", Some("windows-1252")), Ok(Some("https://a.test/p?%E9#x".into())));
        assert_eq!(location_set("wss://a.test/", "search", "é", Some("windows-1252")), Ok(Some("wss://a.test/?%C3%A9".into())));
        assert_eq!(location_set(at, "hash", "#x", None), Ok(None));
        assert_eq!(location_set(at, "hash", "y", None), Ok(Some("https://a.test/p?q#y".into())));
        assert_eq!(location_set("https://a.test/p", "hash", "", None), Ok(None));
        assert_eq!(location_set(at, "hash", "", None), Ok(Some("https://a.test/p?q#".into())));
    }

    #[test]
    fn a_posted_message_reaches_its_target_origin() {
        assert_eq!(post_message_reaches("*", "opaque:realm1", "https://a"), Some(true));
        assert_eq!(post_message_reaches("/", "https://a", "https://a"), Some(true));
        assert_eq!(post_message_reaches("/", "opaque:realm1", "opaque:realm2"), Some(false));
        assert_eq!(post_message_reaches("/", "opaque:realm1", "opaque:realm1"), Some(true));
        assert_eq!(post_message_reaches("https://a/x?y", "https://b", "https://a"), Some(true));
        assert_eq!(post_message_reaches("data:,x", "opaque:realm1", "opaque:realm1"), Some(false));
        assert_eq!(post_message_reaches("nope", "https://a", "https://a"), None);
    }
}
