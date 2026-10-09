// Native CSS selector matching over the live arena, using Servo's `selectors` crate — the
// production engine (the same one Firefox ships), so tree-structural selectors (`:nth-child`,
// `:not`, `:is`, `:where`, `:has`, combinators, attribute operators, case-sensitivity) are correct
// by construction. It answers the page's `querySelector(All)` / `matches` / `closest` (selectors.js) and the Capybara
// finds — every selector, invalid ones aside.
//
// Ported from the unmerged native-selector-matching branch, where it matched against a JSON MIRROR
// of the DOM that was serialized and copied across the FFI on every navigation — the boundary tax
// that made that approach lose to the JS cascade. Here it reads the LIVE arena (crate::dom) directly.
//
// Element state (`:hover`, `:checked`, `:focus`, `:disabled`, `:dir()`, …) is the arena's own (element_state.rs); a
// shadow tree's top-level element reaches its host (`:host`), and an attribute is matched by its namespace and local
// name. A pseudo-element (`::before`, `::slotted()`, `::part()`) matches no element.

use std::borrow::Borrow;
use std::fmt;

use cssparser::{CowRcStr, Parser as CssParser, ParserInput, SourceLocation, ToCss};
use precomputed_hash::PrecomputedHash;
use selectors::attr::{AttrSelectorOperation, AttrSelectorOperator, CaseSensitivity, NamespaceConstraint};
use selectors::context::{
    MatchingContext, MatchingForInvalidation, MatchingMode, NeedsSelectorFlags, QuirksMode,
    SelectorCaches,
};
use selectors::matching::{matches_selector_list, ElementSelectorFlags};
use selectors::parser::{
    NonTSPseudoClass, ParseRelative, Parser, PseudoElement, SelectorImpl,
    SelectorList, SelectorParseErrorKind,
};
use selectors::{Element, OpaqueElement};

use crate::dom::{NodeId, RealmArena};

pub(crate) const HTML_NS: &str = "http://www.w3.org/1999/xhtml";

// A CSS string (idents, local names, namespaces, attribute values). Wraps String to satisfy the
// selectors associated-type bounds (PrecomputedHash / Borrow<str>) a bare String can't.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct CssStr(pub String);

impl<'a> From<&'a str> for CssStr {
    fn from(s: &'a str) -> Self {
        CssStr(s.to_owned())
    }
}
impl Borrow<str> for CssStr {
    fn borrow(&self) -> &str {
        &self.0
    }
}
impl AsRef<str> for CssStr {
    fn as_ref(&self) -> &str {
        &self.0
    }
}
impl PrecomputedHash for CssStr {
    fn precomputed_hash(&self) -> u32 {
        // FNV-1a over the bytes — cheap and stable, which is all the bloom filter needs.
        let mut h: u32 = 0x811c_9dc5;
        for b in self.0.as_bytes() {
            h ^= *b as u32;
            h = h.wrapping_mul(0x0100_0193);
        }
        h
    }
}
impl ToCss for CssStr {
    fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
        dest.write_str(&self.0)
    }
}

#[derive(Debug, Clone)]
pub struct CsimImpl;

impl SelectorImpl for CsimImpl {
    type ExtraMatchingData<'a> = ();
    type AttrValue = CssStr;
    type Identifier = CssStr;
    type LocalName = CssStr;
    type NamespaceUrl = CssStr;
    type NamespacePrefix = CssStr;
    type BorrowedNamespaceUrl = str;
    type BorrowedLocalName = str;
    type NonTSPseudoClass = PseudoClass;
    type PseudoElement = PseudoEl;
}

// A non-tree-structural pseudo-class (`:hover`, `:checked`, `:state(open)`, …): its ASCII-lowercased name, and a
// functional one's argument — one `is_native_pseudo_class` names (any other is invalid).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PseudoClass {
    name: String,
    arg: Option<String>,
}

