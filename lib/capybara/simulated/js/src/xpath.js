// XPath (DOM § 8): xpath.rs evaluates XPath 1.0 over the arena; this is the binding — XPathEvaluator,
// XPathExpression and XPathResult, a resolver asked for the expression's prefixes as WebIDL calls a callback
// interface, and the answer mapped back onto the JS tree.

import { NODE_ATTRIBUTE, NODE_DOC, NODE_DOCTYPE, NODE_FRAGMENT } from './constants.js';
import { isNodeArg } from './dom-nodes.js';
import { isHtmlDocument } from './mime.js';
import { nodeArena } from './native-query-shadow.js';
import { currentTreeGen } from './mutation-observer.js';

const ANY_TYPE = 0;
const NUMBER_TYPE = 1;
const STRING_TYPE = 2;
const BOOLEAN_TYPE = 3;
const UNORDERED_NODE_ITERATOR_TYPE = 4;
const ORDERED_NODE_ITERATOR_TYPE = 5;
const UNORDERED_NODE_SNAPSHOT_TYPE = 6;
const ORDERED_NODE_SNAPSHOT_TYPE = 7;
const ANY_UNORDERED_NODE_TYPE = 8;
const FIRST_ORDERED_NODE_TYPE = 9;

// Constructs what script cannot: an XPathResult, an XPathExpression.
const INTERNAL = {};

function isIterator(type) { return type === UNORDERED_NODE_ITERATOR_TYPE || type === ORDERED_NODE_ITERATOR_TYPE; }
function isSnapshot(type) { return type === UNORDERED_NODE_SNAPSHOT_TYPE || type === ORDERED_NODE_SNAPSHOT_TYPE; }
function isSingle(type)   { return type === ANY_UNORDERED_NODE_TYPE || type === FIRST_ORDERED_NODE_TYPE; }

// The URL a resolver gives `prefix` — `null` where it gives none, or throws (the exception reported, as a callback
// interface's is: the evaluation goes on to its NamespaceError). A function is called itself; an object's
// `lookupNamespaceURI` is read afresh each time, and called with the object as `this`.
function lookupPrefix(resolver, prefix) {
  try {
    let uri;
    if (typeof resolver === 'function') {
      uri = resolver(prefix);
    } else {
      const lookup = resolver.lookupNamespaceURI;
      if (typeof lookup !== 'function') throw new TypeError("The resolver's lookupNamespaceURI is not callable.");
      uri = lookup.call(resolver, prefix);
    }
    return uri == null ? null : `${uri}`; // (…ToString: a Symbol throws, where String() would not)
  } catch (e) {
    globalThis.reportError(e);
    return null;
  }
}

// A DOMString argument, as WebIDL converts one: ToString, which a Symbol throws on (where `String()` would not).
function domString(v) {
  return `${v}`;
}
// The resolver argument, as WebIDL converts an `XPathNSResolver?`: null, or an object (a function included).
function resolverArg(resolver) {
  if (resolver === undefined || resolver === null) return null;
  if (typeof resolver !== 'object' && typeof resolver !== 'function') throw new TypeError('The resolver is not an XPathNSResolver.');
  return resolver;
}
// The context node argument: a Node of any realm (`isNodeArg`), else a TypeError.
function contextArg(contextNode) {
  if (!isNodeArg(contextNode)) throw new TypeError('The context node is not a Node.');
  return contextNode;
}
// The result type argument, as WebIDL converts an `unsigned short`.
function typeArg(type) {
  return Number(type) & 0xffff;
}

