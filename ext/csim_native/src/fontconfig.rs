// fontconfig, the library Chrome resolves a font family through on Linux, opened at load (`require`): a pattern matched
// as fc-match matches it — parsed, substituted by this machine's rules and the defaults, matched against its fonts —
// and the families a pattern expands to that are STRONGLY bound (what `fc-pattern -c` marks `(s)`), which is how
// Skia tells a family fontconfig substituted (Arial → Liberation Sans) from one it ignored for its fallback.

use std::ffi::{CStr, CString, c_char, c_int, c_uint, c_void};
use std::sync::OnceLock;

type Pattern = c_void;

// An FcValue: its type, and the union (a pointer wide) holding it.
#[repr(C)]
struct Value {
    kind: c_uint,
    u: *const c_void,
}
const TYPE_STRING: c_uint = 3;
const RESULT_MATCH: c_int = 0;
const MATCH_PATTERN: c_int = 0;
const BINDING_STRONG: c_int = 1;

struct Fc {
    _lib: libloading::Library,
    name_parse: unsafe extern "C" fn(*const c_char) -> *mut Pattern,
    config_substitute: unsafe extern "C" fn(*mut c_void, *mut Pattern, c_int) -> c_int,
    default_substitute: unsafe extern "C" fn(*mut Pattern),
    font_match: unsafe extern "C" fn(*mut c_void, *mut Pattern, *mut c_int) -> *mut Pattern,
    get_string: unsafe extern "C" fn(*const Pattern, *const c_char, c_int, *mut *const c_char) -> c_int,
    // (…fontconfig 2.13.1 and later; without it no family counts as substituted)
    get_with_binding: Option<unsafe extern "C" fn(*const Pattern, *const c_char, c_int, *mut Value, *mut c_int) -> c_int>,
    destroy: unsafe extern "C" fn(*mut Pattern),
}
// SAFETY: fontconfig's matching entry points are thread-safe (its configuration is reference-counted and locked, since
// 2.10); the struct holds only the library and function pointers into it.
unsafe impl Send for Fc {}
unsafe impl Sync for Fc {}

impl Fc {
    fn open() -> Result<Fc, String> {
        let name = if cfg!(target_vendor = "apple") { "libfontconfig.1.dylib" } else { "libfontconfig.so.1" };
        // SAFETY: loading fontconfig runs its constructors, which do nothing but set up the library.
        let lib = unsafe { libloading::Library::new(name) }.map_err(|e| format!("{name}: {e}"))?;
        // SAFETY: each symbol is fontconfig's, with the signature fontconfig.h gives it.
        unsafe {
            macro_rules! sym {
                ($name:literal) => {
                    *lib.get(concat!($name, "\0").as_bytes()).map_err(|e| format!("{}: {e}", $name))?
                };
            }
            let init: unsafe extern "C" fn() -> c_int = sym!("FcInit");
            if init() == 0 {
                return Err("FcInit failed: fontconfig could not load its configuration".into());
            }
            Ok(Fc {
                name_parse: sym!("FcNameParse"),
                config_substitute: sym!("FcConfigSubstitute"),
                default_substitute: sym!("FcDefaultSubstitute"),
                font_match: sym!("FcFontMatch"),
                get_string: sym!("FcPatternGetString"),
                get_with_binding: lib.get(b"FcPatternGetWithBinding\0").ok().map(|s| *s),
                destroy: sym!("FcPatternDestroy"),
                _lib: lib,
            })
        }
    }
}

fn fc() -> Result<&'static Fc, &'static String> {
    static FC: OnceLock<Result<Fc, String>> = OnceLock::new();
    FC.get_or_init(Fc::open).as_ref()
}

// Open fontconfig now, or say why it cannot be — the error `require` raises.
pub(crate) fn require() -> Result<(), String> {
    fc().map(|_| ()).map_err(|e| format!("capybara-simulated needs the fontconfig library ({e}); install fontconfig"))
}

