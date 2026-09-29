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
    CascadeInputs, ThreadLocalStyleContext, TreeCountingCaches,
};
use style::data::{ElementDataMut, ElementDataRef, ElementDataWrapper};
use style::dom::{DummyElementContext, LayoutIterator, NodeInfo, OpaqueNode, TDocument, TElement, TNode, TShadowRoot};
use style::global_style_data::GLOBAL_STYLE_DATA;
use style::device::Device;
use style::media_queries::{MediaList, MediaType};
use style::invalidation::element::restyle_hints::RestyleHint;
use style::parser::ParserContext;
use style::properties::animated_properties::AnimationValue;
use style::properties::{
    parse_one_declaration_into, parse_property_declaration_list, parse_style_attribute, ComputedValues, LonghandId,
    PropertyDeclarationBlock, PropertyDeclarationId, PropertyId, ShorthandId, SourcePropertyDeclaration, StyleBuilder,
};
use style::rule_cache::RuleCacheConditions;
use style::parser::Parse;
use style::values::computed::easing::ComputedTimingFunction;
use style::values::computed::ToComputedValue;
use style::values::generics::easing::TimingKeyword;
use style::values::specified::easing::TimingFunction as SpecifiedTimingFunction;
use style::rule_tree::RuleCascadeFlags;
use style::style_resolver::{PseudoElementResolution, StyleResolverForElement};
use style::stylesheets::container_rule::ContainerSizeQuery;
use style::values::computed::Context;
use style::rule_tree::{CascadeLevel, CascadeOrigin};
use style::stylesheets::layer_rule::LayerOrder;
use style::selector_parser::SnapshotMap;
use style::servo::attr::{AttrIdentifier, AttrValue as SnapshotValue};
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
use style::animation::{
    Animation, AnimationSetKey, AnimationState, DocumentAnimationSet, ElementAnimationSet, KeyframesIterationState, Transition,
};
use style::author_styles::AuthorStyles;
use style::stylist::{RuleInclusion, Stylist};
use style::traversal::{recalc_style_at, DomTraversal, PerLevelTraversalData};
use style::traversal_flags::TraversalFlags;
use style::values::{AtomIdent, AtomString, GenericAtomIdent};
use style::{Atom, LocalName};
use stylo_dom::ElementState;
use web_atoms::{local_name, ns, LocalNameStaticSet, Namespace, NamespaceStaticSet};

use crate::animations as waapi;
use crate::dom::{NodeId, NodeKind, RealmArena};


// A realm's style lock: every block the engine parses — a sheet, a `style` attribute, a hint — is wrapped in it and
// read under it, so there is ONE for the realm's life (the arena holds it), whatever becomes of the engine.
pub(crate) struct StyleLock(pub(crate) SharedRwLock);

impl Default for StyleLock {
    fn default() -> Self {
        StyleLock(SharedRwLock::new())
    }
}

// What stylo keeps on a node, beside it: an element's id as an atom, its `style` attribute and presentational hints as
// parsed (on first read after they changed), the computed style of the last traversal, and the traversal's flags —
// a shadow root's and a document's slot hold only the flags matching leaves on a parent.
pub(crate) struct StyleSlot {
    id: Option<Atom>,
    // (Both in an UnsafeCell: the verify pass empties them through a shared reference, between traversals.)
    style_attr: UnsafeCell<OnceCell<Option<Arc<Locked<PropertyDeclarationBlock>>>>>,
    // The presentational hints its own attributes give it, parsed on first read after any of them changes.
    hints: UnsafeCell<OnceCell<Option<Arc<Locked<PropertyDeclarationBlock>>>>>,
    data: UnsafeCell<Option<ElementDataWrapper>>,
    dirty_descendants: Cell<bool>,
    // The same for an animation-only restyle (`StyleEngine::advance_to`).
    animation_dirty_descendants: Cell<bool>,
    handled_snapshot: Cell<bool>,
    selector_flags: Cell<ElementSelectorFlags>,
    // Its state bits (`element_state`) and the arena `mutations` they were derived at…
    state: Cell<(u64, ElementState)>,
    // …and the bits its computed style was matched with, which a restyle compares the current ones against.
    styled_state: Cell<ElementState>,
    // Whether the engine holds a snapshot of it from before a change (`StyleEngine::snapshots`).
    has_snapshot: Cell<bool>,
}

impl StyleSlot {
    // `node`'s slot, as its attributes stand.
    pub(crate) fn of(node: &crate::dom::NodeData) -> StyleSlot {
        StyleSlot {
            id: node.plain_attr("id").filter(|v| !v.is_empty()).map(Atom::from),
            style_attr: UnsafeCell::new(OnceCell::new()),
            hints: UnsafeCell::new(OnceCell::new()),
            data: UnsafeCell::new(None),
            dirty_descendants: Cell::new(false),
            animation_dirty_descendants: Cell::new(false),
            handled_snapshot: Cell::new(false),
            selector_flags: Cell::new(ElementSelectorFlags::empty()),
            state: Cell::new((u64::MAX, ElementState::empty())),
            styled_state: Cell::new(ElementState::empty()),
            has_snapshot: Cell::new(false),
        }
    }
}

impl StyleSlot {
    // Forget the style the node was given (the engine that gave it is gone).
    pub(crate) fn forget_style(&self) {
        // SAFETY: called between traversals, with no borrow of the data outstanding.
        unsafe { *self.data.get() = None };
        self.dirty_descendants.set(false);
        self.animation_dirty_descendants.set(false);
        self.has_snapshot.set(false);
        self.handled_snapshot.set(false);
        self.clear_caches();
    }

    // Forget what was parsed and derived of the node, so the next read makes it again (the verify mode's full pass).
    fn clear_caches(&self) {
        // SAFETY: called between traversals — nothing holds a borrow of either cell's contents.
        unsafe {
            *self.style_attr.get() = OnceCell::new();
            *self.hints.get() = OnceCell::new();
        }
        self.state.set((u64::MAX, ElementState::empty()));
    }

    // The attribute `name` changed (None: any of them may have); `id` is the element's id now when that could have.
    pub(crate) fn attr_changed(&mut self, name: Option<&str>, id: Option<Atom>) {
        if name.is_none_or(|n| n == "id") {
            self.id = id.filter(|v| !v.is_empty());
        }
        if name.is_none_or(|n| n == "style") {
            *self.style_attr.get_mut() = OnceCell::new();
        }
        if name.is_none_or(|n| n != "style" && n != "class") {
            *self.hints.get_mut() = OnceCell::new();
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
    // Each element changed since then, as it was before the first change: its attributes (and its state, which a
    // restyle fills in when it finds that moved) — what stylo's invalidation holds against it now to tell which
    // elements' selectors may have started or stopped matching.
    snapshots: SnapshotMap,
    // Everything is styled again next time: the sheets changed, or a change reached a `:has()`…
    restyle_all: bool,
    // …and the rules did, so what an element's animations are made of may have: its `@keyframes` are looked up again.
    rules_changed: bool,
    // Each shadow root's own sheets (its `<style>` elements and adopted sheets), and whether they changed since
    // their cascade data was built.
    shadow_styles: std::collections::HashMap<NodeId, ShadowStyles>,
    // Whether any sheet (a shadow root's included) has a `:has()`, as of the last flush.
    has_relative: bool,
    // The arena's `state_epoch` when the element states were last compared.
    scanned_epoch: u64,
    // The user-agent sheet's quirks-mode half, while the document is in quirks mode.
    quirks_sheet: Option<DocumentStyleSheet>,
    // Every presentational-hint block made, by its text: elements with equal hints share one block (the style-sharing
    // cache compares blocks by identity).
    hint_blocks: RefCell<std::collections::HashMap<HintKey, Arc<Locked<PropertyDeclarationBlock>>>>,
    // CSIM_STYLE_VERIFY: every restyle that styled only what the changes reached is held against styling everything,
    // and each element whose values differ is reported here (`take_verify_failures`).
    verify: bool,
    verify_failures: Vec<String>,
    // The document's CSS animations and transitions, which the traversal starts, updates and cancels as styles
    // change (stylo's own model); the animation clock as of the last flush (seconds); and where each stood at the
    // last rendering update and stands now, which the events that update owes are the difference of
    // (`take_animation_events`).
    animations: DocumentAnimationSet,
    now: f64,
    updated_phases: std::collections::HashMap<AnimationId, (Phase, f64)>,
    phases: std::collections::HashMap<AnimationId, Observed>,
    generations: std::collections::HashMap<(AnimationSetKey, AnimationKind, String), u32>,
    // The Web Animations model: every script-made animation and effect, composited over the CSS ones; and the
    // elements it animates that a normal traversal restyled, whose keyframes are computed again after it.
    pub(crate) web_animations: waapi::Animations,
    restyled_targets: RefCell<Vec<NodeId>>,
    // A change hook panicked (a bug): what the engine holds may be half-updated, so the next style op throws it and
    // everything it styled away (`poisoned`).
    poisoned: bool,
}

// A sheet as the page hands it over: its text, the base URL its `url()`s resolve against, the media list it applies
// under, and whether it is a constructed sheet (`new CSSStyleSheet()`), whose `@import`s are ignored.
pub(crate) struct SheetSource {
    pub(crate) css: String,
    pub(crate) base: String,
    pub(crate) media: String,
    pub(crate) constructed: bool,
}

// What a parsed sheet was made from, so a set of sheets that keeps one keeps its parse.
#[derive(PartialEq)]
struct SheetKey {
    css_hash: u64,
    css_len: usize,
    base: String,
    media: String,
    constructed: bool,
}

impl SheetKey {
    fn of(source: &SheetSource) -> SheetKey {
        let mut hasher = std::hash::DefaultHasher::new();
        source.css.hash(&mut hasher);
        SheetKey {
            css_hash: hasher.finish(),
            css_len: source.css.len(),
            base: source.base.clone(),
            media: source.media.clone(),
            constructed: source.constructed,
        }
    }
}

// One shadow root's sheets, as the page last gave them, and the cascade data stylo built of them.
struct ShadowStyles {
    sheets: Vec<(SheetKey, DocumentStyleSheet)>,
    styles: AuthorStyles<DocumentStyleSheet>,
    dirty: bool,
}

impl Default for ShadowStyles {
    fn default() -> Self {
        ShadowStyles { sheets: Vec::new(), styles: AuthorStyles::new(), dirty: false }
    }
}

// The `@custom-media` a shadow root's sheets can see: none, as no browser ships them (`enable_properties`).
static NO_CUSTOM_MEDIA: std::sync::LazyLock<style::stylesheets::CustomMediaMap> = std::sync::LazyLock::new(Default::default);

// An `@import` whose sheet has not arrived: the rule, the absolute URL it asked for, and the media list its sheet
// will be made with.
struct PendingImport {
    url: String,
    rule: Arc<Locked<ImportRule>>,
    media: Arc<Locked<MediaList>>,
    // The URLs of the sheets that import it, outermost first: one already among them is a cycle.
    chain: Vec<String>,
}

// What a sheet's `@import`s ask of the engine while it is parsed: each is answered with a PENDING rule and noted,
// and the page supplies the sheet by its URL (`import`) — or REFUSED, when the sheet being parsed is among the ones
// importing it (an import cycle, which loads nothing).
struct Loader<'a> {
    pending: &'a RefCell<Vec<PendingImport>>,
    chain: Vec<String>,
}

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
        let href = url.url().map(|u| u.as_str().to_owned());
        let cycle = href.as_ref().is_some_and(|h| self.chain.contains(h));
        let refused = cycle || supports.as_ref().is_some_and(|s| !s.enabled);
        let sheet = if refused || href.is_none() { ImportSheet::new_refused() } else { ImportSheet::new_pending() };
        let rule = Arc::new(lock.wrap(ImportRule { url, stylesheet: sheet, supports, layer, source_location: location }));
        if let (false, Some(url)) = (refused, href) {
            self.pending.borrow_mut().push(PendingImport { url, rule: rule.clone(), media, chain: self.chain.clone() });
        }
        rule
    }
}

