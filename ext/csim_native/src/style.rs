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
    CascadeInputs, ThreadLocalStyleContext, TreeCountingCaches, UpdateAnimationsTasks,
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
    parse_one_declaration_into, parse_property_declaration_list, parse_style_attribute, AnimationDeclarations,
    ComputedValues, LonghandId, OwnedPropertyDeclarationId,
    PropertyDeclarationBlock, PropertyDeclarationId, PropertyId, ShorthandId, SourcePropertyDeclaration, StyleBuilder,
};
use style::rule_cache::RuleCacheConditions;
use style::parser::Parse;
use style::values::computed::easing::ComputedTimingFunction;
use style::values::generics::easing::TimingKeyword;
use style::values::specified::easing::TimingFunction as SpecifiedTimingFunction;
use style::rule_tree::RuleCascadeFlags;
use style::style_resolver::{PrimaryStyle, PseudoElementResolution, ResolvedStyle, StyleResolverForElement};
use style::stylesheets::container_rule::ContainerSizeQuery;
use style::values::computed::Context;
use style::rule_tree::{CascadeLevel, CascadeOrigin};
use style::stylesheets::layer_rule::LayerOrder;
use style::selector_parser::SnapshotMap;
use style::servo::attr::{AttrIdentifier, AttrValue as SnapshotValue};
use style::stylesheets::import_rule::{ImportLayer, ImportSheet, ImportSupportsCondition};
use style::stylesheets::keyframes_rule::KeyframesStepValue;
use style::values::specified::animation::{AnimationComposition, AnimationDirection, AnimationFillMode, AnimationPlayState};
use style::values::specified::TransitionBehavior;
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
use style::animation::DocumentAnimationSet;
use style::author_styles::AuthorStyles;
use style::stylist::{RuleInclusion, Stylist};
use style::traversal::{recalc_style_at, DomTraversal, PerLevelTraversalData};
use style::traversal_flags::TraversalFlags;
use style::values::{AtomIdent, AtomString, GenericAtomIdent};
use style::{Atom, LocalName};
use stylo_dom::ElementState;
use web_atoms::{local_name, ns, LocalNameStaticSet, Namespace, NamespaceStaticSet};

use crate::animations as waapi;
use crate::css_animations::CssAnimationStyle;
use crate::css_transitions::TransitionChange;
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
    // …and, for an element an `:empty` was matched against, whether it WAS empty then — what a child-list change is
    // held against, so only a change that flips it restyles what read it (`children_changed`).
    styled_empty: Cell<Option<bool>>,
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
            styled_empty: Cell::new(None),
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
    // (…the faces of the realm it styles, which its font metrics read)
    faces: crate::walk::SharedFaces,
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
    // The animation clock as of the last flush (ms); and stylo's own model of animations, which runs none here — the
    // engine runs every one itself, as Gecko does — but which a traversal's context holds all the same.
    clock: f64,
    animations: DocumentAnimationSet,
    // The Web Animations model: every animation on the page — a script's, and the CSS animations and transitions style
    // makes — and what the traversal left it to do, as Gecko's does (`update_animations`).
    pub(crate) web_animations: waapi::Animations,
    animation_tasks: RefCell<Vec<AnimationTask>>,
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
    // Whether a sheet reads the host's light DESCENDANTS through `:host(:has(…))` (`host_reads_descendants`), which the
    // relative-selector invalidation maps do not record: a `:has()` inside `:host()` is collected nowhere, so a class
    // written under the host restyled nothing in its tree.
    host_has: bool,
}

impl Default for ShadowStyles {
    fn default() -> Self {
        ShadowStyles { sheets: Vec::new(), styles: AuthorStyles::new(), dirty: false, host_has: false }
    }
}

