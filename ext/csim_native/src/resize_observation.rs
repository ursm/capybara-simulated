// Resize Observer's sizes (§3.4): a target's border box, content box and device pixel content box (the content box at
// `device_pixel_ratio`, rounded), each `[inline, block]` in its writing mode, and its content rect at its padding edge
// in physical axes — all 0 where it has no box it measures (`geometry::observed_sizes`), or is not laid out (the
// bindings' `isLaidOutNode` says); an observation's size, of the box it observes; and the target's DEPTH, the elements
// on its flat-tree path to the root, by which "gather active observations at depth" keeps a loop of resizes from running
// on. One answer for both the gather and the entries it makes. Whether a size moved since the last one reported, and
// the entries, the bindings keep.

use crate::dom::{nid_arg, NodeId, NodeKind, RealmArena};

// The observed boxes, as the bindings number them.
const CONTENT_BOX: i32 = 0;
const BORDER_BOX: i32 = 1;

// A target's sizes: border, content and device-pixel content `[inline, block]`, then the content rect `[x, y, w, h]`.
pub(crate) type Sizes = [f64; 10];

impl RealmArena {
    pub(crate) fn observed_box_sizes(&self, id: NodeId, device_pixel_ratio: f64) -> Sizes {
        let Some([w, h, cw, ch, left, top, vertical]) = crate::geometry::observed_sizes(self, id) else { return [0.0; 10] };
        let logical = |[x, y]: [f64; 2]| if vertical != 0.0 { [y, x] } else { [x, y] };
        let [bi, bb] = logical([w, h]);
        let [ci, cb] = logical([cw, ch]);
        let [di, db] = logical([(cw * device_pixel_ratio).round(), (ch * device_pixel_ratio).round()]);
        [bi, bb, ci, cb, di, db, left, top, cw, ch]
    }

    // "Calculate depth for node": the elements on `id`'s flat-tree path, itself included.
    pub(crate) fn flat_depth(&self, id: NodeId) -> u32 {
        let mut depth = 0;
        let mut at = Some(id);
        while let Some(n) = at.filter(|&n| self.get(n).is_some_and(|d| d.kind == NodeKind::Element)) {
            depth += 1;
            at = crate::geometry::flat_parent(self, n);
        }
        depth
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "resizeObservations", resize_observations_op, context_id);
}

// __dom.resizeObservations(devicePixelRatio, nid, laidOut, …) -> Float64Array, eleven numbers a target: its sizes
// (`observed_box_sizes`, 0 where `laidOut` is false) and its depth (`flat_depth`).
fn resize_observations_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let ratio = args.get(0).number_value(scope).filter(|r| r.is_finite() && *r > 0.0).unwrap_or(1.0);
    let targets: Vec<(Option<NodeId>, bool)> = (0..(args.length() - 1) / 2).map(|i| (nid_arg(scope, &args, 1 + i * 2), args.get(2 + i * 2).is_true())).collect();
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let mut out = Vec::with_capacity(targets.len() * 11);
    for (id, laid_out) in targets {
        let sizes = id.filter(|_| laid_out).map_or([0.0; 10], |id| arena.observed_box_sizes(id, ratio));
        out.extend(sizes);
        out.push(f64::from(id.map_or(0, |id| arena.flat_depth(id))));
    }
    rv.set(crate::dom::f64_array(scope, &out).into());
}
