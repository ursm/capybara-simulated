// The Web Animations model (web-animations-1 §4): the document timeline, animations and their timing, and the timing
// of the effects they play. The engine owns every animation on a page — a script's (`element.animate`) and the ones
// CSS makes of styles — and a JS `Animation` / `KeyframeEffect` is a handle to one of these.
//
// Times are milliseconds, as the API reports them; the document timeline's time is the page's clock. What a script
// waits on — the `ready` and `finished` promises, the `finish` / `cancel` / `remove` events — is kept as state here
// and handed to the handles as `Signal`s: a promise is settled, or an event dispatched, by whoever holds the handle.

use std::collections::HashMap;

use style::properties::animated_properties::{AnimationValue, AnimationValueMap};
use style::properties::{OwnedPropertyDeclarationId, PropertyDeclarationBlock};
use style::selector_parser::PseudoElement;
use style::servo_arc::Arc;
use style::shared_lock::Locked;
use style::values::animated::{Animate, Procedure};
use style::values::computed::easing::ComputedTimingFunction;
use style::values::generics::easing::{BeforeFlag, TimingKeyword};

use crate::dom::NodeId;

pub(crate) type AnimationId = u32;
pub(crate) type EffectId = u32;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum FillMode {
    None,
    Forwards,
    Backwards,
    Both,
    Auto,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PlaybackDirection {
    Normal,
    Reverse,
    Alternate,
    AlternateReverse,
}

// An effect's timing properties (§4.5.3 – §4.8): its delays, fill, iterations and their duration, direction and
// easing. A duration of `auto` is 0 for a keyframe effect (§4.9.2).
#[derive(Clone, Debug)]
pub(crate) struct EffectTiming {
    pub(crate) delay: f64,
    pub(crate) end_delay: f64,
    pub(crate) fill: FillMode,
    pub(crate) iteration_start: f64,
    pub(crate) iterations: f64,
    pub(crate) duration: f64,
    pub(crate) direction: PlaybackDirection,
    pub(crate) easing: ComputedTimingFunction,
}

impl Default for EffectTiming {
    fn default() -> Self {
        EffectTiming {
            delay: 0.0,
            end_delay: 0.0,
            fill: FillMode::Auto,
            iteration_start: 0.0,
            iterations: 1.0,
            duration: 0.0,
            direction: PlaybackDirection::Normal,
            easing: ComputedTimingFunction::Keyword(TimingKeyword::Linear),
        }
    }
}

// Where an effect stands against its active interval (§4.8.3), as its local time puts it; `Idle` when it has none.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Phase {
    Before,
    Active,
    After,
    Idle,
}

// An effect's timing at one local time (§4.8 – §4.11), as `getComputedTiming()` reports it and composition reads it:
// its phase, active time, the iteration it is in and its progress through it (eased, and in the direction that
// iteration runs), all unresolved (None) where the effect is not in effect.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct ComputedTiming {
    pub(crate) phase: Phase,
    pub(crate) local_time: Option<f64>,
    pub(crate) active_duration: f64,
    pub(crate) end_time: f64,
    pub(crate) active_time: Option<f64>,
    pub(crate) current_iteration: Option<f64>,
    pub(crate) progress: Option<f64>,
}

impl EffectTiming {
    // The fill a keyframe effect has for `auto` (§4.8.2: none).
    fn fill(&self) -> FillMode {
        if self.fill == FillMode::Auto { FillMode::None } else { self.fill }
    }

    // §4.8.1: zero when either the iteration duration or the count is, whatever the other (0 × ∞ included).
    pub(crate) fn active_duration(&self) -> f64 {
        if self.duration == 0.0 || self.iterations == 0.0 { 0.0 } else { self.duration * self.iterations }
    }

    // §4.5.4.
    pub(crate) fn end_time(&self) -> f64 {
        (self.delay + self.active_duration() + self.end_delay).max(0.0)
    }

    // The timing at local time `local_time` of an effect played at `playback_rate` (whose sign is the animation
    // direction the phase boundaries are resolved by, §4.8.3).
    pub(crate) fn computed(&self, local_time: Option<f64>, playback_rate: f64) -> ComputedTiming {
        let active_duration = self.active_duration();
        let end_time = self.end_time();
        let mut out = ComputedTiming {
            phase: Phase::Idle,
            local_time,
            active_duration,
            end_time,
            active_time: None,
            current_iteration: None,
            progress: None,
        };
        let Some(local) = local_time else { return out };

        // §4.8.3: the phase, boundaries resolved towards the direction the animation is playing in.
        let backwards = playback_rate < 0.0;
        let before_active = self.delay.min(end_time).max(0.0);
        let active_after = (self.delay + active_duration).min(end_time).max(0.0);
        out.phase = if local < before_active || (backwards && local == before_active) {
            Phase::Before
        } else if local > active_after || (!backwards && local == active_after) {
            Phase::After
        } else {
            Phase::Active
        };

        // §4.8.4: the active time.
        let fill = self.fill();
        let fills_backwards = matches!(fill, FillMode::Backwards | FillMode::Both);
        let fills_forwards = matches!(fill, FillMode::Forwards | FillMode::Both);
        let active_time = match out.phase {
            Phase::Before if fills_backwards => (local - self.delay).max(0.0),
            Phase::Active => local - self.delay,
            Phase::After if fills_forwards => (local - self.delay).min(active_duration).max(0.0),
            _ => return out,
        };
        out.active_time = Some(active_time);

        // §4.9.1: the overall progress.
        let overall = if self.duration == 0.0 {
            if out.phase == Phase::Before { 0.0 } else { self.iterations }
        } else {
            active_time / self.duration
        } + self.iteration_start;

        // §4.9.2: the simple iteration progress — the end of an iteration that ends where the active interval does,
        // not the start of the next.
        let mut simple = if overall.is_infinite() { self.iteration_start % 1.0 } else { overall % 1.0 };
        if simple == 0.0
            && matches!(out.phase, Phase::Active | Phase::After)
            && active_time == active_duration
            && self.iterations != 0.0
        {
            simple = 1.0;
        }

        // §4.9.4: the current iteration.
        let current_iteration = if out.phase == Phase::After && self.iterations.is_infinite() {
            f64::INFINITY
        } else if simple == 1.0 {
            overall.floor() - 1.0
        } else {
            overall.floor()
        };
        out.current_iteration = Some(current_iteration);

        // §4.10: the directed progress…
        let forwards = match self.direction {
            PlaybackDirection::Normal => true,
            PlaybackDirection::Reverse => false,
            PlaybackDirection::Alternate | PlaybackDirection::AlternateReverse => {
                let mut d = current_iteration;
                if self.direction == PlaybackDirection::AlternateReverse {
                    d += 1.0;
                }
                d.is_infinite() || d % 2.0 == 0.0
            },
        };
        let directed = if forwards { simple } else { 1.0 - simple };

        // …and §4.11: the transformed progress, eased — a step easing told which side of a jump it is on.
        let before_flag = if (out.phase == Phase::Before && forwards) || (out.phase == Phase::After && !forwards) {
            BeforeFlag::Set
        } else {
            BeforeFlag::Unset
        };
        let epsilon = if self.duration > 0.0 { 1.0 / (200.0 * self.duration) } else { 1e-7 };
        out.progress = Some(self.easing.calculate_output(directed, before_flag, epsilon));
        out
    }
}

