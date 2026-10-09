// CSS animations as the Web Animations model runs them (css-animations-2 §3 – §4): an animation style made and owns,
// which its owning element's style keeps up to date — what the style says of it where a script has not said otherwise
// since — and which owes `animationstart` / `animationiteration` / `animationend` / `animationcancel` as its phase
// moves. The style engine reads an element's style into `CssAnimationStyle`s (`style.rs`); the model does the rest,
// as Gecko's `nsAnimationManager` and `CSSAnimation` do.

use bitflags::bitflags;
use style::servo_arc::Arc;
use style::values::computed::easing::ComputedTimingFunction;

use crate::animations::{AnimationId, Animations, CompositeOperation, EffectTiming, Keyframe, PlayState, Target};
use crate::css::CssKind;

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

// What a CSS animation is besides an animation and its owner (css.rs): the `@keyframes` name it runs and its place in
// its owner's `animation-name`; what of it a script has set; and whether `animation-play-state` paused it, as the
// style last said.
#[derive(Clone, Debug)]
pub(crate) struct CssAnimation {
    pub(crate) name: String,
    pub(crate) position: usize,
    pub(crate) overridden: Overrides,
    style_paused: bool,
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

impl Animations {
    // The CSS animations `owner`'s style made and still lists, in `animation-name` order.
    pub(crate) fn css_animations_of(&self, owner: &Target) -> Vec<AnimationId> {
        let mut out: Vec<(usize, AnimationId)> = self
            .owned_by(owner)
            .filter_map(|id| Some((self.css_animation(id)?.position, id)))
            .collect();
        out.sort_unstable();
        out.into_iter().map(|(_, id)| id).collect()
    }

    pub(crate) fn has_css_animations(&self, owner: &Target) -> bool {
        self.owned_by(owner).any(|id| self.css_animation(id).is_some())
    }

    fn css_animation(&self, id: AnimationId) -> Option<&CssAnimation> {
        self.animations.get(&id)?.css.as_ref()?.animation()
    }

    fn css_animation_mut(&mut self, id: AnimationId) -> Option<&mut CssAnimation> {
        self.animations.get_mut(&id)?.css.as_mut()?.animation_mut()
    }

    // The CSS animations `owner`'s style now lists (css-animations-2 §3; Gecko's `BuildAnimations`): each takes over
    // the one by its name it ran before — matched from the end of both lists — and a new one is made where there is
    // none; one the style no longer lists is canceled and let go.
    pub(crate) fn update_css_animations(&mut self, owner: &Target, styles: Vec<CssAnimationStyle>) {
        let mut old = self.css_animations_of(owner);
        for (position, style) in styles.into_iter().enumerate().rev() {
            let same_name = old.iter().rposition(|&id| self.css_animation(id).is_some_and(|a| a.name == style.name));
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
        self.set_target(effect, Some(owner.clone()));
        let id = self.new_animation(Some(effect), Some(0.0));
        let animation =
            CssAnimation { name: style.name, position, overridden: Overrides::empty(), style_paused: style.paused };
        self.own(id, owner, CssKind::Animation(animation));
        let _ = if style.paused { self.pause(id) } else { self.play(id, true) };
        id
    }

    // A CSS animation its owner's new style still lists: what the style says of it where a script has not said
    // otherwise (Gecko's `UpdateOldAnimationPropertiesWithNew`), and a change of its play state followed — unless it
    // is idle, which a change of `animation-play-state` does not restart.
    fn restyle_css_animation(&mut self, id: AnimationId, style: CssAnimationStyle, position: usize) {
        let css = self.css_animation_mut(id).unwrap();
        css.position = position;
        let overridden = css.overridden;
        let was_style_paused = std::mem::replace(&mut css.style_paused, style.paused);
        let mut keyframes_changed = false;
        if let Some(e) = self.animations[&id].effect.and_then(|e| self.effects.get_mut(&e)) {
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
        if let Some(css) = self.css_animation_mut(id).filter(|_| takes_over) {
            css.overridden |= Overrides::PLAY_STATE;
        }
    }

    // A script set `what` of the CSS animation playing `effect`: its style no longer does.
    pub(crate) fn override_css(&mut self, effect: crate::animations::EffectId, what: Overrides) {
        if let Some(css) = self.effects.get(&effect).and_then(|e| e.animation).and_then(|a| self.css_animation_mut(a)) {
            css.overridden |= what;
        }
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
