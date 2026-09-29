// The style engine: Servo's stylo over the arena. The arena is stylo's DOM — `StyleNode` is its node and element
// handle, the way `NodeRef` is the query matcher's — and a realm's `StyleEngine` holds what stylo keeps per
// document: the lock its rules are read under, the `Stylist` (the user-agent sheet and the page's sheets, bucketed
// and ready to match), and each element's computed style, which lives beside the node in its `StyleSlot`.

use std::cell::{Cell, OnceCell, RefCell, UnsafeCell};
use std::fmt;
use std::hash::{Hash, Hasher};
use std::ptr::NonNull;

use selectors::attr::{AttrSelectorOperation, CaseSensitivity, NamespaceConstraint};
use selectors::bloom::{BloomFilter, BLOOM_HASH_MASK};
use selectors::matching::{ElementSelectorFlags, MatchingContext, VisitedHandlingMode};
use selectors::sink::Push;
use selectors::OpaqueElement;
use style::applicable_declarations::ApplicableDeclarationBlock;
use style::bloom::each_relevant_element_hash;
use style::context::{
    QuirksMode, RegisteredSpeculativePainter, RegisteredSpeculativePainters, SharedStyleContext, StyleContext,
};
use style::data::{ElementDataMut, ElementDataRef, ElementDataWrapper};
use style::dom::{LayoutIterator, NodeInfo, OpaqueNode, TDocument, TElement, TNode, TShadowRoot};
use style::global_style_data::GLOBAL_STYLE_DATA;
use style::device::Device;
use style::media_queries::{MediaList, MediaType};
use style::invalidation::element::restyle_hints::RestyleHint;
use style::parser::ParserContext;
use style::properties::{parse_style_attribute, ComputedValues, PropertyDeclarationBlock, PropertyId};
use style::selector_parser::SnapshotMap;
use style::stylesheets::import_rule::{ImportLayer, ImportSheet, ImportSupportsCondition};
use style::stylesheets::{ImportRule, OriginSet, StylesheetLoader};
use style::values::CssUrl;
use cssparser::{Parser, ParserInput, SourceLocation};
use style_traits::ParsingMode;
use style::queries::values::PrefersColorScheme;
use style::selector_parser::{AttrValue, Lang, NonTSPseudoClass, PseudoElement, RestyleDamage, SelectorImpl};
use style::servo_arc::{Arc, ArcBorrow};
use style::shared_lock::{Locked, SharedRwLock, StylesheetGuards};
use style::stylesheets::scope_rule::ImplicitScopeRoot;
use style::stylesheets::{AllowImportRules, CssRuleType, DocumentStyleSheet, Origin, Stylesheet, UrlExtraData};
use style::stylist::Stylist;
use style::traversal::{recalc_style_at, DomTraversal, PerLevelTraversalData};
use style::traversal_flags::TraversalFlags;
use style::values::{AtomIdent, AtomString, GenericAtomIdent};
use style::{Atom, LocalName};
use stylo_dom::ElementState;
use web_atoms::{local_name, ns, LocalNameStaticSet, Namespace, NamespaceStaticSet};

use crate::dom::{NodeId, NodeKind, RealmArena};


// What stylo keeps on each element, beside the node: its id as an atom, its `style` attribute as parsed (on first
// read after it changed), the computed style of the last traversal, and the traversal's own flags.
pub(crate) struct StyleSlot {
    id: Option<Atom>,
    style_attr: OnceCell<Option<Arc<Locked<PropertyDeclarationBlock>>>>,
    data: UnsafeCell<Option<ElementDataWrapper>>,
    dirty_descendants: Cell<bool>,
    handled_snapshot: Cell<bool>,
    selector_flags: Cell<ElementSelectorFlags>,
}

impl Default for StyleSlot {
    fn default() -> Self {
        StyleSlot {
            id: None,
            style_attr: OnceCell::new(),
            data: UnsafeCell::new(None),
            dirty_descendants: Cell::new(false),
            handled_snapshot: Cell::new(false),
            selector_flags: Cell::new(ElementSelectorFlags::empty()),
        }
    }
}

impl StyleSlot {
    // The attribute `name` changed (None: any of them may have), and `id` is the element's id now.
    pub(crate) fn attr_changed(&mut self, name: Option<&str>, id: Option<&str>) {
        if name.is_none_or(|n| n == "id") {
            self.id = id.filter(|v| !v.is_empty()).map(Atom::from);
        }
        if name.is_none_or(|n| n == "style") {
            self.style_attr = OnceCell::new();
        }
    }
}

// A realm document's stylo engine: the lock its rules are read under, the stylist holding the user-agent sheet and
// the page's, the document's base URL and mode (what a `style` attribute is parsed with), and the imports its sheets
// are still waiting for.
pub(crate) struct StyleEngine {
    lock: SharedRwLock,
    stylist: Stylist,
    url: UrlExtraData,
    quirks: QuirksMode,
    viewport: (f32, f32),
    doc: Option<NodeId>,
    // The page's sheets as last set, each under what it was made from — so a set that keeps one keeps its parse.
    author: Vec<(SheetKey, DocumentStyleSheet)>,
    pending: RefCell<Vec<PendingImport>>,
    // The arena's `mutations` when it was last styled; None while it has to be styled again whatever they are.
    styled: Option<u64>,
}

