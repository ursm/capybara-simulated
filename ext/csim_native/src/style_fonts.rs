// The font metrics stylo asks for (`ex`, `ch`, and the ascent `font-size-adjust` and `cap` fall back on), read from the face
// the realm's JS side resolved the family to (`walk::SharedFaces`): its x-height and the advance of its `0`. A face not
// resolved yet is the defaults, noted for the next walk to name — and once it is told, the realm's styles are computed
// again (`walk_face`).

use style::device::servo::FontMetricsProvider;
use style::font_metrics::FontMetrics;
use style::values::computed::font::{GenericFontFamily, QueryFontMetricsFlags};
use style::values::computed::{CSSPixelLength, Length};

#[derive(Debug)]
pub(crate) struct Metrics {
    pub(crate) faces: crate::walk::SharedFaces,
}

impl FontMetricsProvider for Metrics {
    fn query_font_metrics(
        &self,
        _vertical: bool,
        font: &style::properties::style_structs::Font,
        size: CSSPixelLength,
        _flags: QueryFontMetricsFlags,
    ) -> FontMetrics {
        let key = crate::walk::face_key(font);
        let Some(face) = self.faces.with(|faces| faces.for_metrics(key)) else { return FontMetrics::default() };
        let size = size.px();
        let zero = crate::font::with_font(face.handle, |m| m.zero_advance()).unwrap_or(0.5) as f32;
        FontMetrics {
            x_height: Some(Length::new(face.xh as f32 * size)),
            zero_advance_measure: Some(Length::new(zero * size)),
            ascent: Length::new(face.asc as f32 * size),
            ..FontMetrics::default()
        }
    }

    fn base_size_for_generic(&self, generic: GenericFontFamily) -> Length {
        Length::new(if generic == GenericFontFamily::Monospace { 13.0 } else { 16.0 })
    }
}
