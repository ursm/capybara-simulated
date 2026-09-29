// CSS animations as the Web Animations model runs them (css-animations-2 §3 – §4): an animation style made and owns,
// which its owning element's style keeps up to date — what the style says of it where a script has not said otherwise
// since — and which owes `animationstart` / `animationiteration` / `animationend` / `animationcancel` as its phase
// moves. The style engine reads an element's style into `CssAnimationStyle`s (`style.rs`); the model does the rest,
// as Gecko's `nsAnimationManager` and `CSSAnimation` do.

use bitflags::bitflags;
use style::servo_arc::Arc;
use style::values::computed::easing::ComputedTimingFunction;

use crate::animations::{AnimationId, Animations, CompositeOperation, EffectTiming, Keyframe, Phase, PlayState, Target};
use crate::dom::NodeId;

bitflags! {
    // What of a CSS animation a script has set, and its style therefore no longer sets (css-animations-2 §4.1; Gecko's
    // `CSSAnimationProperties`).
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub(crate) struct Overrides: u8 {
        const KEYFRAMES = 1 << 0;
        const DURATION = 1 << 1;
        const ITERATIONS = 1 << 2;
        const DIRECTION = 1 << 3;
        const DELAY = 1 << 4;
        const FILL = 1 << 5;
        const COMPOSITION = 1 << 6;
        const PLAY_STATE = 1 << 7;
    }
}

// What a CSS animation is besides an animation: the `@keyframes` name it runs; the element (or pseudo-element) whose
// style owns it — none once that style no longer lists it — and its place in that style's `animation-name`; what of
// it a script has set; whether `animation-play-state` paused it, as the style last said; and where its phase and
// iteration stood when last looked at, which the events it owes are told from (§4.2).
#[derive(Clone, Debug)]
pub(crate) struct CssAnimation {
    pub(crate) name: String,
    pub(crate) owner: Option<Target>,
    pub(crate) position: usize,
    pub(crate) overridden: Overrides,
    style_paused: bool,
    previous: (Phase, Option<f64>),
}

// What an element's style says of one of its CSS animations (css-animations-1 §3): the name, its effect's timing,
// keyframes (from the `@keyframes` rule, each keyframe's easing the one it declares or `animation-timing-function`) and
// composite, the easing out of a keyframe standing in at 0, and whether `animation-play-state` pauses it.
pub(crate) struct CssAnimationStyle {
    pub(crate) name: String,
    pub(crate) timing: EffectTiming,
    pub(crate) keyframes: Vec<Keyframe>,
    pub(crate) implicit_easing: ComputedTimingFunction,
    pub(crate) composite: CompositeOperation,
    pub(crate) paused: bool,
}

// An event a CSS animation owes (§4.2): its type and `elapsedTime` (seconds); the element (and pseudo-element) it is
// about, the animation's name and place in `animation-name` as they were when it was queued; and when it was due on
// the timeline (ms) — which, then the composite order, is the order a rendering update dispatches them in.
#[derive(Clone, Debug)]
pub(crate) struct CssEvent {
    pub(crate) animation: AnimationId,
    pub(crate) kind: &'static str,
    pub(crate) elapsed: f64,
    pub(crate) owner: Target,
    pub(crate) name: String,
    pub(crate) position: usize,
    pub(crate) scheduled: f64,
}

impl Animations {
    // The CSS animations `owner`'s style made and still lists, in `animation-name` order.
    pub(crate) fn css_animations_of(&self, owner: &Target) -> Vec<AnimationId> {
        let mut out: Vec<(usize, AnimationId)> = self
            .owned_by(owner)
            .map(|id| (self.animations[&id].css.as_ref().unwrap().position, id))
            .collect();
        out.sort_unstable();
        out.into_iter().map(|(_, id)| id).collect()
    }

    pub(crate) fn has_css_animations(&self, owner: &Target) -> bool {
        self.owned_by(owner).next().is_some()
    }

    fn owned_by<'a>(&'a self, owner: &'a Target) -> impl Iterator<Item = AnimationId> + 'a {
        self.css_by_owner.get(&owner.node).into_iter().flatten().copied().filter(move |id| {
            self.animations[id].css.as_ref().is_some_and(|css| css.owner.as_ref() == Some(owner))
        })
    }

