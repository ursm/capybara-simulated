// A realm's style sheets, as the style engine parses them: every `<style>` / `<link>` sheet and constructed sheet the
// page has, each by the id the page side names it with, parsed under the realm's lock (`RealmArena::style_lock`) —
// what the engine cascades (`StyleEngine::set_sheets`, `set_shadow_sheets`) and what CSSOM reads and writes. A sheet is
// made once and parsed again only when the page gives it other text; the `@import`s its parse met wait here for the
// page to fetch them (`import`).

use std::cell::RefCell;

use cssparser::{Parser, ParserInput, SourceLocation};
use style::context::QuirksMode;
use style::media_queries::MediaList;
use style::parser::ParserContext;
use style::servo_arc::Arc;
use style::shared_lock::{Locked, SharedRwLock};
use style::stylesheets::import_rule::{ImportLayer, ImportSheet, ImportSupportsCondition};
use style::stylesheets::keyframes_rule::Keyframe;
use style::stylesheets::{
    AllowImportRules, CssRule, CssRuleType, CssRuleTypes, DocumentStyleSheet, ImportRule, Origin, Stylesheet,
    StylesheetLoader, UrlExtraData,
};
use style::values::CssUrl;
use style_traits::ParsingMode;

// A sheet as the page hands it over: its text, the base URL its `url()`s resolve against, the media list it applies
// under, and whether it is a constructed sheet (`new CSSStyleSheet()`), whose `@import`s are ignored.
pub(crate) struct SheetSource {
    pub(crate) css: String,
    pub(crate) base: String,
    pub(crate) media: String,
    pub(crate) constructed: bool,
}

// A sheet of the realm's, and what the engine asks of its text without walking its rules: whether it could paint an
// image (`css_image`) and whether it reads a shadow host's light descendants (`host_reads_descendants`). Its `version`
// moves when it is made of other text, so a CSSOM rule list of the one before is known for one of another sheet.
pub(crate) struct StoredSheet {
    pub(crate) sheet: DocumentStyleSheet,
    pub(crate) css_image: bool,
    pub(crate) host_has: bool,
    pub(crate) version: u32,
    // A constructed sheet (`new CSSStyleSheet()`), which takes no `@import`.
    pub(crate) constructed: bool,
    // An `@import`ed sheet CSSOM reached (`adopt`): one the engine cascades through the sheet importing it.
    pub(crate) imported: bool,
    // The parse is the store's kept one (`parsed`), which other sheets of the same text share: CSSOM takes a copy of
    // its own before it reaches a rule (`own`).
    shared: bool,
}

// A rule a CSSOM object names (cssom_rule.rs): one of a sheet's rules — the engine's own, its `Arc`s cloned in, so it
// is the rule the engine cascades and stays readable once removed — or a keyframe of a `@keyframes`, and the id of the
// sheet it was found in (whose namespaces a selector is read under).
#[derive(Clone)]
pub(crate) enum Rule {
    Css(CssRule),
    Keyframe(Arc<Locked<Keyframe>>),
}
pub(crate) struct RuleRef {
    pub(crate) sheet: u32,
    pub(crate) rule: Rule,
    // The types of the rules it is inside: what a rule inserted into it may be, and — inside a style rule (nesting) —
    // that a selector it is given is relative to its parent's.
    pub(crate) containing: CssRuleTypes,
}

#[derive(Default)]
pub(crate) struct SheetStore {
    // By id — never one used before, so an id the page side kept past a reset (or a drop) names no other sheet.
    sheets: std::collections::HashMap<u32, StoredSheet>,
    next_id: u32,
    // The rules CSSOM objects name, by handle — never one used before, as a sheet's id — until the object goes.
    rules: std::collections::HashMap<u32, RuleRef>,
    next_rule: u32,
    pending: RefCell<Vec<PendingImport>>,
    // The URLs of the `@import`ed sheets whose text could paint an image (`css_image`), as each last arrived.
    image_imports: std::collections::HashSet<String>,
    // Each parse made, by what it was made of — kept across the realm's pages (a suite loads its app's sheets on every
    // page) and SHARED by every sheet of the same text until CSSOM reaches one, which then takes a copy of its own
    // (`own`): an edit is its owner's alone. (Not one with an `@import`, whose imports are fetched for the parse that
    // asked for them.)
    parsed: std::collections::HashMap<ParseKey, DocumentStyleSheet>,
}

