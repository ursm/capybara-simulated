// XPath (DOM § 8): xpath.rs evaluates XPath 1.0 over the arena; this is the binding — XPathEvaluator,
// XPathExpression and XPathResult, a resolver asked for the expression's prefixes as WebIDL calls a callback
// interface, and the answer mapped back onto the JS tree.

import { NODE_ATTRIBUTE, NODE_DOC, NODE_DOCTYPE, NODE_FRAGMENT } from './constants.js';
import { isHtmlDocument } from './mime.js';
import { nodeArena, nodeAtPath, endOfPath } from './native-query-shadow.js';
import { currentTreeGen } from './mutation-observer.js';
import {
  installXPathEvaluator, installXPathExpression, installXPathResult
} from './generated/bindings.js';
import { PLATFORM, brandPrototype, constructedBy, defineInternalSlots, registerInterface } from './webidl.js';

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
    globalThis.__csimReportError(e);
    return null;
  }
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

// The nodes the evaluator answered — `answer` is [key, path…, …] in document order, each node's path from `root` (the
// root of the context's tree: `nodeAtPath`), `key` an attribute's store key (null for the node itself).
function nodesOfAnswer(root, answer) {
  const out = [];
  for (let at = 0; at < answer.length;) {
    const key = answer[at];
    const node = nodeAtPath(root, answer, at + 1);
    at = endOfPath();
    if (node) out.push(key === null ? node : node._attrNodeFor(key));
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
  if (contextNode._nodeType === NODE_DOCTYPE || contextNode._nodeType === NODE_FRAGMENT) {
    throw new globalThis.DOMException('A node of type ' + contextNode._nodeType + ' is not a valid XPath context node.', 'NotSupportedError');
  }
  if (type > FIRST_ORDERED_NODE_TYPE) throw new TypeError('Unknown XPathResult type ' + type + '.');
  // (…an attribute by its element and its store key)
  const isAttr = contextNode._nodeType === NODE_ATTRIBUTE;
  const holder = isAttr ? contextNode._ownerElement : contextNode;
  if (!holder) {
    throw new globalThis.DOMException('An attribute of no element is not a valid XPath context node.', 'NotSupportedError');
  }
  const doc = holder._nodeType === NODE_DOC ? holder : holder.ownerDocument;
  const html = !!doc && isHtmlDocument(doc);
  const a = nodeArena(holder);
  if (!a) throw new Error('[csim] no arena holds the context node of an XPath evaluation');
  const answer = a.dom.xpathEvaluate(compiled.expression, holder._nid, isAttr ? contextNode._key : null, html, compiled.namespaces, type);
  if (answer === undefined) throw new Error('[csim] the arena does not hold the context node of an XPath evaluation');
  const resultType = type === ANY_TYPE ? naturalType(answer) : type;
  if (!Array.isArray(answer)) return new XPathResult(PLATFORM, resultType, answer);
  let root = holder;
  while (root._parent && !root._isShadowRoot) root = root._parent;
  return new XPathResult(PLATFORM, resultType, nodesOfAnswer(root, answer));
}

// XPathResult, XPathExpression and XPathEvaluator (DOM §8), generated from their IDL: a result and an expression no
// page's to construct, their state internal slots — any realm's, by their brands.
export class XPathResult {
  constructor(token, type, value) {
    constructedBy(PLATFORM, token, 'XPathResult');
    defineInternalSlots(this, { _type: type, _value: value, _index: 0, _treeGen: currentTreeGen() });
  }
}
const XPATH_RESULT = brandPrototype(XPathResult, 'XPathResult');
registerInterface('XPathResult', (o) => o !== null && typeof o === 'object' && o[XPATH_RESULT] === true && o._type !== undefined);
// (…a member reading a value of a type the result is not, a TypeError)
function wrongType(result, member) {
  return new TypeError('The result is not of a type ' + member + ' can read (its type is ' + result._type + ').');
}
installXPathResult(XPathResult, {
  get_resultType: (result) => result._type,
  get_numberValue(result) {
    if (result._type !== NUMBER_TYPE) throw wrongType(result, 'numberValue');
    return result._value;
  },
  get_stringValue(result) {
    if (result._type !== STRING_TYPE) throw wrongType(result, 'stringValue');
    return result._value;
  },
  get_booleanValue(result) {
    if (result._type !== BOOLEAN_TYPE) throw wrongType(result, 'booleanValue');
    return result._value;
  },
  get_singleNodeValue(result) {
    if (!isSingle(result._type)) throw wrongType(result, 'singleNodeValue');
    return result._value.length ? result._value[0] : null;
  },
  // An iterator over a tree changed since the result was made is invalid — any change to any tree, as Blink keys it on
  // its DOM tree version.
  get_invalidIteratorState: (result) => isIterator(result._type) && result._treeGen !== currentTreeGen(),
  get_snapshotLength(result) {
    if (!isSnapshot(result._type)) throw wrongType(result, 'snapshotLength');
    return result._value.length;
  },
  iterateNext(result) {
    if (!isIterator(result._type)) throw wrongType(result, 'iterateNext()');
    if (result._treeGen !== currentTreeGen()) {
      throw new globalThis.DOMException('The document has mutated since the result was returned.', 'InvalidStateError');
    }
    return result._index < result._value.length ? result._value[result._index++] : null;
  },
  snapshotItem(result, index) {
    if (!isSnapshot(result._type)) throw wrongType(result, 'snapshotItem()');
    return index < result._value.length ? result._value[index] : null;
  }
});

export class XPathExpression {
  constructor(token, compiled) {
    constructedBy(PLATFORM, token, 'XPathExpression');
    defineInternalSlots(this, { _compiled: compiled });
  }
}
const XPATH_EXPRESSION = brandPrototype(XPathExpression, 'XPathExpression');
registerInterface('XPathExpression', (o) => o !== null && typeof o === 'object' && o[XPATH_EXPRESSION] === true && o._compiled !== undefined);
installXPathExpression(XPathExpression, {
  // (`result`, an XPathResult the caller offers for reuse, may be ignored: a new one is returned)
  evaluate: (expression, contextNode, type) => evaluate(expression._compiled, contextNode, type)
});

// XPathEvaluatorBase, which Document and XPathEvaluator both include: its steps, of arguments their generated bindings
// converted — every one before the resolver is asked anything.
export const xpathEvaluatorBase = {
  createExpression: (expression, resolver) => new XPathExpression(PLATFORM, compile(expression, resolver)),
  evaluate: (expression, contextNode, resolver, type) => evaluate(compile(expression, resolver), contextNode, type)
};
export class XPathEvaluator {}
// (…stateless: any realm's object its prototype brands, the prototype itself none)
const XPATH_EVALUATOR = brandPrototype(XPathEvaluator, 'XPathEvaluator');
registerInterface('XPathEvaluator', (o) => o !== null && typeof o === 'object' && o[XPATH_EVALUATOR] === true && !Object.hasOwn(o, XPATH_EVALUATOR));
installXPathEvaluator(XPathEvaluator, {
  createExpression: (evaluator, expression, resolver) => xpathEvaluatorBase.createExpression(expression, resolver),
  // (…the node itself: a Node's lookupNamespaceURI is the resolver, with no `xml` binding added)
  createNSResolver: (evaluator, nodeResolver) => nodeResolver,
  evaluate: (evaluator, expression, contextNode, resolver, type) => xpathEvaluatorBase.evaluate(expression, contextNode, resolver, type)
});
globalThis.XPathResult = XPathResult;
globalThis.XPathExpression = XPathExpression;
globalThis.XPathEvaluator = XPathEvaluator;