// Every property stylo can parse, whichever of Servo's layout switches it waits behind — this engine's layout is
// its own, so a switch Servo keeps off for its own layout's sake says nothing about ours — and every feature the
// browsers ship that stylo keeps behind a switch of its own. (What stays off is what no browser ships yet: `alpha()`,
// `progress()`, custom media, `light-dark()` images, elliptical corners, cross-document view transitions.)
fn enable_properties() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        use stylo_static_prefs::set_pref;
        set_pref!("layout.unimplemented", true);
        set_pref!("layout.grid.enabled", true);
        set_pref!("layout.columns.enabled", true);
        set_pref!("layout.variable_fonts.enabled", true);
        set_pref!("layout.container-queries.enabled", true);
        set_pref!("layout.writing-mode.enabled", true);
        set_pref!("layout.css.has-selector.enabled", true);
        set_pref!("layout.css.nth-child-of.enabled", true);
        set_pref!("layout.css.at-scope.enabled", true);
        set_pref!("layout.css.starting-style-at-rules.enabled", true);
        set_pref!("layout.css.style-queries.enabled", true);
        set_pref!("layout.css.scroll-state.enabled", true);
        set_pref!("layout.css.anchor-positioning.enabled", true);
        set_pref!("layout.css.attr.enabled", true);
        set_pref!("layout.css.tree-counting-functions.enabled", true);
        set_pref!("layout.css.scroll-driven-animations.enabled", true);
        set_pref!("layout.css.content.alt-text.enabled", true);
        set_pref!("layout.css.font-palette.enabled", true);
        set_pref!("layout.css.font-tech.enabled", true);
        set_pref!("layout.css.margin-rules.enabled", true);
        set_pref!("layout.css.basic-shape-shape.enabled", true);
        set_pref!("layout.css.background-clip.border-area.enabled", true);
        set_pref!("layout.css.appearance-base.enabled", true);
        set_pref!("dom.select.customizable_select.enabled", true);
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
    fn new(arena: &RealmArena, quirks: QuirksMode, viewport: (f32, f32), url: UrlExtraData) -> StyleEngine {
        enable_properties();
        let mut engine = StyleEngine {
            lock: arena.style_lock.0.clone(),
            stylist: Stylist::new(device(quirks, viewport), quirks),
            url,
            quirks,
            viewport,
            doc: None,
            author: Vec::new(),
            pending: RefCell::new(Vec::new()),
            styled: None,
            snapshots: SnapshotMap::new(),
            restyle_all: true,
            rules_changed: true,
            shadow_styles: Default::default(),
            has_relative: false,
            scanned_epoch: u64::MAX,
            quirks_sheet: None,
            hint_blocks: Default::default(),
            verify: std::env::var_os("CSIM_STYLE_VERIFY").is_some_and(|v| v != "0"),
            verify_failures: Vec::new(),
            poisoned: false,
            animations: Default::default(),
            now: 0.0,
            updated_phases: std::collections::HashMap::new(),
            phases: std::collections::HashMap::new(),
            generations: std::collections::HashMap::new(),
            web_animations: waapi::Animations::default(),
            restyled_targets: RefCell::new(Vec::new()),
        };
        let ua = engine.parse(UA_SHEET, engine.url.clone(), "", Origin::UserAgent, AllowImportRules::No, Vec::new());
        engine.stylist.append_stylesheet(ua, &engine.lock.read());
        engine.set_quirks(quirks);
        engine
    }

    // The engine of `arena`'s document at `base`, in `quirks` mode, with a `viewport` of CSS px: `current`, told what
    // changed, or a new one. It is never REPLACED — the elements' styles hold its rule tree.
    pub(crate) fn for_document(
        current: Option<StyleEngine>,
        arena: &RealmArena,
        base: &str,
        quirks: bool,
        viewport: (f32, f32),
    ) -> StyleEngine {
        let quirks = if quirks { QuirksMode::Quirks } else { QuirksMode::NoQuirks };
        let url = UrlExtraData::from(url::Url::parse(base).unwrap_or_else(|_| url::Url::parse("about:blank").unwrap()));
        let Some(mut engine) = current else { return StyleEngine::new(arena, quirks, viewport, url) };
        engine.url = url;
        if engine.quirks != quirks || engine.viewport != viewport {
            engine.quirks = quirks;
            engine.viewport = viewport;
            // …and the origins whose media queries now answer differently are rebuilt (the stylist says which).
            let guard = engine.lock.read();
            let changed =
                engine.stylist.set_device(device(quirks, viewport), &StylesheetGuards { author: &guard, ua_or_user: &guard });
            drop(guard);
            engine.stylist.force_stylesheet_origins_dirty(changed);
            for shadow in engine.shadow_styles.values_mut() {
                shadow.dirty = true;
            }
            engine.set_quirks(quirks);
            engine.styled = None;
            engine.restyle_all = true;
            engine.rules_changed = true;
        }
        engine
    }

    // The user-agent sheet's quirks-mode half goes in or out with the mode.
    fn set_quirks(&mut self, quirks: QuirksMode) {
        self.stylist.set_quirks_mode(quirks);
        let guard = self.lock.read();
        match (quirks == QuirksMode::Quirks, self.quirks_sheet.take()) {
            (true, Some(sheet)) => self.quirks_sheet = Some(sheet),
            (true, None) => {
                drop(guard);
                let sheet =
                    self.parse(UA_QUIRKS_SHEET, self.url.clone(), "", Origin::UserAgent, AllowImportRules::No, Vec::new());
                self.stylist.append_stylesheet(sheet.clone(), &self.lock.read());
                self.quirks_sheet = Some(sheet);
            }
            (false, Some(sheet)) => self.stylist.remove_stylesheet(sheet, &guard),
            (false, None) => {}
        }
    }

    // The realm's arena was emptied for a new page: nothing the engine held of its nodes means anything now.
    pub(crate) fn reset(&mut self) {
        self.doc = None;
        self.animations.sets.write().clear();
        self.updated_phases.clear();
        self.phases.clear();
        self.generations.clear();
        self.web_animations = waapi::Animations::default();
        self.restyled_targets.borrow_mut().clear();
        self.snapshots.clear();
        self.pending.borrow_mut().clear();
        self.shadow_styles.clear();
        self.hint_blocks.borrow_mut().clear();
        self.styled = None;
        self.restyle_all = true;
        self.rules_changed = true;
        self.scanned_epoch = u64::MAX;
    }

    fn parse(
        &self,
        css: &str,
        url: UrlExtraData,
        media: &str,
        origin: Origin,
        imports: AllowImportRules,
        chain: Vec<String>,
    ) -> DocumentStyleSheet {
        let media = Arc::new(self.lock.wrap(self.media_list(media, &url)));
        let sheet = Stylesheet::from_str(
            css,
            url,
            origin,
            media,
            self.lock.clone(),
            Some(&Loader { pending: &self.pending, chain }),
            None,
            self.quirks,
            imports,
        );
        DocumentStyleSheet(Arc::new(sheet))
    }

    // `source` parsed as an author sheet.
    fn parse_source(&self, source: &SheetSource) -> DocumentStyleSheet {
        let url = url::Url::parse(&source.base).map(UrlExtraData::from).unwrap_or_else(|_| self.url.clone());
        let imports = if source.constructed { AllowImportRules::No } else { AllowImportRules::Yes };
        // A sheet reached by URL is the first link of its imports' chain; an inline one names none.
        let chain = if source.constructed { Vec::new() } else { vec![source.base.clone()] };
        self.parse(&source.css, url, &source.media, Origin::Author, imports, chain)
    }

    // The block of `hints` for the hint level, or None when none of them is a declaration of its property. Each is
    // parsed ALONE, as the user agent writes it (its internal keywords allowed; an SVG attribute's length may be a
    // bare number), and kept only when it declared its own property and nothing else — so no attribute can write
    // two declarations. Equal hints are one block, which the style-sharing cache needs (it compares blocks by
    // identity).
    fn hint_block(&self, hints: &[crate::hints::Hint], svg: bool) -> Option<Arc<Locked<PropertyDeclarationBlock>>> {
        if hints.is_empty() {
            return None;
        }
        // Keyed on everything its parse read: the declarations, the SVG mode, and the base URL a `url()` resolved
        // against and the mode (both of which can change in place, `for_document`).
        let key = (hints.to_vec(), svg, self.url.0.as_str().to_owned(), self.quirks == QuirksMode::Quirks);
        if let Some(block) = self.hint_blocks.borrow().get(&key) {
            return Some(block.clone());
        }
        let mode = if svg { ParsingMode::ALLOW_UNITLESS_LENGTH } else { ParsingMode::DEFAULT };
        let context = ParserContext::new(
            Origin::UserAgent,
            &self.url,
            Some(CssRuleType::Style),
            mode,
            self.quirks,
            Default::default(),
            None,
            None,
            Default::default(),
        );
        let mut block = PropertyDeclarationBlock::new();
        for (prop, value) in hints {
            let Ok(id) = PropertyId::parse_enabled_for_all_content(prop) else { continue };
            let text = format!("{prop}: {value}");
            let mut input = ParserInput::new(&text);
            let parsed = parse_property_declaration_list(&context, &mut Parser::new(&mut input), &[]);
            let own = |d: &style::properties::PropertyDeclaration| match (id.as_shorthand(), d.id()) {
                (Ok(shorthand), PropertyDeclarationId::Longhand(l)) => shorthand.longhands().any(|s| s == l),
                (Err(longhand), declared) => declared == longhand,
                _ => false,
            };
            if parsed.len() != 0 && parsed.declarations().iter().all(own) {
                for d in parsed.declarations() {
                    block.push(d.clone(), style::properties::Importance::Normal);
                }
            }
        }
        if block.len() == 0 {
            return None;
        }
        let block = Arc::new(self.lock.wrap(block));
        let mut blocks = self.hint_blocks.borrow_mut();
        if blocks.len() >= HINT_BLOCK_LIMIT {
            blocks.clear();
        }
        blocks.insert(key, block.clone());
        Some(block)
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
    pub(crate) fn set_sheets(&mut self, doc: NodeId, sheets: &[SheetSource]) -> Vec<String> {
        if self.doc != Some(doc) {
            self.doc = Some(doc);
            self.styled = None;
            self.restyle_all = true;
        }
        // The same sheets again (a rebuild the rule set did not need) change nothing.
        if sheets.len() == self.author.len() && sheets.iter().zip(&self.author).all(|(s, (k, _))| SheetKey::of(s) == *k) {
            return Vec::new();
        }
        let mut kept = std::mem::take(&mut self.author);
        let guard = self.lock.read();
        for (_, sheet) in &kept {
            self.stylist.remove_stylesheet(sheet.clone(), &guard);
        }
        drop(guard);
        let before = self.pending.borrow().len();
        for source in sheets {
            let key = SheetKey::of(source);
            let sheet = match kept.iter().position(|(k, _)| *k == key) {
                Some(i) => kept.swap_remove(i).1,
                None => self.parse_source(source),
            };
            self.stylist.append_stylesheet(sheet.clone(), &self.lock.read());
            self.author.push((key, sheet));
        }
        self.styled = None;
        self.restyle_all = true;
        self.rules_changed = true;
        self.pending.borrow()[before..].iter().map(|p| p.url.clone()).collect()
    }

    // The shadow root `root`'s sheets become `sheets` (as `set_sheets` takes them), in its tree order; its host and
    // everything under it is styled again.
    pub(crate) fn set_shadow_sheets(&mut self, arena: &RealmArena, root: NodeId, sheets: &[SheetSource]) -> Vec<String> {
        let mut shadow = self.shadow_styles.remove(&root).unwrap_or_default();
        let mut kept = std::mem::take(&mut shadow.sheets);
        let guard = self.lock.read();
        for (_, sheet) in &kept {
            shadow.styles.stylesheets.remove_stylesheet(Some(self.stylist.device()), &NO_CUSTOM_MEDIA, sheet.clone(), &guard);
        }
        drop(guard);
        let before = self.pending.borrow().len();
        for source in sheets {
            let key = SheetKey::of(source);
            let sheet = match kept.iter().position(|(k, _)| *k == key) {
                Some(i) => kept.swap_remove(i).1,
                None => self.parse_source(source),
            };
            shadow.styles.stylesheets.append_stylesheet(
                Some(self.stylist.device()),
                &NO_CUSTOM_MEDIA,
                sheet.clone(),
                &self.lock.read(),
            );
            shadow.sheets.push((key, sheet));
        }
        shadow.dirty = true;
        self.shadow_styles.insert(root, shadow);
        self.styled = None;
        self.rules_changed = true;
        if let Some(host) = arena.get(root).and_then(|r| r.host) {
            in_arena(arena, self, || hint_element(StyleNode::new(arena, host), RestyleHint::restyle_subtree()));
        }
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
                        Some(&Loader { pending: &self.pending, chain: [&p.chain[..], &[url.to_owned()]].concat() }),
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
        self.restyle_all = true;
        self.rules_changed = true;
        self.pending.borrow()[before..].iter().map(|p| p.url.clone()).collect()
    }

    // Style the document as it stands in `arena`, when anything moved since it last was: what the changes since
    // then reached (the snapshots and hints the change hooks below left, and the elements whose state moved), or
    // everything when the sheets changed.
    fn ensure_styled(&mut self, arena: &RealmArena) {
        if self.styled == Some(arena.mutations) {
            return;
        }
        let Some(doc) = self.doc else { return };
        let _layout = LayoutThreadState::enter();
        {
            let guard = self.lock.read();
            self.stylist.flush(&StylesheetGuards { author: &guard, ua_or_user: &guard });
            self.shadow_styles.retain(|&root, _| arena.get(root).is_some());
            for shadow in self.shadow_styles.values_mut().filter(|s| s.dirty) {
                shadow.styles.flush(&mut self.stylist, &guard);
                shadow.dirty = false;
            }
            self.has_relative = self.stylist.iter_origins().any(|(data, _)| data.relative_selector_invalidation_map().len() != 0)
                || self.shadow_styles.values().any(|s| s.styles.data.relative_selector_invalidation_map().len() != 0);
        }
        self.snapshot_moved_states(arena);
        let restyle_all = std::mem::take(&mut self.restyle_all);
        let flags = match std::mem::take(&mut self.rules_changed) {
            true => TraversalFlags::ForCSSRuleChanges,
            false => TraversalFlags::empty(),
        };
        self.traverse(arena, doc, restyle_all, flags);
        for opaque in self.snapshots.keys() {
            if let Some(slot) = arena.style_slot(node_of(opaque.0)) {
                slot.has_snapshot.set(false);
                slot.handled_snapshot.set(false);
            }
        }
        self.snapshots.clear();
        if self.verify && !restyle_all {
            self.verify_against_restyling_everything(arena, doc);
        }
        self.styled = Some(arena.mutations);
    }

    // Every element's computed values, as `getComputedStyle` serializes them, and then everything styled again from
    // the sheets: an element whose values differ was one the changes reached that the restyle before did not reach.
    fn verify_against_restyling_everything(&mut self, arena: &RealmArena, doc: NodeId) {
        let values = |arena: &RealmArena| -> Vec<(NodeId, Vec<String>)> {
            arena
                .element_ids()
                .filter_map(|id| Some((id, primary_style(arena, id)?)))
                .map(|(id, style)| {
                    let longhands = ShorthandId::All
                        .longhands()
                        .chain([LonghandId::Direction, LonghandId::UnicodeBidi])
                        .map(|l| style.computed_value_to_string(PropertyDeclarationId::Longhand(l)));
                    (id, longhands.collect())
                })
                .collect()
        };
        let before = values(arena);
        // Every element of the flat tree was styled — one that was not would have read nothing, and been answered by
        // whatever else could.
        in_arena(arena, self, || {
            let Some(root) = StyleNode::new(arena, doc).first_child_element() else { return };
            let mut stack = vec![root];
            while let Some(el) = stack.pop() {
                let styled = arena.existing_style_slot(el.id).is_some_and(|s| unsafe { &*s.data.get() }.is_some());
                if !styled {
                    self.verify_failures.push(format!("<{}> is in the flat tree but has no style", el.node().local_name));
                    continue;
                }
                let display_none = primary_style(arena, el.id).is_some_and(|s| s.get_box().clone_display().is_none());
                if !display_none {
                    stack.extend(el.traversal_children().filter_map(|c| c.as_element()));
                }
            }
        });
        // …and what the element caches of its own (its parsed `style` attribute and hints, its state bits) is made
        // again for the comparison, so a stale cache cannot agree with itself.
        for id in arena.element_ids() {
            if let Some(slot) = arena.existing_style_slot(id) {
                slot.clear_caches();
            }
        }
        // The full restyle runs the animations' model too; it runs it on a copy, so that looking changes nothing.
        let copy = DocumentAnimationSet::default();
        copy.sets.write().extend(self.animations.sets.read().iter().map(|(key, set)| {
            // (…without what was canceled, which the real set is rid of before its next traversal.)
            let set = ElementAnimationSet {
                animations: set.animations.iter().filter(|a| a.state != AnimationState::Canceled).cloned().collect(),
                transitions: set.transitions.iter().filter(|t| t.state != AnimationState::Canceled).cloned().collect(),
                dirty: set.dirty,
                keyframes_parent: set.keyframes_parent.clone(),
            };
            (key.clone(), set)
        }));
        let animations = std::mem::replace(&mut self.animations, copy);
        self.traverse(arena, doc, true, TraversalFlags::empty());
        self.animations = animations;
        let after: std::collections::HashMap<NodeId, Vec<String>> = values(arena).into_iter().collect();
        let names: Vec<LonghandId> =
            ShorthandId::All.longhands().chain([LonghandId::Direction, LonghandId::UnicodeBidi]).collect();
        for (id, old) in before {
            let Some(new) = after.get(&id) else { continue };
            if let Some(i) = (0..old.len()).find(|&i| old[i] != new[i]) {
                let node = arena.get(id).map_or(String::new(), |n| n.local_name.to_string());
                self.verify_failures.push(format!(
                    "<{node}> {}: restyled {:?}, everything restyled {:?}",
                    names[i].name(),
                    old[i],
                    new[i]
                ));
            }
        }
    }

    // What the verify mode found since it was last asked.
    pub(crate) fn take_verify_failures(&mut self) -> Vec<String> {
        std::mem::take(&mut self.verify_failures)
    }

    // One traversal over the document: what the hints and snapshots reach, or everything.
    fn traverse(&self, arena: &RealmArena, doc: NodeId, restyle_all: bool, traversal_flags: TraversalFlags) {
        let engine: &StyleEngine = self;
        in_arena(arena, engine, || {
            let guard = engine.lock.read();
            let guards = StylesheetGuards { author: &guard, ua_or_user: &guard };
            let Some(root) = StyleNode::new(arena, doc).first_child_element() else { return };
            if restyle_all {
                if let Some(mut data) = root.mutate_data() {
                    data.hint.insert(RestyleHint::restyle_subtree());
                }
            }
            let context = SharedStyleContext {
                traversal_flags,
                stylist: &engine.stylist,
                options: GLOBAL_STYLE_DATA.options.clone(),
                guards,
                visited_styles_enabled: false,
                animations: engine.animations.clone(),
                current_time_for_animations: engine.now,
                snapshot_map: &engine.snapshots,
                registered_speculative_painters: &NoPainters,
            };
            let token = Recalc::pre_traverse(root, &context);
            if token.should_traverse() {
                style::driver::traverse_dom(&Recalc { context }, token, None);
            }
        });
    }

    // A styled element whose state bits moved since its style was matched is held against its old bits — looked for
    // only when something a state reads was written since the last look (`state_epoch`).
    fn snapshot_moved_states(&mut self, arena: &RealmArena) {
        if self.scanned_epoch == arena.state_epoch {
            return;
        }
        self.scanned_epoch = arena.state_epoch;
        let this: *const StyleEngine = self;
        let snapshots = &mut self.snapshots;
        let mut moved = false;
        in_arena(arena, this, || {
            for id in arena.element_ids() {
                let Some(slot) = arena.existing_style_slot(id) else { continue };
                if unsafe { &*slot.data.get() }.is_none() {
                    continue;
                }
                let el = StyleNode::new(arena, id);
                let before = slot.styled_state.get();
                if el.state() == before {
                    continue;
                }
                moved = true;
                snapshots.entry(TNode::opaque(&el)).or_default().state.get_or_insert(before);
                slot.has_snapshot.set(true);
                mark_ancestors_dirty(el);
                restyle_nth_of_siblings(el);
            }
        });
        self.restyle_all |= moved && self.has_relative;
    }

    // The attributes `names` of `id` are about to change: the element is snapshotted as it stands, and the level the
    // change lands on is hinted — a `style` attribute re-cascades that one block, `class` and `id` are the snapshot's
    // alone, any other may be a presentational hint of the element; a language, a direction and `exportparts`
    // (which of a shadow tree's parts an outer `::part()` reaches) reach its whole subtree, and a table's
    // `cellpadding` its cells.
    pub(crate) fn attributes_will_change(&mut self, arena: &RealmArena, id: NodeId, names: &[&str]) {
        self.guarded(|engine| engine.attributes_will_change_unguarded(arena, id, names));
    }
    fn attributes_will_change_unguarded(&mut self, arena: &RealmArena, id: NodeId, names: &[&str]) {
        let Some(node) = arena.get(id) else { return };
        let Some(slot) = arena.existing_style_slot(id) else { return };
        if unsafe { &*slot.data.get() }.is_none() {
            return;
        }
        let this: *const StyleEngine = self;
        let snapshots = &mut self.snapshots;
        in_arena(arena, this, || {
            let el = StyleNode::new(arena, id);
            let snapshot = snapshots.entry(TNode::opaque(&el)).or_default();
            if snapshot.attrs.is_none() {
                snapshot.attrs = Some(node.attributes.iter().map(|(k, v)| snapshot_attr(node, k, v)).collect());
            }
            let mut hint = RestyleHint::empty();
            for &name in names {
                snapshot.changed_attrs.push(LocalName::from(name));
                snapshot.id_changed |= name == "id";
                snapshot.class_changed |= name == "class";
                snapshot.other_attributes_changed |= name != "id" && name != "class";
                hint |= match name {
                    "style" => RestyleHint::RESTYLE_STYLE_ATTRIBUTE,
                    "lang" | "dir" | "xml:lang" | "exportparts" | "cellpadding" => RestyleHint::restyle_subtree(),
                    "class" | "id" => RestyleHint::empty(),
                    _ => RestyleHint::RESTYLE_SELF,
                };
            }
            slot.has_snapshot.set(true);
            slot.handled_snapshot.set(false);
            mark_ancestors_dirty(el);
            hint_element(el, hint);
            restyle_nth_of_siblings(el);
        });
        self.restyle_all |= self.has_relative;
    }

    // `parent`'s children changed (an insertion, a removal, a text node's data): what its children's selectors
    // depend on is in the flags matching left on it — a structural pseudo-class or a sibling combinator somewhere
    // restyles the children, `:empty` the parent itself — and a child that has never been styled is styled when the
    // parent is next visited. A shadow root's are its host's flat-tree children; a document's is the root, which
    // restyles everything.
    pub(crate) fn children_changed(&mut self, arena: &RealmArena, parent: NodeId) {
        self.guarded(|engine| engine.children_changed_unguarded(arena, parent));
    }
    fn children_changed_unguarded(&mut self, arena: &RealmArena, parent: NodeId) {
        let Some(p) = arena.get(parent) else { return };
        if p.kind == NodeKind::Document {
            self.restyle_all = true;
            return;
        }
        in_arena(arena, self, || {
            let flags = arena.existing_style_slot(parent).or_else(|| p.style.get().map(|b| &**b)).map(|s| s.selector_flags.get());
            let restyle_children = flags.is_some_and(|f| {
                f.intersects(
                    ElementSelectorFlags::HAS_SLOW_SELECTOR
                        | ElementSelectorFlags::HAS_SLOW_SELECTOR_LATER_SIBLINGS
                        | ElementSelectorFlags::HAS_SLOW_SELECTOR_NTH
                        | ElementSelectorFlags::HAS_SLOW_SELECTOR_NTH_OF
                        | ElementSelectorFlags::HAS_EDGE_CHILD_SELECTOR,
                )
            });
            let restyle_self = flags.is_some_and(|f| f.contains(ElementSelectorFlags::HAS_EMPTY_SELECTOR));
            if p.kind == NodeKind::Element {
                let Some(slot) = arena.existing_style_slot(parent) else { return };
                if unsafe { &*slot.data.get() }.is_none() {
                    return;
                }
                let el = StyleNode::new(arena, parent);
                let mut hint = RestyleHint::empty();
                if restyle_children {
                    hint |= RestyleHint::RESTYLE_DESCENDANTS;
                }
                if restyle_self {
                    hint |= RestyleHint::RESTYLE_SELF;
                }
                hint_element(el, hint);
                mark_ancestors_dirty(el);
                unsafe { el.set_dirty_descendants() };
                // …and when its emptiness can have changed under a sibling combinator (`.e:empty + .t`), the siblings
                // after it, whose matching read it (Firefox's `RestyleForEmptyChange`).
                if restyle_self {
                    restyle_later_siblings(arena, parent);
                }
            } else if let Some(host) = p.host.filter(|&h| arena.existing_style_slot(h).is_some()) {
                // A shadow root: its top-level children are the host's flat-tree children.
                let host = StyleNode::new(arena, host);
                if restyle_children {
                    for &c in &p.children {
                        if arena.is_element(c) {
                            hint_element(StyleNode::new(arena, c), RestyleHint::restyle_subtree());
                        }
                    }
                }
                mark_ancestors_dirty(host);
                unsafe { host.set_dirty_descendants() };
            }
        });
        self.restyle_all |= self.has_relative;
    }

    // `id` leaves where it was — out of the document, out of its slot, or on its way somewhere else — and its subtree's
    // styles go with it (Firefox clears them on unbind): what it is styled as next is decided where it lands.
    pub(crate) fn node_left(&mut self, arena: &RealmArena, id: NodeId) {
        self.guarded(|engine| engine.node_left_unguarded(arena, id));
    }
    fn node_left_unguarded(&mut self, arena: &RealmArena, id: NodeId) {
        let mut stack = vec![id];
        while let Some(n) = stack.pop() {
            let Some(node) = arena.get(n) else { continue };
            if let Some(slot) = node.style.get() {
                unsafe { *slot.data.get() = None };
                slot.dirty_descendants.set(false);
                slot.selector_flags.set(ElementSelectorFlags::empty());
                if slot.has_snapshot.replace(false) {
                    self.snapshots.remove(&OpaqueNode(opaque_bits(n)));
                }
            }
            stack.extend(node.children.iter().copied());
            stack.extend(node.shadow_root);
        }
    }

    // `id` gained or lost a custom state (`:state()`), which no snapshot records: it and everything a combinator can
    // reach from it — its parent's children — are styled again.
    pub(crate) fn custom_states_changed(&mut self, arena: &RealmArena, id: NodeId) {
        self.guarded(|engine| engine.custom_states_changed_unguarded(arena, id));
    }
    fn custom_states_changed_unguarded(&mut self, arena: &RealmArena, id: NodeId) {
        in_arena(arena, self, || {
            let el = StyleNode::new(arena, id);
            match TElement::traversal_parent(&el) {
                Some(p) => hint_element(p, RestyleHint::restyle_subtree()),
                None => hint_element(el, RestyleHint::restyle_subtree()),
            }
        });
        self.restyle_all |= self.has_relative;
    }

    // `host` has a shadow root now: its light children leave the flat tree (a slot may take them back, and style them
    // then), and what it renders is its shadow tree.
    pub(crate) fn shadow_attached(&mut self, arena: &RealmArena, host: NodeId) {
        self.guarded(|engine| engine.shadow_attached_unguarded(arena, host));
    }
    fn shadow_attached_unguarded(&mut self, arena: &RealmArena, host: NodeId) {
        let Some(node) = arena.get(host) else { return };
        for &c in &node.children {
            self.node_left(arena, c);
        }
        in_arena(arena, self, || {
            if arena.existing_style_slot(host).is_some() {
                let h = StyleNode::new(arena, host);
                hint_element(h, RestyleHint::restyle_subtree());
                unsafe { h.set_dirty_descendants() };
            }
        });
        self.restyle_all |= self.has_relative;
    }

    // `slot`'s assigned nodes changed (the ones that came or went have left where they were, `node_left`): its
    // flat-tree children are new.
    pub(crate) fn slot_assignment_changed(&mut self, arena: &RealmArena, slot: NodeId) {
        self.guarded(|engine| engine.slot_assignment_changed_unguarded(arena, slot));
    }
    fn slot_assignment_changed_unguarded(&mut self, arena: &RealmArena, slot: NodeId) {
        in_arena(arena, self, || {
            if arena.existing_style_slot(slot).is_some() {
                let s = StyleNode::new(arena, slot);
                hint_element(s, RestyleHint::restyle_subtree());
                unsafe { s.set_dirty_descendants() };
            }
        });
        self.restyle_all |= self.has_relative;
    }

    // The style of the box `id`'s box sits in: its flat-tree parent's, looking through any that is `display:
    // contents` and generates no box of its own.
    fn box_parent_style(&self, arena: &RealmArena, id: NodeId) -> Option<Arc<ComputedValues>> {
        in_arena(arena, self, || {
            let mut cur = TElement::traversal_parent(&StyleNode::new(arena, id));
            while let Some(p) = cur {
                let style = primary_style(arena, p.id)?;
                if !style.get_box().clone_display().is_contents() {
                    return Some(style);
                }
                cur = TElement::traversal_parent(&p);
            }
            None
        })
    }

    // Run a change hook, catching a panic (a bug) where it would unwind into V8's callback frame and abort the process:
    // the engine is marked `poisoned`, and the next style op drops it.
    fn guarded(&mut self, hook: impl FnOnce(&mut StyleEngine)) {
        if self.poisoned {
            return;
        }
        let this = &mut *self;
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || hook(this))).is_err() {
            self.poisoned = true;
        }
    }

    pub(crate) fn poisoned(&self) -> bool {
        self.poisoned
    }

    pub(crate) fn verifies(&self) -> bool {
        self.verify
    }

    // A style flush at `now_ms` on the page's clock: the animations move to it and the document is styled as it
    // stands, which starts, updates and cancels them as their styles say. The events every state change owes wait,
    // in the order they happened, for the rendering update to take them.
    pub(crate) fn flush(&mut self, arena: &RealmArena, now_ms: f64) {
        // (Nothing moved — neither the clock nor the document — nothing to do: the read that asks is a hot path.)
        if now_ms / 1000.0 == self.now && self.styled == Some(arena.mutations) {
            return;
        }
        self.advance_to(arena, now_ms);
        self.ensure_styled(arena);
        self.compute_effects(arena);
        self.note_animation_phases(arena);
    }

    // A Web Animations op (`element.animate`, `play()`, a seek…): whatever it did, the next read styles again.
    pub(crate) fn web_animations_op<R>(&mut self, op: impl FnOnce(&mut waapi::Animations) -> R) -> R {
        self.styled = None;
        op(&mut self.web_animations)
    }

    // A shorthand's value in `style`, as CSSOM's `getPropertyValue` gives it: its longhands' resolved values
    // serialized as the shorthand — None where they do not make one.
    fn shorthand_value(&self, style: &ComputedValues, shorthand: ShorthandId) -> Option<String> {
        let mut block = PropertyDeclarationBlock::new();
        let mut parsed = SourcePropertyDeclaration::default();
        for longhand in shorthand.longhands() {
            let value = style.computed_value_to_string(PropertyDeclarationId::Longhand(longhand));
            parse_one_declaration_into(
                &mut parsed,
                PropertyId::NonCustom(longhand.into()),
                &value,
                Origin::Author,
                &self.url,
                None,
                ParsingMode::DEFAULT,
                self.quirks,
                CssRuleType::Style,
            )
            .ok()?;
            block.extend(parsed.drain(), style::properties::Importance::Normal);
        }
        let mut out = String::new();
        block.shorthand_to_css(shorthand, &mut out).ok()?;
        (!out.is_empty()).then_some(out)
    }

    // An easing as the page wrote it (validated and made canonical by the JS side), computed; linear where it does not
    // parse.
    pub(crate) fn easing(&self, text: &str) -> ComputedTimingFunction {
        let context = ParserContext::new(
            Origin::Author,
            &self.url,
            Some(CssRuleType::Style),
            ParsingMode::DEFAULT,
            self.quirks,
            Default::default(),
            None,
            None,
            Default::default(),
        );
        let mut input = ParserInput::new(text);
        let parsed = SpecifiedTimingFunction::parse(&context, &mut Parser::new(&mut input));
        parsed.map_or(ComputedTimingFunction::Keyword(TimingKeyword::Linear), |f| f.to_computed_value_without_context())
    }

    // A keyframe's declarations, as `element.animate` gives them (property, value): each parsed as an author
    // declaration, a shorthand into its longhands, and one that does not parse left out (the JS side validated the
    // keyframes' shape, not their values).
    pub(crate) fn keyframe_block(&self, declarations: &[(String, String)]) -> Arc<Locked<PropertyDeclarationBlock>> {
        let mut block = PropertyDeclarationBlock::new();
        let mut parsed = SourcePropertyDeclaration::default();
        for (name, value) in declarations {
            let Ok(id) = PropertyId::parse_enabled_for_all_content(name) else { continue };
            let ok = parse_one_declaration_into(
                &mut parsed,
                id,
                value,
                Origin::Author,
                &self.url,
                None,
                ParsingMode::DEFAULT,
                self.quirks,
                CssRuleType::Keyframe,
            );
            if ok.is_ok() {
                block.extend(parsed.drain(), style::properties::Importance::Normal);
            }
        }
        Arc::new(self.lock.wrap(block))
    }

    // The style `id` has without its animations and transitions — its base style (web-animations §5.4.1), which a
    // neutral keyframe and a composite other than `replace` stand on.
    fn base_style(&self, arena: &RealmArena, id: NodeId, style: &Arc<ComputedValues>) -> Arc<ComputedValues> {
        let rules = style.rules();
        let base_rules = self.stylist.rule_tree().remove_animation_rules(rules);
        if base_rules == *rules {
            return style.clone();
        }
        in_arena(arena, self, || {
            let guard = self.lock.read();
            let shared = SharedStyleContext {
                traversal_flags: TraversalFlags::empty(),
                stylist: &self.stylist,
                options: GLOBAL_STYLE_DATA.options.clone(),
                guards: StylesheetGuards { author: &guard, ua_or_user: &guard },
                visited_styles_enabled: false,
                animations: self.animations.clone(),
                current_time_for_animations: self.now,
                snapshot_map: &self.snapshots,
                registered_speculative_painters: &NoPainters,
            };
            let mut thread_local = ThreadLocalStyleContext::new();
            let mut context = StyleContext { shared: &shared, thread_local: &mut thread_local };
            let inputs = CascadeInputs {
                rules: Some(base_rules),
                visited_rules: None,
                flags: style.flags.for_cascade_inputs(),
                included_cascade_flags: RuleCascadeFlags::empty(),
            };
            StyleResolverForElement::new(
                StyleNode::new(arena, id),
                &mut context,
                RuleInclusion::All,
                PseudoElementResolution::IfApplicable,
            )
            .cascade_style_and_visited_with_default_parents(inputs)
            .0
        })
    }

    // An effect's keyframes as values of its target (web-animations §5.3.3 "computing property values"): computed
    // in the target's base style, with its parent's to inherit from; None while the target has no style (or is a
    // pseudo-element, which the engine does not animate yet).
    fn compute_keyframes(&self, arena: &RealmArena, effect: &waapi::Effect) -> Option<waapi::ComputedKeyframes> {
        let target = effect.target.as_ref().filter(|t| t.pseudo.is_none())?;
        let style = primary_style(arena, target.node)?;
        let base = self.base_style(arena, target.node, &style);
        let parent = in_arena(arena, self, || {
            StyleNode::new(arena, target.node).inheritance_parent().and_then(|p| primary_style(arena, p.id))
        });
        let guard = self.lock.read();
        let device = self.stylist.device();
        let builder = StyleBuilder::for_derived_style(device, Some(&self.stylist), &base, parent.as_deref());
        let mut conditions = RuleCacheConditions::default();
        let mut counting = TreeCountingCaches::default();
        let mut context = Context::new_for_animation(
            builder,
            self.quirks,
            &mut conditions,
            ContainerSizeQuery::none(),
            &DummyElementContext,
            &mut counting,
        );
        let mut computed = waapi::ComputedKeyframes::default();
        for keyframe in &effect.keyframes {
            let block = keyframe.block.read_with(&guard);
            for value in block.to_animation_value_iter(&mut context, &base, device.default_computed_values()) {
                let id = value.id().to_owned();
                let frame = waapi::ComputedFrame {
                    offset: keyframe.offset,
                    easing: keyframe.easing.clone(),
                    composite: keyframe.composite.unwrap_or(effect.composite),
                    value,
                };
                match computed.properties.iter_mut().find(|(p, ..)| *p == id) {
                    Some((_, frames, _)) => frames.push(frame),
                    None => computed.properties.push((id, vec![frame], None)),
                }
            }
        }
        for (id, _, base_value) in &mut computed.properties {
            *base_value = AnimationValue::from_computed_values(id.as_borrowed(), &base);
        }
        Some(computed)
    }

    // Every effect whose keyframes are not computed for its target yet (new, changed, or its target restyled) is
    // computed now its target is styled, and its target's animated values composed again.
    fn compute_effects(&mut self, arena: &RealmArena) {
        for node in std::mem::take(&mut *self.restyled_targets.borrow_mut()) {
            self.web_animations.target_restyled(node);
        }
        let stale: Vec<waapi::EffectId> = self
            .web_animations
            .effects
            .iter()
            .filter(|(_, e)| e.computed.is_none() && e.target.is_some())
            .map(|(&id, _)| id)
            .collect();
        let mut restyle = Vec::new();
        for id in stale {
            let computed = self.compute_keyframes(arena, &self.web_animations.effects[&id]);
            let effect = self.web_animations.effects.get_mut(&id).unwrap();
            if computed.is_some() {
                restyle.extend(effect.target.as_ref().map(|t| t.node));
            }
            effect.computed = computed;
        }
        let Some(doc) = self.doc.filter(|_| !restyle.is_empty()) else { return };
        in_arena(arena, self, || {
            for &node in &restyle {
                if arena.existing_style_slot(node).is_some() {
                    hint_animated_values(StyleNode::new(arena, node));
                }
            }
        });
        let _layout = LayoutThreadState::enter();
        self.traverse(arena, doc, false, TraversalFlags::AnimationOnly);
    }

    // A rendering update's events: what each animation and transition moved through since the last one — its phase
    // then against its phase now, as CSS Animations 2 §4.2 and CSS Transitions 2 §6.1 tabulate them — in the order
    // they were due, and those due together in composite order: transitions before animations, then by owning element
    // in tree order, pseudo-element and position.
    pub(crate) fn take_animation_events(&mut self, arena: &RealmArena) -> Vec<AnimationEvent> {
        let mut events = Vec::new();
        for (id, now) in &self.phases {
            let (was, was_iteration) = self.updated_phases.get(id).copied().unwrap_or((Phase::Idle, 0.0));
            let moved = match id.kind {
                AnimationKind::Transition => transition_events(was, now.phase, now.interval, now.active),
                AnimationKind::Animation => animation_events(
                    was,
                    now.phase,
                    was_iteration != now.iteration,
                    now.iteration_start,
                    now.interval,
                    now.active,
                ),
            };
            for (kind, elapsed) in moved {
                let scheduled = to_microseconds(now.scheduled(kind, elapsed));
                let elapsed = to_microseconds(elapsed);
                events.push((scheduled, id, now, AnimationEvent { kind, node: now.node, pseudo: now.pseudo, name: id.name.clone(), elapsed }));
            }
        }
        if events.len() > 1 {
            let mut paths = std::collections::HashMap::new();
            for (_, _, now, _) in &events {
                paths.entry(now.node).or_insert_with(|| tree_path(arena, now.node));
            }
            // (…and what a new one replaced before it. Stable: one animation's events keep the order its phases moved
            // in.)
            events.sort_by(|(time_a, a, now_a, _), (time_b, b, now_b, _)| {
                time_a.total_cmp(time_b).then_with(|| {
                    (a.kind, &paths[&now_a.node], now_a.pseudo_rank, now_a.position, &a.name, a.generation)
                        .cmp(&(b.kind, &paths[&now_b.node], now_b.pseudo_rank, now_b.position, &b.name, b.generation))
                })
            });
        }
        let events = events.into_iter().map(|(.., event)| event).collect();
        // What ran out of the sets (and was no longer running) is forgotten; the rest is where the next update starts.
        self.phases.retain(|_, now| !now.departed);
        self.updated_phases = self.phases.iter().map(|(id, now)| (id.clone(), (now.phase, now.iteration))).collect();
        let phases = &self.phases;
        self.generations.retain(|(key, kind, name), &mut generation| {
            phases.contains_key(&AnimationId { key: key.clone(), kind: *kind, name: name.clone(), generation })
        });
        events
    }

    // Move the clock to `now_ms`: each animation and transition takes the state the time gives it (started,
    // iterated, finished — each a queued event), and every element with one the time moves takes its values at it.
    //
    // They move in an animation-only restyle, as Gecko's do: it cascades what they change to the descendants and
    // starts nothing, so a value a descendant inherits from an animation is already in its before-change style when
    // the next traversal compares — and a descendant transitioning the same property does not start a transition of
    // its own every frame.
    fn advance_to(&mut self, arena: &RealmArena, now_ms: f64) {
        // (…and the elements the Web Animations' timeline, an op or a frame moved, whose values are composed again
        // here too.)
        self.web_animations.set_timeline_time(now_ms);
        let mut restyle = self.web_animations.take_targets_to_restyle();
        let now = now_ms / 1000.0;
        if now != self.now {
            self.now = now;
            // (…those whose values the time moves — one ending now included: a finished animation holds its fill,
            // and a paused one its place.)
            let runs = |state: &AnimationState| matches!(state, AnimationState::Pending | AnimationState::Running);
            restyle.extend(
                self.animations
                    .sets
                    .read()
                    .iter()
                    .filter(|(_, set)| {
                        set.animations.iter().any(|a| runs(&a.state)) || set.transitions.iter().any(|t| runs(&t.state))
                    })
                    .map(|(key, _)| node_of(key.node.0)),
            );
            self.note_animation_phases(arena);
        }
        let Some(doc) = self.doc.filter(|_| !restyle.is_empty()) else { return };
        in_arena(arena, self, || {
            for &node in &restyle {
                if arena.existing_style_slot(node).is_some() {
                    hint_animated_values(StyleNode::new(arena, node));
                }
            }
        });
        let _layout = LayoutThreadState::enter();
        self.traverse(arena, doc, false, TraversalFlags::AnimationOnly);
    }

    // Every animation and transition takes the state the clock gives it — started, iterated (to the iteration the
    // time is in), ended, as stylo leaves to its embedder — and one on an element that is not rendered (`display:
    // none` on it or an ancestor, or not in the document) is canceled, which stylo leaves to it too. Where each then
    // stands is kept for the rendering update's events; what the sets no longer hold stays with the phase it left in
    // — `Idle` if it was still running, since only a canceled one leaves the sets then.
    fn note_animation_phases(&mut self, arena: &RealmArena) {
        let now = self.now;
        let mut sets = self.animations.sets.write();
        for observed in self.phases.values_mut() {
            observed.departed = true;
        }
        for (key, set) in sets.iter_mut() {
            let node = node_of(key.node.0);
            let pseudo = key.pseudo_element.as_ref().and_then(pseudo_name);
            let pseudo_rank = match pseudo {
                None => 0,
                Some("::marker") => 1,
                Some("::before") => 2,
                Some(_) => 3,
            };
            let rendered = primary_style(arena, node).is_some_and(|s| !s.get_box().clone_display().is_none());
            // What the traversal just made comes after what it replaced: those are observed first, and a new one
            // takes the name's next generation.
            let mut observed = Vec::new();
            for new in [false, true] {
                for t in set.transitions.iter_mut().filter(|t| t.is_new == new) {
                    if t.state == AnimationState::Pending && t.has_started(now) {
                        t.state = AnimationState::Running;
                    }
                    if t.state == AnimationState::Running && t.has_ended(now) {
                        t.state = AnimationState::Finished;
                    }
                    if !rendered {
                        t.state = AnimationState::Canceled;
                    }
                    // (`start_time` is where its active time is 0, the delay included.)
                    let duration = t.property_animation.duration;
                    let interval = TimeInterval::of(t.delay, duration);
                    let at = Observed {
                        phase: phase_of(&t.state),
                        interval,
                        zero: t.start_time,
                        active: (now - t.start_time).clamp(0.0, duration),
                        ..Observed::of(node, pseudo, pseudo_rank, 0, now)
                    };
                    observed.push((AnimationKind::Transition, transition_name(t), new, at));
                    t.is_new = false;
                }
                for (position, a) in set.animations.iter_mut().enumerate().filter(|(_, a)| a.is_new == new) {
                    if a.state == AnimationState::Pending && a.has_started(now) {
                        a.state = AnimationState::Running;
                    }
                    a.iterate_to(now);
                    if a.state == AnimationState::Running && a.has_ended(now) {
                        a.state = AnimationState::Finished;
                    }
                    // (`started_at` is where its CURRENT iteration began.)
                    let iteration = iteration_of(a);
                    let into_iteration = match a.state {
                        // (…none into a zero-length one, whose paused progress is infinite once it is over.)
                        AnimationState::Paused(progress) if a.duration > 0.0 => progress * a.duration,
                        AnimationState::Paused(_) => 0.0,
                        _ => now - a.started_at,
                    };
                    if !rendered {
                        a.state = AnimationState::Canceled;
                    }
                    let active_duration = match a.iteration_state {
                        KeyframesIterationState::Finite(_, max) => a.duration * max,
                        KeyframesIterationState::Infinite(_) => f64::INFINITY,
                    };
                    let run = iteration * a.duration + into_iteration;
                    let active = run.clamp(0.0, active_duration);
                    // A paused one is where its progress says: still in its delay, over, or running.
                    let phase = match a.state {
                        AnimationState::Paused(progress) if progress < 0.0 => Phase::Before,
                        AnimationState::Paused(_) if a.has_ended(now) => Phase::After,
                        ref state => phase_of(state),
                    };
                    let at = Observed {
                        phase,
                        iteration,
                        iteration_start: iteration * a.duration,
                        interval: TimeInterval::of(a.delay, active_duration),
                        zero: now - run,
                        active,
                        ..Observed::of(node, pseudo, pseudo_rank, position, now)
                    };
                    observed.push((AnimationKind::Animation, a.name.to_string(), new, at));
                    a.is_new = false;
                }
            }
            for (kind, name, new, at) in observed {
                let generation = self.generations.entry((key.clone(), kind, name.clone())).or_insert(0);
                if new {
                    *generation += 1;
                }
                self.phases.insert(AnimationId { key: key.clone(), kind, name, generation: *generation }, at);
            }
            set.clear_canceled_animations();
        }
        sets.retain(|_, set| !set.is_empty());
        for observed in self.phases.values_mut().filter(|o| o.departed) {
            if matches!(observed.phase, Phase::Before | Phase::Active) {
                observed.phase = Phase::Idle;
            }
        }
    }

    // `id`'s pseudo-element `pseudo` (`before`, `placeholder`, …): its style as `getComputedStyle(el, "::before")`
    // reads it — whether or not it generates a box, as Firefox computes it (`lazily_compute_pseudo_element_style`) where
    // the traversal did not.
    fn pseudo_style(&self, arena: &RealmArena, id: NodeId, pseudo: &str, originating: &ComputedValues) -> Option<Arc<ComputedValues>> {
        let pseudo = match pseudo.to_ascii_lowercase().as_str() {
            "before" => PseudoElement::Before,
            "after" => PseudoElement::After,
            "marker" => PseudoElement::Marker,
            "placeholder" => PseudoElement::Placeholder,
            "selection" => PseudoElement::Selection,
            "first-letter" => PseudoElement::FirstLetter,
            "backdrop" => PseudoElement::Backdrop,
            "file-selector-button" => PseudoElement::FileSelectorButton,
            "details-content" => PseudoElement::DetailsContent,
            _ => return None,
        };
        // An eager one the traversal styled is read as it left it — its animations and transitions applied.
        let slot = arena.existing_style_slot(id)?;
        let styled = unsafe { &*slot.data.get() }.as_ref().and_then(|data| data.borrow().styles.pseudos.get(&pseudo).cloned());
        if styled.is_some() {
            return styled;
        }
        in_arena(arena, self, || {
            let guard = self.lock.read();
            let guards = StylesheetGuards { author: &guard, ua_or_user: &guard };
            self.stylist.lazily_compute_pseudo_element_style(
                &guards,
                StyleNode::new(arena, id),
                &pseudo,
                RuleInclusion::All,
                originating,
                false,
                None,
            )
        })
    }

    // The computed value of the longhand `name` on `id`, as `getComputedStyle` serializes a computed value; None for
    // a shorthand, an unknown property, or an element the document's traversal did not style.
    pub(crate) fn value(
        &mut self,
        arena: &RealmArena,
        id: NodeId,
        name: &str,
        pseudo: Option<&str>,
        now_ms: f64,
    ) -> Option<String> {
        self.flush(arena, now_ms);
        let primary = primary_style(arena, id)?;
        let style = match pseudo {
            None => primary,
            Some(pseudo) => self.pseudo_style(arena, id, pseudo, &primary)?,
        };
        let style = &*style;
        let property = PropertyId::parse_enabled_for_all_content(name).ok()?;
        let longhand = match property.as_shorthand() {
            Ok(shorthand) => return self.shorthand_value(style, shorthand),
            Err(longhand) => longhand,
        };
        let value = style.computed_value_to_string(longhand);
        Some(match longhand {
            // CSSOM's resolved value of an automatic minimum size: the keyword on a flex or grid item, whose layout
            // gives it meaning, and zero on anything else.
            PropertyDeclarationId::Longhand(
                LonghandId::MinWidth | LonghandId::MinHeight | LonghandId::MinInlineSize | LonghandId::MinBlockSize,
            ) if value == "auto" => {
                if is_flex_or_grid_item(style, self.box_parent_style(arena, id)) {
                    value
                } else {
                    "0px".to_owned()
                }
            }
            _ => value,
        })
    }
}