impl ToCss for PseudoClass {
    fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
        dest.write_char(':')?;
        dest.write_str(&self.name)?;
        if let Some(arg) = &self.arg {
            dest.write_char('(')?;
            cssparser::serialize_identifier(arg, dest)?;
            dest.write_char(')')?;
        }
        Ok(())
    }
}
impl NonTSPseudoClass for PseudoClass {
    type Impl = CsimImpl;
    fn is_active_or_hover(&self) -> bool {
        self.arg.is_none() && (self.name == "active" || self.name == "hover")
    }
    fn is_user_action_state(&self) -> bool {
        self.arg.is_none() && matches!(self.name.as_str(), "active" | "hover" | "focus" | "focus-within" | "focus-visible")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PseudoEl(String);

impl ToCss for PseudoEl {
    fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
        dest.write_str("::")?;
        dest.write_str(&self.0)
    }
}
impl PseudoElement for PseudoEl {
    type Impl = CsimImpl;
    // A tree-abiding pseudo-element may follow `::slotted()` (CSS Scoping): `::slotted(p)::before`.
    fn valid_after_slotted(&self) -> bool {
        matches!(self.0.as_str(), "before" | "after" | "marker" | "placeholder" | "file-selector-button")
    }
}

// The parser: everything tree-structural is handled by the crate; we name the non-TS pseudo-classes and the
// pseudo-elements. One it does not know is a parse error — invalid, as in Chrome and Firefox; inside a forgiving
// `:is()` / `:where()` the crate drops just that selector.
//
// `namespaces`: the prefixes a style sheet's `@namespace` rules declare, and its default namespace — none for a query,
// where a prefix other than `*` is invalid.
#[derive(Default)]
struct CsimParser<'n> {
    namespaces: Option<&'n Namespaces>,
}

// A style sheet's `@namespace` declarations.
#[derive(Default)]
pub struct Namespaces {
    pub default: Option<String>,
    pub prefixes: Vec<(String, String)>,
}

