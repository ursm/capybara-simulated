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
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><div id=a><span id=b></span></div><button id=button>b</button><input id=field name=field><div id=source draggable=true>s</div><a id=fractional href=#x style="position:absolute;left:0.25px;top:80.5px;width:97.8125px;height:15.5px">f</a><script>window.coordinates = []; for (const type of ["mousedown", "mouseup", "mousemove", "click", "dblclick", "contextmenu", "auxclick", "pointerdown", "pointermove", "pointerup", "dragstart", "drop", "dragend"]) document.addEventListener(type, (e) => { if (e.target.id === "fractional" || e.target.id === "source") window.coordinates.push([e.type, e.clientX, e.clientY, e.screenX, e.screenY].join(" ")); }, true);window.shadowChild = document.body.appendChild(document.createElement("div")).attachShadow({mode: "open"}).appendChild(document.createElement("i"));</script>']]
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
      el.dispatchEvent(new Event('no node listens to this', {bubbles: true}));
      const inner = shadowChild;
      inner.addEventListener('z', (e) => { out.shadowPath = e.composedPath().length; });
      inner.dispatchEvent(new Event('z', {bubbles: true, composed: true}));
      window.addEventListener('w', () => {}, {once: true});
      document.addEventListener('d', () => {}, {once: true});
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
        const seen = Object.create(null);
        const hit = (what) => { seen[what] = true; };
        const shadowChild = window.shadowChild;
        #{change}
        let out, threw = null;
        try { out = (() => { #{steps} })(); } catch (e) { threw = String(e); }
        #{restore}
        return {out, threw, hits: Object.keys(seen)};
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
    'a replaced Map.prototype.get and set' => [
      "const g = Map.prototype.get, t = Map.prototype.set; Map.prototype.get = function (k) { hit('get'); return g.call(this, k); }; Map.prototype.set = function (k, v) { hit('set'); return t.call(this, k, v); };",
      'Map.prototype.get = g; Map.prototype.set = t;'
    ],
    'a replaced Set.prototype.has and add' => [
      "const h = Set.prototype.has, a = Set.prototype.add; Set.prototype.has = function (v) { hit('has'); return h.call(this, v); }; Set.prototype.add = function (v) { hit('add'); return a.call(this, v); };",
      'Set.prototype.has = h; Set.prototype.add = a;'
    ],
    'accessors on Object.prototype named as a slot' => [
      "const names = ['owner', 'Event', 'MouseEvent', 'target', 'type', 'modifiers', 'dispatchFlag', 'removed']; for (const n of names) Object.defineProperty(Object.prototype, n, {get() { hit('get ' + n); }, set(v) { hit('set ' + n); }, configurable: true});",
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

  # (…each of these a global the page has replaced, or taken away)
  {
    'Object.defineProperty' => 'Object.defineProperty = undefined;',
    'Reflect.apply'         => 'Reflect.apply = undefined;',
    'Object.freeze'         => 'Object.freeze = undefined;',
    'Object.assign'         => 'Object.assign = undefined;'
  }.each do |name, change|
    it "needs no #{name} of the page's" do
      session.visit '/'
      session.execute_script(change)
      expect(session.evaluate_script(<<~JS)).to eq(expected)
        (() => {
          const shadowChild = window.shadowChild;
          #{steps}
        })()
      JS
    end
  end

  # (…the engine's own events, by every gesture a driver plays: what their inits leave out is no member of a page's)
  it 'reads nothing of Object.prototype making the events of a gesture' do
    session.visit '/form'
    session.execute_script(<<~'JS')
      window.hits = new Map();
      for (const name of [
        'view', 'detail', 'which', 'bubbles', 'cancelable', 'composed', 'relatedTarget', 'clientX', 'clientY', 'screenX', 'screenY',
        'button', 'buttons', 'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'movementX', 'movementY', 'modifierAltGraph', 'modifierCapsLock',
        'pointerId', 'width', 'height', 'pressure', 'tangentialPressure', 'tiltX', 'tiltY', 'twist', 'altitudeAngle', 'azimuthAngle',
        'pointerType', 'isPrimary', 'coalescedEvents', 'predictedEvents', 'persistentDeviceId', 'dataTransfer', 'data', 'inputType',
        'isComposing', 'targetRanges', 'key', 'code', 'location', 'repeat', 'charCode', 'keyCode', 'submitter', 'oldState', 'newState'
      ]) {
        Object.defineProperty(Object.prototype, name, {
          get() { window.hits.set(name, true); },
          // (…the host's own write of an object it hands in stays a write: rusty_racer's Object::set, not the platform's)
          set(value) { Object.defineProperty(this, name, {value, writable: true, enumerable: true, configurable: true}); },
          configurable: true
        });
      }
    JS
    session.find('#button').click
    session.find('#button').right_click
    session.find('#button').double_click
    session.find('#button').hover
    session.fill_in('field', with: 'x')
    session.find('#field').send_keys('y', :enter)
    session.find('#source').drag_to(session.find('#button'))
    hits = session.evaluate_script('(() => { const out = []; window.hits.forEach((_, k) => { out[out.length] = k; }); return out.sort(); })()')
    expect(hits).to eq([])
  end

  it 'makes an event whatever a page has put in the chain of its interface objects' do
    expect(session.evaluate_script(<<~JS)).to eq([2, 'x', 0, true])
      (() => {
        Object.setPrototypeOf(MouseEvent, null);
        const clientX = new MouseEvent('x', {clientX: 2}).clientX;
        Object.setPrototypeOf(MouseEvent, UIEvent);
        let called = 0;
        const own = Object.getPrototypeOf(CustomEvent);
        Object.setPrototypeOf(CustomEvent, function () { called++; });
        const custom = new CustomEvent('x');
        Object.setPrototypeOf(CustomEvent, own);
        class Mine extends MouseEvent {}
        return [clientX, custom.type, called, new Mine('m') instanceof UIEvent];
      })()
    JS
  end

  # (…DOM "add an event listener": the signal's abort removes that listener, not one like it added since — spec; Firefox)
  it "removes on abort the signal's own listener, not one added again since" do
    expect(session.evaluate_script(<<~JS)).to eq(1)
      (() => {
        const el = document.getElementById('b'), controller = new AbortController();
        let heard = 0;
        const f = () => { heard++; };
        el.addEventListener('s', f, {signal: controller.signal});
        el.removeEventListener('s', f);
        el.addEventListener('s', f);
        controller.abort();
        el.dispatchEvent(new Event('s'));
        return heard;
      })()
    JS
  end

  # (…Chrome's and Firefox's, measured: `initUIEvent` and `initEvent` leave both)
  it 'resets what a legacy init leaves out' do
    expect(session.evaluate_script(<<~JS)).to eq([false, false, 0, 0, 0, true, 5])
      (() => {
        const mouse = new MouseEvent('x', {modifierAltGraph: true});
        mouse.initMouseEvent('y');
        const key = new KeyboardEvent('x', {modifierCapsLock: true, detail: 5});
        key.initKeyboardEvent('y');
        const composition = new CompositionEvent('x', {detail: 5});
        composition.initCompositionEvent('y');
        const text = document.createEvent('TextEvent');
        text.initUIEvent('u', false, false, null, 5);
        text.initTextEvent('y');
        const ui = new MouseEvent('x', {modifierCapsLock: true, detail: 5});
        ui.initEvent('y');
        return [
          mouse.getModifierState('AltGraph'),
          key.getModifierState('CapsLock'),
          key.detail,
          composition.detail,
          text.detail,
          ui.getModifierState('CapsLock'),
          ui.detail
        ];
      })()
    JS
  end

  # (…the init's members `double`s, a non-finite one a TypeError; each attribute floored, but a PointerEvent's that is none
  # of the three types Pointer Events keeps to `long`s: Chrome's and Firefox's, the two drafts disagreeing)
  it "floors a mouse event's coordinates, and keeps a pointer event's" do
    expect(session.evaluate_script(<<~JS)).to eq(['TypeError', 'TypeError', 1, -2, 2, -3, 1, 1, 2, 1.5, -1.5, 1, 1, 1, 1])
      (() => {
        const outcome = (f) => { try { return f(); } catch (e) { return e.constructor.name; } };
        const init = document.createEvent('MouseEvent');
        init.initMouseEvent('a', true, true, null, 0, 0, 0, 1.5);
        const mouse = new MouseEvent('x', {clientX: 1.5, clientY: -1.5, screenX: 2.5, screenY: -2.5});
        return [
          outcome(() => new MouseEvent('x', {clientX: NaN})),
          outcome(() => new MouseEvent('x', {screenY: Infinity})),
          mouse.clientX,
          mouse.clientY,
          mouse.screenX,
          mouse.screenY,
          mouse.x,
          new DragEvent('x', {clientX: 1.5}).clientX,
          new WheelEvent('x', {screenY: 2.5}).screenY,
          new PointerEvent('x', {clientX: 1.5}).x,
          new PointerEvent('pointerdown', {screenY: -1.5}).screenY,
          new PointerEvent('click', {clientX: 1.5}).clientX,
          new PointerEvent('auxclick', {clientX: 1.5}).clientX,
          new PointerEvent('contextmenu', {clientX: 1.5}).clientX,
          init.clientX
        ];
      })()
    JS
  end

  # (…what every suite missed: the driver's own point, WebDriver's floored centre, on a box of a fractional width)
  it "clicks at a whole pixel, whatever an element's box measures" do
    session.visit '/fractional'
    session.find('#fractional').click
    session.find('#fractional').right_click
    session.find('#fractional').double_click
    session.find('#fractional').hover
    session.find('#source').drag_to(session.find('#fractional'))
    seen = session.evaluate_script('window.coordinates')
    expect(seen).not_to be_empty
    expect(seen.grep_v(/\A[a-z]+ -?\d+ -?\d+ -?\d+ -?\d+\z/)).to eq([])
    expect(session.evaluate_script('document.getElementById("fractional").getBoundingClientRect().width % 1')).to be > 0
  end

  # (…a dispatch's blank lists, however many depths: kept up to one per short length, and one past them doubled)
  it 'keeps one blank list, however many depths a shadow dispatch has been at' do
    expect(session.evaluate_script(<<~JS)).to eq(4 + 600)
      (() => {
        const host = document.body.appendChild(document.createElement('div'));
        let node = host.attachShadow({mode: 'open'}).appendChild(document.createElement('i'));
        let last = 0;
        for (let i = 0; i < 600; i++) {
          node.addEventListener('d', (e) => { last = e.composedPath().length; }, {once: true});
          node.dispatchEvent(new Event('d', {bubbles: true, composed: false}));
          node = node.appendChild(document.createElement('i'));
        }
        return last + 4 - 1;
      })()
    JS
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
