// Web Locks' lock managers (Web Locks §3), one registry for the process: a manager for each storage bucket — a driver
// session's partition and a storage key (an origin's) — with its held lock set and its lock request queue map, so every
// realm and worker of an origin contends for the same locks, as the tabs of one app do.
//
// Who asks is an AGENT (agents.rs), and what a manager owes one — a request of its granted, a lock of its stolen — is a
// notice of its (kinds 16-17 below), a task of its own: the bindings (locks.js) keep each request's callback and
// promises, invoke the callback with its Lock and tell the manager as the promise it returned settles (`locksRelease`).
// An agent gone lets go of its locks and its requests with it (`agent_gone`) — a closed tab's lock is free again.

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex, MutexGuard};

use crate::agents::{agent_of, tell};
use crate::dom::register;
use crate::idb::{name_arg, name_value};

type Name = Vec<u16>;

// A request granted: [request]. Its lock is the request's number too.
const GRANTED: u32 = 16;
// A lock stolen from its holder (`steal`): [lock].
const STOLEN: u32 = 17;

// What names a manager: the session's partition and the storage key.
#[derive(Clone, PartialEq, Eq, Hash)]
struct Bucket {
    partition: u64,
    storage: String,
}

// A lock request, and the lock it becomes: its number, its agent and the client it was made in, its name and mode.
#[derive(Clone)]
struct Request {
    id: u32,
    agent: u64,
    client: String,
    name: Name,
    exclusive: bool,
}

// A lock manager: its held lock set and its lock request queue map, each in the order its entries were made (`query`
// reports them so).
#[derive(Default)]
struct Manager {
    held: Vec<Request>,
    queues: Vec<(Name, VecDeque<Request>)>,
}

impl Manager {
    fn queue(&mut self, name: &[u16]) -> &mut VecDeque<Request> {
        let at = match self.queues.iter().position(|(n, _)| n == name) {
            Some(at) => at,
            None => {
                self.queues.push((name.to_vec(), VecDeque::new()));
                self.queues.len() - 1
            }
        };
        &mut self.queues[at].1
    }
    // §3.4 "grantable": first in its queue, and no lock of its name held that excludes it.
    fn grantable(&self, request: &Request) -> bool {
        let first = self.queues.iter().find(|(n, _)| *n == request.name).and_then(|(_, q)| q.front());
        if first.is_some_and(|f| f.id != request.id) {
            return false;
        }
        !self.held.iter().any(|h| h.name == request.name && (request.exclusive || h.exclusive))
    }
    // §3.6 "process the lock request queue" of `name`: each request first in it that is grantable granted, in turn — its
    // agent told.
    fn process(&mut self, name: &[u16]) {
        while let Some(first) = self.queues.iter().find(|(n, _)| n == name).and_then(|(_, q)| q.front()).cloned() {
            if !self.grantable(&first) {
                break;
            }
            self.queue(name).pop_front();
            tell(first.agent, GRANTED, [f64::from(first.id), 0.0, 0.0, 0.0], true);
            self.held.push(first);
        }
        self.queues.retain(|(_, q)| !q.is_empty());
    }
}

