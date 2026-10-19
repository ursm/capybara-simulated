// MessagePorts (HTML §9.4): each port's entanglement, its port message queue — the messages it holds till `start()` or
// an `onmessage` enables it, and those whose tasks are queued and have not run — whether it is enabled or detached, and,
// of a port whose peer is in another isolate, the END of the host-relayed channel it is (`<channel>/0` or `/1`). The
// isolate's (its `Dom`), every realm of it: a frame's port may be entangled with the page's, and an end the host routes
// to is found whichever realm asks.
//
// A message is a number here, its place in the queue: what it is — the data and the ports the bindings cloned, and
// whether it could not be read back (a `messageerror`) — is the receiving port's to hold, in its slots, so a message
// that reaches back to its port is a cycle the collector takes as any other. What stays with the bindings
// (message-port.js) is that and what is a call: the realm's task a delivery is, the event, the serializer and the host
// the ends go through.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::dom::{dom, register};

#[derive(Default)]
struct Port {
    object: Option<v8::Weak<v8::Value>>,
    peer: Option<u64>,
    enabled: bool,
    detached: bool,
    // The messages held while the queue is not enabled…
    held: VecDeque<u64>,
    // …and those whose delivery tasks are queued, in order.
    inflight: VecDeque<u64>,
    // A remote port's end; and the end a port transferred to another isolate went as.
    remote_end: Option<String>,
    transferred_as: Option<String>,
}

#[derive(Default)]
pub(crate) struct Ports {
    next: u64,
    next_message: u64,
    of: HashMap<u64, Port>,
    // The ends this isolate holds, and those it gave up (a message on its way to one goes back to the host).
    ends: HashMap<String, u64>,
    given: HashSet<String>,
    // The size at which the next sweep lets go of the ports no object names: twice what the last one left.
    sweep_at: usize,
}