#[derive(PartialEq, Eq, Hash)]
struct ParseKey {
    css_hash: u64,
    css_len: usize,
    base: String,
    media: String,
    constructed: bool,
    quirks: bool,
}
const PARSED_LIMIT: usize = 64;

// An `@import` whose sheet has not arrived: the rule, the absolute URL it asked for, and the media list its sheet
// will be made with.
struct PendingImport {
    url: String,
    rule: Arc<Locked<ImportRule>>,
    media: Arc<Locked<MediaList>>,
    // The URLs of the sheets that import it, outermost first: one already among them is a cycle.
    chain: Vec<String>,
}

// What a sheet's `@import`s ask while it is parsed: each is answered with a PENDING rule and noted, and the page
// supplies the sheet by its URL (`SheetStore::import`) — or REFUSED, when the sheet being parsed is among the ones
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

impl SheetStore {
    pub(crate) fn get(&self, id: u32) -> Option<&StoredSheet> {
        self.sheets.get(&id)
    }

    // A sheet the page did not make — an `@import`ed one CSSOM reaches (`CSSImportRule.styleSheet`) — given an id.
    pub(crate) fn adopt(&mut self, sheet: DocumentStyleSheet) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        let stored = StoredSheet { sheet, css_image: false, host_has: false, version: id, constructed: false, imported: true, shared: false };
        self.sheets.insert(id, stored);
        id
    }

    pub(crate) fn rule(&self, handle: u32) -> Option<&RuleRef> {
        self.rules.get(&handle)
    }

    // A handle on `rule` of the sheet `sheet`, for a CSSOM object.
    pub(crate) fn hand_out(&mut self, sheet: u32, rule: Rule, containing: CssRuleTypes) -> u32 {
        let handle = self.next_rule;
        self.next_rule += 1;
        self.rules.insert(handle, RuleRef { sheet, rule, containing });
        handle
    }

    // The CSSOM object naming `handle` is gone.
    pub(crate) fn drop_rule(&mut self, handle: u32) {
        self.rules.remove(&handle);
    }

    // What `@import`s a rule inserted into the sheet asked for (sheet's loader): the URLs, as `make` returns them.
    pub(crate) fn loader(&self, chain: Vec<String>) -> impl StylesheetLoader + '_ {
        Loader { pending: &self.pending, chain }
    }
    pub(crate) fn pending_count(&self) -> usize {
        self.pending.borrow().len()
    }
    pub(crate) fn waiting_after(&self, before: usize) -> Vec<String> {
        self.waiting_since(before)
    }

    // A new sheet of `source` (in a document of `quirks` mode): its id, and the URLs its `@import`s wait for.
    pub(crate) fn make(&mut self, lock: &SharedRwLock, source: &SheetSource, quirks: bool) -> (u32, Vec<String>) {
        let before = self.pending.borrow().len();
        let id = self.next_id;
        self.next_id += 1;
        let stored = self.parse(lock, source, quirks, id);
        self.sheets.insert(id, stored);
        (id, self.waiting_since(before))
    }

    // The sheet `id` made of `source` instead: the URLs its `@import`s wait for. (A new `Stylesheet`, so the engine,
    // which keeps a sheet by identity, takes it as the new sheet it is.)
    pub(crate) fn replace(&mut self, lock: &SharedRwLock, id: u32, source: &SheetSource, quirks: bool) -> Vec<String> {
        let before = self.pending.borrow().len();
        let version = self.next_id;
        self.next_id += 1;
        let stored = self.parse(lock, source, quirks, version);
        if let Some(sheet) = self.sheets.get_mut(&id) {
            *sheet = stored;
        }
        self.waiting_since(before)
    }

    // The sheet `id` applies under `media` now — the same sheet, its rules (and the CSSOM objects naming them) kept.
    pub(crate) fn set_media(&mut self, lock: &SharedRwLock, id: u32, media: &str, quirks: bool) {
        let Some(stored) = self.sheets.get(&id) else { return };
        let url = stored.sheet.0.contents.read_with(&lock.read()).url_data.clone();
        let list = media_list(media, &url, mode(quirks));
        *stored.sheet.0.media.write_with(&mut lock.write()) = list;
    }

    // The page has let go of the sheet `id`.
    pub(crate) fn drop_sheet(&mut self, id: u32) {
        self.sheets.remove(&id);
    }

    // The realm's page was replaced: none of its sheets is the next page's (and none of their ids will be).
    pub(crate) fn reset(&mut self) {
        self.sheets.clear();
        self.rules.clear();
        self.pending.get_mut().clear();
        self.image_imports.clear();
    }

    // Whether the `@import`ed sheet at `url` could paint an image (`css_image`), as it last arrived.
    pub(crate) fn image_import(&self, url: &str) -> bool {
        self.image_imports.contains(url)
    }

    // The sheet at `url` arrived as `css` (None: it could not be fetched): every `@import` waiting for it takes it,
    // and the URLs its own `@import`s wait for are returned.
    pub(crate) fn import(&mut self, lock: &SharedRwLock, url: &str, css: Option<&str>, quirks: bool) -> Vec<String> {
        let waiting: Vec<PendingImport> = {
            let mut pending = self.pending.borrow_mut();
            let (hit, rest) = std::mem::take(&mut *pending).into_iter().partition(|p| p.url == url);
            *pending = rest;
            hit
        };
        let before = self.pending.borrow().len();
        if css.is_some_and(css_image) {
            self.image_imports.insert(url.to_owned());
        } else {
            self.image_imports.remove(url);
        }
        for p in waiting {
            let sheet = match (css, url::Url::parse(url)) {
                (Some(css), Ok(base)) => {
                    let chain = [&p.chain[..], &[url.to_owned()]].concat();
                    let loader = Loader { pending: &self.pending, chain };
                    let url = UrlExtraData::from(base);
                    let sheet = parse_sheet(lock, css, url, Origin::Author, p.media.clone(), AllowImportRules::Yes, Some(&loader), mode(quirks));
                    ImportSheet::new(Arc::new(sheet))
                }
                _ => ImportSheet::new_refused(),
            };
            let mut guard = lock.write();
            p.rule.write_with(&mut guard).stylesheet = sheet;
        }
        self.waiting_since(before)
    }

    fn parse(&mut self, lock: &SharedRwLock, source: &SheetSource, quirks: bool, version: u32) -> StoredSheet {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::hash::DefaultHasher::new();
        source.css.hash(&mut hasher);
        let key = ParseKey {
            css_hash: hasher.finish(),
            css_len: source.css.len(),
            base: source.base.clone(),
            media: source.media.clone(),
            constructed: source.constructed,
            quirks,
        };
        let (sheet, shared) = match self.parsed.get(&key) {
            Some(kept) => (kept.clone(), true),
            None => {
                let url = UrlExtraData::from(url::Url::parse(&source.base).unwrap_or_else(|_| url::Url::parse("about:blank").unwrap()));
                let imports = if source.constructed { AllowImportRules::No } else { AllowImportRules::Yes };
                // A sheet reached by URL is the first link of its imports' chain; an inline one names none.
                let chain = if source.constructed { Vec::new() } else { vec![source.base.clone()] };
                let media = Arc::new(lock.wrap(media_list(&source.media, &url, mode(quirks))));
                let loader = Loader { pending: &self.pending, chain };
                let sheet = parse_sheet(lock, &source.css, url, Origin::Author, media, imports, Some(&loader), mode(quirks));
                let sheet = DocumentStyleSheet(Arc::new(sheet));
                let keep = !source.css.to_ascii_lowercase().contains("@import");
                if keep {
                    if self.parsed.len() >= PARSED_LIMIT {
                        self.parsed.clear();
                    }
                    self.parsed.insert(key, sheet.clone());
                }
                (sheet, keep)
            }
        };
        StoredSheet {
            sheet,
            css_image: css_image(&source.css),
            host_has: host_reads_descendants(&source.css),
            version,
            constructed: source.constructed,
            imported: false,
            shared,
        }
    }

    // CSSOM is about to reach the sheet `id`'s rules: a sheet sharing a kept parse takes a copy of its own first — the
    // one it had and the one it has now, for the engine to cascade the copy where it cascaded the other.
    pub(crate) fn own(&mut self, id: u32) -> Option<(DocumentStyleSheet, DocumentStyleSheet)> {
        let stored = self.sheets.get_mut(&id).filter(|s| s.shared)?;
        let copy = DocumentStyleSheet(Arc::new((*stored.sheet.0).clone()));
        stored.shared = false;
        Some((std::mem::replace(&mut stored.sheet, copy.clone()), copy))
    }

    fn waiting_since(&self, before: usize) -> Vec<String> {
        self.pending.borrow()[before..].iter().map(|p| p.url.clone()).collect()
    }
}

