// A pointer's orientation (Pointer Events §4.1.3, "converting between tiltX / tiltY and altitudeAngle / azimuthAngle"):
// given either way — its tilts in degrees, or its altitude and azimuth in radians — the other pair converted from it,
// and, given neither, a pointer perpendicular to the surface (no tilt, an altitude of π/2, an azimuth of 0). A
// PointerEvent's constructor takes what its init gives (the bindings read the members). And the mouse pointer the driver
// plays — every gesture of it, a click, a right click, a double click, a hover, a drag (`MousePointer`) — and its pointer
// capture.

use std::f64::consts::{FRAC_PI_2, PI};

use crate::dom::{NodeId, RealmArena, STATE_ACTIVE};

// [tiltX, tiltY, altitudeAngle, azimuthAngle] from an init's members (None for one not given).
pub(crate) fn orientation(tilt_x: Option<f64>, tilt_y: Option<f64>, altitude: Option<f64>, azimuth: Option<f64>) -> [f64; 4] {
    let tilted = tilt_x.is_some() || tilt_y.is_some();
    let angled = altitude.is_some() || azimuth.is_some();
    if tilted || !angled {
        let (tx, ty) = (tilt_x.unwrap_or(0.0), tilt_y.unwrap_or(0.0));
        if angled {
            return [tx, ty, altitude.unwrap_or(FRAC_PI_2), azimuth.unwrap_or(0.0)];
        }
        let (x, y) = (tx.to_radians(), ty.to_radians());
        let upright = tx.abs() == 90.0 || ty.abs() == 90.0;
        let azimuth = if tx == 0.0 {
            if ty > 0.0 { FRAC_PI_2 } else if ty < 0.0 { 3.0 * FRAC_PI_2 } else { 0.0 }
        } else if ty == 0.0 {
            if tx < 0.0 { PI } else { 0.0 }
        } else if upright {
            0.0
        } else {
            (y.tan().atan2(x.tan()) + 2.0 * PI) % (2.0 * PI)
        };
        let altitude = if upright {
            0.0
        } else if tx == 0.0 {
            FRAC_PI_2 - y.abs()
        } else if ty == 0.0 {
            FRAC_PI_2 - x.abs()
        } else {
            (1.0 / (x.tan().powi(2) + y.tan().powi(2)).sqrt()).atan()
        };
        return [tx, ty, altitude, azimuth];
    }
    let (altitude, azimuth) = (altitude.unwrap_or(FRAC_PI_2), azimuth.unwrap_or(0.0));
    let (x, y) = if altitude == 0.0 {
        // (…lying on the surface: a tilt of ±90° toward the azimuth's quadrant)
        let q = FRAC_PI_2;
        let x = if azimuth == q || azimuth == 3.0 * q { 0.0 } else if azimuth < q || azimuth > 3.0 * q { q } else { -q };
        let y = if azimuth == 0.0 || azimuth == 2.0 * q || azimuth == 4.0 * q { 0.0 } else if azimuth < 2.0 * q { q } else { -q };
        (x, y)
    } else {
        ((azimuth.cos() / altitude.tan()).atan(), (azimuth.sin() / altitude.tan()).atan())
    };
    // (…rounded as ECMAScript's Math.round does, a half up — to a `long`, which has no -0)
    let round = |v: f64| (v + 0.5).floor() + 0.0;
    [round(x.to_degrees()), round(y.to_degrees()), altitude, azimuth]
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "pointerOrientation", orientation_op, context_id);
    crate::dom::register(scope, ns, "pointerGesture", gesture_op, context_id);
    crate::dom::register(scope, ns, "pointerNext", next_op, context_id);
    crate::dom::register(scope, ns, "setPointerCapture", set_capture_op, context_id);
    crate::dom::register(scope, ns, "releasePointerCapture", release_capture_op, context_id);
    crate::dom::register(scope, ns, "hasPointerCapture", has_capture_op, context_id);
}