// `id`'s state as stylo's bits: every state pseudo-class the arena answers, so that two elements whose bits are equal
// match the same of them (the style-sharing cache shares on that) and a rule of a rare one is collected at all (the
// rule map files `:link`, `:focus`, `:target`, … under the bit and asks for it).
fn element_state(arena: &RealmArena, id: NodeId, link: bool) -> ElementState {
    let mut s = ElementState::empty();
    let mut set = |flag: ElementState, on: bool| {
        if on {
            s.insert(flag);
        }
    };
    set(ElementState::UNVISITED, link);
    set(ElementState::FOCUS, arena.is_focused(id));
    set(ElementState::FOCUSRING, arena.is_focus_visible(id));
    set(ElementState::FOCUS_WITHIN, arena.has_focus_within(id));
    set(ElementState::HOVER, arena.is_hovered(id));
    set(ElementState::CHECKED, arena.is_checked(id) || arena.is_selected(id));
    set(ElementState::INDETERMINATE, arena.is_indeterminate(id));
    set(ElementState::DISABLED, arena.is_actually_disabled(id));
    set(ElementState::ENABLED, arena.is_enabled(id));
    set(ElementState::READWRITE, arena.is_read_write(id));
    set(ElementState::READONLY, !arena.is_read_write(id));
    set(ElementState::DEFAULT, arena.is_default(id));
    set(ElementState::OPEN, arena.is_open(id));
    set(ElementState::PLACEHOLDER_SHOWN, arena.is_placeholder_shown(id));
    set(ElementState::URLTARGET, arena.is_target(id));
    set(ElementState::DEFINED, arena.is_defined(id));
    set(ElementState::MODAL, arena.is_modal(id));
    set(ElementState::POPOVER_OPEN, arena.is_popover_open(id));
    match arena.is_valid_pseudo(id) {
        Some(true) => set(ElementState::VALID, true),
        Some(false) => set(ElementState::INVALID, true),
        None => {}
    }
    match arena.is_user_valid_pseudo(id) {
        Some(true) => set(ElementState::USER_VALID, true),
        Some(false) => set(ElementState::USER_INVALID, true),
        None => {}
    }
    match arena.is_in_range(id) {
        Some(true) => set(ElementState::INRANGE, true),
        Some(false) => set(ElementState::OUTOFRANGE, true),
        None => {}
    }
    match arena.requiredness(id) {
        Some(true) => set(ElementState::REQUIRED, true),
        Some(false) => set(ElementState::OPTIONAL_, true),
        None => {}
    }
    s
}

