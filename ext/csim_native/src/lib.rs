// capybara-simulated's native extension.
//
// One cdylib that bundles the V8 engine (rusty_racer, linked as a library) and the
// native DOM (`mod dom`). Ruby loads THIS .so; it defines the same RustyRacer::*
// surface by calling rusty_racer's own class installer, then registers the native
// DOM to be installed into every realm through rusty_racer's generic hook. The
// engine itself stays a pure V8 binding with no DOM knowledge.

// The Web Animations model: the timeline, animations and their effects' timing; and the ops a JS handle asks it with.
mod animation_ops;
mod animations;
mod autofocus;
mod av1;
mod canvas;
mod canvas_path;
mod caret;
mod clone;
mod collections;
mod css;
mod css_animations;
mod css_transitions;
mod cssom_decl;
mod cssom_rule;
// The native author cascade: a realm's static rules, and one element's winning declarations in one pass.
mod document_encoding;
mod dom;
mod dom_matrix;
mod element_state;
mod event_path;
mod focus;
// Native text metrics (fontations) — used IN-PROCESS by inline layout (mod layout); the JS side
// registers a font (registerFontPath) to a handle it names the face by (`walkFace`).
mod font;
mod font_faces;
mod form_entries;
mod fontconfig;
mod geometry;
// HTML's presentational hints: the declarations an element's attributes add to the cascade.
mod hints;
mod hit_test;
mod input_value;
mod html_parse;
mod image_decode;
mod image_encode;
mod image_source;
// Layout: the records the walk builds (mod walk) laid out, driven by the `layoutBuild` op (mod walk_ops).
mod layout;
mod legacy;
mod mime;
mod mutation;
mod mutation_observers;
mod namespaces;
mod node_handle;
mod numbers;
mod ranges;
mod reflect;
// Bringing a box into view: the scroll boxes that move, and to where (`scrollIntoView`, a driver's scroll-if-needed).
// What is rendered, and the text it renders (`innerText`, the visible text a driver reads).
mod rendered;
mod resolved;
mod scroll_boxes;
mod scroll_into_view;
mod selector;
mod serialize;
mod sheets;
mod slots;
// The style engine: stylo over the arena.
mod style;
mod style_fonts;
mod svg_geometry;
mod tables;
mod text;
mod text_codec;
mod text_selection;
mod token_list;
mod traversal;
// The Unicode classes layout asks of a character, parsed out of the regex that spells them by regex-syntax.
mod unicode;
mod url_ops;
mod validity;
mod values;
mod video;
mod walk;
mod walk_ops;
mod walk_reuse;
mod xpath;
mod yuv;

use magnus::{Error, Module, Ruby};

#[magnus::init]
fn init(ruby: &Ruby) -> Result<(), Error> {
    // Define RustyRacer::Isolate / Context / Snapshot / … exactly as the standalone
    // gem would — the engine code is the same, only the cdylib owner differs.
    rusty_racer::install_classes(ruby)?;
    // Install the native DOM (globalThis.__dom + its templates) into every realm,
    // main and frames alike, via the engine's DOM-agnostic seam.
    rusty_racer::set_realm_init_hook(dom::install);
    // Build the Unicode class tables now: a regex-syntax feature missing at build time has to surface HERE, at
    // `require`, where magnus turns the panic into a Ruby-level failure that names it — not later on the
    // layout path, which runs inside a V8 `extern "C"` callback where the unwind aborts the process instead.
    unicode::init();
    // …and expose them: the suite checks them against what the JS engine (V8) answers for the same
    // regex, which is the invariant `unicode.rs` rests on. Nothing in the driver itself calls this.
    // fontconfig resolves every font family: a machine without it fails here, saying so, not on the first page.
    fontconfig::require().map_err(|e| Error::new(ruby.exception_load_error(), e))?;
    let native = ruby
        .define_module("Capybara")?
        .define_module("Simulated")?
        .define_module("Native")?;
    native.define_module_function("unicode_class_ranges", magnus::function!(unicode::class_ranges, 1))?;
    // HTML's "encode" for a form the host submits in its legacy submission encoding.
    native.define_module_function("form_encode", magnus::function!(text_codec::form_encode, 2))?;
    // An image resource's bytes decoded to RGBA, on whichever thread fetched them.
    native.define_module_function("decode_image", magnus::function!(image_decode::decode_for_ruby, 3))?;
    // A web font's file unwrapped from its WOFF / WOFF2 container.
    native.define_module_function("font_sfnt", magnus::function!(font::sfnt_for_ruby, 1))?;
    // A font pattern matched, and the families it is substituted through, by this machine's fontconfig.
    native.define_module_function("font_match", magnus::function!(fontconfig::font_match_for_ruby, 1))?;
    native.define_module_function("font_strong_families", magnus::function!(fontconfig::strong_families_for_ruby, 1))?;
    // A URL's parts as the URL Standard's parser makes them, the page's own (url_ops.rs).
    native.define_module_function("url_parts", magnus::function!(url_ops::parts_for_ruby, 2))?;
    Ok(())
}
