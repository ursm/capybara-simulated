// The order the host takes what its documents planned — which navigation goes before which, and which questions decide
// whether a kind is taken at all — the engine's, one step at a time (`PlanTakes#next`), as navigate.rs runs a navigation:
// the host carries each step out (browser.rb `take_plans`) and answers the questions. What wins between two plans of one
// navigable is the plan's own (navigation_plan.rs `supersede`); this is the order the kinds are taken in, which decides
// what a navigation taken first leaves for the next to find.
//
// Three passes:
// - `drain` (browser.rb `drain_pending_navigation`): a traversal queued ahead of a navigation another window asked of
//   the page first (the page traversing ignores it, HTML "navigate"); what other windows asked of this one; the
//   navigation turn queued on the event loop, behind what was due before it; a traversal moving a frame the turn made
//   due; a service worker's `WindowClient.navigate()`; the navigations parked on an activating worker; then, where the
//   page planned anything, its location navigation and the frames' submissions; the windows' navigations whatever the
//   page planned (a window's newly loaded document may plan the page's — its opener's reload — which the takes after it
//   take in this same pass); the frames', the page's submission, the reloads and a hyperlink's new window where anything
//   is planned now; and what the windows planned meanwhile.
// - `turn` (browser.rb `take_frame_navigations_due`): at the event loop's navigation turn, a traversal queued with them
//   first, then the forms' — each a task HTML "plan to navigate" queued, which runs ahead of the parallel steps a
//   navigation of the form's own document is at — then the frames' navigations, the windows' with them, and their
//   reloads; another turn queued where what they made planned again.
// - `windows` (browser.rb `consume_pending_window_nav`): a traversal a window's script queued first, then the windows'
//   navigations round by round — what the documents they made planned as they loaded taken with them — up to
//   `WINDOW_ROUNDS`: a document that navigates itself as it loads, again and again, goes on at the next drain.
// - `load` (browser.rb `take_load_navigations`): what a document planned as it loaded, taken as the driver's action that
//   loaded it ends — the turn first, a traversal it made due, the forms', the windows', the frames', then the page's
//   location, a frame's submission into it, a hyperlink's and its own form's.
// - `intents` (browser.rb `drain_task_intents`, after a `drain`): where anything is planned still, a hyperlink's, a
//   form's, a download.
// - `submission` (browser.rb `click`'s submit): after a click whose form planned a submission, and the tasks its
//   handlers queued, the windows' and frames' navigations, then the page's location — which, planned after the
//   submission, superseded it — then the submission, where it still stands.

use std::cell::Cell;

use magnus::{function, method, prelude::*, Error, RModule, Ruby, Value};

const WINDOW_ROUNDS: u32 = 8;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pass {
    Drain,
    Turn,
    Windows,
    Load,
    Intents,
    Submission,
}

#[magnus::wrap(class = "Capybara::Simulated::Native::PlanTakes", free_immediately)]
pub(crate) struct PlanTakes {
    pass: Pass,
    at: Cell<u32>,
    planned: Cell<bool>,
    rounds: Cell<u32>,
}

impl PlanTakes {
    fn of(pass: Pass) -> Self {
        PlanTakes { pass, at: Cell::new(0), planned: Cell::new(false), rounds: Cell::new(0) }
    }
    // PlanTakes.drain / .turn / .windows -> a pass of the host's takes.
    fn drain() -> Self {
        Self::of(Pass::Drain)
    }
    fn turn() -> Self {
        Self::of(Pass::Turn)
    }
    fn windows() -> Self {
        Self::of(Pass::Windows)
    }
    fn load() -> Self {
        Self::of(Pass::Load)
    }
    fn intents() -> Self {
        Self::of(Pass::Intents)
    }
    fn submission() -> Self {
        Self::of(Pass::Submission)
    }

