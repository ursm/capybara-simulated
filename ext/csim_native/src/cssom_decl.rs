// CSSOM's declaration blocks — an element's `style` attribute and a rule's block, as `CSSStyleDeclaration` reads and
// writes them — over stylo's own, which are Gecko's: a style rule's (and a keyframe's, a page's) `PropertyDeclarationBlock`
// and an `@font-face` rule's `Descriptors`. Parsing a declaration, serializing a value and a shorthand, the priority,
// `setProperty`'s and `removeProperty`'s effect on the block and `cssText` are the style system's, so a page's CSSOM
// agrees with the style the engine computes from the same text.
//
// The block lives as TEXT on the JS side (the attribute's value, the rule's text), and every op here takes that text and
// answers from its parse — kept per (text, kind, mode, base) in a bounded map, so the reads a page makes of one block
// between two writes parse it once. A write answers the new text, or nothing where the block did not change (no
// attribute write, no mutation record: CSSOM "update style attribute" only runs on a change) — and keeps the block it
// MADE under that text, which is what the page's style is computed from (`style_attribute_block`): the text is its
// serialization, six significant digits to a number, and parsing that back would lose what the write said
// (`cubic-bezier(0, 1.123456789, …)`), where a browser's attribute steps leave the written block in place.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use cssparser::{Parser, ParserInput, SourceLocation};
use style::context::QuirksMode;
use style::font_face::{parse_font_face_block, DescriptorId, Descriptors};
use style::parser::ParserContext;
use style::properties::{
    parse_one_declaration_into, parse_style_attribute, Importance, PropertyDeclarationBlock, PropertyId,
    SourcePropertyDeclaration, SourcePropertyDeclarationUpdate,
};
use style::stylesheets::supports_rule::parse_condition_or_declaration;
use style::stylesheets::{CssRuleType, Origin, UrlExtraData};
use style_traits::{CssWriter, ParsingMode, ToCss};

// What a block belongs to, which decides what it may declare: the properties of a style rule (an element's `style`
// attribute is one), of a keyframe, of a page — or an `@font-face` rule's descriptors.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Kind {
    Style,
    Keyframe,
    Page,
    FontFace,
}
impl Kind {
    pub(crate) fn from_u32(n: u32) -> Kind {
        match n {
            1 => Kind::Keyframe,
            2 => Kind::Page,
            3 => Kind::FontFace,
            _ => Kind::Style,
        }
    }
    fn rule_type(self) -> CssRuleType {
        match self {
            Kind::Style => CssRuleType::Style,
            Kind::Keyframe => CssRuleType::Keyframe,
            Kind::Page => CssRuleType::Page,
            Kind::FontFace => CssRuleType::FontFace,
        }
    }
}

// The base a block's `url()`s resolve against — the document's — one per base. (A specified `url()` serializes as
// written, whatever its base; the computed one the engine makes of the block is resolved.)
fn url_data(base: &str) -> UrlExtraData {
    thread_local! {
        static URLS: RefCell<HashMap<String, UrlExtraData>> = RefCell::new(HashMap::new());
    }
    URLS.with(|u| {
        let mut u = u.borrow_mut();
        if let Some(url) = u.get(base) {
            return url.clone();
        }
        let url = UrlExtraData::from(url::Url::parse(base).unwrap_or_else(|_| url::Url::parse("about:blank").unwrap()));
        if u.len() >= 64 {
            u.clear();
        }
        u.insert(base.to_owned(), url.clone());
        url
    })
}

fn mode(quirks: bool) -> QuirksMode {
    if quirks { QuirksMode::Quirks } else { QuirksMode::NoQuirks }
}

fn context(url: &UrlExtraData, kind: Kind, quirks: bool) -> ParserContext<'_> {
    ParserContext::new(
        Origin::Author,
        url,
        Some(kind.rule_type()),
        ParsingMode::DEFAULT,
        mode(quirks),
        Default::default(),
        None,
        None,
        Default::default(),
    )
}

// A parsed block of either sort.
enum Block {
    Properties(PropertyDeclarationBlock),
    Descriptors(Descriptors),
}

