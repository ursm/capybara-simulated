// Native CSS selector matching over the live arena, using Servo's `selectors` crate — the
// production engine (the same one Firefox ships), so tree-structural selectors (`:nth-child`,
// `:not`, `:is`, `:where`, `:has`, combinators, attribute operators, case-sensitivity) are correct
// by construction.
//
// Ported from the unmerged native-selector-matching branch, where it matched against a JSON MIRROR
// of the DOM that was serialized and copied across the FFI on every navigation — the boundary tax
// that made that approach lose to the JS cascade. Here it reads the LIVE arena (crate::dom) directly:
// the `Element` trait impl and parser are essentially unchanged; only the node accessors are
// repointed from the mirror's flat `RawNode` at our `NodeData`.
//
// State-dependent, non-tree-structural pseudo-classes (`:hover`, `:checked`, `:focus`, `:disabled`,
// …) depend on element state that still lives in the JS DOM; they are parsed (so real selectors
// don't error) but only `:link`/`:any-link` (structural: a/area/link with href) match here. A
// selector that needs live state must fall back to the JS engine — see the caller.

use std::borrow::Borrow;
use std::fmt;

use cssparser::{CowRcStr, Parser as CssParser, ParserInput, SourceLocation, ToCss};
use precomputed_hash::PrecomputedHash;
use selectors::attr::{AttrSelectorOperation, CaseSensitivity, NamespaceConstraint};
use selectors::context::{
    MatchingContext, MatchingForInvalidation, MatchingMode, NeedsSelectorFlags, QuirksMode,
    SelectorCaches,
};
use selectors::matching::{matches_selector_list, ElementSelectorFlags};
use selectors::parser::{
    NonTSPseudoClass, ParseRelative, Parser, PseudoElement, SelectorImpl, SelectorList,
    SelectorParseErrorKind,
};
use selectors::{Element, OpaqueElement};

use crate::dom::Dom;

const HTML_NS: &str = "http://www.w3.org/1999/xhtml";

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

// A non-tree-structural pseudo-class carried by name (`:hover`, `:checked`, …). Parsing accepts them
// so real selectors parse; only `:link`/`:any-link` match here (see match_non_ts_pseudo_class).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PseudoClass(String);

impl ToCss for PseudoClass {
    fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
        dest.write_char(':')?;
        dest.write_str(&self.0)
    }
}
impl NonTSPseudoClass for PseudoClass {
    type Impl = CsimImpl;
    fn is_active_or_hover(&self) -> bool {
        self.0 == "active" || self.0 == "hover"
    }
    fn is_user_action_state(&self) -> bool {
        matches!(self.0.as_str(), "active" | "hover" | "focus" | "focus-within" | "focus-visible")
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
}

// The parser: everything tree-structural is handled by the crate; we only name the non-TS
// pseudo-classes and pseudo-elements so real selectors parse instead of erroring. The enabled
// features mirror what the driver's css-select supports, so native matching agrees.
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

    fn parse_non_ts_pseudo_class(
        &self,
        _location: SourceLocation,
        name: CowRcStr<'i>,
    ) -> Result<PseudoClass, cssparser::ParseError<'i, Self::Error>> {
        Ok(PseudoClass(name.as_ref().to_ascii_lowercase()))
    }

    fn parse_non_ts_functional_pseudo_class<'t>(
        &self,
        name: CowRcStr<'i>,
        arguments: &mut CssParser<'i, 't>,
        _after_part: bool,
    ) -> Result<PseudoClass, cssparser::ParseError<'i, Self::Error>> {
        // Consume the argument tokens so parsing succeeds; the class is carried by name only.
        while arguments.next().is_ok() {}
        Ok(PseudoClass(name.as_ref().to_ascii_lowercase()))
    }

    fn parse_pseudo_element(
        &self,
        _location: SourceLocation,
        name: CowRcStr<'i>,
    ) -> Result<PseudoEl, cssparser::ParseError<'i, Self::Error>> {
        Ok(PseudoEl(name.as_ref().to_ascii_lowercase()))
    }
}

// A handle into the arena. Copy so the Element trait's element-returning methods are cheap.
#[derive(Clone, Copy)]
pub struct NodeRef<'a> {
    pub dom: &'a Dom,
    pub idx: usize,
}