    // #next(answer) -> its next step for the host, which answered the last with `answer` — a question's answer, or, of
    // `window_navigations`, whether it took any — nil once it is done. A step is a take (`location`, `frame_navigations`,
    // …) or a question ending in `?` (`takes_planned?`: is anything of the page's planned; `windows?`: has the isolate
    // windows `window.open` made; `windows_planned?`; `frames_planned?`: did the frames' documents plan again).
    fn next(&self, answer: Value) -> Option<&'static str> {
        self.step(answer.to_bool())
    }
    fn step(&self, answer: bool) -> Option<&'static str> {
        loop {
            let at = self.at.get();
            self.at.set(at + 1);
            let step = match self.pass {
                Pass::Drain => match at {
                    0 => "traversals_before",
                    1 => "window_tasks",
                    2 => "navigation_turn",
                    3 => "planned_traversal",
                    4 => "sw_client_navigations",
                    5 => "sw_deferred_navigations",
                    6 => "takes_planned?",
                    7 => {
                        self.planned.set(answer);
                        if !answer {
                            self.at.set(9);
                            continue;
                        }
                        "location"
                    }
                    8 => "frame_submissions",
                    9 => "window_navigations",
                    10 if self.planned.get() => continue,
                    10 => "windows?",
                    11 if self.planned.get() => continue,
                    11 if !answer => {
                        self.at.set(18);
                        continue;
                    }
                    11 => "takes_planned?",
                    12 if !self.planned.get() && !answer => {
                        self.at.set(18);
                        continue;
                    }
                    12 => "frame_navigations",
                    13 => "page_submission",
                    14 => "frame_reloads",
                    15 => "reload",
                    16 => "aux_window",
                    17 | 18 => {
                        self.at.set(19);
                        "windows_planned?"
                    }
                    19 if answer => "window_navigations",
                    _ => return None,
                },
                Pass::Turn => match at {
                    0 => "traversals_at_turn",
                    1 => "frame_submissions",
                    2 => "window_navigations",
                    3 => "frame_navigations",
                    4 => "frame_reloads",
                    5 => "frames_planned?",
                    6 if answer => "queue_navigation_turn",
                    _ => return None,
                },
                Pass::Load => *[
                    "navigation_turn",
                    "planned_traversal",
                    "frame_submissions",
                    "window_navigations",
                    "frame_navigations",
                    "location",
                    "page_submission",
                    "navigation",
                    "form_submission",
                ]
                .get(at as usize)?,
                Pass::Intents => match at {
                    0 => "takes_planned?",
                    1 if answer => "navigation",
                    2 => "form_submission",
                    3 => "download",
                    _ => return None,
                },
                Pass::Submission => *["window_navigations", "frame_navigations", "location", "form_submission"].get(at as usize)?,
                Pass::Windows => match at {
                    0 => "window_traversals",
                    // (…round by round, while a round took any)
                    _ if at > 1 && !answer => return None,
                    _ if self.rounds.get() >= WINDOW_ROUNDS => return None,
                    _ => {
                        self.rounds.set(self.rounds.get() + 1);
                        "window_navigation_round"
                    }
                },
            };
            return Some(step);
        }
    }
}

pub(crate) fn define(native: RModule, ruby: &Ruby) -> Result<(), Error> {
    let class = native.define_class("PlanTakes", ruby.class_object())?;
    class.define_singleton_method("drain", function!(PlanTakes::drain, 0))?;
    class.define_singleton_method("turn", function!(PlanTakes::turn, 0))?;
    class.define_singleton_method("windows", function!(PlanTakes::windows, 0))?;
    class.define_singleton_method("load", function!(PlanTakes::load, 0))?;
    class.define_singleton_method("intents", function!(PlanTakes::intents, 0))?;
    class.define_singleton_method("submission", function!(PlanTakes::submission, 0))?;
    class.define_method("next", method!(PlanTakes::next, 1))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The steps a pass gives, each question answered by `answers` in turn, a take answered false.
    fn run(takes: PlanTakes, answers: &[bool]) -> Vec<&'static str> {
        let mut answers = answers.iter().copied();
        let mut out = Vec::new();
        let mut answer = false;
        while let Some(step) = takes.step(answer) {
            out.push(step);
            answer = if step.ends_with('?') || step == "window_navigation_round" { answers.next().unwrap_or(false) } else { false };
        }
        out
    }

    #[test]
    fn a_drain_takes_the_pages_plans_only_where_it_planned_any() {
        let head = ["traversals_before", "window_tasks", "navigation_turn", "planned_traversal", "sw_client_navigations", "sw_deferred_navigations", "takes_planned?"];
        let planned = run(PlanTakes::drain(), &[true, false]);
        assert_eq!(planned[..7], head);
        assert_eq!(
            planned[7..],
            ["location", "frame_submissions", "window_navigations", "frame_navigations", "page_submission", "frame_reloads", "reload", "aux_window", "windows_planned?"]
        );
        // (…none planned and no windows: the windows' navigations alone)
        assert_eq!(run(PlanTakes::drain(), &[false, false, false])[7..], ["window_navigations", "windows?", "windows_planned?"]);
        // (…a window's document planning the page's as it loaded: taken in the same pass, and what the windows planned)
        assert_eq!(
            run(PlanTakes::drain(), &[false, true, true, true])[7..],
            ["window_navigations", "windows?", "takes_planned?", "frame_navigations", "page_submission", "frame_reloads", "reload", "aux_window", "windows_planned?", "window_navigations"]
        );
    }

    #[test]
    fn a_turn_takes_the_forms_first_and_queues_another_where_they_planned_again() {
        assert_eq!(
            run(PlanTakes::turn(), &[true]),
            ["traversals_at_turn", "frame_submissions", "window_navigations", "frame_navigations", "frame_reloads", "frames_planned?", "queue_navigation_turn"]
        );
        assert_eq!(run(PlanTakes::turn(), &[false]).last(), Some(&"frames_planned?"));
    }

    #[test]
    fn what_is_planned_still_is_taken_only_where_anything_is() {
        assert_eq!(run(PlanTakes::intents(), &[true]), ["takes_planned?", "navigation", "form_submission", "download"]);
        assert_eq!(run(PlanTakes::intents(), &[false]), ["takes_planned?"]);
        assert_eq!(run(PlanTakes::submission(), &[]), ["window_navigations", "frame_navigations", "location", "form_submission"]);
        assert_eq!(run(PlanTakes::load(), &[]).len(), 9);
    }

    #[test]
    fn the_windows_are_taken_round_by_round_while_a_round_takes_any() {
        assert_eq!(run(PlanTakes::windows(), &[true, false]), ["window_traversals", "window_navigation_round", "window_navigation_round"]);
        assert_eq!(run(PlanTakes::windows(), &[true; 20]).len(), 1 + WINDOW_ROUNDS as usize);
    }
}