// An element's `exportparts` mappings, as (inner name, outer name): `inner: outer`, or a bare `name` for both.
fn export_parts(node: &crate::dom::NodeData) -> impl Iterator<Item = (AtomIdent, AtomIdent)> + '_ {
    node.plain_attr("exportparts").unwrap_or("").split(',').filter_map(|entry| {
        let mut halves = entry.splitn(2, ':').map(str::trim);
        let inner = halves.next().filter(|s| !s.is_empty())?;
        let outer = halves.next().unwrap_or(inner);
        (!outer.is_empty()).then(|| (AtomIdent::from(inner), AtomIdent::from(outer)))
    })
}

// An animation or transition event the page is owed: its type, the element (and pseudo-element) it concerns, the
// animation's name or the transition's property, and its `elapsedTime` in seconds.
pub(crate) struct AnimationEvent {
    pub(crate) kind: &'static str,
    pub(crate) node: NodeId,
    pub(crate) pseudo: Option<&'static str>,
    pub(crate) name: String,
    pub(crate) elapsed: f64,
}

// Where an animation or transition stands against its active interval (Web Animations §4.6.10), as its events
// compare them: `Idle` is not running at all (never started, or canceled).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Idle,
    Before,
    Active,
    After,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
enum AnimationKind {
    Transition,
    Animation,
}