impl<'a> NodeRef<'a> {
    fn at(&self, idx: usize) -> NodeRef<'a> {
        NodeRef { dom: self.dom, idx }
    }
    fn node(&self) -> &'a crate::dom::NodeData {
        &self.dom.nodes[self.idx]
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

    fn parent_element(&self) -> Option<Self> {
        self.dom.parent_of(self.idx).map(|p| self.at(p))
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
        self.dom.prev_sibling(self.idx).map(|s| self.at(s))
    }
    fn next_sibling_element(&self) -> Option<Self> {
        self.dom.next_sibling(self.idx).map(|s| self.at(s))
    }
    fn first_element_child(&self) -> Option<Self> {
        self.dom.first_child(self.idx).map(|c| self.at(c))
    }

    fn is_html_element_in_html_document(&self) -> bool {
        let ns = &self.node().ns;
        ns.is_empty() || ns == HTML_NS
    }

    fn has_local_name(&self, name: &str) -> bool {
        self.node().local_name == name
    }
    fn has_namespace(&self, ns: &str) -> bool {
        let n = &self.node().ns;
        if n.is_empty() { ns == HTML_NS } else { n == ns }
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
        // Only no-namespace attributes are modelled (the common case); a specific non-HTML
        // namespace constraint matches nothing here yet.
        match ns {
            NamespaceConstraint::Specific(url) if !url.0.is_empty() && url.0 != HTML_NS => {
                return false;
            }
            _ => {}
        }
        for (name, value) in &self.node().attributes {
            if name == &local_name.0 && operation.eval_str(value) {
                return true;
            }
        }
        false
    }
    fn has_attr_in_no_namespace(&self, local_name: &CssStr) -> bool {
        self.node().attributes.iter().any(|(n, _)| n == &local_name.0)
    }

    fn match_non_ts_pseudo_class(
        &self,
        pc: &PseudoClass,
        _context: &mut MatchingContext<CsimImpl>,
    ) -> bool {
        // State pseudo-classes depend on live element state in the JS DOM; the caller falls back to
        // the JS engine for a selector that needs them. Only structural link state is answered here.
        match pc.0.as_str() {
            "link" | "any-link" => self.is_link(),
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
        matches!(self.node().local_name.as_str(), "a" | "area" | "link")
            && self.node().attributes.iter().any(|(n, _)| n == "href")
    }
    fn is_html_slot_element(&self) -> bool {
        self.node().local_name == "slot"
    }

    fn has_id(&self, id: &CssStr, case: CaseSensitivity) -> bool {
        match self.node().get_attr("id") {
            Some(v) if !v.is_empty() => case.eq(v.as_bytes(), id.0.as_bytes()),
            _ => false,
        }
    }
    fn has_class(&self, name: &CssStr, case: CaseSensitivity) -> bool {
        self.node()
            .get_attr("class")
            .unwrap_or("")
            .split_whitespace()
            .any(|c| case.eq(c.as_bytes(), name.0.as_bytes()))
    }
    fn has_custom_state(&self, _name: &CssStr) -> bool {
        false
    }
    fn imported_part(&self, _name: &CssStr) -> Option<CssStr> {
        None
    }
    fn is_part(&self, _name: &CssStr) -> bool {
        false
    }

    fn is_empty(&self) -> bool {
        self.node().children.is_empty() && !self.node().has_text
    }
    fn is_root(&self) -> bool {
        self.node().parent.is_none()
    }

    fn add_element_unique_hashes(&self, _filter: &mut selectors::bloom::BloomFilter) -> bool {
        // Opt out of the ancestor bloom optimization for now (correctness first).
        false
    }
}

// Parse a selector list, or None if invalid.
pub fn parse(text: &str) -> Option<SelectorList<CsimImpl>> {
    let mut input = ParserInput::new(text);
    let mut parser = CssParser::new(&mut input);
    SelectorList::parse(&CsimParser, &mut parser, ParseRelative::No).ok()
}

// Parsed-selector cache — the driver emits a small recurring set of selectors, so parsing each once
// and reusing it keeps matching off the parser. Keyed by the selector text.
thread_local! {
    static CACHE: std::cell::RefCell<std::collections::HashMap<String, Option<SelectorList<CsimImpl>>>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

// Whether the element at `idx` matches the (already-parsed) selector list.
pub fn matches(dom: &Dom, idx: usize, list: &SelectorList<CsimImpl>) -> bool {
    let mut caches = SelectorCaches::default();
    let mut ctx = MatchingContext::new(
        MatchingMode::Normal,
        None,
        &mut caches,
        QuirksMode::NoQuirks,
        NeedsSelectorFlags::No,
        MatchingForInvalidation::No,
    );
    matches_selector_list(list, &NodeRef { dom, idx }, &mut ctx)
}

// Collect descendants of `root` (preorder / document order) matching `list`. `first_only` stops at
// the first hit (querySelector). The matcher walks each candidate's full ancestor chain, so
// ancestor-dependent combinators resolve correctly even above `root`.
pub fn query(dom: &Dom, root: usize, list: &SelectorList<CsimImpl>, first_only: bool) -> Vec<usize> {
    let mut out = Vec::new();
    let mut stack: Vec<usize> = match dom.nodes.get(root) {
        Some(node) => node.children.iter().rev().copied().collect(),
        None => return out,
    };
    while let Some(idx) = stack.pop() {
        if matches(dom, idx, list) {
            out.push(idx);
            if first_only {
                return out;
            }
        }
        if let Some(node) = dom.nodes.get(idx) {
            stack.extend(node.children.iter().rev().copied());
        }
    }
    out
}

// Parse (cached) + collect. An invalid selector yields None (the caller treats it as a SyntaxError).
pub fn query_text(dom: &Dom, root: usize, text: &str, first_only: bool) -> Option<Vec<usize>> {
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        let entry = c.entry(text.to_owned()).or_insert_with(|| parse(text));
        entry.as_ref().map(|list| query(dom, root, list, first_only))
    })
}
