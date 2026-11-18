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
end