#[derive(Default)]
struct Registry {
    next: u32,
    managers: HashMap<Bucket, Manager>,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

fn lock() -> MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// What a request asks beyond its mode.
#[derive(Clone, Copy, PartialEq)]
enum Ask {
    Queued,
    IfAvailable,
    Steal,
}

impl Registry {
    // §3.5 "request a lock" — its steps in parallel, run at once: the request's number, or none where it asked only
    // if available and was not (the bindings then call back with null).
    fn request(&mut self, bucket: Bucket, mut request: Request, ask: Ask) -> Option<u32> {
        self.next = self.next.wrapping_add(1);
        request.id = self.next;
        let id = request.id;
        let name = request.name.clone();
        let manager = self.managers.entry(bucket).or_default();
        match ask {
            Ask::Steal => {
                // (…every lock of its name let go, its holder told, and the request first in its queue)
                for stolen in manager.held.iter().filter(|h| h.name == name) {
                    tell(stolen.agent, STOLEN, [f64::from(stolen.id), 0.0, 0.0, 0.0], true);
                }
                manager.held.retain(|h| h.name != name);
                manager.queue(&name).push_front(request);
            }
            Ask::IfAvailable if !manager.grantable(&request) => return None,
            _ => manager.queue(&name).push_back(request),
        }
        manager.process(&name);
        Some(id)
    }
    // §3.7 "release a lock": the held lock `id` of agent `agent` let go, and its queue processed. False where it is held
    // no more (stolen).
    fn release(&mut self, agent: u64, id: u32) -> bool {
        for manager in self.managers.values_mut() {
            if let Some(at) = manager.held.iter().position(|h| h.id == id && h.agent == agent) {
                let name = manager.held.remove(at).name;
                manager.process(&name);
                return true;
            }
        }
        false
    }
    // §3.8 "abort the request": the queued request `id` out of its queue, which is processed — false where it is queued
    // no more (granted, or never queued).
    fn abort(&mut self, agent: u64, id: u32) -> bool {
        for manager in self.managers.values_mut() {
            let Some(name) = manager.queues.iter().find(|(_, q)| q.iter().any(|r| r.id == id && r.agent == agent)).map(|(n, _)| n.clone()) else {
                continue;
            };
            manager.queue(&name).retain(|r| r.id != id);
            manager.process(&name);
            return true;
        }
        false
    }
    // Agent `agent` gone: its requests out of their queues and its locks let go, each queue they were in processed.
    fn drop_agent(&mut self, agent: u64) {
        for manager in self.managers.values_mut() {
            let mut names: Vec<Name> = manager.held.iter().filter(|h| h.agent == agent).map(|h| h.name.clone()).collect();
            names.extend(manager.queues.iter().filter(|(_, q)| q.iter().any(|r| r.agent == agent)).map(|(n, _)| n.clone()));
            if names.is_empty() {
                continue;
            }
            manager.held.retain(|h| h.agent != agent);
            for (_, queue) in &mut manager.queues {
                queue.retain(|r| r.agent != agent);
            }
            for name in names {
                manager.process(&name);
            }
        }
        self.managers.retain(|_, m| !m.held.is_empty() || !m.queues.is_empty());
    }
    fn clear(&mut self, partition: u64) {
        self.managers.retain(|b, _| b.partition != partition);
    }
}

// Agent `agent` gone (agents.rs).
pub(crate) fn agent_gone(agent: u64) {
    lock().drop_agent(agent);
}
// A session's lock managers gone with it.
pub(crate) fn clear(partition: u64) {
    lock().clear(partition);
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "locksRequest", request_op, context_id);
    register(scope, ns, "locksRelease", release_op, context_id);
    register(scope, ns, "locksAbort", abort_op, context_id);
    register(scope, ns, "locksQuery", query_op, context_id);
}

fn bucket(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, agent: u64) -> Option<Bucket> {
    let storage = args.get(0).to_rust_string_lossy(scope);
    Some(Bucket { partition: crate::agents::partition(agent)?, storage })
}