#[derive(PartialEq)]
struct SheetKey {
    css_hash: u64,
    css_len: usize,
    base: String,
    media: String,
}

impl SheetKey {
    fn of(css: &str, base: &str, media: &str) -> SheetKey {
        let mut hasher = std::hash::DefaultHasher::new();
        css.hash(&mut hasher);
        SheetKey {
            css_hash: hasher.finish(),
            css_len: css.len(),
            base: base.to_owned(),
            media: media.to_owned(),
        }
    }
}

// An `@import` whose sheet has not arrived: the rule, the absolute URL it asked for, and the media list its sheet
// will be made with.
struct PendingImport {
    url: String,
    rule: Arc<Locked<ImportRule>>,
    media: Arc<Locked<MediaList>>,
}

// What a sheet's `@import`s ask of the engine while it is parsed: each is answered with a PENDING rule and noted,
// and the page supplies the sheet by its URL (`import`).
struct Loader<'a>(&'a RefCell<Vec<PendingImport>>);

impl StylesheetLoader for Loader<'_> {
    fn request_stylesheet(
        &self,
        url: CssUrl,
        location: SourceLocation,
        lock: &SharedRwLock,
        media: Arc<Locked<MediaList>>,
        supports: Option<ImportSupportsCondition>,
        layer: ImportLayer,
    ) -> Arc<Locked<ImportRule>> {
        let refused = supports.as_ref().is_some_and(|s| !s.enabled);
        let href = url.url().map(|u| u.as_str().to_owned());
        let sheet = if refused || href.is_none() { ImportSheet::new_refused() } else { ImportSheet::new_pending() };
        let rule = Arc::new(lock.wrap(ImportRule { url, stylesheet: sheet, supports, layer, source_location: location }));
        if let (false, Some(url)) = (refused, href) {
            self.0.borrow_mut().push(PendingImport { url, rule: rule.clone(), media });
        }
        rule
    }
}

// Every property stylo can parse, whichever of Servo's layout switches it waits behind: this engine's layout is
// its own, so a switch Servo keeps off for its own layout's sake says nothing about ours.
fn enable_properties() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        stylo_static_prefs::set_pref!("layout.unimplemented", true);
        stylo_static_prefs::set_pref!("layout.grid.enabled", true);
        stylo_static_prefs::set_pref!("layout.columns.enabled", true);
        stylo_static_prefs::set_pref!("layout.variable_fonts.enabled", true);
        stylo_static_prefs::set_pref!("layout.container-queries.enabled", true);
        stylo_static_prefs::set_pref!("layout.writing-mode.enabled", true);
    });
}

fn device(quirks: QuirksMode, (width, height): (f32, f32)) -> Device {
    Device::new(
        MediaType::screen(),
        quirks,
        euclid::Size2D::new(width, height),
        euclid::Size2D::new(width, height),
        euclid::Scale::new(1.0),
        Box::new(crate::style_fonts::Metrics),
        ComputedValues::initial_values_with_font_override(style::properties::style_structs::Font::initial_values()),
        PrefersColorScheme::Light,
        Default::default(),
        Default::default(),
    )
}

impl StyleEngine {
    fn new(quirks: QuirksMode, viewport: (f32, f32), url: UrlExtraData) -> StyleEngine {
        enable_properties();
        let mut engine = StyleEngine {
            lock: SharedRwLock::new(),
            stylist: Stylist::new(device(quirks, viewport), quirks),
            url,
            quirks,
            viewport,
            doc: None,
            author: Vec::new(),
            pending: RefCell::new(Vec::new()),
            styled: None,
        };
        let ua = engine.parse(UA_SHEET, engine.url.clone(), "", Origin::UserAgent);
        engine.stylist.append_stylesheet(ua, &engine.lock.read());
        engine
    }

    // The engine for a document at `base` in `quirks` mode, with a `viewport` of CSS px: `current` when it was made
    // for the same, else a new one.
    pub(crate) fn for_document(current: Option<StyleEngine>, base: &str, quirks: bool, viewport: (f32, f32)) -> StyleEngine {
        let quirks = if quirks { QuirksMode::Quirks } else { QuirksMode::NoQuirks };
        let url = url::Url::parse(base).unwrap_or_else(|_| url::Url::parse("about:blank").unwrap());
        match current {
            Some(e) if e.quirks == quirks && e.viewport == viewport && *e.url.0 == url => e,
            _ => StyleEngine::new(quirks, viewport, UrlExtraData::from(url)),
        }
    }

    fn parse(&self, css: &str, url: UrlExtraData, media: &str, origin: Origin) -> DocumentStyleSheet {
        let media = Arc::new(self.lock.wrap(self.media_list(media, &url)));
        let sheet = Stylesheet::from_str(
            css,
            url,
            origin,
            media,
            self.lock.clone(),
            Some(&Loader(&self.pending)),
            None,
            self.quirks,
            AllowImportRules::Yes,
        );
        DocumentStyleSheet(Arc::new(sheet))
    }

