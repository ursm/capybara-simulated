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
// Scope + limits — and these are the SHIM's, not the driver's:
//   - Pointer/touch/wheel/key GESTURES that only need event DISPATCH work.
//   - A pointer move aims at the point it names (`elementFromPoint`, from the
//     layout's real boxes): a viewport origin's point, the pointer's own moved, or
//     an element origin's centre plus the offset (that element the target). A
//     WHEEL action still discards its coordinates: it targets the element that
//     carries a listener for the event type, falling back to the scrolling
//     element (a bubbling event then reaches document/window listeners) — the
//     backlog, not a limit.
//   - Likewise an action that needs a real scroll-position change: the geometry
//     to move is there, `case 'scroll'` just fires a `wheel` event without
//     moving any offset. The subtests that need it are IN-SCOPE failures now
//     (they used to be listed out with a "no layout engine" reason).
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

  // ---- keyboard ------------------------------------------------------------
  // A key action — a key, by a character or the code point WebDriver names it by, pressed or released — is the
  // engine's keyboard's (keys.rs `KeyGesture`, form-fields.js `keyAction`): its events at what is focused, the
  // modifiers it keeps held between actions, its default actions. The modifiers held, as the engine's bits have them
  // (CTRL 1, META 2, ALT 4, SHIFT 8), are what a pointer action's events carry too.
  function keysHeld() {
    var held = W.RustyRacer.steps.keysHeld();
    return { shiftKey: (held & 8) !== 0, ctrlKey: (held & 1) !== 0, altKey: (held & 4) !== 0, metaKey: (held & 2) !== 0 };
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
    // (…along the composed event path the UA's event takes — through a slot and its shadow root to the host — and
    // the window, where it reaches the document)
    var path = W.RustyRacer.steps.composedPathOf(target);
    for (var i = 0; i < path.length; i++) {
      if (listHasNonPassive(W.RustyRacer.steps.listenersFor(path[i], type))) return true;
    }
    var top = path[path.length - 1];
    return !!(top && top.nodeType === 9 && top === D() && listHasNonPassive(W.RustyRacer.steps.windowListenersFor(type)));
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
      if (W.RustyRacer.steps.listenersFor(el, type).length) return el;
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
    if (typeof W.RustyRacer.steps.dispatchTrusted === 'function') {
      try { return W.RustyRacer.steps.dispatchTrusted(target, ev); } catch (e) { return true; }
    }
    ev.isTrusted = true;
    try { return target.dispatchEvent(ev); } catch (e) { return true; }
  }

  function fireTouch(target, type) {
    if (!target) return;
    var c = chainHasNonPassive(target, type);
    var pt = new W.Touch({ identifier: 0, target: target, clientX: 0, clientY: 0, pageX: 0, pageY: 0, screenX: 0, screenY: 0 });
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
    if (d && W.RustyRacer.steps.listenersFor(d, type).length) return d;  // listener on document
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

  // A mouse pointer's action — a move, a press, a release (`phase`: 1, 2, 4) at what is at the pointer — the driver's own
  // gesture, as the engine sequences it (pointer.rs `MousePointer`): the boundary events, the compatibility mouse events a
  // canceled `pointerdown` holds back, the press's focus, `:active`, pointer capture, the click at what the press and the
  // release share.
  function mouseAction(phase, target, x, y, button) {
    W.RustyRacer.steps.pointerAction(phase, target, x || 0, y || 0, button || 0, keysHeld());
  }

  // ---- action replay -------------------------------------------------------
  function performAction(state, a) {
    var p, t;
    switch (a.kind) {
      case 'pointerMove':
        p = state[a.pointer];
        if (a.origin && typeof a.origin === 'object' && a.origin.nodeType) {
          // (…an element origin: the offset from its centre — the element itself the target)
          var box = a.origin.getBoundingClientRect();
          p.x = box.left + box.width / 2 + (a.x || 0); p.y = box.top + box.height / 2 + (a.y || 0);
          // (…what is at that point inside it, in its shadow tree too — not retargeted: the event is, as it climbs; the
          // element itself where what is there is not inside it)
          p.target = W.RustyRacer.steps.pointerTargetAt ? W.RustyRacer.steps.pointerTargetAt(a.origin, p.x, p.y) : a.origin;
        } else {
          // (…a viewport origin — or the pointer's own — the point named, and what is there the target)
          if (a.origin === 'pointer') { p.x = (p.x || 0) + (a.x || 0); p.y = (p.y || 0) + (a.y || 0); }
          else { p.x = a.x || 0; p.y = a.y || 0; }
          var hit = W.RustyRacer.steps.pointerTargetAt ? W.RustyRacer.steps.pointerTargetAt(null, p.x, p.y) : D() && D().elementFromPoint(p.x, p.y);
          p.target = hit || scroller();
        }
        // (…a touch's moves and its end at the element it started on: Touch Events)
        if (p.type === 'touch') { if (p.down) fireTouch(p.downTarget, 'touchmove'); }
        else mouseAction(1, p.target, p.x, p.y, 0);
        break;
      case 'pointerDown':
        p = state[a.pointer];
        p.down = true;
        if (!p.target) p.target = scroller();
        p.downTarget = p.target;
        if (p.type === 'touch') fireTouch(p.target, 'touchstart');
        else mouseAction(2, p.target, p.x, p.y, a.button);
        break;
      case 'pointerUp':
        p = state[a.pointer];
        if (!p.target) p.target = scroller();
        if (p.type === 'touch') fireTouch(p.downTarget || p.target, 'touchend');
        else mouseAction(4, p.target, p.x, p.y, a.button);
        p.down = false;
        break;
      case 'scroll':
        t = (a.origin && a.origin.nodeType) ? a.origin : null;
        fireWheelOn(t, a.dx, a.dy);
        break;
      case 'keyDown':
        W.RustyRacer.steps.keyAction(true, a.key);
        break;
      case 'keyUp':
        W.RustyRacer.steps.keyAction(false, a.key);
        break;
      case 'pause':
      default:
        break;
    }
  }

  function action_sequence(actions) {
    W.RustyRacer.steps.keyRelease();   // each chain starts with no keys depressed
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
  // (…the pointer buttons by name, as upstream's builder names them: `{button: actions.ButtonType.LEFT}`)
  Actions.prototype.ButtonType = { LEFT: 0, MIDDLE: 1, RIGHT: 2, BACK: 3, FORWARD: 4 };
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
      // A WebDriver element click: the pointer moved to the element's centre, pressed and released there — the
      // driver's own gesture (`mouseAction`), trusted, its activation the click's dispatch's. (testdriver-vendor.js
      // replaces this with the driver's `clickResolve`, which scrolls the element into view first.)
      var t = element || (D() && D().body);
      var box = t.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
      mouseAction(1, t, x, y, 0);
      mouseAction(2, t, x, y, 0);
      mouseAction(4, t, x, y, 0);
      return settled();
    },
    // Gestures/state we can't meaningfully back — resolve so awaiting tests proceed.
    bless: function (intent, fn) { try { return settled(typeof fn === 'function' ? fn() : undefined); } catch (e) { return Promise.reject(e); } },
    set_test_context: function () {},
    set_timeout_multiplier: function () {},
    get_computed_label: function () { return Promise.resolve(''); },
    get_computed_role: function () { return Promise.resolve(''); },
    // WebDriver "Delete All Cookies": the session's cookie store emptied (the host's, cookie_jar.rs) — every cookie, not
    // only those of the active document's address, which is all a test that starts from none tells apart.
    delete_all_cookies: function () {
      try { W.RustyRacer.host.deleteAllCookies(); return Promise.resolve(); } catch (e) { return Promise.reject(e); }
    }
  };

  W.test_driver = test_driver;
  // Some harness plumbing references test_driver_internal; we have no backend.
  W.test_driver_internal = W.test_driver_internal || {
    using_action_api: true,
    set_timeout_multiplier: function () {}
  };
})();
