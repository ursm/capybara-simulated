require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/js_engine'

# The cascade matches selectors LIVE on every read — that is how a DYNAMIC pseudo-class takes effect
# at all. Anything that CACHES a cascade result therefore has to be invalidated by every input those
# selectors read. Most already move `settleGen` (an attribute, the tree, the location) or
# `cascadeVersion` (a stylesheet); the rest move `styleStateGen`.
#
# This file exists because ENUMERATING those inputs by hand failed three times. Each round the
# enumeration got better and still missed, because the axis that matters is not WHICH pseudo-classes
# are dynamic (the table below, derived from `selectors.js`) but WHICH CODE PATHS write the state
# behind them — `_value` has 19 writers and `_selectedness` 18. A table of IDL-setter mutations is
# itself just a second hand-enumeration: it passed green while `:checked` had stopped updating
# after a CLICK, the driver's most common interaction.
#
# So the rows come in two flavours: the property setter AND, where one exists, the interaction path
# a user actually takes. Every case READS BEFORE MUTATING, because a cache that is only ever cold
# cannot go stale. When a pseudo-class is added, add both.
RSpec.describe 'cascade invalidation' do
  # [name, body, css, mutation, colour after the mutation]. The rule paints green when the
  # pseudo-class matches, so a passing case is one where the colour CHANGES.
  #
  # A METHOD, not a constant: a constant assigned inside a `describe` block lands at TOP level, and
  # `cascade_conformance_spec.rb` has its own `CASES` — which this clobbered, failing 34 of its
  # examples in the full run while passing alone.
  def self.cases
    [
      ['hover',             '<div id="t">x</div>',
       '#t:hover { color: rgb(0, 128, 0) }',
       "document._hoverElement = document.getElementById('t');",              'rgb(0, 128, 0)'],
      ['focus',             '<input id="t">',
       '#t:focus { color: rgb(0, 128, 0) }',
       "document.getElementById('t').focus();",                               'rgb(0, 128, 0)'],
      ['focus-within',      '<div id="t"><input id="i"></div>',
       '#t:focus-within { color: rgb(0, 128, 0) }',
       "document.getElementById('i').focus();",                               'rgb(0, 128, 0)'],
      ['indeterminate',     '<input type="checkbox" id="t">',
       '#t:indeterminate { color: rgb(0, 128, 0) }',
       "document.getElementById('t').indeterminate = true;",                  'rgb(0, 128, 0)'],
      ['popover-open',      '<div id="t" popover>x</div>',
       '#t:popover-open { color: rgb(0, 128, 0) }',
       "document.getElementById('t').showPopover();",                         'rgb(0, 128, 0)'],
      ['placeholder-shown', '<input id="t" placeholder="p">',
       '#t { color: rgb(0, 0, 0) } #t:placeholder-shown { color: rgb(128, 0, 0) }',
       "document.getElementById('t').value = 'abc';",                         'rgb(0, 0, 0)'],
      ['valid',             '<input id="t" required>',
       '#t:valid { color: rgb(0, 128, 0) }',
       "document.getElementById('t').value = 'abc';",                         'rgb(0, 128, 0)'],
      ['checked',           '<input type="checkbox" id="t">',
       '#t:checked { color: rgb(0, 128, 0) }',
       "document.getElementById('t').checked = true;",                        'rgb(0, 128, 0)'],
      ['modal',             '<dialog id="t">x</dialog>',
       '#t:modal { color: rgb(0, 128, 0) }',
       "document.getElementById('t').showModal();",                           'rgb(0, 128, 0)'],
      ['open',              '<details id="t"><summary>s</summary></details>',
       '#t:open { color: rgb(0, 128, 0) }',
       "document.getElementById('t').open = true;",                           'rgb(0, 128, 0)'],
      ['disabled',          '<input id="t">',
       '#t:disabled { color: rgb(0, 128, 0) }',
       "document.getElementById('t').disabled = true;",                       'rgb(0, 128, 0)'],
      ['defined',           '<z-el id="t"></z-el>',
       '#t:defined { color: rgb(0, 128, 0) }',
       "customElements.define('z-el', class extends HTMLElement {});",        'rgb(0, 128, 0)'],
      ['state',             '<w-el id="t"></w-el>',
       '#t:state(on) { color: rgb(0, 128, 0) }',
       "customElements.define('w-el', class extends HTMLElement { constructor() { super(); " \
       "this._i = this.attachInternals(); } }); document.getElementById('t')._i.states.add('on');",
       'rgb(0, 128, 0)'],
      ['target',            '<div id="t">x</div>',
       '#t:target { color: rgb(0, 128, 0) }',
       "location.hash = '#t';",                                               'rgb(0, 128, 0)'],
      ['filtered',          '<input id="i" list="dl"><datalist id="dl"><option id="t">alpha</option>' \
                            '<option>beta</option></datalist>',
       '#t:filtered { color: rgb(0, 128, 0) }',
       "document.getElementById('i').value = 'be';",                          'rgb(0, 128, 0)']
    ]
  end

  cases.each do |name, body, css, mutate, expected|
    it "updates style when :#{name} changes" do
      html = "<!DOCTYPE html><html><head><style>#{css}</style></head><body>#{body}</body></html>"
      app = lambda {|_env| [200, {'content-type' => 'text/html'}, [html]] }
      s = simulated_session(app)
      s.visit '/'
      got = s.evaluate_script(<<~JS)
        (() => {
          const read = () => getComputedStyle(document.getElementById('t')).color;
          const before = read();                 // populates any cache BEFORE the mutation
          #{mutate}
          return [before, read()];
        })()
      JS
      expect(got[1]).to eq(expected), "#{name}: #{got[0].inspect} -> #{got[1].inspect}"
      expect(got[0]).not_to eq(got[1]), "#{name}: the mutation changed nothing, so the case proves nothing"
    end
  end

  # The INTERACTION paths. These are the ones a cache keyed on IDL setters gets wrong, and the ones
  # a table of setter mutations cannot see.
  it 'updates :checked style across repeated clicks' do
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><head><style>' \
        '#t:checked { color: rgb(0, 128, 0) }</style></head>' \
        '<body><input type="checkbox" id="t"></body></html>']]
    }
    s = simulated_session(app)
    s.visit '/'
    read = "getComputedStyle(document.getElementById('t')).color"
    seen = [s.evaluate_script(read)]
    3.times { s.find('#t').click; seen << s.evaluate_script(read) }
    # Alternating, not stuck: a click writes checkedness through `setCheckedness`, which no IDL
    # setter is involved in.
    expect(seen).to eq(['rgb(0, 0, 0)', 'rgb(0, 128, 0)', 'rgb(0, 0, 0)', 'rgb(0, 128, 0)'])
  end

  it 'updates :placeholder-shown style after setRangeText' do
    # One of ~19 writers of the live value that never touch the `value` IDL setter (the others
    # include execCommand('insertText'), stepUp/stepDown and the whole typing family).
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><head><style>' \
        '#t { color: rgb(0, 0, 0) } #t:placeholder-shown { color: rgb(128, 0, 0) }</style></head>' \
        '<body><input id="t" placeholder="p"></body></html>']]
    }
    s = simulated_session(app)
    s.visit '/'
    read = "getComputedStyle(document.getElementById('t')).color"
    before = s.evaluate_script(read)
    s.evaluate_script("document.getElementById('t').setRangeText('abc', 0, 0)")
    expect([before, s.evaluate_script(read)]).to eq(['rgb(128, 0, 0)', 'rgb(0, 0, 0)'])
  end

  it 'updates :invalid style after setCustomValidity' do
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><head><style>' \
        '#t:invalid { color: rgb(0, 128, 0) }</style></head>' \
        '<body><input id="t"></body></html>']]
    }
    s = simulated_session(app)
    s.visit '/'
    read = "getComputedStyle(document.getElementById('t')).color"
    before = s.evaluate_script(read)
    s.evaluate_script("document.getElementById('t').setCustomValidity('boom')")
    expect([before, s.evaluate_script(read)]).to eq(['rgb(0, 0, 0)', 'rgb(0, 128, 0)'])
  end

  it 'taints a rule whose dynamic pseudo-class FOLLOWS another one' do
    # `a:link:hover`, `li:first-child:hover`, `input:disabled:focus` are ordinary authoring idioms.
    # The pseudo-name scan used a `[^:]` prefix, which CONSUMES a character — so the pseudo directly
    # after a matched one was never scanned, the rule read as static, and its properties cached
    # through the state change. Every row of the table above is a SINGLE pseudo-class, which is why
    # they all stayed green.
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><head><style>' \
        '#t { color: rgb(0, 0, 0) } ' \
        '#t:first-child:placeholder-shown { color: rgb(128, 0, 0) }</style></head>' \
        '<body><input id="t" placeholder="p"></body></html>']]
    }
    s = simulated_session(app)
    s.visit '/'
    read = "getComputedStyle(document.getElementById('t')).color"
    before = s.evaluate_script(read)
    s.evaluate_script("document.getElementById('t').setRangeText('abc', 0, 0)")
    expect([before, s.evaluate_script(read)]).to eq(['rgb(128, 0, 0)', 'rgb(0, 0, 0)'])
  end

  it 'classifies selectors correctly for the taint gate' do
    # Asserted on the CLASSIFIER, not through a colour. The vendor-prefixed case cannot be toggled
    # from a spec, so the colour-based version of this passed against the very regression it was
    # written for — two identical reads of a rule that never matches say nothing about whether it
    # was treated as static.
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] }
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const d = globalThis.__csimSelectorIsDynamic;
        return {
          plain:        d('#t'),
          structural:   d('li:first-child'),
          attribute:    d('input:disabled'),
          hover:        d('#t:hover'),
          chained:      d('a:link:hover'),          // the pseudo AFTER a matched one
          chainedInner: d(':is(:first-child:hover)'),
          vendor:       d('input:-webkit-autofill'),
          dirAuto:      d('#t:dir(rtl)'),           // reads the control's VALUE for dir="auto"
          pseudoEl:     d('p::before'),             // a pseudo-ELEMENT is not a state
          legacyPseudoEl: d('.clearfix:before'),   // ...in its legacy single-colon spelling too
          escapedColon: d('.hover' + String.fromCharCode(92) + ':bg-red-500')  // Tailwind variant: an identifier
        };
      })()
    JS
    expect(got).to eq(
      'plain'        => false,
      'structural'   => false,
      'attribute'    => false,
      'hover'        => true,
      'chained'      => true,
      'chainedInner' => true,
      'vendor'       => true,
      'dirAuto'      => true,
      'pseudoEl'       => false,
      'legacyPseudoEl' => false,
      'escapedColon' => false
    )
  end

  it 'does not cache a flow-side mapping that a dynamic selector decided' do
    # `flowSides` (the writing-mode / direction resolution behind every `*-inline-*` property)
    # carries its own generation-keyed memo, and it predates the taint counter — so a `direction`
    # set by a dynamic selector froze the mapping. The giveaway was that `direction` itself, which
    # is NOT cached there, correctly reported the new value while `margin-inline-start` stayed on
    # the mirrored edge.
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><head><style>' \
        '#t { margin-inline-start: 7px } #t:placeholder-shown { direction: rtl }</style></head>' \
        '<body><input id="t" placeholder="p"></body></html>']]
    }
    s = simulated_session(app)
    s.visit '/'
    read = "(() => { const c = getComputedStyle(document.getElementById('t')); " \
           "return [c.direction, c.marginLeft, c.marginRight]; })()"
    before = s.evaluate_script(read)
    s.evaluate_script("document.getElementById('t').setRangeText('abc', 0, 0)")
    expect([before, s.evaluate_script(read)])
      .to eq([['rtl', '0px', '7px'], ['ltr', '7px', '0px']])
  end

  it 'never caches an element another realm owns' do
    # Per-frame realms are a V8 (rusty_racer) feature; QuickJS keeps a same-realm fallback, so there
    # is no second realm for the cache to be confused between.
    skip 'needs the per-frame realms only V8 provides' unless CsimEngine.v8?
    # A cross-realm read resolves against the READING realm's rules and its own generation counter,
    # and both realms' counters start at 0 — so a cached answer is handed back as current forever,
    # since nothing in the reading realm evicts it. `_ownerDoc` cannot answer the ownership
    # question: it is null on the `html`/`head`/`body` skeleton of EVERY document, a frame's
    # included, so the property was ambiguous in both directions before this asked the tree instead.
    app = lambda {|env|
      body = if env['PATH_INFO'] == '/f'
               '<!DOCTYPE html><html><body style="color: rgb(255, 0, 0)">f</body></html>'
             else
               '<!DOCTYPE html><html><body><iframe id="fr" src="/f"></iframe></body></html>'
             end
      [200, {'content-type' => 'text/html'}, [body]]
    }
    s = simulated_session(app)
    s.visit '/'
    read = "getComputedStyle(document.getElementById('fr').contentDocument.body).color"
    before = s.evaluate_script(read)                       # populates any cache
    s.within_frame('fr') { s.execute_script("document.body.setAttribute('style', 'color: rgb(0, 128, 0)')") }
    expect([before, s.evaluate_script(read)]).to eq(['rgb(255, 0, 0)', 'rgb(0, 128, 0)'])
  end

  it 'updates style when a shadow root ADOPTS a sheet in place' do
    # Not a pseudo-class: an in-place mutation of the ObservableArray. The `adoptedStyleSheets`
    # SETTER already invalidated; the array mutators moved no generation.
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body><div id="h"></div></body></html>']]
    }
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const sr = document.getElementById('h').attachShadow({mode: 'open'});
        sr.innerHTML = '<p id="p">x</p>';
        const p = sr.getElementById('p');
        const before = getComputedStyle(p).color;
        const sheet = new CSSStyleSheet();
        sheet.replaceSync('p { color: rgb(0, 128, 0) }');
        sr.adoptedStyleSheets.push(sheet);
        return [before, getComputedStyle(p).color];
      })()
    JS
    expect(got).to eq(['rgb(0, 0, 0)', 'rgb(0, 128, 0)'])
  end

  # KNOWN GAPS, all pre-existing — each measured identically on the commit before any of this work,
  # so none is an invalidation bug:
  #   * `:user-invalid` / `:user-valid` don't respond to `reportValidity()` (the user-interacted
  #     flag isn't modelled);
  #   * `:selected` can't be cleared on a single-selection `<select>` — deselecting its only
  #     selected option re-selects one, per the selectedness rules;
  #   * clicking an INDETERMINATE checkbox doesn't clear `indeterminate`, where Chrome does.
  # All three belong to the form-state model, not to invalidation.
end
