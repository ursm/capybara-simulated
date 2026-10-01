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
// The native author cascade: a realm's static rules, and one element's winning declarations in one pass.
mod cascade;
mod document_encoding;
mod dom;
mod element_state;
// Native text metrics (fontations) — used IN-PROCESS by native inline layout (L2, mod layout); JS
// registers a font (registerFontPath) to a handle it passes in the layout inputs.
mod font;
// HTML's presentational hints: the declarations an element's attributes add to the cascade.
mod hints;
mod html_parse;
// Native layout (reader-flip endgame), stage L1 = block flow. Driven by the layoutPass / boxOf ops.
mod layout;
mod selector;
// The style engine: stylo over the arena.
mod style;
mod style_fonts;
// The Unicode classes the ORACLE asks a regex for, parsed out of that same regex by regex-syntax.
mod text_codec;
mod unicode;
mod url_ops;
mod validity;
mod walk;
mod walk_ops;
mod walk_reuse;

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
    // …and expose them: the suite checks them against what the ORACLE's own engine answers for the same
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
