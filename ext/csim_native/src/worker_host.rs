// The host side of a window's workers — what the Browser that runs them on its threads (a window's dedicated and shared
// workers, the session's service workers on the session's host: browser.rb `sw_host`) owes and is owed across those
// threads, which its event loop reads to know whether to wait:
//
// - what is OWED it (`Owed`), each a count the worker threads and the host's thread move at once, with no lock — the
//   replies a worker sends under `ensure` (a BroadcastChannel post's `bcack`, a client's message's `swack`, a controlled
//   fetch's response or its stream's last frame), the plain messages posted to one that it may answer, and the workers
//   still running their first script or a message's handler;
// - the streamed responses still open, by the worker that streams each — so a worker that dies mid-body errors its
//   client's stream and lets go of what each held;
// - a race-network-and-fetch-handler route's network leg, fetched before the fetch event is dispatched, which wins where
//   the server's modeled delay is shorter than the handler's dispatch took (Service Workers "race-network-and-fetch-
//   handler": the first to answer);
// - the replies a thread waits for in place, off the event loop — a controlled worker's main script's fetch, a
//   navigation's (`await_reply`), which the worker's thread hands over as it answers;
// - how long the event loop holds its clock for a reply in flight, a budget per kind spent once across its steps;
// - the client ids this window's realms adopted — each a navigation's reserved client's (Service Workers: the reserved
//   client becomes the document's), its realm by it and it by its realm.
//
// One per Browser, which owns it; a session of one window with no worker pays one atomic load per check.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

// What is owed the host, by kind — `owe` / `release` take one of these.
const BROADCAST: usize = 0;
const MESSAGE: usize = 1;
const FETCH: usize = 2;
const POSTED: usize = 3;
const BOOTING: usize = 4;
const BUSY: usize = 5;
const OWED_KINDS: usize = 6;
// The waits a step of the event loop holds its clock for, by kind (`wait_left`).
const WAIT_FETCH: usize = 0;
const WAIT_MESSAGE: usize = 1;
const WAIT_SOCKET_CLOSE: usize = 2;
const WAIT_KINDS: usize = 3;
// The first id of the replies a thread waits for in place that are not a navigation's: far above any realm's own fetch
// ids, so one can never be taken for a page's fetch on the same worker. A navigation's are negative.
const DIRECT_BASE: i64 = 1_000_000_000;
// What a handler that did not answer — no `respondWith` — sends in place of a response.
const FALLTHROUGH: &str = r#"{"fallthrough":true}"#;

#[magnus::wrap(class = "Capybara::Simulated::Native::WorkerHost", free_immediately)]
pub(crate) struct WorkerHost {
    owed: [AtomicUsize; OWED_KINDS],
    state: Mutex<State>,
    answered: Condvar,
}

#[derive(Default)]
struct State {
    // worker handle → the `[realm, fetch id]` of each response it streams that is still open
    streams: HashMap<i64, HashSet<(i64, i64)>>,
    // `[realm, fetch id]` → its network leg
    raced: HashMap<(i64, i64), Leg>,
    // fetch id → the reply a thread waits for, none until it is handed over
    replies: HashMap<i64, Option<String>>,
    direct_seq: i64,
    navigation_seq: i64,
    waits: [Option<Instant>; WAIT_KINDS],
    // realm → the client id it adopted, and back
    clients: HashMap<i64, String>,
    realms: HashMap<String, i64>,
}

struct Leg {
    response: String,
    server_ms: f64,
    started: Instant,
}

// The reserved client ids a navigation mints are the process's, unique however many sessions and windows mint them.
static RESERVED_CLIENTS: AtomicU64 = AtomicU64::new(0);

