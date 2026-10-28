// HTTP authentication for the host's fetches (Fetch "HTTP-network-or-cache fetch" over RFC 7617 Basic): each session's
// authentication entries — a credential an origin accepted, sent with a later request to it before it asks — and whether
// a 401 is answered once with the credentials a request brought (an XHR's `open()` user and password, a URL's
// userinfo). The host sends the requests; these say what they carry.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

// A session's authentication entries: the `Authorization` value each origin accepted.
#[derive(Default)]
struct Entries(HashMap<String, String>);

static REGISTRY: LazyLock<Mutex<(u64, HashMap<u64, Entries>)>> = LazyLock::new(Default::default);
fn lock() -> MutexGuard<'static, (u64, HashMap<u64, Entries>)> {
    REGISTRY.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

// The origin an entry is kept by: an HTTP(S) URL's, None for any other.
fn origin(url: &str) -> Option<String> {
    crate::referrer::http_origin(url)
}

// Fetch "HTTP-network-or-cache fetch" step 14: whether a 401 is answered by a request sent again with the credentials
// it brought (`challenge`) — where its response tainting is not "cors" (a CORS request to another origin prompts for
// none), it includes credentials (its credentials mode `include`, or `same-origin` with its chain at its own origin:
// `crossed` none), it sent no `Authorization` of its own, and the response asks for Basic.
pub(crate) fn answers_challenge(status: u32, challenge: bool, cors_mode: bool, crossed: bool, credentials: &str, sent_authorization: bool, www_authenticate: Option<&str>) -> bool {
    let include = credentials == "include" || (credentials == "same-origin" && !crossed);
    let basic = www_authenticate.is_some_and(|v| v.trim_start().get(..5).is_some_and(|s| s.eq_ignore_ascii_case("basic")));
    status == 401 && challenge && !(cors_mode && crossed) && include && !sent_authorization && basic
}

// — for the host —
pub(crate) fn new_for_ruby() -> u64 {
    let mut reg = lock();
    reg.0 += 1;
    let id = reg.0;
    reg.1.insert(id, Entries::default());
    id
}
// Every entry of the session's gone.
pub(crate) fn clear_for_ruby(id: u64) {
    if let Some(entries) = lock().1.get_mut(&id) {
        entries.0.clear();
    }
}
// The entry for `url`'s origin, sent before it asks: none where it has none.
pub(crate) fn entry_for_ruby(id: u64, url: String) -> Option<String> {
    let origin = origin(&url)?;
    lock().1.get(&id)?.0.get(&origin).cloned()
}
// `authorization`, which `url`'s origin accepted — the response to a request it answered not another 401 — kept for it.
pub(crate) fn accepted_for_ruby(id: u64, url: String, authorization: String) {
    let Some(origin) = origin(&url) else { return };
    if let Some(entries) = lock().1.get_mut(&id) {
        entries.0.insert(origin, authorization);
    }
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn answers_challenge_for_ruby(status: u32, challenge: bool, cors_mode: bool, crossed: bool, credentials: String, sent_authorization: bool, www_authenticate: Option<String>) -> bool {
    answers_challenge(status, challenge, cors_mode, crossed, &credentials, sent_authorization, www_authenticate.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_401_is_answered_once_with_the_credentials_brought() {
        let answers = |cors, crossed, credentials, sent, www| answers_challenge(401, true, cors, crossed, credentials, sent, www);
        assert!(answers(true, false, "same-origin", false, Some("Basic realm=\"x\"")));
        assert!(answers(false, false, "same-origin", false, Some(" basic")));
        // (…none for a CORS request off its origin, one including no credentials, one that sent its own, another scheme)
        assert!(!answers(true, true, "include", false, Some("Basic")));
        assert!(answers(false, true, "include", false, Some("Basic")));
        assert!(!answers(false, true, "same-origin", false, Some("Basic")));
        assert!(!answers(true, false, "omit", false, Some("Basic")));
        assert!(!answers(true, false, "same-origin", true, Some("Basic")));
        assert!(!answers(true, false, "same-origin", false, Some("Digest")));
        assert!(!answers(true, false, "same-origin", false, None));
        assert!(!answers_challenge(200, true, false, false, "same-origin", false, Some("Basic")));
        assert!(!answers_challenge(401, false, false, false, "same-origin", false, Some("Basic")));
    }

    #[test]
    fn an_entry_is_its_origins() {
        let id = new_for_ruby();
        accepted_for_ruby(id, "http://a.test/x".into(), "Basic a".into());
        assert_eq!(entry_for_ruby(id, "http://a.test/y?z".into()).as_deref(), Some("Basic a"));
        assert_eq!(entry_for_ruby(id, "http://a.test:81/".into()), None);
        assert_eq!(entry_for_ruby(id, "data:,x".into()), None);
        clear_for_ruby(id);
        assert_eq!(entry_for_ruby(id, "http://a.test/".into()), None);
    }
}