// §5.3.4 / §5.4.4.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum CompositeOperation {
    Replace,
    Add,
    Accumulate,
}

// The element (or its pseudo-element) an effect animates.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Target {
    pub(crate) node: NodeId,
    pub(crate) pseudo: Option<PseudoElement>,
}

// A keyframe as the page gave it (§5.3.3): where it sits (its computed offset), the easing to the next one and how
// its values composite (None: the effect's), and its declarations as parsed — shorthands expanded to longhands.
#[derive(Clone, Debug)]
pub(crate) struct Keyframe {
    pub(crate) offset: f64,
    pub(crate) easing: Option<ComputedTimingFunction>,
    pub(crate) composite: Option<CompositeOperation>,
    pub(crate) block: Arc<Locked<PropertyDeclarationBlock>>,
}

// A keyframe's value of one property, computed against the target's style (§5.3.3 "computing property values").
#[derive(Clone, Debug)]
pub(crate) struct ComputedFrame {
    pub(crate) offset: f64,
    pub(crate) easing: Option<ComputedTimingFunction>,
    pub(crate) composite: CompositeOperation,
    pub(crate) value: AnimationValue,
}

// An effect's keyframes as values of the target: per property, the keyframes that set it in offset order, and the
// target's own value of it (its base value, what a neutral keyframe and a non-replace composite stand on when no
// effect below says otherwise).
#[derive(Clone, Debug, Default)]
pub(crate) struct ComputedKeyframes {
    pub(crate) properties: Vec<(OwnedPropertyDeclarationId, Vec<ComputedFrame>, Option<AnimationValue>)>,
}

// An effect an animation plays (§4.5, §5.3): its timing, the element it animates, its keyframes and how they
// composite; and those keyframes computed for the target as it was last styled (None until then, or since the target
// or the keyframes changed).
#[derive(Clone, Debug)]
pub(crate) struct Effect {
    pub(crate) timing: EffectTiming,
    pub(crate) animation: Option<AnimationId>,
    pub(crate) target: Option<Target>,
    pub(crate) keyframes: Vec<Keyframe>,
    pub(crate) composite: CompositeOperation,
    pub(crate) iteration_composite_accumulate: bool,
    pub(crate) computed: Option<ComputedKeyframes>,
}

// A task an animation has pending until its timeline's next frame (§4.4.4 – §4.4.10): a play or a pause that takes
// its time from the frame it becomes ready in.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PendingTask {
    Play,
    Pause,
}

// §4.4.16.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PlayState {
    Idle,
    Running,
    Paused,
    Finished,
}

// §5.5.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ReplaceState {
    Active,
    Removed,
    Persisted,
}

// A promise of an animation, as the model sees it: which one it is now (a promise replaced by a new one is a new
// generation) and whether that one is settled.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) struct PromiseState {
    pub(crate) generation: u32,
    pub(crate) settled: bool,
}

impl PromiseState {
    fn replace(&mut self, settled: bool) {
        self.generation += 1;
        self.settled = settled;
    }
}

// What a handle is to do for an animation: settle a promise (the generation says which), or dispatch an event.
// `timeline_time` / `current_time` are what an `AnimationPlaybackEvent` carries.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Signal {
    ReadyResolved { animation: AnimationId, generation: u32 },
    ReadyRejected { animation: AnimationId, generation: u32 },
    FinishedResolved { animation: AnimationId, generation: u32 },
    FinishedRejected { animation: AnimationId, generation: u32 },
    Finish { animation: AnimationId, current_time: Option<f64>, timeline_time: Option<f64> },
    Cancel { animation: AnimationId, timeline_time: Option<f64> },
    Remove { animation: AnimationId, timeline_time: Option<f64> },
    // A finish notification was queued for the next microtask checkpoint: the handle is to run it then
    // (`finish_notification`).
    FinishNotificationQueued { animation: AnimationId },
}

// A script-visible error of an animation method (§4.4): a DOMException's name, or a TypeError.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum AnimationError {
    InvalidState,
    Type,
}

// An animation (§4.4): what drives an effect along a timeline.
#[derive(Clone, Debug)]
pub(crate) struct Animation {
    pub(crate) effect: Option<EffectId>,
    // (Only the document timeline, or none.)
    pub(crate) has_timeline: bool,
    pub(crate) start_time: Option<f64>,
    pub(crate) hold_time: Option<f64>,
    pub(crate) playback_rate: f64,
    pub(crate) pending_playback_rate: Option<f64>,
    pub(crate) pending: Option<PendingTask>,
    previous_current_time: Option<f64>,
    // A finish notification queued for the next microtask checkpoint (§4.4.15), which `finish_notification` runs.
    pub(crate) finish_notification_queued: bool,
    pub(crate) ready: PromiseState,
    pub(crate) finished: PromiseState,
    pub(crate) replace_state: ReplaceState,
    // Its place in composite order among script animations (§5.4.2): the order they were made in.
    pub(crate) sequence: u64,
}