// The page's mouse pointer — the one pointer the driver plays (Pointer Events: its `pointerId` 1, as Chrome's, a
// `pointerType` "mouse", primary) — and the gesture it is playing: what its buttons hold, what it is over, what it pressed,
// its PREVENT MOUSE EVENT flag (§11.1), its pointer capture, and the steps the gesture has yet to take. The bindings play
// a gesture (bridge.entry.js `playPointer`): they ask for it (`pointerGesture`) and then for each step in turn
// (`pointerNext`), telling the engine whether the event they fired was canceled, and they fire what they are told to — every
// decision of which event, at what, with which buttons and count, and whether at all, is made here.
#[derive(Default)]
pub(crate) struct MousePointer {
    // The buttons held (`buttons`' bits).
    buttons: u32,
    // What the pointer is over: what the driver aimed it at, whatever captures it.
    at: Option<NodeId>,
    // What the button held was pressed at (a click's target is shared with its release's: UI Events).
    pressed: Option<NodeId>,
    // The PREVENT MOUSE EVENT flag (§11.1): set at a press whose `pointerdown` was canceled, cleared at the release —
    // which reads it as it was at its `pointerup` (`release_prevented`).
    prevented: bool,
    release_prevented: bool,
    // Whether the press's default action is prevented: its `pointerdown` or its `mousedown` canceled.
    press_prevented: bool,
    // The pending pointer capture target override and the pointer capture target override (§10.1).
    pending_capture: Option<NodeId>,
    capture: Option<NodeId>,
    // The gesture being played: its phases yet to plan (`MOVE` | `PRESS` | `RELEASE` | `NO_CLICK`), its button and click
    // count, the realm it plays in, its steps planned, and the event the bindings were last handed.
    phases: u32,
    button: u32,
    detail: u32,
    cid: i32,
    steps: std::collections::VecDeque<Step>,
    last: Option<&'static str>,
}

// A gesture's phases: the pointer moved to its target, a button pressed there, and released — with no click where the
// press became a drag (`NO_CLICK`: a drag-and-drop's release, which no click follows).
const MOVE: u32 = 1;
const PRESS: u32 = 2;
const RELEASE: u32 = 4;
const NO_CLICK: u32 = 8;
// What a gesture's end answers: whether its press's default action was prevented.
const PRESS_PREVENTED: u32 = 1;

// A step of a gesture, as the bindings take it: an event to fire, or a default action of the press.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Step {
    Fire(Fire),
    // The document's hovered element (`:hover`), which the bindings set (dom-nodes.js `setHoveredElement`: a frame's
    // passes up to its container).
    Hover(NodeId),
    // The element being activated (`:active`), which the engine sets.
    Active(Option<NodeId>),
    // A press's default actions, none where it was prevented: the focus moved (focus.rs `press_target`), the caret set in
    // an editing host (layout.js `caretFromPoint`), and — a second press of the primary button — the word there selected.
    Focus(NodeId),
    Caret(NodeId),
    Word(NodeId),
}
#[derive(Clone, Copy, Debug, PartialEq)]
struct Fire {
    ty: &'static str,
    pointer: bool,
    target: NodeId,
    related: Option<NodeId>,
    button: i32,
    buttons: u32,
    detail: u32,
    when: When,
}
// Whether a planned event is still fired as its turn comes: always; where its target is in a document yet (a boundary
// event at a node a listener of one before it took out of the document goes nowhere — Chrome); where the PREVENT MOUSE
// EVENT flag does not hold back a compatibility mouse event (§11.1 — a release's as it was at its `pointerup`); a click
// where its target is in a document and the click is not withheld from it (HTML: a disabled form control, and what a
// disabled button holds, get none: activation.rs `click_withheld`).
#[derive(Clone, Copy, Debug, PartialEq)]
enum When {
    Always,
    Connected,
    Compat,
    CompatRelease,
    Click,
}

// The bit of `buttons` a `button` holds (UI Events: primary 1, auxiliary 4, secondary 2, back 8, forward 16).
fn button_bit(button: u32) -> u32 {
    match button {
        0 => 1,
        1 => 4,
        2 => 2,
        b => 1 << b.min(31),
    }
}

impl MousePointer {
    fn fire(&mut self, ty: &'static str, target: NodeId, related: Option<NodeId>, button: i32, detail: u32, when: When) {
        let pointer = !ty.starts_with("mouse") && ty != "dblclick";
        let buttons = self.buttons;
        self.steps.push_back(Step::Fire(Fire { ty, pointer, target, related, button, buttons, detail, when }));
    }

