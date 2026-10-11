// A namespace-aware XML / XHTML parser — DOMParser's and XHR's XML documents, and the XML fragment parsing algorithm
// (`innerHTML` and its kin in an XML document). Unlike the HTML parser it honours `<tag/>` on any element, keeps the case
// of tag and attribute names, makes processing instructions and CDATA sections real nodes, resolves namespaces from the
// in-scope `xmlns` / `xmlns:foo` declarations, and parses a `<script>` / `<style>` body as markup. It is not a validating
// parser: of a DOCTYPE's internal subset it expands only the general entities of a literal value (`<!ENTITY n "v">`),
// their replacement text parsed as markup in the scope it is referred in (one level: a value naming another entity is
// left as it is); in text it decodes the predefined, numeric and `&nbsp;` references.
//
// It makes no node: it answers the steps that make them (`xmlParse`), which the bindings replay — the objects are
// theirs to construct — or none where the source is not well-formed: a document's is then a `<parsererror>` one, a
// fragment's a SyntaxError.

use std::collections::HashMap;

use crate::dom::{nid_arg, NodeKind};

const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS: &str = "http://www.w3.org/2000/xmlns/";

// A step's opcode (`xmlParse`'s answer): an element, a text, a comment, a CDATA section, a processing instruction, a
// doctype — each the next node, put in the node it names (-1: the top level).
const OP_ELEMENT: i32 = 0;
const OP_TEXT: i32 = 1;
const OP_COMMENT: i32 = 2;
const OP_CDATA: i32 = 3;
const OP_PI: i32 = 4;
const OP_DOCTYPE: i32 = 5;

type Units = Vec<u16>;
// The in-scope namespace declarations: prefix (empty: the default) → namespace (None: undeclared by an empty value).
type Scope = HashMap<Units, Option<Units>>;

fn units(s: &str) -> Units {
    s.encode_utf16().collect()
}

// A value of the answer.
enum Value {
    Number(i32),
    Text(Units),
    Null,
    Undefined,
}

// The steps made so far, and the number the next node takes.
struct Steps {
    values: Vec<Value>,
    next: i32,
}

impl Steps {
    fn node(&mut self, op: i32, parent: i32) -> i32 {
        self.values.push(Value::Number(op));
        self.values.push(Value::Number(parent));
        let handle = self.next;
        self.next += 1;
        handle
    }
    fn text(&mut self, units: Units) {
        self.values.push(Value::Text(units));
    }
    fn optional(&mut self, units: Option<Units>) {
        self.values.push(units.map_or(Value::Null, Value::Text));
    }
}

