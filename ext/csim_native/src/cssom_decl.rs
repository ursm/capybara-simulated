// CSSOM's declaration blocks — an element's `style` attribute and a rule's block, as `CSSStyleDeclaration` reads and
// writes them — over stylo's own, which are Gecko's: a style rule's (and a keyframe's, a page's) `PropertyDeclarationBlock`
// and an `@font-face` rule's `Descriptors`. Parsing a declaration, serializing a value and a shorthand, the priority,
// `setProperty`'s and `removeProperty`'s effect on the block and `cssText` are the style system's, so a page's CSSOM
// agrees with the style the engine computes from the same text.
//
// The block lives as TEXT on the JS side (the attribute's value, the rule's text), and every op here takes that text and
// answers from its parse — kept per (text, kind, mode, base) in a bounded map, so the reads a page makes of one block
// between two writes parse it once. A write answers the new text, or nothing where the block did not change (no
// attribute write, no mutation record: CSSOM "update style attribute" only runs on a change) — and the block it MADE,
// which an element keeps (dom.rs `NodeData::written_style`) and the style engine computes the element's style from: the
// text is its serialization, six significant digits to a number, and parsing that back would lose what the write said
// (`cubic-bezier(0, 1.123456789, …)`), where a browser's attribute steps leave the written block in place.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use cssparser::{Parser, ParserInput, SourceLocation};
use style::context::QuirksMode;
use style::font_face::{parse_font_face_block, DescriptorId, Descriptors};
use style::parser::ParserContext;
use style::properties::style_structs::Font;
use style::properties::{
    parse_one_declaration_into, parse_style_attribute, ComputedValues, Importance, NonCustomPropertyId, PropertyDeclaration,
    PropertyDeclarationBlock, PropertyDeclarationId, PropertyId, SourcePropertyDeclaration, SourcePropertyDeclarationUpdate,
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
pub(crate) fn url_data(base: &str) -> UrlExtraData {
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
    rule_context(url, kind.rule_type(), quirks)
}
// …and for a rule of any type (cssom_rule.rs).
pub(crate) fn rule_context(url: &UrlExtraData, rule_type: CssRuleType, quirks: bool) -> ParserContext<'_> {
    ParserContext::new(
        Origin::Author,
        url,
        Some(rule_type),
        ParsingMode::DEFAULT,
        mode(quirks),
        Default::default(),
        None,
        None,
        Default::default(),
    )
}

// A parsed block of either sort.
pub(crate) enum Block {
    Properties(PropertyDeclarationBlock),
    Descriptors(Descriptors),
}

// What a write made: the block's new text, and the block itself.
pub(crate) struct Written {
    pub(crate) text: String,
    block: Block,
}
impl Written {
    pub(crate) fn into_block(self) -> Block {
        self.block
    }
}

// The block a CSSOM write made of an element's `style` attribute, which the element keeps (dom.rs
// `NodeData::written_style`): what its style is computed from and its next write starts from, while its attribute holds
// the text the write wrote — in a document of the base and mode it was written in, where that text says what the block
// does. Anywhere else the text is parsed afresh.
pub(crate) struct WrittenStyle {
    text: String,
    base: UrlExtraData,
    quirks: bool,
    block: Rc<Block>,
}
impl WrittenStyle {
    // What a write to the block of `key` made, where it is a block of properties.
    pub(crate) fn new(key: &Key, written: Written) -> Option<WrittenStyle> {
        matches!(written.block, Block::Properties(_)).then(|| WrittenStyle {
            text: written.text,
            base: url_data(&key.base),
            quirks: key.quirks,
            block: Rc::new(written.block),
        })
    }
    pub(crate) fn text(&self) -> &str {
        &self.text
    }
    // The block, where an attribute holding `text` in a document of `base` and mode `quirks` declares it.
    pub(crate) fn declared_by(&self, text: &str, base: &UrlExtraData, quirks: bool) -> Option<&PropertyDeclarationBlock> {
        match &*self.block {
            Block::Properties(block) if self.text == text && self.base == *base && self.quirks == quirks => Some(block),
            _ => None,
        }
    }
    // …and as the block a read or a write of `key` is of.
    pub(crate) fn for_key(&self, key: &Key) -> Option<Rc<Block>> {
        self.declared_by(&key.text, &url_data(&key.base), key.quirks).map(|_| self.block.clone())
    }
}

