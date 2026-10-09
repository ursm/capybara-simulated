// CSS transitions as the Web Animations model runs them (css-transitions-1 §3, css-transitions-2 §4 – §6): an animation
// a style change started, of one property from its value in the before-change style to its value in the after-change
// style, which its owner's later style changes cancel, reverse or replace — and which owes `transitionrun` /
// `transitionstart` / `transitionend` / `transitioncancel` as its phase moves (css.rs). The style engine reads what a
// style change did to each transitioning property into `TransitionChange`s (`style.rs`); the model does the rest, as
// Gecko's `nsTransitionManager` and `CSSTransition` do.

use style::properties::animated_properties::AnimationValue;
use style::properties::{OwnedPropertyDeclarationId, PropertyDeclarationBlock};
use style::shared_lock::SharedRwLock;
use style::values::computed::easing::ComputedTimingFunction;
use style::values::generics::easing::BeforeFlag;
use style::servo_arc::Arc;

use crate::animations::{
    AnimationId, Animations, CompositeOperation, ComputedFrame, ComputedKeyframes, EffectTiming, FillMode, Keyframe,
    PlayState, Target,
};
use crate::css::CssKind;

// What a CSS transition is besides an animation and its owner (css.rs): the property it transitions; the style change
// that started it, among its owner's — what transitions of one element sort by (css-transitions-2 §4.1); the value it
// ends at; and what a reversal of it is measured against (css-transitions-1 §3.1): the value it was reversing from, and
// how much of its own run it was shortened to.
#[derive(Clone, Debug)]
pub(crate) struct CssTransition {
    pub(crate) property: OwnedPropertyDeclarationId,
    pub(crate) generation: u64,
    pub(crate) end_value: AnimationValue,
    pub(crate) reversing_adjusted_start: AnimationValue,
    pub(crate) reversing_shortening_factor: f64,
}

// A transition that ran to its end with nothing holding it (css-transitions-1 §3 "completed transition"): all that is
// left of it to matter is its end value — whether a later change starts another — so that is all that is kept of it, not
// an animation every frame walks.
#[derive(Clone, Debug)]
pub(crate) struct CompletedTransition {
    pub(crate) owner: Target,
    pub(crate) property: OwnedPropertyDeclarationId,
    pub(crate) end_value: AnimationValue,
}

// What a style change did to one property the after-change style's `transition-property` lists (css-transitions-1 §3):
// its value before and after, whether the two transition (an animatable property, and one that interpolates between
// them or is allowed to animate discretely — the same question of the running transition's current value), and the
// duration, delay and timing function of the item that lists it.
pub(crate) struct TransitionChange {
    pub(crate) property: OwnedPropertyDeclarationId,
    pub(crate) before: AnimationValue,
    pub(crate) after: AnimationValue,
    pub(crate) animatable: bool,
    pub(crate) allow_discrete: bool,
    pub(crate) duration: f64,
    pub(crate) delay: f64,
    pub(crate) easing: ComputedTimingFunction,
}

impl TransitionChange {
    fn transitionable(&self, from: &AnimationValue) -> bool {
        self.animatable && (self.allow_discrete || from.interpolable_with(&self.after))
    }
}

impl Animations {
    // The CSS transitions `owner`'s style started and still owns: running, completed, or canceled by a script.
    pub(crate) fn css_transitions_of(&self, owner: &Target) -> Vec<AnimationId> {
        self.owned_by(owner).filter(|&id| self.css_transition(id).is_some()).collect()
    }

    // (…a completed one kept as its end value included: a style change that no longer lists it is what forgets it.)
    pub(crate) fn has_css_transitions(&self, owner: &Target) -> bool {
        self.owned_by(owner).any(|id| self.css_transition(id).is_some()) || self.completed_of(owner).next().is_some()
    }

    fn css_transition(&self, id: AnimationId) -> Option<&CssTransition> {
        self.animations.get(&id)?.css.as_ref()?.transition()
    }

    // The properties `owner` has a transition of: running, completed, or canceled by a script.
    pub(crate) fn transitioning_properties(&self, owner: &Target) -> Vec<OwnedPropertyDeclarationId> {
        let owned = self.css_transitions_of(owner).into_iter().map(|id| self.css_transition(id).unwrap().property.clone());
        owned.chain(self.completed_of(owner).map(|c| c.property.clone())).collect()
    }

