// MessagePort channels across isolates (HTML §9.4): a driver session's, every window's and worker's. A channel's two
// ends, `<channel>/0` and `<channel>/1` (a channel's id unique in the session: message-port.js, workers.js
// `__csimAllocPortChannel`), each held by a realm — or a worker, a worker's scope — of a window, whichever isolate holds
// the port at that end, which says so as it takes it (`here`) and as it gives it up to another (`gone`). A message
// posted at one end goes to the other's holder; one for an end no isolate holds yet waits for its next holder (HTML's
// port message queue) — the messages its last holder had received and not delivered first.
//
// What is kept here is where each message is to go; the host delivers it there (Browser#deliver_port_message), into a
// realm or a worker's inbox of the window whose holder it is.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

// Who holds an end: a realm (`"realm"`) or a worker (`"worker"`, by its handle) of window `window`.
pub(crate) type Holder = (String, u32, i64);

#[derive(Default)]
struct End {
    at: Option<Holder>,
    pending: Vec<String>,
    closed: bool,
}

static REGISTRY: LazyLock<Mutex<HashMap<(u64, String), End>>> = LazyLock::new(Default::default);

fn lock() -> MutexGuard<'static, HashMap<(u64, String), End>> {
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

fn other_end(end: &str) -> String {
    match end.rsplit_once('/') {
        Some((channel, "0")) => format!("{channel}/1"),
        Some((channel, _)) => format!("{channel}/0"),
        None => end.to_owned(),
    }
}

// A message reaching end `end`: its holder's to be delivered, or held for its next one — or nowhere, at a closed end.
fn receive(end: &mut End, data: String) -> Option<Holder> {
    if end.closed {
        return None;
    }
    match &end.at {
        Some(holder) => Some(holder.clone()),
        None => {
            end.pending.push(data);
            None
        }
    }
}

// An end taken by `holder`: the messages held for it, which it is now to be delivered (none at a closed end).
pub(crate) fn here(partition: u64, end: String, kind: String, window: u32, id: i64) -> Vec<String> {
    let mut reg = lock();
    let e = reg.entry((partition, end)).or_default();
    if e.closed {
        return Vec::new();
    }
    e.at = Some((kind, window, id));
    std::mem::take(&mut e.pending)
}

// …given up by `from`, with the messages it had received and not delivered (`held`): held for its next holder ahead of
// any held already — or, its next holder having taken it already, that one's to be delivered: `[holder, messages]`.
pub(crate) fn gone(partition: u64, end: String, held: Vec<String>, kind: String, window: u32, id: i64) -> Option<(Holder, Vec<String>)> {
    let mut reg = lock();
    let e = reg.entry((partition, end)).or_default();
    if e.at.as_ref() == Some(&(kind, window, id)) {
        e.at = None;
        e.pending.splice(0..0, held);
        return None;
    }
    let mut to = None;
    for data in held {
        if let Some(holder) = receive(e, data.clone()) {
            to.get_or_insert_with(|| (holder, Vec::new())).1.push(data);
        }
    }
    to
}

// A message that reached an end's holder after it had given the end up — it was on its way — for the holder now: its
// holder, nil where it waits for one (or the end is closed or unknown).
pub(crate) fn redeliver(partition: u64, end: String, data: String) -> Option<Holder> {
    let mut reg = lock();
    receive(reg.get_mut(&(partition, end))?, data)
}

// A port closed at its end: nothing more is delivered to it, and an end whose other is closed too is forgotten.
pub(crate) fn closed(partition: u64, end: String) {
    let mut reg = lock();
    let other = (partition, other_end(&end));
    if reg.get(&other).is_some_and(|e| e.closed) {
        reg.remove(&other);
        reg.remove(&(partition, end));
    } else {
        reg.insert((partition, end), End { closed: true, ..End::default() });
    }
}

// A message posted at end `from` (none where that end is closed, or unknown: a worker's post and its close in one turn
// reach here after the close, its signals about ends handled ahead of its messages): `[the other end, its holder]` to
// deliver it to, nil where it waits for one.
pub(crate) fn post(partition: u64, from: String, data: String) -> Option<(String, Holder)> {
    let mut reg = lock();
    if reg.get(&(partition, from.clone())).is_none_or(|e| e.closed) {
        return None;
    }
    let to = other_end(&from);
    let holder = receive(reg.entry((partition, to.clone())).or_default(), data)?;
    Some((to, holder))
}

// A window gone: every end one of its isolates held closed, the messages held for it dropped — its document destroyed,
// nothing is delivered to its ports any more (HTML "MessagePort … garbage collection": its owner gone). An end given
// up (`gone`) before it went, on its way to another holder, is no longer the window's, and stays.
pub(crate) fn forget_window(partition: u64, window: u32) {
    for e in lock().iter_mut().filter(|((p, _), _)| *p == partition).map(|(_, e)| e) {
        if e.at.as_ref().is_some_and(|(_, w, _)| *w == window) {
            *e = End { closed: true, ..End::default() };
        }
    }
}

// A session's channels gone.
pub(crate) fn clear(partition: u64) {
    lock().retain(|(p, _), _| *p != partition);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivers_to_the_holder_of_the_other_end_or_holds_for_the_next() {
        let p = 9_001;
        let holder = |w: u32, id: i64| ("realm".to_owned(), w, id);
        assert!(here(p, "c/0".into(), "realm".into(), 0, 1).is_empty());
        // (…the other end held by none yet: held for its holder, handed over as it takes the end)
        assert_eq!(post(p, "c/0".into(), "a".into()), None);
        assert_eq!(here(p, "c/1".into(), "worker".into(), 1, 4), vec!["a".to_owned()]);
        assert_eq!(post(p, "c/1".into(), "b".into()), Some(("c/0".into(), holder(0, 1))));
        // (…given up with a message undelivered: held ahead of the next, which its next holder takes)
        assert_eq!(gone(p, "c/0".into(), vec!["x".into()], "realm".into(), 0, 1), None);
        assert_eq!(post(p, "c/1".into(), "y".into()), None);
        assert_eq!(here(p, "c/0".into(), "realm".into(), 2, 3), vec!["x".to_owned(), "y".to_owned()]);
        // (…a window gone: its ends closed, nothing held for them — an end it gave up before, on its way, kept)
        assert!(here(p, "d/0".into(), "realm".into(), 2, 3).is_empty());
        assert_eq!(gone(p, "d/0".into(), Vec::new(), "realm".into(), 2, 3), None);
        forget_window(p, 2);
        for n in 0..3 {
            assert_eq!(post(p, "c/1".into(), format!("z{n}")), None);
        }
        assert!(lock().get(&(p, "c/0".into())).is_some_and(|e| e.closed && e.pending.is_empty()));
        assert!(lock().get(&(p, "d/0".into())).is_some_and(|e| !e.closed));
        assert_eq!(post(p, "c/0".into(), "w".into()), None);
        // (…both ends closed: the channel forgotten)
        closed(p, "c/1".into());
        assert!(!lock().contains_key(&(p, "c/0".into())) && !lock().contains_key(&(p, "c/1".into())));
        clear(p);
        assert!(lock().keys().all(|(q, _)| *q != p));
    }
}