    fn media_list(&self, media: &str, url: &UrlExtraData) -> MediaList {
        if media.is_empty() {
            return MediaList::empty();
        }
        let mut context = ParserContext::new(
            Origin::Author,
            url,
            Some(CssRuleType::Media),
            ParsingMode::DEFAULT,
            self.quirks,
            Default::default(),
            None,
            None,
            Default::default(),
        );
        let mut input = ParserInput::new(media);
        MediaList::parse(&mut context, &mut Parser::new(&mut input))
    }

    // The document `doc`'s sheets become `sheets` — (text, base URL, media) each, in document order — and the URLs
    // their `@import`s wait for are returned (`import` supplies each).
    pub(crate) fn set_sheets(&mut self, doc: NodeId, sheets: &[(String, String, String)]) -> Vec<String> {
        self.doc = Some(doc);
        let mut kept = std::mem::take(&mut self.author);
        let guard = self.lock.read();
        for (_, sheet) in &kept {
            self.stylist.remove_stylesheet(sheet.clone(), &guard);
        }
        drop(guard);
        let before = self.pending.borrow().len();
        for (css, base, media) in sheets {
            let key = SheetKey::of(css, base, media);
            let sheet = match kept.iter().position(|(k, _)| *k == key) {
                Some(i) => kept.swap_remove(i).1,
                None => {
                    let url = url::Url::parse(base).map(UrlExtraData::from).unwrap_or_else(|_| self.url.clone());
                    self.parse(css, url, media, Origin::Author)
                }
            };
            self.stylist.append_stylesheet(sheet.clone(), &self.lock.read());
            self.author.push((key, sheet));
        }
        self.styled = None;
        self.pending.borrow()[before..].iter().map(|p| p.url.clone()).collect()
    }

    // The sheet at `url` arrived as `css` (None: it could not be fetched): every `@import` waiting for it takes it,
    // and the URLs its own `@import`s wait for are returned.
    pub(crate) fn import(&mut self, url: &str, css: Option<&str>) -> Vec<String> {
        let waiting: Vec<PendingImport> = {
            let mut pending = self.pending.borrow_mut();
            let (hit, rest) = std::mem::take(&mut *pending).into_iter().partition(|p| p.url == url);
            *pending = rest;
            hit
        };
        let before = self.pending.borrow().len();
        for p in waiting {
            let sheet = match (css, url::Url::parse(url)) {
                (Some(css), Ok(base)) => {
                    let media = p.media.clone();
                    let sheet = Stylesheet::from_str(
                        css,
                        UrlExtraData::from(base),
                        Origin::Author,
                        media,
                        self.lock.clone(),
                        Some(&Loader(&self.pending)),
                        None,
                        self.quirks,
                        AllowImportRules::Yes,
                    );
                    ImportSheet::new(Arc::new(sheet))
                }
                _ => ImportSheet::new_refused(),
            };
            let mut guard = self.lock.write();
            p.rule.write_with(&mut guard).stylesheet = sheet;
        }
        self.stylist.force_stylesheet_origins_dirty(OriginSet::all());
        self.styled = None;
        self.pending.borrow()[before..].iter().map(|p| p.url.clone()).collect()
    }

    // Style the document as it stands in `arena`, when anything moved since it last was.
    fn ensure_styled(&mut self, arena: &RealmArena) {
        if self.styled == Some(arena.mutations) {
            return;
        }
        let Some(doc) = self.doc else { return };
        style::thread_state::enter(style::thread_state::ThreadState::LAYOUT);
        {
            let guard = self.lock.read();
            self.stylist.flush(&StylesheetGuards { author: &guard, ua_or_user: &guard });
        }
        let engine: &StyleEngine = self;
        in_arena(arena, engine, || {
            let guard = engine.lock.read();
            let guards = StylesheetGuards { author: &guard, ua_or_user: &guard };
            let Some(root) = StyleNode::new(arena, doc).first_child_element() else { return };
            // Everything is styled again: a mutation can reach anything until the invalidation that says what it
            // reached is in place.
            if let Some(mut data) = root.mutate_data() {
                data.hint.insert(RestyleHint::restyle_subtree());
            }
            let snapshots = SnapshotMap::new();
            let context = SharedStyleContext {
                traversal_flags: TraversalFlags::empty(),
                stylist: &engine.stylist,
                options: GLOBAL_STYLE_DATA.options.clone(),
                guards,
                visited_styles_enabled: false,
                animations: Default::default(),
                current_time_for_animations: 0.0,
                snapshot_map: &snapshots,
                registered_speculative_painters: &NoPainters,
            };
            let token = Recalc::pre_traverse(root, &context);
            if token.should_traverse() {
                style::driver::traverse_dom(&Recalc { context }, token, None);
            }
        });
        style::thread_state::exit(style::thread_state::ThreadState::LAYOUT);
        self.styled = Some(arena.mutations);
    }

