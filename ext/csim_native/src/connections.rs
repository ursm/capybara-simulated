// The connections an isolate's realms hold open — its EventSources' (event_source_state.rs) and its WebSockets'
// (ws_state.rs), a registry of each — by the realm whose object made them: each object, and the state handle it wraps,
// from its construction until its connection is closed for good. What the host's events for a connection are delivered
// to (the object of a realm the host's id for its connection names: one lookup, whatever the number of connections),
// and what a realm's document going — or being stopped — closes (each of the realm's), are found here. An entry holds
// its object strongly, as a connection that may still fire events keeps its object alive (HTML §9.2.8 / WebSockets §7
// "garbage collection"): an entry goes as its connection closes, or with its realm.

use std::collections::{BTreeMap, HashMap};

pub(crate) struct Entry {
    pub(crate) realm: i32,
    pub(crate) target: v8::Global<v8::Object>,
    pub(crate) state: v8::Global<v8::Object>,
    // The host's id for its connection (0: none now).
    host: i32,
}

#[derive(Default)]
pub(crate) struct Registry {
    next: u64,
    // By key, in the order they were made.
    entries: BTreeMap<u64, Entry>,
    // The key of the entry each host id is the connection of.
    by_host: HashMap<i32, u64>,
}

impl Registry {
    // The connection of `target`, whose state is `state`, made in `realm`: the key its state names it by.
    pub(crate) fn add(&mut self, realm: i32, target: v8::Global<v8::Object>, state: v8::Global<v8::Object>) -> u64 {
        self.next += 1;
        self.entries.insert(self.next, Entry { realm, target, state, host: 0 });
        self.next
    }
    // …the host's id for its connection now (0: none — a source reconnecting has no connection till it connects).
    pub(crate) fn set_host(&mut self, key: u64, host: i32) {
        let Some(entry) = self.entries.get_mut(&key) else { return };
        if entry.host > 0 {
            self.by_host.remove(&entry.host);
        }
        entry.host = host;
        if host > 0 {
            self.by_host.insert(host, key);
        }
    }
    // …closed for good (0: one never registered).
    pub(crate) fn remove(&mut self, key: u64) {
        if let Some(entry) = self.entries.remove(&key) {
            self.forget_host(&entry);
        }
    }
    fn forget_host(&mut self, entry: &Entry) {
        if entry.host > 0 {
            self.by_host.remove(&entry.host);
        }
    }
    // The object of `realm`'s connection that is the host's `host`, if any.
    pub(crate) fn of_host(&self, realm: i32, host: i32) -> Option<&v8::Global<v8::Object>> {
        let entry = self.by_host.get(&host).and_then(|key| self.entries.get(key)).filter(|e| e.realm == realm)?;
        Some(&entry.target)
    }
    // …those of `realm`, in the order they were made: each object and its state.
    pub(crate) fn of_realm(&self, realm: i32) -> Vec<(v8::Global<v8::Object>, v8::Global<v8::Object>)> {
        self.entries.values().filter(|e| e.realm == realm).map(|e| (e.target.clone(), e.state.clone())).collect()
    }
    // …those of `realm` taken out: its document is going.
    pub(crate) fn take_realm(&mut self, realm: i32) -> Vec<Entry> {
        let keys: Vec<u64> = self.entries.iter().filter(|(_, e)| e.realm == realm).map(|(k, _)| *k).collect();
        let taken: Vec<Entry> = keys.into_iter().filter_map(|k| self.entries.remove(&k)).collect();
        for entry in &taken {
            self.forget_host(entry);
        }
        taken
    }
    pub(crate) fn drop_realm(&mut self, realm: i32) {
        self.take_realm(realm);
    }
}
