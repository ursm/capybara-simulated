// In-process WPT gate: no automation backend; testdriver.js is self-contained.
//
// Vendor overrides for testdriver_internal hooks the in-process driver CAN
// answer. `get_computed_label` is the accessible-name computation: for the
// aria-element-reflection tests it is driven entirely by aria-labelledby /
// ariaLabelledByElements, so we implement that branch (the IDL getter already
// drops references that are out of scope, so only valid labels contribute).
(function () {
  if (!window.test_driver) return;

  function accessibleLabel(element) {
    if (!element) return '';
    // aria-labelledby / ariaLabelledByElements: the accessible name is the
    // space-joined text ("name from content") of the valid referenced elements.
    const refs = element.ariaLabelledByElements;
    if (refs && refs.length) {
      return Array.from(refs)
        .map(r => ((r.innerText != null ? r.innerText : r.textContent) || '').trim())
        .filter(Boolean)
        .join(' ');
    }
    const ariaLabel = element.getAttribute && element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();
    return '';
  }

  window.test_driver.get_computed_label = function (element) {
    return Promise.resolve(accessibleLabel(element));
  };

  // `test_driver.bless(intent, fn)` grants transient user activation (a real
  // automation backend does this via a trusted click). The in-process driver
  // models the transient-activation flag as `globalThis.__csimTransientActivation`
  // (read by navigator.userActivation.isActive, consumed by activation-gated
  // APIs like HTMLInputElement.showPicker()).
  window.test_driver.bless = function (intent, fn) {
    globalThis.__csimTransientActivation = true;
    try {
      return Promise.resolve(typeof fn === 'function' ? fn() : undefined);
    } catch (e) {
      return Promise.reject(e);
    }
  };

  // `test_driver.click` / `test_driver.send_keys` drive a trusted UA action on
  // an element. A real backend routes through WebDriver; the in-process driver
  // exposes the same capabilities its Ruby side uses (the click resolver and the
  // key-send engine) as handle-keyed bridge entry points. We obtain a handle for
  // the passed Node via __csimRegisterNode, then call them directly.

  // WebDriver "normalised keys" — the special code points (Unicode PUA U+E0xx)
  // map to the bridge's named-key atoms; everything else is printable text.
  // Keyed by code point (cp(0xE0xx)) rather than literal PUA characters so the
  // table is readable and unambiguous. Modifier keys stay held until the end of
  // the string (WebDriver keyboard model); a U+E000 NULL releases them.
  const cp = (n) => String.fromCodePoint(n);
  const WD_NULL  = cp(0xE000);
  const WD_SPACE = cp(0xE00D);
  const WD_NAMED = {
    [cp(0xE003)]: 'backspace', [cp(0xE004)]: 'tab',       [cp(0xE006)]: 'enter',
    [cp(0xE007)]: 'enter',     [cp(0xE00C)]: 'escape',    [cp(0xE00E)]: 'page_up',
    [cp(0xE00F)]: 'page_down', [cp(0xE010)]: 'end',       [cp(0xE011)]: 'home',
    [cp(0xE012)]: 'left',      [cp(0xE013)]: 'up',        [cp(0xE014)]: 'right',
    [cp(0xE015)]: 'down',      [cp(0xE017)]: 'delete'
  };
  // Left modifiers E008/E009/E00A + Meta E03D, and the right-hand variants
  // E050..E053 (WebDriver Level 2) — all fold to the same modifier name.
  const WD_MODIFIERS = {
    [cp(0xE008)]: 'shift', [cp(0xE009)]: 'control', [cp(0xE00A)]: 'alt', [cp(0xE03D)]: 'meta',
    [cp(0xE050)]: 'shift', [cp(0xE051)]: 'control', [cp(0xE052)]: 'alt', [cp(0xE053)]: 'meta'
  };

  function parseKeys(str) {
    const atoms = [];
    const held  = [];
    let text = '';
    const flush = () => { if (text) { atoms.push({ kind: 'text', value: text }); text = ''; } };
    for (const ch of String(str == null ? '' : str)) {
      if (ch === WD_NULL) { flush(); held.length = 0; continue; }   // NULL: release modifiers
      const mod = WD_MODIFIERS[ch];
      if (mod) { flush(); if (held.indexOf(mod) === -1) held.push(mod); continue; }
      const named = WD_NAMED[ch];
      const token = named || (ch === WD_SPACE ? ' ' : null);
      if (token != null) {
        flush();
        if (held.length) atoms.push({ kind: 'combo', parts: held.concat([token]) });
        else if (named)  atoms.push({ kind: 'key',  name: token });
        else             atoms.push({ kind: 'text', value: token });   // bare space
        continue;
      }
      if (held.length) { flush(); atoms.push({ kind: 'combo', parts: held.concat([ch]) }); }
      else text += ch;
    }
    flush();
    return atoms;
  }

  // Resolve on a macrotask so any DEFERRED default actions the key/click engine
  // schedules via setTimeout(0) have run before the test inspects state — Tab's
  // sequential-focus advance (__csimAdvanceFocus) and Enter's implicit submit
  // are parked on a 0ms timer, so a synchronous resolve would observe focus /
  // navigation that hasn't happened yet. The deferred default is enqueued before
  // this resolver, so FIFO timer order runs it first.
  function settleThen() {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(resolve, 0);
      else resolve();
    });
  }

  window.test_driver.send_keys = function (element, keys) {
    try {
      const h = globalThis.__csimRegisterNode && globalThis.__csimRegisterNode(element);
      if (h && typeof globalThis.__csimSendKeys === 'function') {
        globalThis.__csimSendKeys(h, parseKeys(keys));
      }
      return settleThen();
    } catch (e) {
      return Promise.reject(e);
    }
  };

  window.test_driver.click = function (element) {
    try {
      const h = globalThis.__csimRegisterNode && globalThis.__csimRegisterNode(element);
      // __csimClickResolve runs the trusted mousedown→mouseup→click sequence
      // (+ checkbox/radio activation + focus). It returns a navigate/submit
      // intent the Ruby side would action; an in-page test click ignores it.
      if (h && typeof globalThis.__csimClickResolve === 'function') {
        globalThis.__csimClickResolve(h, null);
      }
      return settleThen();
    } catch (e) {
      return Promise.reject(e);
    }
  };
})();