// An animation or transition as the events know it: its element (and pseudo-element), whether it is one or the
// other, its name or property, and which of the ones by that name it is — a transition sent back where it came from
// is a new one, and the one it replaced is canceled.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
struct AnimationId {
    key: AnimationSetKey,
    kind: AnimationKind,
    name: String,
    generation: u32,
}

// Where an animation or transition stood when last looked at (`at`): its phase and iteration, the times its events
// report and the time its active time was 0 (`zero`), which with them says when each is scheduled; where it sorts
// among its element's (`pseudo_rank`, and `position` in `animation-name`); and whether it has left the sets since.
#[derive(Clone, Copy, Debug)]
struct Observed {
    node: NodeId,
    pseudo: Option<&'static str>,
    pseudo_rank: u8,
    position: usize,
    at: f64,
    phase: Phase,
    iteration: f64,
    iteration_start: f64,
    interval: TimeInterval,
    zero: f64,
    active: f64,
    departed: bool,
}

impl Observed {
    // Looked at `at`, and nothing more known yet: each kind sets over it what it has.
    fn of(node: NodeId, pseudo: Option<&'static str>, pseudo_rank: u8, position: usize, at: f64) -> Observed {
        Observed {
            node,
            pseudo,
            pseudo_rank,
            position,
            at,
            phase: Phase::Idle,
            iteration: 0.0,
            iteration_start: 0.0,
            interval: TimeInterval { start: 0.0, end: 0.0 },
            zero: at,
            active: 0.0,
            departed: false,
        }
    }

