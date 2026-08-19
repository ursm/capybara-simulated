# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# CSSOM gives a CSSStyleDeclaration an IDL attribute per supported CSS property, in BOTH spellings,
# so every property name is `in` it whether or not anything set it. This is what feature detection
# is written against (`'gap' in el.style`), and it is the first thing every WPT `*-computed` test
# asserts (`assert_true(property in getComputedStyle(target))`) — ours answered false for anything
# unset, so those tests failed before reading a single value.
#
# Measured in Chrome 151.0.7922.108: `'flex-wrap' in cs` and `'flexWrap' in cs` are true on a bare
# element, `'not-a-prop' in cs` and `'--x' in cs` are false. The examples below pin what we
# match; the note after them covers the two neighbouring surfaces we do not.
RSpec.describe 'CSS property names on a CSSStyleDeclaration' do
  def style_probe
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<body><div id="a"></div></body>']] })
    s.visit '/'
    s
  end

  it 'reports every supported property, in both spellings, set or not' do
    s = style_probe
    expect(s.evaluate_script(<<~JS)).to eq([true, true, true, true])
      (() => { const cs = getComputedStyle(document.getElementById('a'));
               return ['flex-wrap' in cs, 'flexWrap' in cs, 'font-size' in cs, 'align-items' in cs]; })()
    JS
    expect(s.evaluate_script(<<~JS)).to eq([true, true])
      (() => { const st = document.getElementById('a').style;
               return ['flex-wrap' in st, 'flexWrap' in st]; })()
    JS
  end

  it 'does not invent names that are not properties' do
    s = style_probe
    expect(s.evaluate_script(<<~JS)).to eq([false, false, false])
      (() => { const cs = getComputedStyle(document.getElementById('a'));
               return ['not-a-prop' in cs, '--x' in cs, 'nope' in document.getElementById('a').style]; })()
    JS
  end

  it 'answers the same for a detached element and an invalid pseudo-element' do
    s = style_probe
    # Those two return their own empty declaration (length 0, every value ''), and Chrome still
    # reports every property name on them — so `in` must not depend on which of the three
    # declarations you happen to be holding.
    expect(s.evaluate_script(<<~JS)).to eq([true, true, true])
      (() => { const el = document.getElementById('a'), det = document.createElement('div');
               return ['width' in getComputedStyle(det),
                       'width' in getComputedStyle(el, '::bogus'),
                       'width' in getComputedStyle(el, '::before')]; })()
    JS
  end

  it 'still answers for the members that are not properties at all' do
    s = style_probe
    # The prototype's own members answer `in` too (Chrome), which the presence check must not
    # shadow — it is an addition to what was there, not a replacement.
    expect(s.evaluate_script(<<~JS)).to eq([true, true, true])
      (() => { const st = document.getElementById('a').style;
               return ['toString' in st, 'constructor' in st, 'setProperty' in st]; })()
    JS
  end

  it 'leaves a custom property out even once it is set' do
    s = style_probe
    # `--x` gets no IDL attribute, so it is never `in` the declaration — but it is still a
    # declaration: it counts in `length`, `item()` names it, and `getPropertyValue` reads it.
    # Answering `in` from the STORED declarations, as we used to, got this backwards.
    expect(s.evaluate_script(<<~JS)).to eq([false, false, 1, '--x', '1'])
      (() => { const st = document.getElementById('a').style;
               st.setProperty('--x', '1');
               const cs = getComputedStyle(document.getElementById('a'));
               return ['--x' in st, '--x' in cs, st.length, st.item(0), st.getPropertyValue('--x')]; })()
    JS
  end

  it 'reports its indexed run from its OWN declarations' do
    s = style_probe
    # The indexed properties are the ones `length` / `item` / iteration walk — and those differ per
    # declaration: an inline one has what was set, a resolved-value one has every longhand. Letting
    # the computed declaration answer from the inline one behind it made `0 in getComputedStyle(el)`
    # depend on whether the element happened to carry a style attribute.
    expect(s.evaluate_script(<<~JS)).to eq([true, false, true, true, false])
      (() => { const el = document.getElementById('a'); el.style.color = 'red';
               const cs = getComputedStyle(el);
               return [0 in el.style, 1 in el.style, 0 in cs, 5 in cs, 9999 in cs]; })()
    JS
  end

  it 'gives a detached element a real, if empty, declaration' do
    s = style_probe
    # It answers '' for every property, but it is still a CSSStyleDeclaration: the interface's own
    # members are there and `instanceof` holds, both measured in Chrome.
    expect(s.evaluate_script(<<~JS)).to eq([true, true, true, true, 'function', ''])
      (() => { const dcs = getComputedStyle(document.createElement('div'));
               return ['length' in dcs, 'item' in dcs, Symbol.iterator in dcs,
                       dcs instanceof CSSStyleDeclaration, typeof dcs.toString, dcs.width]; })()
    JS
  end

  it 'names the rule a declaration belongs to, and null when there is none' do
    s = style_probe
    # `parentRule` is an interface member, so it is `in` every declaration; it is the owning rule
    # for `rule.style` and null for an inline or resolved-value one. It used to be absent from the
    # member list entirely, which made it read '' — a string — instead of null.
    expect(s.evaluate_script(<<~JS)).to eq([true, nil, nil, true])
      (() => { const el = document.getElementById('a');
               const sheet = document.head.appendChild(document.createElement('style'));
               sheet.sheet.insertRule('.r { color: blue }');
               const rule = sheet.sheet.cssRules[0];
               return ['parentRule' in el.style, el.style.parentRule,
                       getComputedStyle(el).parentRule, rule.style.parentRule === rule]; })()
    JS
  end

  it 'refuses to be sealed, the way the platform does' do
    s = style_probe
    # A CSSStyleDeclaration has an indexed property getter, so WebIDL makes it a legacy platform
    # object whose [[PreventExtensions]] returns false: in Chrome `Object.freeze(el.style)` throws
    # and the declaration stays extensible. That refusal is what keeps the presence answers legal —
    # a sealed target could not carry a property the proxy reports, so every later read would throw.
    expect(s.evaluate_script(<<~JS)).to eq(['TypeError', true, true, 'block'])
      (() => { const el = document.getElementById('a'); let threw = 'no';
               try { Object.freeze(el.style); } catch (e) { threw = e.constructor.name; }
               return [threw, Object.isExtensible(el.style), 'flex-wrap' in el.style,
                       getComputedStyle(el).display]; })()
    JS
  end

  # Two neighbouring surfaces this does NOT give us, both measured rather than assumed:
  #
  # - OWN-ness is a Chrome/Gecko split and we take the SPEC side. CSSOM defines these as IDL
  #   attributes on CSSStyleDeclaration.prototype, so they are present but not own — which is
  #   exactly what `css/cssom/cssstyledeclaration-properties.html` asserts
  #   (`assert_false(declaration.hasOwnProperty("color"))`). Chrome defines them as own, enumerable,
  #   configurable data properties and FAILS that subtest; we pass it, and adding a
  #   `getOwnPropertyDescriptor` trap to "match Chrome" would trade the conformance away. It would
  #   also cost: the computed-style proxy's TARGET is the inline-style proxy, so V8 consults the
  #   target's [[GetOwnProperty]] on every property READ to check its invariants, and such a trap
  #   then ran a declaration lookup per read — 17-56% on `getComputedStyle(el).display` / `.color` /
  #   `.width`, which app JS reads constantly.
  # - ENUMERATION is still missing, and that one IS a gap. Per spec the supported property INDICES
  #   are own enumerable properties, so `Object.keys(el.style)` should be `['0', '1']` for two
  #   declarations; ours is empty, because nothing here traps `ownKeys`. Discourse's
  #   `body-scroll-lock` snapshots a style object with `Object.assign({}, html.style)` and restores
  #   from it, which for us copies nothing back.

  it 'still reads the value through the name it reports' do
    s = style_probe
    expect(s.evaluate_script(<<~JS)).to eq(['nowrap', 'wrap', 'wrap'])
      (() => { const el = document.getElementById('a');
               const before = getComputedStyle(el)['flex-wrap'];
               el.style.flexWrap = 'wrap';
               return [before, getComputedStyle(el)['flex-wrap'], getComputedStyle(el).flexWrap]; })()
    JS
  end
end