    // "Process pending pointer capture" (§10.4), before a pointer event: the override lost where the pending one is not it,
    // the pending one got where it is not the override — the events of the pointer event that runs them (its button, the
    // buttons held) — and the pending one the override. An override no longer in a document loses it at its document
    // (§10.5: "lostpointercapture … SHOULD be fired at the document"), a pending one that left is dropped. The element that
    // got it, for the boundary events to it to go first (Chrome and Firefox).
    fn process_pending_capture(&mut self, arena: &RealmArena, button: i32) -> Option<NodeId> {
        if let Some(c) = self.capture.filter(|&c| !arena.is_connected(c)) {
            if let Some(doc) = arena.get(c).and_then(|n| arena.realm_document(n.realm)) {
                self.fire("lostpointercapture", doc, None, button, 0, When::Always);
            }
            self.capture = None;
        }
        if self.pending_capture.is_some_and(|c| !arena.is_connected(c)) {
            self.pending_capture = None;
        }
        if let Some(lost) = self.capture.filter(|&c| Some(c) != self.pending_capture) {
            self.fire("lostpointercapture", lost, None, button, 0, When::Connected);
        }
        let got = self.pending_capture.filter(|&p| Some(p) != self.capture);
        self.capture = self.pending_capture;
        got
    }

    // The pointer going over `to` from `from` (the hovered element, where it is in a document): the hovered element `to`,
    // the pointer's boundary events — out at the element left and leave at each it leaves, innermost first, then over at
    // `to` and enter at each it enters, outermost first, the other side their related target — then `got`'s capture,
    // then the same of the compatibility mouse events (Pointer Events; Chrome, measured). `mouse` false: the pointer's
    // alone, its mouse events catching up later (a capture released: `plan_release`).
    fn boundaries(&mut self, arena: &RealmArena, from: Option<NodeId>, to: NodeId, got: Option<NodeId>, mouse: bool) {
        // (…none onto a node no document holds: nothing is hovered that is not in one)
        let moved = from != Some(to) && arena.is_connected(to);
        let (leave, enter) = if moved { crate::event_path::hover_chains(arena, from, Some(to)) } else { Default::default() };
        if moved {
            self.steps.push_back(Step::Hover(to));
            self.boundary_events(from, to, &leave, &enter, ["pointerout", "pointerleave", "pointerover", "pointerenter"], -1);
        }
        if let Some(got) = got {
            self.fire("gotpointercapture", got, None, -1, 0, When::Connected);
        }
        if moved && mouse {
            self.boundary_events(from, to, &leave, &enter, ["mouseout", "mouseleave", "mouseover", "mouseenter"], 0);
        }
    }
    fn boundary_events(&mut self, from: Option<NodeId>, to: NodeId, leave: &[NodeId], enter: &[NodeId], [out, left, over, entered]: [&'static str; 4], button: i32) {
        if let Some(from) = from {
            self.fire(out, from, Some(to), button, 0, When::Connected);
            for &el in leave {
                self.fire(left, el, Some(to), button, 0, When::Connected);
            }
        }
        self.fire(over, to, from, button, 0, When::Connected);
        for &el in enter {
            self.fire(entered, el, from, button, 0, When::Connected);
        }
    }

    // What the pointer is over as far as its events go: its capture's target, else what it is at.
    fn target(&self) -> Option<NodeId> {
        self.capture.or(self.at)
    }

    // A move to what it is at: the boundary events where that is not what was hovered, then `pointermove` and its
    // `mousemove`. A move with no button changed reports -1 as the pointer's button, 0 as the mouse's (Chrome, Firefox).
    fn plan_move(&mut self, arena: &RealmArena, hovered: Option<NodeId>) {
        let got = self.process_pending_capture(arena, -1);
        let Some(target) = self.target() else { return };
        self.boundaries(arena, hovered, target, got, true);
        self.fire("pointermove", target, None, -1, 0, When::Always);
        self.fire("mousemove", target, None, 0, 0, When::Compat);
    }

    // A press of `button` — the `count`th click of it (a double click's second is 2): the element pressed `:active` from
    // before its `pointerdown` (Chrome, Firefox) — of the primary button alone (Selectors 4 §9.3: "On systems with more
    // than one mouse button, :active applies only to the primary or primary activation button", where Chrome and Firefox
    // activate on any) — its `pointerdown` (whose `detail` is 0: Pointer Events) and `mousedown`
    // (its count), the focus — and, of the primary button, the caret, a second press selecting the word — and, of the
    // secondary button, the context menu as on Linux, at the press, whether or not the press was canceled (Chrome,
    // Firefox).
    fn plan_press(&mut self, arena: &RealmArena, hovered: Option<NodeId>) {
        let button = self.button as i32;
        let got = self.process_pending_capture(arena, button);
        let Some(target) = self.target() else { return };
        self.boundaries(arena, hovered, target, got, true);
        self.pressed = Some(target);
        self.press_prevented = false;
        self.buttons |= button_bit(self.button);
        if self.button == 0 {
            self.steps.push_back(Step::Active(Some(target)));
        }
        self.fire("pointerdown", target, None, button, 0, When::Always);
        self.fire("mousedown", target, None, button, self.detail, When::Compat);
        self.steps.push_back(Step::Focus(target));
        if self.button == 0 {
            self.steps.push_back(Step::Caret(target));
            if self.detail == 2 {
                self.steps.push_back(Step::Word(target));
            }
        }
        if self.button == 2 {
            self.fire("contextmenu", target, None, button, 1, When::Always);
        }
    }

    // A release of `button`: nothing `:active` from before its `pointerup` (Chrome, Firefox), its `pointerup` and `mouseup`
    // at what the pointer is over — a captured pointer's at its capture's target, which loses the capture right after the
    // `pointerup` (§10.5 "implicit release", Firefox), the pointer's boundary events back to what it is at following — then
    // the click: `click` of the primary button, `auxclick` of another (UI Events), at the captured target (Pointer Events
    // §"the click, auxclick and contextmenu events"), else at the nearest flat-tree ancestor the press's target and the
    // release's share (Chrome, Firefox: a press dragged off its element clicks their common ancestor; none where they share
    // none, its press's target gone) — a double click's second followed by its `dblclick` — and the mouse's boundary
    // events back to what the pointer is at (Chrome, Firefox).
    fn plan_release(&mut self, arena: &RealmArena, hovered: Option<NodeId>) {
        let button = self.button as i32;
        self.buttons &= !button_bit(self.button);
        self.steps.push_back(Step::Active(None));
        let got = self.process_pending_capture(arena, button);
        let Some(target) = self.target() else { return };
        self.boundaries(arena, hovered, target, got, true);
        let captured = self.capture;
        self.fire("pointerup", target, None, button, 0, When::Always);
        if let Some(c) = captured {
            self.pending_capture = None;
            self.capture = None;
            self.fire("lostpointercapture", c, None, button, 0, When::Connected);
            if let Some(at) = self.at {
                self.boundaries(arena, Some(c), at, None, false);
            }
        }
        self.fire("mouseup", target, None, button, self.detail, When::CompatRelease);
        let pressed = self.pressed.take();
        let click = captured.or_else(|| pressed.and_then(|p| flat_common_ancestor(arena, p, target)));
        if let Some(click) = click.filter(|_| self.phases & NO_CLICK == 0) {
            self.fire(if button == 0 { "click" } else { "auxclick" }, click, None, button, self.detail, When::Click);
            if button == 0 && self.detail == 2 {
                self.fire("dblclick", click, None, button, 2, When::Click);
            }
        }
        if let Some((c, at)) = captured.zip(self.at).filter(|&(c, at)| c != at) {
            let (leave, enter) = crate::event_path::hover_chains(arena, Some(c), Some(at));
            self.boundary_events(Some(c), at, &leave, &enter, ["mouseout", "mouseleave", "mouseover", "mouseenter"], 0);
        }
    }

    // The gesture's press let go of with no release: no button held, no flag, no capture.
    fn abandon(&mut self) {
        self.buttons = 0;
        self.pressed = None;
        self.prevented = false;
        self.pending_capture = None;
        self.capture = None;
    }

    // The next phase planned, where the steps planned are all taken.
    fn plan(&mut self, arena: &RealmArena) {
        let hovered = arena.hover.filter(|&h| arena.is_connected(h));
        for phase in [MOVE, PRESS, RELEASE] {
            if self.phases & phase != 0 {
                self.phases &= !phase;
                match phase {
                    MOVE => self.plan_move(arena, hovered),
                    PRESS => self.plan_press(arena, hovered),
                    _ => self.plan_release(arena, hovered),
                }
                return;
            }
        }
    }

    // The outcome of the event last handed out — whether it was canceled — taken: a `pointerdown`'s sets the flag and,
    // with a `mousedown`'s, prevents the press's default action; a `pointerup` takes the flag, which held its `mouseup`
    // back or not.
    fn take_outcome(&mut self, canceled: bool) {
        match self.last.take() {
            Some("pointerdown") => {
                self.prevented = canceled;
                self.press_prevented |= canceled;
            }
            Some("mousedown") => self.press_prevented |= canceled,
            Some("pointerup") => self.release_prevented = std::mem::take(&mut self.prevented),
            _ => {}
        }
    }

    // The next step the bindings take: the steps the engine takes itself (`:active`) taken, and an event no longer fired
    // passed over. None at the gesture's end.
    fn next(&mut self, arena: &mut RealmArena) -> Option<Step> {
        loop {
            if self.steps.is_empty() {
                if self.phases & (MOVE | PRESS | RELEASE) == 0 {
                    return None;
                }
                self.plan(arena);
                continue;
            }
            let step = self.steps.pop_front()?;
            match step {
                Step::Active(target) => set_active(arena, target),
                Step::Fire(f) if !self.fires(arena, &f) => {}
                Step::Focus(_) | Step::Caret(_) | Step::Word(_) if self.press_prevented => {}
                Step::Fire(f) => {
                    self.last = Some(f.ty);
                    return Some(step);
                }
                _ => return Some(step),
            }
        }
    }
    fn fires(&self, arena: &RealmArena, f: &Fire) -> bool {
        match f.when {
            When::Always => true,
            When::Connected => arena.is_connected(f.target),
            When::Compat => !self.prevented,
            When::CompatRelease => !self.release_prevented,
            When::Click => arena.is_connected(f.target) && !arena.click_withheld(f.target),
        }
    }
}

// The nearest element that is `a` or a flat-tree ancestor of it and is `b` or one of `b`'s too — none where they share
// none.
fn flat_common_ancestor(arena: &RealmArena, a: NodeId, b: NodeId) -> Option<NodeId> {
    std::iter::successors(Some(a), |&n| crate::geometry::flat_parent(arena, n))
        .find(|&n| arena.is_element(n) && crate::geometry::flat_inclusive_ancestor(arena, n, b))
}

// The element being activated (`:active`): `target`, or none.
fn set_active(arena: &mut RealmArena, target: Option<NodeId>) {
    if let Some(prev) = arena.active.filter(|&a| Some(a) != target) {
        let bits = arena.get(prev).map_or(0, |n| n.state);
        arena.set_state(prev, bits & !STATE_ACTIVE);
    }
    if let Some(target) = target {
        let bits = arena.get(target).map_or(0, |n| n.state);
        arena.set_state(target, bits | STATE_ACTIVE);
    }
}

// A step as the bindings take it: `[kind, type, target, relatedTarget, button, buttons, detail, pressure, flags]` for an
// event (`kind` FIRE_POINTER or FIRE_MOUSE, `flags` BUBBLES | CANCELABLE), `[kind, element]` for the rest.
const FIRE_POINTER: u32 = 0;
const FIRE_MOUSE: u32 = 1;
const HOVER: u32 = 2;
const FOCUS: u32 = 3;
const CARET: u32 = 4;
const WORD: u32 = 5;
const BUBBLES: u32 = 1;
const CANCELABLE: u32 = 2;
fn step_value<'s>(scope: &mut v8::PinScope<'s, '_>, step: Step) -> v8::Local<'s, v8::Value> {
    let (kind, el) = match step {
        Step::Fire(f) => return fire_value(scope, f),
        Step::Hover(el) => (HOVER, el),
        Step::Focus(el) => (FOCUS, el),
        Step::Caret(el) => (CARET, el),
        Step::Word(el) => (WORD, el),
        Step::Active(_) => unreachable!("taken by the engine"),
    };
    let kind = v8::Integer::new_from_unsigned(scope, kind).into();
    let el = crate::dom::node_value(scope, Some(el));
    v8::Array::new_with_elements(scope, &[kind, el]).into()
}
fn fire_value<'s>(scope: &mut v8::PinScope<'s, '_>, f: Fire) -> v8::Local<'s, v8::Value> {
    // (…the flags of its type: an enter or a leave neither bubbles nor is cancelable, a capture's got or lost is not
    // cancelable — Pointer Events' and UI Events' tables)
    let flags = match f.ty {
        "pointerenter" | "pointerleave" | "mouseenter" | "mouseleave" => 0,
        "gotpointercapture" | "lostpointercapture" => BUBBLES,
        _ => BUBBLES | CANCELABLE,
    };
    // (…a pointer's pressure 0.5 while a button is held, 0 while none is: a pointer that reports none, Pointer Events)
    let pressure = if f.buttons != 0 { 0.5 } else { 0.0 };
    let kind = v8::Integer::new_from_unsigned(scope, if f.pointer { FIRE_POINTER } else { FIRE_MOUSE }).into();
    let ty = v8::String::new_from_one_byte(scope, f.ty.as_bytes(), v8::NewStringType::Internalized).unwrap().into();
    let target = crate::dom::node_value(scope, Some(f.target));
    let related = crate::dom::node_value(scope, f.related);
    let numbers = [f.button as f64, f.buttons as f64, f.detail as f64, pressure, flags as f64].map(|n| v8::Number::new(scope, n).into());
    let all: [v8::Local<v8::Value>; 9] = [kind, ty, target, related, numbers[0], numbers[1], numbers[2], numbers[3], numbers[4]];
    v8::Array::new_with_elements(scope, &all).into()
}

// The gesture's next step to the bindings, or — at its end — what it answers (PRESS_PREVENTED).
fn answer_next(scope: &mut v8::PinScope<'_, '_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let d = crate::dom::dom(scope);
    let cid = d.mouse.cid;
    // (…none past its realm's end: a frame whose listener removed it)
    let next = match d.arena.enter_known(cid) {
        Some(arena) => d.mouse.next(arena),
        None => None,
    };
    match next {
        Some(step) => {
            let value = step_value(scope, step);
            rv.set(value);
        }
        None => {
            let answer = if crate::dom::dom(scope).mouse.press_prevented { PRESS_PREVENTED } else { 0 };
            rv.set_uint32(answer);
        }
    }
}

// __dom.pointerGesture(phases, nid, button, count) -> the first step of a gesture of the mouse pointer at the element
// `nid` — where it is from now on — of `phases` (MOVE | PRESS | RELEASE | NO_CLICK), its `button` pressed or released the
// `count`th time; its answer where it has none.
fn gesture_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    let phases = args.get(0).uint32_value(scope).unwrap_or(0);
    let at = crate::dom::nid_arg(scope, &args, 1);
    let button = args.get(2).uint32_value(scope).unwrap_or(0);
    let detail = args.get(3).uint32_value(scope).unwrap_or(1);
    let cid = crate::dom::realm_id(scope, &args);
    let d = crate::dom::dom(scope);
    let mouse = &mut d.mouse;
    mouse.steps.clear();
    mouse.last = None;
    mouse.press_prevented = false;
    // (…a press no release followed — a gesture the driver abandoned, a delayed click a navigation overtook — is over
    // before another begins: the driver presses one button at a time)
    if phases & PRESS != 0 && mouse.buttons != 0 {
        mouse.abandon();
        if let Some(arena) = d.arena.enter_known(cid) {
            set_active(arena, None);
        }
    }
    let mouse = &mut d.mouse;
    mouse.at = at.or(mouse.at);
    (mouse.phases, mouse.button, mouse.detail, mouse.cid) = (phases, button, detail, cid);
    answer_next(scope, rv);
}