// The document's animations and effects, and its timeline's time.
#[derive(Default)]
pub(crate) struct Animations {
    pub(crate) animations: HashMap<AnimationId, Animation>,
    pub(crate) effects: HashMap<EffectId, Effect>,
    // Each element's effects, and the elements an op touched since the last flush.
    by_target: HashMap<NodeId, Vec<EffectId>>,
    dirty_targets: Vec<NodeId>,
    next_animation: AnimationId,
    next_effect: EffectId,
    next_sequence: u64,
    // The document timeline's current time (ms), None before the page has one.
    pub(crate) timeline_time: Option<f64>,
    pub(crate) signals: Vec<Signal>,
}

impl Animations {
    pub(crate) fn new_effect(&mut self, timing: EffectTiming) -> EffectId {
        self.next_effect += 1;
        let effect = Effect {
            timing,
            animation: None,
            target: None,
            keyframes: Vec::new(),
            composite: CompositeOperation::Replace,
            iteration_composite_accumulate: false,
            computed: None,
        };
        self.effects.insert(self.next_effect, effect);
        self.next_effect
    }

    // An effect's target becomes `target`: its values leave the old one and reach the new one, computed anew.
    pub(crate) fn set_target(&mut self, effect: EffectId, target: Option<Target>) {
        let Some(e) = self.effects.get_mut(&effect) else { return };
        if e.target == target {
            return;
        }
        let old = std::mem::replace(&mut e.target, target.clone());
        e.computed = None;
        if let Some(old) = old {
            self.dirty_targets.push(old.node);
            if let Some(list) = self.by_target.get_mut(&old.node) {
                list.retain(|&id| id != effect);
                if list.is_empty() {
                    self.by_target.remove(&old.node);
                }
            }
        }
        if let Some(t) = target {
            self.dirty_targets.push(t.node);
            self.by_target.entry(t.node).or_default().push(effect);
        }
    }

    // `node` was restyled: its effects' keyframes are computed again, from the style it has now.
    pub(crate) fn target_restyled(&mut self, node: NodeId) {
        for effect in self.by_target.get(&node).into_iter().flatten() {
            if let Some(e) = self.effects.get_mut(effect) {
                e.computed = None;
            }
        }
    }

    // What an effect animates changed (its keyframes, its composite): computed anew, and its target restyled.
    pub(crate) fn keyframes_changed(&mut self, effect: EffectId) {
        let Some(e) = self.effects.get_mut(&effect) else { return };
        e.computed = None;
        if let Some(t) = &e.target {
            self.dirty_targets.push(t.node);
        }
    }

    // What an animation shows moved otherwise than with the clock (a seek, a pause, a change of timing or effect):
    // its target is restyled at the next flush.
    pub(crate) fn touch(&mut self, id: AnimationId) {
        let node = self
            .animations
            .get(&id)
            .and_then(|a| a.effect)
            .and_then(|e| self.effects.get(&e))
            .and_then(|e| e.target.as_ref())
            .map(|t| t.node);
        if let Some(node) = node {
            self.dirty_targets.push(node);
        }
    }

    // The elements whose animated values are to be composed again at this flush: every one a frame moved or an op
    // touched since the last.
    pub(crate) fn take_targets_to_restyle(&mut self) -> Vec<NodeId> {
        let mut out = std::mem::take(&mut self.dirty_targets);
        out.sort_unstable_by_key(|n| (n.idx, n.generation));
        out.dedup();
        out
    }

    // Does any effect animate `node`?
    pub(crate) fn animates(&self, node: NodeId) -> bool {
        self.by_target.contains_key(&node)
    }

    // Composite `underlying` (what the effects below left, keyed by property) with every effect animating `target`,
    // in composite order (§5.4.2: the order their animations were made in), at their animations' current times
    // (§5.4.4 "the effect value of a keyframe effect").
    pub(crate) fn compose(&self, target: &Target, underlying: &mut AnimationValueMap) {
        let Some(effects) = self.by_target.get(&target.node) else { return };
        let mut ordered: Vec<(u64, &Effect)> = effects
            .iter()
            .filter_map(|id| self.effects.get(id))
            .filter(|e| e.target.as_ref() == Some(target))
            .filter_map(|e| Some((self.animations.get(&e.animation?)?.sequence, e)))
            .collect();
        ordered.sort_unstable_by_key(|(sequence, _)| *sequence);
        for (_, effect) in ordered {
            let Some(computed) = &effect.computed else { continue };
            let Some(timing) = effect.animation.and_then(|a| {
                let rate = self.animations[&a].playback_rate;
                Some(effect.timing.computed(self.current_time(a), rate))
            }) else {
                continue;
            };
            let (Some(progress), Some(iteration)) = (timing.progress, timing.current_iteration) else { continue };
            let accumulate = if effect.iteration_composite_accumulate { iteration } else { 0.0 };
            for (id, frames, base) in &computed.properties {
                let below = underlying.get(id).or(base.as_ref());
                if let Some(value) = compose_property(frames, below, progress, timing.phase, accumulate) {
                    underlying.insert(id.clone(), value);
                }
            }
        }
    }

    // `new Animation(effect, timeline)` (§4.4 constructor): idle, its ready promise settled.
    pub(crate) fn new_animation(&mut self, effect: Option<EffectId>, has_timeline: bool) -> AnimationId {
        self.next_animation += 1;
        self.next_sequence += 1;
        let id = self.next_animation;
        self.animations.insert(
            id,
            Animation {
                effect: None,
                has_timeline,
                start_time: None,
                hold_time: None,
                playback_rate: 1.0,
                pending_playback_rate: None,
                pending: None,
                previous_current_time: None,
                finish_notification_queued: false,
                ready: PromiseState { generation: 0, settled: true },
                finished: PromiseState::default(),
                replace_state: ReplaceState::Active,
                sequence: self.next_sequence,
            },
        );
        self.set_effect(id, effect);
        id
    }