    // When an event it owes is due: at its `elapsed` time on its own clock, and a cancellation when it was looked at.
    fn scheduled(&self, kind: &str, elapsed: f64) -> f64 {
        if kind.ends_with("cancel") { self.at } else { self.zero + elapsed }
    }
}

// A phase as stylo's state says it (after the clock has moved it).
fn phase_of(state: &AnimationState) -> Phase {
    match state {
        AnimationState::Pending => Phase::Before,
        AnimationState::Running | AnimationState::Paused(_) => Phase::Active,
        AnimationState::Finished => Phase::After,
        AnimationState::Canceled => Phase::Idle,
    }
}

// The active interval an event's `elapsedTime` is measured on (seconds from its start, a negative delay having run
// part of it already).
#[derive(Clone, Copy, Debug)]
struct TimeInterval {
    start: f64,
    end: f64,
}

impl TimeInterval {
    // (A delay of 0 starts it at 0, not at -0.)
    fn of(delay: f64, active_duration: f64) -> TimeInterval {
        let start = if delay < 0.0 { (-delay).min(active_duration) } else { 0.0 };
        TimeInterval { start, end: active_duration }
    }
}

// The events an animation moving from phase `was` to `now` owes, with their `elapsedTime`s (CSS Animations 2 §4.2);
// `iterated` is whether its current iteration moved inside the active phase, `iteration_start` where that one begins,
// and `active` the time it has run, which a cancellation reports.
fn animation_events(
    was: Phase,
    now: Phase,
    iterated: bool,
    iteration_start: f64,
    interval: TimeInterval,
    active: f64,
) -> Vec<(&'static str, f64)> {
    use Phase::*;
    match (was, now) {
        (Idle | Before, Active) => vec![("animationstart", interval.start)],
        (Idle | Before, After) => vec![("animationstart", interval.start), ("animationend", interval.end)],
        (Active, Before) => vec![("animationend", interval.start)],
        (Active, Active) if iterated => vec![("animationiteration", iteration_start)],
        (Active, After) => vec![("animationend", interval.end)],
        (After, Active) => vec![("animationstart", interval.end)],
        (After, Before) => vec![("animationstart", interval.end), ("animationend", interval.start)],
        (Before | Active, Idle) => vec![("animationcancel", active)],
        _ => Vec::new(),
    }
}

// …and a transition's (CSS Transitions 2 §6.1), `transitionrun` first once it exists at all.
fn transition_events(was: Phase, now: Phase, interval: TimeInterval, active: f64) -> Vec<(&'static str, f64)> {
    use Phase::*;
    match (was, now) {
        (Idle, Before) => vec![("transitionrun", interval.start)],
        (Idle, Active) => vec![("transitionrun", interval.start), ("transitionstart", interval.start)],
        (Idle, After) => vec![
            ("transitionrun", interval.start),
            ("transitionstart", interval.start),
            ("transitionend", interval.end),
        ],
        (Before, Active) => vec![("transitionstart", interval.start)],
        (Before, After) => vec![("transitionstart", interval.start), ("transitionend", interval.end)],
        (Active, After) => vec![("transitionend", interval.end)],
        (Active, Before) => vec![("transitionend", interval.start)],
        (After, Active) => vec![("transitionstart", interval.end)],
        (After, Before) => vec![("transitionstart", interval.end), ("transitionend", interval.start)],
        (Before | Active, Idle) => vec![("transitioncancel", active)],
        _ => Vec::new(),
    }
}