// __dom.pointerNext(canceled) -> the gesture's next step, the event last handed out `canceled` or not; its answer at its end.
fn next_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    let canceled = args.get(0).is_true();
    crate::dom::dom(scope).mouse.take_outcome(canceled);
    answer_next(scope, rv);
}

// Element's pointer capture (Pointer Events §10.2) of the pointer `pointerId` — the mouse's, 1, the only pointer there is:
// another NotFoundError (1); an element in no document InvalidStateError (2); none taken while no button is held ("fails
// silently": Chrome) — and its release, nothing where the element does not have it.
const NOT_FOUND: u32 = 1;
const INVALID_STATE: u32 = 2;
const MOUSE_POINTER_ID: f64 = 1.0;
// __dom.setPointerCapture(element, pointerId) -> 0, or the error (NOT_FOUND, INVALID_STATE).
fn set_capture_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    if args.get(1).number_value(scope) != Some(MOUSE_POINTER_ID) {
        return rv.set_uint32(NOT_FOUND);
    }
    let Some(id) = crate::node_handle::nid_of(scope, args.get(0)) else { return rv.set_uint32(INVALID_STATE) };
    let d = crate::dom::dom(scope);
    if !d.arena.is_connected(id) {
        return rv.set_uint32(INVALID_STATE);
    }
    // (…none where no button is held, nor of an element of a document the pointer's gesture is not in: §10.2 "the
    // element's node document is not the active document of the pointer")
    if d.mouse.buttons != 0 && d.arena.get(id).is_some_and(|n| n.realm == d.mouse.cid) {
        d.mouse.pending_capture = Some(id);
    }
    rv.set_uint32(0);
}
// __dom.releasePointerCapture(element, pointerId) -> 0, or NOT_FOUND.
fn release_capture_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    if args.get(1).number_value(scope) != Some(MOUSE_POINTER_ID) {
        return rv.set_uint32(NOT_FOUND);
    }
    let id = crate::node_handle::nid_of(scope, args.get(0));
    let mouse = &mut crate::dom::dom(scope).mouse;
    if id.is_some() && mouse.pending_capture == id {
        mouse.pending_capture = None;
    }
    rv.set_uint32(0);
}
// __dom.hasPointerCapture(element, pointerId) -> whether the element is the pointer's pending capture target.
fn has_capture_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = crate::node_handle::nid_of(scope, args.get(0));
    let mine = args.get(1).number_value(scope) == Some(MOUSE_POINTER_ID);
    rv.set_bool(mine && id.is_some() && crate::dom::dom(scope).mouse.pending_capture == id);
}

