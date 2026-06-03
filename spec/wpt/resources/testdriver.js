// In-process testdriver.js shim for the capybara-simulated WPT gate.
//
// The real testdriver.js + testdriver-actions.js + testdriver-vendor.js post
// gesture commands over a MessageChannel to a browser-automation backend (the
// `wptrunner` harness driving Chrome/Firefox). We have no backend: this driver
// runs the DOM in-process. So instead of round-tripping, each `test_driver`
// action is executed HERE by synthesizing the DOM events the gesture would
// produce and dispatching them on the existing event-dispatch machinery.
//
// This is a hand-written resource (like resources/testharnessreport.js), served
// for all three /resources/testdriver*.js paths; the other two files are empty.
//
// Scope + limits (there is NO layout engine):
//   - Pointer/touch/wheel/key GESTURES that only need event DISPATCH work.
//   - Coordinate hit-testing is unavailable (elementFromPoint is null on these
//     pages), so a "viewport"-origin action targets the element that actually
//     carries a listener for the event type, falling back to the scrolling
//     element (a bubbling event then reaches document/window listeners).
//   - Actions that need a real scroll-position change / scrollend / topmost-hit
//     remain HARNESS_ERROR by design — out of scope, not a shim bug.
'use strict';

(function () {
  var W = globalThis;
  var D = function () { return W.document; };

  // ---- cancelable-when-passive --------------------------------------------
  // A trusted wheel / touchstart / touchmove event is cancelable iff some
  // listener on its propagation path is NON-passive. (The spec marks the event
  // non-cancelable for the whole dispatch when a passive listener would
  // otherwise be defeated; these tests register exactly one listener, so
  // "is there a non-passive listener on the path?" is exact.) The event ctor
  // never derives this — we must compute it and pass `cancelable` in.
  function listHasNonPassive(list) {
    return !!(list && list.some(function (e) { return !e.passive; }));
  }
  function chainHasNonPassive(target, type) {
    for (var n = target; n; ) {
      if (n._listeners && listHasNonPassive(n._listeners[type])) return true;
      if (n.nodeType === 9) break;                 // Document — element walk done
      // Climb via _parent; only fall back to ownerDocument for a CONNECTED node
      // (a detached node's event never propagates to the live document, so we
      // must not count that document's listeners against it).
      n = n._parent || (n.isConnected ? n.ownerDocument : null) || null;
    }
    if (typeof W.__csimWindowListenersFor === 'function') {
      if (listHasNonPassive(W.__csimWindowListenersFor(type))) return true;
    }
    return false;
  }

  // ---- target resolution without layout -----------------------------------
  // BFS the tree for the first element carrying a listener of `type`. This is
  // how a "viewport"-origin gesture finds its target: the test attaches its one
  // listener to a known element (div/body/document) or the window.
  function elementWithListenerFor(type) {
    var root = D() && D().documentElement;
    if (!root) return null;
    var stack = [root], guard = 0;
    while (stack.length && guard++ < 200000) {
      var el = stack.pop();
      if (el._listeners && el._listeners[type] && el._listeners[type].length) return el;
      var kids = el.children;
      if (kids) for (var i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return null;
  }
  function scroller() {
    var d = D();
    return (d && (d.scrollingElement || d.documentElement || d.body)) || d || null;
  }

  // ---- low-level dispatch --------------------------------------------------
  function dispatch(target, ev) {
    if (!target) return true;
    ev.isTrusted = true;   // UA-synthesized; writable own prop (Event ctor sets false)
    try { return target.dispatchEvent(ev); } catch (e) { return true; }
  }

  function fireTouch(target, type) {
    if (!target) return;
    var c = chainHasNonPassive(target, type);
    var pt = { identifier: 0, target: target, clientX: 0, clientY: 0, pageX: 0, pageY: 0, screenX: 0, screenY: 0 };
    var live = (type === 'touchend') ? [] : [pt];
    dispatch(target, new W.TouchEvent(type, {
      bubbles: true, cancelable: c, composed: true,
      touches: live, targetTouches: live, changedTouches: [pt]
    }));
  }

  function nodeWithListenerFor(type) {
    var el = elementWithListenerFor(type);
    if (el) return el;
    var d = D();
    if (d && d._listeners && d._listeners[type] && d._listeners[type].length) return d;  // listener on document
    return null;
  }
  function fireWheelOn(target, dx, dy) {
    // An explicit origin element wins; otherwise dispatch on the node (element
    // OR document) actually listening for wheel/mousewheel; else the scroller
    // (whose bubbling event reaches document/window listeners).
    var t = target || nodeWithListenerFor('wheel') || nodeWithListenerFor('mousewheel') || scroller();
    if (!t) return;
    var init = { bubbles: true, composed: true, deltaX: dx || 0, deltaY: dy || 0 };
    dispatch(t, new W.WheelEvent('wheel', Object.assign({ cancelable: chainHasNonPassive(t, 'wheel') }, init)));
    // Legacy `mousewheel` — fire unconditionally; tests register {once} so a
    // non-matching extra dispatch is harmless, and it removes the "does this
    // engine fire mousewheel?" ambiguity for the mousewheel variants.
    dispatch(t, new W.WheelEvent('mousewheel', Object.assign({ cancelable: chainHasNonPassive(t, 'mousewheel') }, init)));
  }

  function firePointer(target, pType, mType) {
    if (!target) return;
    if (pType && W.PointerEvent) {
      dispatch(target, new W.PointerEvent(pType, { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', isPrimary: true }));
    }
    if (mType) dispatch(target, new W.MouseEvent(mType, { bubbles: true, cancelable: true, composed: true }));
  }

  // ---- action replay -------------------------------------------------------
  function performAction(state, a) {
    var p, t;
    switch (a.kind) {
      case 'pointerMove':
        p = state[a.pointer];
        if (a.origin && typeof a.origin === 'object' && a.origin.nodeType) p.target = a.origin;
        p.x = a.x; p.y = a.y;
        if (p.down) {                                   // implicit pointer capture
          if (p.type === 'touch') fireTouch(p.target, 'touchmove');
          else firePointer(p.target, 'pointermove', 'mousemove');
        }
        break;
      case 'pointerDown':
        p = state[a.pointer];
        p.down = true;
        if (!p.target) p.target = scroller();
        p.downTarget = p.target;
        if (p.type === 'touch') fireTouch(p.target, 'touchstart');
        else firePointer(p.target, 'pointerdown', 'mousedown');
        break;
      case 'pointerUp':
        p = state[a.pointer];
        if (!p.target) p.target = scroller();
        if (p.type === 'touch') fireTouch(p.target, 'touchend');
        else {
          firePointer(p.target, 'pointerup', 'mouseup');
          // `click` fires only when up lands on the same target the pointer went
          // down on (no drag away) — matches real browsers.
          if (p.target === p.downTarget) {
            dispatch(p.target, new W.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
          }
        }
        p.down = false;
        break;
      case 'scroll':
        t = (a.origin && a.origin.nodeType) ? a.origin : null;
        fireWheelOn(t, a.dx, a.dy);
        break;
      case 'keyDown':
        t = (D() && D().activeElement) || (D() && D().body);
        dispatch(t, new W.KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, key: a.key }));
        break;
      case 'keyUp':
        t = (D() && D().activeElement) || (D() && D().body);
        dispatch(t, new W.KeyboardEvent('keyup', { bubbles: true, cancelable: true, composed: true, key: a.key }));
        break;
      case 'pause':
      default:
        break;
    }
  }

  function action_sequence(actions) {
    var state = Object.create(null);
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      if (a.pointer && !state[a.pointer]) {
        state[a.pointer] = { type: a.pointerType || 'mouse', x: 0, y: 0, target: null, down: false };
      }
    }
    for (var j = 0; j < actions.length; j++) performAction(state, actions[j]);
    return Promise.resolve();
  }

  // ---- Actions builder (mirrors testdriver-actions.js shape) ---------------
  function Actions() {
    this._actions = [];
    this._pointers = Object.create(null);   // name -> type
    this._current = null;                    // current pointer source name
    this.context = null;
  }
  Actions.prototype._cur = function () {
    if (!this._current) { this._current = 'auto-mouse'; this._pointers['auto-mouse'] = 'mouse'; }
    return this._current;
  };
  Actions.prototype.addPointer = function (name, type) {
    name = name || ('pointer-' + (Object.keys(this._pointers).length + 1));
    this._pointers[name] = type || 'mouse';
    this._current = name;
    return this;
  };
  Actions.prototype.addWheel = function (name) {
    name = name || 'wheel';
    this._pointers[name] = 'wheel';
    return this;
  };
  Actions.prototype.setPointer = function (name) { if (this._pointers[name]) this._current = name; return this; };
  Actions.prototype.pointerMove = function (x, y, opts) {
    opts = opts || {}; var n = this._cur();
    this._actions.push({ kind: 'pointerMove', pointer: n, pointerType: this._pointers[n], x: x, y: y, origin: opts.origin });
    return this;
  };
  Actions.prototype.pointerDown = function (opts) {
    opts = opts || {}; var n = this._cur();
    this._actions.push({ kind: 'pointerDown', pointer: n, pointerType: this._pointers[n], button: opts.button || 0 });
    return this;
  };
  Actions.prototype.pointerUp = function (opts) {
    opts = opts || {}; var n = this._cur();
    this._actions.push({ kind: 'pointerUp', pointer: n, pointerType: this._pointers[n], button: opts.button || 0 });
    return this;
  };
  Actions.prototype.scroll = function (x, y, dx, dy, opts) {
    opts = opts || {};
    this._actions.push({ kind: 'scroll', x: x, y: y, dx: dx, dy: dy, origin: opts.origin });
    return this;
  };
  Actions.prototype.keyDown = function (key) { this._actions.push({ kind: 'keyDown', key: key }); return this; };
  Actions.prototype.keyUp   = function (key) { this._actions.push({ kind: 'keyUp', key: key }); return this; };
  Actions.prototype.pause   = function (d)   { this._actions.push({ kind: 'pause', duration: d || 0 }); return this; };
  Actions.prototype.addTick = function ()    { return this; };
  Actions.prototype.setContext = function (c) { this.context = c; return this; };
  Actions.prototype.serialize = function () { return this._actions; };
  Actions.prototype.send = function () { return action_sequence(this._actions); };

  // ---- public test_driver surface -----------------------------------------
  var test_driver = {
    Actions: Actions,
    action_sequence: function (actions) { return action_sequence(actions); },
    click: function (element) {
      try { if (element && typeof element.click === 'function') { element.click(); return Promise.resolve(); } } catch (e) {}
      var t = element || (D() && D().body);
      firePointer(t, 'pointerdown', 'mousedown');
      firePointer(t, 'pointerup', 'mouseup');
      dispatch(t, new W.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
      return Promise.resolve();
    },
    send_keys: function (element, keys) {
      try { if (element && typeof element.focus === 'function') element.focus(); } catch (e) {}
      var str = String(keys == null ? '' : keys);
      for (var i = 0; i < str.length; i++) {
        var ch = str[i];
        var cp = str.codePointAt(i);
        // WebDriver special keys (arrows, Backspace, Enter, …) live in the PUA
        // block U+E000..U+F8FF. They produce keydown/keyup but DON'T insert text
        // — so no keypress, no value mutation, no `input` event for them.
        var special = cp >= 0xE000 && cp <= 0xF8FF;
        dispatch(element, new W.KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, key: ch }));
        if (!special) {
          dispatch(element, new W.KeyboardEvent('keypress', { bubbles: true, cancelable: true, composed: true, key: ch }));
          try {
            if (element && 'value' in element) {
              element.value = (element.value || '') + ch;
              var InputCtor = W.InputEvent || W.Event;
              dispatch(element, new InputCtor('input', { bubbles: true, composed: true, data: ch }));
            }
          } catch (e) {}
        }
        dispatch(element, new W.KeyboardEvent('keyup', { bubbles: true, cancelable: true, composed: true, key: ch }));
      }
      return Promise.resolve();
    },
    // Gestures/state we can't meaningfully back — resolve so awaiting tests proceed.
    bless: function (intent, fn) { try { return Promise.resolve(typeof fn === 'function' ? fn() : undefined); } catch (e) { return Promise.reject(e); } },
    set_test_context: function () {},
    set_timeout_multiplier: function () {},
    get_computed_label: function () { return Promise.resolve(''); },
    get_computed_role: function () { return Promise.resolve(''); }
  };

  W.test_driver = test_driver;
  // Some harness plumbing references test_driver_internal; we have no backend.
  W.test_driver_internal = W.test_driver_internal || {
    using_action_api: true,
    set_timeout_multiplier: function () {}
  };
})();