impl Ports {
    fn make(&mut self, object: Option<v8::Weak<v8::Value>>) -> u64 {
        // (…the ports no object names any more let go of as the registry doubles: collected ones)
        if self.of.len() >= self.sweep_at.max(64) {
            let gone: Vec<u64> = self.of.iter().filter(|(_, p)| p.object.as_ref().is_some_and(v8::Weak::is_empty)).map(|(id, _)| *id).collect();
            for id in gone {
                self.forget(id);
            }
            self.sweep_at = self.of.len() * 2;
        }
        self.next += 1;
        self.of.insert(self.next, Port { object, ..Port::default() });
        self.next
    }
    // The isolate's slots go after V8 has disposed it, and a weak handle's drop resets its node, freed memory by then:
    // let go of whole (as the Dom's other weak handles are).
    pub(crate) fn leak_weak_handles(&mut self) {
        std::mem::forget(std::mem::take(&mut self.of));
    }
    fn forget(&mut self, id: u64) {
        let Some(port) = self.of.remove(&id) else { return };
        if let Some(peer) = port.peer.and_then(|p| self.of.get_mut(&p)) {
            peer.peer = None;
        }
        if let Some(end) = port.remote_end {
            self.ends.remove(&end);
        }
    }
    fn port(&mut self, id: u64) -> Option<&mut Port> {
        self.of.get_mut(&id)
    }
    // (…every message it has that its handler has not had, in order — a transfer's to take on)
    fn take_pending(&mut self, id: u64) -> VecDeque<u64> {
        let Some(p) = self.port(id) else { return VecDeque::new() };
        let mut pending = std::mem::take(&mut p.inflight);
        pending.append(&mut p.held);
        pending
    }
    // `close()` disentangles it: detached, its peer left with nowhere to deliver (it stays open); a remote port's end
    // let go of, for the host to close.
    fn close(&mut self, id: u64) -> Option<String> {
        let p = self.port(id)?;
        p.detached = true;
        let peer = p.peer.take();
        let end = p.remote_end.take();
        if let Some(peer) = peer.and_then(|peer| self.of.get_mut(&peer)).filter(|peer| peer.peer == Some(id)) {
            peer.peer = None;
        }
        if let Some(end) = &end {
            self.ends.remove(end);
        }
        end
    }
    // A port transferred within the isolate: `moved` entangled in its place, its peer (or its end) moved onto it, and
    // every message it had not delivered held there, in order — HTML's transfer-receiving steps leave the new port's
    // queue disabled. The source neutered. The end, where it had one, which `moved` now holds.
    fn transfer(&mut self, id: u64, moved: u64) -> Option<String> {
        let pending = self.take_pending(id);
        let p = self.port(id)?;
        let peer = p.peer.take();
        let end = p.remote_end.take();
        p.detached = true;
        if let Some(peer) = peer.and_then(|peer| self.of.get_mut(&peer)) {
            peer.peer = Some(moved);
        }
        if let Some(end) = &end {
            self.ends.insert(end.clone(), moved);
            self.given.remove(end);
        }
        let m = self.port(moved)?;
        m.peer = peer;
        m.remote_end = end.clone();
        m.held = pending;
        end
    }
    fn entangle(&mut self, a: u64, b: u64) {
        if let Some(p) = self.port(a) {
            p.peer = Some(b);
        }
        if let Some(p) = self.port(b) {
            p.peer = Some(a);
        }
    }
    // A message arriving at the port: its number, and whether its delivery is a task to queue now — held where its
    // queue is not enabled.
    fn accept(&mut self, id: u64) -> (u64, bool) {
        self.next_message += 1;
        let message = self.next_message;
        let Some(p) = self.port(id) else { return (message, false) };
        if p.enabled {
            p.inflight.push_back(message);
        } else {
            p.held.push_back(message);
        }
        (message, p.enabled)
    }
    // `start()` — and an `onmessage` set — enabling its queue, what it held now on its way, in order; once. How many
    // delivery tasks that makes.
    fn enable(&mut self, id: u64) -> usize {
        let Some(p) = self.port(id).filter(|p| !p.enabled) else { return 0 };
        p.enabled = true;
        let held = std::mem::take(&mut p.held);
        let n = held.len();
        p.inflight.extend(held);
        n
    }
    // A transfer to another isolate (`portToEnd`), the port neutered.
    fn to_end(&mut self, id: u64, channel: &str, lone: u64) -> Option<Went> {
        let p = self.port(id)?;
        if let Some(end) = &p.transferred_as {
            return Some(Went::Already(end.clone()));
        }
        let remote = p.remote_end.take();
        let pending = self.take_pending(id);
        let went = match remote {
            Some(end) => {
                self.ends.remove(&end);
                self.given.insert(end.clone());
                Went::Remote(end, pending)
            }
            None => {
                let kept = self.port(id).and_then(|p| p.peer).unwrap_or(lone);
                let kept_end = format!("{channel}/0");
                if let Some(k) = self.port(kept) {
                    k.peer = None;
                    k.remote_end = Some(kept_end.clone());
                }
                self.ends.insert(kept_end.clone(), kept);
                Went::Kept(format!("{channel}/1"), pending, kept, kept_end)
            }
        };
        let p = self.port(id)?;
        p.transferred_as = Some(match &went {
            Went::Already(end) | Went::Remote(end, _) | Went::Kept(end, ..) => end.clone(),
        });
        p.peer = None;
        p.detached = true;
        Some(went)
    }
    // A new port taking `end`, transferred to this isolate.
    fn at_end(&mut self, id: u64, end: String) {
        if let Some(p) = self.port(id) {
            p.remote_end = Some(end.clone());
        }
        self.given.remove(&end);
        self.ends.insert(end, id);
    }
}

// How a port went to another isolate: as the end it went as already; as a remote one's end, with the messages it had
// not delivered; or as end 1 of a new channel whose end 0 the port it was entangled with keeps.
enum Went {
    Already(String),
    Remote(String, VecDeque<u64>),
    Kept(String, VecDeque<u64>, u64, String),
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "portNew", new_op, context_id);
    register(scope, ns, "portEntangle", entangle_op, context_id);
    register(scope, ns, "portPeer", peer_op, context_id);
    register(scope, ns, "portDetached", detached_op, context_id);
    register(scope, ns, "portRemoteEnd", remote_end_op, context_id);
    register(scope, ns, "portAccept", accept_op, context_id);
    register(scope, ns, "portNext", next_op, context_id);
    register(scope, ns, "portEnable", enable_op, context_id);
    register(scope, ns, "portClose", close_op, context_id);
    register(scope, ns, "portTransfer", transfer_op, context_id);
    register(scope, ns, "portToEnd", to_end_op, context_id);
    register(scope, ns, "portAtEnd", at_end_op, context_id);
    register(scope, ns, "portOfEnd", of_end_op, context_id);
}

