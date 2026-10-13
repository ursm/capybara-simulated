// Indexed Database's databases (§2.1-2.4), one registry for the process: each named by the driver session's partition,
// a storage key (an origin's) and its name, with its version, its object stores' schema and records (idb.rs), its
// connections, its transactions and their order, and the queue its open and delete requests wait in — so every realm
// and worker of a session reads the same database, and a page reloaded finds what the last one wrote.
//
// Who asks is an AGENT: a realm of an isolate (a window's, a frame's, a worker's), made as it first uses IndexedDB and
// gone with its realm (`drop_realm`, or its isolate). What the registry owes an agent — an event to fire at one of its
// connections, a request of its answered, a transaction of its started — waits in the agent's notices until it takes
// them (`idbTake`): at once, by the bindings after each of their own calls, and at each step of its event loop for what
// another agent's call caused. The bindings (idb.js) keep the requests and events, a transaction's state between its
// events and its requests' order, key conversion and key paths.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{LazyLock, Mutex, MutexGuard};

use crate::dom::{realm_id, register};
use crate::idb::{name_arg, name_value, Store};

pub(crate) type Name = Vec<u16>;

// What names a database: the session's partition, the storage key, its name.
#[derive(Clone, PartialEq, Eq, Hash, Debug, Default)]
pub(crate) struct DbKey {
    partition: u64,
    storage: String,
    name: Name,
}

// A database: its version, its object stores by name (each a store's number), its connections not yet closed and its
// transactions not yet finished, each in the order made — and, while an upgrade runs, what it began from.
struct Database {
    version: f64,
    stores: BTreeMap<Name, u32>,
    connections: Vec<u32>,
    transactions: Vec<u32>,
    upgrade: Option<Upgrade>,
}

// An upgrade transaction's start: the version, the store names and every store as they were — which an abort puts back —
// and the stores it made (each kept, deleted or not, for the requests queued before its deletion, until it ends).
struct Upgrade {
    tx: u32,
    version: f64,
    stores: BTreeMap<Name, u32>,
    saved: HashMap<u32, Store>,
    made: Vec<u32>,
}

// A connection: its database, its agent, its version and store names (as of its open, or its own upgrade), whether its
// close is pending, and whether it is closed.
struct Connection {
    db: DbKey,
    agent: u64,
    version: f64,
    store_names: Vec<Name>,
    close_pending: bool,
    closed: bool,
}

// A transaction: its connection, its scope (store names, sorted), its mode, whether it started.
struct Transaction {
    conn: u32,
    db: DbKey,
    scope: Vec<Name>,
    mode: u32,
    started: bool,
}
const READONLY: u32 = 0;
const VERSIONCHANGE: u32 = 2;

// An open or a delete request waiting in its database's queue: its agent and the agent's number for it, what it asks,
// and how far it got — the connection an open made, the connections it waits for, those a `versionchange` event is
// still to fire at, and the version it upgrades to.
struct Pending {
    id: u32,
    agent: u64,
    request: u32,
    open: Option<Option<f64>>,
    conn: Option<u32>,
    waiting: Vec<u32>,
    unacked: Vec<u32>,
    blocked: bool,
    version: f64,
}

// What an agent is told, its kind and up to four numbers (NaN: null), and whether it is a task of its own or fires as it
// is taken.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Notice {
    kind: u32,
    args: [f64; 4],
    later: bool,
}
// `versionchange` at a connection: [connection, old version, new version].
const VERSION_CHANGE: u32 = 1;
// `blocked` at a request: [request, old version, new version].
const BLOCKED: u32 = 2;
// An upgrade begun for an open request: [request, connection, transaction, old version].
const UPGRADE: u32 = 3;
// An open request's connection: [request, connection].
const OPENED: u32 = 4;
// An open request refused, a VersionError: [request, the version asked, the database's].
const OPEN_REFUSED: u32 = 5;
// A delete request done: [request, the old version].
const DELETED: u32 = 6;
// A queued request's turn: [its entry].
const TURN: u32 = 7;
// A transaction started: [transaction].
const STARTED: u32 = 8;

struct Agent {
    partition: u64,
    notices: Vec<Notice>,
}

