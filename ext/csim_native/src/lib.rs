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
mod css;
mod css_animations;
mod css_transitions;
mod cssom_decl;
mod cssom_rule;
// The native author cascade: a realm's static rules, and one element's winning declarations in one pass.
mod document_encoding;
mod dom;
mod element_state;
// Native text metrics (fontations) — used IN-PROCESS by inline layout (mod layout); the JS side
// registers a font (registerFontPath) to a handle it names the face by (`walkFace`).
mod font;
mod geometry;
// HTML's presentational hints: the declarations an element's attributes add to the cascade.
mod hints;
mod hit_test;
mod html_parse;
// Layout: the records the walk builds (mod walk) laid out, driven by the `layoutBuild` op (mod walk_ops).
mod layout;
// Bringing a box into view: the scroll boxes that move, and to where (`scrollIntoView`, a driver's scroll-if-needed).
// What is rendered, and the text it renders (`innerText`, the visible text a driver reads).
mod rendered;
mod resolved;
mod scroll_into_view;
mod selector;
mod sheets;
// The style engine: stylo over the arena.
mod style;
mod style_fonts;
mod text_codec;
// The Unicode classes layout asks of a character, parsed out of the regex that spells them by regex-syntax.
mod unicode;
mod url_ops;
mod validity;
mod walk;
mod walk_ops;
mod walk_reuse;
mod xpath;

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
    let native = ruby
        .define_module("Capybara")?
        .define_module("Simulated")?
        .define_module("Native")?;
    native.define_module_function("unicode_class_ranges", magnus::function!(unicode::class_ranges, 1))?;
    // HTML's "encode" for a form the host submits in its legacy submission encoding.
    native.define_module_function("form_encode", magnus::function!(text_codec::form_encode, 2))?;
    Ok(())
}
