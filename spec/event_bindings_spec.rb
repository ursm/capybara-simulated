# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The event interfaces' bindings (script/gen_bindings.mjs `eventInterface`) and the dispatch behind them, on a page that has
# changed what its Array.prototype answers: nothing of the platform's own consults it. Each page's change counts the calls
# it sees, none of them the platform's. (Of the events' paths: inserting a node, which many a `for…of` of the platform's
# does walk by such an iterator, is left out of it, the shadow tree made before the change.)
RSpec.describe 'Event bindings on a hostile page' do
  let(:session) do
    simulated_session(lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><div id=a><span id=b></span></div>']]
    })
  end

  before { session.visit '/' }

  let(:steps) do
    <<~'JS'
      const el = document.getElementById('b');
      const out = {};
      out.event = new Event('x', {bubbles: true}).bubbles;
      out.detail = new CustomEvent('x', {detail: 1}).detail;
      out.mouse = new MouseEvent('x', {clientX: 3, modifierAltGraph: true}).getModifierState('AltGraph');
      out.pointer = new PointerEvent('x', {tiltX: 45}).tiltX;
      out.key = new KeyboardEvent('x', {keyCode: 7}).which;
      const init = document.createEvent('MouseEvent');
      init.initMouseEvent('m', true, true, window, 1, 2, 3, 4, 5, false, false, false, false, 0, el);
      out.initMouse = init.clientX;
      let order = '';
      const first = () => { order += 'a'; }, second = () => { order += 'b'; }, third = () => { order += 'c'; };
      el.addEventListener('y', first);
      el.addEventListener('y', second, {once: true});
      el.addEventListener('y', third);
      el.removeEventListener('y', third);
      el.addEventListener('y', (e) => { out.path = e.composedPath().length; });
      el.dispatchEvent(new Event('y', {bubbles: true}));
      el.dispatchEvent(new Event('y', {bubbles: true}));
      out.order = order;
      const inner = shadowChild;
      inner.addEventListener('z', (e) => { out.shadowPath = e.composedPath().length; });
      inner.dispatchEvent(new Event('z', {bubbles: true, composed: true}));
      const target = new EventTarget();
      target.addEventListener('t', (e) => { out.flatPath = e.composedPath().length; });
      target.dispatchEvent(new Event('t'));
      let clicked = 0;
      el.addEventListener('click', () => { clicked++; });
      el.click();
      out.clicked = clicked;
      return out;
    JS
  end

  let(:expected) do
    {
      'event'      => true,
      'detail'     => 1,
      'mouse'      => true,
      'pointer'    => 45,
      'key'        => 7,
      'initMouse'  => 4,
      'path'       => 6,
      'order'      => 'aba',
      'shadowPath' => 7,
      'flatPath'   => 1,
      'clicked'    => 1
    }
  end

  def results_under(change, restore)
    session.evaluate_script(<<~JS)
      (() => {
        const seen = new Map();
        const hit = (what) => { seen.set(what, true); };
        const shadowChild = document.body.appendChild(document.createElement('div')).attachShadow({mode: 'open'}).appendChild(document.createElement('i'));
        #{change}
        let out, threw = null;
        try { out = (() => { #{steps} })(); } catch (e) { threw = String(e); }
        #{restore}
        const hits = [];
        seen.forEach((_, what) => { hits[hits.length] = what; });
        return {out, threw, hits};
      })()
    JS
  end

  {
    'a replaced Array.prototype[Symbol.iterator]' => [
      "const own = Array.prototype[Symbol.iterator]; Array.prototype[Symbol.iterator] = function () { hit('iterator'); return own.call(this); };",
      'Array.prototype[Symbol.iterator] = own;'
    ],
    'a replaced %ArrayIteratorPrototype%.next' => [
      "const ip = Object.getPrototypeOf([][Symbol.iterator]()), own = ip.next; ip.next = function () { hit('next'); return own.call(this); };",
      'ip.next = own;'
    ],
    'a replaced Array.prototype.concat' => [
      "const own = Array.prototype.concat; Array.prototype.concat = function (...a) { hit('concat'); return own.apply(this, a); };",
      'Array.prototype.concat = own;'
    ],
    'a Symbol.isConcatSpreadable getter on Array.prototype' => [
      "Object.defineProperty(Array.prototype, Symbol.isConcatSpreadable, {get() { hit('spreadable'); return true; }, configurable: true});",
      'delete Array.prototype[Symbol.isConcatSpreadable];'
    ],
    'index accessors on Array.prototype' => [
      "for (let i = 0; i < 8; i++) Object.defineProperty(Array.prototype, i, {get() { hit('get'); }, set(v) { hit('set'); }, configurable: true});",
      'for (let i = 0; i < 8; i++) delete Array.prototype[i];'
    ],
    'a replaced Array.prototype.slice and push' => [
      "const s = Array.prototype.slice, p = Array.prototype.push; Array.prototype.slice = function (...a) { hit('slice'); return s.apply(this, a); }; Array.prototype.push = function (...a) { hit('push'); return p.apply(this, a); };",
      'Array.prototype.slice = s; Array.prototype.push = p;'
    ],
    'a constructor getter on Array.prototype (the species a builtin reads)' => [
      "const d = Object.getOwnPropertyDescriptor(Array.prototype, 'constructor'); Object.defineProperty(Array.prototype, 'constructor', {get() { hit('constructor'); return Array; }, configurable: true});",
      "Object.defineProperty(Array.prototype, 'constructor', d);"
    ],
    'accessors on Object.prototype named as a slot' => [
      "const names = ['owner', 'Event', 'MouseEvent', 'target', 'type', 'modifiers', 'dispatchFlag']; for (const n of names) Object.defineProperty(Object.prototype, n, {get() { hit('get ' + n); }, set(v) { hit('set ' + n); }, configurable: true});",
      'for (const n of names) delete Object.prototype[n];'
    ]
  }.each do |name, (change, restore)|
    it "keeps events working and out of sight of #{name}" do
      result = results_under(change, restore)
      expect(result['threw']).to be_nil
      expect(result['out']).to eq(expected)
      expect(result['hits']).to eq([])
    end
  end

  it "still walks a page's own iterable by its iterator: a sequence member of an init" do
    expect(session.evaluate_script(<<~JS)).to eq([1, true, 2])
      (() => {
        let walked = 0;
        const iterable = {*[Symbol.iterator]() { walked++; }};
        const ev = new FontFaceSetLoadEvent('x', {fontfaces: iterable});
        const ports = new MessageChannel();
        const message = new MessageEvent('m', {ports: new Set([ports.port1, ports.port2])});
        return [walked, Object.isFrozen(message.ports), message.ports.length];
      })()
    JS
  end

  it 'reads each attribute from one slot, whichever realm made the event, and refuses any other `this`' do
    expect(session.evaluate_script(<<~JS)).to eq([7, 'TypeError', 'TypeError', true])
      (() => {
        const frame = document.body.appendChild(document.createElement('iframe'));
        const get = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'clientX').get;
        const outcome = (f) => { try { return f(); } catch (e) { return e.constructor.name; } };
        return [
          get.call(new frame.contentWindow.MouseEvent('x', {clientX: 7})),
          outcome(() => get.call(new Event('x'))),
          outcome(() => MouseEvent.prototype.clientX),
          Object.getOwnPropertyDescriptor(new Event('x'), 'isTrusted').configurable === false
        ];
      })()
    JS
  end
end
