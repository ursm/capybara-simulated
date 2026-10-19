// A realm's window viewport (CSSOM View §2: what `innerWidth` / `innerHeight` answer, what its `@media` and its
// `matchMedia` lists evaluate against, and what its document lays out against): the driver's for a top-level window —
// the display it starts filling, `resize_to` moving it — and a frame's its container's content box, which the parent
// realm measured and handed it (none for an unrendered container: an empty window). And HTML's "run the resize steps":
// whether the window is not the size it was at the last ones, a resize before any of them included.

use crate::dom::{realm_id, register};

// The display (`screen.width` / `screen.height`): what a top-level window starts out filling, and what `maximize` /
// `fullscreen` restore it to (the Ruby side's `Browser::SCREEN_SIZE`, `Native.screen_size`).
pub(crate) const SCREEN: [f64; 2] = [1024.0, 768.0];
// …for the host: `[width, height]`.
pub(crate) fn screen_size_for_ruby() -> Vec<i64> {
    SCREEN.map(|v| v as i64).to_vec()
}

// A realm's: its window viewport (None: the display's), the content box its container last handed it — None where
// none has (a top-level window), Some(None) for an unrendered container — and the size its last resize steps saw.
#[derive(Default)]
pub(crate) struct Viewport {
    window: Option<[f64; 2]>,
    given: Option<Option<[f64; 2]>>,
    resized_at: Option<[f64; 2]>,
}

impl Viewport {
    pub(crate) fn size(&self) -> [f64; 2] {
        self.window.unwrap_or(SCREEN)
    }
    // (…the size before a first change, where no resize steps took one: a resize before any rendering update is a resize
    // all the same)
    fn hold_baseline(&mut self) {
        if self.resized_at.is_none() {
            self.resized_at = Some(self.size());
        }
    }
    // The driver moved a top-level window — or, `loading`, gave the size its document is loaded into, which is no resize
    // of it: its resize steps take their first size from there.
    fn set(&mut self, size: [f64; 2], loading: bool) {
        if !loading {
            self.hold_baseline();
        }
        self.window = Some(size);
    }
    // A frame's container handed it a content box, or none — the first the size its document loads at, a change of
    // nothing.
    fn give(&mut self, size: Option<[f64; 2]>) {
        if self.given.is_some() {
            self.hold_baseline();
        }
        self.given = Some(size);
        self.window = Some(size.unwrap_or([0.0, 0.0]));
    }
    // Whether the container's content box `size` is not what it last handed the frame.
    fn moved(&self, size: Option<[f64; 2]>) -> bool {
        self.given != Some(size)
    }
    // The resize steps: whether the window is not the size it was at the last ones — taking its size as theirs.
    fn resize_steps(&mut self) -> bool {
        let size = self.size();
        self.resized_at.replace(size).is_some_and(|was| was != size)
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "viewport", viewport_op, context_id);
    register(scope, ns, "screenSize", screen_size_op, context_id);
    register(scope, ns, "viewportSet", set_op, context_id);
    register(scope, ns, "frameViewportGive", give_op, context_id);
    register(scope, ns, "frameViewportMoved", moved_op, context_id);
    register(scope, ns, "resizeSteps", resize_steps_op, context_id);
}

// A realm's viewport, `cid`'s — none for one dropped, or a frame's whose navigable is gone (a removed frame's window,
// held on to: Chrome's 0). (A frame's a navigation replaced keeps its own: a page's held `contentWindow` is the Window
// here, not a WindowProxy following the navigable to its new document, whose size it would read.)
pub(crate) fn of(scope: &mut v8::PinScope<'_, '_>, cid: i32) -> [f64; 2] {
    let arena = &crate::dom::dom(scope).arena;
    if arena.is_dropped(cid) || arena.navigables.lost_navigable(cid) {
        return [0.0, 0.0];
    }
    crate::dom::realm(scope, cid).window_viewport.size()
}
// …and the one an op works in: its own realm's.
pub(crate) fn here(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> [f64; 2] {
    let cid = realm_id(scope, args);
    of(scope, cid)
}

fn size_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, at: i32) -> Option<[f64; 2]> {
    if args.get(at).is_null_or_undefined() {
        return None;
    }
    Some([at, at + 1].map(|i| args.get(i).number_value(scope).unwrap_or(0.0)))
}

// __dom.viewport(axis) -> the realm's viewport width (axis 0) or height (1).
fn viewport_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let axis = usize::from(args.get(0).uint32_value(scope) == Some(1));
    rv.set_double(here(scope, &args)[axis]);
}

// __dom.screenSize(axis) -> the display's width (axis 0) or height (1).
fn screen_size_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let axis = usize::from(args.get(0).uint32_value(scope) == Some(1));
    rv.set_double(SCREEN[axis]);
}

// __dom.viewportSet(width, height, loading): the driver moved the realm's (top-level) window, or loads its document at
// that size.
fn set_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some(size) = size_arg(scope, &args, 0) else { return };
    let loading = args.get(2).is_true();
    crate::dom::realm(scope, cid).window_viewport.set(size, loading);
}

// __dom.frameViewportGive(width, height) / (null): the realm's (a frame's) container handed it its content box, or
// none.
fn give_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let size = size_arg(scope, &args, 0);
    crate::dom::realm(scope, cid).window_viewport.give(size);
}

// __dom.frameViewportMoved(frameRealm, width, height) / (frameRealm, null) -> whether the frame realm's container's
// content box (or none) is not what it last handed it.
fn moved_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(frame) = args.get(0).int32_value(scope) else { return rv.set_bool(false) };
    let size = size_arg(scope, &args, 1);
    let moved = crate::dom::dom(scope).arena.realm_state(frame).is_some_and(|s| s.window_viewport.moved(size));
    rv.set_bool(moved);
}

// __dom.resizeSteps() -> whether the realm's window is not the size it was at its last resize steps (`resize_steps`).
fn resize_steps_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    rv.set_bool(crate::dom::realm(scope, cid).window_viewport.resize_steps());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_steps() {
        let mut v = Viewport::default();
        assert_eq!(v.size(), SCREEN);
        assert!(!v.resize_steps());
        v.set([800.0, 600.0], false);
        assert!(v.resize_steps());
        assert!(!v.resize_steps());
        // (…a resize before any steps is one all the same)
        let mut v = Viewport::default();
        v.set([800.0, 600.0], false);
        assert!(v.resize_steps());
        // (…and a document loaded at a size, none)
        let mut v = Viewport::default();
        v.set([800.0, 600.0], true);
        assert!(!v.resize_steps());
    }

    #[test]
    fn frames() {
        let mut v = Viewport::default();
        v.give(None);
        assert_eq!(v.size(), [0.0, 0.0]);
        assert!(!v.resize_steps());
        assert!(v.moved(Some([300.0, 150.0])));
        v.give(Some([300.0, 150.0]));
        assert!(!v.moved(Some([300.0, 150.0])));
        assert!(v.resize_steps());
    }
}
