// Native CSS selector matching over the live arena, using Servo's `selectors` crate — the
// production engine (the same one Firefox ships), so tree-structural selectors (`:nth-child`,
// `:not`, `:is`, `:where`, `:has`, combinators, attribute operators, case-sensitivity) are correct
// by construction. It answers the page's `querySelector(All)` / `matches` / `closest` first
// (selectors.js), the cascade's per-rule matches, and the Capybara finds.
//
// Ported from the unmerged native-selector-matching branch, where it matched against a JSON MIRROR
// of the DOM that was serialized and copied across the FFI on every navigation — the boundary tax
// that made that approach lose to the JS cascade. Here it reads the LIVE arena (crate::dom) directly.
//
// Element state (`:hover`, `:checked`, `:focus`, `:disabled`, `:dir()`, …) is the arena's own
// (element_state.rs). What it cannot answer yet — a shadow-tree construct (`:host`, `::slotted()`,
// `::part()`), an attribute selector with a namespace, a functional pseudo-class it does not know —
// is flagged at parse time (`needs_fallback`) and reported as `QueryOutcome::NeedsJsFallback`:
// NOT matched natively, because the answer would be a wrong subset; the caller runs css-select.

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
    Component, NonTSPseudoClass, ParseRelative, Parser, PseudoElement, RelativeSelector, SelectorImpl,
    SelectorList, SelectorParseErrorKind,
};
use selectors::visitor::SelectorVisitor;
use selectors::{Element, OpaqueElement};

use web_atoms::ns;
use crate::dom::{NodeId, RealmArena};

pub(crate) const HTML_NS: &str = "http://www.w3.org/1999/xhtml";
const XLINK_NS: &str = "http://www.w3.org/1999/xlink";

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
// functional one's argument. Parsing accepts every one so real selectors parse; the ones `is_native_pseudo_class`
// does not name send the selector to css-select (see match_non_ts_pseudo_class).
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
#[derive(Default)]
struct CsimParser;

impl<'i> Parser<'i> for CsimParser {
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
        // `:state(<ident>)` — a custom element's custom state — is answered here; any other functional one (and a
        // `:state()` of anything but one ident) is css-select's: its tokens are consumed so the selector parses.
        // (`:nth-child()` and friends are tree-structural, the crate's own, and never reach here.)
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
        // `:lang(<range>#)` — idents or strings, each ASCII-lowercased; kept comma-joined, as selectors.js `langRanges`
        // splits its argument.
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
    fn parent_node_is_shadow_root(&self) -> bool {
        false
    }
    fn containing_shadow_host(&self) -> Option<Self> {
        None
    }
    fn is_pseudo_element(&self) -> bool {
        false
    }

    fn prev_sibling_element(&self) -> Option<Self> {
        self.arena.prev_sibling(self.id).map(|s| self.at(s))
    }
    fn next_sibling_element(&self) -> Option<Self> {
        self.arena.next_sibling(self.id).map(|s| self.at(s))
    }
    fn first_element_child(&self) -> Option<Self> {
        self.arena.first_child(self.id).map(|c| self.at(c))
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
        // Only no-namespace attributes are modelled: a selector with a namespace is css-select's (ShadowConstructVisitor).
        if !matches!(ns, NamespaceConstraint::Specific(url) if url.0.is_empty()) {
            return false;
        }
        let node = self.node();
        node.attributes.iter().any(|(name, value)| {
            name == &local_name.0
                && match (operation, node.get_attr_u16(name)) {
                    (AttrSelectorOperation::WithValue { operator, case_sensitivity, value: wanted }, Some(units)) => {
                        eval_utf16(*operator, *case_sensitivity, units, &wanted.0)
                    }
                    _ => operation.eval_str(value),
                }
        })
    }
    fn has_attr_in_no_namespace(&self, local_name: &CssStr) -> bool {
        self.node().attributes.iter().any(|(n, _)| n == &local_name.0)
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
            "selected" => arena.is_selected(id),
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
            // No history, no pressed pointer and no autofill: nothing is visited, active or autofilled.
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

    // A hyperlink: an HTML `<a>` / `<area>` with an `href` in no namespace (HTML "selectors" — a `<link>` is none), or
    // an SVG `<a>` with that or an XLink `href` (SVG 1.1's `xlink:href`, or one set unprefixed by `setAttributeNS`).
    fn is_link(&self) -> bool {
        let node = self.node();
        match &*node.local_name {
            "a" | "area" if node.is_html() => node.plain_attr("href").is_some(),
            "a" if node.ns == ns!(svg) => {
                node.plain_attr("href").is_some() || node.ns_attr(XLINK_NS, "href").is_some()
            }
            _ => false,
        }
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
    // `:root` is the DOCUMENT's element only — a detached element, or a fragment's child, is no root (the JS matcher's
    // `isDocumentRoot`).
    fn is_root(&self) -> bool {
        self.arena.parent_of(self.id).is_some_and(|p| self.arena.is_document(p))
    }

    fn add_element_unique_hashes(&self, _filter: &mut selectors::bloom::BloomFilter) -> bool {
        // Opt out of the ancestor bloom optimization for now (correctness first).
        false
    }
}

// Pseudo-classes the native matcher answers correctly from arena structure alone. Everything
// else (:hover, :checked, :focus, :valid, :target, …) depends on live element state the JS DOM
// still owns, so a selector using one must defer to css-select rather than silently return a
// wrong (subset) result.
//
// This gate only sees pseudo-classes routed through `parse_non_ts_pseudo_class`. A few crate
// BUILT-INS bypass it: `:scope` (handled correctly via the context's scope_element — see
// new_context) and the shadow-DOM `:host` / `::part()` / `::slotted()`, which the arena can't
// model. The latter three match nothing here (no shadow host / parts), which agrees with
// css-select on a shadow-less tree; they'll need real handling — not this structural gate — when
// shadow DOM enters the arena.
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
            | "selected"
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
    )
}

