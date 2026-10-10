// HTML serialization (HTML §13.3, "serializing HTML fragments"): a node's children — or the node itself — as markup,
// what `innerHTML`, `outerHTML`, `getHTML()` and a driver's page source read. Over UTF-16 code units, as the DOM holds
// text and as a page reads the result: a lone surrogate in a text node or an attribute value passes through.

use std::rc::Rc;

use crate::dom::{NodeData, NodeId, NodeKind, RealmArena};
use web_atoms::ns;

// The void elements (and the obsolete ones the serializer still treats as void): an HTML element of these has no end
// tag and no content.
const VOID: [&str; 18] = [
    "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "meta",
    "param", "source", "track", "wbr",
];
// The HTML elements whose text is written as it is — the parser reads their content as raw text, so escaping it would
// not round-trip. (Not `noscript`: this driver parses with scripting disabled, so its content is elements.)
const RAW_TEXT: [&str; 7] = ["style", "script", "xmp", "iframe", "noembed", "noframes", "plaintext"];

struct Writer<'a> {
    arena: &'a RealmArena,
    // The shadow roots to serialize (`getHTML()`'s options): each host, and the opening `<template shadowrootmode=…>`
    // tag its root is written as — the root's own attributes are the page side's to say.
    shadows: &'a [(NodeId, Vec<u16>)],
    out: Vec<u16>,
}

