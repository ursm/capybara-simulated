// CSSOM's rules over the engine's own (stylo's `CssRule`s in the realm's sheets, sheets.rs): a CSSOM rule object names
// one by a HANDLE, and everything it says — its `cssText`, its selector, its media, its keyframes' keys, an `@import`'s
// URL and sheet, an `@namespace`'s prefix, an `@counter-style`'s descriptors — is read off that rule, and every CSSOM
// mutation (`insertRule`, `deleteRule`, `selectorText`, `keyText`, `media`, a descriptor, `rule.style`) is made to it
// in place, through the engine's own parsers and checks. What the page reads is what the engine cascades.

use cssparser::{Parser, ParserInput, ToCss};
use selectors::parser::{ParseRelative, SelectorList};
use style::context::QuirksMode;
use style::counter_style::{parse_counter_style_name_definition, DescriptorId};
use style::parser::Parse;
use style::properties::PropertyDeclarationBlock;
use style::selector_parser::SelectorParser;
use style::servo_arc::Arc;
use style::shared_lock::{Locked, SharedRwLock, SharedRwLockReadGuard, ToCssWithGuard};
use style::stylesheets::import_rule::ImportLayer;
use style::stylesheets::keyframes_rule::{Keyframe, KeyframeSelectors};
use style::stylesheets::PageSelectors;
use style::stylesheets::{
    AllowImportRules, CssRule, CssRuleType, CssRuleTypes, CssRules, DocumentStyleSheet, Origin, RulesMutateError,
    StylesheetInDocument,
};
use style::values::KeyframesName;
use style_traits::CssWriter;

use crate::cssom_decl::Block;
use crate::sheets::{Rule, RuleRef, SheetStore};

// The descriptors of an `@counter-style` rule, in the order its CSSOM attributes list them.
pub(crate) const COUNTER_STYLE_DESCRIPTORS: [&str; 10] =
    ["system", "symbols", "additive-symbols", "negative", "prefix", "suffix", "range", "pad", "speak-as", "fallback"];

// ---- CSSOM's rules, as handles on the engine's (sheets.rs `Rule`) ----

// The CSSOM interface a rule is an instance of, as the page side names its classes.
pub(crate) fn kind(rule: &Rule) -> &'static str {
    match rule {
        Rule::Keyframe(_) => "keyframe",
        Rule::Css(rule) => match rule {
            CssRule::Style(_) => "style",
            CssRule::Namespace(_) => "namespace",
            CssRule::Import(_) => "import",
            CssRule::Media(_) => "media",
            CssRule::CustomMedia(_) => "custom-media",
            CssRule::Container(_) => "container",
            CssRule::FontFace(_) => "font-face",
            CssRule::FontFeatureValues(_) => "font-feature-values",
            CssRule::FontPaletteValues(_) => "font-palette-values",
            CssRule::CounterStyle(_) => "counter-style",
            CssRule::Keyframes(_) => "keyframes",
            CssRule::Margin(_) => "margin",
            CssRule::Supports(_) => "supports",
            CssRule::Page(_) => "page",
            CssRule::Property(_) => "property",
            CssRule::Document(_) => "document",
            CssRule::LayerBlock(_) => "layer-block",
            CssRule::LayerStatement(_) => "layer-statement",
            CssRule::Scope(_) => "scope",
            CssRule::StartingStyle(_) => "starting-style",
            CssRule::AppearanceBase(_) => "appearance-base",
            CssRule::PositionTry(_) => "position-try",
            CssRule::NestedDeclarations(_) => "nested-declarations",
            CssRule::ViewTransition(_) => "view-transition",
        },
    }
}

// The list of rules a rule holds (a grouping rule's, a style rule's nested ones, a page's margin rules) — not a
// `@keyframes`, whose keyframes are no CSS rules.
fn rule_list(rule: &CssRule, guard: &SharedRwLockReadGuard) -> Option<Arc<Locked<CssRules>>> {
    Some(match rule {
        CssRule::Style(r) => r.read_with(guard).rules.clone()?,
        CssRule::Media(r) => r.rules.clone(),
        CssRule::Supports(r) => r.rules.clone(),
        CssRule::Container(r) => r.rules.clone(),
        CssRule::LayerBlock(r) => r.rules.clone(),
        CssRule::Scope(r) => r.rules.clone(),
        CssRule::StartingStyle(r) => r.rules.clone(),
        CssRule::Document(r) => r.rules.clone(),
        CssRule::Page(r) => r.read_with(guard).rules.clone(),
        _ => return None,
    })
}

