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
use style::properties::{
    parse_property_declaration_list, parse_style_attribute, ComputedValues, LonghandId, PropertyDeclarationBlock,
    PropertyDeclarationId, PropertyId, ShorthandId,
};
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
use style::author_styles::AuthorStyles;
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
    // The presentational hints its own attributes give it, parsed on first read after any of them changes.
    hints: OnceCell<Option<Arc<Locked<PropertyDeclarationBlock>>>>,
    data: UnsafeCell<Option<ElementDataWrapper>>,
    dirty_descendants: Cell<bool>,
    handled_snapshot: Cell<bool>,
    selector_flags: Cell<ElementSelectorFlags>,
    // Its state bits (`element_state`) and the arena `mutations` they were derived at…
    state: Cell<(u64, ElementState)>,
    // …and the bits its computed style was matched with, which a restyle compares the current ones against.
    styled_state: Cell<ElementState>,
    // Whether the engine holds a snapshot of it from before a change (`StyleEngine::snapshots`).
    has_snapshot: Cell<bool>,
}

impl Default for StyleSlot {
    fn default() -> Self {
        StyleSlot {
            id: None,
            style_attr: OnceCell::new(),
            hints: OnceCell::new(),
            data: UnsafeCell::new(None),
            dirty_descendants: Cell::new(false),
            handled_snapshot: Cell::new(false),
            selector_flags: Cell::new(ElementSelectorFlags::empty()),
            state: Cell::new((u64::MAX, ElementState::empty())),
            styled_state: Cell::new(ElementState::empty()),
            has_snapshot: Cell::new(false),
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
        if name.is_none_or(|n| n != "style" && n != "class") {
            self.hints = OnceCell::new();
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
    // Everything is styled again next time: the sheets changed, or a change reached a `:has()`.
    restyle_all: bool,
    // Each shadow root's own sheets (its `<style>` elements and adopted sheets), and whether they changed since
    // their cascade data was built.
    shadow_styles: std::collections::HashMap<NodeId, ShadowStyles>,
    // CSIM_STYLE_VERIFY: every restyle that styled only what the changes reached is held against styling everything,
    // and each element whose values differ is reported here (`take_verify_failures`).
    verify: bool,
    verify_failures: Vec<String>,
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
            snapshots: SnapshotMap::new(),
            restyle_all: true,
            shadow_styles: Default::default(),
            verify: std::env::var_os("CSIM_STYLE_VERIFY").is_some_and(|v| v != "0"),
            verify_failures: Vec::new(),
        };
        let ua = engine.parse(UA_SHEET, engine.url.clone(), "", Origin::UserAgent, AllowImportRules::No);
        engine.stylist.append_stylesheet(ua, &engine.lock.read());
        if quirks == QuirksMode::Quirks {
            let sheet = engine.parse(UA_QUIRKS_SHEET, engine.url.clone(), "", Origin::UserAgent, AllowImportRules::No);
            engine.stylist.append_stylesheet(sheet, &engine.lock.read());
        }
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

    fn parse(&self, css: &str, url: UrlExtraData, media: &str, origin: Origin, imports: AllowImportRules) -> DocumentStyleSheet {
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
            imports,
        );
        DocumentStyleSheet(Arc::new(sheet))
    }

    // `source` parsed as an author sheet.
    fn parse_source(&self, source: &SheetSource) -> DocumentStyleSheet {
        let url = url::Url::parse(&source.base).map(UrlExtraData::from).unwrap_or_else(|_| self.url.clone());
        let imports = if source.constructed { AllowImportRules::No } else { AllowImportRules::Yes };
        self.parse(&source.css, url, &source.media, Origin::Author, imports)
    }

    // The declarations `css` as the user agent writes them (its internal keywords allowed), for the hint level.
    fn hint_block(&self, css: &str) -> Arc<Locked<PropertyDeclarationBlock>> {
        let context = ParserContext::new(
            Origin::UserAgent,
            &self.url,
            Some(CssRuleType::Style),
            ParsingMode::DEFAULT,
            self.quirks,
            Default::default(),
            None,
            None,
            Default::default(),
        );
        let mut input = ParserInput::new(css);
        let block = parse_property_declaration_list(&context, &mut Parser::new(&mut input), &[]);
        Arc::new(self.lock.wrap(block))
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
        self.doc = Some(doc);
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
        self.restyle_all = true;
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
        style::thread_state::enter(style::thread_state::ThreadState::LAYOUT);
        {
            let guard = self.lock.read();
            self.stylist.flush(&StylesheetGuards { author: &guard, ua_or_user: &guard });
            self.shadow_styles.retain(|&root, _| arena.get(root).is_some());
            for shadow in self.shadow_styles.values_mut().filter(|s| s.dirty) {
                shadow.styles.flush(&mut self.stylist, &guard);
                shadow.dirty = false;
            }
        }
        self.snapshot_moved_states(arena);
        let restyle_all = std::mem::take(&mut self.restyle_all);
        self.traverse(arena, doc, restyle_all);
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
        style::thread_state::exit(style::thread_state::ThreadState::LAYOUT);
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
        self.traverse(arena, doc, true);
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
    fn traverse(&self, arena: &RealmArena, doc: NodeId, restyle_all: bool) {
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
                traversal_flags: TraversalFlags::empty(),
                stylist: &engine.stylist,
                options: GLOBAL_STYLE_DATA.options.clone(),
                guards,
                visited_styles_enabled: false,
                animations: Default::default(),
                current_time_for_animations: 0.0,
                snapshot_map: &engine.snapshots,
                registered_speculative_painters: &NoPainters,
            };
            let token = Recalc::pre_traverse(root, &context);
            if token.should_traverse() {
                style::driver::traverse_dom(&Recalc { context }, token, None);
            }
        });
    }

    // A styled element whose state bits moved since its style was matched is held against its old bits.
    fn snapshot_moved_states(&mut self, arena: &RealmArena) {
        let this: *const StyleEngine = self;
        let snapshots = &mut self.snapshots;
        in_arena(arena, this, || {
            for id in arena.element_ids() {
                let Some(slot) = arena.style_slot(id) else { continue };
                if unsafe { &*slot.data.get() }.is_none() {
                    continue;
                }
                let el = StyleNode::new(arena, id);
                let before = slot.styled_state.get();
                if el.state() == before {
                    continue;
                }
                snapshots.entry(TNode::opaque(&el)).or_default().state.get_or_insert(before);
                slot.has_snapshot.set(true);
                mark_ancestors_dirty(el);
            }
        });
    }

    // The attribute `name` of `id` is about to change (None: any of them may): the element is snapshotted as it
    // stands, the level its change lands on is hinted (a `style` attribute re-cascades that one block, any other may
    // be a presentational hint), and a language or direction reaches its whole subtree.
    pub(crate) fn attribute_will_change(&mut self, arena: &RealmArena, id: NodeId, name: Option<&str>) {
        let Some(node) = arena.get(id) else { return };
        let Some(slot) = arena.style_slot(id) else { return };
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
            match name {
                Some(n) => snapshot.changed_attrs.push(LocalName::from(n)),
                None => snapshot.changed_attrs.extend(node.attributes.iter().map(|(k, _)| LocalName::from(k.as_str()))),
            }
            snapshot.id_changed |= name.is_none_or(|n| n == "id");
            snapshot.class_changed |= name.is_none_or(|n| n == "class");
            snapshot.other_attributes_changed |= name.is_none_or(|n| n != "id" && n != "class");
            slot.has_snapshot.set(true);
            slot.handled_snapshot.set(false);
            mark_ancestors_dirty(el);
            let hint = match name {
                Some("style") => RestyleHint::RESTYLE_STYLE_ATTRIBUTE,
                // …a language or a direction inherits, and `exportparts` decides which of a shadow tree's parts an
                // outer tree's `::part()` reaches.
                Some("lang" | "dir" | "xml:lang" | "exportparts") | None => RestyleHint::restyle_subtree(),
                Some("class" | "id") => RestyleHint::empty(),
                Some(_) => RestyleHint::RESTYLE_SELF,
            };
            hint_element(el, hint);
        });
        self.restyle_all |= self.uses_has();
    }

    // `parent`'s children changed (an insertion, a removal, a text node's data): what its children's selectors
    // depend on is in the flags matching left on it — a structural pseudo-class or a sibling combinator somewhere
    // restyles the children, an edge-child one the edges, `:empty` the parent itself. `arrived` are the children
    // that came in from elsewhere, which carry the style of where they were.
    pub(crate) fn children_changed(&mut self, arena: &RealmArena, parent: NodeId, arrived: &[NodeId]) {
        in_arena(arena, self, || {
            for &c in arrived {
                if arena.style_slot(c).is_some_and(|s| unsafe { &*s.data.get() }.is_some()) {
                    hint_element(StyleNode::new(arena, c), RestyleHint::restyle_subtree());
                }
            }
            let Some(slot) = arena.style_slot(parent) else { return };
            if unsafe { &*slot.data.get() }.is_none() {
                return;
            }
            let p = StyleNode::new(arena, parent);
            let flags = slot.selector_flags.get();
            let mut hint = RestyleHint::empty();
            if flags.intersects(
                ElementSelectorFlags::HAS_SLOW_SELECTOR
                    | ElementSelectorFlags::HAS_SLOW_SELECTOR_LATER_SIBLINGS
                    | ElementSelectorFlags::HAS_SLOW_SELECTOR_NTH
                    | ElementSelectorFlags::HAS_SLOW_SELECTOR_NTH_OF
                    | ElementSelectorFlags::HAS_EDGE_CHILD_SELECTOR,
            ) {
                hint |= RestyleHint::RESTYLE_DESCENDANTS;
            }
            if flags.contains(ElementSelectorFlags::HAS_EMPTY_SELECTOR) {
                hint |= RestyleHint::RESTYLE_SELF;
            }
            hint_element(p, hint);
            // …and a child that has never been styled is styled when its parent is next visited.
            mark_ancestors_dirty(p);
            unsafe { p.set_dirty_descendants() };
        });
        self.restyle_all |= self.uses_has();
    }

    // `id` gained or lost a custom state (`:state()`), which no snapshot records: it and everything a combinator can
    // reach from it — its parent's children — are styled again.
    pub(crate) fn custom_states_changed(&mut self, arena: &RealmArena, id: NodeId) {
        in_arena(arena, self, || {
            let el = StyleNode::new(arena, id);
            match TElement::traversal_parent(&el) {
                Some(p) => hint_element(p, RestyleHint::restyle_subtree()),
                None => hint_element(el, RestyleHint::restyle_subtree()),
            }
        });
    }

    // `slot`'s assigned nodes went from `old` to `now`: its flat-tree children changed, and each node that came or
    // went carries the style of where it was.
    pub(crate) fn slot_assignment_changed(&mut self, arena: &RealmArena, slot: NodeId, old: &[NodeId], now: &[NodeId]) {
        in_arena(arena, self, || {
            for &n in old.iter().chain(now) {
                if arena.style_slot(n).is_some_and(|s| unsafe { &*s.data.get() }.is_some()) {
                    hint_element(StyleNode::new(arena, n), RestyleHint::restyle_subtree());
                }
            }
            if arena.style_slot(slot).is_some() {
                let s = StyleNode::new(arena, slot);
                hint_element(s, RestyleHint::restyle_subtree());
                unsafe { s.set_dirty_descendants() };
            }
        });
        self.restyle_all |= self.uses_has();
    }

    // Does any sheet have a `:has()`? Its invalidation is not done yet, so a change anywhere restyles everything.
    fn uses_has(&self) -> bool {
        self.stylist.iter_origins().any(|(data, _)| data.relative_selector_invalidation_map().len() != 0)
    }

    // The computed value of the longhand `name` on `id`, as `getComputedStyle` serializes a computed value; None for
    // a shorthand, an unknown property, or an element the document's traversal did not style.
    pub(crate) fn value(&mut self, arena: &RealmArena, id: NodeId, name: &str) -> Option<String> {
        self.ensure_styled(arena);
        let slot = arena.style_slot(id)?;
        // SAFETY: no traversal runs while the value is read.
        let data = unsafe { &*slot.data.get() }.as_ref()?.borrow();
        let style = data.styles.get_primary()?;
        let property = PropertyId::parse_enabled_for_all_content(name).ok()?;
        let longhand = match property.as_shorthand() {
            Ok(_) => return None,
            Err(longhand) => longhand,
        };
        let value = style.computed_value_to_string(longhand);
        Some(match longhand {
            // CSSOM's resolved value of an automatic minimum size: the keyword on a flex or grid item, whose layout
            // gives it meaning, and zero on anything else.
            PropertyDeclarationId::Longhand(
                LonghandId::MinWidth | LonghandId::MinHeight | LonghandId::MinInlineSize | LonghandId::MinBlockSize,
            ) if value == "auto" => {
                let parent = in_arena(arena, self, || TElement::traversal_parent(&StyleNode::new(arena, id)).map(|p| p.id));
                if is_flex_or_grid_item(style, parent.and_then(|p| primary_style(arena, p))) {
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

// The node an `OpaqueNode` stands for (`opaque_bits`).
fn node_of(bits: usize) -> NodeId {
    let bits = bits - 1;
    NodeId { idx: bits as u32, generation: (bits >> 32) as u32 }
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
            el.slot().styled_state.set(el.state());
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
        let parsed = self.slot().style_attr.get_or_init(|| {
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
        let own = self.slot().hints.get_or_init(|| {
            let mut css = String::new();
            crate::hints::own_hints(self.node(), &mut css);
            (!css.is_empty()).then(|| engine.hint_block(&css))
        });
        if let Some(block) = own {
            push(block.clone());
        }
        let mut css = String::new();
        crate::hints::cell_hints(self.arena(), self.id, &mut css);
        if !css.is_empty() {
            push(engine.hint_block(&css));
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
        let engine = StyleEngine::new(QuirksMode::NoQuirks, (800.0, 600.0), UrlExtraData::from(url::Url::parse("about:blank").unwrap()));
        for (tag, attrs) in cases {
            let mut node = NodeData::of_kind(NodeKind::Element, Vec::new());
            node.local_name = web_atoms::LocalName::from(*tag);
            node.ns = ns!(html);
            node.attributes = attrs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            let mut css = String::new();
            crate::hints::own_hints(&node, &mut css);
            assert!(!css.is_empty(), "<{tag}> gave no hint");
            let errors = Errors(RefCell::new(Vec::new()));
            let context = ParserContext::new(
                Origin::UserAgent,
                &engine.url,
                Some(CssRuleType::Style),
                ParsingMode::DEFAULT,
                QuirksMode::NoQuirks,
                Default::default(),
                Some(&errors),
                None,
                Default::default(),
            );
            let mut input = ParserInput::new(&css);
            parse_property_declaration_list(&context, &mut Parser::new(&mut input), &[]);
            assert_eq!(errors.0.into_inner(), Vec::<String>::new(), "<{tag}>: {css}");
        }
    }
}