// Where `id` stands in shadow-including tree order, as the child indexes down to it (a shadow root comes before its
// host's children).
fn tree_path(arena: &RealmArena, id: NodeId) -> Vec<i64> {
    let mut path = Vec::new();
    let mut cur = id;
    while let Some(node) = arena.get(cur) {
        let (parent, index) = match (node.parent, node.host) {
            (Some(parent), _) => {
                let index = arena.get(parent).and_then(|p| p.children.iter().position(|&c| c == cur));
                (parent, index.map_or(-1, |i| i as i64))
            },
            (None, Some(host)) => (host, -1),
            (None, None) => break,
        };
        path.push(index);
        cur = parent;
    }
    path.reverse();
    path
}

// A time in seconds as an event reports it: to the microsecond a page's clock is kept in, which is also what drops
// the tail single precision leaves on a duration (stylo keeps `0.3s` as 0.30000001192092896) and a product of one
// leaves on an iteration's start.
fn to_microseconds(seconds: f64) -> f64 {
    (seconds * 1e6).round() / 1e6
}

// The property a transition's events name.
fn transition_name(t: &Transition) -> String {
    match t.property_animation.property_id() {
        PropertyDeclarationId::Longhand(l) => l.name().to_owned(),
        PropertyDeclarationId::Custom(n) => format!("--{n}"),
    }
}

// The iteration an animation is in (0 for the first).
fn iteration_of(a: &Animation) -> f64 {
    match a.iteration_state {
        KeyframesIterationState::Finite(current, _) | KeyframesIterationState::Infinite(current) => current,
    }
}

// A pseudo-element's name in an event (`::before`), for the ones an animation can run on.
fn pseudo_name(pseudo: &PseudoElement) -> Option<&'static str> {
    match pseudo {
        PseudoElement::Before => Some("::before"),
        PseudoElement::After => Some("::after"),
        PseudoElement::Marker => Some("::marker"),
        _ => None,
    }
}

// The node an `OpaqueNode` stands for (`opaque_bits`).
fn node_of(bits: usize) -> NodeId {
    let bits = bits - 1;
    NodeId { idx: bits as u32, generation: (bits >> 32) as u32 }
}

// The siblings after `id` are styled again, subtrees and all, when its parent (a shadow root included) says a sibling
// combinator's matching read what comes before them (`HAS_SLOW_SELECTOR_LATER_SIBLINGS`).
fn restyle_later_siblings(arena: &RealmArena, id: NodeId) {
    let Some(parent) = arena.get(id).and_then(|n| n.parent) else { return };
    let later = arena.get(parent).and_then(|p| p.style.get()).is_some_and(|s| {
        s.selector_flags.get().contains(ElementSelectorFlags::HAS_SLOW_SELECTOR_LATER_SIBLINGS)
    });
    let Some(siblings) = arena.get(parent).map(|p| &p.children).filter(|_| later) else { return };
    let Some(at) = siblings.iter().position(|&c| c == id) else { return };
    for &sibling in &siblings[at + 1..] {
        if arena.is_element(sibling) && arena.existing_style_slot(sibling).is_some() {
            hint_element(StyleNode::new(arena, sibling), RestyleHint::restyle_subtree());
        }
    }
}

// `:nth-child(… of S)` counts siblings that match S, which a change to one of them moves for every other: its parent's
// children are styled again when matching said a selector like that looked at them (Firefox's
// `RestyleSiblingsForNthOf`).
fn restyle_nth_of_siblings(el: StyleNode) {
    let Some(parent) = selectors::Element::parent_element(&el) else { return };
    if parent.slot().selector_flags.get().contains(ElementSelectorFlags::HAS_SLOW_SELECTOR_NTH_OF) {
        hint_element(parent, RestyleHint::RESTYLE_DESCENDANTS);
    }
}

// `el` is styled again as `hint` says, and the traversal is told the way down to it.
fn hint_element(el: StyleNode, hint: RestyleHint) {
    if hint.is_empty() {
        return;
    }
    if let Some(mut data) = el.mutate_data() {
        data.hint.insert(hint);
    }
    mark_ancestors_dirty(el);
}

// `el`'s animated values (and its pseudo-elements') are to move in the next animation-only restyle.
fn hint_animated_values(el: StyleNode) {
    match el.mutate_data() {
        Some(mut data) if data.has_styles() => {
            data.hint.insert(RestyleHint::RESTYLE_CSS_ANIMATIONS | RestyleHint::RESTYLE_CSS_TRANSITIONS)
        },
        _ => return,
    }
    let mut cur = TElement::traversal_parent(&el);
    while let Some(p) = cur {
        if p.has_animation_only_dirty_descendants() {
            break;
        }
        unsafe { p.set_animation_only_dirty_descendants() };
        cur = TElement::traversal_parent(&p);
    }
}

// Every flat-tree ancestor of `el` has a dirty descendant, up to the first that already knew.
fn mark_ancestors_dirty(el: StyleNode) {
    let mut cur = TElement::traversal_parent(&el);
    while let Some(p) = cur {
        if p.has_dirty_descendants() {
            break;
        }
        unsafe { p.set_dirty_descendants() };
        cur = TElement::traversal_parent(&p);
    }
}

// One attribute of `node` as a snapshot holds it: its name and namespace, and its value — the id an atom and the
// class list its tokens, as the matcher asks for them.
fn snapshot_attr(node: &crate::dom::NodeData, key: &str, value: &str) -> (AttrIdentifier, SnapshotValue) {
    let (ns, local) = match node.attr_ns.iter().find(|(k, _, _)| k == key) {
        Some((_, ns, local)) => (web_atoms::Namespace::from(ns.as_str()), local.as_str()),
        None => (web_atoms::Namespace::default(), key),
    };
    let ident = AttrIdentifier {
        local_name: LocalName::from(local),
        name: LocalName::from(key),
        namespace: GenericAtomIdent(ns),
        prefix: None,
    };
    let value = match local {
        "id" => SnapshotValue::Atom(Atom::from(value)),
        "class" => SnapshotValue::TokenList(
            std::sync::OnceLock::from(value.to_owned()),
            value.split_ascii_whitespace().map(Atom::from).collect(),
        ),
        _ => SnapshotValue::String(value.to_owned()),
    };
    (ident, value)
}

// The computed style the last traversal gave `id`.
fn primary_style(arena: &RealmArena, id: NodeId) -> Option<Arc<ComputedValues>> {
    let slot = arena.style_slot(id)?;
    // SAFETY: no traversal runs while a style is read.
    let data = unsafe { &*slot.data.get() }.as_ref()?.borrow();
    data.styles.get_primary().cloned()
}

// Is a box of `style`, under a parent of `parent`, a flex or grid item: its parent a flex or grid container, and
// itself in flow?
fn is_flex_or_grid_item(style: &ComputedValues, parent: Option<Arc<ComputedValues>>) -> bool {
    use style::computed_values::position::T as Position;
    parent.is_some_and(|p| p.get_box().clone_display().is_item_container())
        && !matches!(style.get_box().clone_position(), Position::Absolute | Position::Fixed)
}