fn is_ws(c: u16) -> bool {
    matches!(c, 0x20 | 0x09 | 0x0A | 0x0D | 0x0C)
}
// …and the white space of a JS regular expression's `\s`, which the source's other scans read by.
fn is_js_space(c: u16) -> bool {
    matches!(c, 0x09..=0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}
fn is_word(c: u16) -> bool {
    c < 0x80 && (c as u8).is_ascii_alphanumeric() || c == u16::from(b'_')
}
// XML's name productions (XML 1.0 §2.3 NameStartChar / NameChar, Namespaces §3 NCName: no colon) — a lone surrogate in
// none.
fn is_name_start(c: char) -> bool {
    matches!(c, 'A'..='Z' | '_' | 'a'..='z' | '\u{C0}'..='\u{D6}' | '\u{D8}'..='\u{F6}' | '\u{F8}'..='\u{2FF}'
        | '\u{370}'..='\u{37D}' | '\u{37F}'..='\u{1FFF}' | '\u{200C}'..='\u{200D}' | '\u{2070}'..='\u{218F}'
        | '\u{2C00}'..='\u{2FEF}' | '\u{3001}'..='\u{D7FF}' | '\u{F900}'..='\u{FDCF}' | '\u{FDF0}'..='\u{FFFD}'
        | '\u{10000}'..='\u{EFFFF}')
}
fn is_name_char(c: char) -> bool {
    is_name_start(c) || matches!(c, '-' | '.' | '0'..='9' | '\u{B7}' | '\u{300}'..='\u{36F}' | '\u{203F}'..='\u{2040}')
}
fn is_nc_name(s: &[u16]) -> bool {
    let mut chars = char::decode_utf16(s.iter().copied());
    matches!(chars.next(), Some(Ok(c)) if is_name_start(c)) && chars.all(|c| c.is_ok_and(is_name_char))
}
fn is_q_name(s: &[u16]) -> bool {
    match s.iter().position(|&c| c == u16::from(b':')) {
        None => is_nc_name(s),
        Some(colon) => is_nc_name(&s[..colon]) && is_nc_name(&s[colon + 1..]),
    }
}
fn starts_with(s: &[u16], at: usize, prefix: &str) -> bool {
    let p = units(prefix);
    s.len() >= at + p.len() && s[at..at + p.len()] == p[..]
}
fn find(s: &[u16], from: usize, needle: &str) -> Option<usize> {
    let n = units(needle);
    (from..=s.len().saturating_sub(n.len())).find(|&i| s[i..].starts_with(&n))
}
fn find_unit(s: &[u16], from: usize, c: u8) -> Option<usize> {
    s.get(from..)?.iter().position(|&u| u == u16::from(c)).map(|p| p + from)
}

// The text with its character references decoded: `&amp;` `&lt;` `&gt;` `&quot;` `&apos;` `&nbsp;`, `&#n;` and `&#xh;`
// (a lower-case `x`); any other `&` kept. A reference to no character makes the source not well-formed (`err`).
fn decode(text: &[u16], err: &mut bool) -> Units {
    if !text.contains(&u16::from(b'&')) {
        return text.to_vec();
    }
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text[i] == u16::from(b'&') {
            if let Some((decoded, len)) = reference(&text[i..], err) {
                out.extend(decoded);
                i += len;
                continue;
            }
        }
        out.push(text[i]);
        i += 1;
    }
    out
}
fn reference(s: &[u16], err: &mut bool) -> Option<(Units, usize)> {
    // (…its name the units a reference's can be — `#`, `x`, ASCII letters and digits — to its `;`: a run of bare `&`s
    // scans no further than the next unit that cannot be one)
    let end = 1 + s[1..].iter().position(|&c| !(c < 0x80 && ((c as u8).is_ascii_alphanumeric() || c == u16::from(b'#'))))?;
    if s[end] != u16::from(b';') {
        return None;
    }
    let name = String::from_utf16(&s[1..end]).ok()?;
    let ch = match name.as_str() {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => '\u{A0}',
        _ => {
            let code = if let Some(hex) = name.strip_prefix("#x") {
                (!hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit())).then(|| u32::from_str_radix(hex, 16).unwrap_or(u32::MAX))?
            } else if let Some(dec) = name.strip_prefix('#') {
                (!dec.is_empty() && dec.bytes().all(|b| b.is_ascii_digit())).then(|| dec.parse::<u32>().unwrap_or(u32::MAX))?
            } else {
                return None;
            };
            // (…a code point as `String.fromCodePoint` makes it — a lone surrogate's unit as it is — and past the last,
            // none: a reference to no character)
            if code > 0x10FFFF {
                *err = true;
                return Some((Vec::new(), end + 1));
            }
            return Some((code_point_units(code), end + 1));
        }
    };
    Some((units(&ch.to_string()), end + 1))
}
fn code_point_units(code: u32) -> Units {
    match char::from_u32(code) {
        Some(c) => units(&c.to_string()),
        None => vec![code as u16],
    }
}

// A start tag's inside (`name attr="v" …`): its name and its attributes, their values decoded — and whether its
// attributes are not well-formed (a name missing, a value missing or unquoted, a quote unclosed).
fn parse_tag(inner: &[u16], err: &mut bool) -> (Units, Vec<(Units, Units)>, bool) {
    let n = inner.len();
    let mut i = 0;
    while i < n && is_ws(inner[i]) {
        i += 1;
    }
    let mut name_end = i;
    while name_end < n && !is_ws(inner[name_end]) {
        name_end += 1;
    }
    let name = inner[i..name_end].to_vec();
    i = name_end;
    let mut attrs = Vec::new();
    let mut bad = false;
    while i < n {
        while i < n && (is_ws(inner[i]) || inner[i] == u16::from(b'/')) {
            i += 1;
        }
        if i >= n {
            break;
        }
        if inner[i] == u16::from(b'=') {
            bad = true;
            break;
        }
        let mut ae = i;
        while ae < n && !is_ws(inner[ae]) && inner[ae] != u16::from(b'=') {
            ae += 1;
        }
        let attr_name = inner[i..ae].to_vec();
        i = ae;
        while i < n && is_ws(inner[i]) {
            i += 1;
        }
        if i >= n || inner[i] != u16::from(b'=') {
            bad = true;
            break;
        }
        i += 1;
        while i < n && is_ws(inner[i]) {
            i += 1;
        }
        let Some(&quote) = inner.get(i).filter(|&&q| q == u16::from(b'"') || q == u16::from(b'\'')) else {
            bad = true;
            break;
        };
        let Some(end) = inner[i + 1..].iter().position(|&c| c == quote).map(|p| p + i + 1) else {
            bad = true;
            break;
        };
        attrs.push((attr_name, decode(&inner[i + 1..end], err)));
        i = end + 1;
    }
    (name, attrs, bad)
}