impl<'i> Parser<'i> for CsimParser<'_> {
    type Impl = CsimImpl;
    type Error = SelectorParseErrorKind<'i>;

    fn parse_is_and_where(&self) -> bool {
        true
    }
    fn parse_has(&self) -> bool {
        true
    }
    fn parse_nth_child_of(&self) -> bool {
        true
    }
    fn parse_part(&self) -> bool {
        true
    }
    fn parse_slotted(&self) -> bool {
        true
    }
    fn parse_host(&self) -> bool {
        true
    }
    fn default_namespace(&self) -> Option<CssStr> {
        self.namespaces?.default.clone().map(CssStr)
    }
    fn namespace_for_prefix(&self, prefix: &CssStr) -> Option<CssStr> {
        let (_, url) = self.namespaces?.prefixes.iter().find(|(p, _)| *p == prefix.0)?;
        Some(CssStr(url.clone()))
    }

    fn parse_non_ts_pseudo_class(
        &self,
        location: SourceLocation,
        name: CowRcStr<'i>,
    ) -> Result<PseudoClass, cssparser::ParseError<'i, Self::Error>> {
        let lower = name.as_ref().to_ascii_lowercase();
        if !is_native_pseudo_class(&lower) {
            return Err(location.new_custom_error(SelectorParseErrorKind::UnsupportedPseudoClassOrElement(name)));
        }
        Ok(PseudoClass { name: lower, arg: None })
    }

    fn parse_non_ts_functional_pseudo_class<'t>(
        &self,
        name: CowRcStr<'i>,
        arguments: &mut CssParser<'i, 't>,
        _after_part: bool,
    ) -> Result<PseudoClass, cssparser::ParseError<'i, Self::Error>> {
        let name = name.as_ref().to_ascii_lowercase();
        // `:state(<ident>)` — a custom element's custom state — and `:lang()` / `:dir()` below are answered here; any
        // other functional one (and one of these whose argument is not what it takes) is invalid. (`:nth-child()` and
        // friends are tree-structural, the crate's own, and never reach here.)
        if name == "state" {
            let state = arguments.try_parse(|p| {
                let ident = p.expect_ident()?.as_ref().to_owned();
                p.expect_exhausted()?;
                Ok::<_, cssparser::ParseError<'i, ()>>(ident)
            });
            if let Ok(ident) = state {
                return Ok(PseudoClass { name, arg: Some(ident) });
            }
        }
        // `:lang(<range>#)` — idents or strings, each ASCII-lowercased; kept comma-joined, as `matches_lang` splits its
        // argument.
        if name == "lang" {
            let ranges = arguments.try_parse(|p| {
                let ranges = p.parse_comma_separated(|p| {
                    let t = p.next()?.clone();
                    match t {
                        cssparser::Token::Ident(v) | cssparser::Token::QuotedString(v) => Ok(v.as_ref().to_ascii_lowercase()),
                        _ => Err(p.new_unexpected_token_error::<()>(t)),
                    }
                })?;
                p.expect_exhausted()?;
                Ok::<_, cssparser::ParseError<'i, ()>>(ranges.join(","))
            });
            if let Ok(ranges) = ranges {
                return Ok(PseudoClass { name, arg: Some(ranges) });
            }
        }
        // `:dir(<ident>)` — the element's directionality (element_state.rs `is_rtl`); an ident other than `ltr` / `rtl`
        // is valid and matches nothing.
        if name == "dir" {
            let ident = arguments.try_parse(|p| {
                let ident = p.expect_ident()?.as_ref().to_ascii_lowercase();
                p.expect_exhausted()?;
                Ok::<_, cssparser::ParseError<'i, ()>>(ident)
            });
            if let Ok(ident) = ident {
                return Ok(PseudoClass { name, arg: Some(ident) });
            }
        }
        Err(arguments.new_custom_error(SelectorParseErrorKind::UnsupportedPseudoClassOrElement(name.into())))
    }

    // A pseudo-element is no element, so a selector naming one matches none (`querySelector('div::before')` is null) —
    // but only one the CSS specifications define parses; any other is a SyntaxError. The set Chrome and Firefox both
    // accept, and `::spelling-error` / `::grammar-error`, which CSS Pseudo-Elements 4 defines (Firefox has neither).
    fn parse_pseudo_element(
        &self,
        location: SourceLocation,
        name: CowRcStr<'i>,
    ) -> Result<PseudoEl, cssparser::ParseError<'i, Self::Error>> {
        let lower = name.as_ref().to_ascii_lowercase();
        if !matches!(
            lower.as_str(),
            "before" | "after" | "marker" | "placeholder" | "selection" | "backdrop" | "target-text" | "cue"
                | "file-selector-button" | "spelling-error" | "grammar-error" | "first-line" | "first-letter"
                | "details-content" | "view-transition"
        ) {
            return Err(location.new_custom_error(SelectorParseErrorKind::UnsupportedPseudoClassOrElement(name)));
        }
        Ok(PseudoEl(lower))
    }

    // The functional ones, likewise matching no element: `::highlight(<custom-ident>)`, and the view transitions'
    // `::view-transition-group()` / `-image-pair()` / `-old()` / `-new()` of `*` or a name (with `.class`es), or none.
    fn parse_functional_pseudo_element<'t>(
        &self,
        name: CowRcStr<'i>,
        arguments: &mut CssParser<'i, 't>,
    ) -> Result<PseudoEl, cssparser::ParseError<'i, Self::Error>> {
        let lower = name.as_ref().to_ascii_lowercase();
        match lower.as_str() {
            "highlight" => {
                arguments.expect_ident()?;
            }
            "view-transition-group" | "view-transition-image-pair" | "view-transition-old" | "view-transition-new" => {
                // `<pt-name-and-class-selector>`: `*` or a name, then `.class`es — or the classes alone — each a
                // `<custom-ident>` (no CSS-wide keyword, no `default`), a class's dot directly before it.
                let custom_ident = |ident: &str| {
                    !["initial", "inherit", "unset", "revert", "revert-layer", "default"].iter().any(|k| ident.eq_ignore_ascii_case(k))
                };
                let named = arguments.try_parse(|p| p.expect_delim('*')).is_ok()
                    || arguments.try_parse(|p| p.expect_ident().map(|i| custom_ident(i)).ok().filter(|&ok| ok).ok_or(())).is_ok();
                let mut classes = 0;
                while !arguments.is_exhausted() {
                    arguments.expect_delim('.')?;
                    let location = arguments.current_source_location();
                    match arguments.next_including_whitespace()? {
                        cssparser::Token::Ident(class) if custom_ident(class) => classes += 1,
                        token => {
                            let token = token.clone();
                            return Err(location.new_unexpected_token_error(token));
                        }
                    }
                }
                if !named && classes == 0 {
                    return Err(arguments.new_custom_error(SelectorParseErrorKind::UnsupportedPseudoClassOrElement(name)));
                }
            }
            _ => return Err(arguments.new_custom_error(SelectorParseErrorKind::UnsupportedPseudoClassOrElement(name))),
        }
        Ok(PseudoEl(lower))
    }
}