// `css` parsed as a sheet of `origin` at `url`, under `media`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn parse_sheet(
    lock: &SharedRwLock,
    css: &str,
    url: UrlExtraData,
    origin: Origin,
    media: Arc<Locked<MediaList>>,
    imports: AllowImportRules,
    loader: Option<&dyn StylesheetLoader>,
    quirks: QuirksMode,
) -> Stylesheet {
    Stylesheet::from_str(css, url, origin, media, lock.clone(), loader, None, quirks, imports)
}

fn mode(quirks: bool) -> QuirksMode {
    if quirks { QuirksMode::Quirks } else { QuirksMode::NoQuirks }
}

// A `media` attribute's list (none for an empty one).
pub(crate) fn media_list(media: &str, url: &UrlExtraData, quirks: QuirksMode) -> MediaList {
    if media.is_empty() {
        return MediaList::empty();
    }
    let mut context = ParserContext::new(
        Origin::Author,
        url,
        Some(CssRuleType::Media),
        ParsingMode::DEFAULT,
        quirks,
        Default::default(),
        None,
        None,
        Default::default(),
    );
    let mut input = ParserInput::new(media);
    MediaList::parse(&mut context, &mut Parser::new(&mut input))
}

// Whether a sheet's text could paint an image: a `background` / `cursor` / `list-style` declaration with a `url(` in its
// value (a declaration is what lies between `;`, `{` and `}`, and the property a keyword with a `:` after it).
pub(crate) fn css_image(css: &str) -> bool {
    let lower = css.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut from = 0;
    while let Some(at) = lower[from..].find("url(").map(|i| i + from) {
        let start = bytes[..at].iter().rposition(|&b| matches!(b, b';' | b'{' | b'}')).map_or(0, |i| i + 1);
        let decl = &lower[start..at];
        // (…a keyword with a `:` after it, the regex's `keyword[^:;{}]*:`)
        let keyword_then_colon = |k: &str| decl.match_indices(k).any(|(i, _)| decl[i + k.len()..].contains(':'));
        if ["background", "cursor", "list-style"].into_iter().any(keyword_then_colon) {
            return true;
        }
        from = at + 4;
    }
    false
}

// Whether `css` holds a `:has()` inside a `:host()` ARGUMENT — read off the text: between a `:host(` and the
// parenthesis that closes it (ASCII case-insensitively).
pub(crate) fn host_reads_descendants(css: &str) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