// __dom.locksRequest(storageKey, name, exclusive, ask, clientId) -> the request's number, or null where it asked only
// if available (ask 1) and was not, or where this realm is no agent. Ask 2 steals.
fn request_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(agent) = agent_of(scope, &args) else { return rv.set_null() };
    let Some(bucket) = bucket(scope, &args, agent) else { return rv.set_null() };
    let Some(name) = name_arg(scope, args.get(1)) else { return rv.set_null() };
    let exclusive = args.get(2).boolean_value(scope);
    let ask = match args.get(3).uint32_value(scope).unwrap_or(0) {
        1 => Ask::IfAvailable,
        2 => Ask::Steal,
        _ => Ask::Queued,
    };
    let client = args.get(4).to_rust_string_lossy(scope);
    let request = Request { id: 0, agent, client, name, exclusive };
    match lock().request(bucket, request, ask) {
        Some(id) => rv.set_uint32(id),
        None => rv.set_null(),
    }
}
// __dom.locksRelease(lock) -> whether this realm's lock was held, and is let go now.
fn release_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(agent) = agent_of(scope, &args) else { return rv.set_bool(false) };
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    rv.set_bool(lock().release(agent, id));
}
// __dom.locksAbort(request) -> whether this realm's request was still queued, and is out of its queue now.
fn abort_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(agent) = agent_of(scope, &args) else { return rv.set_bool(false) };
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    rv.set_bool(lock().abort(agent, id));
}
// __dom.locksQuery(storageKey) -> [held count, name, exclusive, clientId, …]: the manager's held locks, then its queued
// requests, each in order (§3.9 "snapshot the lock state").
fn query_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(agent) = agent_of(scope, &args) else { return rv.set_null() };
    let Some(bucket) = bucket(scope, &args, agent) else { return rv.set_null() };
    let (held, pending): (Vec<Request>, Vec<Request>) = {
        let reg = lock();
        reg.managers.get(&bucket).map_or_else(Default::default, |m| {
            (m.held.clone(), m.queues.iter().flat_map(|(_, q)| q.iter().cloned()).collect())
        })
    };
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(1 + (held.len() + pending.len()) * 3);
    items.push(v8::Integer::new_from_unsigned(scope, held.len() as u32).into());
    for r in held.iter().chain(&pending) {
        items.push(name_value(scope, &r.name));
        items.push(v8::Boolean::new(scope, r.exclusive).into());
        items.push(v8::String::new(scope, &r.client).map_or_else(|| v8::undefined(scope).into(), Into::into));
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(s: &str) -> Name {
        s.encode_utf16().collect()
    }
    fn bucket() -> Bucket {
        Bucket { partition: 1, storage: "o".into() }
    }
    fn ask(reg: &mut Registry, agent: u64, n: &str, exclusive: bool, how: Ask) -> Option<u32> {
        reg.request(bucket(), Request { id: 0, agent, client: String::new(), name: name(n), exclusive }, how)
    }
    fn granted(agent: u64) -> Vec<u32> {
        crate::agents::take(agent).into_iter().filter(|n| n.kind == GRANTED).map(|n| n.args[0] as u32).collect()
    }

    // An exclusive lock waits for the one held, shared ones are granted together, and a release grants the next.
    #[test]
    fn exclusive_waits_and_shared_share() {
        let mut reg = Registry::default();
        let (a, b) = (crate::agents::new_agent(1, 0), crate::agents::new_agent(1, 0));
        let first = ask(&mut reg, a, "x", true, Ask::Queued).unwrap();
        let second = ask(&mut reg, b, "x", true, Ask::Queued).unwrap();
        assert_eq!(granted(a), vec![first]);
        assert!(granted(b).is_empty());
        assert!(reg.release(a, first));
        assert_eq!(granted(b), vec![second]);
        let s1 = ask(&mut reg, a, "y", false, Ask::Queued).unwrap();
        let s2 = ask(&mut reg, b, "y", false, Ask::Queued).unwrap();
        assert_eq!((granted(a), granted(b)), (vec![s1], vec![s2]));
    }

    // ifAvailable is refused while the lock is held; a steal takes it, its holder told; a gone agent's locks are free.
    #[test]
    fn if_available_steal_and_a_gone_agent() {
        let mut reg = Registry::default();
        let (a, b) = (crate::agents::new_agent(1, 0), crate::agents::new_agent(1, 0));
        let held = ask(&mut reg, a, "x", true, Ask::Queued).unwrap();
        crate::agents::take(a);
        assert_eq!(ask(&mut reg, b, "x", true, Ask::IfAvailable), None);
        let thief = ask(&mut reg, b, "x", true, Ask::Steal).unwrap();
        let told: Vec<(u32, u32)> = crate::agents::take(a).into_iter().map(|n| (n.kind, n.args[0] as u32)).collect();
        assert_eq!(told, vec![(STOLEN, held)]);
        assert!(!reg.release(a, held));
        assert_eq!(granted(b), vec![thief]);
        let waiting = ask(&mut reg, a, "x", true, Ask::Queued).unwrap();
        reg.drop_agent(b);
        assert_eq!(granted(a), vec![waiting]);
    }
}