// The `>` that ends the tag whose `<` is at `lt`, past any in a quoted value.
fn tag_end(s: &[u16], lt: usize) -> Option<usize> {
    let mut quote: Option<u16> = None;
    for (i, &c) in s.iter().enumerate().skip(lt + 1) {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == u16::from(b'"') || c == u16::from(b'\'') => quote = Some(c),
            None if c == u16::from(b'>') => return Some(i),
            None => {}
        }
    }
    None
}

// A `<!DOCTYPE …>` declaration's body (between `<!` and `>`): its name and public and system ids — `PUBLIC` takes both
// literals, `SYSTEM` the system one, either missing not well-formed (None) — or Some(None) for a declaration that is no
// DOCTYPE.
#[allow(clippy::type_complexity)]
fn doctype(decl: &[u16]) -> Option<Option<(Units, Units, Units)>> {
    let is_doctype = decl.len() >= 7
        && decl[..7].iter().zip("doctype".bytes()).all(|(&c, b)| c < 0x80 && (c as u8).to_ascii_lowercase() == b)
        && decl.get(7).is_none_or(|&c| is_js_space(c));
    if !is_doctype {
        return Some(None);
    }
    // (…the internal subset left out: from the first `[` to the last `]`)
    let bare: Units = match (decl.iter().position(|&c| c == u16::from(b'[')), decl.iter().rposition(|&c| c == u16::from(b']'))) {
        (Some(a), Some(b)) if b > a => decl[..a].iter().chain(&decl[b + 1..]).copied().collect(),
        _ => decl.to_vec(),
    };
    // (…its words as `"[^"]*"|'[^']*'|\S+` reads them: a quoted literal whole, an unclosed quote a word like any other)
    let mut parts: Vec<&[u16]> = Vec::new();
    let mut i = 0;
    while i < bare.len() {
        let c = bare[i];
        if is_js_space(c) {
            i += 1;
            continue;
        }
        if c == u16::from(b'"') || c == u16::from(b'\'') {
            if let Some(close) = bare[i + 1..].iter().position(|&d| d == c) {
                parts.push(&bare[i..i + 2 + close]);
                i += 2 + close;
                continue;
            }
        }
        let word_end = bare[i..].iter().position(|&d| is_js_space(d)).map_or(bare.len(), |p| p + i);
        parts.push(&bare[i..word_end]);
        i = word_end;
    }
    let quote = |c: u16| c == u16::from(b'"') || c == u16::from(b'\'');
    let unquote = |x: Option<&&[u16]>| -> Units {
        let mut x: &[u16] = x.copied().unwrap_or(&[]);
        if x.first().is_some_and(|&c| quote(c)) {
            x = &x[1..];
        }
        if x.last().is_some_and(|&c| quote(c)) {
            x = &x[..x.len() - 1];
        }
        x.to_vec()
    };
    let name = parts.get(1).map(|p| p.to_vec()).unwrap_or_default();
    let keyword = parts.get(2).map(|k| String::from_utf16_lossy(k).to_ascii_uppercase()).unwrap_or_default();
    let (public, system) = match keyword.as_str() {
        "PUBLIC" if parts.len() < 5 => return None,
        "PUBLIC" => (unquote(parts.get(3)), unquote(parts.get(4))),
        "SYSTEM" if parts.len() < 4 => return None,
        "SYSTEM" => (Vec::new(), unquote(parts.get(3))),
        _ => (Vec::new(), Vec::new()),
    };
    Some(Some((name, public, system)))
}