// A parsed selector plus whether it needs the JS fallback (it uses a non-native pseudo).
struct Parsed {
    list: SelectorList<CsimImpl>,
    needs_fallback: bool,
}

// The outcome of a native query: a matched id set, a request to fall back to the JS css-select
// engine (the selector uses live-state constructs), or an invalid selector.
pub enum QueryOutcome {
    Matched(Vec<NodeId>),
    NeedsJsFallback,
    Invalid,
}

// Detects selector constructs the arena can't evaluate: the shadow-DOM ones the FLAT arena models no host / part /
// slot relationship for — `:host` / `:host()` / `:host-context()` (Component::Host), `::part()` (Component::Part),
// `::slotted()` (Component::Slotted) — and an attribute selector with a namespace (`[*|title]`, `[svg|href]`), as
// the arena keeps no attribute's namespace. The crate parses these as BUILT-IN components, so they never reach the
// CsimParser::parse_* callbacks that set needs_fallback — a post-parse visit is the only way to catch them. Any hit
// means the whole selector must defer to css-select.
struct ShadowConstructVisitor {
    found: bool,
}
impl SelectorVisitor for ShadowConstructVisitor {
    type Impl = CsimImpl;
    fn visit_simple_selector(&mut self, s: &Component<CsimImpl>) -> bool {
        if matches!(s, Component::Host(..) | Component::Part(..) | Component::Slotted(..)) {
            self.found = true;
            return false; // found one — stop this branch's walk
        }
        true
    }
    fn visit_attribute_selector(&mut self, ns: &NamespaceConstraint<&CssStr>, _local: &CssStr, _lower: &CssStr) -> bool {
        if !matches!(ns, NamespaceConstraint::Specific(url) if url.0.is_empty()) {
            self.found = true;
            return false;
        }
        true
    }
    // `:is()` / `:where()` / `:not()` / `:nth-child(...of...)` nest via visit_selector_list, whose crate
    // default recurses — so a shadow construct there is already caught. `:has()` nests via THIS callback,
    // whose crate default SKIPS the inner selectors; recurse explicitly so `:has(::slotted(.x))` and the
    // like also force fallback.
    fn visit_relative_selector_list(&mut self, list: &[RelativeSelector<CsimImpl>]) -> bool {
        for rs in list {
            if !rs.selector.visit(self) {
                return false;
            }
        }
        true
    }
}

// Parse a selector list, or None if invalid, recording whether it needs JS fallback.
fn parse(text: &str) -> Option<Parsed> {
    let mut input = ParserInput::new(text);
    let mut parser = CssParser::new(&mut input);
    let list = SelectorList::parse(&CsimParser, &mut parser, ParseRelative::No).ok()?;
    // A shadow-DOM construct (:host / ::part() / ::slotted()) forces fallback too — the arena is the
    // flat tree and models no host/part/slot relationship, so native matching would answer it wrong.
    let mut shadow = ShadowConstructVisitor { found: false };
    for sel in list.slice() {
        if !shadow.found {
            sel.visit(&mut shadow);
        }
    }
    Some(Parsed {
        list,
        needs_fallback: shadow.found,
    })
}

// Parsed-selector cache — the driver emits a small recurring set of selectors, so parsing each once
// and reusing it keeps matching off the parser. Keyed by the selector text, and BOUNDED: a page's own
// queries interpolate ids (`#comment_123`, `[data-id="7"]`) without end, and the cache outlives sessions.
thread_local! {
    static CACHE: std::cell::RefCell<std::collections::HashMap<String, Option<Parsed>>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}
const CACHE_LIMIT: usize = 4096;

// The cached parse of `text` (parsed and stored on a miss — the cache emptied first when it is full), to `f`.
fn with_parsed<R>(text: &str, f: impl FnOnce(Option<&Parsed>) -> R) -> R {
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        if !c.contains_key(text) {
            if c.len() >= CACHE_LIMIT {
                c.clear();
            }
            c.insert(text.to_owned(), parse(text));
        }
        f(c.get(text).and_then(Option::as_ref))
    })
}

