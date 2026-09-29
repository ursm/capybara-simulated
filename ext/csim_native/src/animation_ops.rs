// The Web Animations ops (`__dom.anim*`): what a JS `Animation` / `KeyframeEffect` handle asks of the realm's model
// (`animations.rs`, kept by its style engine). A handle holds an id; the model holds everything else, and what the
// handle must do in turn — settle a promise, dispatch an event — comes back as signals (`animSignals`).

use style::selector_parser::PseudoElement;

use crate::animations::{
    AnimationError, AnimationId, CompositeOperation, EffectId, EffectTiming, FillMode, Keyframe, Phase,
    PlayState, PlaybackDirection, ReplaceState, Signal, Target,
};
use crate::dom::{dom, nid_arg, realm_id, register, style_op};
use crate::style::StyleEngine;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "animEffect", anim_effect, context_id);
    register(scope, ns, "animEffectSet", anim_effect_set, context_id);
    register(scope, ns, "animNew", anim_new, context_id);
    register(scope, ns, "animCall", anim_call, context_id);
    register(scope, ns, "animState", anim_state, context_id);
    register(scope, ns, "animTiming", anim_timing, context_id);
    register(scope, ns, "animSignals", anim_signals, context_id);
    register(scope, ns, "animDrop", anim_drop, context_id);
    register(scope, ns, "animCommitValues", anim_commit_values, context_id);
    register(scope, ns, "animNextFrameDelay", anim_next_frame_delay, context_id);
}

// The document timeline at the page's clock `now` (an op's last argument), before an op reads or moves an animation.
fn at_time(engine: &mut StyleEngine, now: Option<f64>) {
    if let Some(now) = now.filter(|n| n.is_finite()) {
        if engine.web_animations.timeline_time != Some(now) {
            engine.web_animations_op(|model| model.set_timeline_time(now));
        }
    }
}

// The realm's style engine, for an op to work on (none: the page is not styled by the engine, and the op does
// nothing).
fn with_engine(
    scope: &mut v8::PinScope<'_, '_>,
    args: &v8::FunctionCallbackArguments<'_>,
    op: impl FnOnce(&mut v8::PinScope<'_, '_>, &mut StyleEngine),
) {
    let cid = realm_id(scope, args);
    style_op(scope, cid, |scope| {
        let engine: *mut StyleEngine = match dom(scope).styles.get_mut(&cid) {
            Some(engine) => engine,
            None => return,
        };
        // SAFETY: the engine lives in the realm's `Dom` for the length of the op, which touches nothing else there.
        op(scope, unsafe { &mut *engine });
    });
}

