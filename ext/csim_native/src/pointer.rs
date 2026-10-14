// A pointer's orientation (Pointer Events §4.1.3, "converting between tiltX / tiltY and altitudeAngle / azimuthAngle"):
// given either way — its tilts in degrees, or its altitude and azimuth in radians — the other pair converted from it,
// and, given neither, a pointer perpendicular to the surface (no tilt, an altitude of π/2, an azimuth of 0). A
// PointerEvent's constructor takes what its init gives (the bindings read the members).

use std::f64::consts::{FRAC_PI_2, PI};

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
    // (…rounded as ECMAScript's Math.round does: a half up, one from -0.5 to 0 to -0)
    let round = |v: f64| if (-0.5..0.0).contains(&v) { -0.0 } else { (v + 0.5).floor() };
    [round(x.to_degrees()), round(y.to_degrees()), altitude, azimuth]
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "pointerOrientation", orientation_op, context_id);
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