// A parsed pattern, destroyed when dropped.
struct Owned(*mut Pattern);
impl Drop for Owned {
    fn drop(&mut self) {
        if let Ok(fc) = fc() {
            // SAFETY: a pattern fontconfig handed over, destroyed once.
            unsafe { (fc.destroy)(self.0) };
        }
    }
}

// `pattern` (fontconfig's syntax: `Arial:weight=200`) parsed and substituted by this machine's rules.
fn substituted(fc: &Fc, pattern: &str) -> Option<Owned> {
    let c = CString::new(pattern).ok()?;
    // SAFETY: a NUL-terminated pattern; the result is owned by the caller.
    let p = unsafe { (fc.name_parse)(c.as_ptr()) };
    if p.is_null() {
        return None;
    }
    // SAFETY: the current configuration (null) on a pattern we own.
    unsafe { (fc.config_substitute)(std::ptr::null_mut(), p, MATCH_PATTERN) };
    Some(Owned(p))
}
// The strings an object of `p` holds, in order.
fn strings(fc: &Fc, p: *const Pattern, object: &CStr) -> Vec<String> {
    let mut out = Vec::new();
    for id in 0.. {
        let mut s: *const c_char = std::ptr::null();
        // SAFETY: `p` is a live pattern; a string it returns lives as long as it does, and is copied out here.
        if unsafe { (fc.get_string)(p, object.as_ptr(), id, &mut s) } != RESULT_MATCH || s.is_null() {
            break;
        }
        out.push(unsafe { CStr::from_ptr(s) }.to_string_lossy().into_owned());
    }
    out
}

// The font `pattern` matches, as fc-match answers it: its file, and its family names (a face may declare several).
pub(crate) fn font_match(pattern: &str) -> Option<(String, Vec<String>)> {
    let fc = fc().ok()?;
    let p = substituted(fc, pattern)?;
    let mut result = 0;
    // SAFETY: a pattern we own, defaults added, then matched against the current configuration's fonts.
    let matched = unsafe {
        (fc.default_substitute)(p.0);
        Owned((fc.font_match)(std::ptr::null_mut(), p.0, &mut result))
    };
    if matched.0.is_null() || result != RESULT_MATCH {
        return None;
    }
    let file = strings(fc, matched.0, c"file").into_iter().next()?;
    Some((file, strings(fc, matched.0, c"family")))
}

// The families `pattern` expands to under this machine's rules that are strongly bound.
pub(crate) fn strong_families(pattern: &str) -> Vec<String> {
    let Ok(fc) = fc() else { return Vec::new() };
    let (Some(get), Some(p)) = (fc.get_with_binding, substituted(fc, pattern)) else { return Vec::new() };
    let mut out = Vec::new();
    for id in 0.. {
        let mut v = Value { kind: 0, u: std::ptr::null() };
        let mut binding = 0;
        // SAFETY: a live pattern; a string value lives as long as it does, and is copied out here.
        if unsafe { get(p.0, c"family".as_ptr(), id, &mut v, &mut binding) } != RESULT_MATCH {
            break;
        }
        if v.kind == TYPE_STRING && binding == BINDING_STRONG && !v.u.is_null() {
            out.push(unsafe { CStr::from_ptr(v.u.cast()) }.to_string_lossy().into_owned());
        }
    }
    out
}

// Capybara::Simulated::Native.font_match(pattern) -> `[file, families]`, or nil where fontconfig matches nothing.
pub(crate) fn font_match_for_ruby(pattern: String) -> Option<(String, Vec<String>)> {
    font_match(&pattern)
}
// Capybara::Simulated::Native.font_strong_families(pattern) -> the strongly bound families it expands to.
pub(crate) fn strong_families_for_ruby(pattern: String) -> Vec<String> {
    strong_families(&pattern)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_as_fc_match_does() {
        let (file, families) = font_match("sans-serif").expect("a sans-serif face");
        assert!(std::path::Path::new(&file).exists() && !families.is_empty());
        // (…a family fontconfig has no rule for is not strongly bound to anything but itself)
        assert_eq!(strong_families("No Such Family Anywhere"), vec!["No Such Family Anywhere".to_owned()]);
    }
}
