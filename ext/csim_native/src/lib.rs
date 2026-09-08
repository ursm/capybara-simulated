// capybara-simulated's native extension.
//
// One cdylib that bundles the V8 engine (rusty_racer, linked as a library) and the
// native DOM (`mod dom`). Ruby loads THIS .so; it defines the same RustyRacer::*
// surface by calling rusty_racer's own class installer, then registers the native
// DOM to be installed into every realm through rusty_racer's generic hook. The
// engine itself stays a pure V8 binding with no DOM knowledge.

mod dom;
// Native layout (reader-flip endgame), stage L1 = block flow. Driven by the layoutPass / boxOf ops.
mod layout;
mod selector;

use magnus::{Error, Ruby};

#[magnus::init]
fn init(ruby: &Ruby) -> Result<(), Error> {
    // Define RustyRacer::Isolate / Context / Snapshot / … exactly as the standalone
    // gem would — the engine code is the same, only the cdylib owner differs.
    rusty_racer::install_classes(ruby)?;
    // Install the native DOM (globalThis.__dom + its templates) into every realm,
    // main and frames alike, via the engine's DOM-agnostic seam.
    rusty_racer::set_realm_init_hook(dom::install);
    Ok(())
}