const CACHE_LIMIT: usize = 4096;
// Where a block is kept: its text, its kind, its document's mode and base.
#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct Key {
    text: String,
    kind: Kind,
    quirks: bool,
    base: String,
}
impl Key {
    // (…the base as a URL serializes, as the engine's own is: a `style` attribute's block is found by the engine's)
    pub(crate) fn new(text: &str, kind: Kind, quirks: bool, base: &str) -> Key {
        Key { text: text.to_owned(), kind, quirks, base: url_data(base).0.as_str().to_owned() }
    }
    fn with_text(&self, text: String) -> Key {
        Key { text, ..self.clone() }
    }
}
thread_local! {
    static BLOCKS: RefCell<HashMap<Key, Rc<Block>>> = RefCell::new(HashMap::new());
}
fn keep(key: Key, block: Rc<Block>) {
    BLOCKS.with(|b| {
        let mut b = b.borrow_mut();
        if b.len() >= CACHE_LIMIT {
            b.clear();
        }
        b.insert(key, block);
    });
}

// The parse of the key's text — the declaration list inside the block's braces — as a block of its kind, in its
// document.
fn parsed(key: &Key) -> Rc<Block> {
    if let Some(block) = BLOCKS.with(|b| b.borrow().get(key).cloned()) {
        return block;
    }
    let (text, kind, quirks) = (key.text.as_str(), key.kind, key.quirks);
    let url = url_data(&key.base);
    let block = Rc::new(match kind {
        Kind::FontFace => {
            let context = context(&url, kind, quirks);
            let mut input = ParserInput::new(text);
            let mut parser = Parser::new(&mut input);
            Block::Descriptors(parse_font_face_block(&context, &mut parser, SourceLocation { line: 0, column: 0 }).descriptors)
        }
        _ => Block::Properties(parse_style_attribute(text, &url, None, mode(quirks), kind.rule_type())),
    });
    keep(key.clone(), block.clone());
    block
}

// The block a CSSOM write made of an element's `style` attribute, where `css` is the text it wrote — what the engine
// computes the element's style from, rather than a parse of that text (see above).
pub(crate) fn style_attribute_block(css: &str, quirks: bool, base: &str) -> Option<PropertyDeclarationBlock> {
    match &*BLOCKS.with(|b| b.borrow().get(&Key::new(css, Kind::Style, quirks, base)).cloned())? {
        Block::Properties(block) => Some(block.clone()),
        Block::Descriptors(_) => None,
    }
}

fn property(name: &str) -> Option<PropertyId> {
    PropertyId::parse_enabled_for_all_content(name).ok()
}

fn descriptor(name: &str) -> Option<DescriptorId> {
    let mut input = ParserInput::new(name);
    let mut parser = Parser::new(&mut input);
    parser.parse_entirely(|i| DescriptorId::parse(i)).ok()
}

fn serialize(block: &Block) -> String {
    let mut out = String::new();
    let _ = match block {
        Block::Properties(block) => block.to_css(&mut out),
        Block::Descriptors(descriptors) => descriptors.to_css(&mut CssWriter::new(&mut out)),
    };
    out
}

// `getPropertyValue(name)`: '' for what the block does not set, and for a name it cannot hold.
pub(crate) fn value(key: &Key, name: &str) -> String {
    let mut out = String::new();
    match &*parsed(key) {
        Block::Properties(block) => {
            if let Some(id) = property(name) {
                let _ = block.property_value_to_css(&id, &mut out);
            }
        }
        Block::Descriptors(descriptors) => {
            if let Some(id) = descriptor(name) {
                let _ = descriptors.get(id, &mut out);
            }
        }
    }
    out
}

// `getPropertyPriority(name)` is `important` (a descriptor never is).
pub(crate) fn important(key: &Key, name: &str) -> bool {
    match &*parsed(key) {
        Block::Properties(block) => property(name).is_some_and(|id| block.property_priority(&id).important()),
        Block::Descriptors(_) => false,
    }
}

// `cssText`.
pub(crate) fn css_text(key: &Key) -> String {
    serialize(&parsed(key))
}

