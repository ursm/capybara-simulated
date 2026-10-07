// MessageChannel and MessagePort (HTML §9.4), generated from their IDL — channel messaging. Two entangled ports; a
// message posted on one is a task on the other's port message queue, which holds what arrives until `start()` or an
// `onmessage` enables it. A port is made by the platform alone (a channel's, a transfer's); what it is entangled with,
// what its queue holds and whether it is enabled or detached are its internal slots'. Its `postMessage` serializes the
// message (platform-globals.js, beside the structured clone); this is the entanglement it travels over.
//
// A port belongs to the realm that made it: its messages are tasks of that realm's event loop (a detached iframe's ports
// stop delivering with it) and MessageEvents of that realm — `realm` in its slots, whichever realm posts to it. A port
// whose peer is in ANOTHER isolate (a worker's, a service worker's) is a remote one: its messages travel serialized
// through the host by a channel id (`remoteChannel`), each isolate holding one endpoint under it.

import { EventTarget, createMessageEvent, dispatchWithOnHandler, installEventHandlerAttrs } from './events.js';
import { installMessageChannel, installMessagePort } from './generated/bindings.js';
import { followWindowClock } from './timers.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';

// (…this realm's, which its ports hold)
const REALM = {
  queueTask: (task) => globalThis.__csimSetTimeout(task, 0),
  messageEvent: (data, ports) => createMessageEvent('message', { data, ports, origin: '', lastEventId: '', source: null })
};

export class MessagePort extends EventTarget {
  constructor(token) {
    constructedBy(PLATFORM, token, 'MessagePort');
    super();
    makeSlots(this, 'MessagePort', {
      peer: null, enabled: false, queue: [], detached: false, realm: REALM,
      // (…a remote port's channel, and the channel a transferred-away port went as, which a second reference to it in
      // the same message reuses)
      remoteChannel: null, transferChannel: null
    });
  }
}
const portOf = (o) => slotsOf(o, 'MessagePort');
// Whether `o` is a MessagePort, of any realm.
export const isMessagePort = (o) => portOf(o) !== undefined;
registerInterface('MessagePort', isMessagePort);

export const newMessagePort = () => new MessagePort(PLATFORM);
export const portDetached = (port) => portOf(port).detached;
export const peerOf = (port) => portOf(port).peer;
export const remoteChannelOf = (port) => portOf(port).remoteChannel;

// A message arriving at `port`: a task on its queue where the queue is enabled, held till it is where not.
export function acceptMessage(port, data, ports) {
  const s = portOf(port);
  if (s.enabled) deliver(port, s, data, ports);
  else s.queue.push({ data, ports });
}
function deliver(port, s, data, ports) {
  s.realm.queueTask(() => {
    if (!s.detached) dispatchWithOnHandler(port, s.realm.messageEvent(data, ports));
  });
}
// `start()` — and an `onmessage` set: its queue enabled, what it held delivered in order. Once.
export function enablePort(port) {
  const s = portOf(port);
  if (s.enabled) return;
  s.enabled = true;
  const held = s.queue;
  s.queue = [];
  for (const m of held) deliver(port, s, m.data, m.ports);
}
// `close()` disentangles it: detached (a closed port is no transferable), its peer left with nowhere to deliver. The
// peer itself stays open.
export function closePort(port) {
  const s = portOf(port);
  s.detached = true;
  const peer = s.peer;
  s.peer = null;
  if (peer && portOf(peer).peer === port) portOf(peer).peer = null;
}
// A port transferred within the isolate — to a message's receiver, to another realm: a fresh port of THIS realm
// entangled in its place, its peer, its held messages and its enabled state moved onto it (messages that arrived
// before the transfer are received in order), the source neutered.
export function movePort(port) {
  const s = portOf(port), moved = newMessagePort(), m = portOf(moved);
  m.peer = s.peer;
  m.enabled = s.enabled;
  m.queue = s.queue;
  if (s.peer) portOf(s.peer).peer = moved;
  s.peer = null;
  s.queue = [];
  s.detached = true;
  return moved;
}

// ── Remote ports: a port whose entangled peer is transferred to ANOTHER isolate ──
const portsByChannel = new Map();   // channel id → this isolate's endpoint
// Transfer `port` away: its KEPT peer becomes this isolate's endpoint of a fresh channel, `port` is neutered, and the
// channel's id is what the message carries (the same id again for the same port, which a message can reference in its
// data and its transfer list both). Called by the message serializer (workers.js).
globalThis.__csimPortToChannel = function (port) {
  const s = portOf(port);
  if (s.transferChannel) return s.transferChannel;
  const channel = String(globalThis.__csimAllocPortChannel());
  const kept = s.peer || newMessagePort();   // a lone port still gets a routable (if idle) endpoint
  portOf(kept).remoteChannel = channel;
  portOf(kept).peer = null;
  portsByChannel.set(channel, kept);
  s.transferChannel = channel;
  s.peer = null;
  s.detached = true;
  s.queue = [];
  if (typeof globalThis.__csimPortEndpointHere === 'function') { try { globalThis.__csimPortEndpointHere(channel); } catch (_) {} }
  return channel;
};
// …and THIS isolate's endpoint of a channel transferred TO it — one port however often the message names the channel.
globalThis.__csimChannelToPort = function (channel) {
  channel = String(channel);
  let port = portsByChannel.get(channel);
  if (!port) {
    port = newMessagePort();
    portOf(port).remoteChannel = channel;
    portsByChannel.set(channel, port);
    if (typeof globalThis.__csimPortEndpointHere === 'function') { try { globalThis.__csimPortEndpointHere(channel); } catch (_) {} }
  }
  return port;
};
// A message the host routed to a channel's endpoint in this isolate: the serialized message (its data and the ports it
// transferred), decoded, accepted.
globalThis.__csimPortChannelDeliver = function (channel, dataStr) {
  const port = portsByChannel.get(String(channel));
  if (!port) return;
  let data = null, ports = [];
  if (typeof globalThis.__csimDecodeMessage === 'function') {
    try { ({ data, ports } = globalThis.__csimDecodeMessage(dataStr)); } catch (_) {}
  }
  acceptMessage(port, data, ports);
};

// A window or frame realm's half of the channel plumbing: a channel id unique in the isolate (`pc-r<realm>-<n>`), a
// post and an endpoint's registration made to the host directly. A worker's scope has its own (workers.js), its
// thread's outbox in place of the host.
let channelSeq = 0;
globalThis.__csimAllocPortChannel = function () {
  return 'pc-r' + globalThis.__csimRealmId() + '-' + (++channelSeq);
};
globalThis.__csimPortRemotePost = function (channel, dataStr) {
  followWindowClock();
  try { globalThis.__csimClientPortPost(channel, dataStr); } catch (_) {}
};
globalThis.__csimPortEndpointHere = function (channel) {
  try { globalThis.__csimClientPortEndpoint(channel, globalThis.__csimRealmId()); } catch (_) {}
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
    const port1 = newMessagePort(), port2 = newMessagePort();
    portOf(port1).peer = port2;
    portOf(port2).peer = port1;
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