// An attribute selector's operator over a value holding a lone surrogate, which the arena's UTF-8 copy carries as
// U+FFFD — read from its UTF-16, so `#\d83d x` (a U+FFFD) does not match a lone U+D83D.
fn eval_utf16(operator: AttrSelectorOperator, case: CaseSensitivity, value: &[u16], wanted: &str) -> bool {
    let wanted: Vec<u16> = wanted.encode_utf16().collect();
    let fold = |u: u16| if (b'A' as u16..=b'Z' as u16).contains(&u) { u + 32 } else { u };
    let eq = |a: &[u16], b: &[u16]| match case {
        CaseSensitivity::CaseSensitive => a == b,
        CaseSensitivity::AsciiCaseInsensitive => a.len() == b.len() && a.iter().zip(b).all(|(&x, &y)| fold(x) == fold(y)),
    };
    let n = wanted.len();
    match operator {
        AttrSelectorOperator::Equal => eq(value, &wanted),
        AttrSelectorOperator::Prefix => n > 0 && value.len() >= n && eq(&value[..n], &wanted),
        AttrSelectorOperator::Suffix => n > 0 && value.len() >= n && eq(&value[value.len() - n..], &wanted),
        AttrSelectorOperator::Substring => n > 0 && value.windows(n).any(|w| eq(w, &wanted)),
        AttrSelectorOperator::Includes => {
            n > 0 && value.split(|&u| matches!(u, 0x09 | 0x0A | 0x0C | 0x0D | 0x20)).any(|w| eq(w, &wanted))
        }
        AttrSelectorOperator::DashMatch => {
            eq(value, &wanted) || (value.len() > n && value[n] == b'-' as u16 && eq(&value[..n], &wanted))
        }
    }
}

// The host of the shadow tree `id` is in, if it is in one.
fn shadow_host_of(arena: &RealmArena, id: NodeId) -> Option<NodeId> {
    let mut cur = id;
    while let Some(p) = arena.parent_of(cur) {
        cur = p;
    }
    arena.get(cur)?.host
}

// A handle into the arena: which arena, and the generational id of the node. Copy so the Element
// trait's element-returning methods are cheap. Only ever constructed for a LIVE node — the query seed
// filters stale ids, and every navigation method returns gen-checked (live) ids — so `node()` resolves.
#[derive(Clone, Copy)]
pub struct NodeRef<'a> {
    pub arena: &'a RealmArena,
    pub id: NodeId,
    // Whether the node's document is an HTML document — in an XML one (XHTML, an XML DOMParser's) an HTML element's
    // type and attribute selectors match case-sensitively, as any other element's.
    pub html_doc: bool,
}

impl<'a> NodeRef<'a> {
    fn at(&self, id: NodeId) -> NodeRef<'a> {
        NodeRef { arena: self.arena, id, html_doc: self.html_doc }
    }
    fn node(&self) -> &'a crate::dom::NodeData {
        self.arena.get(self.id).expect("NodeRef points at a live node")
    }
}

impl fmt::Debug for NodeRef<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "<{}>", self.node().local_name)
    }
}

impl<'a> Element for NodeRef<'a> {
    type Impl = CsimImpl;

    fn opaque(&self) -> OpaqueElement {
        OpaqueElement::new(self.node())
    }

    // The parent ELEMENT: a document, a fragment or a shadow root is none (`* > html` and `:not(.x) > html` match
    // nothing, as in any browser).
    fn parent_element(&self) -> Option<Self> {
        self.arena.parent_of(self.id).filter(|&p| self.arena.is_element(p)).map(|p| self.at(p))
    }
    // A shadow tree's top-level element: its parent is the shadow root, whose host the crate crosses to — featureless,
    // so only `:host` matches it there (`:host > p`, `:host(.x) p`).
    fn parent_node_is_shadow_root(&self) -> bool {
        self.arena.parent_of(self.id).is_some_and(|p| self.arena.get(p).is_some_and(|n| n.host.is_some()))
    }
    fn containing_shadow_host(&self) -> Option<Self> {
        shadow_host_of(self.arena, self.id).map(|host| self.at(host))
    }
    fn is_pseudo_element(&self) -> bool {
        false
    }