    // The computed value of the longhand `name` on `id`, as `getComputedStyle` serializes a computed value; None for
    // a shorthand, an unknown property, or an element the document's traversal did not style.
    pub(crate) fn value(&mut self, arena: &RealmArena, id: NodeId, name: &str) -> Option<String> {
        self.ensure_styled(arena);
        let slot = arena.style_slot(id)?;
        // SAFETY: no traversal runs while the value is read.
        let data = unsafe { &*slot.data.get() }.as_ref()?.borrow();
        let style = data.styles.get_primary()?;
        match PropertyId::parse_enabled_for_all_content(name).ok()?.as_shorthand() {
            Ok(_) => None,
            Err(longhand) => Some(style.computed_value_to_string(longhand)),
        }
    }
}

struct NoPainters;
impl RegisteredSpeculativePainters for NoPainters {
    fn get(&self, _name: &Atom) -> Option<&dyn RegisteredSpeculativePainter> {
        None
    }
}

struct Recalc<'a> {
    context: SharedStyleContext<'a>,
}

impl<'dom> DomTraversal<StyleNode<'dom>> for Recalc<'_> {
    fn process_preorder<F: FnMut(StyleNode<'dom>)>(
        &self,
        traversal_data: &PerLevelTraversalData,
        context: &mut StyleContext<StyleNode<'dom>>,
        node: StyleNode<'dom>,
        note_child: F,
    ) {
        if let Some(el) = node.as_element() {
            let mut data = unsafe { el.ensure_data() };
            recalc_style_at(self, traversal_data, context, el, &mut data, note_child);
            unsafe { el.unset_dirty_descendants() };
        }
    }

    fn needs_postorder_traversal() -> bool {
        false
    }

    fn process_postorder(&self, _context: &mut StyleContext<StyleNode<'dom>>, _node: StyleNode<'dom>) {
        unreachable!("no postorder traversal")
    }

    fn shared_context(&self) -> &SharedStyleContext<'_> {
        &self.context
    }
}

// The arena stylo is reading and the engine reading it, for the length of one `in_arena` call. Stylo's element handle
// has to be one pointer wide (its style-sharing cache stores handles type-erased at that size), so a handle is the
// node's id alone and the arena it indexes is this; the engine is what a `style` attribute is parsed with.
thread_local! {
    static CONTEXT: Cell<(*const RealmArena, *const StyleEngine)> = const { Cell::new((std::ptr::null(), std::ptr::null())) };
}

// Run `f` with `arena` and `engine` as the ones every `StyleNode` reads.
fn in_arena<R>(arena: &RealmArena, engine: &StyleEngine, f: impl FnOnce() -> R) -> R {
    struct Restore((*const RealmArena, *const StyleEngine));
    impl Drop for Restore {
        fn drop(&mut self) {
            CONTEXT.with(|c| c.set(self.0));
        }
    }
    let _restore = Restore(CONTEXT.with(|c| c.replace((arena, engine))));
    f()
}

// Stylo's handle on an arena node — for a node, an element, a document and a shadow root alike, as the crate lets
// one type be all four. Only ever made for a live node, inside the `in_arena` call of the arena the lifetime borrows.
#[derive(Clone, Copy)]
pub(crate) struct StyleNode<'a> {
    id: NodeId,
    arena: std::marker::PhantomData<&'a RealmArena>,
}

impl<'a> StyleNode<'a> {
    fn new(_arena: &'a RealmArena, id: NodeId) -> Self {
        StyleNode { id, arena: std::marker::PhantomData }
    }
    fn at(&self, id: NodeId) -> Self {
        StyleNode { id, arena: std::marker::PhantomData }
    }
    fn arena(&self) -> &'a RealmArena {
        // SAFETY: a handle exists only inside `in_arena` for the arena its lifetime borrows, which set the pointer.
        unsafe { &*CONTEXT.with(Cell::get).0 }
    }
    fn engine(&self) -> &'a StyleEngine {
        // SAFETY: as `arena`.
        unsafe { &*CONTEXT.with(Cell::get).1 }
    }
    fn node(&self) -> &'a crate::dom::NodeData {
        self.arena().get(self.id).expect("StyleNode points at a live node")
    }
    fn slot(&self) -> &'a StyleSlot {
        self.arena().style_slot(self.id).expect("a styled element has a style slot")
    }
    fn data_cell(&self) -> &'a UnsafeCell<Option<ElementDataWrapper>> {
        &self.slot().data
    }
    fn first_child_element(&self) -> Option<Self> {
        self.arena().first_child(self.id).map(|c| self.at(c))
    }
    fn is_html(&self) -> bool {
        self.node().is_html()
    }
}

impl PartialEq for StyleNode<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}
impl Eq for StyleNode<'_> {}

impl Hash for StyleNode<'_> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.id.hash(state)
    }
}

impl fmt::Debug for StyleNode<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "<{}#{}>", self.node().local_name, self.id.idx)
    }
}

