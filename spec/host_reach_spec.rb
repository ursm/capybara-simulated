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
end