// What a page holds of a list of rules: each rule's handle and interface.
fn hand_out_all(store: &mut SheetStore, sheet: u32, rules: Vec<Rule>, containing: CssRuleTypes) -> Vec<(u32, &'static str)> {
    rules.into_iter().map(|rule| (kind(&rule), rule)).map(|(k, rule)| (store.hand_out(sheet, rule, containing), k)).collect()
}

// The rule types a rule's own children are inside: its own, and its ancestors'.
fn inside(r: &RuleRef) -> CssRuleTypes {
    let mut types = r.containing;
    if let Rule::Css(rule) = &r.rule {
        types.insert(rule.rule_type());
    }
    types
}

// The rules of the sheet `sheet`, handed out.
pub(crate) fn sheet_rules(store: &mut SheetStore, lock: &SharedRwLock, sheet: u32) -> Option<Vec<(u32, &'static str)>> {
    let rules: Vec<Rule> = {
        let guard = lock.read();
        let stored = store.get(sheet)?;
        stored.sheet.contents(&guard).rules.read_with(&guard).0.iter().cloned().map(Rule::Css).collect()
    };
    Some(hand_out_all(store, sheet, rules, CssRuleTypes::default()))
}

// The rules the rule `handle` holds — a `@keyframes`'s keyframes included — handed out.
pub(crate) fn child_rules(store: &mut SheetStore, lock: &SharedRwLock, handle: u32) -> Option<Vec<(u32, &'static str)>> {
    let r = store.rule(handle)?;
    let (sheet, containing) = (r.sheet, inside(r));
    let rules: Vec<Rule> = {
        let guard = lock.read();
        match &r.rule {
            Rule::Css(CssRule::Keyframes(k)) => k.read_with(&guard).keyframes.iter().cloned().map(Rule::Keyframe).collect(),
            Rule::Css(rule) => rule_list(rule, &guard)?.read_with(&guard).0.iter().cloned().map(Rule::Css).collect(),
            Rule::Keyframe(_) => return None,
        }
    };
    Some(hand_out_all(store, sheet, rules, containing))
}

// A rule's `cssText`.
pub(crate) fn css_text(store: &SheetStore, lock: &SharedRwLock, handle: u32) -> Option<String> {
    let r = store.rule(handle)?;
    let guard = lock.read();
    let mut out = String::new();
    match &r.rule {
        Rule::Css(rule) => rule.to_css(&guard, &mut out).ok()?,
        Rule::Keyframe(k) => k.read_with(&guard).to_css(&guard, &mut out).ok()?,
    }
    Some(out)
}