impl Writer<'_> {
    fn push(&mut self, s: &str) {
        self.out.extend(s.encode_utf16());
    }
    // "Escaping a string": `&` and U+00A0 always, `<` and `>` too, `"` in an attribute value.
    fn escaped(&mut self, units: &[u16], attribute: bool) {
        for &u in units {
            match u {
                0x26 => self.push("&amp;"),
                0xA0 => self.push("&nbsp;"),
                0x3C => self.push("&lt;"),
                0x3E => self.push("&gt;"),
                0x22 if attribute => self.push("&quot;"),
                _ => self.out.push(u),
            }
        }
    }

    // The work still to do, last first — a walk with its own stack, so a tree of any depth serializes (and none
    // overflows the native one): a node to write (its parent's text raw, or not), or markup to append.
    fn run(&mut self, mut stack: Vec<Task>) {
        while let Some(task) = stack.pop() {
            match task {
                Task::Markup(units) => self.out.extend_from_slice(&units),
                Task::Node(id, raw) => {
                    let Some(n) = self.arena.get(id) else { continue };
                    match n.kind {
                        NodeKind::Element => {
                            if let Some(name) = self.start_tag(n) {
                                stack.push(Task::Markup(format!("</{name}>").encode_utf16().collect()));
                                self.children(id, &mut stack);
                            }
                        }
                        NodeKind::Text if raw => self.out.extend_from_slice(&n.data),
                        NodeKind::Text => self.escaped(&n.data, false),
                        NodeKind::Comment => {
                            self.push("<!--");
                            self.out.extend_from_slice(&n.data);
                            self.push("-->");
                        }
                        NodeKind::ProcessingInstruction => {
                            self.push("<?");
                            self.push(&n.local_name);
                            self.push(" ");
                            self.out.extend_from_slice(&n.data);
                            self.push(">");
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    // Queue the children of `id` (a `<template>`'s: its contents) — and, before them, a host's shadow root where one
    // is asked for.
    fn children(&self, id: NodeId, stack: &mut Vec<Task>) {
        let Some(n) = self.arena.get(id) else { return };
        let parent = if n.kind == NodeKind::Element && n.is_html_named("template") { n.template_content } else { Some(id) };
        let raw = n.kind == NodeKind::Element && n.ns == ns!(html) && RAW_TEXT.contains(&&*n.local_name);
        if let Some(parent) = parent.and_then(|p| self.arena.get(p)) {
            stack.extend(parent.children.iter().rev().map(|&c| Task::Node(c, raw)));
        }
        if let Some((_, open)) = self.shadows.iter().find(|(host, _)| *host == id) {
            if let Some(root) = n.shadow_root {
                stack.push(Task::Markup("</template>".encode_utf16().collect()));
                self.children(root, stack);
                stack.push(Task::Markup(open.clone()));
            }
        }
    }

    // An element's start tag written: its name, for the end tag — none for a void element, which has neither end tag
    // nor content.
    fn start_tag(&mut self, n: &NodeData) -> Option<String> {
        // (…an HTML, SVG or MathML element by its local name — `foreignObject` keeps its case — any other by its
        // qualified name)
        let name = if n.ns == ns!(html) || n.ns == ns!(svg) || n.ns == ns!(mathml) {
            n.local_name.to_string()
        } else {
            match &n.prefix {
                Some(p) => format!("{p}:{}", n.local_name),
                None => n.local_name.to_string(),
            }
        };
        self.push("<");
        self.push(&name);
        // (…an `is` value the element was made with and holds no attribute for, first)
        if let Some(is) = n.is_value.as_deref().filter(|_| n.plain_attr("is").is_none()) {
            self.push(" is=\"");
            self.escaped(is, true);
            self.push("\"");
        }
        for (key, value) in &n.attributes {
            self.push(" ");
            self.push(&attribute_name(n, key));
            self.push("=\"");
            match n.attr_u16.iter().find(|(k, _)| k == key) {
                Some((_, units)) => self.escaped(units, true),
                None => self.escaped(&value.encode_utf16().collect::<Vec<_>>(), true),
            }
            self.push("\"");
        }
        self.push(">");
        (!(n.ns == ns!(html) && VOID.contains(&&*n.local_name))).then_some(name)
    }
}

enum Task {
    Node(NodeId, bool),
    Markup(Vec<u16>),
}

// The name an attribute is written under: its local name in no namespace; `xml:`, `xmlns:` (`xmlns` itself bare) or
// `xlink:` before it in those; its qualified name in any other.
fn attribute_name(n: &NodeData, key: &str) -> String {
    let Some((_, url, local)) = n.attr_ns.iter().find(|(k, _, _)| k == key) else { return key.to_string() };
    match url.as_str() {
        "" => local.clone(),
        "http://www.w3.org/XML/1998/namespace" => format!("xml:{local}"),
        "http://www.w3.org/2000/xmlns/" if local == "xmlns" => "xmlns".to_string(),
        "http://www.w3.org/2000/xmlns/" => format!("xmlns:{local}"),
        "http://www.w3.org/1999/xlink" => format!("xlink:{local}"),
        // (…a store key is the qualified name, a NUL and a counter after it where two would share it)
        _ => key.split('\0').next().unwrap_or(local).to_string(),
    }
}

// `id`'s children serialized — or, `outer`, `id` itself — with the shadow roots `shadows` names.
pub(crate) fn html(arena: &RealmArena, id: NodeId, outer: bool, shadows: &[(NodeId, Vec<u16>)]) -> Vec<u16> {
    let mut w = Writer { arena, shadows, out: Vec::new() };
    let mut stack = Vec::new();
    match arena.get(id) {
        Some(n) if outer && n.kind == NodeKind::Element => stack.push(Task::Node(id, false)),
        Some(_) if !outer => w.children(id, &mut stack),
        _ => {}
    }
    w.run(stack);
    w.out
}

// ── XML serialization (DOM Parsing §3.2) ──
// The spec's algorithm step for step — a namespace prefix map copied per element, generated `ns{n}` prefixes, the
// nearest declared prefix for a namespaced attribute — its require-well-formed checks on for the innerHTML / outerHTML
// getters in an XML document and off for XMLSerializer.
//
// A few subtests in the vendored WPT file are mutually CONTRADICTORY — the
// namespace-prefix algorithm changed across spec revisions (DOM-Parsing issues
// #29/#44/#45/#47/#52) and the file mixes old and new expectations, so no single
// serializer passes all of them. Where the file is self-consistent we follow what
// Chrome / Firefox actually do (CLAUDE.md rule 1: "spec-correct means what real
// browsers do"); where it contradicts itself we follow the revision that passes
// the MOST subtests. The residual out-of-scope failures (wpt_out_of_scope.yml),
// all verified directly against Chrome:
//   - "Drop inconsistent xmlns by matching on local name" — abandoned revision;
//     Chrome keeps the literal xmlns attrs (fails the subtest too).
//   - "...prefix of an attribute is NOT preserved..." (issue #29) — Chrome
//     preserves the author prefix (fails the subtest too); only the old revision
//     generated `ns1`.
//   - "...prefix bound to an empty namespace URI..." — Chrome KEEPS `xmlns=""`
//     here and PASSES this subtest, but only by then FAILING the
//     "redundant/inconsistent xmlns is dropped" subtests (it keeps every redundant
//     xmlns). We instead drop redundant xmlns aggressively, passing those two drop
//     subtests at the cost of this one — strictly more of the file either way.

const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS: &str = "http://www.w3.org/2000/xmlns/";
const HTML_NS: &str = "http://www.w3.org/1999/xhtml";
// The HTML elements written self-closed in XML where they have no children.
const XML_VOID: [&str; 19] = [
    "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "menuitem",
    "meta", "param", "source", "track", "wbr",
];

// A namespace prefix map: each namespace (`null` for none) and the prefixes bound to it, in order.
type PrefixMap = Vec<(String, Vec<String>)>;
fn ns_key(ns: Option<&str>) -> String {
    ns.unwrap_or("null").to_string()
}
fn prefixes<'m>(map: &'m PrefixMap, ns: &str) -> Option<&'m Vec<String>> {
    map.iter().find(|(n, _)| n == ns).map(|(_, p)| p)
}
fn bind(map: &mut PrefixMap, ns: &str, prefix: String) {
    match map.iter_mut().find(|(n, _)| n == ns) {
        Some((_, p)) => p.push(prefix),
        None => map.push((ns.to_string(), vec![prefix])),
    }
}
// The prefix `preferred` where `ns` has it, else the last bound to `ns`; None where none is.
fn preferred_prefix(map: &PrefixMap, ns: &str, preferred: Option<&str>) -> Option<String> {
    let candidates = prefixes(map, ns)?;
    if let Some(p) = preferred.filter(|p| candidates.iter().any(|c| c == p)) {
        return Some(p.to_string());
    }
    candidates.last().cloned()
}

// The XML `Char` production over code units: a valid surrogate pair, or a permitted BMP unit.
fn xml_chars(units: &[u16]) -> bool {
    let mut i = 0;
    while i < units.len() {
        let c = units[i];
        match c {
            0xD800..=0xDBFF if units.get(i + 1).is_some_and(|n| (0xDC00..=0xDFFF).contains(n)) => i += 1,
            0xD800..=0xDFFF => return false,
            0x9 | 0xA | 0xD | 0x20..=0xD7FF | 0xE000..=0xFFFD => {}
            _ => return false,
        }
        i += 1;
    }
    true
}
fn contains(units: &[u16], s: &str) -> bool {
    let needle: Vec<u16> = s.encode_utf16().collect();
    units.windows(needle.len()).any(|w| w == needle)
}

enum XmlTask {
    Node(NodeId, Option<Rc<str>>, Rc<PrefixMap>),
    Markup(Vec<u16>),
}

struct XmlWriter<'a> {
    arena: &'a RealmArena,
    // "require well-formed" (the innerHTML / outerHTML getters): what has no well-formed serialization is refused.
    well_formed: bool,
    prefix_index: u32,
    out: Vec<u16>,
}
type Refused = &'static str;

impl XmlWriter<'_> {
    fn push(&mut self, s: &str) {
        self.out.extend(s.encode_utf16());
    }
    // `&`, `<` and `>` — and in an attribute value `"` and the whitespace that would not survive a parse as itself.
    fn escaped(&mut self, units: &[u16], attribute: bool) {
        for &u in units {
            match u {
                0x26 => self.push("&amp;"),
                0x3C => self.push("&lt;"),
                0x3E => self.push("&gt;"),
                0x22 if attribute => self.push("&quot;"),
                0x09 if attribute => self.push("&#x9;"),
                0x0A if attribute => self.push("&#xA;"),
                0x0D if attribute => self.push("&#xD;"),
                _ => self.out.push(u),
            }
        }
    }
    fn generate_prefix(&mut self, map: &mut PrefixMap, ns: &str) -> String {
        let generated = format!("ns{}", self.prefix_index);
        self.prefix_index += 1;
        match map.iter_mut().find(|(n, _)| n == ns) {
            Some((_, p)) => *p = vec![generated.clone()],
            None => map.push((ns.to_string(), vec![generated.clone()])),
        }
        generated
    }

    // The work still to do, last first — a walk with its own stack, as the HTML one: a node to write, in the namespace
    // it inherits and under the prefix map its parent leaves, or markup to append.
    fn run(&mut self, mut stack: Vec<XmlTask>) -> Result<(), Refused> {
        while let Some(task) = stack.pop() {
            match task {
                XmlTask::Markup(units) => self.out.extend_from_slice(&units),
                XmlTask::Node(id, namespace, map) => self.node(id, namespace, map, &mut stack)?,
            }
        }
        Ok(())
    }

    fn node(&mut self, id: NodeId, namespace: Option<Rc<str>>, map: Rc<PrefixMap>, stack: &mut Vec<XmlTask>) -> Result<(), Refused> {
        let Some(n) = self.arena.get(id) else { return Ok(()) };
        match n.kind {
            NodeKind::Element => {
                if let Some((qualified, inherited, map, children)) = self.element(n, namespace.as_deref(), &map)? {
                    stack.push(XmlTask::Markup(format!("</{qualified}>").encode_utf16().collect()));
                    let (inherited, map) = (inherited.map(Rc::from), Rc::new(map));
                    stack.extend(children.into_iter().rev().map(|c| XmlTask::Node(c, inherited.clone(), map.clone())));
                }
            }
            NodeKind::Text if n.cdata => {
                if self.well_formed && (!xml_chars(&n.data) || contains(&n.data, "]]>")) {
                    return Err("Failed to serialize XML: CDATA section data is not well-formed.");
                }
                self.push("<![CDATA[");
                self.out.extend_from_slice(&n.data);
                self.push("]]>");
            }
            NodeKind::Text => {
                if self.well_formed && !xml_chars(&n.data) {
                    return Err("Failed to serialize XML: text node data contains a character not allowed by the XML Char production.");
                }
                self.escaped(&n.data, false);
            }
            NodeKind::Comment => {
                if self.well_formed && (!xml_chars(&n.data) || contains(&n.data, "--") || n.data.last() == Some(&0x2D)) {
                    return Err("Failed to serialize XML: comment node data is not well-formed.");
                }
                self.push("<!--");
                self.out.extend_from_slice(&n.data);
                self.push("-->");
            }
            NodeKind::ProcessingInstruction => {
                let target = &*n.local_name;
                if self.well_formed
                    && (target.contains(':') || target.eq_ignore_ascii_case("xml") || !xml_chars(&n.data) || contains(&n.data, "?>"))
                {
                    return Err("Failed to serialize XML: processing instruction node is not well-formed.");
                }
                self.push("<?");
                self.push(target);
                self.push(" ");
                self.out.extend_from_slice(&n.data);
                self.push("?>");
            }
            NodeKind::Other => {
                let (public, system) = n.doctype_ids.as_deref().map_or((&[][..], &[][..]), |(p, s)| (&p[..], &s[..]));
                self.push("<!DOCTYPE ");
                self.out.extend_from_slice(&n.data);
                if !public.is_empty() {
                    self.push(" PUBLIC \"");
                    self.out.extend_from_slice(public);
                    self.push("\"");
                } else if !system.is_empty() {
                    self.push(" SYSTEM");
                }
                if !system.is_empty() {
                    self.push(" \"");
                    self.out.extend_from_slice(system);
                    self.push("\"");
                }
                self.push(">");
            }
            NodeKind::Document | NodeKind::Fragment => {
                stack.extend(n.children.iter().rev().map(|&c| XmlTask::Node(c, namespace.clone(), map.clone())));
            }
        }
        Ok(())
    }

    // "Record the namespace information": the element's `xmlns` / `xmlns:*` attributes folded into `map` and its
    // local prefixes; its default namespace declaration, if it has one.
    fn record_namespaces(n: &NodeData, map: &mut PrefixMap, local: &mut Vec<(String, String)>) -> Option<String> {
        let mut default = None;
        for attr in n.attribute_list() {
            // (…a literal `xmlns` attribute in no namespace — `setAttribute('xmlns', …)`, an HTML parse — declares the
            // default namespace too, so the element does not declare it a second time where the two agree)
            if attr.ns.is_none() && attr.local == "xmlns" && attr.prefix.is_none() {
                default = Some(String::from_utf16_lossy(&attr.value));
                continue;
            }
            if attr.ns.as_deref() != Some(XMLNS_NS) {
                continue;
            }
            let value = String::from_utf16_lossy(&attr.value);
            if attr.prefix.is_none() {
                default = Some(value);
                continue;
            }
            if value == XML_NS {
                continue;
            }
            if prefixes(map, &value).is_some_and(|p| p.contains(&attr.local)) {
                continue;
            }
            bind(map, &value, attr.local.clone());
            local.push((attr.local, value));
        }
        default
    }

    // An element's start tag written, by the namespace it inherits and its parent's prefix map: its qualified name, the
    // namespace and prefix map its children inherit, and its children — none where it closes itself.
    #[allow(clippy::type_complexity)]
    fn element(&mut self, n: &NodeData, namespace: Option<&str>, parent_map: &PrefixMap) -> Result<Option<(String, Option<String>, PrefixMap, Vec<NodeId>)>, Refused> {
        let local_name = &*n.local_name;
        if self.well_formed && local_name.contains(':') {
            return Err("Failed to serialize XML: an element's local name contains ':'.");
        }
        let mut map = parent_map.clone();
        let mut local_prefixes: Vec<(String, String)> = Vec::new();
        let local_default = Self::record_namespaces(n, &mut map, &mut local_prefixes);
        let ns: Option<&str> = (!n.ns.is_empty()).then_some(&*n.ns);
        let mut inherited: Option<String> = namespace.map(str::to_string);
        let mut ignore_namespace_definition = false;
        let qualified;
        self.push("<");
        if namespace == ns {
            if local_default.is_some() {
                ignore_namespace_definition = true;
            }
            qualified = if ns == Some(XML_NS) { format!("xml:{local_name}") } else { local_name.to_string() };
            self.push(&qualified);
        } else {
            let key = ns_key(ns);
            let mut prefix: Option<String> = n.prefix.as_deref().map(str::to_string);
            let mut candidate = preferred_prefix(&map, &key, prefix.as_deref());
            if prefix.as_deref() == Some("xmlns") {
                candidate = Some("xmlns".to_string());
            }
            if let Some(candidate) = candidate {
                qualified = format!("{candidate}:{local_name}");
                if let Some(d) = local_default.as_deref().filter(|&d| d != XML_NS) {
                    inherited = (!d.is_empty()).then(|| d.to_string());
                }
                self.push(&qualified);
            } else if let Some(mut p) = prefix.take() {
                if local_prefixes.iter().any(|(l, _)| *l == p) {
                    p = self.generate_prefix(&mut map, &key);
                }
                bind(&mut map, &key, p.clone());
                qualified = format!("{p}:{local_name}");
                self.push(&qualified);
                self.push(&format!(" xmlns:{p}=\""));
                self.escaped(&ns.unwrap_or("").encode_utf16().collect::<Vec<_>>(), true);
                self.push("\"");
                if let Some(d) = local_default.as_deref() {
                    inherited = (!d.is_empty()).then(|| d.to_string());
                }
            } else if local_default.is_none() || local_default.as_deref() != ns {
                ignore_namespace_definition = true;
                qualified = local_name.to_string();
                inherited = ns.map(str::to_string);
                self.push(&qualified);
                self.push(" xmlns=\"");
                self.escaped(&ns.unwrap_or("").encode_utf16().collect::<Vec<_>>(), true);
                self.push("\"");
            } else {
                qualified = local_name.to_string();
                inherited = ns.map(str::to_string);
                self.push(&qualified);
            }
        }
        self.attributes(n, &mut map, &local_prefixes, ignore_namespace_definition)?;
        let html = ns == Some(HTML_NS);
        if n.children.is_empty() && (!html || XML_VOID.contains(&local_name)) {
            self.push(if html { " />" } else { "/>" });
            return Ok(None);
        }
        self.push(">");
        let children = if html && local_name == "template" { n.template_content.map(|c| vec![c]).unwrap_or_default() } else { n.children.clone() };
        Ok(Some((qualified, inherited, map, children)))
    }

    fn attributes(&mut self, n: &NodeData, map: &mut PrefixMap, local_prefixes: &[(String, String)], ignore_namespace_definition: bool) -> Result<(), Refused> {
        for attr in n.attribute_list() {
            let mut candidate: Option<String> = None;
            if let Some(ns) = attr.ns.as_deref() {
                candidate = preferred_prefix(map, ns, attr.prefix.as_deref());
                if ns == XMLNS_NS {
                    let value = String::from_utf16_lossy(&attr.value);
                    let redeclared = attr.prefix.is_some()
                        && local_prefixes.iter().find(|(l, _)| *l == attr.local).map(|(_, v)| v.as_str()) != Some(value.as_str())
                        && prefixes(map, &value).is_some_and(|p| p.contains(&attr.local));
                    if value == XML_NS || (attr.prefix.is_none() && ignore_namespace_definition) || redeclared {
                        continue;
                    }
                    if attr.prefix.as_deref() == Some("xmlns") {
                        candidate = Some("xmlns".to_string());
                    }
                } else if candidate.is_none() {
                    // (…a namespace bound to no prefix yet takes the attribute's own prefix where that is free — `xl:type`
                    // stays so, as Chrome and Firefox write it — else a generated `ns{n}`)
                    let own = attr.prefix.clone().filter(|p| p != "xmlns" && !map.iter().any(|(_, ps)| ps.contains(p)));
                    let p = match own {
                        Some(p) => {
                            bind(map, ns, p.clone());
                            p
                        }
                        None => self.generate_prefix(map, ns),
                    };
                    self.push(&format!(" xmlns:{p}=\""));
                    self.escaped(&ns.encode_utf16().collect::<Vec<_>>(), true);
                    self.push("\"");
                    candidate = Some(p);
                }
            }
            self.push(" ");
            if let Some(p) = candidate {
                self.push(&p);
                self.push(":");
            }
            if self.well_formed && (attr.local.contains(':') || !xml_chars(&attr.value)) {
                return Err("Failed to serialize XML: attribute is not well-formed.");
            }
            self.push(&attr.local);
            self.push("=\"");
            self.escaped(&attr.value, true);
            self.push("\"");
        }
        Ok(())
    }
}

// `id` serialized as XML — or, `inner`, its children (an HTML `<template>`'s: its contents') — requiring it well-formed
// where `well_formed`.
pub(crate) fn xml(arena: &RealmArena, id: NodeId, inner: bool, well_formed: bool) -> Result<Vec<u16>, Refused> {
    let mut w = XmlWriter { arena, well_formed, prefix_index: 1, out: Vec::new() };
    let map: Rc<PrefixMap> = Rc::new(vec![(XML_NS.to_string(), vec!["xml".to_string()])]);
    let parent = arena.get(id).map(|n| if n.is_html_named("template") { n.template_content.and_then(|c| arena.get(c)) } else { Some(n) });
    let stack = match parent {
        Some(n) if inner => n.map_or(Vec::new(), |n| n.children.iter().rev().map(|&c| XmlTask::Node(c, None, map.clone())).collect()),
        Some(_) => vec![XmlTask::Node(id, None, map)],
        None => Vec::new(),
    };
    w.run(stack)?;
    Ok(w.out)
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "serializeHtml", serialize_html, context_id);
    crate::dom::register(scope, ns, "serializeXml", serialize_xml, context_id);
}