    // The CSS animations `owner`'s style now lists (css-animations-2 §3; Gecko's `BuildAnimations`): each takes over
    // the one by its name it ran before — matched from the end of both lists — and a new one is made where there is
    // none; one the style no longer lists is canceled and let go.
    pub(crate) fn update_css_animations(&mut self, owner: &Target, styles: Vec<CssAnimationStyle>) {
        let mut old = self.css_animations_of(owner);
        for (position, style) in styles.into_iter().enumerate().rev() {
            let same_name = old.iter().rposition(|id| self.animations[id].css.as_ref().unwrap().name == style.name);
            match same_name {
                Some(at) => {
                    let id = old.remove(at);
                    self.restyle_css_animation(id, style, position);
                },
                None => {
                    self.new_css_animation(owner, style, position);
                },
            }
        }
        for id in old {
            self.cancel_from_style(id);
        }
    }

    // A CSS animation made of a style: its effect targeting the owner, played — or paused, where its play state says.
    // Neither has a handle until a script asks for one.
    fn new_css_animation(&mut self, owner: &Target, style: CssAnimationStyle, position: usize) -> AnimationId {
        let effect = self.new_effect(style.timing);
        let e = self.effects.get_mut(&effect).unwrap();
        e.keyframes = style.keyframes;
        e.composite = style.composite;
        e.implicit_easing = Some(style.implicit_easing);
        e.orphaned = true;
        self.set_target(effect, Some(owner.clone()));
        let id = self.new_animation(Some(effect), true);
        self.css_by_owner.entry(owner.node).or_default().push(id);
        let a = self.animations.get_mut(&id).unwrap();
        a.handled = false;
        a.css = Some(CssAnimation {
            name: style.name,
            owner: Some(owner.clone()),
            position,
            overridden: Overrides::empty(),
            style_paused: style.paused,
            previous: (Phase::Idle, None),
        });
        let _ = if style.paused { self.pause(id) } else { self.play(id, true) };
        id
    }

    // A CSS animation its owner's new style still lists: what the style says of it where a script has not said
    // otherwise (Gecko's `UpdateOldAnimationPropertiesWithNew`), and a change of its play state followed — unless it
    // is idle, which a change of `animation-play-state` does not restart.
    fn restyle_css_animation(&mut self, id: AnimationId, style: CssAnimationStyle, position: usize) {
        let a = self.animations.get_mut(&id).unwrap();
        let css = a.css.as_mut().unwrap();
        css.position = position;
        let overridden = css.overridden;
        let was_style_paused = std::mem::replace(&mut css.style_paused, style.paused);
        let mut keyframes_changed = false;
        if let Some(e) = a.effect.and_then(|e| self.effects.get_mut(&e)) {
            let (to, from) = (&mut e.timing, &style.timing);
            if !overridden.contains(Overrides::DURATION) {
                to.duration = from.duration;
            }
            if !overridden.contains(Overrides::ITERATIONS) {
                to.iterations = from.iterations;
            }
            if !overridden.contains(Overrides::DIRECTION) {
                to.direction = from.direction;
            }
            if !overridden.contains(Overrides::DELAY) {
                to.delay = from.delay;
            }
            if !overridden.contains(Overrides::FILL) {
                to.fill = from.fill;
            }
            // (…its keyframes and composite only where they changed: a restyle that leaves them — every `color` change
            // on an animated element — computes them again anyway, and a change is the JS side's to hear of.)
            let implicit_easing = Some(style.implicit_easing);
            if !overridden.contains(Overrides::KEYFRAMES)
                && (!same_keyframes(&e.keyframes, &style.keyframes) || e.implicit_easing != implicit_easing)
            {
                e.keyframes = style.keyframes;
                e.implicit_easing = implicit_easing;
                keyframes_changed = true;
            }
            if !overridden.contains(Overrides::COMPOSITION) && e.composite != style.composite {
                e.composite = style.composite;
                keyframes_changed = true;
            }
        }
        if let Some(effect) = self.animations[&id].effect.filter(|_| keyframes_changed) {
            self.keyframes_changed(effect);
            self.properties_changed(effect);
        }
        self.update_finished_state(id, false, false);
        self.touch(id);
        if overridden.contains(Overrides::PLAY_STATE) || self.play_state(id) == PlayState::Idle {
            return;
        }
        // (A style that starts it again continues it where it was: no rewind.)
        let _ = match (was_style_paused, style.paused) {
            (false, true) => self.pause(id),
            (true, false) => self.play(id, false),
            _ => Ok(()),
        };
    }

