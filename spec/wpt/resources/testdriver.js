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

  // Every test_driver action is GENUINELY ASYNC in real testdriver — it posts a
  // command to the automation backend and awaits a reply (a macrotask). We mirror
  // that by resolving on a macrotask (setTimeout 0), NOT synchronously. This is
  // load-bearing, not cosmetic: a test that awaits an action inside a loop —
  // `while (input.scrollLeft === 0) { await test_driver.send_keys(el, ArrowRight) }`
  // (input-text-scroll-…-arrow-keys.html) — must yield to the event loop each turn
  // so the harness timeout timer can fire (the test is DESIGNED to fail-by-timeout
  // when no scroll happens, which is our case: no layout → scrollLeft never moves).
  // Resolving synchronously (Promise.resolve) instead keeps the loop in a tight
  // MICROTASK self-spin that starves the macrotask queue / virtual clock, so the
  // checkpoint never drains and the timeout never fires → V8 OOM. Deferring to a
  // macrotask bounds the loop by the runner's drain budget and lets it complete.
  function settled(value) {
    return new Promise(function (resolve) { setTimeout(function () { resolve(value); }, 0); });
  }

  // ---- keyboard: WebDriver PUA codes + trusted-input default actions -------
  // testdriver send_keys / Actions pass raw WebDriver "Normalised key" chars in
  // the U+E000.. PUA block; real input surfaces the named `key`. Map at least the
  // keys whose default action this driver models (Tab → focus navigation).
  var WD_KEYS = {
    '': 'Backspace', '': 'Tab', '': 'Enter', '': 'Enter',
    '': 'Shift', '': 'Shift', '': 'Control', '': 'Control',
    '': 'Alt', '': 'Alt', '': 'Escape', '': ' ', '': 'Delete',
    '': 'PageUp', '': 'PageDown', '': 'End', '': 'Home',
    '': 'ArrowLeft', '': 'ArrowUp', '': 'ArrowRight', '': 'ArrowDown'
  };
  function keyName(ch) { return WD_KEYS[ch] || ch; }
  var __shiftHeld = false;
  // Track modifier state across a key transition; returns true for a pure
  // modifier key (no text / no further default action).
  function trackModifier(name, down) {
    if (name === 'Shift') { __shiftHeld = down; return true; }
    return name === 'Control' || name === 'Alt' || name === 'Meta';
  }
  // The default action this driver ties to a trusted key press. Today: Tab moves
  // focus through the sequential-focus-navigation order (engine in dom-nodes.js).
  // Only runs when the keydown wasn't preventDefault'd — matching real browsers.
  function keyDefaultAction(name, keydownEv) {
    if (keydownEv && keydownEv.defaultPrevented) return;
    if (name === 'Tab' && typeof W.__csimAdvanceFocus === 'function') {
      W.__csimAdvanceFocus(__shiftHeld);
    } else if ((name === 'ArrowDown' || name === 'ArrowUp' || name === 'ArrowLeft' || name === 'ArrowRight') &&
               typeof W.__csimArrowKeyDefault === 'function') {
      // Arrow-key default on a focused radio (group navigation) / single-line select.
      var t = D() && D().activeElement;
      if (t) W.__csimArrowKeyDefault(t, name);
    }
  }

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
    // WebDriver input injection is a user-agent action → trusted. Route through
    // the driver's trusted-dispatch hook so the public dispatchEvent() IDL
    // path (which sets isTrusted=false) doesn't strip the trusted flag.
    if (typeof W.__csimDispatchTrusted === 'function') {
      try { return W.__csimDispatchTrusted(target, ev); } catch (e) { return true; }
    }
    ev.isTrusted = true;
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
    if (mType) {
      var ev = new W.MouseEvent(mType, { bubbles: true, cancelable: true, composed: true });
      dispatch(target, ev);
      // HTML mousedown default action: move focus to the clicked element, or — if
      // it isn't a focus target — reset focus to the body. The Capybara click path
      // runs the focus half in __csimClickResolve; the testdriver-injected pointer
      // sequence needs both halves. target.focus() is self-gating: it focuses a
      // focusable target, delegates into a (possibly closed) delegatesFocus shadow
      // host, and no-ops otherwise. After it, document.activeElement === target iff
      // the target took (or delegated) focus; if not, the click landed on
      // non-focusable content and focus moves to the body (blur the prior focus).
      // Only blur when the prior active element is STILL focused — if focus()'s
      // focusin handler moved focus elsewhere, that new focus is legitimate and
      // must not be clobbered.
      // (shadow-dom/focus/click-focus-delegatesFocus-*, focus-click-on-shadow-host)
      if (mType === 'mousedown' && !ev.defaultPrevented && typeof target.focus === 'function') {
        var doc = D();
        var prevActive = doc && doc._activeElement;
        try { W.__csimFocusModality = 'pointer'; } catch (e) {}   // pointer-driven focus → not :focus-visible
        try { target.focus(); } catch (e) {}
        if (doc && doc.activeElement !== target && doc._activeElement === prevActive &&
            prevActive && typeof prevActive.blur === 'function') {
          try { prevActive.blur(); } catch (e) {}
        }
      }
    }
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
      case 'keyDown': {
        var dkn = keyName(a.key);
        var dmod = trackModifier(dkn, true);   // sets __shiftHeld before the event/default
        t = (D() && D().activeElement) || (D() && D().body);
        // WebDriver special keys (arrows, Backspace, Enter, …) are PUA U+E000..F8FF.
        var dcp = String(a.key).codePointAt(0);
        var dspecial = dcp >= 0xE000 && dcp <= 0xF8FF;
        var dEv = new W.KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, key: dkn, shiftKey: __shiftHeld });
        dispatch(t, dEv);
        if (!dspecial) {
          // Printable key: keypress + insert the char (through the `value` setter,
          // so e.g. a filter combobox re-filters) + `input` — mirrors send_keys.
          dispatch(t, new W.KeyboardEvent('keypress', { bubbles: true, cancelable: true, composed: true, key: dkn, shiftKey: __shiftHeld }));
          if (!dEv.defaultPrevented) {
            try {
              if (t && 'value' in t) {
                t.value = (t.value || '') + a.key;
                dispatch(t, new (W.InputEvent || W.Event)('input', { bubbles: true, composed: true, data: a.key }));
              }
            } catch (e) {}
          }
        } else if (dkn === 'Backspace') {
          if (!dEv.defaultPrevented) {
            try {
              if (t && 'value' in t && typeof t.value === 'string' && t.value.length) {
                t.value = t.value.slice(0, -1);
                dispatch(t, new (W.InputEvent || W.Event)('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
              }
            } catch (e) {}
          }
        } else if (!dmod) {
          keyDefaultAction(dkn, dEv);          // Tab → sequential focus navigation, etc.
        }
        break;
      }
      case 'keyUp': {
        var ukn = keyName(a.key);
        trackModifier(ukn, false);
        t = (D() && D().activeElement) || (D() && D().body);
        dispatch(t, new W.KeyboardEvent('keyup', { bubbles: true, cancelable: true, composed: true, key: ukn, shiftKey: __shiftHeld }));
        break;
      }
      case 'pause':
      default:
        break;
    }
  }

  function action_sequence(actions) {
    __shiftHeld = false;   // each action chain starts with no keys depressed
    var state = Object.create(null);
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      if (a.pointer && !state[a.pointer]) {
        state[a.pointer] = { type: a.pointerType || 'mouse', x: 0, y: 0, target: null, down: false };
      }
    }
    for (var j = 0; j < actions.length; j++) performAction(state, actions[j]);
    return settled();
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
      // A WebDriver click is real input injection: a full pointer sequence
      // (pointerdown/mousedown, pointerup/mouseup) then a TRUSTED click. We
      // dispatch all of them through `dispatch()` (trusted), and the engine's
      // activation behaviour (checkbox toggle, form submit, anchor navigation,
      // <summary> toggle, …) runs inside the click's dispatch. We deliberately
      // do NOT call element.click(): that IDL method fires an UNtrusted click
      // (per spec), which would defeat the injection's trusted semantics.
      var t = element || (D() && D().body);
      firePointer(t, 'pointerdown', 'mousedown');
      firePointer(t, 'pointerup', 'mouseup');
      dispatch(t, new W.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 }));
      return settled();
    },
    send_keys: function (element, keys) {
      try { W.__csimFocusModality = 'keyboard'; } catch (e) {}   // keyboard-driven → :focus-visible applies
      try { if (element && typeof element.focus === 'function') element.focus(); } catch (e) {}
      var str = String(keys == null ? '' : keys);
      __shiftHeld = false;   // start fresh; a modifier in `keys` stays held for
                             // the rest of THIS call (WebDriver sticky), but does
                             // not leak into a later send_keys / Actions chain
      for (var i = 0; i < str.length; i++) {
        var ch = str[i];
        var cp = str.codePointAt(i);
        // WebDriver special keys (arrows, Backspace, Enter, …) live in the PUA
        // block U+E000..U+F8FF. They produce keydown/keyup but DON'T insert text
        // — so no keypress, no value mutation, no `input` event for them.
        var special = cp >= 0xE000 && cp <= 0xF8FF;
        var kn = keyName(ch);
        var isMod = trackModifier(kn, true);   // sets __shiftHeld for a held Shift
        var kdEv = new W.KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, key: kn, shiftKey: __shiftHeld });
        dispatch(element, kdEv);
        if (!special) {
          dispatch(element, new W.KeyboardEvent('keypress', { bubbles: true, cancelable: true, composed: true, key: kn, shiftKey: __shiftHeld }));
          try {
            if (element && 'value' in element) {
              element.value = (element.value || '') + ch;
              var InputCtor = W.InputEvent || W.Event;
              dispatch(element, new InputCtor('input', { bubbles: true, composed: true, data: ch }));
            }
          } catch (e) {}
        } else if (!isMod) {
          keyDefaultAction(kn, kdEv);          // Tab → sequential focus navigation
        }
        dispatch(element, new W.KeyboardEvent('keyup', { bubbles: true, cancelable: true, composed: true, key: kn, shiftKey: __shiftHeld }));
      }
      return settled();
    },
    // Gestures/state we can't meaningfully back — resolve so awaiting tests proceed.
    bless: function (intent, fn) { try { return settled(typeof fn === 'function' ? fn() : undefined); } catch (e) { return Promise.reject(e); } },
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