impl WorkerHost {
    fn new() -> Self {
        WorkerHost { owed: Default::default(), state: Mutex::new(State { direct_seq: DIRECT_BASE, ..State::default() }), answered: Condvar::new() }
    }
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    // ── What is owed ──
    // #owe(kind, n) — `n` more of `kind` owed.
    fn owe(&self, kind: usize, n: usize) {
        if let Some(count) = self.owed.get(kind) {
            count.fetch_add(n, Ordering::AcqRel);
        }
    }
    // #release(kind, n) — `n` of `kind` answered: never below none, a reply that answers nothing counted (an `__error`
    // postback) letting go of nothing.
    fn release(&self, kind: usize, n: usize) {
        if let Some(count) = self.owed.get(kind) {
            let _ = count.try_update(Ordering::AcqRel, Ordering::Acquire, |c| Some(c.saturating_sub(n)));
        }
    }
    fn owed_of(&self, kind: usize) -> usize {
        self.owed.get(kind).map_or(0, |c| c.load(Ordering::Acquire))
    }
    // #owed?(kinds) — whether any of `kinds` (a bit per kind) is owed.
    fn is_owed(&self, kinds: u32) -> bool {
        (0..OWED_KINDS).any(|k| kinds & (1 << k) != 0 && self.owed[k].load(Ordering::Acquire) > 0)
    }
    // #clear — no reply nor answer owed, no stream open, no hold for one: the host's last worker gone, what was owed by
    // it gone with it. (Not the workers still booting or busy, which their own threads let go of as they end.)
    fn clear(&self) {
        for kind in [BROADCAST, MESSAGE, FETCH, POSTED] {
            self.owed[kind].store(0, Ordering::Release);
        }
        let mut state = self.lock();
        state.streams.clear();
        state.waits[WAIT_FETCH] = None;
        state.waits[WAIT_MESSAGE] = None;
    }
    // #reset — and no hold, no race leg, no reply awaited, no client adopted either: the session's reset. (Still not the
    // workers booting or busy: a thread the reset gave up joining lets go of its own as it ends, which a count zeroed
    // here would take off the next session's worker.)
    fn reset(&self) {
        self.clear();
        let mut state = self.lock();
        state.waits = Default::default();
        state.raced.clear();
        state.replies.clear();
        state.clients.clear();
        state.realms.clear();
        self.answered.notify_all();
    }

    // ── Streamed responses ──
    // #stream_opened(handle, realm, fetch_id) — worker `handle` began streaming the response to that fetch.
    fn stream_opened(&self, handle: i64, realm: i64, fetch_id: i64) {
        self.lock().streams.entry(handle).or_default().insert((realm, fetch_id));
    }
    // #stream_closed(handle, realm, fetch_id) — …and sent its last frame.
    fn stream_closed(&self, handle: i64, realm: i64, fetch_id: i64) {
        if let Some(open) = self.lock().streams.get_mut(&handle) {
            open.remove(&(realm, fetch_id));
        }
    }
    // #stream_worker(realm, fetch_id) -> the worker streaming the response to that fetch, nil for none.
    fn stream_worker(&self, realm: i64, fetch_id: i64) -> Option<i64> {
        self.lock().streams.iter().find(|(_, open)| open.contains(&(realm, fetch_id))).map(|(handle, _)| *handle)
    }
    // #streams_gone(handle) -> the `[realm, fetch id]` of each response worker `handle` was streaming, which it never
    // ends now — the fetch each held answered.
    fn streams_gone(&self, handle: i64) -> Vec<(i64, i64)> {
        let open: Vec<(i64, i64)> = self.lock().streams.remove(&handle).map(|open| open.into_iter().collect()).unwrap_or_default();
        self.release(FETCH, open.len());
        open
    }

    // ── Race legs ──
    // #race_leg(realm, fetch_id, response, server_ms) — the network leg of that fetch, fetched as its event is
    // dispatched: its response (the respondWith wire) and the delay the server modeled.
    fn race_leg(&self, realm: i64, fetch_id: i64, response: String, server_ms: f64) {
        self.lock().raced.insert((realm, fetch_id), Leg { response, server_ms, started: Instant::now() });
    }
    // #race_winner(realm, fetch_id, handler_response) -> the network leg's response where it wins over the handler's —
    // the handler fell through, or the server's modeled delay is shorter than the handler's dispatch took — nil where
    // the handler's stands or no leg ran. The leg is let go of either way: the race is decided once.
    fn race_winner(&self, realm: i64, fetch_id: i64, handler_response: Option<String>) -> Option<String> {
        let leg = self.lock().raced.remove(&(realm, fetch_id))?;
        let handler_ms = leg.started.elapsed().as_secs_f64() * 1000.0;
        (handler_response.as_deref() == Some(FALLTHROUGH) || leg.server_ms < handler_ms).then_some(leg.response)
    }
    // #races_clear — every leg let go of: a realm's fetch ids begin again with a new document.
    fn races_clear(&self) {
        self.lock().raced.clear();
    }

