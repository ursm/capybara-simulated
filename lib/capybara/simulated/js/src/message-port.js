// MessageChannel and MessagePort (HTML §9.4), generated from their IDL — channel messaging. Two entangled ports; a
// message posted on one is a task on the other's port message queue, which holds what arrives until `start()` or an
// `onmessage` enables it. A port is made by the platform alone (a channel's, a transfer's); what it is entangled with,
// what its queue holds and whether it is enabled or detached are its internal slots'. Its `postMessage` serializes the
// message (platform-globals.js, beside the structured clone); this is the entanglement it travels over.
//
// A port belongs to the realm that made it: its messages are tasks of that realm's event loop (a detached iframe's ports
// stop delivering with it) and MessageEvents of that realm — `realm` in its slots, whichever realm posts to it.
//
// A port whose peer is in ANOTHER isolate (a worker's, a service worker's, or a frame's port that went on to one) is a
// remote one: it is an END of a channel the host relays — `<channel>/0` or `<channel>/1` (`remoteEnd`) — and a message
// posted at it goes serialized through the host to whatever holds the other end, a realm of the window or a worker. An
// isolate says so as it takes an end (`endHere`), as it gives one up to another (`endGone`), handing the host the
// messages that end had received and not delivered, for its next holder — and hands back any that reach it after
// (`redeliver`) — and as a port closes its end (`endClosed`).