impl NodeInfo for StyleNode<'_> {
    fn is_element(&self) -> bool {
        self.node().kind == NodeKind::Element
    }
    fn is_text_node(&self) -> bool {
        self.node().kind == NodeKind::Text
    }
}

impl<'a> TDocument for StyleNode<'a> {
    type ConcreteNode = StyleNode<'a>;
    fn as_node(&self) -> Self::ConcreteNode {
        *self
    }
    fn is_html_document(&self) -> bool {
        true
    }
    fn quirks_mode(&self) -> QuirksMode {
        self.engine().quirks
    }
    fn shared_lock(&self) -> &SharedRwLock {
        &self.engine().lock
    }
}

impl<'a> TShadowRoot for StyleNode<'a> {
    type ConcreteNode = StyleNode<'a>;
    fn as_node(&self) -> Self::ConcreteNode {
        *self
    }
    fn host(&self) -> StyleNode<'a> {
        self.at(self.node().host.expect("a shadow root has a host"))
    }
    fn style_data<'b>(&self) -> Option<&'b style::stylist::CascadeData>
    where
        Self: 'b,
    {
        None
    }
}

impl<'a> TNode for StyleNode<'a> {
    type ConcreteElement = StyleNode<'a>;
    type ConcreteDocument = StyleNode<'a>;
    type ConcreteShadowRoot = StyleNode<'a>;

    fn parent_node(&self) -> Option<Self> {
        self.arena().parent_of(self.id).map(|p| self.at(p))
    }
    fn first_child(&self) -> Option<Self> {
        self.node().children.iter().find(|&&c| self.arena().get(c).is_some()).map(|&c| self.at(c))
    }
    fn last_child(&self) -> Option<Self> {
        self.node().children.iter().rev().find(|&&c| self.arena().get(c).is_some()).map(|&c| self.at(c))
    }
    fn prev_sibling(&self) -> Option<Self> {
        let parent = self.arena().get(self.arena().parent_of(self.id)?)?;
        let i = self.node().child_index;
        parent.children[..i.min(parent.children.len())]
            .iter()
            .rev()
            .find(|&&c| self.arena().get(c).is_some())
            .map(|&c| self.at(c))
    }
    fn next_sibling(&self) -> Option<Self> {
        let parent = self.arena().get(self.arena().parent_of(self.id)?)?;
        let i = self.node().child_index;
        parent.children.get(i + 1..)?.iter().find(|&&c| self.arena().get(c).is_some()).map(|&c| self.at(c))
    }
    fn owner_doc(&self) -> Self::ConcreteDocument {
        let mut cur = *self;
        while let Some(p) = cur.parent_node() {
            cur = p;
        }
        cur
    }
    fn is_in_document(&self) -> bool {
        self.owner_doc().node().kind == NodeKind::Document
    }
    fn traversal_parent(&self) -> Option<Self::ConcreteElement> {
        let p = self.parent_node()?;
        if p.is_element() {
            return Some(p);
        }
        p.node().host.map(|h| self.at(h))
    }
    fn opaque(&self) -> OpaqueNode {
        OpaqueNode(opaque_bits(self.id))
    }
    fn debug_id(self) -> usize {
        self.id.idx as usize
    }
    fn as_element(&self) -> Option<Self::ConcreteElement> {
        self.is_element().then_some(*self)
    }
    fn as_document(&self) -> Option<Self::ConcreteDocument> {
        (self.node().kind == NodeKind::Document).then_some(*self)
    }
    fn as_shadow_root(&self) -> Option<Self::ConcreteShadowRoot> {
        (self.node().kind == NodeKind::Fragment && self.node().host.is_some()).then_some(*self)
    }
}

// A node's identity as a pointer-sized word stylo can key on: its slot and generation, never zero.
fn opaque_bits(id: NodeId) -> usize {
    ((id.generation as usize) << 32 | id.idx as usize) + 1
}

pub(crate) struct Children<'a> {
    node: StyleNode<'a>,
    next: usize,
}

impl<'a> Iterator for Children<'a> {
    type Item = StyleNode<'a>;
    fn next(&mut self) -> Option<Self::Item> {
        let children = &self.node.node().children;
        while let Some(&c) = children.get(self.next) {
            self.next += 1;
            if self.node.arena().get(c).is_some() {
                return Some(self.node.at(c));
            }
        }
        None
    }
}

impl<'a> selectors::Element for StyleNode<'a> {
    type Impl = SelectorImpl;

