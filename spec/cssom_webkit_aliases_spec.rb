# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A `-webkit-…` name is one of two things, and browsers are precise about which. Measured in Chrome
# 151.0.7922.169: of the 151 webkit-cased IDL attributes on a declaration, 42 are properties in
# their own right (`-webkit-line-clamp`, `-webkit-text-fill-color`) and 109 are ALIASES — another
# name for an unprefixed property, resolved the moment a declaration is parsed. What we had instead
# was a rule: `-webkit-` plus any supported name, accepted as a property OF ITS OWN. So
# `-webkit-transform` in a real stylesheet stored a declaration nothing ever read rather than
# setting `transform`, some 600 invented spellings answered `CSS.supports` with true, and every one
# of them was reachable by name while absent from the interface.
RSpec.describe 'the -webkit- property surface' do
  def page(html)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s
  end

  # The resolution happens at PARSE time, so a rule is unprefixed from the moment it is read:
  # `rule.cssText` and `[...rule.style]` name the property, not the alias, exactly as in Chrome.
  it 'stores a stylesheet declaration under the property the alias names' do
    s = page('<style>#a { -webkit-transform: scale(2); -webkit-box-sizing: border-box }</style><div id="a"></div>')
    normalized = ['#a { transform: scale(2); box-sizing: border-box; }', ['transform', 'box-sizing'], 'scale(2)', 'scale(2)']
    expect(s.evaluate_script(<<~JS)).to eq(normalized)
      (() => { const rule = document.styleSheets[0].cssRules[0];
               return [rule.cssText, [...rule.style],
                       rule.style.getPropertyValue('-webkit-transform'),
                       rule.style.getPropertyValue('transform')]; })()
    JS
  end

  # …and it applies. This is the behaviour the old model quietly lost: real stylesheets ship
  # prefixed declarations, and ours became a declaration no reader knew the name of.
  it 'cascades an aliased declaration onto the property itself' do
    s = page('<style>#a { -webkit-transform: scale(2) }</style><div id="a"></div>')
    expect(s.evaluate_script(<<~JS)).to eq(['matrix(2, 0, 0, 2, 0, 0)', 'matrix(2, 0, 0, 2, 0, 0)'])
      (() => { const cs = getComputedStyle(document.getElementById('a'));
               return [cs.transform, cs.getPropertyValue('-webkit-transform')]; })()
    JS
  end

  # Every writing surface resolves through the same funnel: the CSSOM methods, a named-property
  # write, and `cssText`.
  it 'resolves the alias however the declaration is written' do
    s = page('<div id="a"></div>')
    written = ['transform: scale(2);', 'box-sizing: border-box;', 'flex-direction: column;', '']
    expect(s.evaluate_script(<<~JS)).to eq(written)
      (() => { const made = (write) => { const d = document.createElement('div'); write(d.style);
                                         return d.getAttribute('style') || ''; };
               return [made(st => st.setProperty('-webkit-transform', 'scale(2)')),
                       made(st => { st.webkitBoxSizing = 'border-box'; }),
                       made(st => { st.cssText = '-webkit-flex-direction: column'; }),
                       made(st => { st.setProperty('-webkit-transform', 'scale(2)');
                                    st.removeProperty('-webkit-transform'); })]; })()
    JS
  end

  # A third of the aliases RENAME rather than just drop the prefix — the flow-relative family and
  # the logical sizes — which is why this is a measured table and not a rule.
  it 'follows an alias that renames the property' do
    s = page('<div id="a"></div>')
    renamed = [['margin-inline-start'], '3px', 'border-block-end-width: 2px;', 'inline-size: 4px;']
    expect(s.evaluate_script(<<~JS)).to eq(renamed)
      (() => { const made = (write) => { const d = document.createElement('div'); write(d.style); return d; };
               const a = made(st => st.setProperty('-webkit-margin-start', '3px'));
               return [[...a.style], a.style.marginInlineStart,
                       made(st => st.setProperty('-webkit-border-after-width', '2px')).getAttribute('style'),
                       made(st => st.setProperty('-webkit-logical-width', '4px')).getAttribute('style')]; })()
    JS
  end

  # An aliased SHORTHAND expands like the shorthand it names.
  it 'expands an aliased shorthand through its own longhands' do
    s = page('<style>#a { -webkit-animation: 1s linear foo }</style><div id="a"></div>')
    expect(s.evaluate_script(<<~JS)).to eq(['1s', 'foo', 'linear'])
      (() => { const cs = getComputedStyle(document.getElementById('a'));
               return [cs.animationDuration, cs.animationName, cs.animationTimingFunction]; })()
    JS
  end

  # The 42 real ones keep their own name and their own storage — an alias is not a prefix rule.
  it 'leaves a genuine -webkit- property prefixed' do
    s = page('<div id="a"></div>')
    expect(s.evaluate_script(<<~JS)).to eq([['-webkit-line-clamp'], '2', true])
      (() => { const d = document.createElement('div');
               d.style.setProperty('-webkit-line-clamp', '2');
               return [[...d.style], d.style.getPropertyValue('-webkit-line-clamp'),
                       CSS.supports('-webkit-line-clamp', '2')]; })()
    JS
  end

  # And a `-webkit-` name that is NEITHER is not a property at all. The old rule invented one for
  # every supported name; Chrome answers false for all of them (measured).
  it 'refuses a -webkit- spelling no browser implements' do
    s = page('<div id="a"></div>')
    expect(s.evaluate_script(<<~JS)).to eq([false, '', false])
      (() => { const d = document.createElement('div');
               d.style.setProperty('-webkit-grid-template-areas', 'none');
               return [CSS.supports('-webkit-grid-template-areas', 'none'),
                       d.getAttribute('style') || '',
                       'webkitGridTemplateAreas' in d.style]; })()
    JS
  end

  # `@supports` asked the same question and answered it differently: it stripped any vendor prefix
  # and then accepted anything property-SHAPED, so every prefixed spelling was "supported". The bias
  # exists for standard properties mdn's table lags behind — it was never meant to cover a prefix
  # whose surface we now measure, and stripping applied iOS-only blocks while dropping the `not (…)`
  # fallbacks a real browser keeps. All six of these match Chrome 151.0.7922.169 exactly.
  it 'answers @supports about a prefixed name from the same table' do
    s = page(<<~HTML)
      <style>
        #a { color: black }
        @supports (-webkit-transform: scale(2)) { #a { border-left-color: green } }
        @supports (-webkit-grid-template-areas: none) { #a { border-top-color: red } }
        @supports (-webkit-touch-callout: none) { #a { color: red } }
        @supports (-moz-appearance: none) { #a { background-color: red } }
        @supports (--x: 1) { #a { border-right-color: green } }
        @supports not (-webkit-backdrop-filter: blur(1px)) { #a { outline-color: green } }
      </style><div id="a"></div>
    HTML
    applied = ['rgb(0, 128, 0)', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgba(0, 0, 0, 0)',
               'rgb(0, 128, 0)', 'rgb(0, 128, 0)']
    expect(s.evaluate_script(<<~JS)).to eq(applied)
      (() => { const cs = getComputedStyle(document.getElementById('a'));
               return [cs.borderLeftColor, cs.borderTopColor, cs.color, cs.backgroundColor,
                       cs.borderRightColor, cs.outlineColor]; })()
    JS
  end

  # `CSS.supports` has to agree with the at-rule about the same text, so the one-argument form runs
  # that evaluator — and CSSOM's algorithm has a step easy to miss: parse as a condition, and
  # FAILING that, re-parse wrapped in parens as a bare declaration. `CSS.supports('display: grid')`
  # is the common spelling and is not a condition. The empty string is false even though the at-rule
  # treats an unparseable condition as supported: that bias keeps a real browser's block from being
  # dropped, and an API answering a question has no such excuse. Measured identical in Chrome.
  it 'answers the one-argument CSS.supports the way the at-rule would' do
    s = page('<div id="a"></div>')
    answers = [true, true, true, true, false, true, false]
    expect(s.evaluate_script(<<~JS)).to eq(answers)
      (() => ['display: grid', '(display: grid)', 'font-variant-caps: initial', 'position: sticky',
              '(-webkit-grid-template-areas: none)', '(--x: 1)', ''].map(c => CSS.supports(c)))()
    JS
  end

  # The riskiest thing in a real stylesheet: which one wins when both spellings are written. They
  # are ONE property, so it is document order — measured identical to Chrome.
  it 'lets the later spelling win, because they are one property' do
    s = page('<style>#a { transform: scale(3); -webkit-transform: scale(2) } ' \
             '#b { -webkit-transform: scale(2); transform: scale(3) }</style>' \
             '<div id="a"></div><div id="b"></div>')
    expect(s.evaluate_script(<<~JS)).to eq(['matrix(2, 0, 0, 2, 0, 0)', 'matrix(3, 0, 0, 3, 0, 0)'])
      (() => ['a', 'b'].map(id => getComputedStyle(document.getElementById(id)).transform))()
    JS
  end

  # …and it reaches LAYOUT, which is the whole point of resolving rather than storing a second name:
  # the border-box width stays 100, and the inline-start margin moves the box (46 = the body's own
  # 8px plus 38). Both measured identical to Chrome.
  it 'feeds layout through the property the alias names' do
    s = page('<style>#a { -webkit-box-sizing: border-box; width: 100px; padding: 10px; border: 5px solid } ' \
             '#b { -webkit-margin-start: 38px }</style><div id="a"></div><div id="b"></div>')
    expect(s.evaluate_script(<<~JS)).to eq([100, 46])
      (() => [document.getElementById('a').getBoundingClientRect().width,
              document.getElementById('b').getBoundingClientRect().x])()
    JS
  end

  # `!important` and the priority read follow the alias too — one declaration, either spelling.
  it 'carries a priority through either spelling' do
    s = page('<style>#a { -webkit-transform: scale(2) !important }</style><div id="a"></div>')
    expect(s.evaluate_script(<<~JS)).to eq(['important', 'important', '#a { transform: scale(2) !important; }'])
      (() => { const st = document.styleSheets[0].cssRules[0].style;
               return [st.getPropertyPriority('-webkit-transform'), st.getPropertyPriority('transform'),
                       document.styleSheets[0].cssRules[0].cssText]; })()
    JS
  end

  # Every alias the table keeps must name a property we really have — a typo in a target would
  # otherwise vanish silently, leaving a spelling that answers `in` and then stores nothing. Walking
  # the dashed webkit attributes off the prototype is the page-visible way to check the whole table.
  it 'stores something for every -webkit- spelling it advertises' do
    s = page('<div id="a"></div>')
    expect(s.evaluate_script(<<~JS)).to eq([])
      (() => Reflect.ownKeys(CSSStyleDeclaration.prototype)
               .filter(k => typeof k === 'string' && k.startsWith('-webkit-'))
               .filter(name => { const d = document.createElement('div');
                                 d.style.setProperty(name, 'inherit');
                                 return !d.getAttribute('style'); }))()
    JS
  end

  # The capitalised spelling CSSOM mints for a prefixed property (`WebkitTransform`) is ours by
  # SPEC, not by measurement: Chrome exposes only the lowercase-first one.
  it 'exposes the capitalised spelling the spec mints' do
    s = page('<div id="a"></div>')
    expect(s.evaluate_script(<<~JS)).to eq(['transform: scale(2);', 'scale(2)'])
      (() => { const d = document.createElement('div');
               d.style.WebkitTransform = 'scale(2)';
               return [d.getAttribute('style'), d.style.webkitTransform]; })()
    JS
  end

  # An alias is only a name for a property we HAVE: `-webkit-app-region` points at `app-region`,
  # which Chrome implements and mdn's table does not list. Advertising the alias would promise a
  # declaration nothing could store, so it is filtered out where the table is built — and would
  # start working on its own the day the target arrives.
  it 'drops an alias whose target we do not model' do
    s = page('<div id="a"></div>')
    expect(s.evaluate_script(<<~JS)).to eq([false, ''])
      (() => { const d = document.createElement('div');
               d.style.setProperty('-webkit-app-region', 'drag');
               return [CSS.supports('-webkit-app-region', 'drag'), d.getAttribute('style') || '']; })()
    JS
  end

  # Presence and REFLECTION have to agree, which is what closes the gap the prototype work left
  # open: an alias is `in` a declaration and carries an IDL attribute, and both answer for the
  # property it names. (That the attributes live on the PROTOTYPE is this driver's spec-side choice
  # — Chrome makes them own properties of each instance, so `Reflect.ownKeys` of its prototype has
  # none of them. See cssom_declaration_members_spec.)
  it 'gives every spelling an IDL attribute that reads the property' do
    s = page('<style>#a { transform: scale(3) }</style><div id="a"></div>')
    expect(s.evaluate_script(<<~JS)).to eq([true, true, true, 'matrix(3, 0, 0, 3, 0, 0)'])
      (() => { const p = CSSStyleDeclaration.prototype, cs = getComputedStyle(document.getElementById('a'));
               return ['webkitTransform' in cs,
                       Reflect.ownKeys(p).includes('webkitTransform'),
                       Reflect.ownKeys(p).includes('-webkit-transform'),
                       cs.webkitTransform]; })()
    JS
  end
end
