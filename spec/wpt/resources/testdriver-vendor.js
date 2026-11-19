// In-process WPT gate: no automation backend; testdriver.js is self-contained.
//
// Vendor overrides for testdriver_internal hooks the in-process driver CAN
// answer. `get_computed_label` is the accessible-name computation: for the
// aria-element-reflection tests it is driven entirely by aria-labelledby /
// ariaLabelledByElements, so we implement that branch (the IDL getter already
// drops references that are out of scope, so only valid labels contribute).
(function () {
  if (!window.test_driver) return;

  function labelFromRefs(refs) {
    return Array.from(refs)
      .map(r => ((r.innerText != null ? r.innerText : r.textContent) || '').trim())
      .filter(Boolean)
      .join(' ');
  }
  function accessibleLabel(element) {
    if (!element) return '';
    // aria-labelledby / ariaLabelledByElements: the accessible name is the
    // space-joined text ("name from content") of the valid referenced elements.
    const refs = element.ariaLabelledByElements;
    if (refs && refs.length) return labelFromRefs(refs);
    const ariaLabel = element.getAttribute && element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();
    // A PRESENT labelledby that resolved to no elements (dangling id, refs out
    // of scope) still SUPERSEDES the internals default — the element is named
    // "" rather than falling through (element-internals-aria-element-reflection
    // "should supersede"); only a fully-absent surface consults internals.
    if (refs != null) return '';
    // A custom element's ElementInternals supplies the DEFAULT semantics the
    // element's own attributes didn't override (ElementInternals-role).
    const internals = RustyRacer.steps.internalsOf(element);
    if (internals) {
      const irefs = internals.ariaLabelledByElements;
      if (irefs && irefs.length) return labelFromRefs(irefs);
      if (internals.ariaLabel) return String(internals.ariaLabel).trim();
    }
    return '';
  }

  window.test_driver.get_computed_label = function (element) {
    return Promise.resolve(accessibleLabel(element));
  };

  // WebDriver "Get Computed Role": the explicit `role` attribute's first VALID
  // token wins, else the ElementInternals default role. The returned vocabulary
  // is the computed one Chrome reports — a couple of authored roles compute to
  // a different name (img → image, directory → list, presentation → none).
  // Implicit HTML-AAM roles (tag-derived) are not modeled yet: an element with
  // neither surface computes to '' — the vendored consumers only exercise
  // explicit/internals roles.
  const KNOWN_ROLES = new Set([
    'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote',
    'button', 'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox',
    'complementary', 'contentinfo', 'definition', 'deletion', 'dialog',
    'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic',
    'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list',
    'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'menu', 'menubar',
    'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation',
    'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar',
    'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader',
    'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton',
    'status', 'strong', 'subscript', 'superscript', 'switch', 'tab', 'table',
    'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar',
    'tooltip', 'tree', 'treegrid', 'treeitem'
  ]);
  const COMPUTED_ROLE_ALIASES = { img: 'image', directory: 'list', presentation: 'none' };
  function validRoleOf(value) {
    for (const tok of String(value).trim().split(/\s+/)) {
      const t = tok.toLowerCase();
      if (KNOWN_ROLES.has(t)) return COMPUTED_ROLE_ALIASES[t] || t;
    }
    return '';
  }
  function computedRole(element) {
    if (!element) return '';
    const attr = element.getAttribute && element.getAttribute('role');
    if (attr) {
      const r = validRoleOf(attr);
      if (r) return r;
    }
    const internals = RustyRacer.steps.internalsOf(element);
    if (internals && internals.role != null) {
      const r = validRoleOf(internals.role);
      if (r) return r;
    }
    return '';
  }

  window.test_driver.get_computed_role = function (element) {
    return Promise.resolve(computedRole(element));
  };

  // `test_driver.bless(intent, fn)` grants transient user activation (a real
  // automation backend does this via a trusted click): the activation
  // notification steps a user's click runs (`activationNotify`), read by
  // navigator.userActivation and consumed by activation-gated APIs like
  // HTMLInputElement.showPicker(). An optional 3rd `context` argument blesses
  // ANOTHER window (a cross-window proxy) — that window's own steps.
  // `test_driver.set_permission`: the clipboard's, the session's to say (the rest of the Permissions API's answer no
  // test's setting here).
  window.test_driver.set_permission = function (descriptor, state) {
    RustyRacer.steps.setClipboardPermission(descriptor.name, state);
    return Promise.resolve();
  };
  window.test_driver.bless = function (intent, fn, context) {
    const target = context && context !== window && typeof context === 'object' ? context : globalThis;
    try { target.RustyRacer.steps.activationNotify(); } catch (e) {}
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
  // the passed Node via registerNode, then call them directly — the ones of
  // the window whose document holds it (a frame's element, clicked from its parent,
  // is that frame's to resolve: a realm answers for its own nodes' handles).
  function windowOf(element) {
    const doc = element && (element.ownerDocument || element);
    return (doc && doc.defaultView) || globalThis;
  }

  // Resolve on a macrotask, as a backend's reply comes, so what the action queued has run before the test reads state.
  function settleThen() {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(resolve, 0);
      else resolve();
    });
  }

  window.test_driver.send_keys = function (element, keys) {
    const w = windowOf(element);
    const h = w.RustyRacer.steps.registerNode && w.RustyRacer.steps.registerNode(element);
    // Dispatch the keys on the NEXT task, not synchronously — real
    // test_driver.send_keys is async, so a test that wires up an EventWatcher
    // AFTER calling send_keys (e.g. `Promise.all([send_keys(...), watcher.wait_for(...)])`,
    // where send_keys is evaluated first) registers its listeners before the keys
    // fire (historical-search-event). A second task then resolves.
    return new Promise((resolve, reject) => {
      const run = () => {
        try {
          // (…WebDriver's "element send keys": the engine reads its keys — a modifier held until the NULL key or the
          // end, the code points WebDriver names keys by — keys.rs `webdriver_keys`)
          if (h && typeof w.RustyRacer.steps.sendKeys === 'function') w.RustyRacer.steps.sendKeys(h, [{ kind: 'webdriver', value: String(keys == null ? '' : keys) }]);
        } catch (e) { reject(e); return; }
        if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(resolve, 0);
        else resolve();
      };
      if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(run, 0);
      else run();
    });
  };

  window.test_driver.click = function (element) {
    try {
      const w = windowOf(element);
      const h = w.RustyRacer.steps.registerNode && w.RustyRacer.steps.registerNode(element);
      // clickResolve runs the trusted mousedown→mouseup→click sequence
      // (+ checkbox/radio activation + focus). leavePending keeps any resulting
      // submit/navigate intent in its pending slot so the driver's drain actions
      // it — this JS-side click discards the return value the Ruby click path
      // would otherwise consume (so without it a target=_blank submit is lost).
      if (h && typeof w.RustyRacer.steps.clickResolve === 'function') {
        w.RustyRacer.steps.clickResolve(h, null, { leavePending: true });
      }
      return settleThen();
    } catch (e) {
      return Promise.reject(e);
    }
  };
})();