    // §4.4.3 (as far as the effect goes): an effect belongs to one animation at a time, so another's loses it.
    pub(crate) fn set_effect(&mut self, id: AnimationId, effect: Option<EffectId>) {
        let Some(old) = self.animations.get(&id).map(|a| a.effect) else { return };
        if old == effect {
            return;
        }
        if let Some(e) = effect {
            if let Some(previous) = self.effects.get(&e).and_then(|e| e.animation) {
                if let Some(a) = self.animations.get_mut(&previous) {
                    a.effect = None;
                }
            }
            if let Some(e) = self.effects.get_mut(&e) {
                e.animation = Some(id);
            }
        }
        if let Some(e) = old.and_then(|e| self.effects.get_mut(&e)) {
            e.animation = None;
        }
        self.animations.get_mut(&id).unwrap().effect = effect;
        self.update_finished_state(id, false, false);
    }

    fn timeline_time_of(&self, a: &Animation) -> Option<f64> {
        if a.has_timeline { self.timeline_time } else { None }
    }

    // §4.5.4: the end of the animation's effect, 0 without one.
    pub(crate) fn effect_end(&self, id: AnimationId) -> f64 {
        self.animations
            .get(&id)
            .and_then(|a| a.effect)
            .and_then(|e| self.effects.get(&e))
            .map_or(0.0, |e| e.timing.end_time())
    }

    // §4.4.4: the current time — the hold time where there is one, else where the timeline's time puts it.
    pub(crate) fn current_time(&self, id: AnimationId) -> Option<f64> {
        let a = self.animations.get(&id)?;
        self.current_time_of(a, a.hold_time)
    }

    fn current_time_of(&self, a: &Animation, hold_time: Option<f64>) -> Option<f64> {
        if hold_time.is_some() {
            return hold_time;
        }
        let timeline = self.timeline_time_of(a)?;
        Some((timeline - a.start_time?) * a.playback_rate)
    }

    // §4.4.15: the playback rate a pending change will leave, else the current one.
    pub(crate) fn effective_playback_rate(&self, id: AnimationId) -> f64 {
        self.animations.get(&id).map_or(1.0, |a| a.pending_playback_rate.unwrap_or(a.playback_rate))
    }

    // §4.4.16.
    pub(crate) fn play_state(&self, id: AnimationId) -> PlayState {
        let Some(a) = self.animations.get(&id) else { return PlayState::Idle };
        let current = self.current_time(id);
        if current.is_none() && a.start_time.is_none() && a.pending.is_none() {
            return PlayState::Idle;
        }
        if a.pending == Some(PendingTask::Pause) || (a.start_time.is_none() && a.pending != Some(PendingTask::Play)) {
            return PlayState::Paused;
        }
        let rate = self.effective_playback_rate(id);
        let end = self.effect_end(id);
        match current {
            Some(t) if (rate > 0.0 && t >= end) || (rate < 0.0 && t <= 0.0) => PlayState::Finished,
            _ => PlayState::Running,
        }
    }

    // The effect's local time: the animation's current time (§4.5.1).
    pub(crate) fn computed_timing(&self, effect: EffectId) -> Option<ComputedTiming> {
        let e = self.effects.get(&effect)?;
        let (local, rate) = match e.animation {
            Some(a) => (self.current_time(a), self.animations[&a].playback_rate),
            None => (None, 1.0),
        };
        Some(e.timing.computed(local, rate))
    }

    // §4.4.4 "set the current time" without the finished-state update (the silent part).
    fn set_current_time_silently(&mut self, id: AnimationId, seek: Option<f64>) -> Result<(), AnimationError> {
        let timeline = self.timeline_time_of(&self.animations[&id]);
        let a = self.animations.get_mut(&id).unwrap();
        let Some(seek) = seek else {
            // (An unresolved time is only an error where the current time is not unresolved already.)
            return if a.hold_time.is_some() || (timeline.is_some() && a.start_time.is_some()) {
                Err(AnimationError::Type)
            } else {
                Ok(())
            };
        };
        if a.hold_time.is_some() || a.start_time.is_none() || timeline.is_none() || a.playback_rate == 0.0 {
            a.hold_time = Some(seek);
        } else {
            a.start_time = Some(timeline.unwrap() - seek / a.playback_rate);
        }
        if timeline.is_none() {
            a.start_time = None;
        }
        a.previous_current_time = None;
        Ok(())
    }

    // `animation.currentTime = seek` (§4.4.4).
    pub(crate) fn set_current_time(&mut self, id: AnimationId, seek: Option<f64>) -> Result<(), AnimationError> {
        self.set_current_time_silently(id, seek)?;
        let a = self.animations.get_mut(&id).unwrap();
        if a.pending == Some(PendingTask::Pause) {
            a.hold_time = seek;
            if let Some(rate) = a.pending_playback_rate.take() {
                a.playback_rate = rate;
            }
            a.start_time = None;
            a.pending = None;
            self.resolve_ready(id);
        }
        self.update_finished_state(id, true, false);
        Ok(())
    }

    // `animation.startTime = new_start` (§4.4.5).
    pub(crate) fn set_start_time(&mut self, id: AnimationId, new_start: Option<f64>) {
        let timeline = self.timeline_time_of(&self.animations[&id]);
        let previous = self.current_time(id);
        let a = self.animations.get_mut(&id).unwrap();
        if timeline.is_none() && new_start.is_some() {
            a.hold_time = None;
        }
        if let Some(rate) = a.pending_playback_rate.take() {
            a.playback_rate = rate;
        }
        a.start_time = new_start;
        if new_start.is_some() {
            if a.playback_rate != 0.0 {
                a.hold_time = None;
            }
        } else {
            a.hold_time = previous;
        }
        if a.pending.take().is_some() {
            self.resolve_ready(id);
        }
        self.update_finished_state(id, true, false);
    }