// The general entities of a literal value a DOCTYPE's internal subset declares (`<!ENTITY name "value">`), into
// `entities`; a parameter or an external one left out.
fn collect_entities(decl: &[u16], entities: &mut HashMap<Units, Units>) {
    let (Some(a), Some(b)) = (decl.iter().position(|&c| c == u16::from(b'[')), decl.iter().rposition(|&c| c == u16::from(b']'))) else {
        return;
    };
    if b <= a {
        return;
    }
    let subset = &decl[a + 1..b];
    let mut i = 0;
    while let Some(at) = find(subset, i, "<!ENTITY") {
        i = at + 8;
        let mut j = i;
        let skip_ws = |j: &mut usize| {
            let start = *j;
            while *j < subset.len() && is_js_space(subset[*j]) {
                *j += 1;
            }
            *j > start
        };
        if !skip_ws(&mut j) || j >= subset.len() || subset[j] == u16::from(b'%') {
            continue;
        }
        let name_start = j;
        while j < subset.len() && !is_js_space(subset[j]) {
            j += 1;
        }
        let name = subset[name_start..j].to_vec();
        if !skip_ws(&mut j) {
            continue;
        }
        let Some(&quote) = subset.get(j).filter(|&&q| q == u16::from(b'"') || q == u16::from(b'\'')) else { continue };
        let Some(end) = subset[j + 1..].iter().position(|&c| c == quote).map(|p| p + j + 1) else { continue };
        let value = subset[j + 1..end].to_vec();
        let mut k = end + 1;
        skip_ws(&mut k);
        if subset.get(k) == Some(&u16::from(b'>')) {
            entities.insert(name, value);
            i = k + 1;
        }
    }
}

// The parser's state for one source: the steps it makes, the open elements (each its handle and qualified name) and
// their scopes, the entities declared, whether the source is not well-formed, and how many elements are at the top.
struct Parser<'a> {
    steps: &'a mut Steps,
    fragment: bool,
    open: Vec<(i32, Units)>,
    scopes: Vec<Scope>,
    entities: HashMap<Units, Units>,
    err: bool,
    roots: u32,
    // (…where the top level's nodes go: an entity's replacement text, into the node it is referred in)
    top: i32,
}

impl Parser<'_> {
    fn parent(&self) -> i32 {
        self.open.last().map_or(self.top, |&(h, _)| h)
    }

    // A run of character data: its references decoded, a declared entity's replacement text parsed as markup in the
    // scope here — a fragment, which a malformed value makes not well-formed — and every `&` that starts no reference
    // (a bare one, one unterminated) not well-formed.
    fn chars(&mut self, text: &[u16]) {
        let mut i = 0;
        while let Some(at) = text[i..].iter().position(|&c| c == u16::from(b'&')).map(|p| p + i) {
            if !well_formed_reference(&text[at + 1..]) {
                self.err = true;
            }
            i = at + 1;
        }
        let mut last = 0;
        let mut at = 0;
        while let Some(amp) = text[at..].iter().position(|&c| c == u16::from(b'&')).map(|p| p + at) {
            let name_end = text[amp + 1..].iter().position(|&c| is_js_space(c) || c == u16::from(b';') || c == u16::from(b'&')).map(|p| p + amp + 1);
            match name_end {
                Some(e) if e > amp + 1 && text[e] == u16::from(b';') => {
                    at = e + 1;
                    let name = text[amp + 1..e].to_vec();
                    let Some(value) = self.entities.get(&name).cloned() else { continue };
                    if amp > last {
                        self.text_node(&text[last..amp]);
                    }
                    let scope = self.scopes.last().cloned().unwrap_or_default();
                    let parent = self.parent();
                    let mut expanded = Steps { values: Vec::new(), next: self.steps.next };
                    let ok = parse_into(&value, &mut expanded, scope, true, parent);
                    if ok {
                        self.steps.values.append(&mut expanded.values);
                        self.steps.next = expanded.next;
                    } else {
                        self.err = true;
                    }
                    last = e + 1;
                }
                Some(e) => at = e.max(amp + 1),
                None => break,
            }
        }
        if last < text.len() {
            self.text_node(&text[last..]);
        }
    }
    fn text_node(&mut self, text: &[u16]) {
        let decoded = decode(text, &mut self.err);
        let parent = self.parent();
        self.steps.node(OP_TEXT, parent);
        self.steps.text(decoded);
    }
}