fn id_arg(scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>) -> u64 {
    v.number_value(scope).map_or(0, |n| n as u64)
}
fn end_arg(scope: &mut v8::PinScope<'_, '_>, v: v8::Local<'_, v8::Value>) -> String {
    v.to_rust_string_lossy(scope)
}
fn string<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::null(scope).into(), Into::into)
}
fn end_value<'s>(scope: &mut v8::PinScope<'s, '_>, end: Option<String>) -> v8::Local<'s, v8::Value> {
    match end {
        Some(end) => string(scope, &end),
        None => v8::null(scope).into(),
    }
}
fn object_of<'s>(scope: &mut v8::PinScope<'s, '_>, id: Option<u64>) -> v8::Local<'s, v8::Value> {
    // (…the registry out of the Dom while the weak handle is read, which needs the scope: a cloned one would be a
    // handle made and freed for the read)
    let ports = std::mem::take(&mut dom(scope).message_ports);
    let object = id.and_then(|id| ports.of.get(&id)?.object.as_ref()?.to_local(scope));
    dom(scope).message_ports = ports;
    object.unwrap_or_else(|| v8::null(scope).into())
}
// The numbers of `list`, in order.
fn messages_value<'s>(scope: &mut v8::PinScope<'s, '_>, list: &VecDeque<u64>) -> v8::Local<'s, v8::Value> {
    let values: Vec<f64> = list.iter().map(|&m| m as f64).collect();
    crate::dom::f64_array(scope, &values).into()
}