    fn prev_sibling_element(&self) -> Option<Self> {
        self.arena.prev_element_sibling(self.id).map(|s| self.at(s))
    }
    fn next_sibling_element(&self) -> Option<Self> {
        self.arena.next_element_sibling(self.id).map(|s| self.at(s))
    }
    fn first_element_child(&self) -> Option<Self> {
        self.arena.first_element_child(self.id).map(|c| self.at(c))
    }

    fn is_html_element_in_html_document(&self) -> bool {
        self.html_doc && self.node().is_html()
    }

    fn has_local_name(&self, name: &str) -> bool {
        &*self.node().local_name == name
    }
    fn has_namespace(&self, ns: &str) -> bool {
        &*self.node().ns == ns
    }
    fn is_same_type(&self, other: &Self) -> bool {
        self.node().local_name == other.node().local_name && self.node().ns == other.node().ns
    }

    fn attr_matches(
        &self,
        ns: &NamespaceConstraint<&CssStr>,
        local_name: &CssStr,
        operation: &AttrSelectorOperation<&CssStr>,
    ) -> bool {
        // Each attribute by its namespace and local name (`[*|href]`, `[svg|href]`, `[title]` = in no namespace) — as
        // DOM has them, not by the store's key: an XLink `xlink:href` is an `href` in the XLink namespace.
        let node = self.node();
        let value_matches = |key: &String, value: &String| match (operation, node.get_attr_u16(key)) {
            (AttrSelectorOperation::WithValue { operator, case_sensitivity, value: wanted }, Some(units)) => {
                eval_utf16(*operator, *case_sensitivity, units, &wanted.0)
            }
            _ => operation.eval_str(value),
        };
        let local = local_name.0.as_str();
        // (…on an element with no namespaced attribute — nearly every one — each is in no namespace, named by its key:
        // matched by the key alone, with no record looked up per attribute, which cost an attribute selector 2.5x)
        if node.attr_ns.is_empty() {
            if matches!(ns, NamespaceConstraint::Specific(url) if !url.0.is_empty()) {
                return false;
            }
            return node.attributes.iter().any(|(key, value)| crate::dom::store_key_names(key, local) && value_matches(key, value));
        }
        node.attributes.iter().any(|(key, value)| {
            let (attr_ns, attr_local) = node.attribute_name(key);
            attr_local == local
                && match ns {
                    NamespaceConstraint::Any => true,
                    NamespaceConstraint::Specific(url) => url.0 == attr_ns,
                }
                && value_matches(key, value)
        })
    }
    fn has_attr_in_no_namespace(&self, local_name: &CssStr) -> bool {
        let node = self.node();
        if node.attr_ns.is_empty() {
            return node.attributes.iter().any(|(key, _)| crate::dom::store_key_names(key, &local_name.0));
        }
        node.attributes.iter().any(|(key, _)| node.attribute_name(key) == ("", local_name.0.as_str()))
    }