fn string_arg(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<String> {
    (value.is_string()).then(|| value.to_rust_string_lossy(scope))
}

fn number_arg(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Option<f64> {
    if value.is_null_or_undefined() { None } else { value.number_value(scope) }
}

// An array argument's items, read out as values: a number, a string, or nothing (null, undefined, anything else).
#[derive(Clone, Debug)]
enum Item {
    Number(f64),
    Text(String),
    Nothing,
}

fn array_arg(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Vec<Item> {
    let Ok(array) = v8::Local::<v8::Array>::try_from(value) else { return Vec::new() };
    (0..array.length())
        .map(|i| match array.get_index(scope, i) {
            Some(v) if v.is_string() => Item::Text(v.to_rust_string_lossy(scope)),
            Some(v) if v.is_number() => Item::Number(v.number_value(scope).unwrap_or(0.0)),
            _ => Item::Nothing,
        })
        .collect()
}

impl Item {
    fn number(&self) -> Option<f64> {
        if let Item::Number(n) = self { Some(*n) } else { None }
    }
    fn text(&self) -> Option<&str> {
        if let Item::Text(t) = self { Some(t) } else { None }
    }
}

// A timing as the JS side normalized it: [delay, endDelay, fill, iterationStart, iterations, duration, direction,
// easing] (`duration` a number — `auto` is 0 for a keyframe effect).
fn timing_arg(engine: &StyleEngine, items: &[Item]) -> EffectTiming {
    let number = |i: usize, default: f64| items.get(i).and_then(Item::number).unwrap_or(default);
    let text = |i: usize| items.get(i).and_then(Item::text);
    let fill = match text(2) {
        Some("none") => FillMode::None,
        Some("forwards") => FillMode::Forwards,
        Some("backwards") => FillMode::Backwards,
        Some("both") => FillMode::Both,
        _ => FillMode::Auto,
    };
    let direction = match text(6) {
        Some("reverse") => PlaybackDirection::Reverse,
        Some("alternate") => PlaybackDirection::Alternate,
        Some("alternate-reverse") => PlaybackDirection::AlternateReverse,
        _ => PlaybackDirection::Normal,
    };
    EffectTiming {
        delay: number(0, 0.0),
        end_delay: number(1, 0.0),
        fill,
        iteration_start: number(3, 0.0),
        iterations: number(4, 1.0),
        duration: number(5, 0.0),
        direction,
        easing: engine.easing(text(7).unwrap_or("linear")),
    }
}

fn composite_arg(text: Option<&str>) -> Option<CompositeOperation> {
    match text {
        Some("replace") => Some(CompositeOperation::Replace),
        Some("add") => Some(CompositeOperation::Add),
        Some("accumulate") => Some(CompositeOperation::Accumulate),
        _ => None,
    }
}

// Keyframes as the JS side normalized them, flat: [count, then per keyframe: computed offset, easing | null,
// composite | null, declaration count, then (property, value) pairs — longhands and shorthands as written].
fn keyframes_arg(engine: &StyleEngine, items: &[Item]) -> Vec<Keyframe> {
    let mut at = 1;
    let mut frames = Vec::new();
    let count = items.first().and_then(Item::number).unwrap_or(0.0) as usize;
    for _ in 0..count {
        let Some(offset) = items.get(at).and_then(Item::number) else { break };
        let easing = items.get(at + 1).and_then(Item::text).map(|e| engine.easing(e));
        let composite = composite_arg(items.get(at + 2).and_then(Item::text));
        let declared = items.get(at + 3).and_then(Item::number).unwrap_or(0.0) as usize;
        at += 4;
        let declarations: Vec<(String, String)> = (0..declared)
            .filter_map(|i| {
                let name = items.get(at + 2 * i)?.text()?;
                let value = items.get(at + 2 * i + 1)?.text()?;
                Some((name.to_owned(), value.to_owned()))
            })
            .collect();
        at += 2 * declared;
        frames.push(Keyframe { offset, easing, composite, block: engine.keyframe_block(&declarations) });
    }
    frames
}

// A target: an element (its node id, or -1 for none) and its pseudo-element (`::before`, `::after`, `::marker`).
fn target_arg(
    scope: &mut v8::PinScope<'_, '_>,
    args: &v8::FunctionCallbackArguments<'_>,
    node: i32,
    pseudo: i32,
) -> Option<Target> {
    let node = nid_arg(scope, args, node)?;
    let pseudo = match string_arg(scope, args.get(pseudo)).as_deref() {
        Some("::before") => Some(PseudoElement::Before),
        Some("::after") => Some(PseudoElement::After),
        Some("::marker") => Some(PseudoElement::Marker),
        _ => None,
    };
    Some(Target { node, pseudo })
}

// __dom.animEffect(targetNid | -1, pseudo | null, timing, composite, iterationComposite, keyframes) -> effect id.
fn anim_effect(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    with_engine(scope, &args, |scope, engine| {
        let timing = array_arg(scope, args.get(2));
        let timing = timing_arg(engine, &timing);
        let composite = composite_arg(string_arg(scope, args.get(3)).as_deref()).unwrap_or(CompositeOperation::Replace);
        let accumulate = string_arg(scope, args.get(4)).as_deref() == Some("accumulate");
        let keyframes = array_arg(scope, args.get(5));
        let keyframes = keyframes_arg(engine, &keyframes);
        let target = target_arg(scope, &args, 0, 1);
        let id = engine.web_animations_op(|model| {
            let id = model.new_effect(timing);
            let effect = model.effects.get_mut(&id).unwrap();
            effect.composite = composite;
            effect.iteration_composite_accumulate = accumulate;
            effect.keyframes = keyframes;
            model.set_target(id, target);
            id
        });
        rv.set(v8::Integer::new_from_unsigned(scope, id).into());
    });
}

// __dom.animEffectSet(effect, what, a, b): what an effect's setters change — `timing` (a: timing), `target` (a:
// node | -1, b: pseudo), `keyframes` (a: keyframes), `composite` / `iterationComposite` (a: the operation).
fn anim_effect_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    with_engine(scope, &args, |scope, engine| {
        let Some(id) = number_arg(scope, args.get(0)).map(|n| n as EffectId) else { return };
        match string_arg(scope, args.get(1)).as_deref() {
            Some("timing") => {
                let timing = array_arg(scope, args.get(2));
                let timing = timing_arg(engine, &timing);
                engine.web_animations_op(|model| {
                    if let Some(effect) = model.effects.get_mut(&id) {
                        effect.timing = timing;
                        if let Some(a) = effect.animation {
                            model.update_finished_state(a, false, false);
                            model.touch(a);
                        }
                    }
                });
            },
            Some("target") => {
                let target = target_arg(scope, &args, 2, 3);
                engine.web_animations_op(|model| model.set_target(id, target));
            },
            Some("keyframes") => {
                let keyframes = array_arg(scope, args.get(2));
                let keyframes = keyframes_arg(engine, &keyframes);
                engine.web_animations_op(|model| {
                    if let Some(effect) = model.effects.get_mut(&id) {
                        effect.keyframes = keyframes;
                    }
                    model.keyframes_changed(id);
                });
            },
            Some(what @ ("composite" | "iterationComposite")) => {
                let text = string_arg(scope, args.get(2));
                let is_composite = what == "composite";
                engine.web_animations_op(|model| {
                    if let Some(effect) = model.effects.get_mut(&id) {
                        if is_composite {
                            effect.composite = composite_arg(text.as_deref()).unwrap_or(effect.composite);
                        } else {
                            effect.iteration_composite_accumulate = text.as_deref() == Some("accumulate");
                        }
                    }
                    model.keyframes_changed(id);
                });
            },
            _ => {},
        }
    });
}

// __dom.animNew(effect | 0, hasTimeline) -> animation id.
fn anim_new(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    with_engine(scope, &args, |scope, engine| {
        let effect = number_arg(scope, args.get(0)).map(|n| n as EffectId).filter(|&e| e != 0);
        let has_timeline = args.get(1).boolean_value(scope);
        let id = engine.web_animations_op(|model| model.new_animation(effect, has_timeline));
        rv.set(v8::Integer::new_from_unsigned(scope, id).into());
    });
}

// __dom.animCall(animation, method, arg, now) -> undefined, or the name of the error the method throws
// (`InvalidStateError`, `TypeError`).
fn anim_call(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    with_engine(scope, &args, |scope, engine| {
        let Some(id) = number_arg(scope, args.get(0)).map(|n| n as AnimationId) else { return };
        let method = string_arg(scope, args.get(1)).unwrap_or_default();
        let arg = number_arg(scope, args.get(2));
        let now = number_arg(scope, args.get(3));
        at_time(engine, now);
        let result = engine.web_animations_op(|model| {
            if !model.animations.contains_key(&id) {
                return Ok(());
            }
            let result = match method.as_str() {
                "play" => model.play(id, true),
                "pause" => model.pause(id),
                "finish" => model.finish(id),
                "cancel" => {
                    model.cancel(id);
                    Ok(())
                },
                "reverse" => model.reverse(id),
                "currentTime" => model.set_current_time(id, arg),
                "startTime" => {
                    model.set_start_time(id, arg);
                    Ok(())
                },
                "playbackRate" => {
                    model.set_playback_rate(id, arg.unwrap_or(1.0));
                    Ok(())
                },
                "updatePlaybackRate" => {
                    model.update_playback_rate(id, arg.unwrap_or(1.0));
                    Ok(())
                },
                "effect" => {
                    model.touch(id);
                    model.set_effect(id, arg.map(|n| n as EffectId).filter(|&e| e != 0));
                    Ok(())
                },
                "finishNotification" => {
                    model.finish_notification(id);
                    Ok(())
                },
                "persist" => {
                    model.animations.get_mut(&id).unwrap().replace_state = ReplaceState::Persisted;
                    Ok(())
                },
                _ => Ok(()),
            };
            model.touch(id);
            result
        });
        if let Err(error) = result {
            let name = match error {
                AnimationError::InvalidState => "InvalidStateError",
                AnimationError::Type => "TypeError",
            };
            if let Some(s) = v8::String::new(scope, name) {
                rv.set(s.into());
            }
        }
    });
}

// __dom.animDrop(kind, id): a handle is gone (`animation` / `effect`), and what it held with it.
fn anim_drop(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    with_engine(scope, &args, |scope, engine| {
        let kind = string_arg(scope, args.get(0));
        let Some(id) = number_arg(scope, args.get(1)).map(|n| n as u32) else { return };
        engine.web_animations_op(|model| match kind.as_deref() {
            Some("animation") => model.drop_animation(id),
            Some("effect") => model.drop_effect(id),
            _ => {},
        });
    });
}

// __dom.animCommitValues(animation, now) -> [property, value, …]: what `commitStyles()` writes (§4.4.19).
fn anim_commit_values(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    with_engine(scope, &args, |scope, engine| {
        let Some(id) = number_arg(scope, args.get(0)).map(|n| n as AnimationId) else { return };
        at_time(engine, number_arg(scope, args.get(1)));
        let mut items: Vec<v8::Local<v8::Value>> = Vec::new();
        for value in engine.web_animations.committed_values(id) {
            let declaration = value.uncompute();
            let mut css = String::new();
            if declaration.to_css(&mut css).is_err() {
                continue;
            }
            items.push(string_value(scope, &declaration.id().name()));
            items.push(string_value(scope, &css));
        }
        rv.set(v8::Array::new_with_elements(scope, &items).into());
    });
}

// __dom.animNextFrameDelay(now) -> ms until an animation next needs a frame, or -1 (none runs).
fn anim_next_frame_delay(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set(v8::Number::new(scope, -1.0).into());
    with_engine(scope, &args, |scope, engine| {
        at_time(engine, number_arg(scope, args.get(0)));
        let delay = engine.web_animations.next_frame_delay().unwrap_or(-1.0);
        rv.set(v8::Number::new(scope, delay).into());
    });
}

fn optional_number<'s>(scope: &mut v8::PinScope<'s, '_>, value: Option<f64>) -> v8::Local<'s, v8::Value> {
    match value {
        Some(n) => v8::Number::new(scope, n).into(),
        None => v8::null(scope).into(),
    }
}

fn string_value<'s>(scope: &mut v8::PinScope<'s, '_>, text: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, text).map_or_else(|| v8::undefined(scope).into(), Into::into)
}

// __dom.animState(animation, now) -> [playState, currentTime | null, startTime | null, playbackRate, pending,
// readyGeneration, readySettled, finishedGeneration, finishedSettled, replaceState, finishNotificationQueued].
fn anim_state(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    with_engine(scope, &args, |scope, engine| {
        let Some(id) = number_arg(scope, args.get(0)).map(|n| n as AnimationId) else { return };
        let now = number_arg(scope, args.get(1));
        at_time(engine, now);
        let model = &engine.web_animations;
        let Some(a) = model.animations.get(&id) else { return };
        let play_state = match model.play_state(id) {
            PlayState::Idle => "idle",
            PlayState::Running => "running",
            PlayState::Paused => "paused",
            PlayState::Finished => "finished",
        };
        let replace_state = match a.replace_state {
            ReplaceState::Active => "active",
            ReplaceState::Removed => "removed",
            ReplaceState::Persisted => "persisted",
        };
        let items = [
            string_value(scope, play_state),
            optional_number(scope, model.current_time(id)),
            optional_number(scope, a.start_time),
            v8::Number::new(scope, a.playback_rate).into(),
            v8::Boolean::new(scope, a.pending.is_some()).into(),
            v8::Number::new(scope, a.ready.generation as f64).into(),
            v8::Boolean::new(scope, a.ready.settled).into(),
            v8::Number::new(scope, a.finished.generation as f64).into(),
            v8::Boolean::new(scope, a.finished.settled).into(),
            string_value(scope, replace_state),
            v8::Boolean::new(scope, a.finish_notification_queued).into(),
        ];
        rv.set(v8::Array::new_with_elements(scope, &items).into());
    });
}

// __dom.animTiming(effect, now) -> [localTime | null, progress | null, currentIteration | null, activeDuration, endTime,
// phase] — what `getComputedTiming()` adds to the timing.
fn anim_timing(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    with_engine(scope, &args, |scope, engine| {
        let Some(id) = number_arg(scope, args.get(0)).map(|n| n as EffectId) else { return };
        let now = number_arg(scope, args.get(1));
        at_time(engine, now);
        let Some(timing) = engine.web_animations.computed_timing(id) else { return };
        let phase = match timing.phase {
            Phase::Before => "before",
            Phase::Active => "active",
            Phase::After => "after",
            Phase::Idle => "idle",
        };
        let items = [
            optional_number(scope, timing.local_time),
            optional_number(scope, timing.progress),
            optional_number(scope, timing.current_iteration),
            v8::Number::new(scope, timing.active_duration).into(),
            v8::Number::new(scope, timing.end_time).into(),
            string_value(scope, phase),
        ];
        rv.set(v8::Array::new_with_elements(scope, &items).into());
    });
}

// __dom.animSignals() -> [kind, animation, a, b, …]: what the handles are to do, in order — `ready` / `readyReject` /
// `finished` / `finishedReject` (a: the promise's generation), `finish` (a: current time, b: timeline time),
// `cancel` / `remove` (b: timeline time), and `finishNotification` (a microtask to queue for the animation).
fn anim_signals(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    with_engine(scope, &args, |scope, engine| {
        let signals = engine.web_animations.take_signals();
        let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(signals.len() * 4);
        for signal in signals {
            let (kind, animation, a, b) = match signal {
                Signal::ReadyResolved { animation, generation } => ("ready", animation, Some(generation as f64), None),
                Signal::ReadyRejected { animation, generation } => ("readyReject", animation, Some(generation as f64), None),
                Signal::FinishedResolved { animation, generation } => ("finished", animation, Some(generation as f64), None),
                Signal::FinishedRejected { animation, generation } => {
                    ("finishedReject", animation, Some(generation as f64), None)
                },
                Signal::Finish { animation, current_time, timeline_time } => ("finish", animation, current_time, timeline_time),
                Signal::Cancel { animation, timeline_time } => ("cancel", animation, None, timeline_time),
                Signal::Remove { animation, timeline_time } => ("remove", animation, None, timeline_time),
                Signal::FinishNotificationQueued { animation } => ("finishNotification", animation, None, None),
            };
            items.push(string_value(scope, kind));
            items.push(v8::Number::new(scope, animation as f64).into());
            items.push(optional_number(scope, a));
            items.push(optional_number(scope, b));
        }
        rv.set(v8::Array::new_with_elements(scope, &items).into());
    });
}
