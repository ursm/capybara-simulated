// Driver-side runtime running inside a single mini_racer Context.
// `__csim_bundle` is the IIFE exposing happy-dom (built by build.mjs).
// Every Capybara session shares this Context — DOM state is reset per
// visit by recreating the window, never the V8 isolate.

(function () {
  const {Window, URL: WhatwgURL, URLSearchParams: WhatwgURLSearchParams,
         installXPath} = globalThis.__csim_bundle;
  if (!globalThis.URL) globalThis.URL = WhatwgURL;
  if (!globalThis.URLSearchParams) globalThis.URLSearchParams = WhatwgURLSearchParams;

  const handles = new Map();
  let nextHandleId = 0;

  // Capybara's `have_text` matchers and several internal checks call into
  // `visibleText` repeatedly against the same handle while polling. The
  // text-collection walks happy-dom's textContent / styles each call, so
  // re-running it 1000+ times per spec adds up. Cache by handle and drop
  // the whole cache the moment any mutating runtime method runs (or
  // `drainTimers` advances the virtual clock — Stimulus / Turbo timers
  // may have rewritten the page). The cache is intentionally narrow:
  // we measured a broader MutationObserver-driven cache as a wash, since
  // the dispatch overhead ate the cache wins; pinning a bare `Map.clear()`
  // to known-mutating call sites is much cheaper.
  const visibleTextCache = new Map();
  function clearReadCache() { if (visibleTextCache.size) visibleTextCache.clear(); }
  let currentWindow = null;
  let currentDocument = null;
  let activeHandleId = null;

  const modalQueue = [];
  let modalResponses = {alert: [], confirm: [], prompt: []};
  // Stack of {type, text, response} pushed by accept_modal /
  // dismiss_modal blocks; consumed by the modal stubs above.
  const modalHandlers = [];
  let asyncSlot = null;

  function track(node) {
    if (node == null) return null;
    for (const [id, n] of handles) if (n === node) return id;
    const id = ++nextHandleId;
    handles.set(id, node);
    return id;
  }
  function lookup(id) {
    if (id == null) return null;
    const node = handles.get(id);
    if (!node) throw new Error('stale or unknown node handle: ' + id);
    // Element is detached from the live document — surface a stale-handle
    // error so Capybara's automatic_reload retry kicks in.
    if (node.nodeType === 1 && node.isConnected === false) {
      throw new Error('stale or unknown node handle: ' + id + ' (detached)');
    }
    return node;
  }

  function resetState() {
    if (currentWindow) {
      try { currentWindow.happyDOM && currentWindow.happyDOM.close && currentWindow.happyDOM.close(); }
      catch (_) {}
    }
    handles.clear();
    visibleTextCache.clear();
    nextHandleId = 0;
    activeHandleId = null;
    modalQueue.length = 0;
    modalHandlers.length = 0;
    asyncSlot = null;
    currentWindow = null;
    currentDocument = null;
    if (typeof globalThis.__csim_clearTimers === 'function') {
      try { globalThis.__csim_clearTimers(); } catch (_) {}
    }
  }

  // happy-dom keys its private fields with module-level `Symbol("name")`s,
  // so within a single bundle a description maps to one stable symbol.
  // Cache by description to skip the O(symbols) walk on hot paths
  // (`MutationObserver.observe` runs this every time).
  const SYMBOL_CACHE = new Map();
  function findHDSymbol(obj, description) {
    let sym = SYMBOL_CACHE.get(description);
    if (sym) return sym;
    sym = Object.getOwnPropertySymbols(obj).find((s) => s.description === description);
    if (sym) SYMBOL_CACHE.set(description, sym);
    return sym;
  }

  function patchWindowGlobals(win) {
    // happy-dom expects a handful of constructors to live on the window
    // because page-supplied scripts and selector parsers grab them via
    // `this.window.SyntaxError` etc. mini_racer's bare V8 isolate does not
    // wire those up automatically.
    const PASS = ['SyntaxError', 'TypeError', 'Error', 'RangeError',
                  'ReferenceError', 'Promise', 'Map', 'Set', 'WeakMap',
                  'WeakSet', 'Symbol', 'Proxy', 'Reflect', 'Array',
                  'Object', 'String', 'Number', 'Boolean', 'JSON',
                  'Math', 'Date', 'RegExp', 'ArrayBuffer', 'Uint8Array',
                  'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array',
                  'Int32Array', 'Float32Array', 'Float64Array', 'DataView'];
    for (const name of PASS) {
      if (typeof globalThis[name] !== 'undefined' && !win[name]) {
        win[name] = globalThis[name];
      }
    }
    // Modal stubs — happy-dom does not implement alert/confirm/prompt.
    // Two response paths live in parallel:
    //
    //   * `modalHandlers` — text-matched handlers pushed by
    //     `accept_modal` / `dismiss_modal` blocks. Picked first because
    //     they encode the user's intent and support nesting.
    //   * `modalResponses` — legacy unkeyed FIFO queue still consumed
    //     when no matching handler is found, kept for backwards
    //     compatibility with code that calls `set_modal_responses`
    //     directly.
    //
    // For `prompt(message, defaultValue)`, falling through to the
    // default response returns the page-supplied default when no
    // handler / queue entry overrides it.
    const mkResponder = (type) => function (message, defaultValue) {
      const msg = message == null ? null : String(message);
      const recorded = {type, message: msg, response: null};
      const handlerIdx = modalHandlers.findIndex((h) => h.type === type && modalTextMatches(h.text, msg));
      let resolved = false;
      if (handlerIdx >= 0) {
        const handler = modalHandlers[handlerIdx];
        modalHandlers.splice(handlerIdx, 1);
        recorded.response = encodeModalResponse(type, handler.response, defaultValue);
        resolved = true;
      } else {
        const queue = modalResponses[type] || [];
        if (queue.length > 0) {
          recorded.response = encodeModalResponse(type, queue.shift(), defaultValue);
          resolved = true;
        }
      }
      if (!resolved) {
        if (type === 'prompt') recorded.response = defaultValue == null ? null : String(defaultValue);
        else                   recorded.response = type === 'confirm' ? true : undefined;
      }
      modalQueue.push(recorded);
      return recorded.response;
    };
    function encodeModalResponse(type, v, defaultValue) {
      if (type !== 'prompt') return v;
      if (v === false) return null;
      if (v == null)   return defaultValue == null ? '' : String(defaultValue);
      return v;
    }
    function modalTextMatches(matcher, message) {
      if (matcher == null) return true;
      if (typeof matcher === 'string') return String(message || '').indexOf(matcher) >= 0;
      if (typeof matcher === 'object' && 'regexp' in matcher) {
        try {
          const flags = decodeRegexpFlags(matcher.flags || 0);
          return new RegExp(matcher.regexp, flags).test(String(message || ''));
        } catch (_) { return false; }
      }
      return false;
    }
    function decodeRegexpFlags(rubyFlags) {
      // Ruby Regexp#options bitset: 1=IGNORECASE, 2=EXTENDED, 4=MULTILINE.
      let s = '';
      if (rubyFlags & 1) s += 'i';
      if (rubyFlags & 4) s += 'm';
      return s;
    }
    win.alert = mkResponder('alert');
    win.confirm = mkResponder('confirm');
    win.prompt = mkResponder('prompt');
    // Replace happy-dom's real-time timer scheduler with our synchronous
    // queue so drainTimers() can run pending callbacks on demand. Without
    // this, setTimeout-based handlers (jQuery's $(elem).click → setTimeout)
    // never fire because the driver runs the test in a single tick.
    win.setTimeout    = globalThis.setTimeout;
    win.clearTimeout  = globalThis.clearTimeout;
    win.setInterval   = globalThis.setInterval;
    win.clearInterval = globalThis.clearInterval;
    win.setImmediate  = globalThis.setImmediate;
    win.clearImmediate = globalThis.clearImmediate;
    win.queueMicrotask = globalThis.queueMicrotask;
    win.requestAnimationFrame = (cb) => globalThis.setTimeout(() => cb(Date.now()), 16);
    win.cancelAnimationFrame  = (id) => globalThis.clearTimeout(id);
    installValidationMessages(win);
    installMutationObserverPin(win);
    installAttrNodeValue(win);
    installXPath(win);
  }

  // happy-dom 20's `Attr` class implements `value` / `textContent` / `name`
  // but skips `nodeValue`, so it inherits `Node.prototype.nodeValue` which
  // returns `null`. The DOM spec says `Attr.nodeValue === Attr.value`
  // (https://dom.spec.whatwg.org/#dom-node-nodevalue), and any XPath engine
  // (including wgxpath) reads attributes via `nodeValue` to compute their
  // string-value — without this shim every attribute compares as the string
  // `"null"` and predicates like `[@id = //label/@for]` collapse to
  // `"null" === "null"` (matches every element with any id).
  function installAttrNodeValue(win) {
    const proto = win.Attr && win.Attr.prototype;
    if (!proto || proto.__csim_node_value) return;
    Object.defineProperty(proto, 'nodeValue', {
      configurable: true,
      get() { return this.value; },
      set(v) { this.value = v; }
    });
    proto.__csim_node_value = true;
  }

  // happy-dom's MutationObserverListener wraps its dispatch arrow in a
  // `WeakRef` with no other strong reference. V8 collects it before the
  // next mutation arrives; `target[mutationListeners]` still carries the
  // listener but `callback.deref()` returns undefined and every record
  // (plus the subtree-propagation hop in `appendChild`) is silently
  // dropped. Replace each WeakRef with a strong-reference shim that
  // keeps the same `.deref()` shape.
  function installMutationObserverPin(win) {
    const MO = win.MutationObserver;
    if (!MO || !MO.prototype || MO.prototype.__csim_pinned) return;
    const origObserve = MO.prototype.observe;
    MO.prototype.observe = function (target, options) {
      const result = origObserve.call(this, target, options);
      if (target && typeof target === 'object') {
        const sym = findHDSymbol(target, 'mutationListeners');
        const listeners = sym && target[sym];
        if (listeners && listeners.length) {
          for (const ml of listeners) {
            const cb = ml && ml.callback;
            if (cb && typeof cb.deref === 'function' && !cb.__csim_strong) {
              const fn = cb.deref();
              if (fn) {
                ml.callback = {deref() { return fn; }, __csim_strong: true};
              }
            }
          }
        }
      }
      return result;
    };
    MO.prototype.__csim_pinned = true;
  }

  // happy-dom computes `validity` flags but always reports an empty
  // `validationMessage`. Capybara's `have_field validation_message:` test
  // and Rails apps that surface the constraint-validation message rely
  // on the Chrome-style English defaults; shim them once per Window.
  function installValidationMessages(win) {
    const protos = [win.HTMLInputElement && win.HTMLInputElement.prototype,
                    win.HTMLTextAreaElement && win.HTMLTextAreaElement.prototype,
                    win.HTMLSelectElement && win.HTMLSelectElement.prototype];
    for (const proto of protos) {
      if (!proto || proto.__csim_validation_patched) continue;
      Object.defineProperty(proto, 'validationMessage', {
        configurable: true,
        get() {
          if (!this.validity || this.validity.valid) return '';
          const v = this.validity;
          if (v.valueMissing)    return 'Please fill out this field.';
          if (v.typeMismatch)    return 'Please enter a valid value.';
          if (v.patternMismatch) return 'Please match the requested format.';
          if (v.tooShort)        return 'Please lengthen this text to ' + this.minLength + ' characters or more.';
          if (v.tooLong)         return 'Please shorten this text to ' + this.maxLength + ' characters or less.';
          if (v.rangeUnderflow)  return 'Value must be greater than or equal to ' + this.min + '.';
          if (v.rangeOverflow)   return 'Value must be less than or equal to ' + this.max + '.';
          if (v.stepMismatch)    return 'Please enter a valid value.';
          if (v.badInput)        return 'Please enter a number.';
          if (v.customError && this.__csim_customMessage) return this.__csim_customMessage;
          return '';
        }
      });
      proto.__csim_validation_patched = true;
    }
  }

  // happy-dom's CustomElementRegistry stubs out the upgrade step
  // (`upgrade(_root) { /* Do nothing */ }`), so existing tags in the
  // parsed DOM never get promoted to their custom element class. This
  // breaks Turbo: a `<turbo-frame>` in server-rendered HTML stays as a
  // plain HTMLElement and FrameController is never constructed, so frame
  // form submissions fall through to a session-level handler that does
  // not attach the `Turbo-Frame` request header. Patch `define` to walk
  // the document and re-create matching elements through
  // `document.createElement`, which runs the registered constructor and
  // wires `connectedCallback` on insert.
  function installCustomElementUpgrade(win) {
    if (!win.customElements || win.customElements.__csim_patched) return;
    const registry = win.customElements;
    const origDefine = registry.define.bind(registry);
    registry.define = function (name, ctor, options) {
      const out = origDefine(name, ctor, options);
      try { upgradeExisting(name); } catch (_) {}
      return out;
    };
    registry.__csim_patched = true;

    function upgradeExisting(name) {
      const doc = currentDocument;
      if (!doc || !doc.getElementsByTagName) return;
      const ctor = registry.get(name);
      const matches = Array.from(doc.getElementsByTagName(name));
      for (const old of matches) {
        if (ctor && old instanceof ctor) {
          // happy-dom 20's auto-upgrade swaps the element returned by
          // `getElementsByTagName` to an instance of the registered class
          // but leaves the original (unupgraded) element sitting in the
          // document's `elementIdMap`. Subsequent `getElementById` calls
          // then hand back the ghost — empty id, wrong class. Re-toggle
          // the id attribute so happy-dom evicts the stale entry and
          // re-registers the live element.
          rebindIdIndex(old);
          continue;
        }
        const parent = old.parentNode;
        if (!parent) continue;
        const next = old.nextSibling;
        const attrs = [];
        for (const attr of Array.from(old.attributes || [])) {
          attrs.push([attr.name, attr.value]);
        }
        const children = [];
        while (old.firstChild) children.push(old.removeChild(old.firstChild));
        for (const [n] of attrs) {
          try { old.removeAttribute(n); } catch (_) {}
        }
        parent.removeChild(old);
        const fresh = doc.createElement(name);
        for (const [n, v] of attrs) {
          try { fresh.setAttribute(n, v); } catch (_) {}
        }
        for (const child of children) fresh.appendChild(child);
        if (next && next.parentNode === parent) parent.insertBefore(fresh, next);
        else parent.appendChild(fresh);
      }
    }

    function rebindIdIndex(el) {
      const id = el.getAttribute && el.getAttribute('id');
      if (!id) return;
      // Reach through happy-dom's private elementIdMap symbol — the
      // public removeAttribute/setAttribute path appends the live element
      // *after* the ghost, so `getElementById` (which returns
      // entry.elements[0]) keeps handing back the wrong instance until
      // we evict the ghost manually.
      try {
        const doc = currentWindow && currentWindow.document;
        if (!doc) return;
        const sym = findHDSymbol(doc, 'elementIdMap');
        if (!sym) return;
        const map = doc[sym];
        const entry = map && map.get(id);
        if (!entry || !entry.elements) return;
        entry.elements = entry.elements.filter((e) => e === el || (e.isConnected && e.getAttribute && e.getAttribute('id') === id));
        if (entry.elements.indexOf(el) < 0) entry.elements.unshift(el);
      } catch (_) {}
    }
  }

  // Replace happy-dom's network-going `fetch` with one that round-trips
  // through the host Rack app. Synchronous under the hood — `__csim_fetch`
  // is attached from Ruby and returns immediately — but the wrapper still
  // resolves a Promise so consumers (Turbo, Stimulus) `await` normally.
  function installFetchShim(win) {
    const ResponseCtor = win.Response;
    const HeadersCtor  = win.Headers;
    const URLSearchParamsCtor = win.URLSearchParams || globalThis.URLSearchParams;
    const FormDataCtor = win.FormData;
    const DOMExceptionCtor = win.DOMException || Error;

    function headerEntries(input) {
      if (!input) return [];
      if (typeof input.entries === 'function') return Array.from(input.entries());
      if (Array.isArray(input)) return input.slice();
      return Object.keys(input).map((k) => [k, input[k]]);
    }

    function encodeMultipart(formData) {
      const boundary = '----CapybaraSimulatedFetch' + Math.random().toString(16).slice(2);
      const parts = [];
      for (const [name, value] of formData.entries()) {
        if (value && typeof value === 'object' && 'name' in value && 'arrayBuffer' in value) {
          // File / Blob — serialise basename only; binary upload via fetch
          // is rare in Turbo and would need binary-safe transport.
          parts.push('--' + boundary + '\r\n' +
            'Content-Disposition: form-data; name="' + name + '"; filename="' + (value.name || '') + '"\r\n' +
            'Content-Type: ' + (value.type || 'application/octet-stream') + '\r\n\r\n' +
            '\r\n');
        } else {
          parts.push('--' + boundary + '\r\n' +
            'Content-Disposition: form-data; name="' + name + '"\r\n\r\n' +
            String(value) + '\r\n');
        }
      }
      return {body: parts.join('') + '--' + boundary + '--\r\n', contentType: 'multipart/form-data; boundary=' + boundary};
    }

    function serializeBody(body, headers) {
      if (body == null) return '';
      if (typeof body === 'string') return body;
      if (URLSearchParamsCtor && body instanceof URLSearchParamsCtor) {
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
        }
        return body.toString();
      }
      if (FormDataCtor && body instanceof FormDataCtor) {
        const enc = encodeMultipart(body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = enc.contentType;
        }
        return enc.body;
      }
      // ArrayBuffer / TypedArray — best-effort to a Latin-1 string
      if (body && body.byteLength != null) {
        const view = body.buffer ? new Uint8Array(body.buffer, body.byteOffset || 0, body.byteLength) : new Uint8Array(body);
        let s = '';
        for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i]);
        return s;
      }
      return String(body);
    }

    win.fetch = function (input, init) {
      return new Promise((resolve, reject) => {
        try {
          let url, method = 'GET', headers = {}, body = null, signal = null;
          if (input && typeof input === 'object' && input.url) {
            url = input.url;
            method = input.method || 'GET';
            try { for (const [k, v] of input.headers) headers[k] = v; } catch (_) {}
          } else {
            url = String(input);
          }
          if (init) {
            if (init.method) method = init.method;
            for (const [k, v] of headerEntries(init.headers)) headers[k] = v;
            if (init.body != null) body = init.body;
            if (init.signal) signal = init.signal;
          }
          if (signal && signal.aborted) {
            return reject(new DOMExceptionCtor('The operation was aborted.', 'AbortError'));
          }
          const serialized = serializeBody(body, headers);
          const result = globalThis.__csim_fetch(method.toUpperCase(), url, headers, serialized);
          if (!result) return reject(new TypeError('fetch failed'));
          if (result.error) return reject(new TypeError(String(result.error)));
          const respHeaders = new HeadersCtor();
          const rh = result.headers || {};
          for (const k of Object.keys(rh)) {
            const v = rh[k];
            const parts = typeof v === 'string' ? v.split('\n') : (Array.isArray(v) ? v : [String(v)]);
            for (const part of parts) {
              try { respHeaders.append(k, part); } catch (_) {}
            }
          }
          const r = new ResponseCtor(result.body == null ? '' : result.body, {
            status: result.status || 200,
            statusText: result.statusText || '',
            headers: respHeaders
          });
          try { Object.defineProperty(r, 'url', {value: result.finalUrl || url, configurable: true}); } catch (_) {}
          try { Object.defineProperty(r, 'redirected', {value: !!result.redirected, configurable: true}); } catch (_) {}
          resolve(r);
        } catch (e) {
          reject(e);
        }
      });
    };
  }

  function visibleAncestorChainOk(el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (isHidden(cur)) return false;
      // Inside a closed <details>, only the <summary> branch is visible.
      if ((cur.tagName || '').toUpperCase() === 'DETAILS' &&
          !boolPropOrAttr(cur, 'open')) {
        // Walk back from el to cur; if we passed a <summary> on the way,
        // this branch stays visible.
        let probe = el;
        while (probe && probe !== cur) {
          if ((probe.tagName || '').toUpperCase() === 'SUMMARY') return true;
          probe = probe.parentNode;
        }
        return false;
      }
      cur = cur.parentNode;
    }
    return true;
  }

  function isHidden(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'head' || tag === 'title' ||
        tag === 'noscript' || tag === 'template') return true;
    if (el.hidden) return true;
    if (el.type === 'hidden') return true;
    const style = el.getAttribute && el.getAttribute('style');
    if (style && /display\s*:\s*none/i.test(style)) return true;
    if (style && /visibility\s*:\s*hidden/i.test(style)) return true;
    // Stylesheet-driven hiding: consult getComputedStyle so CSS rules
    // (`.hidden_until_hover { display: none }` and the like) are seen.
    if (currentWindow && currentWindow.getComputedStyle) {
      try {
        const cs = currentWindow.getComputedStyle(el);
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return true;
      } catch (_) {}
    }
    return false;
  }

  function visibleTextOf(el, opts) {
    if (!el) return '';
    if (el.nodeType === 3) {
      let tc = el.textContent || '';
      // CSS whitespace collapsing: runs of whitespace (incl. newlines)
      // become a single space, except inside <pre>/<textarea> contexts
      // where the caller signals to preserve whitespace via opts.pre.
      if (!(opts && opts.pre)) tc = tc.replace(/[ \t\r\n\f]+/g, ' ');
      const tt = opts && opts.textTransform;
      if (tt === 'uppercase') tc = tc.toUpperCase();
      else if (tt === 'lowercase') tc = tc.toLowerCase();
      else if (tt === 'capitalize') tc = tc.replace(/(?:^|\s)\S/g, c => c.toUpperCase());
      return tc;
    }
    // DocumentFragment / ShadowRoot / Document: descend into children.
    if (el.nodeType === 9 || el.nodeType === 11) {
      const parts = [];
      for (const child of el.childNodes || []) parts.push(visibleTextOf(child, opts));
      return parts.join('');
    }
    if (el.nodeType !== 1) return '';
    if (isHidden(el)) return '';
    const tag = (el.tagName || '').toLowerCase();
    let childOpts = opts;
    const pre = (opts && opts.pre) || tag === 'pre' || tag === 'textarea';
    const style = el.getAttribute && el.getAttribute('style');
    let tt = opts && opts.textTransform;
    if (style) {
      const m = /text-transform\s*:\s*(uppercase|lowercase|capitalize|none)/i.exec(style);
      if (m) tt = m[1].toLowerCase() === 'none' ? null : m[1].toLowerCase();
    }
    if (pre !== !!(opts && opts.pre) || tt !== (opts && opts.textTransform)) {
      childOpts = {pre, textTransform: tt};
    }
    const parts = [];
    for (const child of el.childNodes) parts.push(visibleTextOf(child, childOpts));
    let out = parts.join('');
    const block = ['p','div','section','article','header','footer','nav','aside',
                   'h1','h2','h3','h4','h5','h6','ul','ol','li','tr','td','th',
                   'pre','address','blockquote','dl','dt','dd','fieldset','form',
                   'hr','table','br'];
    if (block.includes(tag)) {
      // Only mark block boundaries when the block actually contributes
      // text — otherwise empty wrappers (e.g. shadow hosts) break inline
      // adjacency between their siblings.
      if (tag === 'br' || /[^\s]/.test(out)) out = '\n' + out + '\n';
    }
    return out;
  }

  function buildXPath(el) {
    if (!el || el.nodeType !== 1) return '';
    // Elements rooted in a ShadowRoot have no XPath in the host document;
    // Capybara expects the same sentinel as real browsers' driver code.
    let probe = el;
    while (probe) {
      if (probe.nodeType === 11 && probe.host) return '(: Shadow DOM element - no XPath :)';
      probe = probe.parentNode;
    }
    const segments = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const tag = (cur.tagName || '').toLowerCase();
      let index = 1;
      let sib = cur.previousSibling;
      while (sib) {
        if (sib.nodeType === 1 && (sib.tagName || '').toLowerCase() === tag) index++;
        sib = sib.previousSibling;
      }
      segments.unshift(tag + '[' + index + ']');
      cur = cur.parentNode;
      if (cur && cur.nodeType === 9) break;
    }
    return '/' + segments.join('/');
  }

  function boolPropOrAttr(el, name) {
    if (!el) return false;
    if (el[name] === true) return true;
    if (el[name] !== undefined && el[name] !== null && el[name] !== false) return true;
    if (el.hasAttribute && el.hasAttribute(name.toLowerCase())) return true;
    return false;
  }
  function isMultipleSelect(el) { return boolPropOrAttr(el, 'multiple'); }

  // True when a link's load should be handled by Turbo's FrameController:
  // it lives inside a `<turbo-frame>` ancestor, none of its closer
  // ancestors / submitters opted out via `data-turbo="false"` or
  // `data-turbo-frame="_top"`. Used to decide whether the runtime
  // should do its own Rack navigate after a click whose default got
  // preventDefaulted.
  function isFrameScopedLink(el) {
    const frame = el.closest && el.closest('turbo-frame');
    if (!frame) return false;
    const turboFrameAttr = el.getAttribute && el.getAttribute('data-turbo-frame');
    if (turboFrameAttr === '_top') return false;
    const turboAttr = el.closest && el.closest('[data-turbo]');
    if (turboAttr && turboAttr.getAttribute('data-turbo') === 'false') return false;
    return true;
  }

  function makeEvent(type, opts) {
    const init = Object.assign({bubbles: true, cancelable: true}, opts || {});
    const Ctor = (currentWindow && currentWindow.MouseEvent && /click|mouse|dblclick|contextmenu/.test(type))
      ? currentWindow.MouseEvent
      : (currentWindow && currentWindow.KeyboardEvent && /key/.test(type))
        ? currentWindow.KeyboardEvent
        : (currentWindow && currentWindow.FocusEvent && /focus|blur/.test(type))
          ? currentWindow.FocusEvent
          : currentWindow.Event;
    return new Ctor(type, init);
  }

  // Resolve the form an input/button is bound to, honouring the HTML5
  // `form="<id>"` attribute. happy-dom's `el.form` only returns an
  // ancestor form, so we look up by id when the attribute is set.
  function formForControl(el) {
    if (!el) return null;
    const fid = el.getAttribute && el.getAttribute('form');
    if (fid) {
      const byId = currentDocument.getElementById(fid);
      if (byId && (byId.tagName || '').toUpperCase() === 'FORM') return byId;
    }
    return el.form || (el.closest && el.closest('form'));
  }

  function countSubmittableTextInputs(form) {
    let n = 0;
    for (const el of form.querySelectorAll('input')) {
      const t = (el.type || (el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase();
      if (/^(text|email|number|search|tel|url|password|date|time|datetime-local|month|week|color|range)$/.test(t)) {
        n++;
      }
    }
    return n;
  }

  function fieldsFromForm(form, submitter) {
    const out = [];
    // Build the list in document order. happy-dom's `form.elements` does
    // not always include form-attribute associated controls, so collect
    // both the directly contained controls and any document-wide controls
    // bound via `form="<id>"`, then sort them by source position.
    const formId = form.getAttribute && form.getAttribute('id');
    const els = new Set();
    for (const el of form.querySelectorAll('input,textarea,select,button')) {
      if (!el.hasAttribute('form') || el.getAttribute('form') === formId) {
        els.add(el);
      }
    }
    if (formId) {
      for (const el of currentDocument.querySelectorAll(
          `input[form="${cssEscape(formId)}"], textarea[form="${cssEscape(formId)}"], ` +
          `select[form="${cssEscape(formId)}"], button[form="${cssEscape(formId)}"]`)) {
        els.add(el);
      }
    }
    const ordered = Array.from(els);
    ordered.sort((a, b) => {
      const pos = a.compareDocumentPosition && a.compareDocumentPosition(b);
      if (pos & 0x04) return -1;   // a precedes b
      if (pos & 0x02) return 1;    // b precedes a
      return 0;
    });
    for (const el of ordered) {
      if (!el.name) continue;
      if (boolPropOrAttr(el, 'disabled')) continue;
      const tag = (el.tagName || '').toUpperCase();
      const type = (el.type || (el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
      if (tag === 'BUTTON' || type === 'submit' || type === 'image' || type === 'reset') {
        if (el !== submitter) continue;
        if (type === 'reset') continue;
        out.push([el.name, el.value || '']);
        continue;
      }
      if (type === 'checkbox' || type === 'radio') {
        // `checked` is the IDL property reflecting live state. Don't fall
        // back to `hasAttribute('checked')` here — that's the *default*
        // state used by form reset, and Stimulus controllers commonly
        // toggle the property directly (`el.checked = false`) without
        // touching the attribute. Reading the attribute would cause the
        // serializer to submit unchecked boxes as if they were on.
        if (el.checked === true) {
          const v = el.getAttribute && el.getAttribute('value');
          out.push([el.name, v == null ? 'on' : v]);
        }
        continue;
      }
      if (tag === 'SELECT') {
        const opts = Array.from(el.options || []);
        if (opts.length === 0) continue; // unfillable, do not submit
        if (isMultipleSelect(el)) {
          for (const opt of opts) {
            if (boolPropOrAttr(opt, 'selected')) out.push([el.name, opt.value || '']);
          }
          continue;
        }
        const sel = opts.find(o => boolPropOrAttr(o, 'selected')) || opts[0];
        out.push([el.name, sel.value || '']);
        continue;
      }
      if (type === 'file') {
        const files = el.__csim_files || [];
        if (files.length === 0) {
          // Empty file inputs still appear in multipart bodies as empty
          // file parts in real browsers. The Ruby side decides whether to
          // emit them based on enctype.
          out.push([el.name, {file: true, paths: []}]);
        } else {
          out.push([el.name, {file: true, paths: files.slice()}]);
        }
        continue;
      }
      let v = el.value == null ? '' : String(el.value);
      if (tag === 'TEXTAREA') {
        // Strip the single leading newline that HTML5 stripped from the
        // initial textarea content — only when the driver has not been
        // asked to set the value (otherwise the user's own leading
        // newline must round-trip).
        if (!el.__csim_user_set) {
          if (v.startsWith('\r\n')) v = v.slice(2);
          else if (v.startsWith('\n')) v = v.slice(1);
        }
        // Submit with CRLF line endings per HTML5.
        v = v.replace(/\r?\n/g, '\r\n');
      }
      out.push([el.name, v]);
    }
    return out;
  }

  function submitDescriptor(form, submitter, options) {
    // happy-dom auto-dispatches a `submit` event when an INPUT/BUTTON of
    // type=submit is clicked (via form.requestSubmit). When we land here
    // through that path, dispatching another submit event creates a
    // duplicate without the `submitter` field — Turbo's FormSubmitObserver
    // sees the second one and intercepts even when the original submitter
    // had `data-turbo="false"`. Skip our dispatch in that case and rely on
    // the prevented flag the click path captured. Keep dispatching for
    // direct `submit(id)` calls and implicit-submit-on-Enter where no
    // upstream submit event has fired yet.
    const skipDispatch = options && options.skipDispatch;
    const alreadyPrevented = !!(options && options.prevented);
    if (!skipDispatch) {
      const evt = makeEvent('submit', {submitter: submitter || undefined});
      if (!form.dispatchEvent(evt)) return {action: 'none'};
    } else if (alreadyPrevented) {
      return {action: 'none'};
    }
    // The button's formaction/formmethod/formenctype override the form's
    // attributes when present (HTML5 spec).
    const fa = (submitter && submitter.getAttribute && submitter.getAttribute('formaction'));
    const fm = (submitter && submitter.getAttribute && submitter.getAttribute('formmethod'));
    const fe = (submitter && submitter.getAttribute && submitter.getAttribute('formenctype'));
    return {
      action: 'submit',
      url: fa || form.getAttribute('action') || '',
      method: (fm || form.getAttribute('method') || 'GET').toUpperCase(),
      enctype: fe || form.getAttribute('enctype') || 'application/x-www-form-urlencoded',
      fields: fieldsFromForm(form, submitter)
    };
  }

  function unwrapScriptArgs(args) {
    return args.map((a) => {
      if (a && typeof a === 'object' && '__csim_handle' in a) return lookup(a.__csim_handle);
      return a;
    });
  }
  function wrapScriptResult(value) {
    if (value && typeof value === 'object' && value.nodeType === 1) {
      return {__csim_handle: track(value)};
    }
    if (Array.isArray(value)) return value.map(wrapScriptResult);
    return value;
  }

  function attachInlineHandlers(root) {
    const all = root.querySelectorAll('*');
    for (const el of all) {
      if (!el.attributes) continue;
      for (const attr of Array.from(el.attributes)) {
        if (!attr.name || !attr.name.startsWith('on')) continue;
        const eventName = attr.name.slice(2);
        const body = attr.value || '';
        if (!body) continue;
        try {
          const fn = new Function('event', body);
          el.addEventListener(eventName, function (event) {
            try { fn.call(this, event); }
            catch (_) {}
          });
        } catch (_) {}
      }
    }
  }

  // Walk the document for focusable elements (anchors with href, form
  // controls that aren't disabled or hidden, anything with a non-negative
  // tabindex) and advance the active element to the next one in tab
  // order. happy-dom doesn't ship Tab navigation, so each `send_keys(:tab)`
  // call would otherwise be a no-op for `document.activeElement`.
  function advanceFocus(_from, reverse) {
    if (!currentDocument) return;
    const cands = Array.from(currentDocument.querySelectorAll(
      'a[href], button, input:not([type=hidden]), select, textarea, [tabindex]'
    )).filter((el) => {
      if (el.disabled) return false;
      const ti = el.getAttribute('tabindex');
      if (ti && parseInt(ti, 10) < 0) return false;
      // Hidden elements can't take focus.
      if (typeof el.offsetParent !== 'undefined' && el.offsetParent === null && el.tagName !== 'BODY') {
        // happy-dom returns null for everything (no layout), so don't
        // exclude on offsetParent alone — fall through.
      }
      return true;
    });
    const positiveTab = (el) => {
      const ti = parseInt(el.getAttribute('tabindex') || '0', 10);
      return ti > 0 ? ti : null;
    };
    const indexed = cands.filter((el) => positiveTab(el) !== null)
      .map((el, i) => ({el, ti: positiveTab(el), i}))
      .sort((a, b) => a.ti - b.ti || a.i - b.i)
      .map((x) => x.el);
    const natural = cands.filter((el) => positiveTab(el) === null);
    const ordered = indexed.concat(natural);
    if (reverse) ordered.reverse();
    if (ordered.length === 0) return;
    const cur = currentDocument.activeElement;
    const at = ordered.indexOf(cur);
    const next = ordered[(at >= 0 && at + 1 < ordered.length) ? at + 1 : 0];
    if (next && typeof next.focus === 'function') {
      next.focus();
      activeHandleId = track(next);
    }
  }

  // ---- send_keys helpers ------------------------------------------------
  function isModifier(name) {
    return name === 'Shift' || name === 'Control' || name === 'Alt' || name === 'Meta';
  }
  function isSpecialKey(name) {
    return name.length > 1 && /^[A-Z]/.test(name);
  }
  function modifierProp(name) {
    return ({Shift: 'shiftKey', Control: 'ctrlKey', Alt: 'altKey', Meta: 'metaKey'})[name];
  }
  function keyForEvent(name, opts) {
    if (isSpecialKey(name)) return name;
    if (opts && opts.shiftKey) return name.toUpperCase();
    return name;
  }
  function keyCodeFor(name) {
    if (isModifier(name)) return ({Shift: 16, Control: 17, Alt: 18, Meta: 91})[name];
    if (name === 'Enter') return 13;
    if (name === 'Tab') return 9;
    if (name === 'Backspace') return 8;
    if (name === 'Delete') return 46;
    if (name === 'Escape') return 27;
    if (name === ' ') return 32;
    if (name === 'ArrowLeft') return 37;
    if (name === 'ArrowUp') return 38;
    if (name === 'ArrowRight') return 39;
    if (name === 'ArrowDown') return 40;
    if (name === 'Home') return 36;
    if (name === 'End') return 35;
    if (name === 'PageUp') return 33;
    if (name === 'PageDown') return 34;
    if (name.length === 1) {
      const c = name.toUpperCase().charCodeAt(0);
      if (c >= 48 && c <= 57) return c;        // 0-9
      if (c >= 65 && c <= 90) return c;        // A-Z
      return name.charCodeAt(0);
    }
    return 0;
  }
  function keyCodeName(name) {
    if (isModifier(name)) return name === 'Meta' ? 'MetaLeft' : (name + 'Left');
    if (name === 'Enter') return 'Enter';
    if (name === 'Tab') return 'Tab';
    if (name === 'Backspace') return 'Backspace';
    if (name === 'Delete') return 'Delete';
    if (name === 'Escape') return 'Escape';
    if (name === ' ') return 'Space';
    if (/^Arrow/.test(name)) return name;
    if (name.length === 1) {
      const ch = name.toUpperCase();
      if (ch >= '0' && ch <= '9') return 'Digit' + ch;
      if (ch >= 'A' && ch <= 'Z') return 'Key' + ch;
    }
    return name;
  }

  function drainTimers(ms) {
    if (typeof globalThis.__csim_runTimers === 'function') {
      try { return !!globalThis.__csim_runTimers(ms); } catch (_) {}
    }
    return false;
  }

  // happy-dom has no layout engine, so getBoundingClientRect always returns
  // (0,0,0,0). We approximate the box for click-offset routing by reading
  // computed `top`/`left`/`width`/`height` (in px) from the element and
  // each ancestor. Falls back to inline `style.*` if the computed value is
  // unset. Anything beyond simple px positioning yields 0, which is a
  // truthful signal that we cannot resolve geometry for the element.
  function pxValue(v) {
    if (v == null) return 0;
    const m = String(v).match(/^(-?\d+(?:\.\d+)?)/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    return isFinite(n) ? n : 0;
  }
  function readPx(el, computed, prop) {
    let v = computed && computed[prop];
    if (!v || v === 'auto') v = el.style && el.style[prop];
    return pxValue(v);
  }
  function simRect(el) {
    const win = currentWindow;
    if (!el || !win) return {x: 0, y: 0, width: 0, height: 0};
    let cs = null;
    try { cs = win.getComputedStyle(el); } catch (_) {}
    const width  = readPx(el, cs, 'width');
    const height = readPx(el, cs, 'height');
    let x = 0, y = 0, cur = el;
    while (cur && cur.nodeType === 1) {
      let ccs = null;
      try { ccs = win.getComputedStyle(cur); } catch (_) {}
      x += readPx(cur, ccs, 'left');
      y += readPx(cur, ccs, 'top');
      cur = cur.parentElement;
    }
    return {x, y, width, height};
  }

  // Translate an offset-style click descriptor (`offsetX`, `offsetY`,
  // `w3cOffset`) into absolute clientX/clientY using the simulated rect.
  // Mutates `m` in place. With no offset given, click lands at the
  // element's center; rect collapses to (0,0,0,0) for elements we cannot
  // resolve, so the click defaults to the document origin in that case.
  function applyClickOffset(el, m) {
    const hasOffset = ('offsetX' in m) || ('offsetY' in m);
    const w3c = !!m.w3cOffset;
    delete m.w3cOffset;
    const ox = m.offsetX; delete m.offsetX;
    const oy = m.offsetY; delete m.offsetY;
    if ('clientX' in m && 'clientY' in m) return;
    const r = simRect(el);
    const baseX = r.x + (w3c || !hasOffset ? r.width  / 2 : 0);
    const baseY = r.y + (w3c || !hasOffset ? r.height / 2 : 0);
    m.clientX = baseX + (Number(ox) || 0);
    m.clientY = baseY + (Number(oy) || 0);
  }

  globalThis.__csim = {
    loadHTML(html, url) {
      resetState();
      // Wipe globals that scripts may have published on the previous Window
      // so that re-loading e.g. jQuery on the next page starts from a clean
      // slate. Without this, jQuery's `isReady` carries over and ready
      // callbacks never fire on subsequent visits.
      const STALE = ['jQuery', '$', 'jquery', 'JQuery'];
      for (const k of STALE) {
        try { delete globalThis[k]; } catch (_) { globalThis[k] = undefined; }
      }
      const win = new Window({url: url || 'http://www.example.com/'});
      patchWindowGlobals(win);
      installFetchShim(win);
      installCustomElementUpgrade(win);
      installHistoryTracking(win);
      currentWindow = win;
      currentDocument = win.document;
      // Prefer happy-dom's incremental innerHTML parser — it preserves
      // form-attribute ordering and other quirks the spec relies on. Some
      // real-world Rails/Turbo pages trip an internal "insertBefore: new
      // node is a parent of the node to insert to" DOMException there;
      // when that happens, fall back to DOMParser, which builds a fresh
      // Document and we adopt its <head>/<body>. The DOMParser path
      // reorders some form-associated controls so we only use it when
      // the primary path fails outright.
      const raw = html || '<html><body></body></html>';
      try {
        win.document.documentElement.innerHTML = stripDoctype(raw);
      } catch (_parserErr) {
        const parsed = new win.DOMParser().parseFromString(raw, 'text/html');
        const dstHead = win.document.head;
        const dstBody = win.document.body;
        while (dstHead.firstChild) dstHead.removeChild(dstHead.firstChild);
        while (dstBody.firstChild) dstBody.removeChild(dstBody.firstChild);
        if (parsed.head) {
          for (const child of Array.from(parsed.head.childNodes)) dstHead.appendChild(child);
        }
        if (parsed.body) {
          for (const child of Array.from(parsed.body.childNodes)) dstBody.appendChild(child);
          for (const attr of Array.from(parsed.body.attributes || [])) {
            try { dstBody.setAttribute(attr.name, attr.value); } catch (_) {}
          }
        }
        if (parsed.documentElement) {
          for (const attr of Array.from(parsed.documentElement.attributes || [])) {
            try { win.document.documentElement.setAttribute(attr.name, attr.value); } catch (_) {}
          }
        }
      }
      // Mirror onto globalThis so user scripts (eval/Function) can reach the
      // active document without naming the window explicitly. The Proxy
      // mirrors property writes — `window.Turbo = ...` (a common Rails
      // turbo-rails pattern) needs `globalThis.Turbo` to appear too,
      // because in a real browser `globalThis === window`.
      globalThis.window = new Proxy(win, {
        set(target, key, value) {
          try { target[key] = value; } catch (_) {}
          try { globalThis[key] = value; } catch (_) {}
          return true;
        },
        get(target, key) {
          return target[key];
        },
        has(target, key) {
          return key in target;
        }
      });
      globalThis.document = win.document;
      globalThis.location = win.location;
      globalThis.history = win.history;
      globalThis.alert = win.alert;
      globalThis.confirm = win.confirm;
      globalThis.prompt = win.prompt;
      globalThis.fetch  = win.fetch.bind(win);
      globalThis.Response = win.Response;
      globalThis.Request  = win.Request;
      globalThis.Headers  = win.Headers;
      // Module bundles eval at the top level (globalThis), not inside the
      // window. Mirror the page-level globals user code typically expects
      // so Turbo / Stimulus / arbitrary libraries find them without
      // having to namespace through `window`.
      globalThis.requestAnimationFrame = win.requestAnimationFrame;
      globalThis.cancelAnimationFrame  = win.cancelAnimationFrame;
      globalThis.MutationObserver = win.MutationObserver;
      globalThis.IntersectionObserver = win.IntersectionObserver || function () {
        return {observe() {}, unobserve() {}, disconnect() {}, takeRecords() { return []; }};
      };
      globalThis.ResizeObserver = win.ResizeObserver || function () {
        return {observe() {}, unobserve() {}, disconnect() {}};
      };
      globalThis.CustomEvent = win.CustomEvent;
      globalThis.Event       = win.Event;
      globalThis.EventTarget = win.EventTarget;
      globalThis.HTMLElement = win.HTMLElement;
      globalThis.Element     = win.Element;
      globalThis.Node        = win.Node;
      globalThis.DOMParser   = win.DOMParser;
      globalThis.FormData    = win.FormData;
      globalThis.URL         = win.URL || globalThis.URL;
      globalThis.URLSearchParams = win.URLSearchParams || globalThis.URLSearchParams;
      globalThis.AbortController = win.AbortController;
      globalThis.AbortSignal     = win.AbortSignal;
      globalThis.navigator = win.navigator;
      globalThis.customElements = win.customElements;
      globalThis.HTMLElement = win.HTMLElement;
      // mini_racer has no host module loader, so dynamic `import()` is
      // rewritten to `globalThis.__csim_import` by the bundler. The
      // registry is populated by per-module assignments emitted in the
      // bundle body, but those run *after* the static-import evaluation
      // phase — and that is the same phase where library code (e.g.
      // stimulus-loading's `eagerLoadControllersFrom`) calls dynamic
      // `import()`. To handle that ordering, every call before drain
      // is queued; we resolve the queue once the bundle has finished
      // evaluating and the registry is populated.
      globalThis.__csim_modules = {};
      globalThis.__csim_pending_imports = [];
      globalThis.__csim_import = function (specifier) {
        const mod = globalThis.__csim_modules[specifier];
        if (mod) return Promise.resolve(mod);
        return new Promise(function (resolve, reject) {
          globalThis.__csim_pending_imports.push({specifier, resolve, reject});
        });
      };
      globalThis.__csim_drain_imports = function () {
        const queue = globalThis.__csim_pending_imports;
        globalThis.__csim_pending_imports = [];
        for (const {specifier, resolve, reject} of queue) {
          const mod = globalThis.__csim_modules[specifier];
          if (mod) resolve(mod);
          else reject(new Error('capybara-simulated: dynamic import not pre-bundled: ' + specifier));
        }
      };
      // Turbo's `extractForeignFrameElement` calls `CSS.escape(id)` to
      // build a selector. happy-dom doesn't expose CSS yet — provide a
      // minimal shim covering the identifier-safe subset.
      globalThis.CSS = globalThis.CSS || win.CSS || {
        escape(s) {
          return String(s).replace(/[^a-zA-Z0-9_ -￿-]/g, (c) => '\\' + c);
        }
      };
      // Bound event-target methods so libraries can do
      // `addEventListener('DOMContentLoaded', ...)` at top level. Real
      // browsers expose these because globalThis === window; we have to
      // forward them explicitly.
      globalThis.addEventListener    = win.addEventListener.bind(win);
      globalThis.removeEventListener = win.removeEventListener.bind(win);
      globalThis.dispatchEvent       = win.dispatchEvent.bind(win);
      globalThis.matchMedia          = win.matchMedia ? win.matchMedia.bind(win) : (() => ({matches: false, media: '', addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; }}));
      globalThis.getComputedStyle    = win.getComputedStyle.bind(win);
      globalThis.scrollTo            = () => {};
      globalThis.scrollBy            = () => {};
      globalThis.innerWidth  = win.innerWidth  || 1024;
      globalThis.innerHeight = win.innerHeight || 768;
      return true;
    },

    runInlineScripts() {
      if (!currentDocument) return;
      const scripts = currentDocument.querySelectorAll('script:not([src])');
      const sources = [];
      for (const s of scripts) sources.push(s.textContent || '');
      for (const code of sources) {
        try { (0, eval)(code); } catch (_) {}
      }
      attachInlineHandlers(currentDocument);
      syncWindowGlobals();
      fireReadyEvents();
    },

    syncWindowGlobals() { syncWindowGlobals(); },

    externalScriptSources() {
      if (!currentDocument) return [];
      const out = [];
      // Skip type="module" — those are handled separately via
      // `moduleScriptDetails` so the Ruby driver can run them through
      // esbuild instead of treating them as classic scripts.
      for (const s of currentDocument.querySelectorAll('script[src]:not([type="module"])')) {
        const t = (s.getAttribute('type') || '').toLowerCase();
        if (t && t !== 'text/javascript' && t !== 'application/javascript') continue;
        const src = s.getAttribute('src');
        if (src) out.push(src);
      }
      return out;
    },

    // Collect everything the Ruby module loader needs in one round-trip:
    // the importmap JSON (inline only — Rails always inlines it) and the
    // ordered list of `<script type="module">` entries with either
    // `inline` source or `src`. Returns null when the page has no module
    // scripts so the Ruby side can short-circuit.
    moduleScriptDetails() {
      if (!currentDocument) return null;
      const out = {importmap: '', entries: []};
      const im = currentDocument.querySelector('script[type="importmap"]');
      if (im) out.importmap = im.textContent || '';
      const mods = currentDocument.querySelectorAll('script[type="module"]');
      for (const s of mods) {
        const src = s.getAttribute('src');
        if (src) out.entries.push({src});
        else if (s.textContent && s.textContent.trim()) out.entries.push({inline: s.textContent});
      }
      if (!out.importmap && out.entries.length === 0) return null;
      return out;
    },

    pushModalHandler(handler) {
      modalHandlers.push(handler);
      return true;
    },
    popModalHandler(type, text) {
      const sameText = (a, b) => {
        if (a == null && b == null) return true;
        if (typeof a === 'string' && typeof b === 'string') return a === b;
        if (a && b && typeof a === 'object' && typeof b === 'object' && a.regexp === b.regexp) return true;
        return false;
      };
      const idx = modalHandlers.findIndex((h) => h.type === type && sameText(h.text, text));
      if (idx >= 0) modalHandlers.splice(idx, 1);
      return true;
    },

    setModalResponses(responses) {
      modalResponses = {
        alert:   (responses && responses.alert)   || [],
        confirm: (responses && responses.confirm) || [],
        prompt:  (responses && responses.prompt)  || []
      };
      return true;
    },

    drainModalQueue() {
      const out = modalQueue.slice();
      modalQueue.length = 0;
      return out;
    },

    evaluate(code, args) {
      const params = unwrapScriptArgs(Array.isArray(args) ? args : []);
      // Strip trailing semicolons / whitespace so `(...);` style scripts
      // still parse when wrapped in `return (...)`.
      const stripped = String(code).replace(/[;\s]+$/, '');
      try {
        const fn = new Function('return (' + stripped + ');');
        return wrapScriptResult(fn.apply(currentWindow, params));
      } catch (_) {
        const fn = new Function(code);
        return wrapScriptResult(fn.apply(currentWindow, params));
      }
    },
    executeScript(code, args) {
      const params = unwrapScriptArgs(Array.isArray(args) ? args : []);
      const fn = new Function(code);
      fn.apply(currentWindow, params);
      return null;
    },

    // The user script receives a callback as its final argument and is
    // expected to invoke it (synchronously or asynchronously) with the
    // result. The Ruby side drives the virtual clock between polls until
    // the callback fires or the wait budget runs out.
    startAsync(code, args) {
      const params = unwrapScriptArgs(Array.isArray(args) ? args : []);
      asyncSlot = {done: false};
      const slot = asyncSlot;
      const callback = (value) => {
        if (slot.done) return;
        slot.done = true;
        slot.value = value;
      };
      try {
        const fn = new Function(code);
        fn.apply(currentWindow, params.concat([callback]));
      } catch (e) {
        slot.done = true;
        slot.error = String((e && e.stack) || e);
      }
      return true;
    },
    pollAsync() {
      const slot = asyncSlot;
      if (!slot) return {done: true, error: 'no async script in flight'};
      if (!slot.done) return {done: false};
      asyncSlot = null;
      if ('error' in slot) return {done: true, error: slot.error};
      return {done: true, value: wrapScriptResult(slot.value)};
    },

    html() {
      if (!currentDocument || !currentDocument.documentElement) return '';
      return String('<!doctype html>' + currentDocument.documentElement.outerHTML);
    },
    title() {
      if (!currentDocument) return '';
      // Prefer the raw `<title>` text content so leading/trailing
      // whitespace round-trips through Capybara's title matchers.
      const t = currentDocument.querySelector && currentDocument.querySelector('title');
      if (t && t.textContent != null) return String(t.textContent);
      return String(currentDocument.title || '');
    },

    findXPath(xpath, contextId) {
      if (!currentDocument) return [];
      const root = contextId ? lookup(contextId) : (currentDocument.documentElement || currentDocument);
      const fast = tryFastXPath(xpath, root);
      if (fast) return fast.map(track);
      try {
        const result = currentDocument.evaluate(
          xpath, root, null,
          /* UNORDERED_NODE_ITERATOR_TYPE */ 4, null
        );
        const ids = [];
        let n;
        while ((n = result.iterateNext())) ids.push(track(n));
        return ids;
      } catch (e) {
        return findViaXPathFallback(xpath, root);
      }
    },
    findCSS(css, contextId) {
      if (!currentDocument) return [];
      const root = contextId ? lookup(contextId) : currentDocument;
      if (!root || !root.querySelectorAll) return [];
      const matches = root.querySelectorAll(rewriteCSS(css));
      const ids = [];
      for (const el of matches) ids.push(track(el));
      return ids;
    },

    tagName(id) {
      const node = lookup(id);
      // ShadowRoot has nodeType 11 with no tagName; Capybara's element
      // inspect formatter expects a string here.
      if (node && node.nodeType === 11) return 'ShadowRoot';
      return String((node.tagName || '').toLowerCase());
    },
    innerHTML(id)   { return String(lookup(id).innerHTML || ''); },
    outerHTML(id)   { return String(lookup(id).outerHTML || ''); },
    attr(id, name) {
      const el = lookup(id);
      if (el.hasAttribute(name)) return el.getAttribute(name);
      // Capybara's `node[:validationMessage]` and friends expect the IDL
      // property when no matching HTML attribute exists — Selenium's
      // attribute() does the same fallback. Returning null here would
      // hide computed values (validationMessage, validity, etc.).
      const direct = el[name];
      if (direct === undefined) return null;
      if (direct === null || typeof direct === 'string' || typeof direct === 'boolean' || typeof direct === 'number') {
        return direct;
      }
      return null;
    },
    prop(id, name) {
      const v = lookup(id)[name];
      return v === undefined ? null : v;
    },
    allText(id)     { return String(lookup(id).textContent || ''); },
    visibleText(id) {
      const cached = visibleTextCache.get(id);
      if (cached !== undefined) return cached;
      const el = lookup(id);
      // If any ancestor of `el` is hidden, the element renders nothing.
      const txt = visibleAncestorChainOk(el) ? String(visibleTextOf(el)) : '';
      visibleTextCache.set(id, txt);
      return txt;
    },
    path(id)        { return String(buildXPath(lookup(id))); },
    rect(id) {
      const el = lookup(id);
      return {x: 0, y: 0, width: 0, height: 0, top: 0, left: 0,
              right: 0, bottom: 0, tagName: (el.tagName || '').toLowerCase()};
    },

    value(id) {
      const el = lookup(id);
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'SELECT' && isMultipleSelect(el)) {
        return Array.from(el.options).filter(o => boolPropOrAttr(o, 'selected'))
          .map(o => String(o.value == null ? '' : o.value));
      }
      const type = (el.type || (el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        const v = el.getAttribute && el.getAttribute('value');
        return v == null ? 'on' : String(v);
      }
      if (tag === 'TEXTAREA') {
        // HTML spec: a single leading newline directly after <textarea> is
        // stripped from the *initial* value. happy-dom does not apply
        // that rule. Only strip when our driver has not written to the
        // field yet — once `setValue` ran we treat the buffer as user
        // content and preserve it byte-for-byte.
        let raw = el.value == null ? '' : String(el.value);
        if (!el.__csim_user_set) {
          if (raw.startsWith('\r\n')) raw = raw.slice(2);
          else if (raw.startsWith('\n')) raw = raw.slice(1);
        }
        return raw;
      }
      if ('value' in el) return el.value == null ? '' : String(el.value);
      return null;
    },

    setValue(id, value) {
      clearReadCache();
      const el = lookup(id);
      const tag = (el.tagName || '').toUpperCase();
      const type = (el.type || (el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
      // contenteditable inherits — walk ancestors looking for an explicit
      // value other than `false`.
      let ceCur = el, ce = null;
      while (ceCur && ceCur.nodeType === 1) {
        const v = ceCur.getAttribute && ceCur.getAttribute('contenteditable');
        if (v !== null && v !== undefined) { ce = v; break; }
        ceCur = ceCur.parentNode;
      }
      if (ce !== null && ce !== undefined && ce !== 'false') {
        el.textContent = String(value == null ? '' : value);
        el.dispatchEvent(makeEvent('input'));
        el.dispatchEvent(makeEvent('change'));
        return true;
      }
      if (tag === 'SELECT' && isMultipleSelect(el) && Array.isArray(value)) {
        for (const opt of el.options) {
          if (value.includes(opt.value)) opt.setAttribute('selected', '');
          else opt.removeAttribute('selected');
        }
      } else if (type === 'checkbox') {
        // Real browsers fire click + change when set/unset via UI. Drive a
        // click whenever the desired state differs from the current state
        // so user-bound `click` handlers run. Use the IDL property only —
        // Stimulus controllers commonly toggle `el.checked` directly,
        // which leaves the `checked` HTML attribute stale.
        const want = !!value;
        const have = el.checked === true;
        if (want !== have) {
          el.dispatchEvent(makeEvent('click'));
          if (el.checked) el.setAttribute('checked', '');
          else            el.removeAttribute('checked');
        }
      } else if (type === 'radio') {
        if (value) {
          // Setting a radio also deselects every same-named peer.
          if (el.name) {
            for (const peer of currentDocument.querySelectorAll('input[type=radio][name="' + cssEscape(el.name) + '"]')) {
              if (peer === el) { peer.setAttribute('checked', ''); peer.checked = true; }
              else             { peer.removeAttribute('checked'); peer.checked = false; }
            }
          } else {
            el.setAttribute('checked', '');
            el.checked = true;
          }
        } else {
          el.removeAttribute('checked');
          el.checked = false;
        }
      } else if (type === 'file') {
        el.__csim_files = Array.isArray(value) ? value : [value];
      } else {
        let str = String(value == null ? '' : value);
        // Pre-formatted ISO timestamps from Ruby: trim to whatever the
        // <input type="..."> actually accepts.
        if (type === 'time' && /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.test(str)) {
          str = str.replace(/^\d{4}-\d{2}-\d{2}T/, '');
        } else if (type === 'date' && /^(\d{4}-\d{2}-\d{2})/.test(str)) {
          str = str.match(/^\d{4}-\d{2}-\d{2}/)[0];
        }
        if (type === 'range') {
          // <input type=range> rounds to the nearest valid step from min.
          const min  = parseFloat(el.getAttribute('min'))  || 0;
          const max  = parseFloat(el.getAttribute('max'));
          const step = parseFloat(el.getAttribute('step')) || 1;
          const num  = parseFloat(str);
          if (Number.isFinite(num) && step > 0) {
            let snapped = Math.round((num - min) / step) * step + min;
            if (Number.isFinite(max)) snapped = Math.min(snapped, max);
            snapped = Math.max(snapped, min);
            // Trim floating-point fuzz introduced by the rounding above.
            const decimals = (String(step).split('.')[1] || '').length;
            str = snapped.toFixed(decimals);
          }
        }
        // HTML "implicit submission": a `\n` in a text-like input on a form
        // with only one such control should submit the form. Strip the \n
        // from the stored value but remember to fire submit afterwards.
        let implicitSubmit = false;
        if (tag === 'INPUT' && /^(text|email|number|search|tel|url|password|date|time|datetime-local|month|week|color|range)?$/.test(type) && str.endsWith('\n')) {
          str = str.replace(/\n$/, '');
          const form = formForControl(el);
          if (form && countSubmittableTextInputs(form) === 1) implicitSubmit = true;
        }
        const maxLen = parseInt(el.getAttribute && el.getAttribute('maxlength'), 10);
        if (Number.isFinite(maxLen) && maxLen >= 0) str = str.slice(0, maxLen);
        el.value = str;
        el.__csim_user_set = true;
        el.dispatchEvent(makeEvent('input'));
        el.dispatchEvent(makeEvent('change'));
        if (implicitSubmit) {
          const form = formForControl(el);
          if (form) {
            const desc = submitDescriptor(form, null);
            return desc;
          }
        }
        return true;
      }
      el.dispatchEvent(makeEvent('input'));
      el.dispatchEvent(makeEvent('change'));
      return true;
    },

    selectOption(id) {
      clearReadCache();
      const opt = lookup(id);
      const select = opt.parentNode && (opt.parentNode.tagName === 'SELECT'
        ? opt.parentNode
        : opt.closest && opt.closest('select'));
      if (!select) return false;
      if (!isMultipleSelect(select)) {
        for (const o of select.options) {
          if (o === opt) o.setAttribute('selected', '');
          else o.removeAttribute('selected');
        }
      } else {
        opt.setAttribute('selected', '');
      }
      select.dispatchEvent(makeEvent('input'));
      select.dispatchEvent(makeEvent('change'));
      return true;
    },
    unselectOption(id) {
      clearReadCache();
      const opt = lookup(id);
      const select = opt.closest && opt.closest('select');
      if (!select || !isMultipleSelect(select)) return false;
      opt.removeAttribute('selected');
      select.dispatchEvent(makeEvent('input'));
      select.dispatchEvent(makeEvent('change'));
      return true;
    },

    visible(id)  { return visibleAncestorChainOk(lookup(id)); },
    checked(id)  { return boolPropOrAttr(lookup(id), 'checked'); },
    selected(id) { return boolPropOrAttr(lookup(id), 'selected'); },
    disabled(id) {
      const el = lookup(id);
      const tag = (el.tagName || '').toUpperCase();
      // Only form controls and `<option>`s actually honour the `disabled`
      // attribute. Plain anchors etc. with stray `disabled` markers must
      // not be reported as disabled.
      const DISABLEABLE = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA',
                                   'OPTGROUP', 'OPTION', 'FIELDSET']);
      if (DISABLEABLE.has(tag) && boolPropOrAttr(el, 'disabled')) return true;
      // An option inside a disabled <select> or <optgroup> is disabled too.
      if (tag === 'OPTION') {
        let p = el.parentNode;
        while (p && p.nodeType === 1) {
          const pt = (p.tagName || '').toUpperCase();
          if (pt === 'OPTGROUP' && boolPropOrAttr(p, 'disabled')) return true;
          if (pt === 'SELECT'   && boolPropOrAttr(p, 'disabled')) return true;
          p = p.parentNode;
        }
      }
      let cur = el.parentNode;
      while (cur && cur.nodeType === 1) {
        if ((cur.tagName || '').toUpperCase() === 'FIELDSET' && boolPropOrAttr(cur, 'disabled')) {
          const legend = cur.querySelector && cur.querySelector('legend');
          if (legend && legend.contains && legend.contains(el)) return false;
          return true;
        }
        cur = cur.parentNode;
      }
      return false;
    },
    readonly(id) { return boolPropOrAttr(lookup(id), 'readOnly') ||
                          boolPropOrAttr(lookup(id), 'readonly'); },
    multiple(id) { return boolPropOrAttr(lookup(id), 'multiple'); },

    focus(id)  { clearReadCache(); activeHandleId = id; lookup(id).dispatchEvent(makeEvent('focus', {bubbles: false})); return true; },
    blur(id)   { clearReadCache(); lookup(id).dispatchEvent(makeEvent('blur', {bubbles: false})); if (activeHandleId === id) activeHandleId = null; return true; },
    activeElement() {
      // Honour the JS-side `document.activeElement` first — happy-dom
      // updates it when scripts call `focus()` directly, which the
      // tracker variable does not see. Fall back to the runtime's
      // tracker when the document hasn't initialised yet.
      const el = currentDocument && currentDocument.activeElement;
      if (el) return track(el);
      return activeHandleId;
    },

    hover(id) {
      clearReadCache();
      const el = lookup(id);
      el.dispatchEvent(makeEvent('mouseover'));
      el.dispatchEvent(makeEvent('mouseenter', {bubbles: false}));
      return true;
    },
    trigger(id, name) { clearReadCache(); lookup(id).dispatchEvent(makeEvent(name)); return true; },

    drainTimers(ms) {
      // Only clear the read cache if a timer actually fired — most
      // `advance_virtual_clock` calls from Ruby have nothing to do but
      // tick the wall clock. Without this the visibleText cache is
      // invalidated on every cross-bridge call and never hits.
      if (drainTimers(ms)) clearReadCache();
      return true;
    },

    consumeHistoryPushed() {
      const v = _historyPushed;
      _historyPushed = false;
      return v;
    },

    shadowRoot(id) {
      const el = lookup(id);
      const root = el && el.shadowRoot;
      return root ? track(root) : null;
    },

    mouseDown(id, button, modifiers) {
      const el = lookup(id);
      const m = Object.assign({button: button || 0}, modifiers || {});
      applyClickOffset(el, m);
      el.dispatchEvent(makeEvent('mousedown', m));
      return true;
    },

    click(id, button, modifiers, skipDown) {
      clearReadCache();
      const el = lookup(id);
      activeHandleId = id;
      const m = Object.assign({button: button || 0}, modifiers || {});
      applyClickOffset(el, m);
      // Real browsers dispatch mousedown → mouseup → click (or contextmenu
      // for the right button). Page handlers like the Capybara test suite's
      // `mouse_down_time` / `click_delay` rely on the down/up pair.
      if (!skipDown) el.dispatchEvent(makeEvent('mousedown', m));
      el.dispatchEvent(makeEvent('mouseup', m));
      const eventType = button === 2 ? 'contextmenu' : 'click';
      const evt = makeEvent(eventType, m);
      // For anchor elements we used to attach a preventDefault suppressor
      // so happy-dom's HTMLAnchorElement.dispatchEvent wouldn't call
      // `window.open(href)` and double-navigate. The suppressor masked
      // legitimate `preventDefault()` calls from Turbo / Stimulus link
      // interceptors though, which made the runtime always fall through
      // to a Ruby-side `navigate` even when Turbo had already taken
      // responsibility for the link via a `<turbo-frame>` visit. Track
      // whether *something else* prevented the default by sampling the
      // event's defaultPrevented before our late capture listener
      // re-prevents to keep happy-dom out of the way.
      const tagU = (el.tagName || '').toUpperCase();
      const isLink = tagU === 'A' && el.getAttribute('href') != null;
      // happy-dom's HTMLButtonElement / HTMLInputElement.dispatchEvent
      // auto-dispatches `submit` on the form when this is a submit-type
      // control click. Capture whether that submit was preventDefaulted so
      // submitDescriptor doesn't fire a redundant submit event (which
      // would lose the `submitter` field and confuse Turbo).
      const submitForm = (tagU === 'BUTTON' || (tagU === 'INPUT' && /^(submit|image)$/i.test(el.type || '')))
        ? formForControl(el)
        : null;
      let autoSubmitFired = false;
      let lastAutoSubmit = null;
      let autoSubmitListener = null;
      if (submitForm) {
        // Capture-phase listener so it always fires before any bubble-
        // phase handler (notably Turbo's FormSubmitObserver attached to
        // document). The final `defaultPrevented` value is whatever later
        // listeners chose, so read it after dispatch returns.
        autoSubmitListener = (e) => {
          autoSubmitFired = true;
          lastAutoSubmit = e;
        };
        submitForm.addEventListener('submit', autoSubmitListener, true);
      }
      const proceeded = el.dispatchEvent(evt);
      let autoSubmitPrevented = !!(lastAutoSubmit && lastAutoSubmit.defaultPrevented);
      if (submitForm) {
        try { submitForm.removeEventListener('submit', autoSubmitListener, true); } catch (_) {}
      }
      // For links, we want happy-dom's HTMLAnchorElement default
      // (window.open / location set) NOT to fire — the Ruby driver does
      // the navigate. preventDefault here acts only on happy-dom's
      // default action because user listeners have already run during
      // the dispatch above; their decisions are reflected in
      // `proceeded` (false ⇔ defaultPrevented).
      const externallyPrevented = isLink && !proceeded;
      if (isLink) try { evt.preventDefault(); } catch (_) {}
      if (!proceeded && !isLink) return {action: 'none'};
      if (button === 2) return {action: 'none'};

      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'LABEL') {
        // happy-dom already redirects label clicks to their associated
        // form control (toggling checkboxes/radios), so we don't need to
        // route the click manually. We do still need to mirror the new
        // state into the `checked` attribute (form serialisation reads
        // it) and, for radios, deselect peers that share the same name.
        const targetId = el.getAttribute && el.getAttribute('for');
        let target = null;
        if (targetId) target = currentDocument.getElementById(targetId);
        if (!target) target = el.querySelector && el.querySelector('input,textarea,select,button');
        if (target) {
          if (target.checked) target.setAttribute('checked', '');
          else                target.removeAttribute('checked');
          if ((target.type || '').toLowerCase() === 'radio' && target.name && target.checked) {
            for (const peer of currentDocument.querySelectorAll('input[type=radio][name="' + cssEscape(target.name) + '"]')) {
              if (peer === target) continue;
              peer.checked = false;
              peer.removeAttribute('checked');
            }
          }
        }
      }
      if (tag === 'A' && el.getAttribute('href') != null) {
        const href = el.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
          return {action: 'none'};
        }
        // When the link sits inside a `<turbo-frame>` (and isn't escaping
        // to the top with `data-turbo-frame="_top"` or `data-turbo="false"`),
        // Turbo's FrameController intercepts the click and replaces the
        // frame's contents asynchronously. Don't double-navigate via
        // Rack in that case — the frame visit owns the load. Top-level
        // Drive visits still go through Ruby navigate so the response
        // is rendered as a fresh page.
        if (externallyPrevented && isFrameScopedLink(el)) return {action: 'none'};
        return {action: 'navigate', href};
      }
      if (tag === 'BUTTON') {
        const btnType = (el.type || 'submit').toLowerCase();
        if (btnType === 'submit') {
          const form = formForControl(el);
          if (form) return submitDescriptor(form, el, {skipDispatch: autoSubmitFired, prevented: autoSubmitPrevented});
        }
        if (btnType === 'reset') {
          const form = formForControl(el);
          if (form && form.reset) form.reset();
        }
      }
      if (tag === 'INPUT') {
        const type = (el.type || '').toLowerCase();
        if (type === 'submit' || type === 'image') {
          const form = formForControl(el);
          if (form) return submitDescriptor(form, el, {skipDispatch: autoSubmitFired, prevented: autoSubmitPrevented});
        }
        if (type === 'reset') {
          const form = formForControl(el);
          if (form && form.reset) form.reset();
        }
        if (type === 'checkbox') {
          // happy-dom toggles `el.checked` automatically on dispatchEvent
          // for click on a checkbox. Sync the attribute so attribute-based
          // queries (and form serialisation) stay consistent.
          if (el.checked) el.setAttribute('checked', '');
          else            el.removeAttribute('checked');
          el.dispatchEvent(makeEvent('change'));
        }
        if (type === 'radio') {
          // happy-dom selects `el` on click but does not deselect peers.
          if (el.name) {
            for (const peer of currentDocument.querySelectorAll('input[type=radio][name="' + cssEscape(el.name) + '"]')) {
              if (peer === el) { peer.setAttribute('checked', ''); peer.checked = true; }
              else             { peer.removeAttribute('checked'); peer.checked = false; }
            }
          } else {
            el.setAttribute('checked', '');
            el.checked = true;
          }
          el.dispatchEvent(makeEvent('change'));
        }
      }
      return {action: 'none'};
    },

    doubleClick(id, modifiers) {
      clearReadCache();
      const el = lookup(id);
      const m = Object.assign({button: 0}, modifiers || {});
      applyClickOffset(el, m);
      el.dispatchEvent(makeEvent('mousedown', m));
      el.dispatchEvent(makeEvent('mouseup', m));
      el.dispatchEvent(makeEvent('click', m));
      el.dispatchEvent(makeEvent('mousedown', m));
      el.dispatchEvent(makeEvent('mouseup', m));
      el.dispatchEvent(makeEvent('click', m));
      el.dispatchEvent(makeEvent('dblclick', m));
      return {action: 'none'};
    },
    rightClick(id, modifiers, skipDown) {
      clearReadCache();
      const el = lookup(id);
      const m = Object.assign({button: 2}, modifiers || {});
      applyClickOffset(el, m);
      if (!skipDown) el.dispatchEvent(makeEvent('mousedown', m));
      el.dispatchEvent(makeEvent('mouseup', m));
      el.dispatchEvent(makeEvent('contextmenu', m));
      return {action: 'none'};
    },

    // Mirrors Capybara's HTML5 drop helper: build a DataTransfer holding
    // the supplied files and/or strings, attach it to the dragenter,
    // dragover and drop events, and dispatch them on the target. happy-dom
    // exposes `DragEvent` as a plain `Event`, so we paste `dataTransfer`
    // onto each event before dispatch.
    drop(id, items) {
      clearReadCache();
      const el = lookup(id);
      const win = currentWindow;
      const dt = new win.DataTransfer();
      for (const item of items || []) {
        if (item.kind === 'file') {
          const file = new win.File([item.contents || ''], item.name || '', {type: item.type || ''});
          dt.items.add(file);
        } else {
          dt.items.add(String(item.data == null ? '' : item.data), String(item.type || ''));
        }
      }
      const fire = (name) => {
        const ev = makeEvent(name, {bubbles: true, cancelable: true});
        try {
          Object.defineProperty(ev, 'dataTransfer', {value: dt, writable: false, configurable: true});
        } catch (_) {
          ev.dataTransfer = dt;
        }
        el.dispatchEvent(ev);
      };
      fire('dragenter');
      fire('dragover');
      fire('drop');
      return true;
    },

    submit(id) { clearReadCache(); return submitDescriptor(lookup(id), null); },

    sendKeys(id, keys) {
      clearReadCache();
      const el = lookup(id);
      const editable = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
      let formToSubmit = null;
      // Modifiers held for the rest of the call after a top-level
      // `:shift` etc. (Selenium semantics). [:shift, 'o'] combos hold
      // the modifier just for `tail`.
      const heldModifiers = new Set();
      const cursor = {pos: editable ? (el.value || '').length : 0};

      const fireKey = (name, opts) => {
        const detail = Object.assign({key: keyForEvent(name, opts), code: keyCodeName(name), keyCode: keyCodeFor(name)}, opts || {});
        for (const m of heldModifiers) detail[modifierProp(m)] = true;
        if (opts && opts.modifiers) for (const m of opts.modifiers) detail[modifierProp(m)] = true;
        el.dispatchEvent(makeEvent('keydown', detail));
        if (!isSpecialKey(name)) el.dispatchEvent(makeEvent('keypress', detail));
        applyKeyEffect(name, detail);
        el.dispatchEvent(makeEvent('keyup', detail));
      };
      const applyKeyEffect = (name, detail) => {
        if (!editable) return;
        const cur = el.value == null ? '' : el.value;
        const shift = !!detail.shiftKey;
        const ctrlOrMeta = !!detail.ctrlKey || !!detail.metaKey;
        if (ctrlOrMeta) return;  // hotkeys: skip text effect
        if (name === 'Backspace') {
          if (cursor.pos === 0) return;
          el.value = cur.slice(0, cursor.pos - 1) + cur.slice(cursor.pos);
          cursor.pos -= 1;
          el.dispatchEvent(makeEvent('input'));
        } else if (name === 'Delete') {
          if (cursor.pos === cur.length) return;
          el.value = cur.slice(0, cursor.pos) + cur.slice(cursor.pos + 1);
          el.dispatchEvent(makeEvent('input'));
        } else if (name === 'ArrowLeft')   cursor.pos = Math.max(0, cursor.pos - 1);
        else   if (name === 'ArrowRight')  cursor.pos = Math.min(cur.length, cursor.pos + 1);
        else   if (name === 'Home')        cursor.pos = 0;
        else   if (name === 'End')         cursor.pos = cur.length;
        else if (!isSpecialKey(name)) {
          const ch = shift ? name.toUpperCase() : name;
          el.value = cur.slice(0, cursor.pos) + ch + cur.slice(cursor.pos);
          cursor.pos += ch.length;
          el.dispatchEvent(makeEvent('input'));
        } else if (name === 'Enter' && (el.tagName === 'INPUT')) {
          formToSubmit = el.form || el.closest('form');
        }
      };

      const handle = (k) => {
        if (typeof k === 'string') {
          for (const ch of k) fireKey(ch, {});
          return;
        }
        if (!k || typeof k !== 'object') return;
        if ('combo' in k) {
          // Press each modifier (firing keydown), execute the tail with
          // them held, then release in reverse order.
          for (const mod of k.combo) {
            heldModifiers.add(mod);
            el.dispatchEvent(makeEvent('keydown', {key: mod, code: keyCodeName(mod), keyCode: keyCodeFor(mod), [modifierProp(mod)]: true}));
          }
          for (const part of k.tail) handle(part);
          for (let i = k.combo.length - 1; i >= 0; i--) {
            const mod = k.combo[i];
            el.dispatchEvent(makeEvent('keyup', {key: mod, code: keyCodeName(mod), keyCode: keyCodeFor(mod), [modifierProp(mod)]: true}));
            heldModifiers.delete(mod);
          }
          return;
        }
        if ('special' in k) {
          const name = String(k.special);
          if (isModifier(name)) {
            // Top-level modifier symbol toggles a held-down state for
            // the remainder of the call.
            if (heldModifiers.has(name)) heldModifiers.delete(name);
            else heldModifiers.add(name);
            return;
          }
          if (name === 'Enter' && el.tagName === 'INPUT') {
            formToSubmit = el.form || el.closest('form');
          }
          if (name === 'Tab') advanceFocus(el, !!heldModifiers.has('Shift'));
          fireKey(name, {});
        }
      };

      for (const k of keys) handle(k);
      if (formToSubmit) return submitDescriptor(formToSubmit, null);
      return {action: 'none'};
    }
  };

  // Real browsers expose every property of `window` as a global. mini_racer
  // keeps globalThis and the happy-dom Window separate, so libraries that
  // attach to `window` (jQuery, page boot scripts) need their additions
  // mirrored back onto globalThis for subsequent `<script>` tags to see.
  const _SKIP_SYNC = new Set([
    'self', 'window', 'document', 'top', 'parent', 'frames', 'opener',
    'globalThis', 'happyDOM'
  ]);
  // happy-dom does not fire DOMContentLoaded / load on its own when we
  // assign innerHTML and replay scripts in a single tick. Frameworks like
  // jQuery hold their initialisation behind `$(document).ready(...)`, so
  // we synthesise both events at the end of script setup.
  function fireReadyEvents() {
    if (!currentWindow || !currentDocument) return;
    try {
      currentDocument.dispatchEvent(new currentWindow.Event('DOMContentLoaded', {bubbles: true, cancelable: false}));
    } catch (_) {}
    try {
      currentWindow.dispatchEvent(new currentWindow.Event('load', {bubbles: false, cancelable: false}));
    } catch (_) {}
  }

  function syncWindowGlobals() {
    if (!currentWindow) return;
    for (const key of Object.keys(currentWindow)) {
      if (_SKIP_SYNC.has(key)) continue;
      if (key.startsWith('_')) continue;
      try {
        if (globalThis[key] === undefined && currentWindow[key] !== undefined) {
          globalThis[key] = currentWindow[key];
        }
      } catch (_) {}
    }
  }

  function cssEscape(s) {
    return String(s).replace(/(["\\\]\[\(\)])/g, '\\$1');
  }

  // happy-dom's selector parser does not implement form-state pseudo
  // classes like `:enabled`, `:read-write`, `:optional`, treating them
  // as no-match. Rewrite them to their attribute-based equivalents,
  // which are close enough for Capybara's form interaction selectors.
  // We deliberately do not touch pseudos happy-dom does support
  // (`:disabled`, `:checked`, `:not`, `:nth-child`, etc.).
  const PSEUDO_REWRITES = [
    [/:enabled\b/g,           ':not([disabled])'],
    [/:read-write\b/g,        ':not([readonly])'],
    [/:read-only\b/g,         '[readonly]'],
    [/:optional\b/g,          ':not([required])']
  ];
  // happy-dom's parser also rejects CSS identifier escape sequences in
  // `#id` / `.class` (e.g. `#\31 foo` for `#1foo`). Decode the escapes
  // and rewrite to attribute selectors, which it accepts.
  const CSS_IDENT_RE = /(?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w-])+/.source;
  const ESCAPED_ID_RE = new RegExp('#(' + CSS_IDENT_RE + ')', 'g');
  const ESCAPED_CLASS_RE = new RegExp('\\.(' + CSS_IDENT_RE + ')', 'g');
  function unescapeIdent(s) {
    return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_m, hex, ch) =>
      hex ? String.fromCodePoint(parseInt(hex, 16)) : ch);
  }
  function rewriteCSS(css) {
    let out = String(css || '');
    for (const [re, repl] of PSEUDO_REWRITES) out = out.replace(re, repl);
    if (out.indexOf('\\') !== -1) {
      out = out.replace(ESCAPED_ID_RE, (m, ident) =>
        ident.indexOf('\\') === -1 ? m : '[id="' + unescapeIdent(ident).replace(/"/g, '\\"') + '"]');
      out = out.replace(ESCAPED_CLASS_RE, (m, ident) =>
        ident.indexOf('\\') === -1 ? m : '[class~="' + unescapeIdent(ident).replace(/"/g, '\\"') + '"]');
    }
    return out;
  }

  function stripDoctype(html) {
    return String(html || '').replace(/^\s*<!doctype[^>]*>\s*/i, '');
  }

  // Capybara emits XPath; happy-dom has no document.evaluate. The fallback
  // covers a useful subset by translating to CSS, with a hand-rolled text()
  // and contains() filter on top.
  // history.pushState / replaceState change window.location.href without a
  // real fetch. Wrap them to set a flag the Ruby driver inspects so it
  // does not turn the URL change into a Rack request.
  let _historyPushed = false;
  function installHistoryTracking(win) {
    if (!win.history) return;
    const wrap = (name) => {
      const orig = win.history[name];
      if (typeof orig !== 'function' || orig.__csim_wrapped) return;
      const wrapped = function () {
        _historyPushed = true;
        return orig.apply(win.history, arguments);
      };
      wrapped.__csim_wrapped = true;
      win.history[name] = wrapped;
    };
    wrap('pushState');
    wrap('replaceState');
  }

  // Capybara's xpath gem produces a small set of stable XPath shapes for
  // its built-in selectors (link, button, link_or_button, select, option,
  // field, fillable_field, …). Even after the facade fix fontoxpath spends
  // ~4ms on each of these — partly because the predicates redundantly walk
  // the whole document for `//label[text=X]/@for`. When we recognise the
  // pattern we can skip fontoxpath entirely and resolve the match through
  // happy-dom's native `getElementById` + `querySelectorAll('label[for]')`,
  // which is O(label-count) instead of O(elements × labels).
  //
  // Returns an array of nodes on a hit, or `null` on miss (caller falls
  // back to fontoxpath).
  function tryFastXPath(xpath, root) {
    if (typeof xpath !== 'string') return null;
    // Capybara appends `(./@<test_id> = 'X')` to every locator predicate when
    // `Capybara.test_id` is set. The aria-label clause is the standard last
    // attr; a `)) or (` immediately after means a 6th (test_id) clause was
    // injected. Bail to fontoxpath in that case — falling through is just
    // slower, not broken.
    if (/aria-label\s*(?:=|,) '[^']+'\)\)\s+or\s+\(/.test(xpath)) return null;
    const ms = NORM_TEXT_RX.exec(xpath);
    if (ms) return findByNormText(root, ms[1], ms[3], ms[2] === 'contains');
    const ll = LOCATE_FIELD_RX.exec(xpath);
    if (ll) return findByLabel(root, ll[1], ll[2]);
    const lb = LINK_OR_BUTTON_RX.exec(xpath);
    if (lb) return findLinkOrButton(root, lb[1], lb[2] === 'contains');
    return null;
  }

  // .//TAG[(normalize-space(string(.)) = 'X')]
  // .//TAG[contains(normalize-space(string(.)), 'X')]
  // .//TAG[normalize-space(string(.)) = 'X']    (no outer parens — rare)
  const NORM_TEXT_RX = /^\.\/\/([a-z][\w-]*)\[\(?(contains)?\(?normalize-space\(string\(\.\)\)(?:, ?| = )'((?:[^'\\]|\\.)*)'\)?\)?\]$/;

  function findByNormText(root, tag, text, isContains) {
    const out = [];
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    for (const el of root.querySelectorAll(tag)) {
      const t = norm(el.textContent);
      if (isContains ? t.indexOf(text) >= 0 : t === text) out.push(el);
    }
    return out;
  }

  // .//select[((((@id = 'X') or (@name = 'X')) or (@placeholder = 'X'))
  //   or (@id = //label[(normalize-space(string(.)) = 'X')]/@for))
  //   or (@aria-label = 'X'))]
  //   | .//label[(normalize-space(string(.)) = 'X')]//.//select
  //
  // Capybara's `:select` selector. The same locator value is repeated in
  // every clause, so capture once and verify.
  const LOCATE_FIELD_RX = new RegExp(
    '^\\.\\/\\/(select|textarea)\\[\\(\\(\\(\\(\\(\\.\\/@id = \'([^\']+)\'\\)' +
    ' or \\(\\.\\/@name = \'\\2\'\\)\\)' +
    ' or \\(\\.\\/@placeholder = \'\\2\'\\)\\)' +
    ' or \\(\\.\\/@id = \\/\\/label\\[\\(normalize-space\\(string\\(\\.\\)\\) = \'\\2\'\\)\\]\\/@for\\)\\)' +
    ' or \\(\\.\\/@aria-label = \'\\2\'\\)\\)\\]' +
    '(?: \\| \\.\\/\\/label\\[\\(normalize-space\\(string\\(\\.\\)\\) = \'\\2\'\\)\\]\\/\\/\\.\\/\\/\\1)?$'
  );

  function findByLabel(root, tag, value) {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const matches = new Set();
    for (const el of root.querySelectorAll(tag)) {
      if (
        el.getAttribute('id') === value ||
        el.getAttribute('name') === value ||
        el.getAttribute('placeholder') === value ||
        el.getAttribute('aria-label') === value
      ) matches.add(el);
    }
    // <label for="…">text</label> — anywhere in the *document*, then resolve
    // its target by id and verify the target is inside `root`.
    const doc = root.ownerDocument || (root.nodeType === 9 ? root : currentDocument);
    if (doc) {
      for (const label of doc.querySelectorAll('label[for]')) {
        if (norm(label.textContent) !== value) continue;
        const target = doc.getElementById(label.getAttribute('for'));
        if (
          target &&
          (target.tagName || '').toLowerCase() === tag &&
          (root === doc.documentElement || root === doc || root.contains(target))
        ) matches.add(target);
      }
    }
    // <label>text<select/></label> — descendant of root.
    for (const label of root.querySelectorAll('label')) {
      if (norm(label.textContent) !== value) continue;
      for (const child of label.querySelectorAll(tag)) matches.add(child);
    }
    return Array.from(matches);
  }

  function unescXp(s) { return s.replace(/\\(.)/g, '$1'); }

  // .//a[./@href][((((@id = 'X') or [normalize-space(string(.)) = 'X' | contains(...)])
  //   or [@title = 'X' | contains(...)]) or .//img[(@alt = 'X' | contains)]) or [@aria-label = 'X' | contains])]
  // | .//input[type=submit/...][...] | .//label[X]//*[input-or-button]
  // | .//input[type=image][...] | .//button[...] | .//label[X]//* (dup) | .//input[image] (dup)
  //
  // Capybara's `:link_or_button` selector — by far the most common shape we
  // see (~25% of all xpath calls in a Rails system spec). The detector
  // anchors on the link clause (5 OR'd predicates ending with @aria-label)
  // and reads off whether the suite is in exact-match or contains mode.
  // If the last clause isn't aria-label (e.g. Capybara.test_id is set, or
  // enable_aria_label is off), we bail and fontoxpath handles it.
  const LINK_OR_BUTTON_RX = new RegExp(
    '^\\.\\/\\/a\\[\\.\\/@href\\]' +
    '\\[\\(\\(\\(\\(\\(' +
      '\\.\\/@id = \'([^\']+)\'\\)' +
      ' or (?:\\(normalize-space\\(string\\(\\.\\)\\) = \'\\1\'\\)|(contains)\\(normalize-space\\(string\\(\\.\\)\\), \'\\1\'\\))\\)' +
      ' or (?:\\(\\.\\/@title = \'\\1\'\\)|contains\\(\\.\\/@title, \'\\1\'\\))\\)' +
      ' or \\.\\/\\/img\\[(?:\\(\\.\\/@alt = \'\\1\'\\)|contains\\(\\.\\/@alt, \'\\1\'\\))\\]\\)' +
      ' or (?:\\(\\.\\/@aria-label = \'\\1\'\\)|contains\\(\\.\\/@aria-label, \'\\1\'\\))\\)' +
    '\\]' +
    ' \\| \\.\\/\\/input\\['
  );

  function findLinkOrButton(root, value, isContains) {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const eq = (s) => isContains ? (s != null && String(s).indexOf(value) >= 0) : (s === value);
    const eqText = (s) => isContains ? norm(s).indexOf(value) >= 0 : norm(s) === value;
    const matches = new Set();

    // <a href> by id (always exact), text/title/aria-label, child <img alt>
    for (const a of root.querySelectorAll('a[href]')) {
      if (
        a.getAttribute('id') === value ||
        eqText(a.textContent) ||
        eq(a.getAttribute('title')) ||
        eq(a.getAttribute('aria-label'))
      ) { matches.add(a); continue; }
      for (const img of a.querySelectorAll('img')) {
        if (eq(img.getAttribute('alt'))) { matches.add(a); break; }
      }
    }

    // <input type=submit/reset/image/button>
    for (const input of root.querySelectorAll(
      'input[type=submit],input[type=reset],input[type=image],input[type=button]'
    )) {
      if (
        input.getAttribute('id') === value ||
        input.getAttribute('name') === value ||
        eq(input.getAttribute('value')) ||
        eq(input.getAttribute('title')) ||
        eq(input.getAttribute('aria-label'))
      ) matches.add(input);
    }

    // <input type=image> alt / aria-label
    for (const input of root.querySelectorAll('input[type=image]')) {
      if (eq(input.getAttribute('alt')) || eq(input.getAttribute('aria-label'))) matches.add(input);
    }

    // <button> id/name/value/title/aria-label/text/child <img alt>
    for (const btn of root.querySelectorAll('button')) {
      if (
        btn.getAttribute('id') === value ||
        btn.getAttribute('name') === value ||
        eq(btn.getAttribute('value')) ||
        eq(btn.getAttribute('title')) ||
        eq(btn.getAttribute('aria-label')) ||
        eqText(btn.textContent)
      ) { matches.add(btn); continue; }
      for (const img of btn.querySelectorAll('img')) {
        if (eq(img.getAttribute('alt'))) { matches.add(btn); break; }
      }
    }

    // <label>text<input|button/></label>
    for (const label of root.querySelectorAll('label')) {
      if (!eqText(label.textContent)) continue;
      for (const c of label.querySelectorAll(
        'input[type=submit],input[type=reset],input[type=image],input[type=button],button'
      )) matches.add(c);
    }

    // <label for="…">text</label> (anywhere in the document) → input/button
    const doc = root.ownerDocument || (root.nodeType === 9 ? root : currentDocument);
    if (doc && doc.querySelectorAll) {
      for (const label of doc.querySelectorAll('label[for]')) {
        if (!eqText(label.textContent)) continue;
        const target = doc.getElementById(label.getAttribute('for'));
        if (!target) continue;
        const tag  = (target.tagName || '').toLowerCase();
        const type = ((target.getAttribute && target.getAttribute('type')) || '').toLowerCase();
        const clickable = (tag === 'input' && /^(submit|reset|image|button)$/.test(type)) || tag === 'button';
        if (!clickable) continue;
        if (root === doc.documentElement || root === doc || root.contains(target)) matches.add(target);
      }
    }

    return Array.from(matches);
  }

  function findViaXPathFallback(xpath, root) {
    if (typeof xpath !== 'string') return [];
    const m = xpath.match(/^\.?\/\/(?:descendant::)?([A-Za-z*][\w*]*)(?:\[(.+)\])?$/);
    if (!m) {
      // Last resort: take the whole thing as a tag name.
      try {
        const els = root.querySelectorAll(xpath);
        const ids = [];
        for (const el of els) ids.push(track(el));
        return ids;
      } catch (_) { return []; }
    }
    const tag = m[1];
    const els = root.querySelectorAll(tag);
    const ids = [];
    for (const el of els) ids.push(track(el));
    return ids;
  }
})();