    // ── Replies awaited in place ──
    // #await_direct -> a fetch id a thread waits for the reply to in place (`await_reply`), not a navigation's.
    fn await_direct(&self) -> i64 {
        let mut state = self.lock();
        state.direct_seq += 1;
        let id = state.direct_seq;
        state.replies.insert(id, None);
        id
    }
    // #await_navigation -> …a navigation's.
    fn await_navigation(&self) -> i64 {
        let mut state = self.lock();
        state.navigation_seq -= 1;
        let id = state.navigation_seq;
        state.replies.insert(id, None);
        id
    }
    // WorkerHost.direct?(fetch_id) -> whether `fetch_id` is one a thread waits for in place that is not a navigation's
    // (`await_direct`), whose reply never rides the event loop's delivery — nor is it raced.
    fn is_direct(fetch_id: i64) -> bool {
        fetch_id > DIRECT_BASE
    }
    // #answer(fetch_id, reply) -> whether a thread waits for that reply, now handed over to it.
    fn answer(&self, fetch_id: i64, reply: String) -> bool {
        let mut state = self.lock();
        match state.replies.get_mut(&fetch_id) {
            Some(slot) => {
                *slot = Some(reply);
                drop(state);
                self.answered.notify_all();
                true
            }
            None => false,
        }
    }
    // #await_reply(fetch_id, seconds) -> the reply to `fetch_id` once it is handed over, waiting at most `seconds` for it
    // with the GVL released (the worker's thread runs meanwhile) — nil where it is not in by then. The wait is let go of
    // as it is answered; a caller that gives up lets go of it (`forget_reply`).
    fn await_reply(&self, fetch_id: i64, seconds: f64) -> Option<String> {
        let deadline = Instant::now() + Duration::from_secs_f64(seconds.max(0.0));
        crate::image_decode::without_gvl(|| {
            let mut state = self.lock();
            loop {
                match state.replies.get_mut(&fetch_id) {
                    None => return None,
                    Some(slot @ Some(_)) => {
                        let reply = slot.take();
                        state.replies.remove(&fetch_id);
                        return reply;
                    }
                    Some(None) => {}
                }
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return None;
                }
                state = self.answered.wait_timeout(state, left).unwrap_or_else(PoisonError::into_inner).0;
            }
        })
    }
    // #awaiting?(fetch_id) -> whether a thread still waits for the reply to `fetch_id`, not handed over yet nor let go of
    // (a session's reset lets go of every one).
    fn is_awaiting(&self, fetch_id: i64) -> bool {
        self.lock().replies.contains_key(&fetch_id)
    }
    // #forget_reply(fetch_id) — no thread waits for it any more: a reply handed over after is dropped.
    fn forget_reply(&self, fetch_id: i64) {
        self.lock().replies.remove(&fetch_id);
    }

    // ── Clock holds ──
    // #wait_left(kind, budget) -> the seconds a hold of `kind` has left — its budget of `budget` seconds begun with the
    // first step that holds for it, and spent across the steps after (≤ 0 once spent).
    fn wait_left(&self, kind: usize, budget: f64) -> f64 {
        let mut state = self.lock();
        let Some(wait) = state.waits.get_mut(kind) else { return 0.0 };
        let deadline = *wait.get_or_insert_with(|| Instant::now() + Duration::from_secs_f64(budget.max(0.0)));
        let now = Instant::now();
        if deadline >= now { deadline.duration_since(now).as_secs_f64() } else { -now.duration_since(deadline).as_secs_f64() }
    }
    // #wait_reset(kind) — a reply of `kind` came in, or none is owed: the next one waits afresh.
    fn wait_reset(&self, kind: usize) {
        if let Some(wait) = self.lock().waits.get_mut(kind) {
            *wait = None;
        }
    }

    // ── Adopted client ids ──
    // #adopt_client(realm, client_id) — realm `realm`'s document adopted the reserved client `client_id`: its id that one,
    // the one it had before naming nothing.
    fn adopt_client(&self, realm: i64, client_id: String) {
        let mut state = self.lock();
        if let Some(old) = state.clients.insert(realm, client_id.clone()) {
            state.realms.remove(&old);
        }
        state.realms.insert(client_id, realm);
    }
    // #client_of(realm) -> the client id realm `realm` adopted, nil for none.
    fn client_of(&self, realm: i64) -> Option<String> {
        self.lock().clients.get(&realm).cloned()
    }
    // #realm_of(client_id) -> the realm that adopted `client_id`, nil for none.
    fn realm_of(&self, client_id: String) -> Option<i64> {
        self.lock().realms.get(&client_id).copied()
    }
    // #forget_client(realm) — realm `realm` is gone, the id it adopted with it.
    fn forget_client(&self, realm: i64) {
        let mut state = self.lock();
        if let Some(old) = state.clients.remove(&realm) {
            state.realms.remove(&old);
        }
    }
}