    fn opaque(&self) -> OpaqueElement {
        OpaqueElement::from_non_null_ptr(NonNull::new(opaque_bits(self.id) as *mut ()).unwrap())
    }
    fn parent_element(&self) -> Option<Self> {
        self.arena().parent_of(self.id).filter(|&p| self.arena().is_element(p)).map(|p| self.at(p))
    }
    fn parent_node_is_shadow_root(&self) -> bool {
        self.parent_node().is_some_and(|p| p.as_shadow_root().is_some())
    }
    fn containing_shadow_host(&self) -> Option<Self> {
        let mut cur = self.parent_node();
        while let Some(p) = cur {
            if let Some(h) = p.node().host {
                return Some(self.at(h));
            }
            cur = p.parent_node();
        }
        None
    }
    fn is_pseudo_element(&self) -> bool {
        false
    }
    fn prev_sibling_element(&self) -> Option<Self> {
        self.arena().prev_sibling(self.id).map(|s| self.at(s))
    }
    fn next_sibling_element(&self) -> Option<Self> {
        self.arena().next_sibling(self.id).map(|s| self.at(s))
    }
    fn first_element_child(&self) -> Option<Self> {
        self.arena().first_child(self.id).map(|c| self.at(c))
    }
    fn is_html_element_in_html_document(&self) -> bool {
        self.is_html()
    }
    fn has_local_name(&self, name: &web_atoms::LocalName) -> bool {
        self.node().local_name == *name
    }
    fn has_namespace(&self, ns: &Namespace) -> bool {
        self.node().ns == *ns
    }
    fn is_same_type(&self, other: &Self) -> bool {
        self.node().local_name == other.node().local_name && self.node().ns == other.node().ns
    }
    fn attr_matches(
        &self,
        ns: &NamespaceConstraint<&GenericAtomIdent<NamespaceStaticSet>>,
        local_name: &GenericAtomIdent<LocalNameStaticSet>,
        operation: &AttrSelectorOperation<&AtomString>,
    ) -> bool {
        let node = self.node();
        let value = match ns {
            NamespaceConstraint::Specific(url) if !url.0.is_empty() => node.ns_attr(&url.0, &local_name.0),
            NamespaceConstraint::Specific(_) => node.plain_attr(&local_name.0),
            NamespaceConstraint::Any => node.get_attr(&local_name.0),
        };
        value.is_some_and(|v| operation.eval_str(v))
    }
    fn match_non_ts_pseudo_class(&self, pc: &NonTSPseudoClass, _context: &mut MatchingContext<SelectorImpl>) -> bool {
        let (arena, id) = (self.arena(), self.id);
        match pc {
            NonTSPseudoClass::Active => false,
            NonTSPseudoClass::AnyLink | NonTSPseudoClass::Link => self.is_link(),
            NonTSPseudoClass::Visited => false,
            NonTSPseudoClass::Autofill => false,
            NonTSPseudoClass::Checked => arena.is_checked(id) || arena.is_selected(id),
            NonTSPseudoClass::Default => arena.is_default(id),
            NonTSPseudoClass::Defined => arena.is_defined(id),
            NonTSPseudoClass::Disabled => arena.is_actually_disabled(id),
            NonTSPseudoClass::Enabled => arena.is_enabled(id),
            NonTSPseudoClass::Focus => arena.is_focused(id),
            NonTSPseudoClass::FocusVisible => arena.is_focus_visible(id),
            NonTSPseudoClass::FocusWithin => arena.has_focus_within(id),
            NonTSPseudoClass::Fullscreen => false,
            NonTSPseudoClass::Hover => arena.is_hovered(id),
            NonTSPseudoClass::Indeterminate => arena.is_indeterminate(id),
            NonTSPseudoClass::Invalid => arena.is_valid_pseudo(id) == Some(false),
            NonTSPseudoClass::Valid => arena.is_valid_pseudo(id) == Some(true),
            NonTSPseudoClass::Modal => arena.is_modal(id),
            NonTSPseudoClass::Open => arena.is_open(id),
            NonTSPseudoClass::Optional => arena.requiredness(id) == Some(false),
            NonTSPseudoClass::Required => arena.requiredness(id) == Some(true),
            NonTSPseudoClass::InRange => arena.is_in_range(id) == Some(true),
            NonTSPseudoClass::OutOfRange => arena.is_in_range(id) == Some(false),
            NonTSPseudoClass::PlaceholderShown => arena.is_placeholder_shown(id),
            NonTSPseudoClass::PopoverOpen => arena.is_popover_open(id),
            NonTSPseudoClass::ReadOnly => !arena.is_read_write(id),
            NonTSPseudoClass::ReadWrite => arena.is_read_write(id),
            NonTSPseudoClass::Target => arena.is_target(id),
            NonTSPseudoClass::UserInvalid => arena.is_user_valid_pseudo(id) == Some(false),
            NonTSPseudoClass::UserValid => arena.is_user_valid_pseudo(id) == Some(true),
            NonTSPseudoClass::Lang(lang) => arena.matches_lang(id, &lang.to_string()),
            NonTSPseudoClass::CustomState(state) => arena.has_custom_state(id, &state.0),
            NonTSPseudoClass::MozMeterOptimum
            | NonTSPseudoClass::MozMeterSubOptimum
            | NonTSPseudoClass::MozMeterSubSubOptimum
            | NonTSPseudoClass::ServoNonZeroBorder => false,
        }
    }
    fn match_pseudo_element(&self, _pe: &PseudoElement, _context: &mut MatchingContext<SelectorImpl>) -> bool {
        false
    }
    fn apply_selector_flags(&self, flags: ElementSelectorFlags) {
        let own = flags.for_self();
        if !own.is_empty() {
            let slot = self.slot();
            slot.selector_flags.set(slot.selector_flags.get() | own);
        }
        let parent = flags.for_parent();
        if !parent.is_empty() {
            if let Some(p) = selectors::Element::parent_element(self) {
                let slot = p.slot();
                slot.selector_flags.set(slot.selector_flags.get() | parent);
            }
        }
    }
    fn is_link(&self) -> bool {
        let node = self.node();
        match &*node.local_name {
            "a" | "area" if self.is_html() => node.plain_attr("href").is_some(),
            "a" if self.node().ns == ns!(svg) => node.plain_attr("href").is_some(),
            _ => false,
        }
    }
    fn is_html_slot_element(&self) -> bool {
        self.is_html() && self.node().local_name == local_name!("slot")
    }
    fn has_id(&self, id: &AtomIdent, case: CaseSensitivity) -> bool {
        self.slot().id.as_ref().is_some_and(|own| case.eq(own.as_bytes(), id.as_bytes()))
    }
    fn has_class(&self, name: &AtomIdent, case: CaseSensitivity) -> bool {
        self.node()
            .get_attr("class")
            .unwrap_or("")
            .split_ascii_whitespace()
            .any(|c| case.eq(c.as_bytes(), name.as_bytes()))
    }
    fn has_custom_state(&self, name: &AtomIdent) -> bool {
        self.arena().has_custom_state(self.id, name)
    }
    fn imported_part(&self, _name: &AtomIdent) -> Option<AtomIdent> {
        None
    }
    fn is_part(&self, _name: &AtomIdent) -> bool {
        false
    }
    fn is_empty(&self) -> bool {
        self.arena().is_empty(self.id)
    }
    fn is_root(&self) -> bool {
        self.arena().parent_of(self.id).is_some_and(|p| self.arena().is_document(p))
    }
    fn add_element_unique_hashes(&self, filter: &mut BloomFilter) -> bool {
        each_relevant_element_hash(*self, |hash| filter.insert_hash(hash & BLOOM_HASH_MASK));
        true
    }
}