import { EventTarget, createMessageEvent, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { installMessageChannel, installMessagePort } from './generated/bindings.js';
import { followWindowClock } from './timers.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';

// (…this realm's, which its ports hold: its event loop, its events, the channel ends it holds, and its plumbing to the
// host — looked up as it is called, which a worker's scope replaces once installed)
const REALM = {
  queueTask: (task) => globalThis.__csimSetTimeout(task, 0),
  messageEvent: (data, ports, failed) => createMessageEvent(failed ? 'messageerror' : 'message', { data, ports, origin: '', lastEventId: '', source: null }),
  ends: new Map(),
  given: new Set(),
  endHere: (end) => globalThis.__csimPortEndHere(end),
  endGone: (end, held) => globalThis.__csimPortEndGone(end, held),
  endClosed: (end) => globalThis.__csimPortEndClosed(end),
  redeliver: (end, dataStr) => globalThis.__csimPortRedeliver(end, dataStr),
  post: (end, message, transfer) => REALM.postEncoded(end, globalThis.__csimEncodeMessage(message, transfer)),
  postEncoded: (end, dataStr) => globalThis.__csimPortRemotePost(end, dataStr)
};

export class MessagePort extends EventTarget {
  constructor(token) {
    constructedBy(PLATFORM, token, 'MessagePort');
    super();
    makeSlots(this, 'MessagePort', {
      peer: null, enabled: false, queue: [], detached: false, realm: REALM,
      // (…the messages whose tasks are queued and have not run — which a transfer moves with the port, ahead of what its
      // queue holds: HTML moves the port message queue with it)
      inflight: [],
      // (…a remote port's end, and the end a port transferred to another isolate went as, which a second reference to
      // it in the same message reuses)
      remoteEnd: null, transferredAs: null
    });
  }
}
const portOf = (o) => slotsOf(o, 'MessagePort');
// Whether `o` is a MessagePort, of any realm.
export const isMessagePort = (o) => portOf(o) !== undefined;
registerInterface('MessagePort', isMessagePort);

export const newMessagePort = () => new MessagePort(PLATFORM);
// Two new ports, entangled — a MessageChannel's, or a SharedWorker's outside port and the inside one its worker's
// `connect` carries.
export function newEntangledPorts() {
  const port1 = newMessagePort(), port2 = newMessagePort();
  portOf(port1).peer = port2;
  portOf(port2).peer = port1;
  return [port1, port2];
}
export const portDetached = (port) => portOf(port).detached;
export const peerOf = (port) => portOf(port).peer;
// A remote port's post: through the host from its end, in its realm.
export function postRemote(port, message, transfer) {
  const s = portOf(port);
  if (!s.remoteEnd) return false;
  s.realm.post(s.remoteEnd, message, transfer);
  return true;
}

// A message arriving at `port`: a task on its queue where the queue is enabled, held till it is where not.
// (…`failed`: one that could not be read back here, its event a `messageerror`)
export function acceptMessage(port, data, ports, failed = false) {
  const s = portOf(port);
  if (s.enabled) deliver(port, s, data, ports, failed);
  else s.queue.push({ data, ports, failed });
}
function deliver(port, s, data, ports, failed) {
  const msg = { data, ports, failed };
  s.inflight.push(msg);
  s.realm.queueTask(() => {
    // (…unless a transfer took it on with the port)
    const i = s.inflight[0] === msg ? 0 : s.inflight.indexOf(msg);
    if (i < 0) return;
    s.inflight.splice(i, 1);
    if (!s.detached) dispatchWithOnHandler(port, s.realm.messageEvent(data, ports, failed));
  });
}
// (…every message it has that its handler has not had, in order — a transfer's to take on)
function takePending(s) {
  const pending = s.inflight.concat(s.queue);
  s.inflight = [];
  s.queue = [];
  return pending;
}
// `start()` — and an `onmessage` set: its queue enabled, what it held delivered in order. Once.
export function enablePort(port) {
  const s = portOf(port);
  if (s.enabled) return;
  s.enabled = true;
  const held = s.queue;
  s.queue = [];
  for (const m of held) deliver(port, s, m.data, m.ports, m.failed);
}
// `close()` disentangles it: detached (a closed port is no transferable), its peer — a port of the isolate, or the far
// end of its channel — left with nowhere to deliver. The peer itself stays open.
export function closePort(port) {
  const s = portOf(port);
  s.detached = true;
  const peer = s.peer;
  s.peer = null;
  if (peer && portOf(peer).peer === port) portOf(peer).peer = null;
  if (s.remoteEnd) {
    s.realm.ends.delete(s.remoteEnd);
    s.realm.endClosed(s.remoteEnd);
    s.remoteEnd = null;
  }
}
// A port transferred within the isolate — to a message's receiver, to another realm: a fresh port of THIS realm
// entangled in its place, its peer (or its channel end, which this realm takes) moved onto it, and every message it had
// not delivered — queued as tasks or held — held there, in order, ahead of any posted after: HTML's transfer-receiving
// steps move the tasks into the new port's queue "leaving [it] in its initial disabled state", for the receiver's
// `onmessage` or `start()` to enable. The source neutered.
export function movePort(port) {
  const s = portOf(port), moved = newMessagePort(), m = portOf(moved);
  m.peer = s.peer;
  if (s.peer) portOf(s.peer).peer = moved;
  if (s.remoteEnd) {
    m.remoteEnd = s.remoteEnd;
    s.realm.ends.delete(s.remoteEnd);
    REALM.ends.set(m.remoteEnd, moved);
    REALM.given.delete(m.remoteEnd);
    REALM.endHere(m.remoteEnd);
    s.remoteEnd = null;
  }
  s.peer = null;
  s.detached = true;
  m.queue = takePending(s);
  return moved;
}

// ── Remote ports ──
// Transfer `port` to another isolate: the end the message carries for it (the same again for the same port, which a
// message can reference in its data and its transfer list both), `port` neutered. A remote port gives its end up to
// the receiver, with the messages it had received and not delivered; a port of this isolate makes a channel of its
// entanglement, its kept peer taking the other end here and posting what `port` held on to it, first. Called by the
// message serializer (workers.js).
globalThis.__csimPortToEnd = function (port) {
  const s = portOf(port);
  if (s.transferredAs) return s.transferredAs;
  const pending = takePending(s);
  let end;
  if (s.remoteEnd) {
    end = s.remoteEnd;
    s.realm.ends.delete(end);
    s.realm.given.add(end);
    s.realm.endGone(end, pending.map((msg) => globalThis.__csimReencodeMessage(msg)));
    s.remoteEnd = null;
  } else {
    const channel = String(globalThis.__csimAllocPortChannel());
    const kept = s.peer || newMessagePort(), k = portOf(kept);   // a lone port still gets a routable (if idle) end
    end = channel + '/1';
    k.peer = null;
    k.remoteEnd = channel + '/0';
    k.realm.ends.set(k.remoteEnd, kept);
    k.realm.endHere(k.remoteEnd);
    // (…what can no longer cross — one that failed already, one holding what crosses no isolate — read back as failed)
    for (const msg of pending) k.realm.postEncoded(k.remoteEnd, globalThis.__csimReencodeMessage(msg));
  }
  s.transferredAs = end;
  s.peer = null;
  s.detached = true;
  return end;
};
// …and THIS isolate's port at an end transferred TO it — one port however often the message names the end.
globalThis.__csimEndToPort = function (end) {
  end = String(end);
  let port = REALM.ends.get(end);
  if (!port) {
    port = newMessagePort();
    portOf(port).remoteEnd = end;
    REALM.ends.set(end, port);
    REALM.given.delete(end);
    REALM.endHere(end);
  }
  return port;
};
// A message the host routed to an end this realm holds: the serialized message (its data and the ports it
// transferred), decoded, accepted. One for an end this realm has given up since the host sent it — it was on its way —
// goes back, for the end's holder now.
globalThis.__csimPortEndDeliver = function (end, dataStr) {
  end = String(end);
  const port = REALM.ends.get(end);
  if (!port) {
    if (REALM.given.has(end)) REALM.redeliver(end, dataStr);
    return;
  }
  const m = globalThis.__csimDecodeMessage(dataStr);
  acceptMessage(port, m.data, m.ports, m.failed);
};

// A window or frame realm's half of the plumbing: a channel id unique in the isolate (`pc-r<realm>-<n>`), and the
// post, the taking and the giving up of an end made to the host directly. A worker's scope has its own (workers.js),
// its thread's outbox in place of the host.
let channelSeq = 0;
globalThis.__csimAllocPortChannel = function () {
  return 'pc-r' + globalThis.__csimRealmId() + '-' + (++channelSeq);
};
globalThis.__csimPortRemotePost = function (end, dataStr) {
  followWindowClock();
  globalThis.__csimClientPortPost(end, dataStr);
};
globalThis.__csimPortEndHere = function (end) {
  followWindowClock();
  globalThis.__csimClientPortEndHere(end, globalThis.__csimRealmId());
};
globalThis.__csimPortEndGone = function (end, held) {
  globalThis.__csimClientPortEndGone(end, held, globalThis.__csimRealmId());
};
globalThis.__csimPortEndClosed = function (end) {
  globalThis.__csimClientPortEndClosed(end);
};
globalThis.__csimPortRedeliver = function (end, dataStr) {
  globalThis.__csimClientPortRedeliver(end, dataStr);
};

// Its members — `postMessage` the caller's (`post`) — and its event handlers, of which setting `onmessage` to a handler
// enables its queue as `start()` does (HTML §9.4.4); `addEventListener('message')` does not.
export function installPorts(post) {
  installMessagePort(MessagePort, {
    postMessage_message_transfer: (port, message, transfer) => post(port, message, transfer),
    postMessage_message_options: (port, message, options) => post(port, message, options.transfer),
    start: (port) => enablePort(port),
    close: (port) => closePort(port),
    installEventHandlers(proto, names, isSelf) {
      installEventHandlerAttrs(proto, names, null, isSelf);
      const handler = Object.getOwnPropertyDescriptor(proto, 'onmessage');
      const { set } = Object.getOwnPropertyDescriptor({
        set onmessage(v) {
          handler.set.call(this, v);
          if (v !== null && (typeof v === 'object' || typeof v === 'function')) enablePort(this);
        }
      }, 'onmessage');
      Object.defineProperty(proto, 'onmessage', { ...handler, set });
    }
  });
  globalThis.MessagePort = MessagePort;
}

// A MessageChannel: its two ports, entangled — React's scheduler and idle-callback polyfills post on one to be called
// back from the other, a task rather than a timer.
export class MessageChannel {
  constructor() {
    const [port1, port2] = newEntangledPorts();
    makeSlots(this, 'MessageChannel', { port1, port2 });
  }
}
const channelOf = (o) => slotsOf(o, 'MessageChannel');
registerInterface('MessageChannel', (o) => channelOf(o) !== undefined);
installMessageChannel(MessageChannel, {
  get_port1: (channel) => channelOf(channel).port1,
  get_port2: (channel) => channelOf(channel).port2
});
globalThis.MessageChannel = MessageChannel;