    fn completed_of<'a>(&'a self, owner: &'a Target) -> impl Iterator<Item = &'a CompletedTransition> + 'a {
        self.completed_transitions.get(&owner.node).into_iter().flatten().filter(move |c| c.owner == *owner)
    }

    // …and a completed one of `property` is gone.
    fn forget_completed(&mut self, owner: &Target, property: &OwnedPropertyDeclarationId) {
        if let Some(list) = self.completed_transitions.get_mut(&owner.node) {
            list.retain(|c| !(c.owner == *owner && c.property == *property));
            if list.is_empty() {
                self.completed_transitions.remove(&owner.node);
            }
        }
    }

    // The CSS transitions a frame found over — and its events sent — with no handle to hold them: kept as their end
    // values from now on (`CompletedTransition`), and the animations let go.
    pub(crate) fn retire_completed_transitions(&mut self, ids: &[AnimationId]) {
        for &id in ids {
            let Some(a) = self.animations.get(&id) else { continue };
            let Some((owner, transition)) = a.css.as_ref().and_then(|css| Some((css.owner.clone()?, css.transition()?)))
            else {
                continue;
            };
            let over = a.css.as_ref().unwrap().last_phase() == crate::animations::Phase::After;
            if a.handled || !over || self.play_state(id) != PlayState::Finished {
                continue;
            }
            let record = CompletedTransition { owner: owner.clone(), property: transition.property.clone(), end_value: transition.end_value.clone() };
            self.completed_transitions.entry(owner.node).or_default().push(record);
            self.let_go(id);
        }
    }

    // Every completed transition whose owner `keep` no longer keeps (not rendered, gone) is forgotten.
    pub(crate) fn forget_completed_transitions(&mut self, mut keep: impl FnMut(&Target) -> bool) {
        self.completed_transitions.retain(|_, list| {
            list.retain(|c| keep(&c.owner));
            !list.is_empty()
        });
    }

    // A style change event on `owner` (css-transitions-1 §3 "Starting of transitions"): each property its after-change
    // style lists (`listed`) and the change can have moved (`changes`) starts, reverses, replaces or cancels its
    // transition as the change says; a transition of a property it does not list is canceled, or let go where it is
    // over. With none listed — the owner no longer rendered, or gone — every one is.
    pub(crate) fn update_css_transitions(
        &mut self,
        owner: &Target,
        listed: &[OwnedPropertyDeclarationId],
        changes: Vec<TransitionChange>,
        lock: &SharedRwLock,
    ) {
        self.style_changes += 1;
        let generation = self.style_changes;
        for id in self.css_transitions_of(owner) {
            let property = &self.css_transition(id).unwrap().property;
            if !listed.contains(property) {
                self.end_css_transition(id);
            }
        }
        let unlisted: Vec<OwnedPropertyDeclarationId> =
            self.completed_of(owner).map(|c| c.property.clone()).filter(|p| !listed.contains(p)).collect();
        for property in unlisted {
            self.forget_completed(owner, &property);
        }
        for change in changes {
            self.consider_transition(owner, change, generation, lock);
        }
    }

    // A transition its owner's style no longer has: canceled if it is running, let go if it is over (css-transitions-1
    // §3 step 3).
    fn end_css_transition(&mut self, id: AnimationId) {
        match self.play_state(id) {
            PlayState::Running | PlayState::Paused => self.cancel_from_style(id),
            _ => self.let_go(id),
        }
    }

    // css-transitions-1 §3, for one property.
    fn consider_transition(&mut self, owner: &Target, change: TransitionChange, generation: u64, lock: &SharedRwLock) {
        let existing: Vec<AnimationId> = self
            .css_transitions_of(owner)
            .into_iter()
            .filter(|&id| self.css_transition(id).is_some_and(|t| t.property == change.property))
            .collect();
        // (A running transition is one not over; a completed one is over — one a page still holds, or the end value
        // kept of it; one a script canceled is neither, and goes.)
        let (mut running, mut held) = (None, None);
        for id in existing {
            match self.play_state(id) {
                PlayState::Running | PlayState::Paused => running = Some(id),
                PlayState::Finished => held = Some(id),
                PlayState::Idle => self.let_go(id),
            }
        }
        let completed_end = match held {
            Some(id) => Some(self.css_transition(id).unwrap().end_value.clone()),
            None => self.completed_of(owner).find(|c| c.property == change.property).map(|c| c.end_value.clone()),
        };
        let forget_completed = |model: &mut Animations| {
            match held {
                Some(id) => model.let_go(id),
                None => model.forget_completed(owner, &change.property),
            }
        };
        let combined_duration = change.duration.max(0.0) + change.delay;
        // Step 1: none running, a change, one that transitions, not the end of a completed one, and time to run in.
        if running.is_none()
            && change.before != change.after
            && change.transitionable(&change.before)
            && completed_end.as_ref().is_none_or(|end| *end != change.after)
            && combined_duration > 0.0
        {
            if completed_end.is_some() {
                forget_completed(self);
            }
            let (from, to) = (change.before.clone(), change.after.clone());
            self.start_transition(owner, &change, from, to, None, generation, lock);
            return;
        }
        // Step 2: a completed transition to another value is gone.
        if completed_end.is_some_and(|end| end != change.after) {
            forget_completed(self);
        }
        // Step 4: a running transition to another value.
        let Some(id) = running else { return };
        let old = self.css_transition(id).unwrap().clone();
        if old.end_value == change.after {
            return;
        }
        let current = self.current_value(id, &change.property).unwrap_or_else(|| change.before.clone());
        if current == change.after || !change.transitionable(&current) || combined_duration <= 0.0 {
            self.cancel_from_style(id);
            return;
        }
        // (Sent back where it came from, it takes as long as it has run — shortened as the running one was.)
        let reversal = (old.reversing_adjusted_start == change.after).then(|| {
            let progress = self.transition_output(id);
            let factor = (progress * old.reversing_shortening_factor + (1.0 - old.reversing_shortening_factor)).abs().clamp(0.0, 1.0);
            (old.end_value.clone(), factor)
        });
        self.cancel_from_style(id);
        self.start_transition(owner, &change, current, change.after.clone(), reversal, generation, lock);
    }

    // A transition of `change`'s property from `from` to `to`, started by the style change `generation`: its effect
    // fills backwards through its delay and eases by the timing function between the two (css-transitions-2 §4), and is
    // played. A `reversal` — what it reverses from and its shortening factor — shortens its duration and a negative
    // delay by the factor.
    #[allow(clippy::too_many_arguments)]
    fn start_transition(
        &mut self,
        owner: &Target,
        change: &TransitionChange,
        from: AnimationValue,
        to: AnimationValue,
        reversal: Option<(AnimationValue, f64)>,
        generation: u64,
        lock: &SharedRwLock,
    ) {
        let (reversing_adjusted_start, factor) = reversal.unwrap_or_else(|| (from.clone(), 1.0));
        let delay = if change.delay < 0.0 { change.delay * factor } else { change.delay };
        let timing =
            EffectTiming { duration: change.duration * factor, delay, fill: FillMode::Backwards, ..EffectTiming::default() };
        let effect = self.new_effect(timing);
        let block = |value: &AnimationValue| {
            let mut block = PropertyDeclarationBlock::new();
            block.push(value.uncompute(), style::properties::Importance::Normal);
            Arc::new(lock.wrap(block))
        };
        let frame = |offset: f64, easing: Option<ComputedTimingFunction>, value: &AnimationValue| ComputedFrame {
            offset,
            easing,
            composite: CompositeOperation::Replace,
            value: value.clone(),
        };
        let e = self.effects.get_mut(&effect).unwrap();
        e.keyframes = vec![
            Keyframe { offset: 0.0, easing: Some(change.easing.clone()), composite: None, block: block(&from) },
            Keyframe { offset: 1.0, easing: None, composite: None, block: block(&to) },
        ];
        // (Its keyframes are values already: nothing computes them again.)
        e.computed = Some(ComputedKeyframes {
            properties: vec![(
                change.property.clone(),
                vec![frame(0.0, Some(change.easing.clone()), &from), frame(1.0, None, &to)],
                None,
            )],
        });
        e.given = true;
        self.set_target(effect, Some(owner.clone()));
        let id = self.new_animation(Some(effect), Some(0.0));
        let transition = CssTransition {
            property: change.property.clone(),
            generation,
            end_value: to,
            reversing_adjusted_start,
            reversing_shortening_factor: factor,
        };
        self.own(id, owner, CssKind::Transition(transition));
        let _ = self.play(id, true);
    }

    // The output of a transition's timing function where it stands now: how far along its run it has come.
    fn transition_output(&self, id: AnimationId) -> f64 {
        let Some(effect) = self.animations[&id].effect.and_then(|e| self.effects.get(&e)) else { return 0.0 };
        let progress = self.computed_timing_of(effect).and_then(|t| t.progress).unwrap_or(0.0).clamp(0.0, 1.0);
        match effect.keyframes.first().and_then(|k| k.easing.as_ref()) {
            Some(easing) => easing.calculate_output(progress, BeforeFlag::Unset, 1e-7),
            None => progress,
        }
    }
}
