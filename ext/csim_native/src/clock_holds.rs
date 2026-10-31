// How long a window's event loop holds its clock for a reply in flight that its own JavaScript cannot see — a controlled
// fetch's response from a service worker, a message's ack from a worker, a WebSocket's echoed close frame — each kind a
// budget of real time begun with the first step that holds for it and spent across the steps after, so a reply that
// never comes costs it once; refreshed as a reply comes in, or once none is owed (browser.rb `run_event_loop_frame`).
// One per Browser.

use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

const FETCH: usize = 0;
const MESSAGE: usize = 1;
const SOCKET_CLOSE: usize = 2;
const KINDS: usize = 3;

#[magnus::wrap(class = "Capybara::Simulated::Native::ClockHolds", free_immediately)]
pub(crate) struct ClockHolds {
    deadlines: Mutex<[Option<Instant>; KINDS]>,
}

impl ClockHolds {
    fn new() -> Self {
        ClockHolds { deadlines: Mutex::new(Default::default()) }
    }
    // #left(kind, budget) -> the seconds a hold of `kind` has left — its budget of `budget` seconds begun with the first
    // step that holds for it (≤ 0 once spent).
    fn left(&self, kind: usize, budget: f64) -> f64 {
        let mut deadlines = self.deadlines.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(hold) = deadlines.get_mut(kind) else { return 0.0 };
        let deadline = *hold.get_or_insert_with(|| Instant::now() + Duration::from_secs_f64(budget.max(0.0)));
        let now = Instant::now();
        if deadline >= now { deadline.duration_since(now).as_secs_f64() } else { -now.duration_since(deadline).as_secs_f64() }
    }
    // #reset(kind) — a reply of `kind` came in, or none is owed: the next one waits afresh.
    fn reset(&self, kind: usize) {
        if let Some(hold) = self.deadlines.lock().unwrap_or_else(PoisonError::into_inner).get_mut(kind) {
            *hold = None;
        }
    }
    // #settle(fetches, messages, socket_closes) — each kind whose reply is owed no more (true) let go of: what an
    // event-loop step does once its holds are behind it, in one call.
    fn settle(&self, fetches: bool, messages: bool, socket_closes: bool) {
        let mut deadlines = self.deadlines.lock().unwrap_or_else(PoisonError::into_inner);
        for (kind, settled) in [(FETCH, fetches), (MESSAGE, messages), (SOCKET_CLOSE, socket_closes)] {
            if settled {
                deadlines[kind] = None;
            }
        }
    }
    // #clear — none held: the session's reset.
    fn clear(&self) {
        *self.deadlines.lock().unwrap_or_else(PoisonError::into_inner) = Default::default();
    }
}

pub(crate) fn define(native: magnus::RModule, ruby: &magnus::Ruby) -> Result<(), magnus::Error> {
    use magnus::{function, method, Module, Object};
    let class = native.define_class("ClockHolds", ruby.class_object())?;
    class.const_set("FETCH", FETCH)?;
    class.const_set("MESSAGE", MESSAGE)?;
    class.const_set("SOCKET_CLOSE", SOCKET_CLOSE)?;
    class.define_singleton_method("new", function!(ClockHolds::new, 0))?;
    class.define_method("left", method!(ClockHolds::left, 2))?;
    class.define_method("reset", method!(ClockHolds::reset, 1))?;
    class.define_method("settle", method!(ClockHolds::settle, 3))?;
    class.define_method("clear", method!(ClockHolds::clear, 0))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hold_spends_its_budget_once() {
        let holds = ClockHolds::new();
        assert!(holds.left(FETCH, 0.0) <= 0.0);
        assert!(holds.left(FETCH, 10.0) <= 0.0);
        holds.reset(FETCH);
        assert!(holds.left(FETCH, 10.0) > 9.0);
        assert!(holds.left(MESSAGE, 10.0) > 9.0);
        holds.settle(false, true, false);
        assert!(holds.left(FETCH, 0.0) > 9.0);
        assert!(holds.left(MESSAGE, 0.0) <= 0.0);
    }
}
