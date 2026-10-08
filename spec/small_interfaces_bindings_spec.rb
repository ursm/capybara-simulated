# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# MediaError and SVGAnimatedString, generated from their IDL: made by the platform alone, brands checked, state in
# slots. Headless Chrome's figures.
RSpec.describe 'Small interface bindings' do
  let(:app) {
    lambda do |env|
      if env['PATH_INFO'] == '/a.xml'
        [200, {'content-type' => 'application/xml'}, ['<a/>']]
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body><svg><circle id=c class="a b"/></svg>']]
      end
    end
  }
  let(:session) {
    s = simulated_session(app)
    s.visit('/')
    s
  }

  it 'is what their IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        const c = document.getElementById('c');
        const name = c.className;
        const read = [name.baseVal, name.animVal, name === c.className];
        name.baseVal = 5;
        const set = [c.getAttribute('class'), name.animVal];
        name.animVal = 'x';
        return [
          error(() => new MediaError()),
          [MediaError.MEDIA_ERR_DECODE, MediaError.prototype.MEDIA_ERR_SRC_NOT_SUPPORTED, Object.getOwnPropertyNames(MediaError.prototype).sort()],
          error(() => Object.getOwnPropertyDescriptor(MediaError.prototype, 'code').get.call({})),
          error(() => new SVGAnimatedString()),
          read,
          set,
          c.getAttribute('class'),
          Object.getOwnPropertyNames(SVGAnimatedString.prototype).sort(),
          error(() => Object.getOwnPropertyDescriptor(SVGAnimatedString.prototype, 'baseVal').get.call({}))
        ];
      })()
    JS
    expect(got).to eq([
      "TypeError: Failed to construct 'MediaError': Illegal constructor",
      [3, 4, %w[MEDIA_ERR_ABORTED MEDIA_ERR_DECODE MEDIA_ERR_NETWORK MEDIA_ERR_SRC_NOT_SUPPORTED code constructor message]],
      'TypeError: Illegal invocation',
      "TypeError: Failed to construct 'SVGAnimatedString': Illegal constructor",
      ['a b', 'a b', true],
      %w[5 5],
      '5',
      %w[animVal baseVal constructor],
      'TypeError: Illegal invocation'
    ])
  end

  # BarProp and External are interfaces of their own, made by the platform alone: each bar of the window one BarProp
  # ([SameObject]), visible; External's two operations doing nothing.
  it 'gives the window its BarProps and its External' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
        return [
          [typeof BarProp, typeof External, locationbar instanceof BarProp, locationbar === window.locationbar, toolbar.visible],
          [Object.prototype.toString.call(statusbar), Object.prototype.toString.call(external), external instanceof External],
          [external.AddSearchProvider(), external.IsSearchProviderInstalled()],
          error(() => new BarProp()), error(() => new External()),
          error(() => Object.getOwnPropertyDescriptor(BarProp.prototype, 'visible').get.call({}))
        ];
      })()
    JS
    expect(got).to eq([
      ['function', 'function', true, true, true],
      ['[object BarProp]', '[object External]', true],
      [nil, nil],
      'TypeError', 'TypeError', 'TypeError'
    ])
  end

  # ValidityState and CustomStateSet are interfaces of their own, made by the platform alone: a control's validity a
  # live view ([SameObject]); a custom element's states a setlike<DOMString> (each value converted to a string) whose
  # mutations reach `:state()`.
  it 'gives a control its ValidityState and a custom element its CustomStateSet' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
        const input = document.createElement('input');
        input.required = true;
        const validity = input.validity;
        const before = [validity.valueMissing, validity.valid];
        input.value = 'x';
        class S extends HTMLElement { constructor() { super(); this.i = this.attachInternals(); } }
        customElements.define('x-states', S);
        const el = document.body.appendChild(new S());
        const states = el.i.states;
        states.add({toString: () => 'on'});
        const matched = el.matches(':state(on)');
        states.delete('on');
        return [
          [Object.prototype.toString.call(validity), validity === input.validity, before, validity.valueMissing, validity.valid, Object.keys(validity)],
          [Object.prototype.toString.call(states), states === el.i.states, matched, el.matches(':state(on)'), states.size, Object.keys(states)],
          [states.add('a') === states, [...states], states.has({toString: () => 'a'})],
          error(() => new ValidityState()), error(() => new CustomStateSet()),
          error(() => CustomStateSet.prototype.add.call(new Set(), 'x'))
        ];
      })()
    JS
    expect(got).to eq([
      ['[object ValidityState]', true, [true, false], false, true, []],
      ['[object CustomStateSet]', true, true, false, 0, []],
      [true, ['a'], true],
      'TypeError', 'TypeError', 'TypeError'
    ])
  end

  # ElementInternals keeps its state in its slots: its validity and message (a form reads them, not a page's
  # checkValidity), its submission value, and its ARIA default semantics; the binding converts setValidity's flags and
  # anchor and setFormValue's value.
  it 'gives a custom element its ElementInternals' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
        class F extends HTMLElement {
          static formAssociated = true;
          constructor() { super(); this.i = this.attachInternals(); }
        }
        customElements.define('x-face', F);
        const form = document.body.appendChild(document.createElement('form'));
        const el = form.appendChild(new F());
        el.setAttribute('name', 'f');
        const i = el.i;
        i.setFormValue(5);
        i.setValidity({valueMissing: 1}, 'need');
        ElementInternals.prototype.checkValidity = () => true;
        const formValid = form.checkValidity();
        i.role = 'button';
        i.ariaLabelledByElements = [el];
        return [
          [Object.prototype.toString.call(i), Object.keys(i), i.validity.valueMissing, i.validationMessage, formValid],
          [...new FormData(form)].map(([k, v]) => [k, v]),
          [i.role, i.ariaLabelledByElements === i.ariaLabelledByElements, i.ariaLabelledByElements[0] === el, i.ariaLabel],
          error(() => new ElementInternals()),
          error(() => i.setValidity({customError: true}, 'x', document.createElementNS('http://www.w3.org/2000/svg', 'g'))),
          error(() => i.setValidity({customError: true})),
          error(() => { i.ariaOwnsElements = [{}]; }),
          error(() => Object.getOwnPropertyDescriptor(ElementInternals.prototype, 'role').get.call({}))
        ];
      })()
    JS
    expect(got).to eq([
      ['[object ElementInternals]', [], true, 'need', false],
      [%w[f 5]],
      ['button', true, true, nil],
      'TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError'
    ])
  end

  # Validity is told by value, so a frame's getter or method answers for this realm's objects (Chrome: `valid` true);
  # setValidity sets the flags and the message, its newlines normalized, before refusing an anchor (HTML's step order,
  # Firefox's); and `:state()` reads the set by the intrinsic iterator, whatever a page put on Set.prototype.
  it "answers validity across realms, as setValidity's steps go, whatever a page does to Set" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const frame = document.body.appendChild(document.createElement('iframe')).contentWindow;
        class G extends HTMLElement {
          static formAssociated = true;
          constructor() { super(); this.i = this.attachInternals(); }
        }
        customElements.define('x-g', G);
        const el = document.body.appendChild(new G());
        const valid = Object.getOwnPropertyDescriptor(frame.ValidityState.prototype, 'valid').get.call(document.createElement('input').validity);
        let invalids = 0;
        el.addEventListener('invalid', () => invalids++);
        const checked = frame.ElementInternals.prototype.checkValidity.call(el.i);
        let refused;
        try { el.i.setValidity({valueMissing: true}, 'a\\r\\nb\\rc', document.body); } catch (e) { refused = e.name; }
        const after = [el.i.validity.valueMissing, el.i.validationMessage];
        const iterator = Set.prototype[Symbol.iterator];
        Set.prototype[Symbol.iterator] = function* () { yield 'hacked'; };
        el.i.states.add('p');
        Set.prototype[Symbol.iterator] = iterator;
        return [valid, checked, invalids, refused, after, el.matches(':state(p)'), el.matches(':state(hacked)')];
      })()
    JS
    expect(got).to eq([true, true, 0, 'NotFoundError', [true, "a\nb\nc"], true, false])
  end

  # An element's dataset is a DOMStringMap by its slots — any realm's — made by the platform alone, its named setter's
  # value a DOMString (a Symbol a TypeError, as Web IDL's conversion, where String() would have written "Symbol()").
  it 'gives an element its DOMStringMap' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
        const el = document.createElement('div');
        el.dataset.fooBar = {toString: () => 'x'};
        const frame = document.body.appendChild(document.createElement('iframe')).contentWindow;
        return [
          [Object.prototype.toString.call(el.dataset), el.dataset === el.dataset, el.getAttribute('data-foo-bar'), Object.keys(el.dataset)],
          el.dataset instanceof DOMStringMap,
          frame.Object.prototype.toString.call(frame.document.createElement('p').dataset),
          error(() => new DOMStringMap()),
          error(() => { el.dataset.sym = Symbol(); }),
          el.hasAttribute('data-sym')
        ];
      })()
    JS
    expect(got).to eq([['[object DOMStringMap]', true, 'x', ['fooBar']], true, '[object DOMStringMap]', 'TypeError', 'TypeError', false])
  end

  # An element's attributes are a NamedNodeMap by its slots, made by the platform alone: its operations run the
  # element's attribute steps, not members a page replaced on Element.prototype; its @@iterator %Array.prototype.values%;
  # a frame's members work on it.
  it 'gives an element its NamedNodeMap' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
        const el = document.createElement('div');
        el.setAttribute('a', '1');
        el.setAttribute('b', '2');
        const map = el.attributes;
        const own = Element.prototype.getAttributeNode;
        Element.prototype.getAttributeNode = () => 'page';
        const named = map.getNamedItem('a');
        Element.prototype.getAttributeNode = own;
        const frame = document.body.appendChild(document.createElement('iframe')).contentWindow;
        const removed = frame.NamedNodeMap.prototype.removeNamedItem.call(map, 'b');
        return [
          [Object.prototype.toString.call(map), map === el.attributes, map.length, Object.keys(map), named && named.value],
          [map[Symbol.iterator] === Array.prototype.values, [...map].map((a) => a.name), map.item(-1), removed.name, el.hasAttribute('b')],
          error(() => new NamedNodeMap()),
          error(() => map.removeNamedItem('nope')),
          error(() => Object.getOwnPropertyDescriptor(NamedNodeMap.prototype, 'length').get.call({})),
          error(() => map.setNamedItem({}))
        ];
      })()
    JS
    expect(got).to eq([
      ['[object NamedNodeMap]', true, 1, %w[0], '1'],
      [true, %w[a], nil, 'b', false],
      'TypeError', 'NotFoundError', 'TypeError', 'TypeError'
    ])
  end

  # Both are legacy platform objects as Web IDL §3.9 says (Chrome and Firefox where they agree): a dataset's named
  # setter converts its value before it checks the name, [[DefineOwnProperty]] runs it, a symbol expando is the map's
  # own, and an object inheriting from it gets a property of its own; a NamedNodeMap's indices are read-only to an
  # inheriting object too and in strict code; neither is made non-extensible; a map's uppercase names follow its
  # element into an XML document.
  it 'are legacy platform objects as Web IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        'use strict';
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
        const el = document.createElement('div');
        const ds = el.dataset;
        const order = error(() => { ds['a-b'] = {toString() { throw new RangeError(); }}; });
        const defined = Reflect.defineProperty(ds, 'qq', {value: 'v'});
        const accessor = Reflect.defineProperty(ds, 'acc', {get() {}});
        const sym = Symbol();
        ds[sym] = 1;
        const child = Object.create(ds);
        child.bar = 'x';
        el.setAttribute('a', '1');
        const map = el.attributes;
        const mapChild = Object.create(map);
        const n = document.createElement('p');
        const nmap = n.attributes;
        n.setAttributeNS(null, 'Baz', '1');
        document.implementation.createDocument(null, 'r').documentElement.append(n);
        return [
          [order, defined, el.getAttribute('data-qq'), accessor, Object.keys(ds)],
          [Object.getOwnPropertySymbols(ds).length, Object.hasOwn(ds, sym), el.hasAttribute('data-bar'), Object.hasOwn(child, 'bar')],
          [Reflect.preventExtensions(ds), Reflect.preventExtensions(map), Object.keys(ds).length],
          [Reflect.set(mapChild, '0', 'x', mapChild), error(() => { map.length = 5; }), error(() => { map[0] = 1; })],
          ['Baz' in nmap, Object.getOwnPropertyNames(nmap)]
        ];
      })()
    JS
    expect(got).to eq([
      ['RangeError', true, 'v', false, ['qq']],
      [1, true, false, true],
      [false, false, 1],
      [false, 'TypeError', 'TypeError'],
      [true, %w[0 Baz]]
    ])
  end

  # An XMLDocument is made by the platform alone — createDocument, a clone of one — never by a page's `new` (Chrome:
  # TypeError); an XML DOMParser parse is a Document (HTML's parseFromString: "a new Document"; Chrome and Firefox:
  # XMLDocument), an XHR's XML response an XMLDocument (XHR: "a document"; Chrome and Firefox).
  it 'makes XMLDocuments' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const t = (o) => Object.prototype.toString.call(o);
        const created = document.implementation.createDocument(null, 'a');
        let made;
        try { new XMLDocument(); made = 'none'; } catch (e) { made = e.name; }
        return [
          t(created), t(new DOMParser().parseFromString('<a/>', 'application/xml')),
          t(new DOMParser().parseFromString('<a/>', 'text/html')), t(created.cloneNode(true)), t(new Document()),
          made, created instanceof XMLDocument, new Document() instanceof XMLDocument
        ];
      })()
    JS
    expect(got).to eq([
      '[object XMLDocument]', '[object Document]', '[object Document]', '[object XMLDocument]', '[object Document]',
      'TypeError', true, false
    ])

    got = session.evaluate_script(<<~JS)
      (() => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '/a.xml', false);
        xhr.send();
        return Object.prototype.toString.call(xhr.responseXML);
      })()
    JS
    expect(got).to eq('[object XMLDocument]')
  end

  # A clone is of the node's own interface — never by the `constructor` a page replaced or subclassed, nor a document
  # by a named element its brand's name would read on into (Chrome).
  it 'clones of their own interface' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const t = (o) => Object.prototype.toString.call(o);
        const form = document.createElement('form');
        form.name = '_xmlDocument';
        document.body.append(form);
        let ran = 0;
        class F extends DocumentFragment { constructor() { super(); ran++; } }
        const sub = new F().cloneNode();
        const replaced = document.createDocumentFragment();
        replaced.constructor = function X() {};
        return [
          t(document.cloneNode()), ran, sub instanceof F, t(sub), t(replaced.cloneNode()),
          t(new DOMParser().parseFromString('<form name="_xmlDocument">', 'text/html').cloneNode(true))
        ];
      })()
    JS
    expect(got).to eq([
      '[object Document]', 1, false, '[object DocumentFragment]', '[object DocumentFragment]', '[object Document]'
    ])
  end
end