    fn match_non_ts_pseudo_class(
        &self,
        pc: &PseudoClass,
        _context: &mut MatchingContext<CsimImpl>,
    ) -> bool {
        // Every name `is_native_pseudo_class` admits; the element states are element_state.rs's.
        let (arena, id) = (self.arena, self.id);
        if let Some(arg) = &pc.arg {
            return match pc.name.as_str() {
                "state" => arena.has_custom_state(id, arg),
                "lang" => arena.matches_lang(id, arg),
                "dir" => match arg.as_str() {
                    "rtl" => arena.is_rtl(id),
                    "ltr" => !arena.is_rtl(id),
                    _ => false,
                },
                _ => false,
            };
        }
        match pc.name.as_str() {
            "link" | "any-link" | "-webkit-any-link" => self.is_link(),
            "focus" => arena.is_focused(id),
            "focus-visible" => arena.is_focus_visible(id),
            "focus-within" => arena.has_focus_within(id),
            "hover" => arena.is_hovered(id),
            "checked" => arena.is_checked(id),
            "indeterminate" => arena.is_indeterminate(id),
            "disabled" => arena.is_actually_disabled(id),
            "enabled" => arena.is_enabled(id),
            "read-write" => arena.is_read_write(id),
            "read-only" => !arena.is_read_write(id),
            "default" => arena.is_default(id),
            "open" => arena.is_open(id),
            "placeholder-shown" => arena.is_placeholder_shown(id),
            "target" => arena.is_target(id),
            "valid" => arena.is_valid_pseudo(id) == Some(true),
            "invalid" => arena.is_valid_pseudo(id) == Some(false),
            "user-valid" => arena.is_user_valid_pseudo(id) == Some(true),
            "user-invalid" => arena.is_user_valid_pseudo(id) == Some(false),
            "in-range" => arena.is_in_range(id) == Some(true),
            "out-of-range" => arena.is_in_range(id) == Some(false),
            "defined" => arena.is_defined(id),
            "required" => arena.requiredness(id) == Some(true),
            "optional" => arena.requiredness(id) == Some(false),
            "popover-open" => arena.is_popover_open(id),
            "modal" => arena.is_modal(id),
            "filtered" => arena.is_filtered(id),
            // No history, no pressed pointer, no autofill and no fullscreen (`document.fullscreenElement` is always
            // null): nothing is visited, active, autofilled or fullscreen.
            _ => false,
        }
    }
    fn match_pseudo_element(
        &self,
        _pe: &PseudoEl,
        _context: &mut MatchingContext<CsimImpl>,
    ) -> bool {
        false
    }

    fn apply_selector_flags(&self, _flags: ElementSelectorFlags) {}

    fn is_link(&self) -> bool {
        self.node().is_hyperlink()
    }
    fn is_html_slot_element(&self) -> bool {
        self.node().is_html_named("slot")
    }

    fn has_id(&self, id: &CssStr, case: CaseSensitivity) -> bool {
        if let Some(units) = self.node().get_attr_u16("id") {
            return eval_utf16(AttrSelectorOperator::Equal, case, units, &id.0);
        }
        match self.node().get_attr("id") {
            Some(v) if !v.is_empty() => case.eq(v.as_bytes(), id.0.as_bytes()),
            _ => false,
        }
    }
    fn has_class(&self, name: &CssStr, case: CaseSensitivity) -> bool {
        if let Some(units) = self.node().get_attr_u16("class") {
            return eval_utf16(AttrSelectorOperator::Includes, case, units, &name.0);
        }
        self.node()
            .get_attr("class")
            .unwrap_or("")
            // ASCII whitespace, as HTML tokenizes `class`: a U+00A0 is part of a class name, not a separator.
            .split_ascii_whitespace()
            .any(|c| case.eq(c.as_bytes(), name.0.as_bytes()))
    }
    fn has_custom_state(&self, name: &CssStr) -> bool {
        self.arena.has_custom_state(self.id, &name.0)
    }
    fn imported_part(&self, _name: &CssStr) -> Option<CssStr> {
        None
    }
    fn is_part(&self, _name: &CssStr) -> bool {
        false
    }

    fn is_empty(&self) -> bool {
        self.arena.is_empty(self.id)
    }
    // `:root` is the DOCUMENT's element only — a detached element, or a fragment's child, is no root.
    fn is_root(&self) -> bool {
        self.arena.parent_of(self.id).is_some_and(|p| self.arena.is_document(p))
    }

    fn add_element_unique_hashes(&self, _filter: &mut selectors::bloom::BloomFilter) -> bool {
        // Opt out of the ancestor bloom optimization for now (correctness first).
        false
    }
}

// The non-tree-structural pseudo-classes this engine knows — any other is invalid. Their state is the arena's
// (element_state.rs); `:visited`, `:active`, `:autofill` and `:fullscreen` parse and never match (no history, no pressed
// pointer, no autofill, no fullscreen element). The crate's BUILT-INS bypass this list: the tree-structural ones,
// `:scope`, and `:host`.
fn is_native_pseudo_class(name: &str) -> bool {
    matches!(
        name,
        "link"
            | "any-link"
            | "-webkit-any-link"
            | "visited"
            | "active"
            | "autofill"
            | "-webkit-autofill"
            | "focus"
            | "focus-visible"
            | "focus-within"
            | "hover"
            | "checked"
            | "indeterminate"
            | "disabled"
            | "enabled"
            | "read-write"
            | "read-only"
            | "default"
            | "open"
            | "placeholder-shown"
            | "target"
            | "valid"
            | "invalid"
            | "user-valid"
            | "user-invalid"
            | "in-range"
            | "out-of-range"
            | "required"
            | "optional"
            | "defined"
            | "popover-open"
            | "modal"
            | "filtered"
            | "fullscreen"
    )
}