const CACHE_LIMIT: usize = 4096;
// Where a block's parse is kept: its text, its kind, its document's mode and base.
#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct Key {
    text: String,
    kind: Kind,
    quirks: bool,
    base: String,
}
impl Key {
    pub(crate) fn new(text: &str, kind: Kind, quirks: bool, base: &str) -> Key {
        Key { text: text.to_owned(), kind, quirks, base: base.to_owned() }
    }
}
thread_local! {
    static BLOCKS: RefCell<HashMap<Key, Rc<Block>>> = RefCell::new(HashMap::new());
}

// The parse of the key's text — the declaration list inside the block's braces — as a block of its kind, in its
// document.
fn parsed(key: &Key) -> Rc<Block> {
    if let Some(block) = BLOCKS.with(|b| b.borrow().get(key).cloned()) {
        return block;
    }
    let block = Rc::new(parse(key));
    BLOCKS.with(|b| {
        let mut b = b.borrow_mut();
        if b.len() >= CACHE_LIMIT {
            b.clear();
        }
        b.insert(key.clone(), block.clone());
    });
    block
}
fn parse(key: &Key) -> Block {
    let url = url_data(&key.base);
    match key.kind {
        Kind::FontFace => {
            let context = context(&url, key.kind, key.quirks);
            let mut input = ParserInput::new(&key.text);
            let mut parser = Parser::new(&mut input);
            Block::Descriptors(parse_font_face_block(&context, &mut parser, SourceLocation { line: 0, column: 0 }).descriptors)
        }
        kind => {
            let mut block = parse_style_attribute(&key.text, &url, None, mode(key.quirks), kind.rule_type());
            // (…which the engine's own parse admits, and a page's block holds none of — but for the CSS-wide keyword an
            // `all` gives every longhand it covers, which is what lets the block serialize as `all` again)
            let internal: Vec<PropertyId> = block
                .declarations()
                .iter()
                .filter(|d| !matches!(d, PropertyDeclaration::CSSWideKeyword(_)))
                .map(|d| d.id())
                .filter(|id| !exposed(&id.name()))
                .filter_map(|id| PropertyId::parse_enabled_for_all_content(&id.name()).ok())
                .collect();
            for id in internal {
                if let Some(first) = block.first_declaration_to_remove(&id) {
                    block.remove_property(&id, first);
                }
            }
            Block::Properties(block)
        }
    }
}

// The engine's internal properties — the UA sheet's and its own bookkeeping, which it parses wherever it parses
// author CSS — are no page's to see: Gecko keeps them out of content, as Chrome has none of them.
fn exposed(name: &str) -> bool {
    !(name.starts_with("-moz-") || name.starts_with("-x-") || name.starts_with("-servo-") ||
      matches!(name, "masonry-auto-flow" | "link-parameters"))
}

// `name` as a property a block of the key's kind may declare (a keyframe takes no animation property, a page no
// `display`), and one a page can see.
fn property(name: &str, key: &Key) -> Option<PropertyId> {
    let url = url_data(&key.base);
    let id = PropertyId::parse(name, &context(&url, key.kind, key.quirks)).ok()?;
    exposed(&name.to_ascii_lowercase()).then_some(id)
}

// A property a page can name: what CSSOM's IDL attributes, `getComputedStyle`'s enumeration and a keyframe's members are
// made of. The JS side has it as data (js/src/css-properties.js, written from this by script/gen_css_properties.rb and
// held to it by spec/css_properties_spec.rb), because a realm's interfaces are built where no engine is attached yet.
pub(crate) struct Property {
    pub(crate) name: &'static str,
    // The property it names: an alias's, or its own name.
    pub(crate) property: &'static str,
    pub(crate) animatable: bool,
    // A shorthand's longhands, in the engine's order; none for a longhand.
    pub(crate) longhands: Vec<&'static str>,
    // A longhand's initial value, computed and serialized as a computed style reads it.
    pub(crate) initial: Option<String>,
}