    // A CSS animation its owner's style no longer lists (or no longer renders): canceled while it is still the owner's
    // — its `animationcancel` is the owner's — and let go, to be what a script holding it makes of it.
    pub(crate) fn cancel_from_style(&mut self, id: AnimationId) {
        self.cancel(id);
        self.touch(id);
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

    // The owners of CSS animations (the elements; each pseudo-element's under its element's).
    pub(crate) fn css_owners(&self) -> impl Iterator<Item = NodeId> + '_ {
        self.css_by_owner.keys().copied()
    }

    // A script's call that played or paused CSS animation `id` (`method`, done), which was paused or not before it: its
    // play state is the script's from now on — for `play()` and `pause()` whatever they did, for `reverse()` and a
    // start time where they turned it from paused to running or back (css-animations-2 §4.1).
    pub(crate) fn script_played(&mut self, id: AnimationId, method: &str, was_paused: bool) {
        let paused = self.play_state(id) == PlayState::Paused;
        let takes_over = match method {
            "play" | "pause" => true,
            "reverse" | "startTime" => paused != was_paused,
            _ => false,
        };
        if let Some(css) = self.animations.get_mut(&id).and_then(|a| a.css.as_mut()).filter(|_| takes_over) {
            css.overridden |= Overrides::PLAY_STATE;
        }
    }

    // A script set `what` of the CSS animation playing `effect`: its style no longer does.
    pub(crate) fn override_css(&mut self, effect: crate::animations::EffectId, what: Overrides) {
        let animation = self.effects.get(&effect).and_then(|e| e.animation);
        if let Some(css) = animation.and_then(|a| self.animations.get_mut(&a)).and_then(|a| a.css.as_mut()) {
            css.overridden |= what;
        }
    }

    // The events CSS animation `id` owes for where its phase moved since it was last looked at — at the last frame
    // (css-animations-2 §4.2), or `canceling` it, from where it stands to idle, which is looked at now — while its
    // owner owns it. Each is due when its `elapsedTime` falls on the animation's own clock; a cancellation, now.
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
        let into_iteration = (iteration.unwrap_or(0.0) - timing.iteration_start).max(0.0) * timing.duration;
        let ran = current.map_or(0.0, |t| (t - timing.delay).clamp(0.0, active_duration));
        use Phase::*;
        let events: &[(&'static str, f64)] = match (was, phase) {
            (Idle | Before, Active) => &[("animationstart", start)],
            (Idle | Before, After) => &[("animationstart", start), ("animationend", end)],
            (Active, Before) => &[("animationend", start)],
            (Active, Active) => &[("animationiteration", into_iteration)],
            (Active, After) => &[("animationend", end)],
            (After, Active) => &[("animationstart", end)],
            (After, Before) => &[("animationstart", end), ("animationend", start)],
            (Before | Active, Idle) => &[("animationcancel", ran)],
            _ => &[],
        };
        let timeline = self.timeline_time.filter(|_| a.has_timeline).unwrap_or(0.0);
        let due = |kind: &str, elapsed: f64| match (a.start_time, a.playback_rate) {
            (Some(start), rate) if rate != 0.0 && kind != "animationcancel" => start + (timing.delay + elapsed) / rate,
            _ => timeline,
        };
        let queued: Vec<CssEvent> = events
            .iter()
            .map(|&(kind, elapsed)| CssEvent {
                animation: id,
                kind,
                elapsed: elapsed / 1000.0,
                owner: owner.clone(),
                name: css.name.clone(),
                position: css.position,
                scheduled: due(kind, elapsed),
            })
            .collect();
        self.css_events.extend(queued);
        self.animations.get_mut(&id).unwrap().css.as_mut().unwrap().previous = (phase, iteration);
    }

    pub(crate) fn take_css_events(&mut self) -> Vec<CssEvent> {
        std::mem::take(&mut self.css_events)
    }
}

// Whether two keyframe lists are the same: the same blocks (a `@keyframes` rule's, not merely equal ones) at the same
// offsets, easing and compositing alike.
fn same_keyframes(a: &[Keyframe], b: &[Keyframe]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| {
            x.offset == y.offset && x.easing == y.easing && x.composite == y.composite && Arc::ptr_eq(&x.block, &y.block)
        })
}