    // `animation.play()` (§4.4.10), with `auto_rewind` (false for a play `updatePlaybackRate` asks for).
    pub(crate) fn play(&mut self, id: AnimationId, auto_rewind: bool) -> Result<(), AnimationError> {
        let current = self.current_time(id);
        let end = self.effect_end(id);
        let rate = self.effective_playback_rate(id);
        let a = self.animations.get_mut(&id).unwrap();
        let aborted_pause = a.pending == Some(PendingTask::Pause);
        let mut has_pending_ready_promise = false;
        let seek = if rate > 0.0 && auto_rewind && current.is_none_or(|t| t < 0.0 || t >= end) {
            Some(0.0)
        } else if rate < 0.0 && auto_rewind && current.is_none_or(|t| t <= 0.0 || t > end) {
            if end.is_infinite() {
                return Err(AnimationError::InvalidState);
            }
            Some(end)
        } else if rate == 0.0 && current.is_none() {
            Some(0.0)
        } else {
            None
        };
        if seek.is_some() {
            a.hold_time = seek;
        }
        if a.hold_time.is_some() {
            a.start_time = None;
        }
        if a.pending.take().is_some() {
            has_pending_ready_promise = true;
        }
        if a.hold_time.is_none() && seek.is_none() && !aborted_pause && a.pending_playback_rate.is_none() {
            return Ok(());
        }
        if !has_pending_ready_promise {
            a.ready.replace(false);
        }
        a.pending = Some(PendingTask::Play);
        self.update_finished_state(id, false, false);
        Ok(())
    }

    // `animation.pause()` (§4.4.12).
    pub(crate) fn pause(&mut self, id: AnimationId) -> Result<(), AnimationError> {
        if self.animations[&id].pending == Some(PendingTask::Pause) || self.play_state(id) == PlayState::Paused {
            return Ok(());
        }
        let current = self.current_time(id);
        let end = self.effect_end(id);
        let a = self.animations.get_mut(&id).unwrap();
        let seek = match current {
            Some(_) => None,
            None if a.playback_rate >= 0.0 => Some(0.0),
            None if end.is_infinite() => return Err(AnimationError::InvalidState),
            None => Some(end),
        };
        if seek.is_some() {
            a.hold_time = seek;
        }
        let mut has_pending_ready_promise = false;
        if a.pending == Some(PendingTask::Play) {
            a.pending = None;
            has_pending_ready_promise = true;
        }
        if !has_pending_ready_promise {
            a.ready.replace(false);
        }
        a.pending = Some(PendingTask::Pause);
        self.update_finished_state(id, false, false);
        Ok(())
    }

    // `animation.finish()` (§4.4.14).
    pub(crate) fn finish(&mut self, id: AnimationId) -> Result<(), AnimationError> {
        let rate = self.effective_playback_rate(id);
        let end = self.effect_end(id);
        if rate == 0.0 || (rate > 0.0 && end.is_infinite()) {
            return Err(AnimationError::InvalidState);
        }
        self.apply_pending_playback_rate(id);
        let limit = if rate > 0.0 { end } else { 0.0 };
        self.set_current_time_silently(id, Some(limit))?;
        let timeline = self.timeline_time_of(&self.animations[&id]);
        let a = self.animations.get_mut(&id).unwrap();
        if a.start_time.is_none() {
            if let Some(t) = timeline {
                a.start_time = Some(t - limit / a.playback_rate);
            }
        }
        let resolved_pending = match a.pending {
            Some(PendingTask::Pause) if a.start_time.is_some() => {
                a.hold_time = None;
                true
            },
            Some(PendingTask::Play) if a.start_time.is_some() => true,
            _ => false,
        };
        if resolved_pending {
            a.pending = None;
            self.resolve_ready(id);
        }
        self.update_finished_state(id, true, true);
        Ok(())
    }

    // `animation.cancel()` (§4.4.13).
    pub(crate) fn cancel(&mut self, id: AnimationId) {
        if self.play_state(id) != PlayState::Idle {
            self.reset_pending_tasks(id);
            let timeline_time = self.timeline_time_of(&self.animations[&id]);
            let a = self.animations.get_mut(&id).unwrap();
            if !a.finished.settled {
                self.signals.push(Signal::FinishedRejected { animation: id, generation: a.finished.generation });
            }
            a.finished.replace(false);
            a.finish_notification_queued = false;
            self.signals.push(Signal::Cancel { animation: id, timeline_time });
        }
        let a = self.animations.get_mut(&id).unwrap();
        a.hold_time = None;
        a.start_time = None;
    }

    // `animation.reverse()` (§4.4.18).
    pub(crate) fn reverse(&mut self, id: AnimationId) -> Result<(), AnimationError> {
        if self.timeline_time_of(&self.animations[&id]).is_none() {
            return Err(AnimationError::InvalidState);
        }
        let original = self.animations[&id].pending_playback_rate;
        let rate = self.effective_playback_rate(id);
        self.animations.get_mut(&id).unwrap().pending_playback_rate = Some(-rate);
        let played = self.play(id, true);
        if played.is_err() {
            self.animations.get_mut(&id).unwrap().pending_playback_rate = original;
        }
        played
    }

    // `animation.playbackRate = rate` (§4.4.15.1): at once, the current time kept.
    pub(crate) fn set_playback_rate(&mut self, id: AnimationId, rate: f64) {
        let previous = self.current_time(id);
        let a = self.animations.get_mut(&id).unwrap();
        a.pending_playback_rate = None;
        a.playback_rate = rate;
        if previous.is_some() {
            let _ = self.set_current_time(id, previous);
        }
    }

    // `animation.updatePlaybackRate(rate)` (§4.4.15.2): at the next frame, without a jump.
    pub(crate) fn update_playback_rate(&mut self, id: AnimationId, rate: f64) {
        let previous_state = self.play_state(id);
        let unconstrained = {
            let a = &self.animations[&id];
            self.current_time_of(a, None)
        };
        let timeline = self.timeline_time_of(&self.animations[&id]);
        let current = self.current_time(id);
        self.animations.get_mut(&id).unwrap().pending_playback_rate = Some(rate);
        if self.animations[&id].pending.is_some() {
            return;
        }
        match previous_state {
            PlayState::Idle | PlayState::Paused => self.apply_pending_playback_rate(id),
            _ if current.is_none() => self.apply_pending_playback_rate(id),
            PlayState::Finished => {
                let a = self.animations.get_mut(&id).unwrap();
                a.start_time = match (unconstrained, timeline) {
                    (Some(u), Some(t)) if rate != 0.0 => Some(t - u / rate),
                    (_, t) => t,
                };
                self.apply_pending_playback_rate(id);
                self.update_finished_state(id, false, false);
            },
            PlayState::Running => {
                let _ = self.play(id, false);
            },
        }
    }

