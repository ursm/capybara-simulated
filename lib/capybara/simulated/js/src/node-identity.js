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
// (an EventTarget's members ask Node.prototype's brand first: events.js `isNodeTarget`). A primitive is answered
// without a read.
// A private field read through a Proxy takes V8's slow path: the realm's own document, a Proxy that every `document.*`
// member has for `this`, is answered first, from what it was stamped with (`holdRealmDocument`).
// Every realm of the isolate is made from the one snapshot, which shares the class's private names between them, so a
// node another realm made reads as one of this realm's would. A legacy platform object — a `<form>`, a `<select>`, a
// document — is the Proxy around the object constructed, which no private field passes through: the Proxy is stamped
// too (`stampNodeProxy`), with what the object has.
import { Stamp } from './webidl.js';

export let stampNode, stampNamedNode, stampNodeProxy, holdRealmDocument, setNid, setAttrs;
export let nodeTypeOf, nidOf, isNodeObject, nodeObjectTypeOf, selfOf, namespaceOf, prefixOf, localNameOf, tagOf, attrsOf;
let realmDocument = null, realmDocumentType, realmDocumentNid;
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
      return new NodeIdentity(proxy, o.#type, o.#nid, proxy, o.#ns, o.#prefix, o.#localName, o.#tag, o.#attrs);
    };
    holdRealmDocument = (doc) => {
      realmDocument = doc;
      realmDocumentType = doc.#type;
      realmDocumentNid = doc.#nid;
    };
    // (…as it is registered, which a node is before any Proxy is made of it)
    setNid = (o, nid) => {
      o.#nid = nid;
    };
    setAttrs = (o, attrs) => {
      o.#attrs = attrs;
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
    // Whether `o` is a node — the object a script holds of one, not the object behind its Proxy.
    isNodeObject = (o) => {
      if (o === realmDocument) return true;
      if (typeof o !== 'object' || o === null) return false;
      try { return o.#self === o; } catch { return false; }
    };
    // …and its type where it is one, undefined where it is none: an interface's brand check in one read less.
    nodeObjectTypeOf = (o) => {
      if (o === realmDocument) return realmDocumentType;
      if (typeof o !== 'object' || o === null) return undefined;
      try { return o.#self === o ? o.#type : undefined; } catch { return undefined; }
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