// Whether what follows an `&` is a reference XML allows: `#digits;`, `#xhex;` (either case), or a name and `;`.
fn well_formed_reference(s: &[u16]) -> bool {
    let semi = |rest: &[u16], valid: &dyn Fn(u16) -> bool| -> bool {
        let n = rest.iter().take_while(|&&c| valid(c)).count();
        n > 0 && rest.get(n) == Some(&u16::from(b';'))
    };
    let hex = |c: u16| c < 0x80 && (c as u8).is_ascii_hexdigit();
    let digit = |c: u16| c < 0x80 && (c as u8).is_ascii_digit();
    match s.first() {
        Some(&c) if c == u16::from(b'#') => match s.get(1) {
            Some(&x) if x == u16::from(b'x') || x == u16::from(b'X') => semi(&s[2..], &hex),
            _ => semi(&s[1..], &digit),
        },
        Some(&c) if c < 0x80 && ((c as u8).is_ascii_alphabetic() || c == u16::from(b'_') || c == u16::from(b':')) => {
            let rest = &s[1..];
            let n = rest.iter().take_while(|&&c| is_word(c) || c == u16::from(b'.') || c == u16::from(b':') || c == u16::from(b'-')).count();
            rest.get(n) == Some(&u16::from(b';'))
        }
        _ => false,
    }
}