    fn apply_pending_playback_rate(&mut self, id: AnimationId) {
        let a = self.animations.get_mut(&id).unwrap();
        if let Some(rate) = a.pending_playback_rate.take() {
            a.playback_rate = rate;
        }
    }

    // §4.4.13 "reset an animation's pending tasks": the ready promise rejected and replaced by a settled one.
    fn reset_pending_tasks(&mut self, id: AnimationId) {
        if self.animations[&id].pending.is_none() {
            return;
        }
        self.apply_pending_playback_rate(id);
        let a = self.animations.get_mut(&id).unwrap();
        a.pending = None;
        self.signals.push(Signal::ReadyRejected { animation: id, generation: a.ready.generation });
        a.ready.replace(true);
    }

    fn resolve_ready(&mut self, id: AnimationId) {
        let a = self.animations.get_mut(&id).unwrap();
        if !a.ready.settled {
            a.ready.settled = true;
            self.signals.push(Signal::ReadyResolved { animation: id, generation: a.ready.generation });
        }
    }

    // §4.4.2 "update an animation's finished state": a time past the end is held there (unless it was sought), and
    // the finished promise follows whether the animation is finished — its notification now (`synchronously`) or at
    // the next microtask checkpoint.
    pub(crate) fn update_finished_state(&mut self, id: AnimationId, did_seek: bool, synchronously: bool) {
        let end = self.effect_end(id);
        let timeline = self.timeline_time_of(&self.animations[&id]);
        let unconstrained = {
            let a = &self.animations[&id];
            if did_seek { self.current_time_of(a, a.hold_time) } else { self.current_time_of(a, None) }
        };
        let a = self.animations.get_mut(&id).unwrap();
        if let (Some(t), Some(_), None) = (unconstrained, a.start_time, a.pending) {
            if a.playback_rate > 0.0 && t >= end {
                a.hold_time = Some(if did_seek { t } else { a.previous_current_time.map_or(end, |p| p.max(end)) });
            } else if a.playback_rate < 0.0 && t <= 0.0 {
                a.hold_time = Some(if did_seek { t } else { a.previous_current_time.map_or(0.0, |p| p.min(0.0)) });
            } else if a.playback_rate != 0.0 && timeline.is_some() {
                if let (true, Some(hold)) = (did_seek, a.hold_time) {
                    a.start_time = Some(timeline.unwrap() - hold / a.playback_rate);
                }
                a.hold_time = None;
            }
        }
        let current = self.current_time(id);
        self.animations.get_mut(&id).unwrap().previous_current_time = current;
        let finished = self.play_state(id) == PlayState::Finished;
        let a = self.animations.get_mut(&id).unwrap();
        if finished && !a.finished.settled {
            if synchronously {
                a.finish_notification_queued = false;
                self.finish_notification(id);
            } else if !a.finish_notification_queued {
                a.finish_notification_queued = true;
                self.signals.push(Signal::FinishNotificationQueued { animation: id });
            }
        } else if !finished && a.finished.settled {
            a.finished.replace(false);
        }
    }

    // The finish notification steps (§4.4.2), queued by `update_finished_state` for a microtask: the finished promise
    // is resolved and a `finish` event dispatched — if the animation is still finished by then.
    pub(crate) fn finish_notification(&mut self, id: AnimationId) {
        let Some(a) = self.animations.get_mut(&id) else { return };
        a.finish_notification_queued = false;
        if self.play_state(id) != PlayState::Finished {
            return;
        }
        let timeline_time = self.timeline_time_of(&self.animations[&id]);
        let current_time = self.current_time(id);
        let a = self.animations.get_mut(&id).unwrap();
        if a.finished.settled {
            return;
        }
        a.finished.settled = true;
        self.signals.push(Signal::FinishedResolved { animation: id, generation: a.finished.generation });
        self.signals.push(Signal::Finish { animation: id, current_time, timeline_time });
    }