// Parse a selector list, or None if invalid.
fn parse(text: &str, namespaces: Option<&Namespaces>) -> Option<SelectorList<CsimImpl>> {
    let mut input = ParserInput::new(text);
    let mut parser = CssParser::new(&mut input);
    SelectorList::parse(&CsimParser { namespaces }, &mut parser, ParseRelative::No).ok()
}

// Is `text` a selector this engine supports — CSS.supports('selector(…)') / `@supports selector(…)`?
pub fn is_valid(text: &str) -> bool {
    with_parsed(text, None, |list| list.is_some())
}

// Parsed-selector cache — the driver emits a small recurring set of selectors, so parsing each once
// and reusing it keeps matching off the parser. Keyed by the selector text, and BOUNDED: a page's own
// queries interpolate ids (`#comment_123`, `[data-id="7"]`) without end, and the cache outlives sessions.
thread_local! {
    static CACHE: std::cell::RefCell<std::collections::HashMap<String, Option<SelectorList<CsimImpl>>>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}
const CACHE_LIMIT: usize = 4096;

// The cached parse of `text` (parsed and stored on a miss — the cache emptied first when it is full), to `f`; under a
// style sheet's `namespaces`, keyed by them too.
fn with_parsed<R>(text: &str, namespaces: Option<&Namespaces>, f: impl FnOnce(Option<&SelectorList<CsimImpl>>) -> R) -> R {
    let keyed;
    let key = match namespaces {
        None => text,
        Some(ns) => {
            let mut k = format!("{text}\u{1}{}", ns.default.as_deref().unwrap_or("\u{0}"));
            for (prefix, url) in &ns.prefixes {
                k.push_str(&format!("\u{2}{prefix}\u{3}{url}"));
            }
            keyed = k;
            &keyed
        }
    };
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        if !c.contains_key(key) {
            if c.len() >= CACHE_LIMIT {
                c.clear();
            }
            c.insert(key.to_owned(), parse(text, namespaces));
        }
        f(c.get(key).and_then(Option::as_ref))
    })
}

// The document's mode as the matcher takes it: in a quirks-mode document a class or id selector matches ASCII
// case-insensitively (Selectors 4 §6.6 / §6.7) — the crate hands `has_class` / `has_id` the sensitivity from this.
pub fn quirks_mode(quirks: bool) -> QuirksMode {
    if quirks {
        QuirksMode::Quirks
    } else {
        QuirksMode::NoQuirks
    }
}