pub(crate) fn properties() -> Vec<Property> {
    crate::style::enable_properties();
    let initial = ComputedValues::initial_values_with_font_override(Font::initial_values());
    let page_sees = |id: NonCustomPropertyId| exposed(id.name()) && id.to_property_id().enabled_for_all_content();
    NonCustomPropertyId::iter()
        .filter(|&id| page_sees(id))
        .map(|id| {
            let own = id.unaliased();
            Property {
                name: id.name(),
                property: own.name(),
                animatable: own.is_animatable(),
                longhands: own.as_shorthand().map_or_else(Vec::new, |shorthand| {
                    shorthand.longhands().filter(|&l| page_sees(l.into())).map(|l| l.name()).collect()
                }),
                initial: own.as_longhand().map(|l| initial.computed_value_to_string(PropertyDeclarationId::Longhand(l))),
            }
        })
        .collect()
}

fn descriptor(name: &str) -> Option<DescriptorId> {
    let mut input = ParserInput::new(name);
    let mut parser = Parser::new(&mut input);
    parser.parse_entirely(|i| DescriptorId::parse(i)).ok()
}

fn serialize(block: &Block) -> String {
    let mut out = String::new();
    match block {
        Block::Properties(block) => {
            let _ = block.to_css(&mut out);
        }
        Block::Descriptors(descriptors) => {
            let _ = descriptors.to_css(&mut CssWriter::new(&mut out));
            // (…which writes `; ` after each descriptor, the last one too)
            out.truncate(out.trim_end().len());
        }
    }
    out
}

