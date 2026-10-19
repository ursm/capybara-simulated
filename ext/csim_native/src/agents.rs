// The AGENTS of the process's shared registries — IndexedDB's databases (idb_databases.rs) and the lock managers of Web
// Locks (web_locks.rs): who asks, and what a registry owes each. An agent is a realm of an isolate (a window's, a
// frame's, a worker's) of a driver session's partition, made as the realm first uses one of them and gone with its realm
// (`drop_realm`) or its isolate, every registry told (`agent_gone`) so that what it held — a connection, a lock — goes
// with it.
//
// What a registry owes an agent for another agent's call — an event to fire, a request answered, a lock granted — waits
// in the agent's notices until it takes them (`agentTake`): at once, by the bindings after each of their own calls, and
// at each step of its event loop (engine-notices.js). A notice is a kind, which names its registry by range, four
// numbers, and whether it is a task of its own or is acted on as it is taken.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};

use crate::dom::{realm_id, register};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Notice {
    pub(crate) kind: u32,
    pub(crate) args: [f64; 4],
    pub(crate) later: bool,
}

struct Agent {
    partition: u64,
    notices: Vec<Notice>,
}

static AGENTS: LazyLock<Mutex<HashMap<u64, Agent>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT: AtomicU64 = AtomicU64::new(0);

// The agents, held for one step (a registry may hold its own lock meanwhile — never the reverse).
fn agents() -> MutexGuard<'static, HashMap<u64, Agent>> {
    AGENTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// A new agent of session `partition`.
pub(crate) fn new_agent(partition: u64) -> u64 {
    let agent = NEXT.fetch_add(1, Ordering::Relaxed) + 1;
    agents().insert(agent, Agent { partition, notices: Vec::new() });
    agent
}
// Agent `agent`'s session, while it lives.
pub(crate) fn partition(agent: u64) -> Option<u64> {
    agents().get(&agent).map(|a| a.partition)
}
pub(crate) fn live(agent: u64) -> bool {
    agents().contains_key(&agent)
}
// Agent `agent` told a notice, where it lives.
pub(crate) fn tell(agent: u64, kind: u32, args: [f64; 4], later: bool) {
    if let Some(a) = agents().get_mut(&agent) {
        a.notices.push(Notice { kind, args, later });
    }
}
// The notices agent `agent` has, taken.
pub(crate) fn take(agent: u64) -> Vec<Notice> {
    agents().get_mut(&agent).map(|a| std::mem::take(&mut a.notices)).unwrap_or_default()
}
// Agent `agent` gone: every registry told, after it is out of the agents (no lock of theirs taken while that is held).
fn agent_gone(agent: u64) {
    agents().remove(&agent);
    crate::idb_databases::agent_gone(agent);
}

// ── The agents of an isolate ─────────────────────────────────────────────────────────────────────────────────────────
// Each realm's agent, by realm — gone with the realm, or with the isolate.
#[derive(Default)]
struct RealmAgents(HashMap<i32, u64>);
impl Drop for RealmAgents {
    fn drop(&mut self) {
        for agent in self.0.values() {
            agent_gone(*agent);
        }
    }
}
// The agent the calling realm is, where it is one.
pub(crate) fn agent_of(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> Option<u64> {
    let realm = realm_id(scope, args);
    scope.get_slot::<RealmAgents>().and_then(|a| a.0.get(&realm).copied())
}
// The agent realm `realm` was, gone (its context begun anew or disposed).
pub(crate) fn drop_realm(scope: &mut v8::PinScope<'_, '_>, realm: i32) {
    let Some(agent) = scope.get_slot_mut::<RealmAgents>().and_then(|a| a.0.remove(&realm)) else { return };
    agent_gone(agent);
}

// ── For the host ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Whether an agent of a session has notices it has yet to take — some event loop of the session has work (which one,
// each isolate's `agentsPending` says).
pub(crate) fn pending(partition: u64) -> bool {
    agents().values().any(|a| a.partition == partition && !a.notices.is_empty())
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "agentJoin", join, context_id);
    register(scope, ns, "agentTake", take_op, context_id);
    register(scope, ns, "agentsPending", pending_here, context_id);
    register(scope, ns, "agentsDrop", drop_all, context_id);
}

// __dom.agentJoin(partition): this realm an agent of session `partition`'s, where it is not yet one.
fn join(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    if agent_of(scope, &args).is_some() {
        return;
    }
    let partition = args.get(0).integer_value(scope).unwrap_or(0) as u64;
    let realm = realm_id(scope, &args);
    let agent = new_agent(partition);
    if scope.get_slot::<RealmAgents>().is_none() {
        scope.set_slot(RealmAgents::default());
    }
    scope.get_slot_mut::<RealmAgents>().expect("RealmAgents slot was just set").0.insert(realm, agent);
}
// __dom.agentTake() -> [kind, later, a, b, c, d, …]: the notices this realm's agent has, taken (null for none).
fn take_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(agent) = agent_of(scope, &args) else { return rv.set_null() };
    let notices = take(agent);
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
// __dom.agentsPending() -> whether an agent of this isolate — any realm's — has notices to take.
fn pending_here(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let mine: Vec<u64> = scope.get_slot::<RealmAgents>().map(|a| a.0.values().copied().collect()).unwrap_or_default();
    let all = agents();
    rv.set_bool(mine.iter().any(|a| all.get(a).is_some_and(|a| !a.notices.is_empty())));
}
// __dom.agentsDrop(): every agent of this isolate gone — its window closed while the isolate lives on (kept for its
// service workers): what each held let go, as a closed window's is.
fn drop_all(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let gone: Vec<u64> = scope.get_slot_mut::<RealmAgents>().map(|a| a.0.drain().map(|(_, agent)| agent).collect()).unwrap_or_default();
    for agent in gone {
        agent_gone(agent);
    }
}
