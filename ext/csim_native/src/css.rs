// What an animation style made is besides an animation (css-animations-2 §3, css-transitions-2 §4): a CSS animation's or
// a CSS transition's own state (css_animations.rs, css_transitions.rs), and what the two share — the element (or
// pseudo-element) whose style owns it, none once that style lets it go; the index of owners style asks about every
// restyle; and the events it owes as its phase moves from one frame to the next, told from where it stood at the last.

use crate::animations::{AnimationId, Animations, Phase, PlayState, Target};
use crate::css_animations::CssAnimation;
use crate::css_transitions::CssTransition;
use crate::dom::NodeId;

#[derive(Clone, Debug)]
pub(crate) struct Css {
    pub(crate) owner: Option<Target>,
    pub(crate) kind: CssKind,
    previous: (Phase, Option<f64>),
}

#[derive(Clone, Debug)]
pub(crate) enum CssKind {
    Animation(CssAnimation),
    Transition(CssTransition),
}

impl Css {
    pub(crate) fn new(owner: &Target, kind: CssKind) -> Css {
        Css { owner: Some(owner.clone()), kind, previous: (Phase::Idle, None) }
    }

    pub(crate) fn animation(&self) -> Option<&CssAnimation> {
        if let CssKind::Animation(a) = &self.kind { Some(a) } else { None }
    }

    pub(crate) fn animation_mut(&mut self) -> Option<&mut CssAnimation> {
        if let CssKind::Animation(a) = &mut self.kind { Some(a) } else { None }
    }

    pub(crate) fn transition(&self) -> Option<&CssTransition> {
        if let CssKind::Transition(t) = &self.kind { Some(t) } else { None }
    }

    // The phase it stood in at the last frame, whose events it owed then.
    pub(crate) fn last_phase(&self) -> Phase {
        self.previous.0
    }

    // What its events and `getAnimations()` name it by: an animation's `@keyframes` name, a transition's property.
    pub(crate) fn name(&self) -> String {
        match &self.kind {
            CssKind::Animation(a) => a.name.clone(),
            CssKind::Transition(t) => t.property.as_borrowed().name().into_owned(),
        }
    }
}

// An event a CSS animation or transition owes (css-animations-2 §4.2, css-transitions-2 §6.1): its type and
// `elapsedTime` (seconds); the element (and pseudo-element) it is about, and the name and place among the owner's that
// the animation or transition had when it was queued (`animation-name` position, or the style change that started a
// transition); and when it was due on the timeline (ms) — which, then the composite order, is the order a rendering
// update dispatches them in.
#[derive(Clone, Debug)]
pub(crate) struct CssEvent {
    pub(crate) animation: AnimationId,
    pub(crate) kind: &'static str,
    pub(crate) elapsed: f64,
    pub(crate) owner: Target,
    pub(crate) transition: bool,
    pub(crate) name: String,
    pub(crate) order: u64,
    pub(crate) scheduled: f64,
}

impl Animations {
    // The animations and transitions `owner`'s style made and still owns.
    pub(crate) fn owned_by<'a>(&'a self, owner: &'a Target) -> impl Iterator<Item = AnimationId> + 'a {
        self.css_by_owner.get(&owner.node).into_iter().flatten().copied().filter(move |id| {
            self.animations[id].css.as_ref().is_some_and(|css| css.owner.as_ref() == Some(owner))
        })
    }