#[derive(Default)]
pub(crate) struct Registry {
    next: u32,
    next_agent: u64,
    next_partition: u64,
    pub(crate) stores: HashMap<u32, Store>,
    databases: HashMap<DbKey, Database>,
    queues: HashMap<DbKey, VecDeque<Pending>>,
    connections: HashMap<u32, Connection>,
    transactions: HashMap<u32, Transaction>,
    agents: HashMap<u64, Agent>,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

// The registry, held for one op (no V8 call is made while it is).
pub(crate) fn lock() -> MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Registry {
    pub(crate) fn next_id(&mut self) -> u32 {
        self.next = self.next.wrapping_add(1);
        self.next
    }
    fn tell(&mut self, agent: u64, kind: u32, args: [f64; 4], later: bool) {
        if let Some(a) = self.agents.get_mut(&agent) {
            a.notices.push(Notice { kind, args, later });
        }
    }

    // ── Liveness ──
    // Whether store `id` is one of its database's now.
    pub(crate) fn store_live(&self, id: u32) -> bool {
        let Some(st) = self.stores.get(&id) else { return false };
        self.databases.get(&st.db).is_some_and(|db| db.stores.get(&st.name) == Some(&id))
    }

    // ── The connection queue ──
    // Request `request` of `agent` queued behind the others for its database — its turn a task later where it is first.
    fn enqueue(&mut self, key: DbKey, agent: u64, request: u32, open: Option<Option<f64>>) {
        let id = self.next_id();
        let queue = self.queues.entry(key).or_default();
        queue.push_back(Pending { id, agent, request, open, conn: None, waiting: Vec::new(), unacked: Vec::new(), blocked: false, version: 0.0 });
        if queue.len() == 1 {
            self.tell(agent, TURN, [f64::from(id), 0.0, 0.0, 0.0], true);
        }
    }
    fn queue_of(&self, entry: u32) -> Option<DbKey> {
        self.queues.iter().find(|(_, q)| q.front().is_some_and(|p| p.id == entry)).map(|(k, _)| k.clone())
    }
    // The first request of a queue run: "open a database connection" or "delete a database" up to where it waits.
    fn turn(&mut self, entry: u32) {
        let Some(key) = self.queue_of(entry) else { return };
        let (agent, request, open) = {
            let p = &self.queues[&key][0];
            (p.agent, p.request, p.open)
        };
        match open {
            Some(asked) => {
                let existed = self.databases.contains_key(&key);
                let db = self.databases.entry(key.clone()).or_insert_with(|| Database {
                    version: 0.0,
                    stores: BTreeMap::new(),
                    connections: Vec::new(),
                    transactions: Vec::new(),
                    upgrade: None,
                });
                let version = asked.unwrap_or(if existed { db.version } else { 1.0 });
                if db.version > version {
                    let current = db.version;
                    self.tell(agent, OPEN_REFUSED, [f64::from(request), version, current, 0.0], false);
                    return self.finish(&key);
                }
                let conn = self.next_id();
                let db = self.databases.get_mut(&key).expect("just made");
                db.connections.push(conn);
                let store_names = db.stores.keys().cloned().collect();
                let current = db.version;
                self.connections.insert(conn, Connection { db: key.clone(), agent, version: current, store_names, close_pending: false, closed: false });
                if current == version {
                    self.tell(agent, OPENED, [f64::from(request), f64::from(conn), 0.0, 0.0], false);
                    return self.finish(&key);
                }
                let p = self.queues.get_mut(&key).and_then(VecDeque::front_mut).expect("its turn");
                p.conn = Some(conn);
                p.version = version;
                self.wait_for_connections(&key);
            }
            None => {
                if !self.databases.contains_key(&key) {
                    self.tell(agent, DELETED, [f64::from(request), 0.0, 0.0, 0.0], false);
                    return self.finish(&key);
                }
                self.wait_for_connections(&key);
            }
        }
    }
    // The database's other connections each told `versionchange` (one whose close is pending not) — what the first
    // request waits for to be fired before it decides on `blocked`.
    fn wait_for_connections(&mut self, key: &DbKey) {
        let Some(db) = self.databases.get(key) else { return };
        let p = &self.queues[key][0];
        let old = db.version;
        let new = if p.open.is_some() { p.version } else { f64::NAN };
        let others: Vec<u32> = db.connections.iter().copied().filter(|c| Some(*c) != p.conn).collect();
        let mut unacked = Vec::new();
        for &c in &others {
            let Some(conn) = self.connections.get(&c) else { continue };
            if !conn.close_pending {
                let agent = conn.agent;
                self.tell(agent, VERSION_CHANGE, [f64::from(c), old, new, 0.0], false);
                unacked.push(c);
            }
        }
        let p = self.queues.get_mut(key).and_then(VecDeque::front_mut).expect("its turn");
        p.waiting = others;
        let none = unacked.is_empty();
        p.unacked = unacked;
        if none {
            self.after_versionchange(key);
        }
    }
    // Every `versionchange` fired: `blocked` at the request where a connection is still open — and the request goes on
    // once none is (`closed`).
    fn after_versionchange(&mut self, key: &DbKey) {
        let open = self.still_open(key);
        let Some(db) = self.databases.get(key) else { return };
        let old = db.version;
        let p = self.queues.get_mut(key).and_then(VecDeque::front_mut).expect("its turn");
        if open {
            p.blocked = true;
            let new = if p.open.is_some() { p.version } else { f64::NAN };
            let (agent, request) = (p.agent, p.request);
            self.tell(agent, BLOCKED, [f64::from(request), old, new, 0.0], true);
        } else {
            self.proceed(key, false);
        }
    }
    fn still_open(&self, key: &DbKey) -> bool {
        let p = &self.queues[key][0];
        p.waiting.iter().any(|c| self.connections.get(c).is_some_and(|c| !c.closed))
    }
    // The waiting over: an open's upgrade begun, a delete's database gone — a task later where a close ended the wait.
    fn proceed(&mut self, key: &DbKey, later: bool) {
        // (…none for a request whose agent is gone)
        if self.queues[key].front().is_some_and(|p| !self.agents.contains_key(&p.agent)) {
            return self.finish(key);
        }
        let p = self.queues.get_mut(key).and_then(VecDeque::front_mut).expect("its turn");
        p.waiting.clear();
        p.blocked = false;
        let (agent, request, conn, version, open) = (p.agent, p.request, p.conn, p.version, p.open.is_some());
        if open {
            let Some(conn) = conn else { return };
            let tx = self.next_id();
            let Some(db) = self.databases.get_mut(key) else { return };
            let old = db.version;
            let saved = db.stores.values().filter_map(|id| self.stores.get(id).map(|st| (*id, st.clone()))).collect();
            db.upgrade = Some(Upgrade { tx, version: old, stores: db.stores.clone(), saved, made: Vec::new() });
            db.version = version;
            let scope: Vec<Name> = db.stores.keys().cloned().collect();
            db.transactions.push(tx);
            if let Some(c) = self.connections.get_mut(&conn) {
                c.version = version;
            }
            self.transactions.insert(tx, Transaction { conn, db: key.clone(), scope, mode: VERSIONCHANGE, started: true });
            self.tell(agent, UPGRADE, [f64::from(request), f64::from(conn), f64::from(tx), old], later);
        } else {
            let Some(db) = self.databases.remove(key) else { return };
            for id in db.stores.values() {
                self.stores.remove(id);
            }
            self.tell(agent, DELETED, [f64::from(request), db.version, 0.0, 0.0], later);
            self.finish(key);
        }
    }
    // The first request done: the next one's turn a task later.
    fn finish(&mut self, key: &DbKey) {
        let Some(queue) = self.queues.get_mut(key) else { return };
        queue.pop_front();
        match queue.front() {
            Some(next) => {
                let (agent, id) = (next.agent, next.id);
                self.tell(agent, TURN, [f64::from(id), 0.0, 0.0, 0.0], true);
            }
            None => {
                self.queues.remove(key);
            }
        }
    }
    // A `versionchange` fired at connection `conn` — or none to fire, its agent gone.
    fn ack(&mut self, conn: u32) {
        let Some(key) = self.connections.get(&conn).map(|c| c.db.clone()) else { return };
        let Some(p) = self.queues.get_mut(&key).and_then(VecDeque::front_mut) else { return };
        if !p.unacked.contains(&conn) {
            return;
        }
        p.unacked.retain(|&c| c != conn);
        if p.unacked.is_empty() {
            self.after_versionchange(&key);
        }
    }

    // ── Connections ──
    // "Close a database connection": closing at once, closed once its transactions are done.
    fn close(&mut self, conn: u32) {
        let Some(c) = self.connections.get_mut(&conn) else { return };
        c.close_pending = true;
        let busy = self.transactions.values().any(|t| t.conn == conn);
        if !busy {
            self.closed(conn);
        }
    }
    fn closed(&mut self, conn: u32) {
        let Some(c) = self.connections.get_mut(&conn) else { return };
        if c.closed {
            return;
        }
        c.closed = true;
        let key = c.db.clone();
        if let Some(db) = self.databases.get_mut(&key) {
            db.connections.retain(|&x| x != conn);
        }
        // (…a request waiting for it to close goes on, a task later)
        let waits = self.queues.get(&key).and_then(VecDeque::front).is_some_and(|p| p.blocked && p.waiting.contains(&conn));
        if waits && !self.still_open(&key) {
            self.proceed(&key, true);
        }
    }

    // ── Transactions ──
    // The database's transactions started as each may: none overlapping an earlier one still running or waiting, where
    // either writes — each agent told of its own, but of `quiet`, which its maker reads off it.
    fn schedule(&mut self, key: &DbKey, quiet: Option<u32>) {
        let Some(db) = self.databases.get(key) else { return };
        let order = db.transactions.clone();
        for (i, &tx) in order.iter().enumerate() {
            let Some(t) = self.transactions.get(&tx) else { continue };
            if t.started {
                continue;
            }
            let blocked = order[..i].iter().any(|e| self.transactions.get(e).is_some_and(|e| conflicts(e, t)));
            if blocked {
                continue;
            }
            let agent = self.connections.get(&t.conn).map(|c| c.agent);
            if let Some(t) = self.transactions.get_mut(&tx) {
                t.started = true;
            }
            if let Some(agent) = agent.filter(|_| quiet != Some(tx)) {
                self.tell(agent, STARTED, [f64::from(tx), 0.0, 0.0, 0.0], false);
            }
        }
    }
    // A transaction finished: gone from its database's schedule — which may start the next — and its connection closed
    // where that waited on it.
    fn finished(&mut self, tx: u32) {
        let Some(t) = self.transactions.remove(&tx) else { return };
        if let Some(db) = self.databases.get_mut(&t.db) {
            db.transactions.retain(|&x| x != tx);
        }
        let closing = self.connections.get(&t.conn).is_some_and(|c| c.close_pending && !c.closed);
        if closing && !self.transactions.values().any(|o| o.conn == t.conn) {
            self.closed(t.conn);
        }
        self.schedule(&t.db, None);
    }
    // An upgrade committed: what it began from let go — the stores it deleted with it.
    fn upgrade_committed(&mut self, tx: u32) {
        let Some(key) = self.transactions.get(&tx).map(|t| t.db.clone()) else { return };
        let Some(db) = self.databases.get_mut(&key) else { return };
        let Some(upgrade) = db.upgrade.take_if(|u| u.tx == tx) else { return };
        for id in upgrade.stores.values().chain(&upgrade.made) {
            if !db.stores.values().any(|x| x == id) {
                self.stores.remove(id);
            }
        }
    }
    // …or aborted: the version, the store names and every store put back; a store it made gone; its connection's
    // version and names as they were.
    fn upgrade_aborted(&mut self, tx: u32) {
        let Some((key, conn)) = self.transactions.get(&tx).map(|t| (t.db.clone(), t.conn)) else { return };
        let Some(db) = self.databases.get_mut(&key) else { return };
        let Some(upgrade) = db.upgrade.take_if(|u| u.tx == tx) else { return };
        db.version = upgrade.version;
        db.stores = upgrade.stores;
        let names = db.stores.keys().cloned().collect();
        for id in upgrade.made {
            self.stores.remove(&id);
        }
        for (id, store) in upgrade.saved {
            self.stores.insert(id, store);
        }
        if let Some(c) = self.connections.get_mut(&conn) {
            c.version = upgrade.version;
            c.store_names = names;
        }
    }
    // The version a database's transactions committed: an upgrade still running set its own.
    fn committed_version(db: &Database) -> f64 {
        db.upgrade.as_ref().map_or(db.version, |u| u.version)
    }

    // ── Agents ──
    // An agent gone with its realm: its connections closed, its transactions aborted (what they wrote put back), its
    // requests out of their queues.
    fn drop_agent(&mut self, agent: u64) {
        self.agents.remove(&agent);
        // (…its requests out first, the first of a queue too: a connection of its closing must not go on with a request
        // of its own that waited on it)
        let keys: Vec<DbKey> = self.queues.keys().cloned().collect();
        for key in keys {
            let head_gone = self.queues[&key].front().is_some_and(|p| p.agent == agent);
            if let Some(queue) = self.queues.get_mut(&key) {
                let head = queue.pop_front();
                queue.retain(|p| p.agent != agent);
                if let Some(head) = head {
                    queue.push_front(head);
                }
            }
            if head_gone {
                self.finish(&key);
            }
        }
        let conns: Vec<u32> = self.connections.iter().filter(|(_, c)| c.agent == agent).map(|(id, _)| *id).collect();
        for conn in &conns {
            let txs: Vec<u32> = self.transactions.iter().filter(|(_, t)| t.conn == *conn).map(|(id, _)| *id).collect();
            for tx in txs {
                crate::idb::undo_transaction(self, tx);
                self.upgrade_aborted(tx);
                self.finished(tx);
            }
            if let Some(c) = self.connections.get_mut(conn) {
                c.close_pending = true;
            }
            self.closed(*conn);
            self.ack(*conn);
        }
        self.connections.retain(|_, c| c.agent != agent || !c.closed);
    }
    // A session's storage cleared: every database of its partition gone, its stores with it.
    fn clear(&mut self, partition: u64) {
        let gone: Vec<DbKey> = self.databases.keys().filter(|k| k.partition == partition).cloned().collect();
        for key in gone {
            if let Some(db) = self.databases.remove(&key) {
                for id in db.stores.values() {
                    self.stores.remove(id);
                }
                if let Some(u) = db.upgrade {
                    for id in u.saved.keys().chain(&u.made) {
                        self.stores.remove(id);
                    }
                }
            }
        }
        self.queues.retain(|k, _| k.partition != partition);
        self.transactions.retain(|_, t| t.db.partition != partition);
        self.connections.retain(|_, c| c.db.partition != partition);
    }
}

fn conflicts(a: &Transaction, b: &Transaction) -> bool {
    (a.mode != READONLY || b.mode != READONLY) && a.scope.iter().any(|n| b.scope.contains(n))
}

// ── The agents of an isolate ─────────────────────────────────────────────────────────────────────────────────────────
// Each realm's agent, by realm — gone from the registry with the realm, or with the isolate.
#[derive(Default)]
struct Agents(HashMap<i32, u64>);
impl Drop for Agents {
    fn drop(&mut self) {
        let mut reg = lock();
        for agent in self.0.values() {
            reg.drop_agent(*agent);
        }
    }
}
fn agent_of(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> Option<u64> {
    let realm = realm_id(scope, args);
    scope.get_slot::<Agents>().and_then(|a| a.0.get(&realm).copied())
}
// The agent realm `realm` was, gone (its context begun anew or disposed).
pub(crate) fn drop_realm(scope: &mut v8::PinScope<'_, '_>, realm: i32) {
    let Some(agent) = scope.get_slot_mut::<Agents>().and_then(|a| a.0.remove(&realm)) else { return };
    lock().drop_agent(agent);
}

// ── For the host ─────────────────────────────────────────────────────────────────────────────────────────────────────
// A new session's partition.
pub(crate) fn partition_new() -> u64 {
    let mut reg = lock();
    reg.next_partition += 1;
    reg.next_partition
}
// A session's databases deleted (its storage cleared).
pub(crate) fn clear(partition: u64) {
    lock().clear(partition);
}
// Whether an agent of a session has notices it has yet to take — some event loop of the session has work (which one,
// each isolate's `idbPending` says).
pub(crate) fn pending(partition: u64) -> bool {
    lock().agents.values().any(|a| a.partition == partition && !a.notices.is_empty())
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "idbAgent", agent_op, context_id);
    register(scope, ns, "idbTake", take, context_id);
    register(scope, ns, "idbPending", pending_here, context_id);
    register(scope, ns, "idbDropAgents", drop_agents, context_id);
    register(scope, ns, "idbOpen", open, context_id);
    register(scope, ns, "idbDeleteDatabase", delete_database, context_id);
    register(scope, ns, "idbTurn", turn, context_id);
    register(scope, ns, "idbAck", ack, context_id);
    register(scope, ns, "idbDatabases", databases, context_id);
    register(scope, ns, "idbConnection", connection, context_id);
    register(scope, ns, "idbClose", close, context_id);
    register(scope, ns, "idbTransaction", transaction, context_id);
    register(scope, ns, "idbFinished", finished, context_id);
    register(scope, ns, "idbUpgradeEnd", upgrade_end, context_id);
    register(scope, ns, "idbRequestDone", request_done, context_id);
    register(scope, ns, "idbStoreId", store_id, context_id);
    register(scope, ns, "idbStoreCreate", store_create, context_id);
    register(scope, ns, "idbStoreDelete", store_delete, context_id);
    register(scope, ns, "idbStoreRename", store_rename, context_id);
}

fn u32_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, i: i32) -> u32 {
    args.get(i).uint32_value(scope).unwrap_or(0)
}
fn string_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, i: i32) -> String {
    args.get(i).to_rust_string_lossy(scope)
}
fn db_key(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, agent: u64) -> Option<DbKey> {
    let storage = string_arg(scope, args, 0);
    let name = name_arg(scope, args.get(1))?;
    let partition = lock().agents.get(&agent)?.partition;
    Some(DbKey { partition, storage, name })
}
fn names_value<'s>(scope: &mut v8::PinScope<'s, '_>, names: &[Name]) -> v8::Local<'s, v8::Value> {
    let items: Vec<v8::Local<v8::Value>> = names.iter().map(|n| name_value(scope, n)).collect();
    v8::Array::new_with_elements(scope, &items).into()
}