// Collect descendants of `root` (preorder / document order) matching `list`, with `:scope` bound to
// `scope` — the query root, or a document's root element (a Document is no element for `:scope` to be) — so
// `:scope > .child` resolves against it. `first_only` stops at the first hit (querySelector).
//
// `:scope` binding: the crate matches `Component::Scope` as `element.opaque() == scope_element` when
// the context sets it, falling back to `is_root()` when it doesn't (context.rs / matching.rs).
// `is_root()` would wrongly resolve `:scope` to the arena root, so we set scope_element to `root`;
// OpaqueElement is a type-erased pointer (no borrow), so it outlives the short dom borrow here.
//
// ONE MatchingContext (and its SelectorCaches — the nth-index cache) is reused across every
// candidate, the crate's intended usage; a fresh cache per candidate would be pure waste. The
// matcher walks each candidate's full ancestor chain, so ancestor-dependent combinators resolve
// correctly even above `root`.
pub fn query(arena: &RealmArena, root: NodeId, scope: NodeId, list: &SelectorList<CsimImpl>, first_only: bool, quirks: bool, html_doc: bool) -> Vec<NodeId> {
    let mut out = Vec::new();
    if arena.get(root).is_none() {
        return out;
    }
    // Seed with the root's LIVE element children, reversed so the stack pops in document order.
    let mut stack: Vec<NodeId> = arena.element_children(root);
    stack.reverse();
    let mut caches = SelectorCaches::default();
    let mut ctx = MatchingContext::new(
        MatchingMode::Normal,
        None,
        &mut caches,
        quirks_mode(quirks),
        NeedsSelectorFlags::No,
        MatchingForInvalidation::No,
    );
    ctx.scope_element = Some(NodeRef { arena, id: scope, html_doc }.opaque());
    // (`:host` is the host of the shadow tree the query is scoped in — none for a document's)
    ctx.current_host = shadow_host_of(arena, scope).map(|host| NodeRef { arena, id: host, html_doc }.opaque());
    // Backstop for the DESCENDANT DFS below only: an acyclic subtree pushes each node onto `stack` at
    // most once, so a pop count past the slot count means a `children` cycle was planted, and we break
    // rather than spin the isolate forever (no V8 interrupt reaches native code). It does NOT bound the
    // crate's ANCESTOR walk (repeated parent_element for descendant/sibling combinators, inside a single
    // matches_selector_list) — that relies on the arena being ACYCLIC, which it is: the arena mirrors the
    // always-acyclic JS DOM, and sync_children rejects self-cycles + stale/duplicate edges. Only a buggy
    // driver planting a genuine parent-chain cycle (never a real DOM) could hang that walk; the same
    // acyclicity assumption Servo itself makes. matches_compiled / matches_text share it.
    let cap = arena.slot_count().saturating_add(1);
    let mut steps = 0usize;
    while let Some(id) = stack.pop() {
        // A stale edge (child freed + slot reused) reads absent — skip it, never alias the reoccupant.
        if arena.get(id).is_none() {
            continue;
        }
        steps += 1;
        if steps > cap {
            break;
        }
        if matches_selector_list(list, &NodeRef { arena, id, html_doc }, &mut ctx) {
            out.push(id);
            if first_only {
                return out;
            }
        }
        // (…its element children, pushed in reverse so they pop in order — straight off the node's list, no copy)
        if let Some(node) = arena.get(id) {
            stack.extend(node.children.iter().rev().copied().filter(|&c| arena.is_element(c)));
        }
    }
    out
}

// Parse (cached) + collect: the matched ids, or None for an invalid selector (the caller's SyntaxError).
pub fn query_text(arena: &RealmArena, root: NodeId, scope: NodeId, text: &str, first_only: bool, quirks: bool, html_doc: bool) -> Option<Vec<NodeId>> {
    with_parsed(text, None, |list| list.map(|list| query(arena, root, scope, list, first_only, quirks, html_doc)))
}

// Does ONE element match the selector — or, `closest`, which of it and its ancestors is the nearest that does? The
// matching element's id (None for none), or None outside for an invalid selector. `scoped` binds `:scope` to the element the
// question is asked of (Element.matches / closest, whose scoping root is the element itself); unscoped — a cascade rule
// — has no scoping root. The matcher walks the full ancestor chain for descendant / child combinators.
pub fn matches_text(
    arena: &RealmArena,
    id: NodeId,
    text: &str,
    namespaces: Option<&Namespaces>,
    quirks: bool,
    html_doc: bool,
    scoped: bool,
    closest: bool,
) -> Option<Option<NodeId>> {
    with_parsed(text, namespaces, |list| {
        match list {
            None => None,
            Some(list) => {
                if arena.get(id).is_none() {
                    return Some(None);
                }
                let mut caches = SelectorCaches::default();
                let mut ctx = MatchingContext::new(
                    MatchingMode::Normal,
                    None,
                    &mut caches,
                    quirks_mode(quirks),
                    NeedsSelectorFlags::No,
                    MatchingForInvalidation::No,
                );
                if scoped {
                    ctx.scope_element = Some(NodeRef { arena, id, html_doc }.opaque());
                }
                ctx.current_host = shadow_host_of(arena, id).map(|host| NodeRef { arena, id: host, html_doc }.opaque());
                let mut at = Some(id);
                while let Some(candidate) = at {
                    if matches_selector_list(list, &NodeRef { arena, id: candidate, html_doc }, &mut ctx) {
                        return Some(Some(candidate));
                    }
                    at = if closest { arena.parent_of(candidate).filter(|&up| arena.is_element(up)) } else { None };
                }
                Some(None)
            }
        }
    })
}