// `expression` parsed, and every prefix it names resolved: the flat [prefix, uri, …] the evaluator takes. A
// SyntaxError for an expression that does not parse; a NamespaceError for a prefix the resolver does not bind.
function compile(expression, resolver) {
  const prefixes = globalThis.__dom.xpathPrefixes(expression);
  if (typeof prefixes === 'string') {
    throw new globalThis.DOMException("The string '" + expression + "' is not a valid XPath expression: " + prefixes, 'SyntaxError');
  }
  const namespaces = [];
  for (const prefix of prefixes) {
    const uri = resolver == null ? null : lookupPrefix(resolver, prefix);
    if (uri === null) {
      throw new globalThis.DOMException("The string '" + expression + "' contains unresolvable namespace prefixes.", 'NamespaceError');
    }
    namespaces.push(prefix, uri);
  }
  return { expression, namespaces };
}

// The nodes the evaluator answered — `answer` is [node, key, …] in document order, `key` an attribute's store key (null
// for the node itself).
function nodesOfAnswer(answer) {
  const out = [];
  for (let k = 0; k < answer.length; k += 2) {
    const node = answer[k], key = answer[k + 1];
    out.push(key === null ? node : node._attrNodeFor(key));
  }
  return out;
}

// The result type a value of the evaluator's answers when ANY_TYPE was asked for.
function naturalType(answer) {
  if (Array.isArray(answer)) return UNORDERED_NODE_ITERATOR_TYPE;
  if (typeof answer === 'number') return NUMBER_TYPE;
  return typeof answer === 'string' ? STRING_TYPE : BOOLEAN_TYPE;
}

// (…its arguments converted already)
function evaluate(compiled, contextNode, type) {
  // (…a DocumentType or a DocumentFragment — a shadow root too — is no context node DOM XPath takes)
  if (contextNode.nodeType === NODE_DOCTYPE || contextNode.nodeType === NODE_FRAGMENT) {
    throw new globalThis.DOMException('A node of type ' + contextNode.nodeType + ' is not a valid XPath context node.', 'NotSupportedError');
  }
  if (type > FIRST_ORDERED_NODE_TYPE) throw new TypeError('Unknown XPathResult type ' + type + '.');
  // (…an attribute by its element and its store key)
  const isAttr = contextNode.nodeType === NODE_ATTRIBUTE;
  const holder = isAttr ? contextNode._ownerElement : contextNode;
  if (!holder) {
    throw new globalThis.DOMException('An attribute of no element is not a valid XPath context node.', 'NotSupportedError');
  }
  const doc = holder.nodeType === NODE_DOC ? holder : holder.ownerDocument;
  const html = !!doc && isHtmlDocument(doc);
  const a = nodeArena(holder);
  if (!a) throw new Error('[csim] no arena holds the context node of an XPath evaluation');
  const answer = a.dom.xpathEvaluate(compiled.expression, holder._nid, isAttr ? contextNode._key : null, html, compiled.namespaces, type);
  if (answer === undefined) throw new Error('[csim] the arena does not hold the context node of an XPath evaluation');
  const resultType = type === ANY_TYPE ? naturalType(answer) : type;
  return new XPathResult(INTERNAL, resultType, Array.isArray(answer) ? nodesOfAnswer(answer) : answer);
}

export class XPathResult {
  #type;
  #value;
  #index = 0;
  #treeGen;

