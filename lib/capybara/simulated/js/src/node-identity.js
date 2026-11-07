// A node's identity — its type, its slot in the engine's arena, the object a script holds of it, and an element's or an
// attribute's name — kept out of the page's reach: private fields stamped on the node's object (webidl.js `Stamp`), as
// internal slots would be. No key of the object names them, so neither `Object.getOwnPropertyNames(node)`,
// `JSON.stringify(node)` nor a `for…in` sees one (a browser's `JSON.stringify(new Text('a'))` is `{}`), and no change of
// a prototype a page makes reaches them: its type is the one its constructor gave it (`Reflect.construct(Text, ['x'],
// Comment)` is a Text).
// The read itself costs what the own property it replaced did — 3.5 ns in a tight loop over 12 element maps, both — as
// long as it is the read alone; what is left is the reader's call, shared by every site where a property load had an
// inline cache of its own: an operation of five or six reads (an XML `getElementById`, `matches`, `tagName`) costs
// some 15 ns more than its own properties did (2026-11-07). A presence check before a read (`#x in o`) doubles the
// read, so each reader reads, and answers undefined for what has no such field by catching the TypeError a read of one
// throws; every node has every field, so that is only ever something that is no node, and no hot path asks about one
// (an EventTarget's members, which see windows and XMLHttpRequests as often as nodes, ask with the check: `isNode`). A
// primitive is answered without a read.
// A private field read through a Proxy takes V8's slow path: the realm's own document, a Proxy that every `document.*`
// member has for `this`, is answered first, from what it was stamped with (`holdRealmDocument`).
// Every realm of the isolate is made from the one snapshot, which shares the class's private names between them, so a
// node another realm made reads as one of this realm's would. A legacy platform object — a `<form>`, a `<select>`, a
// document — is the Proxy around the object constructed, which no private field passes through: the Proxy is stamped
// too (`stampNodeProxy`), with what the object has.
import { Stamp } from './webidl.js';