// `getPropertyValue(name)`: '' for what the block does not set, and for a name it cannot hold.
pub(crate) fn value(key: &Key, made: Option<Rc<Block>>, name: &str) -> String {
    let mut out = String::new();
    match &*current(key, made) {
        Block::Properties(block) => {
            if let Some(id) = property(name, key) {
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
pub(crate) fn important(key: &Key, made: Option<Rc<Block>>, name: &str) -> bool {
    match &*current(key, made) {
        Block::Properties(block) => property(name, key).is_some_and(|id| block.property_priority(&id).important()),
        Block::Descriptors(_) => false,
    }
}

// `cssText`.
pub(crate) fn css_text(key: &Key, made: Option<Rc<Block>>) -> String {
    serialize(&current(key, made))
}

// The names `length`, `item()` and iteration walk, in the block's order: every longhand, custom property or descriptor
// it sets that a page can see.
pub(crate) fn names(key: &Key, made: Option<Rc<Block>>) -> Vec<String> {
    match &*current(key, made) {
        Block::Properties(block) => {
            block.declarations().iter().map(|d| d.id().name().to_string()).filter(|n| exposed(n)).collect()
        }
        Block::Descriptors(descriptors) => {
            (0..descriptors.len()).filter_map(|i| descriptors.at(i)).map(|id| id.name().to_owned()).collect()
        }
    }
}

fn written(block: Block) -> Written {
    Written { text: serialize(&block), block }
}

// The block a read or a write is of: the one the last write MADE where the caller still holds it (an element's
// `written_style`, while its attribute holds the text that write wrote) — a parse of that text would round what it
// said, and lose what its serialization cannot say — else the parse of the key's text.
fn current(key: &Key, made: Option<Rc<Block>>) -> Rc<Block> {
    made.unwrap_or_else(|| parsed(key))
}

// `setProperty(name, value, important)` — what the write made, or None where the block did not change: a name the
// block cannot hold, a value that does not parse, or the same declaration again. (An empty value is `removeProperty`,
// the caller's.)
pub(crate) fn set(
    key: &Key,
    made: Option<Rc<Block>>,
    name: &str,
    value: &str,
    important: bool,
) -> Option<Written> {
    let url = url_data(&key.base);
    match &*current(key, made) {
        Block::Properties(current) => {
            let id = property(name, key)?;
            // (…and a keyframe holds no `!important` declaration: its parse drops one, so a write would only lose it)
            if important && key.kind == Kind::Keyframe {
                return None;
            }
            let mut source = SourcePropertyDeclaration::default();
            parse_one_declaration_into(
                &mut source,
                id,
                value,
                Origin::Author,
                &url,
                None,
                ParsingMode::DEFAULT,
                mode(key.quirks),
                key.kind.rule_type(),
            )
            .ok()?;
            let importance = if important { Importance::Important } else { Importance::Normal };
            let mut block = current.clone();
            let mut updates = SourcePropertyDeclarationUpdate::default();
            if !block.prepare_for_update(&source, importance, &mut updates) {
                return None;
            }
            block.update(source.drain(), importance, &mut updates);
            Some(written(Block::Properties(block)))
        }
        Block::Descriptors(current) => {
            if important {
                return None;
            }
            let context = context(&url, key.kind, key.quirks);
            let id = descriptor(name)?;
            let mut descriptors = current.clone();
            let mut input = ParserInput::new(value);
            let mut parser = Parser::new(&mut input);
            if !descriptors.set(id, &context, &mut parser).ok()? {
                return None;
            }
            Some(written(Block::Descriptors(descriptors)))
        }
    }
}

// `removeProperty(name)` — the value it had, and what the write made where the block set the name at all.
pub(crate) fn remove(key: &Key, made: Option<Rc<Block>>, name: &str) -> (String, Option<Written>) {
    let old = value(key, made.clone(), name);
    match &*current(key, made) {
        Block::Properties(current) => {
            let Some(id) = property(name, key) else { return (old, None) };
            let Some(first) = current.first_declaration_to_remove(&id) else { return (old, None) };
            let mut block = current.clone();
            block.remove_property(&id, first);
            (old, Some(written(Block::Properties(block))))
        }
        Block::Descriptors(current) => {
            let Some(id) = descriptor(name) else { return (old, None) };
            let mut descriptors = current.clone();
            if !descriptors.remove(id) {
                return (old, None);
            }
            (old, Some(written(Block::Descriptors(descriptors))))
        }
    }
}

// `cssText`'s setter: the block the key's text parses to, as a write made it.
pub(crate) fn replace(key: &Key) -> Written {
    written(parse(key))
}

// `CSS.supports(name, value)`: the property is one the engine implements and a page can see, and the value parses as
// it.
pub(crate) fn supports(name: &str, value: &str) -> bool {
    let key = Key::new("", Kind::Style, false, "about:blank");
    let Some(id) = property(name, &key) else { return false };
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

// A `<number>` as CSS reads it — a math function of numbers reduced (`calc(0.5)`, `min(1, 2 / 4)`) — or None where it
// is none, or one that needs a style to resolve. The engine reduces in f32, so the answer is the shortest decimal that
// f32 rounds back to, read as a double: `calc(0.1 + 0.1)` is 0.2, as script has it, not 0.20000000298023224. (A value
// f32 cannot hold to a double's digits stays an f32's: `calc(1 / 3)` is 0.33333334 where Chrome, reducing in double,
// says 0.3333333333333333.)
pub(crate) fn number(text: &str) -> Option<f64> {
    use style::parser::Parse;
    let url = url_data("about:blank");
    let context = context(&url, Kind::Style, false);
    let mut input = ParserInput::new(text);
    let mut parser = Parser::new(&mut input);
    let n = parser.parse_entirely(|p| style::values::specified::Number::parse(&context, p)).ok()?;
    n.resolve()?.to_string().parse().ok()
}

// The longhands a `font` shorthand sets: its style, small-caps, weight, stretch, size and family, specified — None
// where it is no `font` value (a CSS-wide keyword, a `var()`, a system font, nothing that parses).
struct FontShorthand {
    style: String,
    variant_caps: String,
    weight: style::values::specified::FontWeight,
    stretch: String,
    size: style::values::specified::FontSize,
    family: style::values::computed::font::FontFamilyList,
}
fn font_shorthand(text: &str) -> Option<FontShorthand> {
    use style::properties::ShorthandId;
    use style::values::specified::FontFamily;
    let mut source = SourcePropertyDeclaration::default();
    parse_one_declaration_into(
        &mut source,
        PropertyId::NonCustom(ShorthandId::Font.into()),
        text,
        Origin::Author,
        &url_data("about:blank"),
        None,
        ParsingMode::DEFAULT,
        QuirksMode::NoQuirks,
        CssRuleType::Style,
    )
    .ok()?;
    let (mut style, mut variant_caps, mut weight, mut stretch, mut size, mut family) = (None, None, None, None, None, None);
    for declaration in source.drain().declarations {
        match declaration {
            PropertyDeclaration::FontStyle(v) => style = Some(v.to_css_string()),
            PropertyDeclaration::FontVariantCaps(v) => variant_caps = Some(v.to_css_string()),
            PropertyDeclaration::FontWeight(v) => weight = Some(v),
            PropertyDeclaration::FontStretch(v) => stretch = Some(v.to_css_string()),
            PropertyDeclaration::FontSize(v) => size = Some(v),
            PropertyDeclaration::FontFamily(FontFamily::Values(list)) => family = Some(list),
            _ => {}
        }
    }
    // (…a CSS-wide keyword is no family name written bare, `revert-layer` included, which the engine takes for one: CSS
    // Fonts 4 §4.2)
    let family = family?;
    let keyword = |f: &style::values::computed::font::SingleFontFamily| match f {
        style::values::computed::font::SingleFontFamily::FamilyName(name) => {
            name.syntax == style::values::computed::font::FontFamilyNameSyntax::Identifiers
                && ["initial", "inherit", "unset", "default", "revert", "revert-layer"].iter().any(|k| name.name.to_string().eq_ignore_ascii_case(k))
        }
        _ => false,
    };
    if family.iter().any(keyword) {
        return None;
    }
    Some(FontShorthand { style: style?, variant_caps: variant_caps?, weight: weight?, stretch: stretch?, size: size?, family })
}

// A canvas's `font` (HTML §4.12.5.1.11): the `font` shorthand `text` computed — its size in px, `em` and `%` of `em`,
// `rem` of `rem`, `lh` / `rlh` of the line heights (NaN where there is none to resolve against) — serialized as a
// computed `font` is, its line height left out (style, small-caps, weight, stretch, size, family, each omitted at its
// initial value), and the parts its text is drawn with. None where it is no `font` value, or its size cannot be
// resolved.
pub(crate) struct CanvasFont {
    pub(crate) css: String,
    pub(crate) px: f64,
    pub(crate) weight: f64,
    // 0 upright, 1 italic, 2 oblique.
    pub(crate) slant: u8,
    pub(crate) small_caps: bool,
    // The first family: a name as written, or a generic family's keyword.
    pub(crate) family: String,
}
pub(crate) fn canvas_font(text: &str, em: f64, rem: f64, lh: f64, rlh: f64) -> Option<CanvasFont> {
    use style::values::specified::font::{AbsoluteFontWeight, FontSizeKeyword};
    use style::values::specified::length::LengthUnit;
    use style::values::specified::{FontSize, FontWeight, LengthPercentage};
    let font = font_shorthand(text)?;
    let slant = match font.style.as_str() {
        "normal" => 0,
        "italic" => 1,
        _ => 2,
    };
    let small_caps = font.variant_caps == "small-caps";
    let mut parts: Vec<String> = [font.style, font.variant_caps].into_iter().filter(|p| p != "normal").collect();
    let weight = match font.weight {
        FontWeight::Absolute(AbsoluteFontWeight::Normal) => 400.0,
        FontWeight::Absolute(AbsoluteFontWeight::Bold) | FontWeight::Bolder => {
            parts.push("bold".to_owned());
            700.0
        }
        // (…relative to the initial weight, 400)
        FontWeight::Lighter => {
            parts.push("100".to_owned());
            100.0
        }
        FontWeight::Absolute(AbsoluteFontWeight::Weight(n)) => {
            let n = f64::from(n.resolve()?);
            if n != 400.0 {
                parts.push(crate::numbers::to_js_string(n));
            }
            n
        }
        FontWeight::System(_) => return None,
    };
    if font.stretch != "normal" {
        parts.push(font.stretch);
    }
    let px = match font.size {
        // (…the fixed table browsers size the absolute keywords by, `medium` 16px)
        FontSize::Keyword(info) => match info.kw {
            FontSizeKeyword::XXSmall => 9.0,
            FontSizeKeyword::XSmall => 10.0,
            FontSizeKeyword::Small => 13.0,
            FontSizeKeyword::Medium => 16.0,
            FontSizeKeyword::Large => 18.0,
            FontSizeKeyword::XLarge => 24.0,
            FontSizeKeyword::XXLarge => 32.0,
            FontSizeKeyword::XXXLarge => 48.0,
            _ => return None,
        },
        FontSize::Length(LengthPercentage::Percentage(p)) => f64::from(p.get()) * em,
        FontSize::Length(LengthPercentage::Length(l)) => match l.length_unit() {
            LengthUnit::Em => f64::from(l.unitless_value()) * em,
            LengthUnit::Rem => f64::from(l.unitless_value()) * rem,
            LengthUnit::Lh => f64::from(l.unitless_value()) * lh,
            LengthUnit::Rlh => f64::from(l.unitless_value()) * rlh,
            _ => f64::from(l.to_px_if_absolute()?),
        },
        _ => return None,
    };
    if !(px > 0.0 && px.is_finite()) {
        return None;
    }
    let px = (px * 1e6).round() / 1e6;
    parts.push(format!("{}px", crate::numbers::to_js_string(px)));
    parts.push(font.family.iter().map(|f| f.to_css_string()).collect::<Vec<_>>().join(", "));
    let family = font.family.iter().next().map_or_else(String::new, family_name);
    Some(CanvasFont { css: parts.join(" "), px, weight, slant, small_caps, family })
}
// A family as a name: a family name as written, a generic family's keyword.
fn family_name(f: &style::values::computed::font::SingleFontFamily) -> String {
    use style::values::computed::font::SingleFontFamily;
    match f {
        SingleFontFamily::FamilyName(name) => name.name.to_string(),
        SingleFontFamily::Generic(generic) => generic.to_css_string(),
    }
}

// A canvas's `letterSpacing` / `wordSpacing` (HTML §4.12.5.1.11): the CSS `<length>` `text`, serialized, and in px —
// a font-relative one of the current font's size `em` (`ex` and `ch` half of it, `ic` all of it, absent the glyphs
// that would say), `rem` of the root's; one that needs what a canvas has not (a viewport, a container, a line height)
// 0. None where it is no length.
pub(crate) fn canvas_spacing(text: &str, em: f64, rem: f64) -> Option<(String, f64)> {
    use style::parser::Parse;
    use style::values::specified::length::LengthUnit;
    use style::values::specified::{Length, LengthPercentage};
    let url = url_data("about:blank");
    let context = context(&url, Kind::Style, false);
    let mut input = ParserInput::new(text.trim());
    let mut parser = Parser::new(&mut input);
    let length = parser.parse_entirely(|p| Length::parse(&context, p)).ok()?;
    let css = length.to_css_string();
    let px = match LengthPercentage::from(length) {
        LengthPercentage::Length(l) => {
            let v = f64::from(l.unitless_value());
            match l.length_unit() {
                LengthUnit::Em | LengthUnit::Ic => v * em,
                LengthUnit::Ex | LengthUnit::Ch => v * 0.5 * em,
                LengthUnit::Rem => v * rem,
                _ => l.to_px_if_absolute().map_or(0.0, f64::from),
            }
        }
        // (…a `calc()` of absolute lengths only)
        LengthPercentage::Calc(c) => c.to_computed_pixel_length_without_context().map_or(0.0, f64::from),
        LengthPercentage::Percentage(_) => return None,
    };
    Some((css, px))
}

// …and the families it names, as names (`document.fonts.check()` / `load()`): None where it is no `font` value.
pub(crate) fn font_shorthand_families(text: &str) -> Option<Vec<String>> {
    Some(font_shorthand(text)?.family.iter().map(family_name).collect())
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