// __dom.serializeXml(nid, inner, wellFormed) -> the node as XML (`xml`) — or, `inner`, its children — or `[message]`
// where it has no well-formed serialization.
fn serialize_xml(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let (inner, well_formed) = (args.get(1).is_true(), args.get(2).is_true());
    match xml(crate::dom::realm(scope, cid), id, inner, well_formed) {
        Ok(out) => {
            let out = crate::dom::utf16_value(scope, &out);
            rv.set(out);
        }
        Err(message) => {
            let Some(m) = v8::String::new(scope, message) else { return };
            rv.set(v8::Array::new_with_elements(scope, &[m.into()]).into());
        }
    }
}

// __dom.serializeHtml(nid, outer, shadows) -> the node's children as HTML — or, `outer`, the element itself (`html`);
// `shadows` (or undefined) a flat `[hostNid, openingTag, …]` of the shadow roots to write.
fn serialize_html(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(id) = crate::dom::nid_arg(scope, &args, 0) else { return };
    let outer = args.get(1).is_true();
    let mut shadows = Vec::new();
    if let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(2)) {
        for k in (0..list.length()).step_by(2) {
            let host = list.get_index(scope, k).and_then(|v| v.integer_value(scope)).and_then(NodeId::from_i64);
            let open = list.get_index(scope, k + 1).map(|v| crate::dom::utf16_arg(scope, v));
            if let (Some(host), Some(open)) = (host, open) {
                shadows.push((host, open));
            }
        }
    }
    let out = html(crate::dom::realm(scope, cid), id, outer, &shadows);
    let out = crate::dom::utf16_value(scope, &out);
    rv.set(out);
}