// Compiled-selector store for the AUTHORITATIVE cascade path. The shadow / query APIs re-send the
// selector STRING every call (marshalled across V8→Rust, then hashed in CACHE); the cascade matches
// millions of times, so instead it compiles each rule's selector ONCE to a stable integer handle and
// then matches by handle — no per-call string conversion, hash, or key allocation. COMPILED holds the
// parsed lists; COMPILED_IDX dedups by text so distinct rules that share a selector share one entry,
// keeping COMPILED bounded by distinct selectors (like CACHE).
thread_local! {
    static COMPILED: std::cell::RefCell<Vec<SelectorList<CsimImpl>>> = std::cell::RefCell::new(Vec::new());
    static COMPILED_IDX: std::cell::RefCell<std::collections::HashMap<String, i32>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

// Compile a selector to a stable handle: `>= 0` indexes COMPILED (a natively-matchable selector);
// `-1` means invalid OR needs JS fallback (a live-state pseudo) — the caller must use css-select for
// it, and should cache this handle so it never re-asks. Idempotent per text.
pub fn compile_selector(text: &str) -> i32 {
    if let Some(h) = COMPILED_IDX.with(|m| m.borrow().get(text).copied()) {
        return h;
    }
    let h = match parse(text) {
        Some(p) if !p.needs_fallback => COMPILED.with(|c| {
            let mut v = c.borrow_mut();
            v.push(p.list);
            (v.len() - 1) as i32
        }),
        _ => -1, // invalid or live-state → the caller uses css-select
    };
    COMPILED_IDX.with(|m| m.borrow_mut().insert(text.to_owned(), h));
    h
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

// The compiled selectors, by handle, for a caller that matches many against one element with one
// MatchingContext of its own (the native cascade's per-element pass, crate::cascade).
pub fn with_compiled<R>(f: impl FnOnce(&[SelectorList<CsimImpl>]) -> R) -> R {
    COMPILED.with(|c| f(&c.borrow()))
}

// Match ONE element against a previously compiled selector handle. `None` when the handle is out of
// range or the node id is stale (the caller falls back to css-select); `Some(bool)` is authoritative.
// Like `query`, the crate's ancestor walk (for combinators) relies on the arena being acyclic — a
// property the sync layer maintains (it mirrors the acyclic JS DOM); there is no per-call cycle cap here.
pub fn matches_compiled(arena: &RealmArena, id: NodeId, handle: i32, quirks: bool) -> Option<bool> {
    if handle < 0 || arena.get(id).is_none() {
        return None;
    }
    COMPILED.with(|c| {
        let v = c.borrow();
        let list = v.get(handle as usize)?;
        let mut caches = SelectorCaches::default();
        let mut ctx = MatchingContext::new(
            MatchingMode::Normal,
            None,
            &mut caches,
            quirks_mode(quirks),
            NeedsSelectorFlags::No,
            MatchingForInvalidation::No,
        );
        Some(matches_selector_list(list, &NodeRef { arena, id, html_doc: true }, &mut ctx))
    })
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

// Parse (cached) + collect. Distinguishes three outcomes: a matched id set, a request to defer to
// the JS engine (a live-state selector), or Invalid (the caller treats it as a SyntaxError). A
// deferred selector is NOT matched here — the arena result would be a wrong subset.
pub fn query_text(arena: &RealmArena, root: NodeId, scope: NodeId, text: &str, first_only: bool, quirks: bool, html_doc: bool) -> QueryOutcome {
    with_parsed(text, |entry| match entry {
        None => QueryOutcome::Invalid,
        Some(p) if p.needs_fallback => QueryOutcome::NeedsJsFallback,
        Some(p) => QueryOutcome::Matched(query(arena, root, scope, &p.list, first_only, quirks, html_doc)),
    })
}

// Does ONE element match the selector — or, `closest`, which of it and its ancestors is the nearest that does? Same
// three outcomes; Matched carries the matching element's id (empty = none). `scoped` binds `:scope` to the element the
// question is asked of (Element.matches / closest, whose scoping root is the element itself); unscoped — a cascade rule
// — has no scoping root. The matcher walks the full ancestor chain for descendant / child combinators.
pub fn matches_text(arena: &RealmArena, id: NodeId, text: &str, quirks: bool, html_doc: bool, scoped: bool, closest: bool) -> QueryOutcome {
    with_parsed(text, |entry| {
        match entry {
            None => QueryOutcome::Invalid,
            Some(p) if p.needs_fallback => QueryOutcome::NeedsJsFallback,
            Some(p) => {
                if arena.get(id).is_none() {
                    return QueryOutcome::Matched(Vec::new());
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
                let mut at = Some(id);
                while let Some(candidate) = at {
                    if matches_selector_list(&p.list, &NodeRef { arena, id: candidate, html_doc }, &mut ctx) {
                        return QueryOutcome::Matched(vec![candidate]);
                    }
                    at = if closest { arena.parent_of(candidate).filter(|&up| arena.is_element(up)) } else { None };
                }
                QueryOutcome::Matched(Vec::new())
            }
        }
    })
}
