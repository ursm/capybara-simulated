// The font metrics stylo asks for (`ex`, `ch`, `cap`, `ic` units, `font-size-adjust`). SPIKE: the defaults.

use style::device::servo::FontMetricsProvider;
use style::font_metrics::FontMetrics;
use style::values::computed::font::{GenericFontFamily, QueryFontMetricsFlags};
use style::values::computed::{CSSPixelLength, Length};

#[derive(Debug)]
pub(crate) struct Metrics;

impl FontMetricsProvider for Metrics {
    fn query_font_metrics(
        &self,
        _vertical: bool,
        _font: &style::properties::style_structs::Font,
        _size: CSSPixelLength,
        _flags: QueryFontMetricsFlags,
    ) -> FontMetrics {
        FontMetrics::default()
    }

    fn base_size_for_generic(&self, generic: GenericFontFamily) -> Length {
        Length::new(if generic == GenericFontFamily::Monospace { 13.0 } else { 16.0 })
    }
}
