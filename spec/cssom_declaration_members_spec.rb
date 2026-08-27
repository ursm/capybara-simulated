# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The CSSStyleDeclaration interface itself, as opposed to the property NAMES it carries (those are
# `cssom_property_presence_spec.rb`). A declaration here is a Proxy that answers `in` and a read from
# its traps, and for a long time that was ALL it answered: nothing was ever defined on
# `CSSStyleDeclaration.prototype`, so `Reflect.ownKeys` / `Reflect.getOwnPropertyDescriptor` walking
# the chain came back empty and `CSSStyleDeclaration.prototype.setProperty` was `undefined`. The
# prototype now carries what CSSOM puts on it: the interface's own eight members, and an IDL
# attribute for every supported CSS property.
#
# Chrome puts the property attributes somewhere else entirely — own, enumerable, configurable DATA
# properties on each instance (measured, 151.0.7922.169: 745 on an inline declaration, 1220 on a
# computed one, being those plus its indices), with only its own nine on the prototype (the eight
# below plus `cssFloat`). That placement is what makes Chrome fail
# `css/cssom/cssstyledeclaration-properties.html`'s `assert_false(hasOwnProperty("color"))`; we
# follow the spec instead and pass both it and `css/css-logical/getComputedStyle-listing.html`.
RSpec.describe 'the CSSStyleDeclaration interface surface' do
  def style_probe
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<body><div id="a"></div></body>']] })
    s.visit '/'
    s
  end

  # A member runs only when it is reached off the bare prototype, where there is no declaration
  # behind `this` — a declaration answers from its own traps. That is WebIDL's brand check, and
  # Chrome throws the same TypeError from the members IT keeps on the prototype (measured,
  # 151.0.7922.169: `cssText`, `length` and `cssFloat` all give "Illegal invocation"). `p.color` is
  # not measurable there — Chrome has no per-property attribute on the prototype at all, so the read
  # is `undefined` and the write makes an expando — and this is the deliberate divergence: we put
  # those attributes where CSSOM does, which means they brand-check like every other member.
  it 'throws when a member is used on the bare prototype' do
    s = style_probe
    expect(s.evaluate_script(<<~JS)).to eq(['TypeError', 'TypeError', 'TypeError', 'TypeError'])
      (() => { const p = CSSStyleDeclaration.prototype;
               const threw = (f) => { try { f(); return 'no throw'; } catch (e) { return e.constructor.name; } };
               return [threw(() => p.color), threw(() => { p.color = 'red'; }),
                       threw(() => p.cssText), threw(() => p.item(0))]; })()
    JS
  end

  # The brand is the implementation a declaration carries, not its shape: duck-typing on
  # `getPropertyValue` would hand a spoofed receiver the real answer, and would have stopped
  # rejecting the bare prototype the moment the interface methods landed there. It is carried under
  # a registry symbol so it survives a realm crossing (see the last example), which does mean a page
  # that mints the same symbol can imitate it — reach across realms is worth that.
  it 'refuses a receiver that merely looks like a declaration' do
    s = style_probe
    expect(s.evaluate_script(<<~JS)).to eq('TypeError')
      (() => { try {
                 return Reflect.get(CSSStyleDeclaration.prototype, 'color', {getPropertyValue: () => 'spoofed'});
               } catch (e) { return e.constructor.name; } })()
    JS
  end

  # CSSOM's own members had the same hole the property attributes did: `'setProperty' in el.style`
  # was true while `CSSStyleDeclaration.prototype.setProperty` was `undefined`, so anything that
  # reflects over the interface — or wraps a method on it — saw nothing to work with.
  it "exposes the interface's own members on the prototype too" do
    s = style_probe
    shapes = [
      'getPropertyValue/1',
      'getPropertyPriority/1',
      'setProperty/2',
      'removeProperty/1',
      'item/1',
      'cssText/rw',
      'length/r',
      'parentRule/r'
    ]
    expect(s.evaluate_script(<<~JS)).to eq(shapes)
      (() => { const p = CSSStyleDeclaration.prototype;
               // The arity is the interface's own: WebIDL counts only the REQUIRED arguments, so
               // `setProperty` is 2 even though it takes a priority (measured in Chrome, which
               // reports 1/1/2/1/1). A `(...args)` wrapper would report 0 for every one of them.
               const shape = (n) => { const d = Object.getOwnPropertyDescriptor(p, n);
                                      if (!d) return n + '/missing';
                                      if (!d.get) return n + '/' + d.value.length;
                                      return n + '/' + (d.set ? 'rw' : 'r'); };
               return ['getPropertyValue', 'getPropertyPriority', 'setProperty', 'removeProperty', 'item',
                       'cssText', 'length', 'parentRule'].map(shape); })()
    JS
  end

  # `for…in` over a declaration used to walk NOTHING, because everything was synthesized. It now
  # walks the prototype the way a browser's does — Chrome yields 745 names for an inline declaration
  # and 1220 for a computed one, all own; ours are inherited, and it yields the dashed spellings
  # too, which Chrome does not carry. `Object.keys` stays empty either way: the indexed run is the
  # one own-property surface we still do not model (see cssom_property_presence_spec).
  it 'walks the interface in a for-in, and still owns nothing' do
    s = style_probe
    expect(s.evaluate_script(<<~JS)).to eq([true, true, true, true, 0])
      (() => { const st = document.getElementById('a').style; const seen = [];
               for (const k in st) seen.push(k);
               return [seen.length > 1000, seen.includes('setProperty'), seen.includes('marginInlineStart'),
                       seen.includes('margin-inline-start'), Object.keys(st).length]; })()
    JS
  end

  # A member is ONE function, held by the prototype and shared by every declaration — measured in
  # Chrome, where `a.style.item`, `b.style.item` and `CSSStyleDeclaration.prototype.item` are the
  # same object. Synthesizing it per read handed back a new closure every time, which
  # `html/rendering/…/multicol-standards-mode.html` sees the moment it compares two computed styles
  # member by member.
  it 'hands every declaration the same function for a member' do
    s = style_probe
    expect(s.evaluate_script(<<~JS)).to eq([true, true, true])
      (() => { const a = document.getElementById('a'), b = document.body, p = CSSStyleDeclaration.prototype;
               return [a.style.item === b.style.item, a.style.item === p.item,
                       getComputedStyle(a).getPropertyValue === getComputedStyle(b).getPropertyValue]; })()
    JS
  end

  # …and they have to be the real thing when called with a real declaration, not a stub that keeps
  # reflection happy.
  it 'runs the declaration through a member taken off the prototype' do
    s = style_probe
    expect(s.evaluate_script(<<~JS)).to eq(['3px', 'margin-left: 3px;', 1])
      (() => { const p = CSSStyleDeclaration.prototype, st = document.getElementById('a').style;
               p.setProperty.call(st, 'margin-left', '3px');
               return [p.getPropertyValue.call(st, 'margin-left'),
                       Object.getOwnPropertyDescriptor(p, 'cssText').get.call(st),
                       Object.getOwnPropertyDescriptor(p, 'length').get.call(st)]; })()
    JS
  end

  # The descriptor must stay a live view of the declaration, not a snapshot taken when it was
  # defined: reflection and reading have to agree about the same element.
  it 'reads and writes the declaration through the prototype accessor' do
    s = style_probe
    expect(s.evaluate_script(<<~JS)).to eq(['', '3px', ''])
      (() => { const el = document.getElementById('a');
               const get = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'marginInlineStart').get;
               const set = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'marginInlineStart').set;
               const before = get.call(el.style);
               set.call(el.style, '3px');
               const after = get.call(el.style);
               set.call(el.style, null);           // [LegacyNullToEmptyString] clears, not "null"
               return [before, after, get.call(el.style)]; })()
    JS
  end

  # The WPT test that motivated all of this starts its walk at the COMPUTED declaration, whose proxy
  # target is the INLINE one — two proxies deep. Pinning the prototype alone would not catch a
  # change to that chain.
  it 'finds a property by walking the chain from a computed declaration' do
    s = style_probe
    expect(s.evaluate_script(<<~JS)).to eq([true, true, true])
      (() => { const found = (o, n) => { while (o) { if (Reflect.getOwnPropertyDescriptor(o, n)) return true;
                                                     o = Reflect.getPrototypeOf(o); } return false; };
               const keyed = (o, n) => { while (o) { if (Reflect.ownKeys(o).includes(n)) return true;
                                                     o = Reflect.getPrototypeOf(o); } return false; };
               const cs = getComputedStyle(document.getElementById('a'));
               return [found(cs, 'borderBlockEndColor'), keyed(cs, 'borderBlockEndColor'),
                       found(getComputedStyle(document.createElement('div')), 'marginInlineStart')]; })()
    JS
  end

  # A member on the prototype runs in the realm of whoever READS it, while the declaration it has to
  # reach was built by the realm that owns the node — and an iframe is its own realm, with its own
  # prototype. A node adopted out of one therefore crosses that line on every member call, which is
  # what `css/cssom/style-attr-update-across-documents.html` exercises. Keying the implementation off
  # a per-realm map left the reader with nothing to look up; a registry symbol is the one key both
  # realms agree on.
  it 'reaches the declaration of a node adopted out of an iframe' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<body><iframe id="f" srcdoc="<div></div>"></iframe></body>']] })
    s.visit '/'
    expect(s.evaluate_script(<<~JS)).to eq(['blue', 'rgb(0, 0, 255)', 1])
      (() => { const p = CSSStyleDeclaration.prototype;                     // the MAIN realm's
               const adopted = document.getElementById('f').contentDocument.createElement('div');
               document.body.appendChild(adopted);                          // …adopts it into this one
               Object.getOwnPropertyDescriptor(p, 'backgroundColor').set.call(adopted.style, 'blue');
               return [p.getPropertyValue.call(adopted.style, 'background-color'),
                       p.getPropertyValue.call(getComputedStyle(adopted), 'background-color'),
                       Object.getOwnPropertyDescriptor(p, 'length').get.call(adopted.style)]; })()
    JS
  end
end