// One of a rule's attributes, as CSSOM reads it: `what` names it — `selector` (a style or page rule's), `media` (an
// `@media`'s or an `@import`'s list), `condition` (an `@media` / `@supports` / `@container` condition), `name` (an
// `@keyframes`, `@layer`, `@property`, `@counter-style`, `@position-try`, `@font-palette-values`), `key` (a keyframe's
// selector), `href` (as written) / `url` (resolved) / `supports` / `layer` (an `@import`'s), `prefix` / `namespace` (an
// `@namespace`'s), `family` / `values` (an `@font-feature-values`'s, and `family` an `@font-palette-values`'s),
// `names` (an `@layer` statement's, comma-separated), `start` / `end` (an `@scope`'s), `syntax` / `inherits` /
// `initial` (an `@property`'s) and a counter style's descriptors by name. None where the rule has no such attribute.
pub(crate) fn get(store: &SheetStore, lock: &SharedRwLock, handle: u32, what: &str) -> Option<String> {
    let r = store.rule(handle)?;
    let guard = lock.read();
    let css = |v: &dyn ToCssDyn| v.css();
    Some(match (&r.rule, what) {
        (Rule::Css(CssRule::Style(s)), "selector") => s.read_with(&guard).selectors.to_css_string(),
        (Rule::Css(CssRule::Page(p)), "selector") => css(&p.read_with(&guard).selectors),
        (Rule::Css(CssRule::Media(m)), "media" | "condition") => css(m.media_queries.read_with(&guard)),
        (Rule::Css(CssRule::Import(i)), "media") => i.read_with(&guard).stylesheet.media(&guard).map_or_else(String::new, |m| css(m)),
        (Rule::Css(CssRule::Import(i)), "href") => i.read_with(&guard).url.original()?.to_owned(),
        (Rule::Css(CssRule::Import(i)), "url") => i.read_with(&guard).url.as_str().to_owned(),
        (Rule::Css(CssRule::Import(i)), "supports") => css(&i.read_with(&guard).supports.as_ref()?.condition),
        (Rule::Css(CssRule::Import(i)), "layer") => match &i.read_with(&guard).layer {
            ImportLayer::None => return None,
            ImportLayer::Anonymous => String::new(),
            ImportLayer::Named(name) => css(name),
        },
        (Rule::Css(CssRule::Supports(s)), "condition") => css(&s.condition),
        (Rule::Css(CssRule::Container(c)), "condition") => css(&c.conditions),
        (Rule::Css(CssRule::Namespace(n)), "prefix") => n.prefix.as_ref().map_or_else(String::new, |p| p.to_string()),
        (Rule::Css(CssRule::Namespace(n)), "namespace") => n.url.to_string(),
        (Rule::Css(CssRule::Keyframes(k)), "name") => {
            let k = k.read_with(&guard);
            k.name.as_atom().to_string()
        }
        (Rule::Css(CssRule::LayerBlock(l)), "name") => l.name.as_ref().map_or_else(String::new, |n| css(n)),
        (Rule::Css(CssRule::LayerStatement(l)), "names") => l.names.iter().map(|n| css(n)).collect::<Vec<_>>().join(","),
        (Rule::Css(CssRule::Property(p)), "name") => format!("--{}", p.name.0),
        (Rule::Css(CssRule::Property(p)), "syntax") => p.descriptors.syntax.as_ref().map_or_else(String::new, |s| css(s)),
        (Rule::Css(CssRule::Property(p)), "inherits") => p.descriptors.inherits.as_ref().map_or_else(String::new, |i| css(i)),
        (Rule::Css(CssRule::Property(p)), "initial") => p.descriptors.initial_value.as_ref().map_or_else(String::new, |v| css(&**v)),
        (Rule::Css(CssRule::CounterStyle(c)), "name") => css(c.read_with(&guard).name()),
        (Rule::Css(CssRule::PositionTry(p)), "name") => css(&p.read_with(&guard).name),
        (Rule::Css(CssRule::FontPaletteValues(p)), "name") => css(&p.name),
        (Rule::Css(CssRule::FontPaletteValues(p)), "family") => p.family_names.iter().map(|n| css(n)).collect::<Vec<_>>().join(", "),
        (Rule::Css(CssRule::FontFeatureValues(f)), "family") => f.family_names.iter().map(|n| css(n)).collect::<Vec<_>>().join(", "),
        // (…its feature values: a line per declaration — its block's at-rule name, the name it declares, its values)
        (Rule::Css(CssRule::FontFeatureValues(f)), "values") => {
            let mut out = String::new();
            let mut list = |block: &str, decls: &mut dyn Iterator<Item = (&style::Atom, String)>| {
                for (name, value) in decls {
                    out.push_str(&format!("{block}\t{name}\t{value}\n"));
                }
            };
            list("swash", &mut f.swash.iter().map(|d| (&d.name, css(&d.value))));
            list("stylistic", &mut f.stylistic.iter().map(|d| (&d.name, css(&d.value))));
            list("ornaments", &mut f.ornaments.iter().map(|d| (&d.name, css(&d.value))));
            list("annotation", &mut f.annotation.iter().map(|d| (&d.name, css(&d.value))));
            list("character-variant", &mut f.character_variant.iter().map(|d| (&d.name, css(&d.value))));
            list("styleset", &mut f.styleset.iter().map(|d| (&d.name, css(&d.value))));
            out
        }
        (Rule::Css(CssRule::Scope(s)), "start") => s.bounds.start.as_ref().map_or_else(String::new, |l| l.to_css_string()),
        (Rule::Css(CssRule::Scope(s)), "end") => s.bounds.end.as_ref().map_or_else(String::new, |l| l.to_css_string()),
        (Rule::Keyframe(k), "key") => css(&k.read_with(&guard).selector),
        (Rule::Css(CssRule::CounterStyle(c)), descriptor) => {
            let mut out = String::new();
            let _ = c.read_with(&guard).descriptors().get(counter_style_descriptor(descriptor)?, &mut out);
            out
        }
        _ => return None,
    })
}

