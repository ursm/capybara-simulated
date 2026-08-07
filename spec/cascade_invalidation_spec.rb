require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

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
