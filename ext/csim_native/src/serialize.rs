// HTML serialization (HTML §13.3, "serializing HTML fragments"): a node's children — or the node itself — as markup,
// what `innerHTML`, `outerHTML`, `getHTML()` and a driver's page source read. Over UTF-16 code units, as the DOM holds
// text and as a page reads the result: a lone surrogate in a text node or an attribute value passes through.

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

    // The children of `id` (a `<template>`'s: its contents), and first a host's shadow root where one is asked for.
    fn children(&mut self, id: NodeId) {
        let Some(n) = self.arena.get(id) else { return };
        if let Some((_, open)) = self.shadows.iter().find(|(host, _)| *host == id) {
            if let Some(root) = n.shadow_root {
                self.out.extend_from_slice(open);
                self.children(root);
                self.push("</template>");
            }
        }
        let parent = if n.kind == NodeKind::Element && n.is_html_named("template") { n.template_content } else { Some(id) };
        let Some(parent) = parent.and_then(|p| self.arena.get(p)) else { return };
        let raw = n.kind == NodeKind::Element && n.ns == ns!(html) && RAW_TEXT.contains(&&*n.local_name);
        for &c in &parent.children {
            let Some(child) = self.arena.get(c) else { continue };
            match child.kind {
                NodeKind::Element => self.element(c, child),
                NodeKind::Text if raw => self.out.extend_from_slice(&child.data),
                NodeKind::Text => self.escaped(&child.data, false),
                NodeKind::Comment => {
                    self.push("<!--");
                    self.out.extend_from_slice(&child.data);
                    self.push("-->");
                }
                NodeKind::ProcessingInstruction => {
                    self.push("<?");
                    self.push(&child.local_name);
                    self.push(" ");
                    self.out.extend_from_slice(&child.data);
                    self.push(">");
                }
                _ => {}
            }
        }
    }

    fn element(&mut self, id: NodeId, n: &NodeData) {
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
            self.escaped(&is.encode_utf16().collect::<Vec<_>>(), true);
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
        if n.ns == ns!(html) && VOID.contains(&&*n.local_name) {
            return;
        }
        self.children(id);
        self.push("</");
        self.push(&name);
        self.push(">");
    }
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
    match arena.get(id) {
        Some(n) if outer && n.kind == NodeKind::Element => w.element(id, n),
        Some(_) if !outer => w.children(id),
        _ => {}
    }
    w.out
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "serializeHtml", serialize_html, context_id);
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