export let stampNode, stampNamedNode, stampNodeProxy, markNodePrototype, holdRealmDocument, isRealmDocument, forgetLastAsked, setNid, setAttrs, setPrefix;
export let nodeTypeOf, nidOf, nodeArgOf, isNodeObject, isNode, nodeBehind, nodeObjectTypeOf, selfOf, namespaceOf, prefixOf, localNameOf, tagOf, attrsOf;
let realmDocument = null, realmDocumentType, realmDocumentNid;
// (…and this realm's steps — native-query-shadow.js `REALM`, given as it loads — which every node this realm's code
// makes is stamped with: the realm its object is of, a step of it making its objects there whichever realm's member
// is called, and a removed frame's kept node's its own still)
let ownSteps;
export let realmStepsOf;
export function setOwnRealmSteps(steps) {
  ownSteps = steps;
}
// (…and the last object `isNode` was asked of, with its answer: an EventTarget member asks it of its `this` several
// times — its brand check, its listener store, its dispatch — and of what is no node the check is a miss each time. One
// object held, until the event loop step ends (`forgetLastAsked`, webidl.js `forgetLastRecord`'s twin).)
let lastAsked = null, lastIsNode = false;
class NodeIdentity extends Stamp {
  // (…its interface's node type, `Node.nodeType`'s; its arena slot, none — undefined — for an Attr, which has none, and
  // until it is registered; the object a script holds of it, the Proxy where it is one; and, an element's or an Attr's,
  // its namespace, its prefix and its local name as given, an element's local name ASCII-lowercased (`tag`, what the
  // matcher and the cascade compare) and its attribute store (the arena's attrsView, from its registration))
  #type;
  #nid;
  #self;
  #ns;
  #prefix;
  #localName;
  #tag;
  #attrs;
  #steps = ownSteps;
  constructor(o, type, nid, self, ns, prefix, localName, tag, attrs) {
    super(o);
    this.#type = type;
    this.#nid = nid;
    this.#self = self;
    this.#ns = ns;
    this.#prefix = prefix;
    this.#localName = localName;
    this.#tag = tag;
    this.#attrs = attrs;
  }
  static {
    // (…`self` none for what stands in for an element and is none, a generated box's holder: style-proxy.js)
    stampNode = (o, type, self = o) => new NodeIdentity(o, type, undefined, self, undefined, undefined, undefined, undefined, undefined);
    stampNamedNode = (o, type, ns, prefix, localName, tag, self = o) => new NodeIdentity(o, type, undefined, self, ns, prefix, localName, tag, undefined);
    // (…`o`'s identity given its Proxy, which `o` names as the node a script holds from then on)
    stampNodeProxy = (proxy, o) => {
      o.#self = proxy;
      lastAsked = null;
      return new NodeIdentity(proxy, o.#type, o.#nid, proxy, o.#ns, o.#prefix, o.#localName, o.#tag, o.#attrs);
    };
    // (…Node.prototype's: an identity of no node — no type, no self — that an object inheriting from it is behind)
    markNodePrototype = (proto) => new NodeIdentity(proto, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
    holdRealmDocument = (doc) => {
      realmDocument = doc;
      realmDocumentType = doc.#type;
      realmDocumentNid = doc.#nid;
    };
    // (…whether `o` is it — asked before which realm a node is of, by a step that makes objects for it)
    isRealmDocument = (o) => o === realmDocument;
    realmStepsOf = (o) => {
      if (o === realmDocument) return ownSteps;
      try { return o.#steps; } catch { return undefined; }
    };
    // (…as it is registered, which a node is before any Proxy is made of it)
    setNid = (o, nid) => {
      o.#nid = nid;
    };
    setAttrs = (o, attrs) => {
      o.#attrs = attrs;
    };
    // (…a custom element's, once its constructor has returned: the object a script holds — a customized built-in
    // form's or select's Proxy, whose target keeps the none it was made with, read by its traps alone)
    setPrefix = (o, prefix) => {
      o.#prefix = prefix;
    };

    nodeTypeOf = (o) => {
      if (o === realmDocument) return realmDocumentType;
      if (typeof o !== 'object' || o === null) return undefined;
      try { return o.#type; } catch { return undefined; }
    };
    nidOf = (o) => {
      if (o === realmDocument) return realmDocumentNid;
      if (typeof o !== 'object' || o === null) return undefined;
      try { return o.#nid; } catch { return undefined; }
    };
    // What an engine op that takes a node is handed of `o`: the realm's document by its slot — the object a script
    // holds of it a Proxy, which the engine would unwrap at every call (node_handle.rs `node_arg`) — any other as it is,
    // but a number, which would name a slot: none.
    nodeArgOf = (o) => (o === realmDocument ? realmDocumentNid : typeof o === 'number' ? undefined : o);
    // Whether `o` is a node — the object a script holds of one, not the object behind its Proxy.
    isNodeObject = (o) => {
      if (o === realmDocument) return true;
      if (typeof o !== 'object' || o === null) return false;
      try { return o.#self === o; } catch { return false; }
    };
    // …asked of what may well be none — an EventTarget's — with the check rather than the catch, which costs a throw
    isNode = (o) => {
      if (o === lastAsked) return lastIsNode;
      const answer = o === realmDocument || (typeof o === 'object' && o !== null && #self in o && o.#self === o);
      lastAsked = o;
      lastIsNode = answer;
      return answer;
    };
    forgetLastAsked = () => {
      lastAsked = null;
    };
    // …and whether a node, or Node.prototype, is on the prototype chain from `proto`: an object `proto` is the prototype
    // of inherits from a node. Asked by EventTarget's members of every object of another interface — an XMLHttpRequest,
    // an AbortSignal, an EventTarget of a page's — so the answer is kept with the prototype, a private field of its own
    // (`Verdict`), read in one step where the walk is a step a prototype; a chain a page changes after it was asked keeps
    // the answer it had.
    class Verdict extends Stamp {
      #nodeBehind;
      constructor(o, verdict) {
        super(o);
        this.#nodeBehind = verdict;
      }
      static {
        nodeBehind = (proto) => {
          try { return proto.#nodeBehind; } catch {}
          let verdict = false;
          for (let p = proto; p !== null; p = Object.getPrototypeOf(p)) {
            if (#self in p) {
              verdict = true;
              break;
            }
          }
          // (…kept, but for a prototype that takes no field: a page's frozen one under a nonextensible-private rule)
          try { new Verdict(proto, verdict); } catch {}
          return verdict;
        };
      }
    }
    // …and its type where it is one, undefined where it is none: an interface's brand check in one read less.
    // (…in one read: what has a type has an identity, and the object behind a Proxy, which passes too, is no script's)
    nodeObjectTypeOf = (o) => {
      if (o === realmDocument) return realmDocumentType;
      if (typeof o !== 'object' || o === null) return undefined;
      try { return o.#type; } catch { return undefined; }
    };
    // …and the object a script holds of the node `o` is the object of.
    selfOf = (o) => (o === realmDocument ? o : o.#self);
    // (…a document's none — read through its Proxy, though, as no hot path asks)
    namespaceOf = (o) => {
      if (typeof o !== 'object' || o === null) return undefined;
      try { return o.#ns; } catch { return undefined; }
    };
    prefixOf = (o) => {
      if (typeof o !== 'object' || o === null) return undefined;
      try { return o.#prefix; } catch { return undefined; }
    };
    localNameOf = (o) => {
      if (typeof o !== 'object' || o === null) return undefined;
      try { return o.#localName; } catch { return undefined; }
    };
    tagOf = (o) => {
      if (typeof o !== 'object' || o === null) return undefined;
      try { return o.#tag; } catch { return undefined; }
    };
    attrsOf = (o) => {
      if (typeof o !== 'object' || o === null) return undefined;
      try { return o.#attrs; } catch { return undefined; }
    };
  }
}
// An Attr's own state: the element it is one of and the key its attribute is stored under there — none while it is
// detached — and the value it keeps of its own.
export let stampAttr, attrOwnerOf, attrStoreKeyOf, attrOwnValueOf, bindAttr, setAttrOwnValue;
class AttrState extends Stamp {
  #owner = null;
  #key = null;
  #value;
  constructor(o, value) {
    super(o);
    this.#value = value;
  }
  static {
    stampAttr = (o, value) => new AttrState(o, value);
    // (…none, for a node that is no Attr Attr.prototype's members were reached on: `Reflect.construct(Text, [], Attr)`)
    attrOwnerOf = (attr) => (#owner in attr ? attr.#owner : null);
    attrStoreKeyOf = (attr) => (#key in attr ? attr.#key : null);
    attrOwnValueOf = (attr) => (#value in attr ? attr.#value : null);
    // (…its element `el` and its key there, or none for both)
    bindAttr = (attr, el, key) => {
      attr.#owner = el;
      attr.#key = key;
    };
    setAttrOwnValue = (attr, value) => {
      attr.#value = value;
    };
  }
}
// A processing instruction's own state: its target, and its attribute map with the data it was read from or written as
// (dom-nodes.js `piAttributeMap`) — a write of the data since leaves them apart.
export let stampPI, piTargetOf, piAttributesOf, setPIAttributes;
class PIState extends Stamp {
  #target;
  #attrs = null;
  #attrsData = null;
  constructor(o, target) {
    super(o);
    this.#target = target;
  }
  static {
    stampPI = (o, target) => new PIState(o, target);
    piTargetOf = (pi) => pi.#target;
    // (…its map, where it was read from `data` or written as it; none else)
    piAttributesOf = (pi, data) => (pi.#attrsData === data ? pi.#attrs : null);
    setPIAttributes = (pi, map, data) => {
      pi.#attrs = map;
      pi.#attrsData = data;
    };
  }
}
// A generated box's holder (style-proxy.js `pseudoNodeFor`): which pseudo-element it is and the element it is of —
// private, so no page's `_pseudo` expando on an element makes that element one.
export let stampGeneratedBox, pseudoOf, originOf;
class GeneratedBox extends Stamp {
  #pseudo;
  #origin;
  constructor(o, pseudo, origin) {
    super(o);
    this.#pseudo = pseudo;
    this.#origin = origin;
  }
  static {
    stampGeneratedBox = (o, pseudo, origin) => new GeneratedBox(o, pseudo, origin);
    // (…undefined for anything else: a node, the realm's document — a Proxy — answered first)
    pseudoOf = (o) => (o !== realmDocument && typeof o === 'object' && o !== null && #pseudo in o ? o.#pseudo : undefined);
    originOf = (o) => o.#origin;
  }
}
// …and a shadow root's brand, its own: what tells one from any other fragment — which a dispatch asks of every node of its
// path, and a tree walk of every node it climbs, so it is one presence check, the realm's document (a Proxy) answered
// first.
export let stampShadowRoot, isShadowRoot;
class ShadowRootBrand extends Stamp {
  #shadowRoot;
  static {
    stampShadowRoot = (o) => new ShadowRootBrand(o);
    isShadowRoot = (o) => o !== realmDocument && typeof o === 'object' && o !== null && #shadowRoot in o;
  }
}