// Whether `css` holds a `:has()` inside a `:host()` ARGUMENT — read off the text, as the JS cascade's
// `hostReadsDescendants` reads it: between a `:host(` and the parenthesis that closes it (ASCII case-insensitively).
fn host_reads_descendants(css: &str) -> bool {
    let lower = css.to_ascii_lowercase();
    lower.match_indices(":host(").any(|(at, _)| {
        let arg = &lower[at + ":host".len()..];
        let mut depth = 0;
        let end = arg
            .bytes()
            .position(|b| {
                depth += match b {
                    b'(' => 1,
                    b')' => -1,
                    _ => 0,
                };
                depth == 0
            })
            .unwrap_or(arg.len());
        arg[..end].contains(":has(")
    })
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

fn device(faces: crate::walk::SharedFaces, quirks: QuirksMode, (width, height): (f32, f32)) -> Device {
    Device::new(
        MediaType::screen(),
        quirks,
        euclid::Size2D::new(width, height),
        euclid::Size2D::new(width, height),
        euclid::Scale::new(1.0),
        Box::new(crate::style_fonts::Metrics { faces }),
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
            faces: arena.faces.clone(),
            lock: arena.style_lock.0.clone(),
            stylist: Stylist::new(device(arena.faces.clone(), quirks, viewport), quirks),
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
            clock: 0.0,
            animations: Default::default(),
            web_animations: waapi::Animations::default(),
            animation_tasks: RefCell::new(Vec::new()),
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
                engine.stylist.set_device(device(engine.faces.clone(), quirks, viewport), &StylesheetGuards::same(&guard));
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

    // Every element's style computed again at the next flush: a font metric (`ex`, `ch`) it was computed with a stand-in
    // for is known now.
    pub(crate) fn restyle_everything(&mut self) {
        self.styled = None;
        self.restyle_all = true;
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
        self.web_animations = waapi::Animations::default();
        self.animation_tasks.borrow_mut().clear();
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

    // Whether the media query list `media` matches the document's device now (a `<source media>`).
    fn media_matches(&self, media: &str) -> bool {
        let list = self.media_list(media, &self.url);
        list.evaluate(self.stylist.device(), self.stylist.quirks_mode(), &mut style::stylesheets::CustomMediaEvaluator::none())
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
        shadow.host_has = sheets.iter().any(|source| host_reads_descendants(&source.css));
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
            self.stylist.flush(&StylesheetGuards::same(&guard));
            self.shadow_styles.retain(|&root, _| arena.get(root).is_some());
            for shadow in self.shadow_styles.values_mut().filter(|s| s.dirty) {
                shadow.styles.flush(&mut self.stylist, &guard);
                shadow.dirty = false;
            }
            // (…a `:has()` whose argument is a type or `*` alone is noted in the ADDITIONAL map only, and `used` says so)
            let relative = |data: &style::stylist::CascadeData| {
                data.relative_selector_invalidation_map().len() != 0 || data.relative_invalidation_map_attributes().used
            };
            self.has_relative = self.stylist.iter_origins().any(|(data, _)| relative(data))
                || self.shadow_styles.values().any(|s| s.host_has || relative(&s.styles.data));
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
        // (What the full restyle leaves the animations to do is not done: looking changes nothing — nor what the
        // incremental restyles keep of each element to compare with next time, its state and its emptiness, which a
        // full restyle rewrites everywhere and so would hide every change the next incremental one missed.)
        let tasks = std::mem::take(&mut *self.animation_tasks.borrow_mut());
        let kept: Vec<(NodeId, ElementState, Option<bool>)> = arena
            .element_ids()
            .filter_map(|id| arena.existing_style_slot(id).map(|s| (id, s.styled_state.get(), s.styled_empty.get())))
            .collect();
        self.traverse(arena, doc, true, TraversalFlags::empty());
        for (id, state, empty) in kept {
            if let Some(slot) = arena.existing_style_slot(id) {
                slot.styled_state.set(state);
                slot.styled_empty.set(empty);
            }
        }
        *self.animation_tasks.borrow_mut() = tasks;
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
            let guards = StylesheetGuards::same(&guard);
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
                current_time_for_animations: engine.clock / 1000.0,
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
                // (…and the state it is now is the one the snapshot is held against from here: the restyle that follows
                // may not reach the element itself — a `:checked ~ .panel` restyles its sibling alone — and a state left
                // at its old value reads as unmoved when it flips BACK, so nothing is restyled for that)
                slot.styled_state.set(el.state());
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
        // (…a `:has()` reads it styled or not: an element nothing styles — under a `display: none`, or a host's light
        // child no slot takes — still decides the match of one above it)
        let styled = arena.existing_style_slot(id).is_some_and(|slot| unsafe { &*slot.data.get() }.is_some());
        self.restyle_all |= self.relative_reads_attributes(names, !styled);
        let Some(node) = arena.get(id) else { return };
        if node.is_html_named("source") {
            if let Some(picture) = arena.parent_of(id) {
                self.restyle_picture_images(arena, picture);
            }
        }
        let Some(slot) = arena.existing_style_slot(id).filter(|_| styled) else { return };
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
    }

    // `picture`'s images, where it is a `<picture>`: which `<source>` each selects — and so the dimensions its hints map
    // (`hints::picture_hints`) — reads its siblings, whose writes restyle nothing of the img's own.
    fn restyle_picture_images(&self, arena: &RealmArena, picture: NodeId) {
        let Some(p) = arena.get(picture).filter(|p| p.is_html_named("picture")) else { return };
        in_arena(arena, self, || {
            for &c in &p.children {
                let styled = arena.existing_style_slot(c).is_some_and(|s| unsafe { &*s.data.get() }.is_some());
                if styled && arena.get(c).is_some_and(|n| n.is_html_named("img")) {
                    let el = StyleNode::new(arena, c);
                    mark_ancestors_dirty(el);
                    hint_element(el, RestyleHint::RESTYLE_SELF);
                }
            }
        });
    }

    // Whether a `:has()` can read an attribute named in `names`: a class or an id where its argument names any, another
    // attribute where one names THAT one (`relative_selector_invalidation_map`, by its LOCAL name — `xlink:href` is
    // `[xlink|href]`'s `href`), a `lang` / `dir` always (`:lang()` and `:dir()` read them through no attribute
    // selector), and anything under a `:host(:has(…))`, which no map records. And on an element nothing styles
    // (`unstyled`), any attribute a state can read (`dom::attribute_reads_state` — not a class, a style, a `data-*` or
    // an `aria-*`) where an argument reads an element STATE: `checked`, `disabled`, `placeholder`, `form`… move one,
    // and `snapshot_moved_states` sees a moved state only on an element it styled before.
    // Every write restyled the whole document on a page with any `:has()` — a `data-*` attribute written under a
    // `display: none` 300 times was 4x the page's time — though no argument can read one it does not name.
    fn relative_reads_attributes(&self, names: &[&str], unstyled: bool) -> bool {
        if !self.has_relative {
            return false;
        }
        if self.shadow_styles.values().any(|s| s.host_has) {
            return true;
        }
        let reads = |data: &style::stylist::CascadeData| {
            let map = data.relative_selector_invalidation_map();
            (unstyled && !map.state_affecting_selectors.is_empty() && names.iter().any(|&name| crate::dom::attribute_reads_state(name)))
                || names.iter().any(|&name| match name {
                    "class" => !map.class_to_selector.is_empty(),
                    "id" => !map.id_to_selector.is_empty(),
                    "lang" | "xml:lang" | "dir" => true,
                    _ => {
                        let local = name.rsplit(':').next().unwrap_or(name);
                        map.other_attribute_affecting_selectors.contains_key(&LocalName::from(local))
                    }
                })
        };
        self.stylist.iter_origins().any(|(data, _)| reads(data)) || self.shadow_styles.values().any(|s| reads(&s.styles.data))
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
        self.restyle_picture_images(arena, parent);
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
            // (…an `:empty` read of it restyles only where the change FLIPPED what it read: a row appended to a list that
            // already had rows changes nothing an `:empty` selector saw — Firefox's `RestyleForEmptyChange` is posted
            // on a flip alone. One never seen empty or not is taken as flipped.)
            let restyle_self = flags.is_some_and(|f| f.contains(ElementSelectorFlags::HAS_EMPTY_SELECTOR))
                && arena.existing_style_slot(parent).is_none_or(|s| s.styled_empty.get() != Some(arena.is_empty(parent)));
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
                // …an emptiness a DESCENDANT's selector read too (`:empty p`, and a shadow tree's `:host(:empty) p`): its
                // whole subtree, as Firefox's `RestyleForEmptyChange` posts it.
                if restyle_self {
                    hint |= RestyleHint::restyle_subtree();
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
        if now_ms == self.clock && self.styled == Some(arena.mutations) {
            return;
        }
        self.advance_to(arena, now_ms);
        // (Keyframes a change made stale are computed before the traversal it restyles: their values are what that
        // traversal's before-change and after-change styles hold, so an animation starting starts no transition.)
        self.compute_effects(arena);
        self.ensure_styled(arena);
        self.update_animations(arena);
        self.compute_effects(arena);
    }

    // What `commitStyles()` writes for animation `id`: the model's effect stack up to it.
    pub(crate) fn committed_values(&self, arena: &RealmArena, id: waapi::AnimationId) -> Vec<AnimationValue> {
        self.web_animations.committed_values(id, Default::default(), &|a, b| tree_order(arena, a, b))
    }

    // What `getAnimations()` reports: the relevant animations targeting `element` itself (not its pseudo-elements) —
    // with `subtree`, those targeting its pseudo-elements and its descendants too — or anything in the document where
    // there is no element; in composite order.
    pub(crate) fn relevant_animations(
        &self,
        arena: &RealmArena,
        element: Option<NodeId>,
        subtree: bool,
    ) -> Vec<waapi::AnimationId> {
        let order = |a, b| tree_order(arena, a, b);
        let within = |root: NodeId, node: NodeId| {
            let mut cur = Some(node);
            while let Some(c) = cur {
                if c == root {
                    return true;
                }
                cur = arena.get(c).and_then(|n| n.parent);
            }
            false
        };
        match (element, self.doc) {
            (Some(el), _) if subtree => self.web_animations.relevant_animations(|t| within(el, t.node), &order),
            (Some(el), _) => self.web_animations.relevant_animations(|t| t.node == el && t.pseudo.is_none(), &order),
            (None, Some(doc)) => {
                self.web_animations.relevant_animations(|t| arena.is_inclusive_ancestor(doc, t.node), &order)
            },
            (None, None) => Vec::new(),
        }
    }

    // `ids` sorted in composite order.
    pub(crate) fn in_composite_order(&self, arena: &RealmArena, mut ids: Vec<waapi::AnimationId>) -> Vec<waapi::AnimationId> {
        let model = &self.web_animations;
        ids.retain(|id| model.animations.contains_key(id));
        ids.sort_by(|&x, &y| model.composite_order(x, y, &|a, b| tree_order(arena, a, b)));
        ids
    }

    // The properties the animations on `element` itself set, as their keyframes declare them (a shorthand expanded)
    // and under the names of the shorthands those are part of — what the JS side's cascade and layout ask of an
    // animated element, until they read the engine's styles (and whose longhand can be the engine's shorthand:
    // `white-space`, `vertical-align`).
    pub(crate) fn animated_properties(&self, element: NodeId) -> Vec<String> {
        let guard = self.lock.read();
        let mut out: Vec<String> = Vec::new();
        for effect in self.effects_on(element) {
            for keyframe in &effect.keyframes {
                for declaration in keyframe.block.read_with(&guard).declarations() {
                    for name in names_of(declaration.id()) {
                        if !out.iter().any(|n| *n == name) {
                            out.push(name.into_owned());
                        }
                    }
                }
            }
        }
        out
    }

    // Whether an animation on `element` itself that sets one of `properties` is relevant (current, or in effect), and
    // whether one is in effect.
    pub(crate) fn animation_activity(&self, element: NodeId, properties: &[String]) -> (bool, bool) {
        let model = &self.web_animations;
        let guard = self.lock.read();
        let (mut relevant, mut in_effect) = (false, false);
        for effect in self.effects_on(element) {
            let sets = effect.keyframes.iter().any(|k| {
                k.block
                    .read_with(&guard)
                    .declarations()
                    .iter()
                    .any(|d| names_of(d.id()).any(|name| properties.iter().any(|p| *p == name)))
            });
            let Some(animation) = effect.animation.filter(|_| sets) else { continue };
            relevant |= model.relevant(animation);
            in_effect |= model.computed_timing_of(effect).is_some_and(|t| t.progress.is_some());
        }
        (relevant, in_effect)
    }

    // The effects played by an animation that target `element` itself.
    fn effects_on(&self, element: NodeId) -> impl Iterator<Item = &waapi::Effect> {
        self.web_animations.effects_targeting(element).filter(move |e| {
            e.animation.is_some() && e.target.as_ref().is_some_and(|t| t.pseudo.is_none())
        })
    }

    // An effect's keyframes as `getKeyframes()` reports them: each one's offset, easing and composite (None: the
    // effect's), and its declarations serialized.
    #[allow(clippy::type_complexity)]
    pub(crate) fn keyframes_text(&self, effect: waapi::EffectId) -> Vec<(f64, String, Option<&'static str>, Vec<(String, String)>)> {
        let Some(effect) = self.web_animations.effects.get(&effect) else { return Vec::new() };
        let guard = self.lock.read();
        effect
            .keyframes
            .iter()
            .map(|k| {
                let easing = k.easing.as_ref().map_or_else(|| "linear".to_owned(), style_traits::ToCss::to_css_string);
                let composite = k.composite.map(|c| match c {
                    waapi::CompositeOperation::Replace => "replace",
                    waapi::CompositeOperation::Add => "add",
                    waapi::CompositeOperation::Accumulate => "accumulate",
                });
                let declarations = k
                    .block
                    .read_with(&guard)
                    .declarations()
                    .iter()
                    .map(|d| {
                        let mut value = String::new();
                        let _ = d.to_css(&mut value);
                        (d.id().name().to_string(), value)
                    })
                    .collect();
                (k.offset, easing, composite, declarations)
            })
            .collect()
    }

    // A Web Animations op (`element.animate`, `play()`, a seek…): whatever it did, the next read styles again.
    pub(crate) fn web_animations_op<R>(&mut self, op: impl FnOnce(&mut waapi::Animations) -> R) -> R {
        self.styled = None;
        op(&mut self.web_animations)
    }

    // A shorthand's value in `style`, as CSSOM's `getPropertyValue` gives it: its longhands' resolved values serialized
    // as the shorthand — None where they do not make one. …except `text-decoration`'s colour, which Chrome and Firefox
    // both leave out while it is `currentcolor` (`<del>`'s is `line-through`), however it resolves: taken COMPUTED, it is
    // the initial the shortest serialization omits. (`text-emphasis` keeps its resolved one in both: `none rgb(0, 0, 0)`.)
    fn shorthand_value(&self, style: &ComputedValues, shorthand: ShorthandId) -> Option<String> {
        let mut block = PropertyDeclarationBlock::new();
        let mut parsed = SourcePropertyDeclaration::default();
        for longhand in shorthand.longhands() {
            let value = if longhand == LonghandId::TextDecorationColor {
                let mut computed = String::new();
                style.computed_or_resolved_value(longhand, None, &mut computed).ok()?;
                computed
            } else {
                style.computed_value_to_string(PropertyDeclarationId::Longhand(longhand))
            };
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
    // keyframes' shape, not their values). Whatever order the page wrote them in, a longhand wins over a shorthand
    // that sets it, a physical property over a logical one, and a shorthand of fewer longhands over one of more
    // (web-animations §5.3.3 "computing property values"; css-logical §4): they are taken in that order, the last
    // one taken winning.
    pub(crate) fn keyframe_block(&self, declarations: &[(String, String)]) -> Arc<Locked<PropertyDeclarationBlock>> {
        let mut ordered: Vec<(PropertyId, &str)> = declarations
            .iter()
            .filter_map(|(name, value)| Some((PropertyId::parse_enabled_for_all_content(name).ok()?, value.as_str())))
            .collect();
        ordered.sort_by_key(|(id, _)| match id.as_shorthand() {
            Ok(shorthand) => (0, !shorthand.longhands().any(|l| l.is_logical()), usize::MAX - shorthand.longhands().count()),
            Err(longhand) => (1, longhand.as_longhand().is_some_and(|l| !l.is_logical()), 0),
        });
        let mut block = PropertyDeclarationBlock::new();
        let mut parsed = SourcePropertyDeclaration::default();
        for (id, value) in ordered {
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

    // The style of a connected element the traversal did not style — one under a `display: none`, whose descendants no
    // traversal styles — resolved on its own, its unstyled ancestors with it, and kept nowhere (Gecko's
    // `ResolveStyleLazily`): what `getComputedStyle` reports of it, and what a script reading a hidden element's
    // style (jQuery's `.css()` on a closed dialog) asks for.
    fn undisplayed_style(&self, arena: &RealmArena, id: NodeId) -> Option<Arc<ComputedValues>> {
        if !arena.is_element(id) || !arena.is_connected(id) {
            return None;
        }
        in_arena(arena, self, || {
            let guard = self.lock.read();
            let shared = SharedStyleContext {
                traversal_flags: TraversalFlags::empty(),
                stylist: &self.stylist,
                options: GLOBAL_STYLE_DATA.options.clone(),
                guards: StylesheetGuards::same(&guard),
                visited_styles_enabled: false,
                animations: self.animations.clone(),
                current_time_for_animations: self.clock / 1000.0,
                snapshot_map: &self.snapshots,
                registered_speculative_painters: &NoPainters,
            };
            let mut thread_local = ThreadLocalStyleContext::new();
            let mut context = StyleContext { shared: &shared, thread_local: &mut thread_local };
            let styles = style::traversal::resolve_style(&mut context, StyleNode::new(arena, id), RuleInclusion::All, None, None);
            Some(styles.primary().clone())
        })
    }

    // The style `id` has without its animations and transitions — its base style (web-animations §5.4.1), which a
    // neutral keyframe and a composite other than `replace` stand on.
    fn base_style(&self, arena: &RealmArena, target: &waapi::Target, style: &Arc<ComputedValues>) -> Arc<ComputedValues> {
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
                guards: StylesheetGuards::same(&guard),
                visited_styles_enabled: false,
                animations: self.animations.clone(),
                current_time_for_animations: self.clock / 1000.0,
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
            let mut resolver = StyleResolverForElement::new(
                StyleNode::new(arena, target.node),
                &mut context,
                RuleInclusion::All,
                PseudoElementResolution::IfApplicable,
            );
            match (&target.pseudo, primary_style(arena, target.node)) {
                (Some(pseudo), Some(originating)) => {
                    let originating = PrimaryStyle { style: ResolvedStyle(originating), reused_via_rule_node: false };
                    resolver.cascade_style_and_visited_for_pseudo_with_default_parents(inputs, pseudo, &originating).0
                },
                _ => resolver.cascade_style_and_visited_with_default_parents(inputs).0,
            }
        })
    }

    // Whether an effect's keyframes, computed from its target's style as it was, would compute the same from the style
    // it has now: nothing they refer to beyond it, the very style it inherits from, and the same base rules and values
    // they can refer to in it — its font (`em`), color (`currentColor`), custom properties (`var()`) and writing mode
    // (logical properties).
    fn keyframe_inputs_hold(&self, arena: &RealmArena, effect: &waapi::Effect) -> bool {
        let (Some(inputs), Some(target)) = (&effect.computed_from, &effect.target) else { return false };
        let Some(style) = target_style(arena, target).filter(|_| !inputs.contextual) else { return false };
        let same_parent = match (&inputs.parent, self.target_parent_style(arena, target)) {
            (Some(was), Some(now)) => Arc::ptr_eq(was, &now),
            (was, now) => was.is_none() && now.is_none(),
        };
        let (was, now) = (&*inputs.style, &*style);
        let rule_tree = self.stylist.rule_tree();
        same_parent
            && rule_tree.remove_animation_rules(was.rules()) == rule_tree.remove_animation_rules(now.rules())
            && was.writing_mode == now.writing_mode
            && was.custom_properties() == now.custom_properties()
            && was.get_font() == now.get_font()
            && was.get_inherited_text() == now.get_inherited_text()
    }

    // An effect's keyframes as values of its target (web-animations §5.3.3 "computing property values"): computed
    // in the target's base style, with its parent's to inherit from — a pseudo-element's parent being its originating
    // element — and what they were computed from; None while the target has no style.
    fn compute_keyframes(
        &self,
        arena: &RealmArena,
        effect: &waapi::Effect,
    ) -> Option<(waapi::ComputedKeyframes, waapi::KeyframeInputs)> {
        let target = effect.target.as_ref()?;
        let style = target_style(arena, target)?;
        let base = self.base_style(arena, target, &style);
        let parent = self.target_parent_style(arena, target);
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
        let mut contextual = false;
        for keyframe in &effect.keyframes {
            let block = keyframe.block.read_with(&guard);
            contextual = contextual || block.declarations().iter().any(refers_beyond_the_style);
            // (Each value is of the physical property the target's writing mode maps it to: one keyframe that sets a
            // property twice — logical and physical — sets it to the value declared last.)
            let mut values: Vec<AnimationValue> = Vec::new();
            for value in block.to_animation_value_iter(&mut context, &base, device.default_computed_values()) {
                values.retain(|v| v.id() != value.id());
                values.push(value);
            }
            for value in values {
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
        Some((computed, waapi::KeyframeInputs { style, parent: parent.clone(), contextual }))
    }

    // The style an effect's target inherits from: its parent's in the flat tree — a pseudo-element's, its originating
    // element's.
    fn target_parent_style(&self, arena: &RealmArena, target: &waapi::Target) -> Option<Arc<ComputedValues>> {
        match target.pseudo {
            Some(_) => primary_style(arena, target.node),
            None => in_arena(arena, self, || {
                StyleNode::new(arena, target.node).inheritance_parent().and_then(|p| primary_style(arena, p.id))
            }),
        }
    }

    // Every effect whose keyframes are not computed for its target yet (new, changed, or its target restyled) is
    // computed now its target is styled, and its target's animated values composed again.
    // (…and every one whose animations changed otherwise, as an op or a style made them.)
    fn compute_effects(&mut self, arena: &RealmArena) {
        let stale: Vec<waapi::EffectId> = self
            .web_animations
            .effects
            .iter()
            .filter(|(_, e)| (e.computed.is_none() || (e.restyled && !e.given)) && e.target.is_some())
            .map(|(&id, _)| id)
            .collect();
        let mut restyle = self.web_animations.take_targets_to_restyle();
        for id in stale {
            let effect = &self.web_animations.effects[&id];
            // (A restyle that left what they were computed from — every `color` change of an animated element that
            // does not reach its keyframes — leaves them, and what the target shows with them.)
            if effect.computed.is_some() && self.keyframe_inputs_hold(arena, effect) {
                self.web_animations.effects.get_mut(&id).unwrap().restyled = false;
                continue;
            }
            let computed = self.compute_keyframes(arena, effect);
            let effect = self.web_animations.effects.get_mut(&id).unwrap();
            if computed.is_some() {
                restyle.extend(effect.target.as_ref().map(|t| t.node));
            }
            (effect.computed, effect.computed_from) = computed.unzip();
            effect.restyled = false;
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

    // What the traversal left the animations to do (`StyleNode::update_animations`, Gecko's `UpdateAnimations` tasks):
    // the CSS animations of each element (or pseudo-element) whose new style may change them are built from it, its
    // transitions started, reversed or canceled from its before-change style to its after-change one, and the
    // keyframes of each one restyled are computed again. A CSS animation or transition whose owner is no longer
    // rendered — `display: none` on an ancestor, which leaves the owner's style as it was, or gone from the document —
    // goes as though its style had listed none.
    fn update_animations(&mut self, arena: &RealmArena) {
        let tasks = std::mem::take(&mut *self.animation_tasks.borrow_mut());
        for task in tasks {
            let target = waapi::Target { node: task.node, pseudo: task.pseudo };
            if task.tasks.contains(UpdateAnimationsTasks::CSS_ANIMATIONS) {
                let styles = self.css_animation_styles(arena, &target);
                self.web_animations.update_css_animations(&target, styles);
            }
            if task.tasks.contains(UpdateAnimationsTasks::CSS_TRANSITIONS) {
                let running = self.web_animations.transitioning_properties(&target);
                let (listed, changes) = match (&task.before_change_style, &task.after_change_style) {
                    (Some(before), Some(after)) if rendered_style(arena, &target).is_some() => {
                        transition_changes(before, after, &running)
                    },
                    _ => (Vec::new(), Vec::new()),
                };
                self.web_animations.update_css_transitions(&target, &listed, changes, &self.lock);
            }
            if task.tasks.contains(UpdateAnimationsTasks::EFFECT_PROPERTIES) {
                self.web_animations.target_restyled(task.node);
            }
        }
        let model = &self.web_animations;
        let unrendered: Vec<waapi::AnimationId> = model
            .css_owners()
            .flat_map(|node| model.css_by_owner[&node].iter().copied())
            .filter(|id| {
                let owner = model.animations[id].css.as_ref().and_then(|css| css.owner.as_ref());
                owner.is_some_and(|o| !is_rendered(arena, o))
            })
            .collect();
        for id in unrendered {
            self.web_animations.unrendered(id);
        }
        self.web_animations.forget_completed_transitions(|owner| is_rendered(arena, owner));
    }

    // What `target`'s style says of its CSS animations (css-animations-1 §3): one for each `animation-name` a
    // `@keyframes` rule in its scope names, in `animation-name` order, the other `animation-*` lists repeating to its
    // length. Each keyframe eases to the next by the `animation-timing-function` it declares, else the animation's,
    // and composites by the `animation-composition` it declares, else the effect's — the animation's; the effect
    // itself is linear. None where the target is not rendered.
    fn css_animation_styles(&self, arena: &RealmArena, target: &waapi::Target) -> Vec<CssAnimationStyle> {
        let Some(style) = rendered_style(arena, target) else { return Vec::new() };
        let ui = style.get_ui();
        let guard = self.lock.read();
        let guards = StylesheetGuards::same(&guard);
        in_arena(arena, self, || {
            let element = StyleNode::new(arena, target.node);
            ui.animation_name_iter()
                .enumerate()
                .filter_map(|(i, name)| {
                    let name = name.as_atom()?;
                    let rule = self.stylist.lookup_keyframes(name, element, style.rules(), &guards)?;
                    let easing = ui.animation_timing_function_mod(i);
                    let composite = composite_of(ui.animation_composition_mod(i));
                    let keyframes = rule
                        .steps
                        .iter()
                        .filter_map(|step| {
                            let KeyframesStepValue::Declarations { block } = &step.value else { return None };
                            let declared_easing = step.get_animation_timing_function(&guard);
                            let declared_composite = step.get_animation_composition(&guard);
                            Some(waapi::Keyframe {
                                offset: step.start_offset.percentage.0 as f64,
                                easing: Some(declared_easing.map_or(easing.clone(), |e| e.to_computed_value_without_context())),
                                composite: declared_composite.map(composite_of),
                                block: block.clone(),
                            })
                        })
                        .collect();
                    let timing = waapi::EffectTiming {
                        delay: to_milliseconds(ui.animation_delay_mod(i).seconds()),
                        duration: to_milliseconds(ui.animation_duration_mod(i).seconds()),
                        iterations: ui.animation_iteration_count_mod(i).0 as f64,
                        direction: match ui.animation_direction_mod(i) {
                            AnimationDirection::Normal => waapi::PlaybackDirection::Normal,
                            AnimationDirection::Reverse => waapi::PlaybackDirection::Reverse,
                            AnimationDirection::Alternate => waapi::PlaybackDirection::Alternate,
                            AnimationDirection::AlternateReverse => waapi::PlaybackDirection::AlternateReverse,
                        },
                        fill: match ui.animation_fill_mode_mod(i) {
                            AnimationFillMode::None => waapi::FillMode::None,
                            AnimationFillMode::Forwards => waapi::FillMode::Forwards,
                            AnimationFillMode::Backwards => waapi::FillMode::Backwards,
                            AnimationFillMode::Both => waapi::FillMode::Both,
                        },
                        ..waapi::EffectTiming::default()
                    };
                    Some(CssAnimationStyle {
                        name: name.to_string(),
                        timing,
                        keyframes,
                        implicit_easing: easing,
                        composite,
                        paused: ui.animation_play_state_mod(i) == AnimationPlayState::Paused,
                    })
                })
                .collect()
        })
    }

    // A rendering update's events: what each CSS animation and transition owes for where its phase moved (the model
    // queues them), in the order they were due, and those due together in composite order — transitions before
    // animations, then by owning element in tree order and pseudo-element, then a transition's style change and
    // property and an animation's place in `animation-name`.
    pub(crate) fn take_animation_events(&mut self, arena: &RealmArena) -> Vec<AnimationEvent> {
        let mut events = self.web_animations.take_css_events();
        if events.len() > 1 {
            let mut paths = std::collections::HashMap::new();
            for e in &events {
                paths.entry(e.owner.node).or_insert_with(|| tree_path(arena, e.owner.node));
            }
            // (Stable: one animation's events keep the order it queued them in.)
            let key = |e: &crate::css::CssEvent| to_microseconds(e.scheduled / 1000.0);
            events.sort_by(|a, b| {
                key(a).total_cmp(&key(b)).then_with(|| {
                    (!a.transition, &paths[&a.owner.node], waapi::pseudo_rank(&a.owner.pseudo), a.order, &a.name).cmp(&(
                        !b.transition,
                        &paths[&b.owner.node],
                        waapi::pseudo_rank(&b.owner.pseudo),
                        b.order,
                        &b.name,
                    ))
                })
            });
        }
        events
            .into_iter()
            .map(|e| AnimationEvent {
                kind: e.kind,
                node: e.owner.node,
                pseudo: e.owner.pseudo.as_ref().and_then(pseudo_name),
                name: e.name,
                elapsed: to_microseconds(e.elapsed),
                animation: e.animation,
            })
            .collect()
    }

    // Move the clock to `now_ms`: every element with an animation the time moves takes its values at it — as a frame
    // or an op moved them in the model (its timeline follows the page's clock).
    //
    // They move in an animation-only restyle, as Gecko's do: it cascades what they change to the descendants and
    // starts nothing, so a value a descendant inherits from an animation is already in its before-change style when
    // the next traversal compares — and a descendant transitioning the same property does not start a transition of
    // its own every frame.
    fn advance_to(&mut self, arena: &RealmArena, now_ms: f64) {
        self.clock = now_ms;
        self.web_animations.set_timeline_time(now_ms);
        let restyle = self.web_animations.take_targets_to_restyle();
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
            let guards = StylesheetGuards::same(&guard);
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

    // What `id`'s `::before` (0) or `::after` (1) renders as the document is styled now — the answer the walk lays out
    // (`walk::generated_text_of`): its text, or None where it generates no box.
    pub(crate) fn generated(&mut self, arena: &RealmArena, id: NodeId, which: usize, now_ms: f64) -> Option<Vec<u16>> {
        self.flush(arena, now_ms);
        crate::walk::generated_text_of(arena, id, which)
    }

    // Whether `id` is SHOWN, as the engine styled it: 0 where no box is — it has no style (an ancestor is `display:
    // none`, which styles none of its descendants, or no slot takes it into the flat tree) or its own `display` is
    // `none` — or where it is SKIPPED, an ancestor's `content-visibility: hidden` (`skips_contents`) keeping its contents from rendering (CSS Contain 2 §4: not painted, not hit, not found — Chrome and
    // Firefox answer `checkVisibility()` false); 1 where it is displayed and visible, 2 where it is displayed but its
    // `visibility` hides it. One question for what the JS cascade answered by matching the hide rules of every ancestor
    // (`isVisibleNodeImpl`).
    pub(crate) fn shown(&mut self, arena: &RealmArena, id: NodeId, now_ms: f64) -> u8 {
        self.flush(arena, now_ms);
        let Some(style) = primary_style(arena, id) else { return 0 };
        if style.get_box().clone_display().is_none() {
            return 0;
        }
        let skipped = in_arena(arena, self, || {
            let mut cur = TElement::traversal_parent(&StyleNode::new(arena, id));
            while let Some(p) = cur {
                if primary_style(arena, p.id).is_some_and(|s| skips_contents(&s)) {
                    return true;
                }
                cur = TElement::traversal_parent(&p);
            }
            false
        });
        if skipped {
            return 0;
        }
        if style.get_inherited_box().visibility == style::computed_values::visibility::T::Visible { 1 } else { 2 }
    }

    // `id`'s `transform` as the 4x4 its computed list composes to, about a reference box `width` x `height` (its border
    // box, which a percentage resolves against), in CSS `matrix3d()` order — at the engine's own precision, where the
    // value it serializes rounds every angle to six figures. None where it has no style; Some(None) for `none`.
    pub(crate) fn transform_matrix(
        &mut self,
        arena: &RealmArena,
        id: NodeId,
        width: f32,
        height: f32,
        now_ms: f64,
    ) -> Option<Option<[f64; 16]>> {
        use style::values::computed::Length;
        self.flush(arena, now_ms);
        let style = primary_style(arena, id).or_else(|| self.undisplayed_style(arena, id))?;
        let transform = &style.get_box().transform;
        if transform.0.is_empty() {
            return Some(None);
        }
        let reference = euclid::default::Rect::new(euclid::default::Point2D::origin(), euclid::default::Size2D::new(Length::new(width), Length::new(height)));
        Some(transform.to_transform_3d_matrix_f64(Some(&reference)).ok().map(|(m, _)| m.to_array()))
    }

    // Whether `id` SKIPS its contents (`skips_contents`), as the document is styled now — shown itself, and nothing under it.
    pub(crate) fn skips(&mut self, arena: &RealmArena, id: NodeId, now_ms: f64) -> bool {
        self.flush(arena, now_ms);
        primary_style(arena, id).is_some_and(|s| skips_contents(&s))
    }

    // The computed value of the longhand `name` on `id`, as `getComputedStyle` serializes a computed value; None for
    // a shorthand, an unknown property, or an element not in the document.
    pub(crate) fn value(
        &mut self,
        arena: &RealmArena,
        id: NodeId,
        name: &str,
        pseudo: Option<&str>,
        now_ms: f64,
    ) -> Option<String> {
        self.flush(arena, now_ms);
        let primary = primary_style(arena, id).or_else(|| self.undisplayed_style(arena, id))?;
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
    set(ElementState::SERVO_LIST_BOX, arena.is_list_box(id));
    set(ElementState::SERVO_NONZERO_BORDER, arena.has_nonzero_border(id));
    let rtl = arena.is_rtl(id);
    set(ElementState::RTL, rtl);
    set(ElementState::LTR, !rtl);
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
// animation's name or the transition's property, its `elapsedTime` in seconds, and the animation it is about.
pub(crate) struct AnimationEvent {
    pub(crate) kind: &'static str,
    pub(crate) node: NodeId,
    pub(crate) pseudo: Option<&'static str>,
    pub(crate) name: String,
    pub(crate) elapsed: f64,
    pub(crate) animation: waapi::AnimationId,
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

// A time in seconds as an event reports it: to the microsecond a page's clock is kept in, which drops the tail the
// arithmetic of it leaves.
fn to_microseconds(seconds: f64) -> f64 {
    (seconds * 1e6).round() / 1e6
}

// A time of a style (seconds, single precision) in the model's milliseconds — to the microsecond, without the tail.
fn to_milliseconds(seconds: f32) -> f64 {
    (seconds as f64 * 1e6).round() / 1e3
}

// What the traversal left the engine to do for an element (or one of its pseudo-elements) once it is over
// (`StyleNode::update_animations`): which of its animations to update, and the styles a transition goes between.
struct AnimationTask {
    node: NodeId,
    pseudo: Option<PseudoElement>,
    before_change_style: Option<Arc<ComputedValues>>,
    after_change_style: Option<Arc<ComputedValues>>,
    tasks: UpdateAnimationsTasks,
}

// The properties the after-change style's `transition-property` lists (physical, the last item naming each deciding
// its duration, delay, timing function and behavior), and what the style change did to each (css-transitions-1 §3):
// its values before and after — asked only where the change can have moved it or the element transitions it already
// (`transitioning`), for `transition: all` names every property there is.
fn transition_changes(
    before: &ComputedValues,
    after: &ComputedValues,
    transitioning: &[OwnedPropertyDeclarationId],
) -> (Vec<OwnedPropertyDeclarationId>, Vec<TransitionChange>) {
    let ui = after.get_ui();
    let mut items: Vec<_> = after.transition_properties().collect();
    items.reverse();
    let mut listed: Vec<OwnedPropertyDeclarationId> = Vec::new();
    let mut changes: Vec<TransitionChange> = Vec::new();
    for item in items {
        let property = item.property.as_borrowed().to_physical(after.writing_mode);
        if listed.iter().any(|p| p.as_borrowed() == property) {
            continue;
        }
        listed.push(property.to_owned());
        if AnimationValue::same_in(property, before, after) && !transitioning.iter().any(|p| p.as_borrowed() == property)
        {
            continue;
        }
        let (Some(from), Some(to)) =
            (AnimationValue::from_computed_values(property, before), AnimationValue::from_computed_values(property, after))
        else {
            continue;
        };
        let i = item.index;
        let allow_discrete = ui.transition_behavior_mod(i) == TransitionBehavior::AllowDiscrete;
        changes.push(TransitionChange {
            property: property.to_owned(),
            before: from,
            after: to,
            // (A custom property's values say whether they interpolate: a registered one's do, per its syntax.)
            animatable: property.is_animatable()
                && (allow_discrete
                    || matches!(property, PropertyDeclarationId::Custom(_))
                    || !property.is_discrete_animatable()),
            allow_discrete,
            duration: to_milliseconds(ui.transition_duration_mod(i).seconds()),
            delay: to_milliseconds(ui.transition_delay_mod(i).seconds()),
            easing: ui.transition_timing_function_mod(i),
        });
    }
    (listed, changes)
}

// Whether a keyframe's declaration computes from anything beyond its element's own style and rules: its parent
// (`inherit`, `unset`, `revert`), the root's font or line (`rem`, `rlh`), the viewport or a container (their units), an
// attribute, an environment variable, an anchor or its place among its siblings.
fn refers_beyond_the_style(declaration: &style::properties::PropertyDeclaration) -> bool {
    fn scan(input: &mut Parser) -> bool {
        use cssparser::Token;
        while let Ok(token) = input.next_including_whitespace_and_comments() {
            let found = match token {
                Token::Ident(ident) => ["inherit", "unset", "revert", "revert-layer"].iter().any(|k| ident.eq_ignore_ascii_case(k)),
                Token::Dimension { unit, .. } => {
                    let unit = unit.to_ascii_lowercase();
                    unit == "rem" || unit == "rlh" || unit.starts_with("cq") || ["vw", "vh", "vi", "vb", "vmin", "vmax"].iter().any(|v| unit.ends_with(v))
                },
                Token::Function(name) => {
                    let name = name.to_ascii_lowercase();
                    ["attr", "env", "anchor", "anchor-size", "sibling-index", "sibling-count"].contains(&name.as_str())
                },
                _ => false,
            };
            let nested = matches!(
                token,
                Token::Function(_) | Token::ParenthesisBlock | Token::SquareBracketBlock | Token::CurlyBracketBlock
            );
            if found || (nested && input.parse_nested_block(|block| Ok::<_, cssparser::ParseError<()>>(scan(block))).unwrap_or(true)) {
                return true;
            }
        }
        false
    }
    let mut text = String::new();
    if declaration.to_css(&mut text).is_err() {
        return true;
    }
    let mut input = ParserInput::new(&text);
    scan(&mut Parser::new(&mut input))
}

// The names a declaration answers to: its property's, and those of the shorthands it is part of.
fn names_of(id: PropertyDeclarationId<'_>) -> impl Iterator<Item = std::borrow::Cow<'_, str>> {
    let shorthands = match id {
        PropertyDeclarationId::Longhand(l) => Some(l.shorthands().map(|s| s.name().into())),
        PropertyDeclarationId::Custom(_) => None,
    };
    std::iter::once(id.name()).chain(shorthands.into_iter().flatten())
}

// Whether node `a` comes before node `b` in shadow-including tree order.
fn tree_order(arena: &RealmArena, a: NodeId, b: NodeId) -> std::cmp::Ordering {
    tree_path(arena, a).cmp(&tree_path(arena, b))
}

// The style an effect's target has: its element's, or the pseudo-element's the traversal made for it.
fn target_style(arena: &RealmArena, target: &waapi::Target) -> Option<Arc<ComputedValues>> {
    let Some(pseudo) = &target.pseudo else { return primary_style(arena, target.node) };
    let slot = arena.style_slot(target.node)?;
    // SAFETY: no traversal runs while a style is read.
    let data = unsafe { &*slot.data.get() }.as_ref()?.borrow();
    data.styles.pseudos.get(pseudo).cloned()
}

// The style an effect's target has where it is rendered: neither it nor — a pseudo-element's — its originating element
// `display: none` (whose pseudo-elements generate no box, whatever styles they were last given).
fn rendered_style(arena: &RealmArena, target: &waapi::Target) -> Option<Arc<ComputedValues>> {
    is_rendered(arena, target).then(|| target_style(arena, target)).flatten()
}

// …asked without taking the style, as a sweep over every completed transition asks it on every flush.
fn is_rendered(arena: &RealmArena, target: &waapi::Target) -> bool {
    let Some(slot) = arena.style_slot(target.node) else { return false };
    // SAFETY: no traversal runs while a style is read.
    let Some(data) = unsafe { &*slot.data.get() }.as_ref() else { return false };
    let data = data.borrow();
    let shown = |style: &ComputedValues| !style.get_box().clone_display().is_none();
    match (&target.pseudo, data.styles.get_primary()) {
        (_, None) => false,
        (None, Some(primary)) => shown(primary),
        (Some(pseudo), Some(primary)) => shown(primary) && data.styles.pseudos.get(pseudo).is_some_and(|s| shown(s)),
    }
}

// An `animation-composition` as the model composites.
fn composite_of(composition: AnimationComposition) -> waapi::CompositeOperation {
    match composition {
        AnimationComposition::Replace => waapi::CompositeOperation::Replace,
        AnimationComposition::Add => waapi::CompositeOperation::Add,
        AnimationComposition::Accumulate => waapi::CompositeOperation::Accumulate,
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
pub(crate) fn primary_style(arena: &RealmArena, id: NodeId) -> Option<Arc<ComputedValues>> {
    let slot = arena.style_slot(id)?;
    // SAFETY: no traversal runs while a style is read.
    let data = unsafe { &*slot.data.get() }.as_ref()?.borrow();
    data.styles.get_primary().cloned()
}
// …and the style it gave `id`'s EAGER pseudo-element `pseudo` (`::before`, `::after`, …), where it made one.
// Whether a box of `style` skips its contents: `content-visibility: hidden` (a `hidden=until-found`'s, in the UA sheet) on
// a box that can take size containment, which is what `content-visibility` applies to (CSS Contain 2 §3.1) — not one
// with no principal box, a non-atomic inline (a `ruby` container among them), a table, or an internal table or ruby box:
// a hidden `<span>`, `<tr>`, `<td>` or `<rt>` skips nothing, as Firefox shows.
fn skips_contents(style: &ComputedValues) -> bool {
    use style::computed_values::content_visibility::T as ContentVisibility;
    use style::values::specified::box_::{DisplayInside, DisplayOutside};
    let d = style.get_box().clone_display();
    style.get_box().content_visibility == ContentVisibility::Hidden
        && !d.is_contents()
        && !matches!(d.outside(), DisplayOutside::InternalTable | DisplayOutside::InternalRuby)
        && !matches!(d.inside(), DisplayInside::Table)
        && !(matches!(d.outside(), DisplayOutside::Inline) && matches!(d.inside(), DisplayInside::Flow | DisplayInside::Ruby))
}

pub(crate) fn eager_pseudo(arena: &RealmArena, id: NodeId, pseudo: &PseudoElement) -> Option<Arc<ComputedValues>> {
    let slot = arena.style_slot(id)?;
    // SAFETY: as above.
    let data = unsafe { &*slot.data.get() }.as_ref()?.borrow();
    data.styles.pseudos.get(pseudo).cloned()
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

// The generated boxes a layout walk lays out, whose values a restyle replacing is a change to it.
const PSEUDOS_GENERATED: [PseudoElement; 2] = [PseudoElement::Before, PseudoElement::After];
fn pseudo_ptr(data: &style::data::ElementData, pseudo: &PseudoElement) -> Option<std::ptr::NonNull<()>> {
    data.styles.pseudos.get(pseudo).map(Arc::raw_ptr)
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
            // (…an element whose values the restyle REPLACED — its own, or its `::before` / `::after` box's — is a change a
            // layout walk reads, stamped as a DOM write is, and one the JS side's memos hear of: `note_restyled`)
            let styles_of = |data: &style::data::ElementData| {
                [data.styles.get_primary().map(Arc::raw_ptr), pseudo_ptr(data, &PSEUDOS_GENERATED[0]), pseudo_ptr(data, &PSEUDOS_GENERATED[1])]
            };
            let before = styles_of(&data);
            recalc_style_at(self, traversal_data, context, el, &mut data, note_child);
            if styles_of(&data) != before {
                el.arena().note_restyled(el.id);
            }
            if self.context.traversal_flags.for_animation_only() {
                unsafe { el.unset_animation_only_dirty_descendants() };
            } else {
                let slot = el.slot();
                slot.styled_state.set(el.state());
                if slot.selector_flags.get().contains(ElementSelectorFlags::HAS_EMPTY_SELECTOR) {
                    slot.styled_empty.set(Some(el.arena().is_empty(el.id)));
                }
                unsafe { el.unset_dirty_descendants() };
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
    // What the model's animations of this element (or its `pseudo`) show now, as a rule; None where none animates it.
    fn composed_animations(
        &self,
        pseudo: Option<PseudoElement>,
        origin: waapi::AnimationOrigin,
    ) -> Option<Arc<Locked<PropertyDeclarationBlock>>> {
        let model = &self.engine().web_animations;
        if !model.animates(self.id) {
            return None;
        }
        let mut values = Default::default();
        let arena = self.arena();
        let target = waapi::Target { node: self.id, pseudo };
        model.compose(&target, origin, &mut values, &|a, b| tree_order(arena, a, b));
        if values.is_empty() {
            return None;
        }
        Some(Arc::new(self.engine().lock.wrap(PropertyDeclarationBlock::from_animation_value_map(&values))))
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
            // (…a direction other than `ltr` / `rtl` is valid and matches nothing: its state is empty)
            NonTSPseudoClass::Dir(dir) => !dir.element_state().is_empty() && self.state().intersects(dir.element_state()),
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
            NonTSPseudoClass::ServoListBox => arena.is_list_box(id),
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
            => false,
            NonTSPseudoClass::ServoNonZeroBorder => arena.has_nonzero_border(id),
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
    // (…the model's included: an element one animates shares no style with its siblings.)
    // (…the model's: an element one animates shares no style with its siblings.)
    fn has_animations(&self, _context: &SharedStyleContext) -> bool {
        self.engine().web_animations.animates(self.id)
    }
    // The CSS animations and transitions run in the model (`update_animations`), as Gecko's do.
    fn runs_css_animations(&self) -> bool {
        true
    }
    // (Run after the traversal: `StyleEngine::update_animations`.)
    fn update_animations(
        &self,
        pseudo: Option<PseudoElement>,
        before_change_style: Option<Arc<ComputedValues>>,
        after_change_style: Option<Arc<ComputedValues>>,
        tasks: UpdateAnimationsTasks,
    ) {
        let task = AnimationTask { node: self.id, pseudo, before_change_style, after_change_style, tasks };
        self.engine().animation_tasks.borrow_mut().push(task);
    }
    fn has_css_animations(&self, _context: &SharedStyleContext, pseudo: Option<PseudoElement>) -> bool {
        self.engine().web_animations.has_css_animations(&waapi::Target { node: self.id, pseudo })
    }
    fn has_css_transitions(&self, _context: &SharedStyleContext, pseudo: Option<PseudoElement>) -> bool {
        self.engine().web_animations.has_css_transitions(&waapi::Target { node: self.id, pseudo })
    }
    // Its animations' values, composited in composite order (web-animations §5.4.2): its CSS transitions in the
    // transitions origin, every other in the animations origin.
    fn animation_rule(&self, _context: &SharedStyleContext) -> Option<Arc<Locked<PropertyDeclarationBlock>>> {
        self.composed_animations(None, waapi::AnimationOrigin::Animations)
    }
    fn transition_rule(&self, _context: &SharedStyleContext) -> Option<Arc<Locked<PropertyDeclarationBlock>>> {
        self.composed_animations(None, waapi::AnimationOrigin::Transitions)
    }
    fn pseudo_animation_declarations(&self, _context: &SharedStyleContext, pseudo: &PseudoElement) -> AnimationDeclarations {
        AnimationDeclarations {
            animations: self.composed_animations(Some(pseudo.clone()), waapi::AnimationOrigin::Animations),
            transitions: self.composed_animations(Some(pseudo.clone()), waapi::AnimationOrigin::Transitions),
        }
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
        crate::hints::picture_hints(self.arena(), self.id, &|media| engine.media_matches(media), &mut list);
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

    // A `:has()` inside a `:host()` is found, and one beside it (or a `:host` with no argument) is not.
    #[test]
    fn a_host_condition_reading_descendants_is_found_in_the_text() {
        assert!(host_reads_descendants(":host(:has(.f)) p { margin: 1px }"));
        assert!(host_reads_descendants("p {} :HOST(.x:HAS(> b)) { color: red }"));
        assert!(!host_reads_descendants(":host(.x) p { color: red } .a:has(.b) { color: red }"));
        assert!(!host_reads_descendants(":host p:has(b) { color: red }"));
        assert!(!host_reads_descendants(":host(.x) p:has(b) { color: red }"));
        assert!(host_reads_descendants(":host(:is(.a, .b):has(i)) p { color: red }"));
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