// A counter-style descriptor by its name (`system`, `additive-symbols`, …).
fn counter_style_descriptor(name: &str) -> Option<DescriptorId> {
    if !COUNTER_STYLE_DESCRIPTORS.contains(&name) {
        return None;
    }
    let mut input = ParserInput::new(name);
    Parser::new(&mut input).parse_entirely(|p| DescriptorId::parse(p)).ok()
}

// A value of any of the engine's serializable types, as its CSS text.
trait ToCssDyn {
    fn css(&self) -> String;
}
impl<T: style_traits::ToCss> ToCssDyn for T {
    fn css(&self) -> String {
        let mut out = String::new();
        let _ = self.to_css(&mut CssWriter::new(&mut out));
        out
    }
}

// CSSOM sets one of a rule's attributes (as `get` names them: `selector`, `key`, `name`, `media`): whether the rule
// took the value — one that does not parse leaves it as it was.
pub(crate) fn set(store: &SheetStore, lock: &SharedRwLock, handle: u32, what: &str, value: &str) -> bool {
    let Some(r) = store.rule(handle) else { return false };
    let Some(stored) = store.get(r.sheet) else { return false };
    // (…parsed as the sheet parses: under its namespaces, at its URL, in its mode)
    let (namespaces, url, quirks) = {
        let guard = lock.read();
        let contents = stored.sheet.contents(&guard);
        (contents.namespaces.clone(), contents.url_data.clone(), contents.quirks_mode)
    };
    // (…an `@import`'s media are its sheet's: written there, where it has arrived)
    let imported = match &r.rule {
        Rule::Css(CssRule::Import(i)) => i.read_with(&lock.read()).stylesheet.as_sheet().cloned(),
        _ => None,
    };
    let mut input = ParserInput::new(value);
    let mut parser = Parser::new(&mut input);
    let mut guard = lock.write();
    match (&r.rule, what) {
        (Rule::Css(CssRule::Style(s)), "selector") => {
            let selectors =
                SelectorParser { stylesheet_origin: Origin::Author, namespaces: &namespaces, url_data: &url, for_supports_rule: false };
            let relative = if r.containing.contains(CssRuleType::Style) { ParseRelative::ForNesting } else { ParseRelative::No };
            let Ok(list) = SelectorList::parse(&selectors, &mut parser, relative) else { return false };
            s.write_with(&mut guard).selectors = list;
        }
        (Rule::Keyframe(k), "key") => {
            let Ok(selector) = parser.parse_entirely(KeyframeSelectors::parse) else { return false };
            k.write_with(&mut guard).selector = selector;
        }
        // (…a keyframes rule's name is any string: one that is no `<custom-ident>` serializes quoted)
        (Rule::Css(CssRule::Keyframes(k)), "name") => {
            k.write_with(&mut guard).name = KeyframesName::from_ident(value);
        }
        (Rule::Css(CssRule::Media(m)), "media") => {
            *m.media_queries.write_with(&mut guard) = crate::sheets::media_list(value, &url, quirks);
        }
        (Rule::Css(CssRule::Import(_)), "media") => {
            let Some(sheet) = imported else { return false };
            *sheet.media.write_with(&mut guard) = crate::sheets::media_list(value, &url, quirks);
        }
        // (…a page rule's selector may be none at all, as `@page { }` has)
        (Rule::Css(CssRule::Page(p)), "selector") => {
            let context = crate::cssom_decl::rule_context(&url, CssRuleType::Page, quirks == QuirksMode::Quirks);
            let selectors = if value.trim().is_empty() {
                PageSelectors::default()
            } else {
                let Ok(selectors) = parser.parse_entirely(|p| PageSelectors::parse(&context, p)) else { return false };
                selectors
            };
            p.write_with(&mut guard).selectors = selectors;
        }
        // (…a counter style's name only to one a counter style can have; a descriptor through the engine's own CSSOM
        // checks — another kind of system, symbols for an `extends` one — and only where it changed)
        (Rule::Css(CssRule::CounterStyle(c)), "name") => {
            let Ok(name) = parser.parse_entirely(|p| parse_counter_style_name_definition(p)) else { return false };
            c.write_with(&mut guard).set_name(name);
        }
        (Rule::Css(CssRule::CounterStyle(c)), descriptor) => {
            let Some(id) = counter_style_descriptor(descriptor) else { return false };
            let context = crate::cssom_decl::rule_context(&url, CssRuleType::CounterStyle, quirks == QuirksMode::Quirks);
            return c.write_with(&mut guard).set_descriptor(id, &context, &mut parser).unwrap_or(false);
        }
        _ => return false,
    }
    true
}