// Stylo's thread state is LAYOUT while it styles, and back when it stops — a panic included.
struct LayoutThreadState;
impl LayoutThreadState {
    fn enter() -> LayoutThreadState {
        style::thread_state::enter(style::thread_state::ThreadState::LAYOUT);
        LayoutThreadState
    }
}
impl Drop for LayoutThreadState {
    fn drop(&mut self) {
        style::thread_state::exit(style::thread_state::ThreadState::LAYOUT);
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
            if self.context.traversal_flags.for_animation_only() {
                unsafe { el.unset_animation_only_dirty_descendants() };
            } else {
                el.slot().styled_state.set(el.state());
                unsafe { el.unset_dirty_descendants() };
                // (…and the keyframes of an element's Web Animations are its style's values: computed again.)
                if el.engine().web_animations.animates(el.id) {
                    el.engine().restyled_targets.borrow_mut().push(el.id);
                }
            }
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

// Run `f` with `arena` and `engine` as the ones every `StyleNode` reads. The engine is a pointer, as the change hooks
// write its snapshots while a handle may read it.
fn in_arena<R>(arena: &RealmArena, engine: *const StyleEngine, f: impl FnOnce() -> R) -> R {
    struct Restore((*const RealmArena, *const StyleEngine));
    impl Drop for Restore {
        fn drop(&mut self) {
            CONTEXT.with(|c| c.set(self.0));
        }
    }
    let _restore = Restore(CONTEXT.with(|c| c.replace((arena as *const RealmArena, engine))));
    f()
}

// Stylo's handle on an arena node — for a node, an element, a document and a shadow root alike, as the crate lets
// one type be all four. Only ever made for a live node, inside the `in_arena` call of the arena the lifetime borrows.
#[derive(Clone, Copy)]
#[repr(transparent)]
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
        self.engine().shadow_styles.get(&self.id).map(|s| &*s.styles.data)
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
    // The FLAT-tree parent: a slotted node's slot, a shadow tree's top-level node's host — and none for a host's
    // child no slot takes, which is in no flat tree.
    fn traversal_parent(&self) -> Option<Self::ConcreteElement> {
        let p = self.parent_node()?;
        let pn = p.node();
        if pn.shadow_root.is_some() {
            return self.node().assigned_slot.filter(|&s| self.arena().get(s).is_some()).map(|s| self.at(s));
        }
        if p.is_element() {
            return Some(p);
        }
        pn.host.map(|h| self.at(h))
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

// An element's flat-tree children: a host's shadow root's children, a slot's assigned nodes (its own children are
// its fallback, shown only when nothing is assigned), anything else's own children — the live ones.
pub(crate) struct Children<'a> {
    node: StyleNode<'a>,
    list: &'a [NodeId],
}

impl<'a> Iterator for Children<'a> {
    type Item = StyleNode<'a>;
    fn next(&mut self) -> Option<Self::Item> {
        while let Some((&c, rest)) = self.list.split_first() {
            self.list = rest;
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
            NonTSPseudoClass::Lang(lang) => arena.matches_lang(id, &lang.to_ascii_lowercase()),
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
        // …on the parent NODE: a shadow tree's top-level children's go to the shadow root (`children_changed`).
        let parent = flags.for_parent();
        if !parent.is_empty() {
            let arena = self.arena();
            if let Some(slot) = arena.parent_of(self.id).and_then(|p| arena.node_style_slot(p)) {
                slot.selector_flags.set(slot.selector_flags.get() | parent);
            }
        }
    }
    fn is_link(&self) -> bool {
        let node = self.node();
        match &*node.local_name {
            "a" | "area" if self.is_html() => node.plain_attr("href").is_some(),
            "a" if self.node().ns == ns!(svg) => {
                node.plain_attr("href").is_some() || node.ns_attr("http://www.w3.org/1999/xlink", "href").is_some()
            }
            _ => false,
        }
    }
    fn is_html_slot_element(&self) -> bool {
        self.is_html() && self.node().local_name == local_name!("slot")
    }
    fn assigned_slot(&self) -> Option<Self> {
        self.node().assigned_slot.filter(|&s| self.arena().get(s).is_some()).map(|s| self.at(s))
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
    // `exportparts` read the other way: the inner part an outer name `name` stands for here.
    fn imported_part(&self, name: &AtomIdent) -> Option<AtomIdent> {
        export_parts(self.node()).find(|(_, outer)| **outer == **name).map(|(inner, _)| inner)
    }
    fn is_part(&self, name: &AtomIdent) -> bool {
        self.node().plain_attr("part").unwrap_or("").split_ascii_whitespace().any(|p| p == &**name)
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
    // An `@scope` with no prelude in a shadow root's sheet is scoped to the host — the owner `<style>`'s parent when
    // that is the shadow root itself, which is where a component's sheet sits.
    fn implicit_scope_for_sheet_in_shadow_root(
        opaque_host: OpaqueElement,
        _sheet_index: usize,
    ) -> Option<ImplicitScopeRoot> {
        Some(ImplicitScopeRoot::ShadowHost(opaque_host))
    }
    // An element inherits from its flat-tree parent (a shadow tree's top-level element from its host, a slotted one
    // from its slot) — not from its DOM parent element, which a shadow tree's top-level element does not have.
    fn inheritance_parent(&self) -> Option<Self> {
        TElement::traversal_parent(self)
    }
    fn traversal_children(&self) -> LayoutIterator<Self::TraversalChildrenIterator> {
        let node = self.node();
        let arena = self.arena();
        let list: &'a [NodeId] = match node.shadow_root.and_then(|r| arena.get(r)) {
            Some(root) => &root.children,
            None if !node.assigned.is_empty() => &node.assigned,
            None => &node.children,
        };
        LayoutIterator(Children { node: *self, list })
    }
    fn slotted_nodes(&self) -> &[StyleNode<'a>] {
        let assigned: &'a [NodeId] = &self.node().assigned;
        // SAFETY: `StyleNode` is `repr(transparent)` over its `NodeId` (the rest is a zero-sized marker).
        unsafe { std::slice::from_raw_parts(assigned.as_ptr().cast::<StyleNode<'a>>(), assigned.len()) }
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
        // SAFETY: the cell is only emptied between traversals (`clear_caches`, `attr_changed` through `&mut`).
        let parsed = unsafe { &*self.slot().style_attr.get() }.get_or_init(|| {
            let css = self.node().plain_attr("style")?;
            let engine = self.engine();
            let block = parse_style_attribute(css, &engine.url, None, engine.quirks, CssRuleType::Style);
            Some(Arc::new(engine.lock.wrap(block)))
        });
        parsed.as_ref().map(|a| a.borrow_arc())
    }
    fn state(&self) -> ElementState {
        let arena = self.arena();
        let slot = self.slot();
        let (at, bits) = slot.state.get();
        if at == arena.mutations {
            return bits;
        }
        let bits = element_state(arena, self.id, selectors::Element::is_link(self));
        slot.state.set((arena.mutations, bits));
        bits
    }
    fn has_part_attr(&self) -> bool {
        self.node().plain_attr("part").is_some()
    }
    fn exports_any_part(&self) -> bool {
        self.node().plain_attr("exportparts").is_some()
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
    fn each_part<F>(&self, mut callback: F)
    where
        F: FnMut(&AtomIdent),
    {
        for part in self.node().plain_attr("part").unwrap_or("").split_ascii_whitespace() {
            callback(&AtomIdent::from(part));
        }
    }
    fn each_exported_part<F>(&self, name: &AtomIdent, mut callback: F)
    where
        F: FnMut(&AtomIdent),
    {
        for (inner, outer) in export_parts(self.node()) {
            if inner == *name {
                callback(&outer);
            }
        }
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
        self.slot().has_snapshot.get()
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
    fn has_animation_only_dirty_descendants(&self) -> bool {
        self.slot().animation_dirty_descendants.get()
    }
    unsafe fn set_animation_only_dirty_descendants(&self) {
        self.slot().animation_dirty_descendants.set(true);
    }
    unsafe fn unset_animation_only_dirty_descendants(&self) {
        self.slot().animation_dirty_descendants.set(false);
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
        true
    }
    fn has_animations(&self, context: &SharedStyleContext) -> bool {
        self.has_css_animations(context, None) || self.has_css_transitions(context, None)
    }
    fn has_css_animations(&self, context: &SharedStyleContext, pseudo: Option<PseudoElement>) -> bool {
        context.animations.has_active_animations(&AnimationSetKey::new(TNode::opaque(self), pseudo))
    }
    fn has_css_transitions(&self, context: &SharedStyleContext, pseudo: Option<PseudoElement>) -> bool {
        context.animations.has_active_transitions(&AnimationSetKey::new(TNode::opaque(self), pseudo))
    }
    // The CSS animations' values, and the Web Animations' composited over them (web-animations §5.4.2: script
    // animations come last in composite order).
    fn animation_rule(&self, context: &SharedStyleContext) -> Option<Arc<Locked<PropertyDeclarationBlock>>> {
        let key = AnimationSetKey::new_for_non_pseudo(TNode::opaque(self));
        let now = context.current_time_for_animations;
        let web_animations = &self.engine().web_animations;
        if !web_animations.animates(self.id) {
            return context.animations.get_animation_declarations(&key, now, &self.engine().lock);
        }
        let mut values = context
            .animations
            .sets
            .read()
            .get(&key)
            .and_then(|set| set.get_value_map_for_active_animations(now))
            .unwrap_or_default();
        web_animations.compose(&waapi::Target { node: self.id, pseudo: None }, &mut values);
        if values.is_empty() {
            return None;
        }
        Some(Arc::new(self.engine().lock.wrap(PropertyDeclarationBlock::from_animation_value_map(&values))))
    }
    fn transition_rule(&self, context: &SharedStyleContext) -> Option<Arc<Locked<PropertyDeclarationBlock>>> {
        context.animations.get_transition_declarations(
            &AnimationSetKey::new_for_non_pseudo(TNode::opaque(self)),
            context.current_time_for_animations,
            &self.engine().lock,
        )
    }
    fn get_attr(&self, attr: &LocalName, ns: &style::Namespace) -> Option<String> {
        let node = self.node();
        if ns.0.is_empty() { node.plain_attr(&attr.0) } else { node.ns_attr(&ns.0, &attr.0) }.map(str::to_owned)
    }
    fn shadow_root(&self) -> Option<StyleNode<'a>> {
        self.node().shadow_root.filter(|&r| self.arena().get(r).is_some()).map(|r| self.at(r))
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
        self.arena().matches_lang(self.id, &value.to_ascii_lowercase())
    }
    fn is_html_document_body_element(&self) -> bool {
        self.is_html()
            && self.node().local_name == local_name!("body")
            && self
                .parent_node()
                .is_some_and(|p| p.is_element() && p.node().local_name == local_name!("html") && p.parent_node().is_some_and(|d| d.as_document().is_some()))
    }
    fn synthesize_presentational_hints_for_legacy_attributes<V>(&self, _visited: VisitedHandlingMode, hints: &mut V)
    where
        V: Push<ApplicableDeclarationBlock>,
    {
        let engine = self.engine();
        let mut push = |block: Arc<Locked<PropertyDeclarationBlock>>| {
            hints.push(ApplicableDeclarationBlock::from_declarations(
                block,
                CascadeLevel::new(CascadeOrigin::PresHints),
                LayerOrder::root(),
            ));
        };
        let svg = self.node().ns == ns!(svg);
        // SAFETY: as `style_attribute`'s.
        let own = unsafe { &*self.slot().hints.get() }.get_or_init(|| {
            let mut list = Vec::new();
            crate::hints::own_hints(self.node(), &mut list);
            engine.hint_block(&list, svg)
        });
        if let Some(block) = own {
            push(block.clone());
        }
        let mut list = Vec::new();
        crate::hints::cell_hints(self.arena(), self.id, &mut list);
        if let Some(block) = engine.hint_block(&list, false) {
            push(block);
        }
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

// What a hint block is cached under (`hint_block`).
type HintKey = (Vec<crate::hints::Hint>, bool, String, bool);

// How many distinct hint blocks the engine keeps before it starts over (a page has a handful).
const HINT_BLOCK_LIMIT: usize = 4096;

// The user-agent style sheet, and what it adds in quirks mode.
const UA_SHEET: &str = include_str!("ua.css");
const UA_QUIRKS_SHEET: &str = include_str!("ua-quirks.css");

#[cfg(test)]
mod tests {
    use super::*;
    use style::error_reporting::{ContextualParseError, ParseErrorReporter};

    struct Errors(RefCell<Vec<String>>);
    impl ParseErrorReporter for Errors {
        fn report_error(&self, _url: &UrlExtraData, location: SourceLocation, error: ContextualParseError) {
            self.0.borrow_mut().push(format!("{}:{}: {error}", location.line + 1, location.column));
        }
    }

    // Every declaration and selector of the user-agent sheet is one stylo accepts: a rule it cannot parse is dropped
    // without a sound, and the default it carried with it.
    #[test]
    fn the_user_agent_sheets_parse_whole() {
        for sheet in [UA_SHEET, UA_QUIRKS_SHEET] {
            assert_parses_whole(sheet);
        }
    }

    fn assert_parses_whole(sheet: &str) {
        enable_properties();
        let lock = SharedRwLock::new();
        let errors = Errors(RefCell::new(Vec::new()));
        Stylesheet::from_str(
            sheet,
            UrlExtraData::from(url::Url::parse("about:blank").unwrap()),
            Origin::UserAgent,
            Arc::new(lock.wrap(MediaList::empty())),
            lock.clone(),
            None,
            Some(&errors),
            QuirksMode::NoQuirks,
            AllowImportRules::Yes,
        );
        assert_eq!(errors.0.into_inner(), Vec::<String>::new());
    }

    // Every declaration a presentational hint writes is one stylo accepts, for every mapping `hints.rs` has.
    #[test]
    fn every_hint_parses() {
        use crate::dom::{NodeData, NodeKind};
        enable_properties();
        let cases: &[(&str, &[(&str, &str)])] = &[
            ("body", &[("marginheight", "5"), ("leftmargin", "7"), ("text", "red"), ("bgcolor", "#abc"), ("background", "a b.png")]),
            ("div", &[("align", "middle")]),
            ("caption", &[("align", "bottom")]),
            ("br", &[("clear", "all")]),
            ("font", &[("color", "chucknorris"), ("face", "Georgia, serif"), ("size", "+2")]),
            ("table", &[("cellspacing", "3"), ("border", "x"), ("bordercolor", "blue"), ("align", "center"), ("width", "50%"), ("height", "20")]),
            ("td", &[("align", "justify"), ("valign", "center"), ("nowrap", ""), ("width", "10.50"), ("height", "3")]),
            ("img", &[("width", "10"), ("height", "20"), ("hspace", "2"), ("vspace", "3"), ("border", "4"), ("align", "absmiddle")]),
            ("img", &[("align", "middle")]),
            ("input", &[("type", "IMAGE"), ("width", "1"), ("height", "2"), ("align", "left"), ("border", "-1")]),
            ("canvas", &[("width", "300"), ("height", "150")]),
            ("iframe", &[("frameborder", "0"), ("width", "100%")]),
            ("hr", &[("align", "right"), ("size", "7"), ("color", "green"), ("width", "40")]),
            ("hr", &[("size", "1")]),
            ("hr", &[("size", "9")]),
            ("li", &[("value", "4")]),
            ("ol", &[("start", "-3")]),
            ("ol", &[("reversed", ""), ("start", "20")]),
            ("ol", &[("reversed", "")]),
            ("col", &[("valign", "top"), ("width", "0")]),
        ];
        // …and an attribute that is not one declaration of its property sets nothing at all.
        let arena_for_injection = RealmArena::default();
        let injected = StyleEngine::new(&arena_for_injection, QuirksMode::NoQuirks, (800.0, 600.0), UrlExtraData::from(url::Url::parse("about:blank").unwrap()));
        let hints = vec![("font-family", "x; display: none".to_owned()), ("color", "red; display: none".to_owned())];
        assert!(injected.hint_block(&hints, false).is_none());
        let arena = RealmArena::default();
        let engine = StyleEngine::new(&arena, QuirksMode::NoQuirks, (800.0, 600.0), UrlExtraData::from(url::Url::parse("about:blank").unwrap()));
        for (tag, attrs) in cases {
            let mut node = NodeData::of_kind(NodeKind::Element, Vec::new());
            node.local_name = web_atoms::LocalName::from(*tag);
            node.ns = ns!(html);
            node.attributes = attrs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            let mut hints = Vec::new();
            crate::hints::own_hints(&node, &mut hints);
            assert!(!hints.is_empty(), "<{tag}> gave no hint");
            let block = engine.hint_block(&hints, false).expect("a hint block");
            let guard = engine.lock.read();
            let parsed = block.read_with(&guard).len();
            let declared: usize = hints
                .iter()
                .map(|(p, _)| match PropertyId::parse_enabled_for_all_content(p).unwrap().as_shorthand() {
                    Ok(s) => s.longhands().count(),
                    Err(_) => 1,
                })
                .sum();
            assert_eq!(parsed, declared, "<{tag}>: {hints:?}");
        }
    }
}