impl<'a> TElement for StyleNode<'a> {
    type ConcreteNode = StyleNode<'a>;
    type TraversalChildrenIterator = Children<'a>;

    fn as_node(&self) -> Self::ConcreteNode {
        *self
    }
    fn implicit_scope_for_sheet_in_shadow_root(
        _opaque_host: OpaqueElement,
        _sheet_index: usize,
    ) -> Option<ImplicitScopeRoot> {
        None
    }
    fn traversal_children(&self) -> LayoutIterator<Self::TraversalChildrenIterator> {
        LayoutIterator(Children { node: *self, next: 0 })
    }
    fn is_html_element(&self) -> bool {
        self.is_html()
    }
    fn is_mathml_element(&self) -> bool {
        self.node().ns == ns!(mathml)
    }
    fn is_svg_element(&self) -> bool {
        self.node().ns == ns!(svg)
    }
    fn style_attribute(&self) -> Option<ArcBorrow<'_, Locked<PropertyDeclarationBlock>>> {
        let parsed = self.slot().style_attr.get_or_init(|| {
            let css = self.node().plain_attr("style")?;
            let engine = self.engine();
            let block = parse_style_attribute(css, &engine.url, None, engine.quirks, CssRuleType::Style);
            Some(Arc::new(engine.lock.wrap(block)))
        });
        parsed.as_ref().map(|a| a.borrow_arc())
    }
    fn state(&self) -> ElementState {
        ElementState::empty()
    }
    fn has_part_attr(&self) -> bool {
        false
    }
    fn exports_any_part(&self) -> bool {
        false
    }
    fn id(&self) -> Option<&Atom> {
        self.slot().id.as_ref()
    }
    fn each_class<F>(&self, mut callback: F)
    where
        F: FnMut(&AtomIdent),
    {
        for c in self.node().get_attr("class").unwrap_or("").split_ascii_whitespace() {
            let atom = Atom::from(c);
            callback(AtomIdent::cast(&atom));
        }
    }
    fn each_custom_state<F>(&self, _callback: F)
    where
        F: FnMut(&AtomIdent),
    {
    }
    fn each_attr_name<F>(&self, mut callback: F)
    where
        F: FnMut(&LocalName),
    {
        for (name, _) in &self.node().attributes {
            callback(&LocalName::from(name.as_str()));
        }
    }
    fn has_dirty_descendants(&self) -> bool {
        self.slot().dirty_descendants.get()
    }
    fn has_snapshot(&self) -> bool {
        false
    }
    fn handled_snapshot(&self) -> bool {
        self.slot().handled_snapshot.get()
    }
    unsafe fn set_handled_snapshot(&self) {
        self.slot().handled_snapshot.set(true);
    }
    unsafe fn set_dirty_descendants(&self) {
        self.slot().dirty_descendants.set(true);
    }
    unsafe fn unset_dirty_descendants(&self) {
        self.slot().dirty_descendants.set(false);
    }
    fn store_children_to_process(&self, _n: isize) {
        unreachable!("sequential traversal only")
    }
    fn did_process_child(&self) -> isize {
        unreachable!("sequential traversal only")
    }
    unsafe fn ensure_data(&self) -> ElementDataMut<'_> {
        let cell = unsafe { &mut *self.data_cell().get() };
        cell.get_or_insert_with(Default::default).borrow_mut()
    }
    unsafe fn clear_data(&self) {
        unsafe { *self.data_cell().get() = None };
    }
    fn has_data(&self) -> bool {
        self.arena().style_slot(self.id).is_some_and(|s| unsafe { &*s.data.get() }.is_some())
    }
    fn borrow_data(&self) -> Option<ElementDataRef<'_>> {
        let slot = self.arena().style_slot(self.id)?;
        unsafe { &*slot.data.get() }.as_ref().map(|d| d.borrow())
    }
    fn mutate_data(&self) -> Option<ElementDataMut<'_>> {
        let slot = self.arena().style_slot(self.id)?;
        unsafe { &*slot.data.get() }.as_ref().map(|d| d.borrow_mut())
    }
    fn skip_item_display_fixup(&self) -> bool {
        false
    }
    fn may_have_animations(&self) -> bool {
        false
    }
    fn has_animations(&self, _context: &SharedStyleContext) -> bool {
        false
    }
    fn has_css_animations(&self, _context: &SharedStyleContext, _pseudo: Option<PseudoElement>) -> bool {
        false
    }
    fn has_css_transitions(&self, _context: &SharedStyleContext, _pseudo: Option<PseudoElement>) -> bool {
        false
    }
    fn animation_rule(&self, _context: &SharedStyleContext) -> Option<Arc<Locked<PropertyDeclarationBlock>>> {
        None
    }
    fn transition_rule(&self, _context: &SharedStyleContext) -> Option<Arc<Locked<PropertyDeclarationBlock>>> {
        None
    }
    fn get_attr(&self, attr: &LocalName, ns: &style::Namespace) -> Option<String> {
        let node = self.node();
        if ns.0.is_empty() { node.plain_attr(&attr.0) } else { node.ns_attr(&ns.0, &attr.0) }.map(str::to_owned)
    }
    fn shadow_root(&self) -> Option<StyleNode<'a>> {
        None
    }
    fn containing_shadow(&self) -> Option<StyleNode<'a>> {
        let mut cur = self.parent_node();
        while let Some(p) = cur {
            if p.as_shadow_root().is_some() {
                return Some(p);
            }
            cur = p.parent_node();
        }
        None
    }
    fn lang_attr(&self) -> Option<AttrValue> {
        None
    }
    fn match_element_lang(&self, _override_lang: Option<Option<AttrValue>>, value: &Lang) -> bool {
        self.arena().matches_lang(self.id, &value.to_string())
    }
    fn is_html_document_body_element(&self) -> bool {
        self.is_html()
            && self.node().local_name == local_name!("body")
            && self
                .parent_node()
                .is_some_and(|p| p.is_element() && p.node().local_name == local_name!("html") && p.parent_node().is_some_and(|d| d.as_document().is_some()))
    }
    fn synthesize_presentational_hints_for_legacy_attributes<V>(&self, _visited: VisitedHandlingMode, _hints: &mut V)
    where
        V: Push<ApplicableDeclarationBlock>,
    {
    }
    fn local_name(&self) -> &web_atoms::LocalName {
        &self.node().local_name
    }
    fn namespace(&self) -> &Namespace {
        &self.node().ns
    }
    fn query_container_size(&self, _display: &style::values::specified::Display) -> euclid::default::Size2D<Option<app_units::Au>> {
        Default::default()
    }
    fn has_selector_flags(&self, flags: ElementSelectorFlags) -> bool {
        self.slot().selector_flags.get().contains(flags)
    }
    fn relative_selector_search_direction(&self) -> ElementSelectorFlags {
        let flags = self.slot().selector_flags.get();
        if flags.contains(ElementSelectorFlags::RELATIVE_SELECTOR_SEARCH_DIRECTION_ANCESTOR_SIBLING) {
            ElementSelectorFlags::RELATIVE_SELECTOR_SEARCH_DIRECTION_ANCESTOR_SIBLING
        } else if flags.contains(ElementSelectorFlags::RELATIVE_SELECTOR_SEARCH_DIRECTION_ANCESTOR) {
            ElementSelectorFlags::RELATIVE_SELECTOR_SEARCH_DIRECTION_ANCESTOR
        } else if flags.contains(ElementSelectorFlags::RELATIVE_SELECTOR_SEARCH_DIRECTION_SIBLING) {
            ElementSelectorFlags::RELATIVE_SELECTOR_SEARCH_DIRECTION_SIBLING
        } else {
            ElementSelectorFlags::empty()
        }
    }
    fn compute_layout_damage(_old: &ComputedValues, _new: &ComputedValues) -> RestyleDamage {
        RestyleDamage::empty()
    }
}

// The user-agent style sheet.
const UA_SHEET: &str = include_str!("ua.css");
