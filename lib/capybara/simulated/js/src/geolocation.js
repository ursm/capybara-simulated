// The Geolocation API (W3C Geolocation) and the Permissions API's `query` (W3C Permissions), generated from their IDL:
// what a request answers and the permissions' states are the engine's (geolocation.rs) — from the position the driver
// emulates (browser.rb `set_geolocation`, read through the `__csimGeolocationState` host function as JSON) — and each
// callback is called in a task of its own (the geolocation task source), a watch's again whenever the emulated
// position changes (`__csimGeolocationChanged`, in every window of the page).

import { EventTarget, dispatchWithOnHandler, installEventHandlerAttrs, Event } from './events.js';
import {
  defineGeolocation, defineGeolocationCoordinates, defineGeolocationPosition, defineGeolocationPositionError,
  definePermissions, installPermissionStatus
} from './generated/bindings.js';
import { PLATFORM, constructedBy, makeSlots, registerInterface, slotsOf, toBoolean, toDOMString, toUSVString } from './webidl.js';
import { DOMException } from './dom-exception.js';
import { queueTask, platformDateNow } from './timers.js';
import { reportError } from './platform-globals.js';

// The emulated source, as the driver set it last: JSON, `"null"` for none.
function emulatedSource() {
  try { return globalThis.__csimGeolocationState() || 'null'; } catch (_) { return 'null'; }
}

const coordinatesBinding = defineGeolocationCoordinates({
  init(s, fields) { s.fields = fields; },
  get_accuracy: (s) => s.fields[0],
  get_latitude: (s) => s.fields[1],
  get_longitude: (s) => s.fields[2],
  get_altitude: (s) => s.fields[3],
  get_altitudeAccuracy: (s) => s.fields[4],
  get_heading: (s) => s.fields[5],
  get_speed: (s) => s.fields[6]
});
const positionBinding = defineGeolocationPosition({
  init(s, fields) {
    s.coords = coordinatesBinding.create(fields);
    s.timestamp = fields[7];
  },
  get_coords: (s) => s.coords,
  get_timestamp: (s) => s.timestamp
});
// GeolocationPositionError's messages, by code — Chrome's.
const ERROR_MESSAGES = [null, 'User denied Geolocation', 'Position unavailable', 'Timeout expired'];
const errorBinding = defineGeolocationPositionError({
  init(s, code) { s.code = code; },
  get_code: (s) => s.code,
  get_message: (s) => ERROR_MESSAGES[s.code]
});
const POSITION_UNAVAILABLE = 2;
globalThis.GeolocationCoordinates = coordinatesBinding.interface;
globalThis.GeolocationPosition = positionBinding.interface;
globalThis.GeolocationPositionError = errorBinding.interface;

// "Call back with" a request's answer — a position, or an error's code — in a task: the success callback with a new
// GeolocationPosition, the error callback (where one was given) with a new GeolocationPositionError; what one throws
// reported. `live` says, as the task runs, whether it is still owed (a watch cleared since is not).
function callBack(answer, success, error, live = () => true) {
  queueTask(() => {
    if (!live()) return;
    const [callback, arg] = typeof answer === 'number' ? [error, () => errorBinding.create(answer)] : [success, () => positionBinding.create(answer)];
    if (callback === null) return;
    try { callback(arg()); } catch (e) { reportError(e, callback); }
  });
}
// "Request a position" (geolocation.rs `request`) — `watch` its watch's id, 0 for none: none for a document that is not
// fully active.
function requestPosition(options, watch = 0) {
  if (!globalThis.__dom.documentFullyActive()) return POSITION_UNAVAILABLE;
  return globalThis.__dom.geolocationRequest(emulatedSource(), watch, options.timeout, platformDateNow());
}

// A watch's callbacks, by its id (the engine's watch ids: `__dom.geolocationWatch`).
const watches = new Map();
const geolocationBinding = defineGeolocation({
  init() {},
  getCurrentPosition(_, success, error, options) {
    callBack(requestPosition(options), success, error);
  },
  // (…none for a document that is not fully active, whose request answers POSITION_UNAVAILABLE: 0)
  watchPosition(_, success, error, options) {
    if (!globalThis.__dom.documentFullyActive()) {
      callBack(POSITION_UNAVAILABLE, success, error);
      return 0;
    }
    const id = globalThis.__dom.geolocationWatch();
    watches.set(id, { success, error, options });
    watchRequest(id);
    return id;
  },
  clearWatch(_, id) {
    globalThis.__dom.geolocationClearWatch(id);
    watches.delete(id);
  }
});
// …a watch's: called back while its id is among the watch ids — but for the denial that removes it, whose error it is
// called back with all the same.
const PERMISSION_DENIED = 1;
function watchRequest(id) {
  const watch = watches.get(id), live = () => globalThis.__dom.geolocationWatches(id);
  const answer = requestPosition(watch.options, id);
  callBack(answer, watch.success, watch.error, answer === PERMISSION_DENIED ? undefined : live);
  if (!live()) watches.delete(id);
}
globalThis.Geolocation = geolocationBinding.interface;
export const geolocation = geolocationBinding.create();