// A DOMException's name for what the engine refused a CSSOM mutation for.
fn refusal(error: RulesMutateError) -> &'static str {
    match error {
        RulesMutateError::Syntax => "SyntaxError",
        RulesMutateError::IndexSize => "IndexSizeError",
        RulesMutateError::HierarchyRequest => "HierarchyRequestError",
        RulesMutateError::InvalidState => "InvalidStateError",
    }
}

// The rule list a CSSOM mutation is of: the sheet's own (`parent` None) or the rule `parent`'s, with the rule types it
// is inside.
fn target_list(store: &SheetStore, lock: &SharedRwLock, sheet: u32, parent: Option<u32>) -> Option<(Arc<Locked<CssRules>>, CssRuleTypes)> {
    let guard = lock.read();
    match parent {
        None => Some((store.get(sheet)?.sheet.contents(&guard).rules.clone(), CssRuleTypes::default())),
        Some(handle) => {
            let r = store.rule(handle)?;
            let Rule::Css(rule) = &r.rule else { return None };
            Some((rule_list(rule, &guard)?, inside(r)))
        }
    }
}

// CSSOM "insert a CSS rule": `css` parsed as one rule (the engine's hierarchy and state checks included) and put at
// `index` of the sheet `sheet`'s list, or of the rule `parent`'s — its handle and interface, and the URLs an `@import` in
// it waits for; or the DOMException it is refused with.
pub(crate) fn insert(
    store: &mut SheetStore,
    lock: &SharedRwLock,
    sheet: u32,
    parent: Option<u32>,
    css: &str,
    index: usize,
) -> Result<(u32, &'static str, Vec<String>), &'static str> {
    let (rules, containing) = target_list(store, lock, sheet, parent).ok_or("NotFoundError")?;
    let stored = store.get(sheet).ok_or("NotFoundError")?;
    let (doc_sheet, constructed) = (stored.sheet.clone(), stored.constructed);
    let before = store.pending_count();
    let rule = {
        let guard = lock.read();
        let contents = doc_sheet.contents(&guard);
        let loader = store.loader(vec![contents.url_data.as_str().to_owned()]);
        let relative = containing.contains(CssRuleType::Style).then_some(CssRuleType::Style);
        let imports = if constructed { AllowImportRules::No } else { AllowImportRules::Yes };
        rules
            .read_with(&guard)
            .parse_rule_for_insert(lock, css, contents, index, containing, relative, Some(&loader), imports)
            .map_err(refusal)?
    };
    rules.write_with(&mut lock.write()).0.insert(index, rule.clone());
    let pending = store.waiting_after(before);
    let rule = Rule::Css(rule);
    let kind = kind(&rule);
    Ok((store.hand_out(sheet, rule, containing), kind, pending))
}

// CSSOM "remove a CSS rule" at `index` of the sheet's list, or of the rule `parent`'s: the DOMException it is refused
// with, if it is.
pub(crate) fn delete(store: &SheetStore, lock: &SharedRwLock, sheet: u32, parent: Option<u32>, index: usize) -> Result<(), &'static str> {
    let (rules, _) = target_list(store, lock, sheet, parent).ok_or("NotFoundError")?;
    rules.write_with(&mut lock.write()).remove_rule(index).map_err(refusal)
}

// A `@keyframes`'s `appendRule(css)`: the keyframe `css` parses to, appended — its handle; None where it does not parse.
pub(crate) fn append_keyframe(store: &mut SheetStore, lock: &SharedRwLock, handle: u32, css: &str) -> Option<u32> {
    let r = store.rule(handle)?;
    let Rule::Css(CssRule::Keyframes(k)) = &r.rule else { return None };
    let (k, sheet, containing) = (k.clone(), r.sheet, inside(r));
    let doc_sheet = store.get(sheet)?.sheet.clone();
    let keyframe = {
        let guard = lock.read();
        Keyframe::parse(css, doc_sheet.contents(&guard), lock).ok()?
    };
    k.write_with(&mut lock.write()).keyframes.push(keyframe.clone());
    Some(store.hand_out(sheet, Rule::Keyframe(keyframe), containing))
}

