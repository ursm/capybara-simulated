# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/raster'

# What a page replaces of `Function.prototype` — `call`, `apply`, `bind` — and `Reflect.apply` is called by nothing of
# the bindings': they call their own functions, and a page's, by the realm's `Reflect.apply` they took before any page
# ran (engine.js `reflectApply`), and the host calls their steps bound to no receiver (engine.js `stepsView`). A page's
# replacement so never sees the realm's host object, its hooks or its steps — as a receiver, an argument, or a function
# of the bindings' — whichever step the host delivers to it by: an image's load, a channel's message, a storage event, a
# worker's message, a fetch's answer, a script the host runs.
RSpec.describe "the host's reach into a page" do
  let(:app) {
    png = Raster.png(1, 1, "\0\0\0".b)
    lambda do |env|
      case env['PATH_INFO']
      when '/i.png' then [200, {'content-type' => 'image/png'}, [png]]
      when '/w.js' then [200, {'content-type' => 'text/javascript'}, ["new BroadcastChannel('c').onmessage = (e) => postMessage('heard ' + e.data); postMessage('ready');"]]
      when '/f' then [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><script>new BroadcastChannel('c').onmessage = (e) => { localStorage.setItem('k', e.data); };</script>"]]
      when '/secret' then [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><title>secret</title><script>window.secret = 's'; frames;</script><iframe></iframe>"]]
      when '/w2.js' then [200, {'content-type' => 'text/javascript'}, ['onmessage = (e) => postMessage(e.data);']]
      when '/state' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><p id=p class="a b" data-x=1 style="color:red">t</p><form id=fm action=/ method=post><input name=q value=1><select name=s multiple><option selected>a<option selected>b</select></form><iframe id=f src=/f></iframe><template id=t><i>z</i></template><canvas id=c></canvas>']]
      when '/objects' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><p id=p x=1 style="color: red" data-a=1 class=c>t</p><form id=f><input name=q></form><iframe id=x src="http://other.test/secret"></iframe>']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><iframe id=f src=/f></iframe>']]
      end
    end
  }
  let(:session) { simulated_session(app) }

  it "hands a page's call, apply, bind and Reflect.apply none of the bindings' own" do
    session.visit '/'
    session.execute_script(<<~JS)
      window.worker = new Worker('/w.js');
      window.heard = [];
      worker.onmessage = (e) => { /*PAGE*/ heard.push(e.data); };
    JS
    poll_until { session.evaluate_script("heard.includes('ready')") }
    session.execute_script(<<~JS)
      const P = Function.prototype, toString = P.toString, R = Reflect.apply, calls = { call: P.call, apply: P.apply, bind: P.bind };
      const own = (f) => { const s = R(toString, f, []); return s.includes('PAGE') || (s.includes('[native code]') && !f.name.startsWith('bound ')); };
      const internal = (x) => (typeof x === 'function' && !own(x))
        || (x !== null && typeof x === 'object' && Object.getPrototypeOf(x) === null && ['steps', 'evalScript', 'rackFetch', 'abortDocumentRest', 'parent'].some((k) => k in x));
      window.leaks = [];
      const spy = (name) => function (self, ...rest) { /*PAGE*/
        if (internal(this) || internal(self) || rest.flat().some(internal)) leaks.push(name);
        return R(calls[name], this, [self, ...rest]);
      };
      P.call = spy('call'); P.apply = spy('apply'); P.bind = spy('bind');
      Reflect.apply = function (f, self, args) { /*PAGE*/ if (internal(f) || internal(self)) leaks.push('Reflect.apply'); return R(f, self, args); };
      window.loaded = 0;
      const img = new Image(); img.onload = () => { /*PAGE*/ loaded++; }; img.src = '/i.png'; document.body.append(img);
      addEventListener('storage', () => { /*PAGE*/ loaded++; });
      new BroadcastChannel('c').postMessage('x');
      fetch('/').then((r) => { /*PAGE*/ return r.text(); }).then(() => { /*PAGE*/ loaded++; });
    JS
    poll_until { session.evaluate_script('loaded >= 3 && heard.length >= 2') }
    expect(session.evaluate_script('[loaded, heard]')).to eq([3, ['ready', 'heard x']])
    expect(session.evaluate_script('[1, 2].map((n) => n + 1)')).to eq([2, 3])
    expect(session.evaluate_script('leaks')).to eq([])
  end

  # …nor what a page puts in place of a static of Reflect's or Object's, or of a method of Object.prototype's: the
  # bindings call those the bundle took as it loaded (intrinsics.js). A cross-origin window's raw global, or the target
  # of a Proxy the bindings made of an element's attributes, a style, a form, a dataset, a class list or a Storage, would
  # be handed to one.
  it "hands a page's Reflect, Object and Object.prototype methods no window, no Proxy's target" do
    session.visit '/objects'
    poll_until { session.evaluate_script("(() => { try { document.getElementById('x').contentWindow.document; return false; } catch (e) { return true; } })()") }
    session.execute_script(<<~JS)
      const R = Reflect.apply, C = Reflect.construct, protoOf = Object.getPrototypeOf, p = document.getElementById('p'), f = document.getElementById('f');
      const ours = new Set([p, f, p.attributes, p.style, p.dataset, p.classList, f.elements, localStorage, sessionStorage, document, window, location]);
      const theirs = [p.attributes, p.style, p.dataset, p.classList, f, f.elements, localStorage, location].map(protoOf);
      const stolen = (x) => {
        if (x === null || (typeof x !== 'object' && typeof x !== 'function') || ours.has(x)) return false;
        try { if (typeof x.secret === 'string') return true; } catch (_) {}
        let proto; try { proto = protoOf(x); } catch (_) { return false; }
        return theirs.includes(proto);
      };
      window.leaks = [];
      let busy = false;
      const spy = (holder, name, label) => {
        const was = holder[name];
        holder[name] = function (...args) { /*PAGE*/
          if (!busy) {
            busy = true;
            try { for (const x of [this, ...args]) if (stolen(x)) leaks.push(label + '.' + name); } finally { busy = false; }
          }
          return new.target ? C(was, args) : R(was, this, args);
        };
      };
      for (const name of Reflect.ownKeys(Reflect)) if (typeof Reflect[name] === 'function' && name !== 'apply') spy(Reflect, name, 'Reflect');
      for (const name of ['keys', 'values', 'entries', 'assign', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'getOwnPropertyNames', 'defineProperty', 'getPrototypeOf', 'setPrototypeOf', 'hasOwn', 'freeze', 'create']) spy(Object, name, 'Object');
      for (const name of ['hasOwnProperty', 'toString']) spy(Object.prototype, name, 'Object.prototype');
      spy(JSON, 'stringify', 'JSON');
    JS
    got = session.evaluate_script(<<~JS)
      (() => {
        const x = document.getElementById('x').contentWindow, p = document.getElementById('p'), f = document.getElementById('f');
        const blocked = (read) => { try { read(); return 'read'; } catch (e) { return e.name; } };
        const reads = [() => x.secret, () => x.location.href, () => x.document];
        const out = reads.map(blocked);
        for (const touch of [() => Object.keys(x), () => x.length, () => x[0], () => x.closed, () => x.location.replace, () => 'secret' in x,
                             () => p.attributes.x.value, () => Object.keys(p.attributes), () => p.style.color, () => Object.keys(p.style),
                             () => f.q, () => Object.keys(f), () => f.elements.q, () => (p.dataset.b = '2', p.dataset.a), () => Object.keys(p.dataset),
                             () => p.classList.add('d'), () => (localStorage.k = '1', localStorage.k), () => Object.keys(localStorage), () => JSON.stringify(location)]) {
          try { touch(); } catch (_) {}
        }
        return [out, leaks];
      })()
    JS
    expect(got).to eq([%w[SecurityError SecurityError SecurityError], []])
  end

  # …nor what a page puts in place of a method of Array.prototype's, Map's, Set's, WeakMap's, WeakSet's, Promise's or
  # String's, or of the array iterator's `next`: the bindings walk their lists and the engine's by index (engine.js
  # `listOf`, `listMap` and the rest), keep their state in collections of their own (intrinsics.js `InternalMap` …),
  # and chain promises by the `then` they took — a page's replacement is handed none of their functions, none of their
  # collections and none of what those hold, whatever the bindings do for it: a worker's message and a transfer, a
  # channel's, a fetch, an image, the observers, custom elements, a frame, a click and typing.
  it "hands a page's Array, Map, Set and Promise methods none of the bindings' functions or state" do
    session.visit '/state'
    session.execute_script(<<~JS)
      window.w = new Worker('/w2.js'); window.done = 0; w.onmessage = () => { /*PAGE*/ done++; };
    JS
    session.execute_script(<<~JS)
      const R = Reflect.apply, toString = Function.prototype.toString, gpo = Object.getPrototypeOf, own = Reflect.ownKeys;
      window.leaks = [];
      const mine = (f) => { const s = R(toString, f, []); return s.includes('PAGE') || s.includes('[native code]'); };
      const desc = (x) => typeof x === 'function' ? 'fn:' + R(toString, x, []).slice(0, 100).replace(/\\s+/g, ' ') : (x && typeof x === 'object' ? 'obj:' + (gpo(x) === null ? 'NULL:' : '') + own(x).slice(0, 6).map(String).join(',') : typeof x);
      const internal = (x) => (typeof x === 'function' && !mine(x)) || (x !== null && typeof x === 'object' && gpo(x) === null && own(x).length > 0);
      let busy = false;
      const note = (where, xs) => { if (busy) return; busy = true; try { for (let i = 0; i < xs.length; i++) if (internal(xs[i])) leaks.push(where + ' ' + desc(xs[i])); } finally { busy = false; } };
      const saved = [];
      const spyAll = (proto, label, names) => {
        for (const m of names) {
          const o = proto[m]; if (typeof o !== 'function') continue; saved.push([proto, m, o]);
          proto[m] = function (...args) { /*PAGE*/ note(label + '.' + String(m) + ' this', [this]); note(label + '.' + String(m) + ' arg', args);
            if (!busy && this && typeof this === 'object' && label === 'Array') { busy = true; try { for (let i = 0; i < this.length; i++) if (internal(this[i])) leaks.push(label + '.' + String(m) + ' elem ' + desc(this[i])); } finally { busy = false; } }
            return R(o, this, args); };
        }
      };
      spyAll(Array.prototype, 'Array', ['push', 'map', 'forEach', 'filter', 'slice', 'concat', 'splice', 'indexOf', 'includes', 'join', 'some', 'every', 'find', 'findIndex', 'reduce', 'flat', 'flatMap', 'fill', 'keys', 'values', 'entries', 'at', 'pop', 'shift', 'unshift', 'reverse', 'sort', 'toSorted', 'reduceRight', 'findLast', 'findLastIndex', Symbol.iterator]);
      spyAll(Map.prototype, 'Map', ['get', 'set', 'has', 'delete', 'forEach', 'keys', 'values', 'entries', 'clear', Symbol.iterator]);
      spyAll(Set.prototype, 'Set', ['add', 'has', 'delete', 'forEach', 'keys', 'values', 'entries', 'clear', Symbol.iterator]);
      spyAll(WeakMap.prototype, 'WeakMap', ['get', 'set', 'has', 'delete']);
      spyAll(WeakSet.prototype, 'WeakSet', ['add', 'has', 'delete']);
      spyAll(Promise.prototype, 'Promise', ['then', 'catch', 'finally']);
      spyAll(String.prototype, 'String', ['replace', 'replaceAll', 'split', 'match', 'matchAll']);
      spyAll(Object.getPrototypeOf([][Symbol.iterator]()), 'ArrayIterator', ['next']);
      // (…and no static of Math's, Number's, String's or ArrayBuffer's a page replaced is called at all: none's answer is
      // the page's to make up)
      for (const [holder, label, names] of [[Math, 'Math', ['min', 'max', 'floor', 'ceil', 'round', 'trunc', 'abs']], [Number, 'Number', ['isFinite', 'isNaN', 'isSafeInteger']], [String, 'String', ['fromCharCode']], [ArrayBuffer, 'ArrayBuffer', ['isView']]]) {
        for (const m of names) { const o = holder[m]; saved.push([holder, m, o]); holder[m] = function (...args) { /*PAGE*/ if (!busy) leaks.push(label + '.' + m + ' called'); return R(o, this, args); }; }
      }
      window.restore = () => { for (const [p, m, o] of saved) p[m] = o; };
      try {
        const img = new Image(); img.onload = () => { /*PAGE*/ done++; }; img.src = '/i.png'; document.body.append(img);
        fetch('/').then((r) => { /*PAGE*/ return r.text(); }).then(() => { /*PAGE*/ done++; });
        new BroadcastChannel('c').postMessage('x');
        const p = document.getElementById('p');
        p.classList.add('c'); [...p.classList]; p.dataset.y = '2'; Object.keys(p.dataset); p.style.color = 'blue'; p.attributes.x; Object.keys(p.attributes);
        new FormData(document.getElementById('fm')); document.getElementById('fm').elements.q;
        document.querySelectorAll('p').forEach(() => { /*PAGE*/ });
        new Blob(['a', 'b']).text().then(() => { /*PAGE*/ done++; });
        new Response('x').arrayBuffer();
        caches.open('c').then((c) => { /*PAGE*/ return c.addAll(['/']); }).catch(() => { /*PAGE*/ });
        navigator.locks.request('l', () => { /*PAGE*/ return 1; });
        new MutationObserver(() => { /*PAGE*/ }).observe(document.body, { subtree: true, attributes: true }); document.body.setAttribute('x', '1');
        structuredClone([new Map([[1, 2]]), new Set([1]), { a: [1] }]);
        const ab = new ArrayBuffer(8); w.postMessage({ ab, m: new Map([[1, 2]]) }, [ab]);
        const ch = new MessageChannel(); w.postMessage(1, [ch.port2]);
        postMessage({ a: [1] }, '*');
        history.pushState({ s: [1] }, '', '#a');
        new URLSearchParams([['a', 'b']]).toString(); new Headers([['a', 'b']]); [...new Headers([['a', 'b']])];
        Array.from(document.getElementsByTagName('option'));
        document.fonts.forEach(() => { /*PAGE*/ });
        getComputedStyle(document.body).getPropertyValue('color');
        document.body.animate([{ opacity: 0 }, { opacity: 1 }], 10).finished.then(() => { /*PAGE*/ });
        new TextDecoder().decode(new Uint8Array([65]));
        document.getElementById('t').content.cloneNode(true);
        const d = document.createElement('div'); d.innerHTML = '<b a=1>x</b><i>y</i>'; d.querySelectorAll('*'); d.remove();
        customElements.define('x-q', class extends HTMLElement { static observedAttributes = ['a']; attributeChangedCallback() { /*PAGE*/ } }); document.body.insertAdjacentHTML('beforeend', '<x-q a=1></x-q>');
        document.createElement('div').attachShadow({ mode: 'open' }).innerHTML = '<p>s</p>';
        const r = document.createRange(); r.selectNodeContents(document.body); r.getClientRects(); getSelection().selectAllChildren(p);
        document.getElementById('c').getContext('2d').fillRect(0, 0, 1, 1);
        new DOMParser().parseFromString('<p>x</p>', 'text/html');
        new URL('/a?b=c', location.href).searchParams.getAll('b');
        indexedDB.open('db').onsuccess = (e) => { /*PAGE*/ const db = e.target.result; };
        new IntersectionObserver(() => { /*PAGE*/ }).observe(p); new ResizeObserver(() => { /*PAGE*/ }).observe(p);
        requestAnimationFrame(() => { /*PAGE*/ }); setTimeout(() => { /*PAGE*/ }, 0); queueMicrotask(() => { /*PAGE*/ });
        document.getElementById('f').contentWindow.document.body.textContent;
        p.getBoundingClientRect(); p.focus(); document.title = 't';
        new EventTarget().addEventListener('x', () => { /*PAGE*/ });
        crypto.subtle.digest('SHA-256', new Uint8Array([1])).then(() => { /*PAGE*/ });
      } catch (e) { leaks.push('threw ' + e + ' ' + (e.stack || '').split('\\n').slice(0, 3).join(' | ')); }
    JS
    sleep 0.5
    session.find(:css, '#p').click
    session.find(:css, 'input[name=q]').set('zz')
    session.find(:css, 'select').select('a') rescue nil
    session.all(:css, 'p').map(&:text)
    session.find(:xpath, '//p').text
    session.within_frame('f') { session.evaluate_script('document.readyState') }
    poll_until { session.evaluate_script('done >= 4') }
    expect(session.evaluate_script('(() => { const l = leaks.slice(); restore(); return l; })()')).to eq([])
  end
end