    // The owners of CSS animations and transitions (the elements; each pseudo-element's under its element's).
    pub(crate) fn css_owners(&self) -> impl Iterator<Item = NodeId> + '_ {
        self.css_by_owner.keys().copied()
    }

    // Animation `id` is `owner`'s from now on: a new CSS animation or transition, which has no handle until a script
    // asks for one, and whose effect none either.
    pub(crate) fn own(&mut self, id: AnimationId, owner: &Target, kind: CssKind) {
        self.css_by_owner.entry(owner.node).or_default().push(id);
        let a = self.animations.get_mut(&id).unwrap();
        a.handled = false;
        a.css = Some(Css::new(owner, kind));
        if let Some(e) = a.effect.and_then(|e| self.effects.get_mut(&e)) {
            e.orphaned = true;
        }
    }

    // A CSS animation or transition its owner's style no longer lists (or no longer renders): canceled while it is
    // still the owner's — its `…cancel` event is the owner's — and let go.
    pub(crate) fn cancel_from_style(&mut self, id: AnimationId) {
        self.cancel(id);
        self.touch(id);
        self.let_go(id);
    }

    // …or its owner is no longer rendered: a CSS animation canceled; a transition canceled while it runs, and let go
    // when it is over (css-transitions-1 §3: an element that is not rendered has no style to change).
    pub(crate) fn unrendered(&mut self, id: AnimationId) {
        let transition = self.animations[&id].css.as_ref().is_some_and(|css| css.transition().is_some());
        match self.play_state(id) {
            PlayState::Finished | PlayState::Idle if transition => self.let_go(id),
            _ => self.cancel_from_style(id),
        }
    }

    // …or let go without canceling (a completed transition, which is over anyway): what a script holding it makes of
    // it from now on, and gone if nothing does.
    pub(crate) fn let_go(&mut self, id: AnimationId) {
        let a = self.animations.get_mut(&id).unwrap();
        if let Some(owner) = a.css.as_mut().and_then(|css| css.owner.take()) {
            if let Some(list) = self.css_by_owner.get_mut(&owner.node) {
                list.retain(|&other| other != id);
                if list.is_empty() {
                    self.css_by_owner.remove(&owner.node);
                }
            }
        }
        if !self.animations[&id].handled {
            self.drop_animation(id);
        }
    }

    // The events CSS animation or transition `id` owes for where its phase moved since it was last looked at — at the
    // last frame, or `canceling` it, from where it stands to idle, which is looked at now — while its owner owns it.
    // Each is due when its `elapsedTime` falls on its own clock; a cancellation, now.
    pub(crate) fn queue_css_events(&mut self, id: AnimationId, canceling: bool) {
        let Some(a) = self.animations.get(&id) else { return };
        let Some(css) = a.css.as_ref() else { return };
        let Some(owner) = css.owner.clone() else { return };
        let timing = a.effect.and_then(|e| self.effects.get(&e)).map(|e| e.timing.clone());
        let current = self.current_time(id);
        let (phase, iteration) = match &timing {
            Some(t) if !canceling => {
                let computed = t.computed(current, a.playback_rate);
                (computed.phase, computed.current_iteration)
            },
            _ => (Phase::Idle, None),
        };
        let (was, was_iteration) = css.previous;
        if (was, was_iteration) == (phase, iteration) {
            return;
        }
        let timing = timing.unwrap_or_default();
        let active_duration = timing.active_duration();
        // (The interval its events report, a negative delay having run part of it before it started.)
        let start = (-timing.delay).min(active_duration).max(0.0);
        let end = (timing.end_time() - timing.delay).min(active_duration).max(0.0);
        let ran = current.map_or(0.0, |t| (t - timing.delay).clamp(0.0, active_duration));
        let (transition, order) = match &css.kind {
            CssKind::Animation(animation) => (false, animation.position as u64),
            CssKind::Transition(transition) => (true, transition.generation),
        };
        let events = if transition {
            transition_events(was, phase, start, end, ran)
        } else {
            let into_iteration = (iteration.unwrap_or(0.0) - timing.iteration_start).max(0.0) * timing.duration;
            animation_events(was, phase, start, end, into_iteration, ran)
        };
        let timeline = self.timeline_time_of(a).unwrap_or(0.0);
        // (…each due at a time of its timeline, scheduled at the document's — the time every animation's events are
        // sorted by, whichever timeline it is on)
        let origin = a.timeline.unwrap_or(0.0);
        let due = |kind: &str, elapsed: f64| match (a.start_time, a.playback_rate) {
            (Some(start), rate) if rate != 0.0 && !kind.ends_with("cancel") => start + (timing.delay + elapsed) / rate,
            _ => timeline,
        };
        let name = css.name();
        let queued: Vec<CssEvent> = events
            .iter()
            .map(|&(kind, elapsed)| CssEvent {
                animation: id,
                kind,
                elapsed: elapsed / 1000.0,
                owner: owner.clone(),
                transition,
                name: name.clone(),
                order,
                scheduled: due(kind, elapsed) + origin,
            })
            .collect();
        self.css_events.extend(queued);
        self.animations.get_mut(&id).unwrap().css.as_mut().unwrap().previous = (phase, iteration);
    }

    pub(crate) fn take_css_events(&mut self) -> Vec<CssEvent> {
        std::mem::take(&mut self.css_events)
    }
}

// The events an animation moving from phase `was` to `now` owes, with their elapsed times (css-animations-2 §4.2): the
// interval it reports runs from `start` to `end`, `into_iteration` is where the iteration it is in began, and `ran` the
// time it had run, which a cancellation reports.
fn animation_events(was: Phase, now: Phase, start: f64, end: f64, into_iteration: f64, ran: f64) -> Vec<(&'static str, f64)> {
    use Phase::*;
    match (was, now) {
        (Idle | Before, Active) => vec![("animationstart", start)],
        (Idle | Before, After) => vec![("animationstart", start), ("animationend", end)],
        (Active, Before) => vec![("animationend", start)],
        (Active, Active) => vec![("animationiteration", into_iteration)],
        (Active, After) => vec![("animationend", end)],
        (After, Active) => vec![("animationstart", end)],
        (After, Before) => vec![("animationstart", end), ("animationend", start)],
        (Before | Active, Idle) => vec![("animationcancel", ran)],
        _ => Vec::new(),
    }
}

// …and a transition's (css-transitions-2 §6.1), `transitionrun` first once it exists at all.
fn transition_events(was: Phase, now: Phase, start: f64, end: f64, ran: f64) -> Vec<(&'static str, f64)> {
    use Phase::*;
    match (was, now) {
        (Idle, Before) => vec![("transitionrun", start)],
        (Idle, Active) => vec![("transitionrun", start), ("transitionstart", start)],
        (Idle, After) => vec![("transitionrun", start), ("transitionstart", start), ("transitionend", end)],
        (Before, Active) => vec![("transitionstart", start)],
        (Before, After) => vec![("transitionstart", start), ("transitionend", end)],
        (Active, After) => vec![("transitionend", end)],
        (Active, Before) => vec![("transitionend", start)],
        (After, Active) => vec![("transitionstart", end)],
        (After, Before) => vec![("transitionstart", end), ("transitionend", start)],
        (Before | Active, Idle) => vec![("transitioncancel", ran)],
        _ => Vec::new(),
    }
}