  constructor(token, type, value) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    this.#type = type;
    this.#value = value;
    this.#treeGen = currentTreeGen();
  }

  #wrongType(member) {
    return new TypeError('The result is not of a type ' + member + ' can read (its type is ' + this.#type + ').');
  }

  get resultType() { return this.#type; }

  get numberValue() {
    if (this.#type !== NUMBER_TYPE) throw this.#wrongType('numberValue');
    return this.#value;
  }

  get stringValue() {
    if (this.#type !== STRING_TYPE) throw this.#wrongType('stringValue');
    return this.#value;
  }

  get booleanValue() {
    if (this.#type !== BOOLEAN_TYPE) throw this.#wrongType('booleanValue');
    return this.#value;
  }

  get singleNodeValue() {
    if (!isSingle(this.#type)) throw this.#wrongType('singleNodeValue');
    return this.#value.length ? this.#value[0] : null;
  }

  // An iterator over a tree changed since the result was made is invalid — any change to any tree, as Blink keys it on
  // its DOM tree version.
  get invalidIteratorState() {
    return isIterator(this.#type) && this.#treeGen !== currentTreeGen();
  }

  get snapshotLength() {
    if (!isSnapshot(this.#type)) throw this.#wrongType('snapshotLength');
    return this.#value.length;
  }

  iterateNext() {
    if (!isIterator(this.#type)) throw this.#wrongType('iterateNext()');
    if (this.#treeGen !== currentTreeGen()) {
      throw new globalThis.DOMException('The document has mutated since the result was returned.', 'InvalidStateError');
    }
    return this.#index < this.#value.length ? this.#value[this.#index++] : null;
  }

  snapshotItem(index) {
    if (arguments.length === 0) throw new TypeError("snapshotItem() requires an argument.");
    if (!isSnapshot(this.#type)) throw this.#wrongType('snapshotItem()');
    index = Number(index) >>> 0;
    return index < this.#value.length ? this.#value[index] : null;
  }
}

export class XPathExpression {
  #compiled;

  constructor(token, compiled) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    this.#compiled = compiled;
  }

  // (`result`, an XPathResult the caller offers for reuse, may be ignored: a new one is returned)
  evaluate(contextNode, type = ANY_TYPE, result = null) { // eslint-disable-line no-unused-vars
    return evaluate(this.#compiled, contextArg(contextNode), typeArg(type));
  }
}

export class XPathEvaluator {}

// XPathEvaluatorBase, which Document and XPathEvaluator both include.
const evaluatorBase = {
  createExpression(expression, resolver = null) {
    expression = domString(expression);
    return new XPathExpression(INTERNAL, compile(expression, resolverArg(resolver)));
  },
  // The node itself: a Node's lookupNamespaceURI is the resolver, with no `xml` binding added.
  createNSResolver(nodeResolver) {
    return nodeResolver;
  },
  // (…every argument converted, in order, before the resolver is asked anything)
  evaluate(expression, contextNode, resolver = null, type = ANY_TYPE, result = null) { // eslint-disable-line no-unused-vars
    expression = domString(expression);
    contextNode = contextArg(contextNode);
    resolver = resolverArg(resolver);
    type = typeArg(type);
    return evaluate(compile(expression, resolver), contextNode, type);
  }
};

const RESULT_TYPES = {
  ANY_TYPE,
  NUMBER_TYPE,
  STRING_TYPE,
  BOOLEAN_TYPE,
  UNORDERED_NODE_ITERATOR_TYPE,
  ORDERED_NODE_ITERATOR_TYPE,
  UNORDERED_NODE_SNAPSHOT_TYPE,
  ORDERED_NODE_SNAPSHOT_TYPE,
  ANY_UNORDERED_NODE_TYPE,
  FIRST_ORDERED_NODE_TYPE
};

// Install the interfaces, and XPathEvaluatorBase onto Document.prototype. Called once at boot (bridge.entry.js).
export function installXPath(DocumentProto) {
  for (const [name, value] of Object.entries(RESULT_TYPES)) {
    const constant = { value, enumerable: true, writable: false, configurable: false };
    Object.defineProperty(XPathResult, name, constant);
    Object.defineProperty(XPathResult.prototype, name, constant);
  }
  for (const cls of [XPathResult, XPathExpression, XPathEvaluator]) {
    Object.defineProperty(cls.prototype, Symbol.toStringTag, { value: cls.name, configurable: true });
  }
  for (const proto of [XPathEvaluator.prototype, DocumentProto]) {
    for (const [name, value] of Object.entries(evaluatorBase)) {
      Object.defineProperty(proto, name, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  globalThis.XPathResult = XPathResult;
  globalThis.XPathExpression = XPathExpression;
  globalThis.XPathEvaluator = XPathEvaluator;
}