    // A frame of the document timeline (§4.2 "update animations and send events", its animation part): the timeline
    // moves to `now`, what was pending becomes ready at that time (§4.4.10 / §4.4.12, the ready time), and each
    // animation's finished state follows.
    pub(crate) fn tick(&mut self, now: f64) {
        self.set_timeline_time(now);
        let mut ids: Vec<AnimationId> = self.animations.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            let pending = self.animations[&id].pending;
            match pending {
                Some(PendingTask::Play) => self.run_pending_play(id, now),
                Some(PendingTask::Pause) => self.run_pending_pause(id, now),
                None => self.update_finished_state(id, false, false),
            }
            if pending.is_some() {
                self.touch(id);
            }
        }
    }

    // The document timeline's time becomes `now` — the page's clock, read whenever an animation is asked about or
    // composed (a frame of this engine's clock is a tenth of a second, where a browser's is a sixtieth: between two,
    // a page reading an animation reads the clock, as the JS model did). What runs moves with it.
    pub(crate) fn set_timeline_time(&mut self, now: f64) {
        if self.timeline_time == Some(now) {
            return;
        }
        self.timeline_time = Some(now);
        // (…every animation whose current time the timeline's carries: a start time and no hold — one that has just
        // run past its end included, which the next frame only then holds there.)
        let moves = |a: &Animation| a.start_time.is_some() && a.hold_time.is_none();
        let moved: Vec<NodeId> = self
            .by_target
            .iter()
            .filter(|(_, effects)| {
                effects.iter().any(|e| self.effects[e].animation.is_some_and(|a| moves(&self.animations[&a])))
            })
            .map(|(node, _)| *node)
            .collect();
        self.dirty_targets.extend(moved);
    }

    // §4.4.10, the pending play task at `ready_time`.
    fn run_pending_play(&mut self, id: AnimationId, ready_time: f64) {
        if !self.animations[&id].has_timeline {
            return;
        }
        let a = self.animations.get_mut(&id).unwrap();
        a.pending = None;
        if let Some(hold) = a.hold_time {
            if let Some(rate) = a.pending_playback_rate.take() {
                a.playback_rate = rate;
            }
            if a.playback_rate == 0.0 {
                a.start_time = Some(ready_time);
            } else {
                a.start_time = Some(ready_time - hold / a.playback_rate);
                a.hold_time = None;
            }
        } else if let (Some(start), Some(rate)) = (a.start_time, a.pending_playback_rate) {
            let current_to_match = (ready_time - start) * a.playback_rate;
            a.playback_rate = rate;
            a.pending_playback_rate = None;
            if rate == 0.0 {
                a.hold_time = Some(current_to_match);
            } else {
                a.start_time = Some(ready_time - current_to_match / rate);
            }
        }
        self.resolve_ready(id);
        self.update_finished_state(id, false, false);
    }

    // §4.4.12, the pending pause task at `ready_time`.
    fn run_pending_pause(&mut self, id: AnimationId, ready_time: f64) {
        let a = self.animations.get_mut(&id).unwrap();
        a.pending = None;
        if let (Some(start), None) = (a.start_time, a.hold_time) {
            a.hold_time = Some((ready_time - start) * a.playback_rate);
        }
        if let Some(rate) = a.pending_playback_rate.take() {
            a.playback_rate = rate;
        }
        a.start_time = None;
        self.resolve_ready(id);
        self.update_finished_state(id, false, false);
    }

    pub(crate) fn take_signals(&mut self) -> Vec<Signal> {
        std::mem::take(&mut self.signals)
    }
}

