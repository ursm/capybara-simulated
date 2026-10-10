// XPath (DOM § 8): xpath.rs evaluates XPath 1.0 over the arena; this is the binding — XPathEvaluator,
// XPathExpression and XPathResult, a resolver asked for the expression's prefixes as WebIDL calls a callback
// interface, and the answer mapped back onto the JS tree.

import { NODE_ATTRIBUTE, NODE_DOC, NODE_DOCTYPE, NODE_FRAGMENT } from './constants.js';
import { isHtmlDocument } from './mime.js';
import { nodeArena } from './native-query-shadow.js';
import { currentTreeGen } from './mutation-observer.js';
import {
  installXPathEvaluator, installXPathExpression, installXPathResult
} from './generated/bindings.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf } from './webidl.js';

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

// The nodes the evaluator answered — `answer` is [keys, nodes] in document order, each key an attribute's store key
// (null for the node itself).
function nodesOfAnswer([keys, nodes]) {
  return nodes.map((node, i) => (keys[i] === null ? node : node._attrNodeFor(keys[i])));
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
  return new XPathResult(PLATFORM, resultType, nodesOfAnswer(answer));
}

// XPathResult, XPathExpression and XPathEvaluator (DOM §8), generated from their IDL: a result and an expression no
// page's to construct, their state internal slots — any realm's code's to read.
export class XPathResult {
  constructor(token, type, value) {
    constructedBy(PLATFORM, token, 'XPathResult');
    // (…the tree generation it was made at, and the clock that tells it: the realm's that made it, whichever realm's
    // members ask — each realm counts its own)
    makeSlots(this, 'XPathResult', { type, value, index: 0, treeGen: currentTreeGen(), clock: currentTreeGen });
  }
}
const resultOf = (o) => slotsOf(o, 'XPathResult');
registerInterface('XPathResult', (o) => resultOf(o) !== undefined);
// (…a member reading a value of a type the result is not, a TypeError)
function wrongType(s, member) {
  return new TypeError('The result is not of a type ' + member + ' can read (its type is ' + s.type + ').');
}
// (…an iterator over a tree changed since the result was made is invalid — any change to any tree, as Blink keys it on
// its DOM tree version)
const mutatedSince = (s) => s.treeGen !== s.clock();
installXPathResult(XPathResult, {
  get_resultType: (result) => resultOf(result).type,
  get_numberValue(result) {
    const s = resultOf(result);
    if (s.type !== NUMBER_TYPE) throw wrongType(s, 'numberValue');
    return s.value;
  },
  get_stringValue(result) {
    const s = resultOf(result);
    if (s.type !== STRING_TYPE) throw wrongType(s, 'stringValue');
    return s.value;
  },
  get_booleanValue(result) {
    const s = resultOf(result);
    if (s.type !== BOOLEAN_TYPE) throw wrongType(s, 'booleanValue');
    return s.value;
  },
  get_singleNodeValue(result) {
    const s = resultOf(result);
    if (!isSingle(s.type)) throw wrongType(s, 'singleNodeValue');
    return s.value.length ? s.value[0] : null;
  },
  get_invalidIteratorState(result) {
    const s = resultOf(result);
    return isIterator(s.type) && mutatedSince(s);
  },
  get_snapshotLength(result) {
    const s = resultOf(result);
    if (!isSnapshot(s.type)) throw wrongType(s, 'snapshotLength');
    return s.value.length;
  },
  iterateNext(result) {
    const s = resultOf(result);
    if (!isIterator(s.type)) throw wrongType(s, 'iterateNext()');
    if (mutatedSince(s)) throw new globalThis.DOMException('The document has mutated since the result was returned.', 'InvalidStateError');
    return s.index < s.value.length ? s.value[s.index++] : null;
  },
  snapshotItem(result, index) {
    const s = resultOf(result);
    if (!isSnapshot(s.type)) throw wrongType(s, 'snapshotItem()');
    return index < s.value.length ? s.value[index] : null;
  }
});

export class XPathExpression {
  constructor(token, compiled) {
    constructedBy(PLATFORM, token, 'XPathExpression');
    makeSlots(this, 'XPathExpression', { compiled });
  }
}
const expressionOf = (o) => slotsOf(o, 'XPathExpression');
registerInterface('XPathExpression', (o) => expressionOf(o) !== undefined);
installXPathExpression(XPathExpression, {
  // (`result`, an XPathResult the caller offers for reuse, may be ignored: a new one is returned)
  evaluate: (expression, contextNode, type) => evaluate(expressionOf(expression).compiled, contextNode, type)
});

// XPathEvaluatorBase, which Document and XPathEvaluator both include: its steps, of arguments their generated bindings
// converted — every one before the resolver is asked anything.
export const xpathEvaluatorBase = {
  createExpression: (expression, resolver) => new XPathExpression(PLATFORM, compile(expression, resolver)),
  evaluate: (expression, contextNode, resolver, type) => evaluate(compile(expression, resolver), contextNode, type)
};
// (…stateless: its slots its brand alone)
export class XPathEvaluator {
  constructor() { makeSlots(this, 'XPathEvaluator'); }
}
registerInterface('XPathEvaluator', (o) => slotsOf(o, 'XPathEvaluator') !== undefined);
installXPathEvaluator(XPathEvaluator, {
  createExpression: (evaluator, expression, resolver) => xpathEvaluatorBase.createExpression(expression, resolver),
  // (…the node itself: a Node's lookupNamespaceURI is the resolver, with no `xml` binding added)
  createNSResolver: (evaluator, nodeResolver) => nodeResolver,
  evaluate: (evaluator, expression, contextNode, resolver, type) => xpathEvaluatorBase.evaluate(expression, contextNode, resolver, type)
});
globalThis.XPathResult = XPathResult;
globalThis.XPathExpression = XPathExpression;
globalThis.XPathEvaluator = XPathEvaluator;