// Parse `src` into `steps` — its top-level nodes into `top` — in the namespace scope `scope`: as a document, or a
// fragment (its top level may hold text and more than one element). Whether it is well-formed.
fn parse_into(src: &[u16], steps: &mut Steps, scope: Scope, fragment: bool, top: i32) -> bool {
    let mut p = Parser { steps, fragment, open: Vec::new(), scopes: vec![scope], entities: HashMap::new(), err: false, roots: 0, top };
    let s = src;
    let n = s.len();
    let mut i = 0;
    while i < n {
        if s[i] != u16::from(b'<') {
            let j = find_unit(s, i, b'<').unwrap_or(n);
            let text = &s[i..j];
            // (…the white space around the document element is no node; any text inside an element is one)
            if if p.open.is_empty() { text.iter().any(|&c| !is_js_space(c)) } else { !text.is_empty() } {
                p.chars(text);
            }
            i = j;
            continue;
        }
        if starts_with(s, i, "<!--") {
            let end = find(s, i + 4, "-->");
            let parent = p.parent();
            p.steps.node(OP_COMMENT, parent);
            p.steps.text(s[i + 4..end.unwrap_or(n)].to_vec());
            i = end.map_or(n, |e| e + 3);
        } else if starts_with(s, i, "<![CDATA[") {
            let end = find(s, i + 9, "]]>");
            let parent = p.parent();
            p.steps.node(OP_CDATA, parent);
            p.steps.text(s[i + 9..end.unwrap_or(n)].to_vec());
            i = end.map_or(n, |e| e + 3);
        } else if starts_with(s, i, "<!") {
            // (…a DOCTYPE — the only `<!…>` content may hold besides those two — its internal subset balanced)
            let mut j = i + 2;
            let mut depth = 0i32;
            while j < n {
                match s[j] {
                    c if c == u16::from(b'[') => depth += 1,
                    c if c == u16::from(b']') => depth -= 1,
                    c if c == u16::from(b'>') && depth <= 0 => break,
                    _ => {}
                }
                j += 1;
            }
            let decl = &s[i + 2..j.min(n)];
            match doctype(decl) {
                Some(Some((name, public, system))) => {
                    let parent = p.parent();
                    p.steps.node(OP_DOCTYPE, parent);
                    p.steps.text(name);
                    p.steps.text(public);
                    p.steps.text(system);
                    collect_entities(decl, &mut p.entities);
                }
                _ => p.err = true,
            }
            i = if j < n { j + 1 } else { n };
        } else if s.get(i + 1) == Some(&u16::from(b'?')) {
            let end = find(s, i + 2, "?>");
            let raw = &s[i + 2..end.unwrap_or(n)];
            i = end.map_or(n, |e| e + 2);
            let target_end = raw.iter().position(|&c| is_js_space(c) || c == u16::from(b'?')).unwrap_or(raw.len());
            // (…the `<?xml …?>` declaration is no processing instruction)
            if target_end > 0 && String::from_utf16_lossy(&raw[..target_end]).to_lowercase() != "xml" {
                let data_start = target_end + raw[target_end..].iter().take_while(|&&c| is_js_space(c)).count();
                let parent = p.parent();
                p.steps.node(OP_PI, parent);
                p.steps.text(raw[..target_end].to_vec());
                p.steps.text(raw[data_start..].to_vec());
            }
        } else if s.get(i + 1) == Some(&u16::from(b'/')) {
            let end = find_unit(s, i, b'>');
            let raw = &s[i + 2..end.unwrap_or(n)];
            let trimmed_end = raw.len() - raw.iter().rev().take_while(|&&c| is_js_space(c)).count();
            let end_name = &raw[..trimmed_end];
            // (…unterminated, white space before the name, or no name; trailing white space is allowed)
            if end.is_none() || raw.first().is_some_and(|&c| is_js_space(c)) || end_name.is_empty() {
                p.err = true;
            }
            match p.open.pop() {
                None => p.err = true,
                Some((_, open_name)) => {
                    if end_name != &open_name[..] {
                        p.err = true;
                    }
                    p.scopes.pop();
                }
            }
            i = end.map_or(n, |e| e + 1);
        } else {
            if s.get(i + 1).is_some_and(|&c| is_ws(c)) {
                p.err = true;
            }
            let Some(end) = tag_end(s, i) else {
                p.err = true;
                break;
            };
            let mut inner = &s[i + 1..end];
            let trailing = inner.iter().rev().take_while(|&&c| is_js_space(c)).count();
            let self_close = inner.len() > trailing && inner[inner.len() - trailing - 1] == u16::from(b'/');
            if self_close {
                inner = &inner[..inner.len() - trailing - 1];
            }
            let (name, attrs, bad) = parse_tag(inner, &mut p.err);
            if bad || !is_q_name(&name) {
                p.err = true;
            }
            i = end + 1;
            // (…this element's scope: its parent's and its own declarations — all of them first, as their order on the
            // element does not matter to which prefix an attribute has)
            let mut scope = p.scopes.last().cloned().unwrap_or_default();
            for (an, av) in &attrs {
                if an == &units("xmlns") {
                    scope.insert(Vec::new(), (!av.is_empty()).then(|| av.clone()));
                } else if let Some(prefix) = an.strip_prefix(&units("xmlns:")[..]) {
                    if !is_nc_name(prefix) || prefix == units("xmlns") {
                        p.err = true;
                    } else {
                        scope.insert(prefix.to_vec(), (!av.is_empty()).then(|| av.clone()));
                    }
                }
            }
            for (an, _) in &attrs {
                if an == &units("xmlns") || an.starts_with(&units("xmlns:")) {
                    continue;
                }
                if !is_q_name(an) {
                    p.err = true;
                    continue;
                }
                if let Some(colon) = an.iter().position(|&c| c == u16::from(b':')) {
                    let prefix = &an[..colon];
                    if prefix != units("xml") && !scope.contains_key(prefix) {
                        p.err = true;
                    }
                }
            }
            let colon = name.iter().position(|&c| c == u16::from(b':'));
            let (prefix, local) = match colon {
                Some(c) => (Some(name[..c].to_vec()), name[c + 1..].to_vec()),
                None => (None, name.clone()),
            };
            if prefix.as_ref().is_some_and(|pfx| pfx != &units("xml") && !scope.contains_key(pfx)) {
                p.err = true;
            }
            let ns = scope.get(prefix.as_deref().unwrap_or(&[])).cloned().flatten();
            // (…a second element at a document's top level: an XML document has one)
            if !p.fragment && p.open.is_empty() {
                p.roots += 1;
                if p.roots > 1 {
                    p.err = true;
                }
            }
            let parent = p.parent();
            let handle = p.steps.node(OP_ELEMENT, parent);
            p.steps.text(local);
            p.steps.optional(ns);
            p.steps.optional(prefix);
            p.steps.values.push(Value::Number(attrs.len() as i32));
            for (an, av) in attrs {
                // (…an attribute's namespace, prefix and local name, where it has a namespace — an `xmlns` one, an
                // `xml:` one, or one whose prefix the scope declares)
                let meta = if an == units("xmlns") {
                    Some((Some(units(XMLNS_NS)), None, units("xmlns")))
                } else {
                    an.iter().position(|&c| c == u16::from(b':')).map(|c| {
                        let (ap, al) = (an[..c].to_vec(), an[c + 1..].to_vec());
                        let ans = if ap == units("xmlns") {
                            Some(units(XMLNS_NS))
                        } else if ap == units("xml") {
                            Some(units(XML_NS))
                        } else {
                            scope.get(&ap).cloned().flatten()
                        };
                        (ans, Some(ap), al)
                    })
                };
                p.steps.text(an);
                p.steps.text(av);
                match meta {
                    Some((ans, ap, al)) => {
                        p.steps.optional(ans);
                        p.steps.optional(ap);
                        p.steps.text(al);
                    }
                    None => p.steps.values.extend([Value::Undefined, Value::Undefined, Value::Undefined]),
                }
            }
            if !self_close {
                p.open.push((handle, name));
                p.scopes.push(scope);
            }
        }
    }
    // (…an element left open)
    !p.err && p.open.is_empty()
}