// …`findRule(key)` / `deleteRule(key)`: the index of the LAST keyframe whose selector is `key`, if any.
pub(crate) fn find_keyframe(store: &SheetStore, lock: &SharedRwLock, handle: u32, key: &str) -> Option<usize> {
    let Rule::Css(CssRule::Keyframes(k)) = &store.rule(handle)?.rule else { return None };
    k.read_with(&lock.read()).find_rule(&lock.read(), key)
}
pub(crate) fn delete_keyframe(store: &SheetStore, lock: &SharedRwLock, handle: u32, index: usize) {
    let Some(Rule::Css(CssRule::Keyframes(k))) = store.rule(handle).map(|r| &r.rule) else { return };
    let mut guard = lock.write();
    let keyframes = &mut k.write_with(&mut guard).keyframes;
    if index < keyframes.len() {
        keyframes.remove(index);
    }
}

// An `@import`'s sheet, as one of the store's (`CSSImportRule.styleSheet`); None while it has none (it was refused, or
// has not arrived).
pub(crate) fn imported_sheet(store: &mut SheetStore, lock: &SharedRwLock, handle: u32) -> Option<u32> {
    let Rule::Css(CssRule::Import(i)) = &store.rule(handle)?.rule else { return None };
    let sheet = i.read_with(&lock.read()).stylesheet.as_sheet()?.clone();
    Some(store.adopt(DocumentStyleSheet(sheet)))
}

// The declarations a rule holds — a style, page, keyframe, margin, nested-declarations or position-try rule's
// properties, an `@font-face`'s descriptors — as a block cssom_decl.rs reads and writes (`rule.style`).
pub(crate) fn rule_block(store: &SheetStore, lock: &SharedRwLock, handle: u32) -> Option<Block> {
    let r = store.rule(handle)?;
    let guard = lock.read();
    Some(match properties(&r.rule, &guard) {
        Some(block) => Block::Properties(block.read_with(&guard).clone()),
        None => match &r.rule {
            Rule::Css(CssRule::FontFace(face)) => Block::Descriptors(face.read_with(&guard).descriptors.clone()),
            _ => return None,
        },
    })
}

// …and the block a CSSOM write made, put in the rule's place (as `WrittenStyle` keeps an element's): whether the rule
// holds declarations of that sort.
pub(crate) fn set_rule_block(store: &SheetStore, lock: &SharedRwLock, handle: u32, block: Block) -> bool {
    let Some(r) = store.rule(handle) else { return false };
    let target = properties(&r.rule, &lock.read());
    let mut guard = lock.write();
    match (target, block, &r.rule) {
        (Some(target), Block::Properties(block), _) => *target.write_with(&mut guard) = block,
        (None, Block::Descriptors(descriptors), Rule::Css(CssRule::FontFace(face))) => {
            face.write_with(&mut guard).descriptors = descriptors
        }
        _ => return false,
    }
    true
}

// The property block of a rule that holds one.
fn properties(rule: &Rule, guard: &SharedRwLockReadGuard) -> Option<Arc<Locked<PropertyDeclarationBlock>>> {
    Some(match rule {
        Rule::Keyframe(k) => k.read_with(guard).block.clone(),
        Rule::Css(CssRule::Style(s)) => s.read_with(guard).block.clone(),
        Rule::Css(CssRule::Page(p)) => p.read_with(guard).block.clone(),
        Rule::Css(CssRule::Margin(m)) => m.block.clone(),
        Rule::Css(CssRule::NestedDeclarations(n)) => n.read_with(guard).block.clone(),
        Rule::Css(CssRule::PositionTry(p)) => p.read_with(guard).block.clone(),
        _ => return None,
    })
}

// A media list as the engine serializes it (`MediaList.mediaText`): `text` parsed as one.
pub(crate) fn media_text(text: &str) -> String {
    let url = crate::cssom_decl::url_data("about:blank");
    crate::sheets::media_list(text, &url, QuirksMode::NoQuirks).css()
}