// A PermissionStatus: the permission its descriptor names, what that says of what it needs (`member`), and the state it
// last had, which moves — `change` fired at it — when the emulated source does. Each a page holds is kept by a weak
// reference, to be told; one with a `change` listener by a strong one too (`listened`, events.js).
class PermissionStatus extends EventTarget {
  constructor(token, name, member, state) {
    constructedBy(PLATFORM, token, 'PermissionStatus');
    super();
    makeSlots(this, 'PermissionStatus', { name, member, state, listened: pinListened });
  }
}
const statusOf = (o) => slotsOf(o, 'PermissionStatus');
registerInterface('PermissionStatus', (o) => statusOf(o) !== undefined);
installPermissionStatus(PermissionStatus, {
  get_state: (status) => statusOf(status).state,
  get_name: (status) => statusOf(status).name,
  installEventHandlers: installEventHandlerAttrs
});
globalThis.PermissionStatus = PermissionStatus;
const statuses = new Set(), listenedStatuses = new Set();
function pinListened(status, listened) {
  if (listened) listenedStatuses.add(status);
  else listenedStatuses.delete(status);
}
// …each still held, those let go of forgotten.
function* heldStatuses() {
  for (const ref of statuses) {
    const status = ref.deref();
    if (status === undefined) statuses.delete(ref);
    else yield status;
  }
}

// `query(permissionDesc)` (Permissions §7.1): none for a window whose document is not fully active — an
// InvalidStateError — else its descriptor's `name`, a required DOMString naming a powerful feature, and what that
// descriptor must say of it (geolocation.rs `Needs`) — a TypeError or NotSupportedError, as Chrome words them — and a
// PermissionStatus of its state, resolved in a task.
const QUERY_ERROR = "Failed to execute 'query' on 'Permissions': ";
const NAME_ERROR = QUERY_ERROR + "Failed to read the 'name' property from 'PermissionDescriptor': ";
const NOT_SUPPORTED = 0, WORDS = 1;
function permissionState(name, member) {
  return globalThis.__dom.permissionState(name, emulatedSource(), member);
}
const permissionsBinding = definePermissions({
  init() {},
  query(_, descriptor) {
    if (globalThis.document !== undefined && !globalThis.__dom.documentFullyActive()) {
      throw new DOMException(QUERY_ERROR + 'The document is not active', 'InvalidStateError');
    }
    const raw = descriptor.name;
    if (raw === undefined) throw new TypeError(NAME_ERROR + 'Required member is undefined.');
    const name = toDOMString(raw, false, NAME_ERROR);
    const needs = globalThis.__dom.permissionMember(name);
    let member = null;
    if (needs !== undefined) {
      const v = descriptor[needs[0]];
      member = needs[1] ? String(toBoolean(v)) : v === undefined ? null : toUSVString(v, QUERY_ERROR);
    }
    const state = permissionState(name, member);
    if (typeof state !== 'string') {
      if (state[NOT_SUPPORTED]) throw new DOMException(QUERY_ERROR + state[WORDS], 'NotSupportedError');
      throw new TypeError(state[WORDS] ? QUERY_ERROR + state[WORDS] : NAME_ERROR + `The provided value '${name}' is not a valid enum value of type PermissionName.`);
    }
    return new Promise((resolve) => {
      queueTask(() => {
        const status = new PermissionStatus(PLATFORM, name, member, permissionState(name, member));
        for (const _ of heldStatuses());
        statuses.add(new WeakRef(status));
        resolve(status);
      });
    });
  }
});
globalThis.Permissions = permissionsBinding.interface;
export const permissions = permissionsBinding.create();

// The emulated source changed (browser.rb `set_geolocation`, which asks every window of the page): each watch is called
// back with what a request answers now, and each PermissionStatus whose state moved is told — `change` — none of it
// for a document that is not fully active (whose updates are "dropped on the floor").
globalThis.__csimGeolocationChanged = function () {
  if (!globalThis.__dom.documentFullyActive()) return;
  for (const id of globalThis.__dom.geolocationWatches()) {
    if (watches.has(id)) watchRequest(id);
  }
  for (const status of heldStatuses()) {
    const s = statusOf(status), state = permissionState(s.name, s.member);
    if (state === s.state) continue;
    s.state = state;
    queueTask(() => dispatchWithOnHandler(status, new Event('change')));
  }
};