// One property's value at `progress` through an effect's iteration (§5.4.4): between the two keyframes about it — a
// neutral one standing in at 0 and 1 where the page gave none, whose value is the underlying one — each composited
// with `underlying` as it says, and `accumulate` iterations of the last keyframe's value added on (an iteration
// composite of accumulate); None where a value it needs is missing.
fn compose_property(
    frames: &[ComputedFrame],
    underlying: Option<&AnimationValue>,
    progress: f64,
    phase: Phase,
    accumulate: f64,
) -> Option<AnimationValue> {
    // (A neutral keyframe is the underlying value composited `add`: the underlying value.)
    let at = |offset: f64| frames.iter().filter(move |f| f.offset == offset);
    let first_is_neutral = at(0.0).next().is_none();
    let last_is_neutral = at(1.0).next().is_none();
    let mut keys: Vec<Option<&ComputedFrame>> = Vec::with_capacity(frames.len() + 2);
    if first_is_neutral {
        keys.push(None);
    }
    keys.extend(frames.iter().map(Some));
    if last_is_neutral {
        keys.push(None);
    }
    let offset_of = |k: &Option<&ComputedFrame>, i: usize| match k {
        Some(f) => f.offset,
        None if i == 0 => 0.0,
        None => 1.0,
    };
    let value_of = |k: &Option<&ComputedFrame>| -> Option<AnimationValue> {
        let Some(frame) = k else { return underlying.cloned() };
        let mut value = match (frame.composite, underlying) {
            (CompositeOperation::Replace, _) | (_, None) => frame.value.clone(),
            (CompositeOperation::Add, Some(u)) => u.animate(&frame.value, Procedure::Add).unwrap_or(frame.value.clone()),
            (CompositeOperation::Accumulate, Some(u)) => {
                u.animate(&frame.value, Procedure::Accumulate { count: 1 }).unwrap_or(frame.value.clone())
            },
        };
        if accumulate > 0.0 {
            if let Some(Some(last)) = keys.last() {
                if let Ok(v) = value.animate(&last.value, Procedure::Accumulate { count: accumulate as u64 }) {
                    value = v;
                }
            }
        }
        Some(value)
    };
    let zeros = (0..keys.len()).filter(|&i| offset_of(&keys[i], i) == 0.0).count();
    let ones = (0..keys.len()).filter(|&i| offset_of(&keys[i], i) == 1.0).count();
    if progress < 0.0 && zeros > 1 {
        return value_of(&keys[0]);
    }
    if progress >= 1.0 && ones > 1 {
        return value_of(keys.last()?);
    }
    let start = (0..keys.len())
        .rev()
        .find(|&i| {
            let o = offset_of(&keys[i], i);
            o <= progress && o < 1.0
        })
        .or_else(|| (0..keys.len()).rev().find(|&i| offset_of(&keys[i], i) == 0.0))?;
    let end = start + 1;
    if end >= keys.len() {
        return value_of(&keys[start]);
    }
    let (from, to) = (value_of(&keys[start])?, value_of(&keys[end])?);
    let (start_offset, end_offset) = (offset_of(&keys[start], start), offset_of(&keys[end], end));
    let distance = if end_offset > start_offset { (progress - start_offset) / (end_offset - start_offset) } else { 0.0 };
    let before_flag = if phase == Phase::Before { BeforeFlag::Set } else { BeforeFlag::Unset };
    let eased = match keys[start].and_then(|f| f.easing.as_ref()) {
        Some(easing) => easing.calculate_output(distance, before_flag, 1e-7),
        None => distance,
    };
    // (A pair that does not interpolate flips half way: discrete.)
    Some(from.animate(&to, Procedure::Interpolate { progress: eased }).unwrap_or(if eased < 0.5 { from } else { to }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timing(duration: f64) -> EffectTiming {
        EffectTiming { duration, ..EffectTiming::default() }
    }

    fn playing(model: &mut Animations, duration: f64) -> AnimationId {
        let effect = model.new_effect(timing(duration));
        let id = model.new_animation(Some(effect), true);
        model.play(id, true).unwrap();
        id
    }

    #[test]
    fn computed_timing_follows_the_phases() {
        let t = EffectTiming { delay: 100.0, duration: 1000.0, iterations: 2.0, ..EffectTiming::default() };
        assert_eq!(t.computed(Some(50.0), 1.0).phase, Phase::Before);
        assert_eq!(t.computed(Some(50.0), 1.0).progress, None);
        let active = t.computed(Some(600.0), 1.0);
        assert_eq!((active.phase, active.current_iteration, active.progress), (Phase::Active, Some(0.0), Some(0.5)));
        let second = t.computed(Some(1600.0), 1.0);
        assert_eq!((second.current_iteration, second.progress), (Some(1.0), Some(0.5)));
        assert_eq!(t.computed(Some(2100.0), 1.0).phase, Phase::After);
        assert_eq!(t.computed(None, 1.0).phase, Phase::Idle);
    }

    #[test]
    fn a_fill_holds_the_end_of_the_last_iteration() {
        let t = EffectTiming { duration: 1000.0, iterations: 2.0, fill: FillMode::Forwards, ..EffectTiming::default() };
        let after = t.computed(Some(5000.0), 1.0);
        assert_eq!((after.current_iteration, after.progress), (Some(1.0), Some(1.0)));
        let fractional = EffectTiming { iterations: 2.5, ..t };
        assert_eq!(fractional.computed(Some(5000.0), 1.0).progress, Some(0.5));
    }

    #[test]
    fn alternate_runs_odd_iterations_backwards() {
        let t = EffectTiming {
            duration: 1000.0,
            iterations: 3.0,
            direction: PlaybackDirection::Alternate,
            ..EffectTiming::default()
        };
        assert_eq!(t.computed(Some(1250.0), 1.0).progress, Some(0.75));
        assert_eq!(t.computed(Some(2250.0), 1.0).progress, Some(0.25));
    }

    #[test]
    fn a_zero_duration_is_at_its_end_the_instant_it_starts() {
        let t = EffectTiming { fill: FillMode::Both, iterations: f64::INFINITY, ..EffectTiming::default() };
        assert_eq!(t.active_duration(), 0.0);
        let after = t.computed(Some(0.0), 1.0);
        assert_eq!((after.phase, after.progress), (Phase::After, Some(1.0)));
        assert_eq!(after.current_iteration, Some(f64::INFINITY));
    }

    #[test]
    fn play_waits_for_a_frame_and_starts_there() {
        let mut model = Animations { timeline_time: Some(100.0), ..Animations::default() };
        let id = playing(&mut model, 1000.0);
        assert_eq!(model.animations[&id].pending, Some(PendingTask::Play));
        assert_eq!(model.current_time(id), Some(0.0));
        assert_eq!(model.play_state(id), PlayState::Running);
        model.tick(150.0);
        assert_eq!(model.animations[&id].start_time, Some(150.0));
        assert!(model.take_signals().contains(&Signal::ReadyResolved { animation: id, generation: 1 }));
        model.tick(650.0);
        assert_eq!(model.current_time(id), Some(500.0));
    }

    #[test]
    fn a_finished_animation_holds_at_its_end_and_notifies() {
        let mut model = Animations { timeline_time: Some(0.0), ..Animations::default() };
        let id = playing(&mut model, 1000.0);
        model.tick(0.0);
        model.tick(1500.0);
        assert_eq!(model.play_state(id), PlayState::Finished);
        assert_eq!(model.current_time(id), Some(1000.0));
        assert!(model.animations[&id].finish_notification_queued);
        model.finish_notification(id);
        let signals = model.take_signals();
        assert!(signals.contains(&Signal::FinishedResolved { animation: id, generation: 0 }));
        assert!(signals.contains(&Signal::Finish { animation: id, current_time: Some(1000.0), timeline_time: Some(1500.0) }));
        // …and playing it again rewinds it, with a new finished promise.
        model.play(id, true).unwrap();
        assert_eq!(model.current_time(id), Some(0.0));
        assert_eq!(model.animations[&id].finished, PromiseState { generation: 1, settled: false });
    }

    #[test]
    fn pause_takes_its_time_from_the_frame() {
        let mut model = Animations { timeline_time: Some(0.0), ..Animations::default() };
        let id = playing(&mut model, 1000.0);
        model.tick(0.0);
        model.tick(300.0);
        model.pause(id).unwrap();
        assert_eq!(model.play_state(id), PlayState::Paused);
        model.tick(400.0);
        assert_eq!((model.animations[&id].start_time, model.current_time(id)), (None, Some(400.0)));
        model.tick(900.0);
        assert_eq!(model.current_time(id), Some(400.0));
    }

    #[test]
    fn finish_and_cancel() {
        let mut model = Animations { timeline_time: Some(0.0), ..Animations::default() };
        let id = playing(&mut model, 1000.0);
        model.finish(id).unwrap();
        assert_eq!((model.play_state(id), model.current_time(id)), (PlayState::Finished, Some(1000.0)));
        assert!(model.take_signals().iter().any(|s| matches!(s, Signal::Finish { .. })));
        model.cancel(id);
        assert_eq!((model.play_state(id), model.current_time(id)), (PlayState::Idle, None));
        assert!(model.take_signals().iter().any(|s| matches!(s, Signal::Cancel { .. })));
        let infinite = model.new_effect(EffectTiming { iterations: f64::INFINITY, ..timing(1000.0) });
        let forever = model.new_animation(Some(infinite), true);
        assert_eq!(model.finish(forever), Err(AnimationError::InvalidState));
    }

    #[test]
    fn seeking_and_playback_rate() {
        let mut model = Animations { timeline_time: Some(0.0), ..Animations::default() };
        let id = playing(&mut model, 1000.0);
        model.tick(0.0);
        model.set_current_time(id, Some(250.0)).unwrap();
        assert_eq!(model.current_time(id), Some(250.0));
        model.set_playback_rate(id, 2.0);
        model.tick(100.0);
        assert_eq!(model.current_time(id), Some(450.0));
        // (A reversal takes effect at the frame it becomes ready in — 650 by then — and runs back from there.)
        model.reverse(id).unwrap();
        model.tick(200.0);
        assert_eq!(model.current_time(id), Some(650.0));
        model.tick(300.0);
        assert_eq!(model.current_time(id), Some(450.0));
    }
}