// The names `length`, `item()` and iteration walk, in the block's order: every longhand, custom property or descriptor
// it sets.
pub(crate) fn names(key: &Key) -> Vec<String> {
    match &*parsed(key) {
        Block::Properties(block) => block.declarations().iter().map(|d| d.id().name().to_string()).collect(),
        Block::Descriptors(descriptors) => {
            (0..descriptors.len()).filter_map(|i| descriptors.at(i)).map(|id| id.name().to_owned()).collect()
        }
    }
}

// `setProperty(name, value, important)` — the block's new text, or None where it did not change: a name the block
// cannot hold, a value that does not parse, or the same declaration again. (An empty value is `removeProperty`, the
// caller's.)
pub(crate) fn set(key: &Key, name: &str, value: &str, important: bool) -> Option<String> {
    let (kind, quirks) = (key.kind, key.quirks);
    let url = url_data(&key.base);
    match &*parsed(key) {
        Block::Properties(current) => {
            let id = property(name)?;
            let mut source = SourcePropertyDeclaration::default();
            parse_one_declaration_into(
                &mut source,
                id,
                value,
                Origin::Author,
                &url,
                None,
                ParsingMode::DEFAULT,
                mode(quirks),
                kind.rule_type(),
            )
            .ok()?;
            let importance = if important { Importance::Important } else { Importance::Normal };
            let mut block = current.clone();
            let mut updates = SourcePropertyDeclarationUpdate::default();
            if !block.prepare_for_update(&source, importance, &mut updates) {
                return None;
            }
            block.update(source.drain(), importance, &mut updates);
            Some(made(key, Block::Properties(block)))
        }
        Block::Descriptors(current) => {
            if important {
                return None;
            }
            let context = context(&url, kind, quirks);
            let id = descriptor(name)?;
            let mut descriptors = current.clone();
            let mut input = ParserInput::new(value);
            let mut parser = Parser::new(&mut input);
            if !descriptors.set(id, &context, &mut parser).ok()? {
                return None;
            }
            Some(made(key, Block::Descriptors(descriptors)))
        }
    }
}

// A block a write made: kept under the text it serializes to, which is what the write answers.
fn made(key: &Key, block: Block) -> String {
    let text = serialize(&block);
    keep(key.with_text(text.clone()), Rc::new(block));
    text
}

// `removeProperty(name)` — the value it had, and the block's new text where it set the name at all.
pub(crate) fn remove(key: &Key, name: &str) -> (String, Option<String>) {
    let old = value(key, name);
    match &*parsed(key) {
        Block::Properties(current) => {
            let Some(id) = property(name) else { return (old, None) };
            let Some(first) = current.first_declaration_to_remove(&id) else { return (old, None) };
            let mut block = current.clone();
            block.remove_property(&id, first);
            (old, Some(made(key, Block::Properties(block))))
        }
        Block::Descriptors(current) => {
            let Some(id) = descriptor(name) else { return (old, None) };
            let mut descriptors = current.clone();
            if !descriptors.remove(id) {
                return (old, None);
            }
            (old, Some(made(key, Block::Descriptors(descriptors))))
        }
    }
}

// `CSS.supports(name, value)`: the property is one the engine implements, and the value parses as it.
pub(crate) fn supports(name: &str, value: &str) -> bool {
    let Some(id) = property(name) else { return false };
    let mut source = SourcePropertyDeclaration::default();
    parse_one_declaration_into(
        &mut source,
        id,
        value,
        Origin::Author,
        &url_data("about:blank"),
        None,
        ParsingMode::DEFAULT,
        QuirksMode::NoQuirks,
        CssRuleType::Style,
    )
    .is_ok()
}

// `CSS.supports(conditionText)`: a `<supports-condition>`, or a bare declaration (`display: grid`), as the engine
// evaluates one in an `@supports` rule.
pub(crate) fn supports_condition(text: &str) -> bool {
    let mut input = ParserInput::new(text);
    let mut parser = Parser::new(&mut input);
    let Ok(condition) = parser.parse_entirely(parse_condition_or_declaration) else { return false };
    let url = url_data("about:blank");
    condition.eval(&context(&url, Kind::Style, false))
}