// __dom.portNew(port) -> the number of `port`, a new one entangled with none, disabled.
fn new_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let weak = v8::Weak::new(scope, args.get(0));
    rv.set_double(dom(scope).message_ports.make(Some(weak)) as f64);
}
// __dom.portEntangle(a, b): two new ports entangled — a MessageChannel's.
fn entangle_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (a, b) = (id_arg(scope, args.get(0)), id_arg(scope, args.get(1)));
    dom(scope).message_ports.entangle(a, b);
}
// __dom.portPeer(id) -> the port it is entangled with in this isolate, or null.
fn peer_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    let peer = dom(scope).message_ports.of.get(&id).and_then(|p| p.peer);
    rv.set(object_of(scope, peer));
}
// __dom.portDetached(id) -> whether it is closed or transferred.
fn detached_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    rv.set_bool(dom(scope).message_ports.of.get(&id).is_some_and(|p| p.detached));
}
// __dom.portRemoteEnd(id) -> the end a remote port is, or null for a port of this isolate.
fn remote_end_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    let end = dom(scope).message_ports.of.get(&id).and_then(|p| p.remote_end.clone());
    rv.set(end_value(scope, end));
}
// __dom.portAccept(id) -> the number of a message arriving at the port: positive where its delivery is a task to
// queue now, negative where it is held, its queue not enabled.
fn accept_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    let (message, now) = dom(scope).message_ports.accept(id);
    rv.set_double(if now { message as f64 } else { -(message as f64) });
}
// __dom.portNext(id) -> the number of the message a delivery task queued for the port runs with — or -1 where a
// transfer took it on with the port, or the port is detached since.
fn next_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    let message = dom(scope).message_ports.port(id).and_then(|p| p.inflight.pop_front().filter(|_| !p.detached));
    rv.set_double(message.map_or(-1.0, |m| m as f64));
}
// __dom.portEnable(id) -> how many delivery tasks to queue: `start()` — and an `onmessage` set — enabling its queue.
fn enable_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    rv.set_double(dom(scope).message_ports.enable(id) as f64);
}
// __dom.portClose(id) -> the end a remote port let go of, for the host to close, or null.
fn close_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    let end = dom(scope).message_ports.close(id);
    rv.set(end_value(scope, end));
}
// __dom.portTransfer(id, moved) -> the end `moved` takes in its place, or null: the port transferred within the isolate.
fn transfer_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (id, moved) = (id_arg(scope, args.get(0)), id_arg(scope, args.get(1)));
    let end = dom(scope).message_ports.transfer(id, moved);
    rv.set(end_value(scope, end));
}
// __dom.portToEnd(id, channel, lone) -> how the port goes to another isolate, neutered:
// - [end] where it went already: a message names it twice (its data and its transfer list);
// - [end, messages] for a remote one, which gives its end up — the numbers of the messages it had received and not
//   delivered, for the end's next holder;
// - [end, messages, kept, keptEnd] for one of this isolate, its entanglement made a channel: `channel`'s end 1 the one it
//   goes as, end 0 taken by the port it was entangled with — or by `lone` (a new port) where it was none's — which posts
//   what it held on to it, first.
fn to_end_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    let channel = end_arg(scope, args.get(1));
    let lone = id_arg(scope, args.get(2));
    let value: Vec<v8::Local<v8::Value>> = match dom(scope).message_ports.to_end(id, &channel, lone) {
        None => return rv.set_null(),
        Some(Went::Already(end)) => vec![string(scope, &end)],
        Some(Went::Remote(end, pending)) => vec![string(scope, &end), messages_value(scope, &pending)],
        Some(Went::Kept(end, pending, kept, kept_end)) => {
            let (end, pending, kept, kept_end) = (string(scope, &end), messages_value(scope, &pending), object_of(scope, Some(kept)), string(scope, &kept_end));
            vec![end, pending, kept, kept_end]
        }
    };
    rv.set(v8::Array::new_with_elements(scope, &value).into());
}
// __dom.portAtEnd(id, end): the new port takes `end`, transferred to this isolate.
fn at_end_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = id_arg(scope, args.get(0));
    let end = end_arg(scope, args.get(1));
    dom(scope).message_ports.at_end(id, end);
}
// __dom.portOfEnd(end) -> the port of this isolate holding `end`; else `true` where this isolate gave it up (a message
// on its way to it goes back to the host), `false` where it never held it.
fn of_end_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let end = end_arg(scope, args.get(0));
    let ports = &dom(scope).message_ports;
    let (held, given) = (ports.ends.get(&end).copied(), ports.given.contains(&end));
    match held {
        Some(id) => rv.set(object_of(scope, Some(id))),
        None => rv.set_bool(given),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_an_entanglement_and_an_end_onto_the_port_a_transfer_makes() {
        let mut p = Ports::default();
        let (a, b, moved) = (p.make(None), p.make(None), p.make(None));
        p.of.get_mut(&a).unwrap().peer = Some(b);
        p.of.get_mut(&b).unwrap().peer = Some(a);
        assert_eq!(p.transfer(a, moved), None);
        assert!(p.of[&a].detached && p.of[&a].peer.is_none());
        assert_eq!((p.of[&moved].peer, p.of[&b].peer), (Some(b), Some(moved)));
        // (…a remote one's end goes with it, no longer one this isolate gave up)
        let (r, r2) = (p.make(None), p.make(None));
        p.of.get_mut(&r).unwrap().remote_end = Some("c/0".into());
        p.ends.insert("c/0".into(), r);
        p.given.insert("c/0".into());
        assert_eq!(p.transfer(r, r2).as_deref(), Some("c/0"));
        assert_eq!((p.ends["c/0"], p.given.contains("c/0")), (r2, false));
    }

    #[test]
    fn closes_a_port_leaving_its_peer_open_and_its_end_let_go_of() {
        let mut p = Ports::default();
        let (a, b) = (p.make(None), p.make(None));
        p.of.get_mut(&a).unwrap().peer = Some(b);
        p.of.get_mut(&b).unwrap().peer = Some(a);
        p.of.get_mut(&a).unwrap().remote_end = Some("c/1".into());
        p.ends.insert("c/1".into(), a);
        assert_eq!(p.close(a).as_deref(), Some("c/1"));
        assert!(p.of[&a].detached && !p.of[&b].detached && p.of[&b].peer.is_none());
        assert!(!p.ends.contains_key("c/1"));
    }
}
