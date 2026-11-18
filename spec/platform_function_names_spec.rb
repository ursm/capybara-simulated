# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# The platform's functions read as a browser's own (Chrome measured 2026-11-18): an attribute's accessors named
# `get x` / `set x` (Web IDL §3.7.6) — a CSS property's on CSSStyleProperties too — `console`'s methods named after
# them, `Intl.DateTimeFormat` whatever the driver's time zone stands it in with, and each one's source
# `function NAME() { [native code] }`, the bindings' JavaScript no page's to read — a frame's read through the page's
# `Function.prototype.toString` as well. A page's own functions, and what is no function, read as ever.
RSpec.describe "the platform's functions" do
  WALK = <<~'JS'
    (roots) => {
      const R = Reflect, toString = Function.prototype.toString, seen = new Set(), bad = [];
      const check = (path, f) => {
        if (typeof f !== 'function' || seen.has(f)) return;
        seen.add(f);
        const source = R.apply(toString, f, []);
        if (!/^function [^(]*\(\) \{ \[native code\] \}$/.test(source)) bad.push(path + ': ' + source.slice(0, 60));
      };
      const walk = (path, o, depth) => {
        if (o === null || (typeof o !== 'object' && typeof o !== 'function') || seen.has(o) || depth > 3) return;
        if (typeof o !== 'function') seen.add(o);
        let keys; try { keys = R.ownKeys(o); } catch (_) { return; }
        for (const k of keys) {
          let d; try { d = R.getOwnPropertyDescriptor(o, k); } catch (_) { continue; }
          if (!d) continue;
          const at = path + '.' + String(k);
          if (d.get) check(at + ' get', d.get);
          if (d.set) check(at + ' set', d.set);
          if (typeof d.value === 'function') { check(at, d.value); walk(at, d.value, depth + 1); if (d.value.prototype) walk(at + '.prototype', d.value.prototype, depth + 1); }
          else if (d.value && typeof d.value === 'object') walk(at, d.value, depth + 1);
        }
        let proto; try { proto = R.getPrototypeOf(o); } catch (_) { proto = null; }
        if (proto) walk(path + '.__proto__', proto, depth + 1);
      };
      for (const [name, root] of roots) walk(name, root, 0);
      return bad;
    }
  JS

  let(:session) {
    simulated_session(lambda do |env|
      case env['PATH_INFO']
      when '/w.js' then [200, {'content-type' => 'text/javascript'}, ["postMessage((#{WALK})([['self', self], ['iterator', [][Symbol.iterator]()]]));"]]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><iframe srcdoc="<p>x"></iframe><iframe id=x src="http://other.test/"></iframe>']]
      end
    end)
  }

  def read(js) = session.evaluate_script(js)

  it 'are named as Web IDL names them' do
    session.visit '/'
    expect(read(<<~JS)).to eq(['get color', 'set color', 'get webkitAlignContent', 'get title', 'set title', %w[log debug error info warn], 'DateTimeFormat', 0, true])
      (() => {
        const d = (o, k) => Object.getOwnPropertyDescriptor(o, k);
        const css = CSSStyleProperties.prototype;
        return [d(css, 'color').get.name, d(css, 'color').set.name, d(css, 'webkitAlignContent').get.name,
                d(Document.prototype, 'title').get.name, d(Document.prototype, 'title').set.name,
                ['log', 'debug', 'error', 'info', 'warn'].map((k) => console[k].name),
                Intl.DateTimeFormat.name, Intl.DateTimeFormat.length,
                new Intl.DateTimeFormat().constructor === Intl.DateTimeFormat];
      })()
    JS
  end

  it 'read as native code, a page\'s own as it wrote them' do
    session.visit '/'
    got = read(<<~JS)
      (() => {
        const d = (o, k) => Object.getOwnPropertyDescriptor(o, k);
        const f = frames[0];
        return [String(Document.prototype.querySelector), String(Event), String(d(Node.prototype, 'nodeType').get), String(console.log),
                String(Intl.DateTimeFormat), String(Function.prototype.toString), Function.prototype.toString.call(f.Document.prototype.createElement),
                String(function mine() { return 1; }), String(Math.max),
                (() => { try { Function.prototype.toString.call({}); return 'none'; } catch (e) { return e.name; } })()];
      })()
    JS
    expect(got).to eq([
      'function querySelector() { [native code] }', 'function Event() { [native code] }', 'function get nodeType() { [native code] }',
      'function log() { [native code] }', 'function DateTimeFormat() { [native code] }', 'function toString() { [native code] }',
      'function createElement() { [native code] }', 'function mine() { return 1; }', 'function max() { [native code] }', 'TypeError'
    ])
  end

  # …every one a page can reach — a window's globals and their prototypes, members and accessors, a document's, an
  # iterator's, a cross-origin window's and its Location's, a worker's globals — none the bindings' source
  it 'are all native code, wherever a page reaches one' do
    session.visit '/'
    poll_until { session.evaluate_script("(() => { try { document.getElementById('x').contentWindow.document; return false; } catch (e) { return true; } })()") }
    got = session.evaluate_script(<<~JS)
      (#{WALK})([['window', window], ['document', document], ['location', location], ['iterator', new URLSearchParams('a=1').entries()],
                 ['nodes', document.querySelectorAll('p').entries()], ['crossOrigin', (() => { const x = document.getElementById('x').contentWindow; return { __proto__: null, close: x.close, focus: x.focus, blur: x.blur, postMessage: x.postMessage, replace: x.location.replace, closed: Object.getOwnPropertyDescriptor(x, 'closed').get, location: Object.getOwnPropertyDescriptor(x, 'location').set, href: Object.getOwnPropertyDescriptor(x.location, 'href').set }; })()]])
    JS
    expect(got).to eq([])
    session.execute_script("new Worker('/w.js').onmessage = (e) => { window.workerBad = e.data; };")
    expect(poll_until { session.evaluate_script('window.workerBad') }).to eq([])
  end
end
