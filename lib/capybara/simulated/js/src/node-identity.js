// A node's identity — its type, its slot in the engine's arena, the object a script holds of it, and an element's or an
// attribute's name — kept out of the page's reach: private fields stamped on the node's object (webidl.js `Stamp`), as
// internal slots would be. No key of the object names them, so neither `Object.getOwnPropertyNames(node)`,
// `JSON.stringify(node)` nor a `for…in` sees one (a browser's `JSON.stringify(new Text('a'))` is `{}`), and no change of
// a prototype a page makes reaches them: its type is the one its constructor gave it (`Reflect.construct(Text, ['x'],
// Comment)` is a Text). A read costs what the own property it replaced did, where a WeakMap or a native call costs
// several times that.
// Every realm of the isolate is made from the one snapshot, which shares the classes' private names between them, so a
// node another realm made reads as one of this realm's would. A legacy platform object — a `<form>`, a `<select>`, a
// document — is the Proxy around the object constructed, which no private field passes through: the Proxy is stamped
// too (`stampNodeProxy`), with what the object has.
// Each reader takes anything, and answers undefined for what has no such field, as for a primitive.
import { Stamp } from './webidl.js';

export let stampNode, stampNamedNode, stampNodeProxy, nodeTypeOf, nidOf, setNid, isNodeObject, selfOf;
export let namespaceOf, prefixOf, localNameOf, tagOf, attrsOf, setPrefix, setAttrs;
class NodeIdentity extends Stamp {
  // (…its interface's node type, `Node.nodeType`'s; its arena slot, none — undefined — for an Attr, which has none, and
  // until it is registered; and the object a script holds of it, the Proxy where it is one)
  #type;
  #nid;
  #self;
  constructor(o, type, nid, self) {
    super(o);
    this.#type = type;
    this.#nid = nid;
    this.#self = self;
  }
  static {
    // (…`self` none for what stands in for an element and is none, a generated box's holder: style-proxy.js)
    stampNode = (o, type, self = o) => new NodeIdentity(o, type, undefined, self);
    nodeTypeOf = (o) => (typeof o === 'object' && o !== null && #type in o ? o.#type : undefined);
    nidOf = (o) => (typeof o === 'object' && o !== null && #nid in o ? o.#nid : undefined);
    // (…as it is registered, which a node is before any Proxy is made of it)
    setNid = (o, nid) => {
      o.#nid = nid;
    };
    // Whether `o` is a node — the object a script holds of one, not the object behind its Proxy.
    isNodeObject = (o) => typeof o === 'object' && o !== null && #self in o && o.#self === o;
    // …and the object a script holds of the node `o` is the object of.
    selfOf = (o) => o.#self;

    // An element's identity, and an Attr's, also hold its name: its namespace, its prefix and its local name as given,
    // and an element's local name ASCII-lowercased (`tag`, what the matcher and the cascade compare) and its attribute
    // store (the arena's attrsView, from its registration). Declared here, so it stamps a node's fields too.
    class NamedNodeIdentity extends NodeIdentity {
      #ns;
      #prefix;
      #localName;
      #tag;
      #attrs;
      constructor(o, type, nid, self, ns, prefix, localName, tag, attrs) {
        super(o, type, nid, self);
        this.#ns = ns;
        this.#prefix = prefix;
        this.#localName = localName;
        this.#tag = tag;
        this.#attrs = attrs;
      }
      static {
        stampNamedNode = (o, type, ns, prefix, localName, tag, self = o) => new NamedNodeIdentity(o, type, undefined, self, ns, prefix, localName, tag, undefined);
        // (…`o`'s identity given its Proxy, which `o` names as the node a script holds from then on)
        stampNodeProxy = (proxy, o) => {
          o.#self = proxy;
          return #tag in o
            ? new NamedNodeIdentity(proxy, o.#type, o.#nid, proxy, o.#ns, o.#prefix, o.#localName, o.#tag, o.#attrs)
            : new NodeIdentity(proxy, o.#type, o.#nid, proxy);
        };
        namespaceOf = (o) => (typeof o === 'object' && o !== null && #ns in o ? o.#ns : undefined);
        prefixOf = (o) => (typeof o === 'object' && o !== null && #prefix in o ? o.#prefix : undefined);
        localNameOf = (o) => (typeof o === 'object' && o !== null && #localName in o ? o.#localName : undefined);
        tagOf = (o) => (typeof o === 'object' && o !== null && #tag in o ? o.#tag : undefined);
        attrsOf = (o) => (typeof o === 'object' && o !== null && #attrs in o ? o.#attrs : undefined);
        // (…an element a custom element constructor made, given the prefix it was created with)
        setPrefix = (o, prefix) => {
          o.#prefix = prefix;
        };
        setAttrs = (o, attrs) => {
          o.#attrs = attrs;
        };
      }
    }
  }
}
