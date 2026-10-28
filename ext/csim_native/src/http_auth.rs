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
// it brought (`challenge`: the use-URL-credentials flag, its URL's credentials) — where its response tainting is not
// "cors" (`tainting_cors`: a CORS request to another origin prompts for none; Chrome measured so, Firefox answers it) and
// it includes credentials (`include_credentials`, the hop's, which its cookies go by too). And, the host's own: it sent
// no `Authorization` of its own, and the response asks for Basic, the one scheme answered. (The step's "traversable for
// user prompts" is not asked: a worker's XHR answers too, as Chrome's does, measured.)
pub(crate) fn answers_challenge(status: u32, challenge: bool, tainting_cors: bool, include_credentials: bool, sent_authorization: bool, www_authenticate: Option<&str>) -> bool {
    let basic = www_authenticate.is_some_and(|v| v.trim_start().get(..5).is_some_and(|s| s.eq_ignore_ascii_case("basic")));
    status == 401 && challenge && !tainting_cors && include_credentials && !sent_authorization && basic
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
// `authorization`, which `url`'s origin accepted, kept for it. (Fetch creates the entry whatever the answered request
// gets back; the host keeps only one the origin did not refuse with another 401, as no browser keeps credentials refused.)
pub(crate) fn accepted_for_ruby(id: u64, url: String, authorization: String) {
    let Some(origin) = origin(&url) else { return };
    if let Some(entries) = lock().1.get_mut(&id) {
        entries.0.insert(origin, authorization);
    }
}
pub(crate) fn answers_challenge_for_ruby(status: u32, challenge: bool, tainting_cors: bool, include_credentials: bool, sent_authorization: bool, www_authenticate: Option<String>) -> bool {
    answers_challenge(status, challenge, tainting_cors, include_credentials, sent_authorization, www_authenticate.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_401_is_answered_once_with_the_credentials_brought() {
        let answers = |tainting, include, sent, www| answers_challenge(401, true, tainting, include, sent, www);
        assert!(answers(false, true, false, Some("Basic realm=\"x\"")));
        assert!(answers(false, true, false, Some(" basic")));
        // (…none for a CORS request off its origin, one including no credentials, one that sent its own, another scheme)
        assert!(!answers(true, true, false, Some("Basic")));
        assert!(!answers(false, false, false, Some("Basic")));
        assert!(!answers(false, true, true, Some("Basic")));
        assert!(!answers(false, true, false, Some("Digest")));
        assert!(!answers(false, true, false, None));
        assert!(!answers_challenge(200, true, false, true, false, Some("Basic")));
        assert!(!answers_challenge(401, false, false, true, false, Some("Basic")));
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