// __dom.idbAgent(partition): this realm an agent of session `partition`'s, where it is not yet one.
fn agent_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if agent_of(scope, &args).is_some() {
        return;
    }
    let partition = args.get(0).integer_value(scope).unwrap_or(0) as u64;
    let realm = realm_id(scope, &args);
    let agent = {
        let mut reg = lock();
        reg.next_agent += 1;
        let agent = reg.next_agent;
        reg.agents.insert(agent, Agent { partition, notices: Vec::new() });
        agent
    };
    if scope.get_slot::<Agents>().is_none() {
        scope.set_slot(Agents::default());
    }
    scope.get_slot_mut::<Agents>().expect("Agents slot was just set").0.insert(realm, agent);
}
// __dom.idbTake() -> [kind, later, a, b, c, d, …]: the notices this realm's agent has, taken (null for none).
fn take(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(agent) = agent_of(scope, &args) else { return rv.set_null() };
    let notices = lock().agents.get_mut(&agent).map(|a| std::mem::take(&mut a.notices)).unwrap_or_default();
    if notices.is_empty() {
        return rv.set_null();
    }
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(notices.len() * 6);
    for n in notices {
        items.push(v8::Integer::new_from_unsigned(scope, n.kind).into());
        items.push(v8::Boolean::new(scope, n.later).into());
        for a in n.args {
            items.push(if a.is_nan() { v8::null(scope).into() } else { v8::Number::new(scope, a).into() });
        }
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.idbPending() -> whether an agent of this isolate — any realm's — has notices to take.
fn pending_here(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let agents: Vec<u64> = scope.get_slot::<Agents>().map(|a| a.0.values().copied().collect()).unwrap_or_default();
    let reg = lock();
    rv.set_bool(agents.iter().any(|a| reg.agents.get(a).is_some_and(|a| !a.notices.is_empty())));
}
// __dom.idbDropAgents(): every agent of this isolate gone — its window closed while the isolate lives on (kept for its
// service workers): its connections closed, as a closed window's are.
fn drop_agents(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let agents: Vec<u64> = scope.get_slot_mut::<Agents>().map(|a| a.0.drain().map(|(_, agent)| agent).collect()).unwrap_or_default();
    let mut reg = lock();
    for agent in agents {
        reg.drop_agent(agent);
    }
}
// __dom.idbOpen(storageKey, name, version, request): an open request queued (`version` undefined: none asked).
fn open(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(agent) = agent_of(scope, &args) else { return };
    let Some(key) = db_key(scope, &args, agent) else { return };
    let version = args.get(2);
    let version = (!version.is_undefined()).then(|| version.number_value(scope)).flatten();
    let request = u32_arg(scope, &args, 3);
    lock().enqueue(key, agent, request, Some(version));
}
// __dom.idbDeleteDatabase(storageKey, name, request): a delete request queued.
fn delete_database(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(agent) = agent_of(scope, &args) else { return };
    let Some(key) = db_key(scope, &args, agent) else { return };
    let request = u32_arg(scope, &args, 2);
    lock().enqueue(key, agent, request, None);
}
// __dom.idbTurn(entry): a queued request's turn come (its `TURN` notice's task).
fn turn(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let entry = u32_arg(scope, &args, 0);
    lock().turn(entry);
}
// __dom.idbAck(connection): the `versionchange` told it fired.
fn ack(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let conn = u32_arg(scope, &args, 0);
    lock().ack(conn);
}
// __dom.idbDatabases(storageKey) -> [name, version, …]: the session's databases of the storage key, at the version their
// transactions committed (none at 0).
fn databases(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(agent) = agent_of(scope, &args) else { return };
    let storage = string_arg(scope, &args, 0);
    let found: Vec<(Name, f64)> = {
        let reg = lock();
        let Some(partition) = reg.agents.get(&agent).map(|a| a.partition) else { return };
        let mut found: Vec<(Name, f64)> = reg
            .databases
            .iter()
            .filter(|(k, _)| k.partition == partition && k.storage == storage)
            .map(|(k, db)| (k.name.clone(), Registry::committed_version(db)))
            .filter(|(_, v)| *v > 0.0)
            .collect();
        found.sort_by(|a, b| a.0.cmp(&b.0));
        found
    };
    let mut items = Vec::with_capacity(found.len() * 2);
    for (name, version) in found {
        items.push(name_value(scope, &name));
        items.push(v8::Number::new(scope, version).into());
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.idbConnection(connection) -> [name, version, store names]: what a connection says of its database.
fn connection(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let conn = u32_arg(scope, &args, 0);
    let found = lock().connections.get(&conn).map(|c| (c.db.name.clone(), c.version, c.store_names.clone()));
    let Some((name, version, names)) = found else { return };
    let items = [name_value(scope, &name), v8::Number::new(scope, version).into(), names_value(scope, &names)];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.idbClose(connection): its close pending — closed once its transactions are done.
fn close(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let conn = u32_arg(scope, &args, 0);
    lock().close(conn);
}
// __dom.idbTransaction(connection, scope, mode) -> [a transaction's number, whether it started]: scheduled — `STARTED`
// told once it may run, where it may not at once; 0 where a store of the scope is none of the database's.
fn transaction(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let conn = u32_arg(scope, &args, 0);
    let mut names = Vec::new();
    if let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(1)) {
        for i in 0..list.length() {
            if let Some(n) = list.get_index(scope, i).and_then(|v| name_arg(scope, v)) {
                names.push(n);
            }
        }
    }
    names.sort();
    names.dedup();
    let mode = u32_arg(scope, &args, 2);
    let mut reg = lock();
    let Some(key) = reg.connections.get(&conn).map(|c| c.db.clone()) else { return rv.set_uint32(0) };
    let Some(db) = reg.databases.get(&key) else { return rv.set_uint32(0) };
    if names.iter().any(|n| !db.stores.contains_key(n)) {
        return rv.set_uint32(0);
    }
    let tx = reg.next_id();
    reg.transactions.insert(tx, Transaction { conn, db: key.clone(), scope: names, mode, started: false });
    reg.databases.get_mut(&key).expect("looked up").transactions.push(tx);
    reg.schedule(&key, Some(tx));
    let started = reg.transactions[&tx].started;
    drop(reg);
    let items = [v8::Integer::new_from_unsigned(scope, tx).into(), v8::Boolean::new(scope, started).into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.idbFinished(transaction): it finished.
fn finished(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let tx = u32_arg(scope, &args, 0);
    lock().finished(tx);
}
// __dom.idbUpgradeEnd(transaction, aborted): an upgrade transaction committed or aborted — what it began from let go, or
// put back.
fn upgrade_end(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let tx = u32_arg(scope, &args, 0);
    let aborted = args.get(1).is_true();
    let mut reg = lock();
    if aborted {
        reg.upgrade_aborted(tx);
    } else {
        reg.upgrade_committed(tx);
    }
}

// __dom.idbRequestDone(request): an open request answered once its upgrade finished — the next request's turn.
fn request_done(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(agent) = agent_of(scope, &args) else { return };
    let request = u32_arg(scope, &args, 0);
    let mut reg = lock();
    let key = reg.queues.iter().find(|(_, q)| q.front().is_some_and(|p| p.agent == agent && p.request == request)).map(|(k, _)| k.clone());
    if let Some(key) = key {
        reg.finish(&key);
    }
}

// ── The schema ──
// __dom.idbStoreId(connection, name) -> the number of its database's store of that name, or 0 for none.
fn store_id(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let conn = u32_arg(scope, &args, 0);
    let Some(name) = name_arg(scope, args.get(1)) else { return rv.set_uint32(0) };
    let reg = lock();
    let id = reg.connections.get(&conn).and_then(|c| reg.databases.get(&c.db)).and_then(|db| db.stores.get(&name).copied());
    rv.set_uint32(id.unwrap_or(0));
}
// __dom.idbStoreCreate(transaction, name, keyPath, autoIncrement) -> a new store's number, in the upgrade's database (0
// where it has one of the name).
fn store_create(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let tx = u32_arg(scope, &args, 0);
    let Some(name) = name_arg(scope, args.get(1)) else { return rv.set_uint32(0) };
    let key_path = crate::idb::key_path_arg(scope, args.get(2));
    let auto_increment = args.get(3).is_true();
    let mut reg = lock();
    let Some((key, conn)) = reg.transactions.get(&tx).map(|t| (t.db.clone(), t.conn)) else { return rv.set_uint32(0) };
    if reg.databases.get(&key).is_none_or(|db| db.stores.contains_key(&name)) {
        return rv.set_uint32(0);
    }
    let id = reg.next_id();
    reg.stores.insert(id, Store::new(key.clone(), name.clone(), key_path, auto_increment));
    let db = reg.databases.get_mut(&key).expect("looked up");
    db.stores.insert(name, id);
    if let Some(upgrade) = &mut db.upgrade {
        upgrade.made.push(id);
    }
    let names = db.stores.keys().cloned().collect();
    if let Some(c) = reg.connections.get_mut(&conn) {
        c.store_names = names;
    }
    rv.set_uint32(id);
}
// __dom.idbStoreDelete(transaction, name) -> the number of the store deleted from the upgrade's database, or 0 for none.
fn store_delete(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let tx = u32_arg(scope, &args, 0);
    let Some(name) = name_arg(scope, args.get(1)) else { return rv.set_uint32(0) };
    let mut reg = lock();
    let Some((key, conn)) = reg.transactions.get(&tx).map(|t| (t.db.clone(), t.conn)) else { return rv.set_uint32(0) };
    let Some(db) = reg.databases.get_mut(&key) else { return rv.set_uint32(0) };
    let Some(id) = db.stores.remove(&name) else { return rv.set_uint32(0) };
    let names = db.stores.keys().cloned().collect();
    // (…its records kept, for the requests queued before the deletion and for an abort, until the upgrade ends)
    if let Some(c) = reg.connections.get_mut(&conn) {
        c.store_names = names;
    }
    rv.set_uint32(id);
}
// __dom.idbStoreRename(transaction, store, name) -> whether it took the name (none of the database's other stores has it).
fn store_rename(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (tx, store) = (u32_arg(scope, &args, 0), u32_arg(scope, &args, 1));
    let Some(name) = name_arg(scope, args.get(2)) else { return rv.set_bool(false) };
    let mut reg = lock();
    let Some((key, conn)) = reg.transactions.get(&tx).map(|t| (t.db.clone(), t.conn)) else { return rv.set_bool(false) };
    let Some(old) = reg.stores.get(&store).map(|st| st.name.clone()) else { return rv.set_bool(false) };
    if old == name {
        return rv.set_bool(true);
    }
    let Some(db) = reg.databases.get_mut(&key) else { return rv.set_bool(false) };
    if db.stores.contains_key(&name) {
        return rv.set_bool(false);
    }
    db.stores.remove(&old);
    db.stores.insert(name.clone(), store);
    let names = db.stores.keys().cloned().collect();
    if let Some(c) = reg.connections.get_mut(&conn) {
        c.store_names = names;
    }
    if let Some(st) = reg.stores.get_mut(&store) {
        st.name = name;
    }
    rv.set_bool(true);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(s: &str) -> Name {
        s.encode_utf16().collect()
    }
    fn key(s: &str) -> DbKey {
        DbKey { partition: 1, storage: "o".into(), name: name(s) }
    }
    fn agent(reg: &mut Registry) -> u64 {
        reg.next_agent += 1;
        reg.agents.insert(reg.next_agent, Agent { partition: 1, notices: Vec::new() });
        reg.next_agent
    }
    fn taken(reg: &mut Registry, agent: u64) -> Vec<(u32, [f64; 4])> {
        std::mem::take(&mut reg.agents.get_mut(&agent).expect("an agent").notices).into_iter().map(|n| (n.kind, n.args)).collect()
    }

    // An open of a new database: its turn a task later, an upgrade begun, the version committed only as it commits.
    #[test]
    fn an_open_upgrades_a_new_database() {
        let mut reg = Registry::default();
        let a = agent(&mut reg);
        reg.enqueue(key("db"), a, 7, Some(None));
        let turn = taken(&mut reg, a);
        assert_eq!(turn[0].0, TURN);
        reg.turn(turn[0].1[0] as u32);
        let n = taken(&mut reg, a);
        assert_eq!(n.len(), 1);
        assert_eq!((n[0].0, n[0].1[0], n[0].1[3]), (UPGRADE, 7.0, 0.0));
        let tx = n[0].1[2] as u32;
        assert_eq!(Registry::committed_version(&reg.databases[&key("db")]), 0.0);
        reg.upgrade_committed(tx);
        assert_eq!(Registry::committed_version(&reg.databases[&key("db")]), 1.0);
    }

    // A second agent's open of a newer version: `versionchange` at the first's connection, `blocked` while it stays
    // open, the upgrade once it closes.
    #[test]
    fn an_upgrade_waits_for_another_agents_connection() {
        let mut reg = Registry::default();
        let (a, b) = (agent(&mut reg), agent(&mut reg));
        reg.enqueue(key("db"), a, 1, Some(Some(1.0)));
        let t = taken(&mut reg, a)[0].1[0] as u32;
        reg.turn(t);
        let up = taken(&mut reg, a)[0].1;
        reg.finished(up[2] as u32);
        reg.upgrade_committed(up[2] as u32);
        reg.finish(&key("db"));
        let conn_a = up[1] as u32;
        reg.enqueue(key("db"), b, 2, Some(Some(2.0)));
        let t = taken(&mut reg, b)[0].1[0] as u32;
        reg.turn(t);
        let to_a = taken(&mut reg, a);
        assert_eq!(to_a, vec![(VERSION_CHANGE, [f64::from(conn_a), 1.0, 2.0, 0.0])]);
        assert!(taken(&mut reg, b).is_empty());
        reg.ack(conn_a);
        assert_eq!(taken(&mut reg, b), vec![(BLOCKED, [2.0, 1.0, 2.0, 0.0])]);
        reg.close(conn_a);
        let n = taken(&mut reg, b);
        assert_eq!((n[0].0, n[0].1[3]), (UPGRADE, 1.0));
    }

    // Transactions overlapping where either writes run one after the other; read-only ones at once.
    #[test]
    fn transactions_start_as_they_may() {
        let mut reg = Registry::default();
        let a = agent(&mut reg);
        reg.databases.insert(key("db"), Database { version: 1.0, stores: BTreeMap::from([(name("s"), 9)]), connections: vec![1], transactions: Vec::new(), upgrade: None });
        reg.connections.insert(1, Connection { db: key("db"), agent: a, version: 1.0, store_names: vec![name("s")], close_pending: false, closed: false });
        let mut new_tx = |reg: &mut Registry, id: u32, mode: u32| {
            reg.transactions.insert(id, Transaction { conn: 1, db: key("db"), scope: vec![name("s")], mode, started: false });
            reg.databases.get_mut(&key("db")).expect("made").transactions.push(id);
            reg.schedule(&key("db"), None);
        };
        new_tx(&mut reg, 10, 1);
        new_tx(&mut reg, 11, READONLY);
        new_tx(&mut reg, 12, READONLY);
        assert_eq!(taken(&mut reg, a), vec![(STARTED, [10.0, 0.0, 0.0, 0.0])]);
        reg.finished(10);
        assert_eq!(taken(&mut reg, a), vec![(STARTED, [11.0, 0.0, 0.0, 0.0]), (STARTED, [12.0, 0.0, 0.0, 0.0])]);
    }
}