// __dom.pointerOrientation(tiltX, tiltY, altitudeAngle, azimuthAngle) -> Float64Array [tiltX, tiltY, altitudeAngle,
// azimuthAngle] (`orientation`; undefined for a member not given).
fn orientation_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let mut given = [None; 4];
    for (i, g) in given.iter_mut().enumerate() {
        let v = args.get(i as i32);
        if !v.is_undefined() {
            *g = v.number_value(scope);
        }
    }
    let answer = orientation(given[0], given[1], given[2], given[3]);
    rv.set(crate::dom::f64_array(scope, &answer).into());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_either_way() {
        assert_eq!(orientation(None, None, None, None), [0.0, 0.0, FRAC_PI_2, 0.0]);
        assert_eq!(orientation(Some(0.0), Some(90.0), None, None), [0.0, 90.0, 0.0, FRAC_PI_2]);
        let [_, _, altitude, azimuth] = orientation(Some(45.0), Some(45.0), None, None);
        assert!((azimuth - PI / 4.0).abs() < 1e-12 && (altitude - (1.0 / 2f64.sqrt()).atan()).abs() < 1e-12);
        assert_eq!(orientation(None, None, Some(0.0), Some(PI)), [-90.0, 0.0, 0.0, PI]);
        assert_eq!(orientation(None, None, Some(FRAC_PI_2 / 2.0), Some(0.0))[..2], [45.0, 0.0]);
    }
}
