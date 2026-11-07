// DOMException and QuotaExceededError (Web IDL §3.14), apart from the events they are thrown beside: what nearly every
// module throws, so a module low in the graph can import it without closing a cycle through events.js.
import { convertDOMExceptionArguments, convertQuotaExceededErrorArguments, installDOMException, installQuotaExceededError } from './generated/bindings.js';
import { makeSlots, slotsOf, registerInterface, reflectConstruct, rootInterface } from './webidl.js';

// DOMException (Web IDL §3.14.1), generated from its IDL: an Error whose name, message and legacy code are its internal
// slots (`exceptionOf`) — read through the interface's getters, never own data a page could overwrite — any realm's
// to read: a structured clone of one is one. core-js's DOMException polyfill (Mastodon's `polyfills` chunk) reads
// `globalThis.DOMException.prototype` at module init, so it is there from the snapshot on.
// Its object is an Error's — made by Error for the class being constructed, so it has a stack, Error's own `message`
// there for that stack's head alone (the interface's getter answers it, as the slots hold it) — while the interface
// object's [[Prototype]] is %Function.prototype% and its prototype's Error's (Web IDL §3.14.1), as `extends Error`
// would not have it.
// (…an Error of `newTarget`'s, which is what gives it a stack: a QuotaExceededError's too)
const ErrorOfRealm = Error;
function makeException(newTarget, message, name) {
  const self = reflectConstruct(ErrorOfRealm, [message], newTarget);
  delete self.message;
  const s = makeSlots(self, 'DOMException');
  s.name = name;
  s.message = message;
  s.code = LEGACY_CODES[name] || 0;
  return self;
}
// (…a derived class's constructor, which makes no object of its own, nor reads `new.target.prototype` for one: the one read
// Web IDL has, as the object is made, after its arguments)
export class DOMException extends Error {
  constructor(message, name) {
    const converted = convertDOMExceptionArguments(arguments);
    message = converted[0];
    name = converted[1];
    return makeException(new.target, message, name);
  }
}
rootInterface(DOMException);
Object.setPrototypeOf(DOMException.prototype, Error.prototype);
// The legacy codes of the names that have one (Web IDL §3.14.1's table).
const LEGACY_CODES = {
  IndexSizeError:              1,  HierarchyRequestError:    3,
  WrongDocumentError:          4,  InvalidCharacterError:    5,
  NoModificationAllowedError:  7,  NotFoundError:            8,
  NotSupportedError:           9,  InUseAttributeError:     10,
  InvalidStateError:          11,  SyntaxError:             12,
  InvalidModificationError:   13,  NamespaceError:          14,
  InvalidAccessError:         15,  TypeMismatchError:       17,
  SecurityError:              18,  NetworkError:            19,
  AbortError:                 20,  URLMismatchError:        21,
  QuotaExceededError:         22,  TimeoutError:            23,
  InvalidNodeTypeError:       24,  DataCloneError:          25
};
// A DOMException's slots — any realm's — or undefined for anything else.
export const exceptionOf = (o) => slotsOf(o, 'DOMException');
registerInterface('DOMException', (o) => exceptionOf(o) !== undefined);
installDOMException(DOMException, {});

// QuotaExceededError (Web IDL §3.14.2): a DOMException named so, with the quota and the amount requested where its
// options give them — neither negative, nor the amount less than the quota.
export class QuotaExceededError extends DOMException {
  constructor(message, options) {
    const converted = convertQuotaExceededErrorArguments(arguments);
    message = converted[0];
    options = converted[1];
    const { quota = null, requested = null } = options;
    if (quota !== null && quota < 0) throw new RangeError("Failed to construct 'QuotaExceededError': The quota must not be negative.");
    if (requested !== null && requested < 0) throw new RangeError("Failed to construct 'QuotaExceededError': The requested amount must not be negative.");
    if (quota !== null && requested !== null && requested < quota) {
      throw new RangeError("Failed to construct 'QuotaExceededError': The requested amount must not be less than the quota.");
    }
    const self = makeException(new.target, message, 'QuotaExceededError');
    const slots = makeSlots(self, 'QuotaExceededError');
    slots.quota = quota;
    slots.requested = requested;
    return self;
  }
}
const quotaErrorOf = (o) => slotsOf(o, 'QuotaExceededError');
registerInterface('QuotaExceededError', (o) => quotaErrorOf(o) !== undefined);
installQuotaExceededError(QuotaExceededError, {});

// A DOMException's serialization (its [Serializable] steps): its name and message — and a QuotaExceededError's quota
// and amount requested — as plain data, which `deserializeException` makes one of this realm again. Shared by the
// structured clone and a worker's messages.
export function serializeException(e) {
  const s = exceptionOf(e), q = quotaErrorOf(e);
  return q ? { name: s.name, message: s.message, quota: q.quota, requested: q.requested } : { name: s.name, message: s.message };
}
export function deserializeException(data) {
  if (data.name === 'QuotaExceededError' && 'quota' in data) {
    return new QuotaExceededError(data.message, { quota: data.quota ?? undefined, requested: data.requested ?? undefined });
  }
  return new DOMException(data.message, data.name);
}
