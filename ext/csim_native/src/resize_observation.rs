// Resize Observer's sizes (§3.4): an observation's size of its box — the border box, the content box, or the device
// pixel content box (the content box at `device_pixel_ratio`, rounded) — `[inline, block]` in the target's writing
// mode, 0 by 0 where it has no box it measures (`geometry::observed_sizes`); and the target's DEPTH, the elements on its
// flat-tree path to the root, by which "gather active observations at depth" keeps a loop of resizes from running on.
// Whether a size moved since the last one reported, and the entries, the bindings keep.

use crate::dom::{nid_arg, NodeId, NodeKind, RealmArena};

// The observed boxes, as the bindings number them.
const CONTENT_BOX: i32 = 0;
const BORDER_BOX: i32 = 1;

impl RealmArena {
    pub(crate) fn observation_size(&self, id: NodeId, box_kind: i32, device_pixel_ratio: f64) -> [f64; 2] {
        let Some([w, h, cw, ch, _, _, vertical]) = crate::geometry::observed_sizes(self, id) else { return [0.0; 2] };
        let [x, y] = match box_kind {
            BORDER_BOX => [w, h],
            CONTENT_BOX => [cw, ch],
            _ => [(cw * device_pixel_ratio).round(), (ch * device_pixel_ratio).round()],
        };
        if vertical != 0.0 { [y, x] } else { [x, y] }
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

// __dom.resizeObservations(devicePixelRatio, nid, box, nid, box, …) -> Float64Array `[inline, block, depth]` an
// observation (`observation_size`, `flat_depth`); `box` 0 content, 1 border, 2 device-pixel content.
fn resize_observations_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let ratio = args.get(0).number_value(scope).filter(|r| r.is_finite() && *r > 0.0).unwrap_or(1.0);
    let pairs: Vec<(Option<NodeId>, i32)> =
        (0..(args.length() - 1) / 2).map(|i| (nid_arg(scope, &args, 1 + i * 2), args.get(2 + i * 2).int32_value(scope).unwrap_or(0))).collect();
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let mut out = Vec::with_capacity(pairs.len() * 3);
    for (id, box_kind) in pairs {
        let (size, depth) = id.map_or(([0.0; 2], 0), |id| (arena.observation_size(id, box_kind, ratio), arena.flat_depth(id)));
        out.extend([size[0], size[1], f64::from(depth)]);
    }
    rv.set(crate::dom::f64_array(scope, &out).into());
}