// Native.reserved_client_seq -> the next number of a navigation's reserved client, the process's.
fn reserved_client_seq() -> u64 {
    RESERVED_CLIENTS.fetch_add(1, Ordering::Relaxed) + 1
}

pub(crate) fn define(native: magnus::RModule, ruby: &magnus::Ruby) -> Result<(), magnus::Error> {
    use magnus::{function, method, Module, Object};
    native.define_module_function("reserved_client_seq", function!(reserved_client_seq, 0))?;
    let class = native.define_class("WorkerHost", ruby.class_object())?;
    for (name, value) in [
        ("BROADCAST", BROADCAST),
        ("MESSAGE", MESSAGE),
        ("FETCH", FETCH),
        ("POSTED", POSTED),
        ("BOOTING", BOOTING),
        ("BUSY", BUSY),
        ("WAIT_FETCH", WAIT_FETCH),
        ("WAIT_MESSAGE", WAIT_MESSAGE),
        ("WAIT_SOCKET_CLOSE", WAIT_SOCKET_CLOSE),
    ] {
        class.const_set(name, value)?;
    }
    class.const_set("FALLTHROUGH", FALLTHROUGH)?;
    class.define_singleton_method("new", function!(WorkerHost::new, 0))?;
    class.define_singleton_method("direct?", function!(WorkerHost::is_direct, 1))?;
    class.define_method("owe", method!(WorkerHost::owe, 2))?;
    class.define_method("release", method!(WorkerHost::release, 2))?;
    class.define_method("owed", method!(WorkerHost::owed_of, 1))?;
    class.define_method("owed?", method!(WorkerHost::is_owed, 1))?;
    class.define_method("clear", method!(WorkerHost::clear, 0))?;
    class.define_method("reset", method!(WorkerHost::reset, 0))?;
    class.define_method("stream_opened", method!(WorkerHost::stream_opened, 3))?;
    class.define_method("stream_closed", method!(WorkerHost::stream_closed, 3))?;
    class.define_method("stream_worker", method!(WorkerHost::stream_worker, 2))?;
    class.define_method("streams_gone", method!(WorkerHost::streams_gone, 1))?;
    class.define_method("race_leg", method!(WorkerHost::race_leg, 4))?;
    class.define_method("race_winner", method!(WorkerHost::race_winner, 3))?;
    class.define_method("races_clear", method!(WorkerHost::races_clear, 0))?;
    class.define_method("await_direct", method!(WorkerHost::await_direct, 0))?;
    class.define_method("await_navigation", method!(WorkerHost::await_navigation, 0))?;
    class.define_method("answer", method!(WorkerHost::answer, 2))?;
    class.define_method("await_reply", method!(WorkerHost::await_reply, 2))?;
    class.define_method("awaiting?", method!(WorkerHost::is_awaiting, 1))?;
    class.define_method("forget_reply", method!(WorkerHost::forget_reply, 1))?;
    class.define_method("wait_left", method!(WorkerHost::wait_left, 2))?;
    class.define_method("wait_reset", method!(WorkerHost::wait_reset, 1))?;
    class.define_method("adopt_client", method!(WorkerHost::adopt_client, 2))?;
    class.define_method("client_of", method!(WorkerHost::client_of, 1))?;
    class.define_method("realm_of", method!(WorkerHost::realm_of, 1))?;
    class.define_method("forget_client", method!(WorkerHost::forget_client, 1))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_release_never_goes_below_none() {
        let host = WorkerHost::new();
        host.owe(FETCH, 2);
        host.release(FETCH, 3);
        assert_eq!(host.owed_of(FETCH), 0);
        host.owe(MESSAGE, 1);
        assert!(host.is_owed(1 << MESSAGE));
        assert!(!host.is_owed(1 << FETCH | 1 << BROADCAST));
    }

    #[test]
    fn a_worker_gone_lets_go_of_the_streams_it_held() {
        let host = WorkerHost::new();
        host.owe(FETCH, 2);
        host.stream_opened(7, 0, 1);
        host.stream_opened(7, 3, 1);
        host.stream_closed(7, 3, 1);
        assert_eq!(host.stream_worker(0, 1), Some(7));
        assert_eq!(host.streams_gone(7), vec![(0, 1)]);
        assert_eq!(host.owed_of(FETCH), 1);
        assert_eq!(host.stream_worker(0, 1), None);
    }

    #[test]
    fn a_race_is_decided_once() {
        let host = WorkerHost::new();
        host.race_leg(0, 1, "net".into(), 0.0);
        std::thread::sleep(Duration::from_millis(2));
        assert_eq!(host.race_winner(0, 1, Some("handler".into())).as_deref(), Some("net"));
        assert_eq!(host.race_winner(0, 1, Some("handler".into())), None);
        // (…a slower server loses to the handler, but not to one that fell through)
        host.race_leg(0, 2, "net".into(), 60_000.0);
        assert_eq!(host.race_winner(0, 2, Some("handler".into())), None);
        host.race_leg(0, 3, "net".into(), 60_000.0);
        assert_eq!(host.race_winner(0, 3, Some(FALLTHROUGH.into())).as_deref(), Some("net"));
    }

    #[test]
    fn a_reply_reaches_only_the_thread_awaiting_it() {
        let host = WorkerHost::new();
        let id = host.await_navigation();
        assert!(id < 0 && !WorkerHost::is_direct(id));
        let direct = host.await_direct();
        assert!(WorkerHost::is_direct(direct));
        assert!(!WorkerHost::is_direct(5));
        assert!(host.answer(id, "r".into()));
        assert!(!host.answer(12, "r".into()));
        host.forget_reply(direct);
        assert!(!host.answer(direct, "late".into()));
    }

    #[test]
    fn a_hold_spends_its_budget_once() {
        let host = WorkerHost::new();
        assert!(host.wait_left(WAIT_FETCH, 0.0) <= 0.0);
        assert!(host.wait_left(WAIT_FETCH, 10.0) <= 0.0);
        host.wait_reset(WAIT_FETCH);
        assert!(host.wait_left(WAIT_FETCH, 10.0) > 9.0);
        assert!(host.wait_left(WAIT_MESSAGE, 10.0) > 9.0);
    }

    #[test]
    fn an_adopted_client_names_its_realm_alone() {
        let host = WorkerHost::new();
        host.adopt_client(4, "client-nav1".into());
        host.adopt_client(4, "client-nav2".into());
        assert_eq!(host.realm_of("client-nav1".into()), None);
        assert_eq!(host.realm_of("client-nav2".into()), Some(4));
        host.forget_client(4);
        assert_eq!(host.client_of(4), None);
    }
}
