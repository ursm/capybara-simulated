// ImageBitmaps (HTML §8.10.1): every bitmap of the isolate — its realm, its RGBA pixels (row-major; a wide-profile
// source's Display P3 rendering beside them), its size, its colour space, whether a cross-origin source tainted it, and
// whether it is closed ([[Detached]]: an unusable image source, of no size and no pixels). The isolate's (its `Dom`),
// numbered as they are made; the bindings (canvas.js) name each by its number, and tell the engine once its object is
// collected (`imageBitmapForget`) — and a realm's go with its context, which no collection reports.
//
// Its pixels are a span of a backing store the engine holds (`image_requests::Pixels`): what createImageBitmap made,
// a clone's copy — handed to a draw as a view on it, never copied for one.

use std::collections::HashMap;

use crate::dom::{dom, realm_id, register};
use crate::image_requests::Pixels;

struct Bitmap {
    realm: i32,
    srgb: Option<Pixels>,
    p3: Option<Pixels>,
    size: [u32; 2],
    display_p3: bool,
    tainted: bool,
    closed: bool,
}

impl Bitmap {
    // What its pixels weigh as V8 is told (`RealmArena::external`).
    fn weight(&self) -> i64 {
        [&self.srgb, &self.p3].into_iter().flatten().map(|p| p.len as i64).sum()
    }
}

#[derive(Default)]
pub(crate) struct ImageBitmaps {
    next: u32,
    of: HashMap<u32, Bitmap>,
}

impl ImageBitmaps {
    // A realm's bitmaps, gone with its context: their objects with it, which no collection reports. -> what they weighed.
    fn drop_realm(&mut self, cid: i32) -> i64 {
        let mut weight = 0;
        self.of.retain(|_, b| {
            let keep = b.realm != cid;
            if !keep {
                weight += b.weight();
            }
            keep
        });
        weight
    }
}

impl crate::dom::Dom {
    // (…`forget_realm_objects`'s, and what they weighed no longer told V8)
    pub(crate) fn forget_image_bitmaps(&mut self, cid: i32) {
        let weight = self.image_bitmaps.drop_realm(cid);
        self.arena.external -= weight;
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "imageBitmapNew", new_op, context_id);
    register(scope, ns, "imageBitmapState", state_op, context_id);
    register(scope, ns, "imageBitmapClose", close_op, context_id);
    register(scope, ns, "imageBitmapForget", forget_op, context_id);
}

fn view<'s>(scope: &mut v8::PinScope<'s, '_>, pixels: Option<Pixels>) -> v8::Local<'s, v8::Value> {
    match pixels {
        Some(p) => p.view(scope),
        None => v8::null(scope).into(),
    }
}

fn id_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> u32 {
    args.get(0).uint32_value(scope).unwrap_or(0)
}

// __dom.imageBitmapNew(pixels | null, width, height, pixelsP3 | null, displayP3, tainted) -> the number of a new bitmap
// of the calling realm's: those pixels (Uint8ClampedArrays, which it holds from now on), that size and colour space,
// tainted or not.
fn new_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = realm_id(scope, &args);
    let srgb = Pixels::of(scope, args.get(0));
    let size = [1, 2].map(|i| args.get(i).uint32_value(scope).unwrap_or(0));
    let p3 = Pixels::of(scope, args.get(3));
    let (display_p3, tainted) = (args.get(4).is_true(), args.get(5).is_true());
    let bitmap = Bitmap { realm, srgb, p3, size, display_p3, tainted, closed: false };
    let d = dom(scope);
    d.arena.external += bitmap.weight();
    d.image_bitmaps.next += 1;
    let id = d.image_bitmaps.next;
    d.image_bitmaps.of.insert(id, bitmap);
    rv.set_uint32(id);
}

// __dom.imageBitmapState(id) -> [pixels | null, width, height, pixelsP3 | null, displayP3, tainted, closed] — its pixels
// as views — or null for one forgotten.
fn state_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, &args);
    let Some(b) = dom(scope).image_bitmaps.of.get(&id) else { return rv.set_null() };
    let (srgb, p3, size, display_p3, tainted, closed) = (b.srgb.clone(), b.p3.clone(), b.size, b.display_p3, b.tainted, b.closed);
    let items = [
        view(scope, srgb),
        v8::Integer::new_from_unsigned(scope, size[0]).into(),
        v8::Integer::new_from_unsigned(scope, size[1]).into(),
        view(scope, p3),
        v8::Boolean::new(scope, display_p3).into(),
        v8::Boolean::new(scope, tainted).into(),
        v8::Boolean::new(scope, closed).into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.imageBitmapClose(id) — the bitmap closed: its pixels let go of, its size none (`close()`, a transfer).
fn close_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, &args);
    let d = dom(scope);
    let Some(b) = d.image_bitmaps.of.get_mut(&id) else { return };
    d.arena.external -= b.weight();
    *b = Bitmap { srgb: None, p3: None, size: [0, 0], closed: true, ..*b };
}

// __dom.imageBitmapForget(id) — the bitmap's object collected: the bitmap let go of.
fn forget_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, &args);
    let d = dom(scope);
    if let Some(b) = d.image_bitmaps.of.remove(&id) {
        d.arena.external -= b.weight();
    }
}
