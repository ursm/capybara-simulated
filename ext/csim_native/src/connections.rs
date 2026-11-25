// The connections an isolate's realms hold open — its EventSources' (event_source_state.rs) and its WebSockets'
// (ws_state.rs), a registry of each — by the realm whose object made them: each object, and the state handle it wraps,
// from its construction until its connection is closed for good. What the host's events for a connection are delivered
// to (the object of a realm whose state names the host's id for it), and what a realm's document going — or being
// stopped — closes (each of the realm's), are found here. An entry holds its object strongly, as a connection that may
// still fire events keeps its object alive (HTML §9.2.8 / WebSockets §7 "garbage collection"): an entry goes as its
// connection closes, or with its realm.

pub(crate) struct Entry {
    key: u64,
    pub(crate) realm: i32,
    pub(crate) target: v8::Global<v8::Object>,
    pub(crate) state: v8::Global<v8::Object>,
}

#[derive(Default)]
pub(crate) struct Registry {
    next: u64,
    entries: Vec<Entry>,
}

impl Registry {
    // The connection of `target`, whose state is `state`, made in `realm`: the key its state names it by.
    pub(crate) fn add(&mut self, realm: i32, target: v8::Global<v8::Object>, state: v8::Global<v8::Object>) -> u64 {
        self.next += 1;
        self.entries.push(Entry { key: self.next, realm, target, state });
        self.next
    }
    // …closed for good (0: one never registered).
    pub(crate) fn remove(&mut self, key: u64) {
        if key != 0 {
            self.entries.retain(|e| e.key != key);
        }
    }
    // …those of `realm`, in the order they were made: each object and its state.
    pub(crate) fn of_realm(&self, realm: i32) -> Vec<(v8::Global<v8::Object>, v8::Global<v8::Object>)> {
        self.entries.iter().filter(|e| e.realm == realm).map(|e| (e.target.clone(), e.state.clone())).collect()
    }
    // …those of `realm` taken out: its document is going.
    pub(crate) fn take_realm(&mut self, realm: i32) -> Vec<Entry> {
        let (taken, kept) = std::mem::take(&mut self.entries).into_iter().partition(|e| e.realm == realm);
        self.entries = kept;
        taken
    }
    pub(crate) fn drop_realm(&mut self, realm: i32) {
        self.entries.retain(|e| e.realm != realm);
    }
}