// The in-scope namespace declarations of `context` — a fragment's context element, or a shadow root's host — its own
// and its ancestors' prefixes and `xmlns` / `xmlns:foo` declarations, the nearest winning, and where none declares the
// default, the context's own namespace (one `createElementNS` made carries no `xmlns`).
fn context_scope(arena: &crate::dom::RealmArena, context: crate::dom::NodeId) -> Scope {
    let mut scope = Scope::new();
    scope.insert(units("xml"), Some(units(XML_NS)));
    let start = arena.get(context).and_then(|n| n.host).unwrap_or(context);
    let mut chain = Vec::new();
    let mut at = Some(start);
    while let Some(id) = at.filter(|&id| arena.get(id).is_some_and(|n| n.kind == NodeKind::Element)) {
        chain.push(id);
        at = arena.parent_of(id);
    }
    for &id in chain.iter().rev() {
        let Some(n) = arena.get(id) else { continue };
        // (…an element's own prefix names its namespace, declared or not: `createElementNS('urn:x', 'c:e')`'s `c`)
        if let Some(prefix) = n.prefix.as_deref() {
            scope.insert(units(prefix), (!n.ns.is_empty()).then(|| units(&n.ns)));
        }
        // (…and a declaration is an attribute in the XMLNS namespace — `setAttribute('xmlns', …)` makes one in none,
        // which declares nothing — its value exactly)
        for (key, attr_ns, local) in &n.attr_ns {
            if attr_ns != XMLNS_NS {
                continue;
            }
            let value = n.get_attr(key).map(|v| n.get_attr_u16(key).map_or_else(|| units(v), <[u16]>::to_vec)).filter(|v| !v.is_empty());
            scope.insert(if local == "xmlns" { Vec::new() } else { units(local) }, value);
        }
    }
    if !scope.contains_key(&Vec::new()) {
        if let Some(n) = arena.get(start).filter(|n| n.kind == NodeKind::Element && !n.ns.is_empty()) {
            scope.insert(Vec::new(), Some(units(&n.ns)));
        }
    }
    scope
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "xmlParse", xml_parse, context_id);
}

// __dom.xmlParse(source, contextNid) -> the steps that make its nodes — `[op, parent, …]` each, the next node's
// (`OP_*`; parent -1 for the top level): an element `localName, namespace, prefix, attributeCount` and its attributes
// `name, value, namespace, prefix, localName` (the last three undefined for one in no namespace); a text, a comment or a
// CDATA section its data; a processing instruction its target and data; a doctype its name and public and system ids —
// or null where the source is not well-formed. A document's source where `contextNid` is -1, else a fragment's in that
// element's namespace scope.
fn xml_parse(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let src = crate::dom::utf16_arg(scope, args.get(0));
    let context = nid_arg(scope, &args, 1);
    let initial = match context {
        Some(c) => context_scope(&crate::dom::dom(scope).arena, c),
        None => {
            let mut s = Scope::new();
            s.insert(units("xml"), Some(units(XML_NS)));
            s
        }
    };
    let mut steps = Steps { values: Vec::new(), next: 0 };
    if !parse_into(&src, &mut steps, initial, context.is_some(), -1) {
        return rv.set_null();
    }
    let values: Vec<v8::Local<'_, v8::Value>> = steps
        .values
        .into_iter()
        .map(|v| match v {
            Value::Number(n) => v8::Integer::new(scope, n).into(),
            Value::Text(u) => crate::dom::utf16_value(scope, &u),
            Value::Null => v8::null(scope).into(),
            Value::Undefined => v8::undefined(scope).into(),
        })
        .collect();
    rv.set(v8::Array::new_with_elements(scope, &values).into());
}
