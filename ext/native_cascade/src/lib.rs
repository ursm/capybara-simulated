// The native cascade accelerator. First increment: scaffold + a boundary benchmark, so the
// packaging (rb-sys fat gems, like rusty_racer) and the JS↔Ruby↔Rust round trip are proven before
// any cascade logic lands. Exposes `Capybara::Simulated::Native`.
use magnus::{function, prelude::*, Error, Ruby};

// Boundary benchmark: sum a Vec<i64> handed across the boundary. Measures the marshalling cost of
// moving per-element integer data Ruby→Rust — the shape the selector matcher will consume. (The
// extension is required, so there is no `available?` — a missing build fails the load, not a query.)
fn bench_sum(v: Vec<i64>) -> i64 {
    v.iter().copied().sum()
}

#[magnus::init]
fn init(ruby: &Ruby) -> Result<(), Error> {
    let module = ruby
        .define_module("Capybara")?
        .define_module("Simulated")?
        .define_module("Native")?;
    module.define_singleton_method("bench_sum", function!(bench_sum, 1))?;
    Ok(())
}
