require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# A selector matches against the live state — that is how a DYNAMIC pseudo-class takes effect at all — so every
# input a selector reads has to reach the style engine as a restyle of what it changes. Most move `settleGen` (an
# attribute, the tree, the location) or `cascadeVersion` (a stylesheet); the rest move `styleStateGen`. What a flip
# does to the BOXES is marked by the style engine's restyle (layout.js `markRestyles`); the layout epoch moves with
# the rule set alone.
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
      ['checked option',    '<select id="s"><option value="a">a</option>' \
                            '<option value="b" id="t">b</option></select>',
       '#t:checked { color: rgb(0, 128, 0) }',
       "document.getElementById('s').value = 'b';",                           'rgb(0, 128, 0)'],
      ['custom validity',   '<input id="t">',
       '#t:invalid { color: rgb(0, 128, 0) }',
       "document.getElementById('t').setCustomValidity('bad');",              'rgb(0, 128, 0)']
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

  it 'restyles through a rule whose dynamic pseudo-class FOLLOWS another one' do
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

  it 'does not cache a flow-side mapping that a dynamic selector decided' do
    # `flowSides` (the writing-mode / direction resolution behind every `*-inline-*` property) once
    # carried a generation-keyed memo of its own, and a `direction` set by a dynamic selector froze the
    # mapping: `direction` itself correctly reported the new value while `margin-inline-start` stayed on
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

  # …and the same state change has to reach the BOXES, not just the CSSOM. Layout keys its memos on
  # the rule-set version, which no state change moves, so only a mark can take an element's box
  # from it: with nothing marking it, an element styled by a dynamic selector once kept the box it
  # was first laid out with — `getBoundingClientRect` served the placeholder-shown 300px after the
  # field was filled. The restyle marks it now. Chrome 151, same page: 308 then 108 — a text `<input>` is
  # `content-box`, so its UA border and padding sit outside the declared width.
  it 'relays out an element a dynamic selector restyles' do
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><head><style>' \
        '#t { width: 100px } #t:placeholder-shown { width: 300px }</style></head>' \
        '<body><input id="t" placeholder="p"></body></html>']]
    }
    s = simulated_session(app)
    s.visit '/'
    read = "document.getElementById('t').getBoundingClientRect().width"
    before = s.evaluate_script(read)
    s.evaluate_script("document.getElementById('t').setRangeText('abc', 0, 0)")
    expect([before, s.evaluate_script(read)]).to eq([308, 108])
  end

  # …and CLEARING the live value counts as changing it. `<form>.reset()` and a `type` change drop
  # the dirty value flag with `delete`, which no assignment helper can catch — so an emptied field
  # kept the box it had while it was full, on both the CSSOM and the geometry side.
  it 'relays out a control whose value a form reset cleared' do
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><head><style>' \
        '#t { width: 100px } #t:placeholder-shown { width: 300px }</style></head>' \
        '<body><form id="f"><input id="t" placeholder="p"></form></body></html>']]
    }
    s = simulated_session(app)
    s.visit '/'
    read = "document.getElementById('t').getBoundingClientRect().width"
    s.evaluate_script("document.getElementById('t').value = 'abc'")
    filled = s.evaluate_script(read)
    s.evaluate_script("document.getElementById('f').reset()")
    expect([filled, s.evaluate_script(read)]).to eq([108, 308])
  end

  # The other half of the same contract, and the one rule 3 cares about: a dynamic rule that only
  # PAINTS must not invalidate layout at all. When layout keyed on the style-state generation
  # unconditionally, one `setRangeText` on a page with a `:hover { background: … }` rule relaid out
  # the whole document — 1 ms became 2.9 s for 100 type-and-measure rounds on a 300-row page.
  it 'does not relay out for a dynamic rule that only paints' do
    rows = (1..200).map {|i| "<div class='r'>row #{i}</div>" }.join
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><head><style>' \
        '.r { padding: 2px } .r:hover { background: #eee }</style></head>' \
        "<body><input id='t'>#{rows}</body></html>"]]
    }
    s = simulated_session(app)
    s.visit '/'
    elapsed = s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('t'), e = document.querySelector('.r');
        e.getBoundingClientRect();                       // warm the pass
        const t0 = Date.now();
        for (let i = 0; i < 100; i++) { t.setRangeText('x', 0, 0); e.getBoundingClientRect(); }
        return Date.now() - t0;
      })()
    JS
    # A full relayout per keystroke is ~2 s on this page; a cached one is single-digit ms. The
    # bound is loose enough to survive a slow machine and still an order of magnitude under the
    # regression it exists to catch.
    expect(elapsed).to be < 300
  end

  it 'never caches an element another realm owns' do
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
    # Not a pseudo-class: an in-place mutation of the ObservableArray is a RULE-SET change, so it
    # moves the cascade version (the memos' key) like the `adoptedStyleSheets` SETTER does — the
    # array mutators once moved no generation at all.
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

  it 'updates style when a <style> lands in, or is edited inside, a shadow root after a read' do
    # A shadow-scoped stylesheet change is invisible to the document cascade's content key; the
    # per-root rule set and every memo key on the cascade VERSION, which the mutation moves directly.
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
        const style = document.createElement('style');
        style.textContent = 'p { color: rgb(0, 128, 0) }';
        sr.appendChild(style);
        const appended = getComputedStyle(p).color;
        style.textContent = 'p { color: rgb(0, 0, 255) }';
        const edited = getComputedStyle(p).color;
        sr.removeChild(style);
        return [before, appended, edited, getComputedStyle(p).color];
      })()
    JS
    expect(got).to eq(['rgb(0, 0, 0)', 'rgb(0, 128, 0)', 'rgb(0, 0, 255)', 'rgb(0, 0, 0)'])
  end

  it 'updates :disabled style when a form-associated custom element is DEFINED after a read' do
    # `:disabled` is a STATIC pseudo-class (attribute-driven, so its reads are cached) — but it
    # also reads form-associatedness off the custom-element registry: until the class is defined
    # the `disabled` attribute is inert on `<my-el>`, and the definition makes it match without
    # any attribute, tree or stylesheet change. The definition moves the cascade version.
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><html><head><style>
          #t:disabled { color: rgb(0, 128, 0) } my-el:disabled span { color: rgb(0, 128, 0) }
        </style></head><body><my-el id="t" disabled>x<span id="s">y</span></my-el></body></html>
      HTML
    }
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('t'), sp = document.getElementById('s');
        const before = [getComputedStyle(t).color, getComputedStyle(sp).color];
        customElements.define('my-el', class extends HTMLElement { static formAssociated = true; });
        return [before, [getComputedStyle(t).color, getComputedStyle(sp).color], t.matches(':disabled')];
      })()
    JS
    expect(got).to eq([['rgb(0, 0, 0)', 'rgb(0, 0, 0)'], ['rgb(0, 128, 0)', 'rgb(0, 128, 0)'], true])
  end

  # ── dynamic rules that move boxes ───────────────────────────────────────────────────────────
  # A dynamic rule that can move boxes must not make the layout epoch listen to focus / hover /
  # checked state — the whole document would relay out per state change, and widget CSS shipped
  # site-wide (EasyMDE, flatpickr) would tax the pages that never render the widget. What a flip
  # reaches is marked by the restyle instead. The specs further down pin both sides: the epoch must
  # NOT move, and the rule MUST take effect the moment it can match — including when the widget
  # arrives only after the first layout.

  # Methods, not constants, for the same reason as `cases` above: a constant assigned inside a
  # `describe` block lands at top level and collides across spec files. The default sheet is a
  # dropdown whose content a focus flip reveals, so a page without a `.dd` is one the rule cannot match.
  def dropdown_css
    '.dd-content { display: none } .dd:focus-within .dd-content { display: block }'
  end

  def styled_page(body, css: nil)
    lambda {|_env|
      [200, {'content-type' => 'text/html'},
       ["<!DOCTYPE html><html><head><style>#{css || dropdown_css}</style></head><body>#{body}</body></html>"]]
    }
  end

  # ── What a shadow tree's own sheets reach, and the gates that answer for the WHOLE DOCUMENT ───────
  #
  # Several document-wide O(1) gates — "does anything here declare this property / a `@keyframes` / a
  # transition?" — cannot see a shadow tree's sheets, which are in no document index, so they answer
  # YES for the entire page the moment one shadow host exists. That is correct and very expensive: a
  # 400-row table beside one `<my-widget>` relaid out 5.4x slower (51 ms → 280 ms, measured), with
  # every light-DOM element paying for a component stylesheet that cannot reach it — see
  # `shadow_host_gates_fail_open` for the decomposition.
  #
  # The gates ask the shadow sheets themselves now — each tree is folded in once, off the PARSED sheet
  # every component with the same stylesheet text shares. Every example here is a way that goes wrong:
  # a property, a `@keyframes` or a transition the union has to see; a sheet that arrives after the
  # gate has already answered once; and `::slotted`, which is why the union cannot wait to be asked.
  def shadow_page(shadow_css, shadow_body, doc_css: '', doc_body: '')
    lambda {|_env|
      [200, {'content-type' => 'text/html'},
       [<<~HTML]]
         <!DOCTYPE html><html><head><style>#{doc_css}</style></head><body>
           #{doc_body}<div id="host"></div>
           <script>
             document.getElementById('host').attachShadow({mode: 'open'}).innerHTML =
               #{("<style>#{shadow_css}</style>#{shadow_body}").dump};
           </script>
         </body></html>
       HTML
    }
  end

  it 'lets a property declared only inside a shadow tree through' do
    s = simulated_session(shadow_page('.t { color: rgb(0, 128, 0); letter-spacing: 3px }', '<p class="t" id="t">x</p>'))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('host').shadowRoot.getElementById('t');
        const cs = getComputedStyle(t);
        return [cs.color, cs.letterSpacing];
      })()
    JS
    expect(got).to eq(['rgb(0, 128, 0)', '3px'])
  end

  it 'finds a @keyframes declared only inside a shadow tree' do
    # …held at its FIRST frame, so the assertion needs no clock: the animation's own `from` is 25px
    # where the element would otherwise be at the initial 0.
    css = '@keyframes slide { from { margin-left: 25px } to { margin-left: 40px } } .t { animation: slide 10s linear both paused }'
    s = simulated_session(shadow_page(css, '<p class="t" id="t">x</p>'))
    s.visit '/'
    margin = s.evaluate_script("getComputedStyle(document.getElementById('host').shadowRoot.getElementById('t')).marginLeft")
    expect(margin).to eq('25px'), 'the shadow tree\'s own @keyframes was never found'
  end

  it 'runs a transition declared only inside a shadow tree' do
    css = '.t { color: rgb(255, 0, 0); transition: color 10s linear } .t.on { color: rgb(0, 0, 255) }'
    s = simulated_session(shadow_page(css, '<p class="t" id="t">x</p>'))
    s.visit '/'
    s.evaluate_script("getComputedStyle(document.getElementById('host').shadowRoot.getElementById('t')).color")
    # (…read in the task that starts it: the transition runs from then on, as in a browser)
    colour = s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('host').shadowRoot.getElementById('t');
        t.classList.add('on');
        return getComputedStyle(t).color;
      })()
    JS
    # …RED, not merely "not blue": a gate that ignored the shadow sheet outright would report the
    # initial black and pass a `not_to eq(blue)`, which is the shape of the mistake this guards.
    expect(colour).to eq('rgb(255, 0, 0)'), 'the transition jumped straight to its end, or the sheet was ignored'
  end

  it 'reaches LAYOUT with a @keyframes declared only inside a shadow tree' do
    # `getComputedStyle` and the geometry read the same animated value through DIFFERENT gates, and a
    # keyframes block's properties are in no document index at all. A gate narrowed on the RULES alone
    # leaves the layout side answering "nothing animates `transform` here", and the two halves of one
    # geometry disagree — computed style reports the interpolated matrix, gBCR the untransformed box.
    css = '@keyframes shove { from { transform: translateX(120px) } to { transform: translateX(120px) } } ' \
          '.t { animation: shove 10s linear both; width: 50px }'
    s = simulated_session(shadow_page(css, '<p class="t" id="t">x</p>'))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('host').shadowRoot.getElementById('t');
        return [getComputedStyle(t).transform, t.getBoundingClientRect().left];
      })()
    JS
    expect(got.first).to eq('matrix(1, 0, 0, 1, 120, 0)')
    expect(got.last).to eq(128), 'the geometry did not see the shadow tree\'s animation'
  end

  it 'invalidates a ::part rule written in a SHADOW sheet, one tree further in' do
    # `exportparts`: the OUTER shadow tree styles an INNER component's part. The rule is in a shadow
    # sheet, not the document's, so a scan that only looks at document rules misses it — and the outer
    # tree is exactly where a component library writes one.
    inner = '<div id="inner"></div>'
    s = simulated_session(lambda {|_env|
      [200, {'content-type' => 'text/html'},
       [<<~HTML]]
         <!DOCTYPE html><html><body><div id="host"></div>
         <script>
           const outer = document.getElementById('host').attachShadow({mode: 'open'});
           outer.innerHTML = #{("<style>#inner::part(label){color:rgb(255,0,0)} .on #inner::part(label){color:rgb(0,128,0)}</style><div id=\"wrap\">#{inner}</div>").dump};
           outer.getElementById('inner').attachShadow({mode: 'open'}).innerHTML = '<p part="label" id="t">x</p>';
         </script></body></html>
       HTML
    })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const outer = document.getElementById('host').shadowRoot;
        const t = outer.getElementById('inner').shadowRoot.getElementById('t');
        const before = getComputedStyle(t).color;
        outer.getElementById('wrap').classList.add('on');
        return [before, getComputedStyle(t).color];
      })()
    JS
    expect(got).to eq(['rgb(255, 0, 0)', 'rgb(0, 128, 0)'])
  end

  it 'sees a shadow sheet that arrives after the gate has already answered' do
    # The union is folded from a QUEUE — a tree is queued when it is attached and again whenever its
    # rules are rebuilt — so an answer given before a sheet existed must not be the answer kept. Three
    # ways a component's stylesheet lands late, each of which left the whole sheet unapplied at some
    # point in writing this: a `<style>` one level below the root (the component builds its markup in a
    # wrapper and attaches it whole), `adoptedStyleSheets` assigned afterwards, and a second `<style>`
    # appended to a tree that has already been read.
    s = simulated_session(lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body><div id="host"></div></body></html>']]
    })
    s.visit '/'
    s.evaluate_script('document.body.offsetHeight')   # …the first read, before any shadow tree exists
    got = s.evaluate_script(<<~JS)
      (() => {
        const sr = document.getElementById('host').attachShadow({ mode: 'open' });
        const wrap = document.createElement('div');
        wrap.innerHTML = '<style>.t { color: rgb(0, 128, 0); letter-spacing: 7px }</style><p class="t" id="t">x</p>';
        sr.appendChild(wrap);
        const nested = getComputedStyle(sr.getElementById('t'));
        const first = [nested.color, nested.letterSpacing];

        const sheet = new CSSStyleSheet();
        sheet.replaceSync('.t { word-spacing: 5px }');
        sr.adoptedStyleSheets = [sheet];
        const adopted = getComputedStyle(sr.getElementById('t')).wordSpacing;

        const late = document.createElement('style');
        late.textContent = '.t { text-indent: 9px }';
        sr.appendChild(late);
        return first.concat([adopted, getComputedStyle(sr.getElementById('t')).textIndent]);
      })()
    JS
    expect(got).to eq(['rgb(0, 128, 0)', '7px', '5px', '9px'])
  end

  it 'sees a ::slotted rule, which styles an element OUTSIDE the tree that declares it' do
    # The reason the union cannot wait to be asked. `::slotted()` is written in a shadow sheet and
    # styles a LIGHT-DOM child — exactly the element a document-wide gate is being asked about, and one
    # whose read never goes near the shadow tree. A union folded lazily answers "nothing declares
    # `word-spacing` here" for it, and the read that would have folded the tree never happens.
    s = simulated_session(lambda {|_env|
      [200, {'content-type' => 'text/html'},
       ['<!DOCTYPE html><html><body><div id="host"><span id="light">x</span></div></body></html>']]
    })
    s.visit '/'
    s.evaluate_script('document.body.offsetHeight')
    got = s.evaluate_script(<<~JS)
      (() => {
        const sr = document.getElementById('host').attachShadow({ mode: 'open' });
        sr.innerHTML = '<style>::slotted(span) { color: rgb(0, 128, 0); word-spacing: 3px }</style><slot></slot>';
        const cs = getComputedStyle(document.getElementById('light'));
        return [cs.color, cs.wordSpacing];
      })()
    JS
    expect(got).to eq(['rgb(0, 128, 0)', '3px'])
  end

  it 'relays out for a DYNAMIC rule that moves a box inside a shadow tree' do
    # A shadow rule's subjects live one tree in, where no document-side sweep ever reached; the restyle
    # that flips them is what has to relay them out.
    [
      ['#t { width: 40px } #t:hover { width: 300px }',
       "document._hoverElement = document.getElementById('host').shadowRoot.getElementById('t');", 300],
      ['#t { width: 40px } #t:focus { width: 300px }',
       "const el = document.getElementById('host').shadowRoot.getElementById('t'); el.setAttribute('tabindex', '0'); el.focus();", 300],
      # …and one that only PAINTS moves no box
      ['#t { width: 40px } #t:hover { background: red }',
       "document._hoverElement = document.getElementById('host').shadowRoot.getElementById('t');", 40]
    ].each do |css, mutation, after|
      s = simulated_session(shadow_page(css, '<div id="t">x</div>'))
      s.visit '/'
      got = s.evaluate_script(<<~JS)
        (() => {
          const t = document.getElementById('host').shadowRoot.getElementById('t');
          const before = t.getBoundingClientRect().width;
          #{mutation}
          return [before, t.getBoundingClientRect().width];
        })()
      JS
      expect(got).to eq([40, after]), css
    end
    # …and the paint-only case needs a barrier of its own: a width that did not move is what a
    # whole-page relayout produces TOO (it costs work, it does not change the answer). The layout
    # epoch moves with the rule set alone, never with a state flip, and it is the observable, so ask
    # it directly.
    s = simulated_session(shadow_page('#t { width: 40px } #t:hover { background: red }', '<div id="t">x</div>'))
    s.visit '/'
    epochs = s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('host').shadowRoot.getElementById('t');
        t.getBoundingClientRect();
        const before = globalThis.__csimLayoutEpoch();
        document._hoverElement = t;
        t.getBoundingClientRect();
        return [before, globalThis.__csimLayoutEpoch()];
      })()
    JS
    expect(epochs.first).to eq(epochs.last), 'a paint-only shadow rule moved the LAYOUT epoch'
  end

  it 'follows an element MOVED across the shadow boundary' do
    # Whether document rules reach an element is decided by its enclosing shadow root, which only a
    # child-list change moves; these are the two moves that prove it, and Chrome agrees with all four
    # figures.
    s = simulated_session(lambda {|_env|
      [200, {'content-type' => 'text/html'},
       [<<~HTML]]
         <!DOCTYPE html><html><head><style>.t { letter-spacing: 5px }</style></head><body>
           <div id="light"><span class="t" id="a">x</span></div><div id="host"></div>
           <script>
             document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
               '<style>.t { letter-spacing: 9px }</style><span class="t" id="b">y</span>';
           </script>
         </body></html>
       HTML
    })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const sr = document.getElementById('host').shadowRoot;
        const a = document.getElementById('a'), b = sr.getElementById('b');
        const out = [getComputedStyle(a).letterSpacing, getComputedStyle(b).letterSpacing];
        sr.appendChild(a);                                 // …a light element moved INTO the tree
        out.push(getComputedStyle(a).letterSpacing);
        document.getElementById('light').appendChild(b);    // …and one moved OUT of it
        out.push(getComputedStyle(b).letterSpacing);
        return out;
      })()
    JS
    expect(got).to eq(['5px', '9px', '9px', '5px'])
  end

  it 'sees a @keyframes name referenced only from inside a shadow tree' do
    # `referencedAnimationNames` is what keeps a `@keyframes` block the page merely SHIPS — Bootstrap's
    # `spin`, Tailwind's `ping` — from opening the transform gate for every element. A shadow host used
    # to make it give up on the page, so every name counted again: measured 1.12x on a 400-row table
    # beside a widget that animates nothing. The trees' own `animation` / `animation-name` declarations
    # are folded in instead — and if they were not, a name only THEY reference would be filtered out
    # and the two halves of one geometry would disagree: `getComputedStyle` reports the interpolated
    # matrix (the animation model reads the keyframes directly) while `getBoundingClientRect` reports
    # the untransformed box (layout asks the gate). That is what this pins.
    kf = 'body { margin: 0 } @keyframes shove { from { transform: translateX(120px) } to { transform: translateX(120px) } }'
    [
      ['.p { animation: shove 10s linear both; width: 50px }',                                    kf],
      ['.p { animation-name: shove; animation-duration: 10s; animation-fill-mode: both; width: 50px }', kf],
      # …and the same thing with the keyframes in the tree too, which has no document side at all
      ["#{kf} .p { animation: shove 10s linear both; width: 50px }",                               'body { margin: 0 }']
    ].each do |shadow_css, doc_css|
      s = simulated_session(shadow_page(shadow_css, '<div class="p" id="t">x</div>', doc_css: doc_css))
      s.visit '/'
      got = s.evaluate_script(<<~JS)
        (() => {
          const t = document.getElementById('host').shadowRoot.getElementById('t');
          return [getComputedStyle(t).transform, t.getBoundingClientRect().left];
        })()
      JS
      expect(got).to eq(['matrix(1, 0, 0, 1, 120, 0)', 120]), shadow_css
    end
    # …while one the page ships and NOTHING references still animates nothing
    s = simulated_session(shadow_page('.p { width: 50px }', '<div class="p" id="t">x</div>', doc_css: kf))
    s.visit '/'
    expect(s.evaluate_script("getComputedStyle(document.getElementById('host').shadowRoot.getElementById('t')).transform")).to eq('none')
  end

  # …and the two ways the name set can be WRONG rather than merely narrow. Both were live, both on a
  # page with no shadow DOM at all, and both show as the same split: the animation model reads the
  # keyframes directly and reports the interpolated matrix, while layout asks the gate and reports the
  # untransformed box. Chrome puts all of these at 120.
  it 'keeps the keyframes gate open for an animation started INLINE after a read' do
    # `referencedAnimationNames` answers `null` — "every name counts" — once the inline-animation latch
    # is set, and that answer was baked into the property index. A page READ before its first
    # `el.style.animation = …` kept the narrower index for the rest of its life, and "find, then act"
    # is the ordinary Capybara ordering.
    %w[cold warm].each do |order|
      s = simulated_session(animation_page('<div id="t" style="width:50px">x</div>'))
      s.visit '/'
      got = s.evaluate_script(<<~JS)
        (() => {
          const t = document.getElementById('t');
          #{"t.getBoundingClientRect();" if order == 'warm'}
          t.style.animation = 'shove 10s linear both';
          return [getComputedStyle(t).transform, t.getBoundingClientRect().left];
        })()
      JS
      expect(got).to eq(['matrix(1, 0, 0, 1, 120, 0)', 120]), order
    end
  end

  it 'gives up on the name set when a var() stands where the name goes' do
    # The tokeniser's own comment says over-approximating is safe — and it is, except here: `animation:
    # 10s var(--n)` yields the token `var(--n)`, so the real name never enters the set and the block it
    # names is filtered out WHILE IT IS RUNNING. That is the one direction a "may" gate must not take.
    [
      '.p { animation: 10s linear both var(--n); width: 50px }',
      '.p { animation-name: var(--n); animation-duration: 10s; animation-fill-mode: both; width: 50px }'
    ].each do |rule|
      s = simulated_session(animation_page('<div class="p" id="t">x</div>', ":root { --n: shove } #{rule}"))
      s.visit '/'
      got = s.evaluate_script("(() => { const t = document.getElementById('t'); return [getComputedStyle(t).transform, t.getBoundingClientRect().left] })()")
      expect(got).to eq(['matrix(1, 0, 0, 1, 120, 0)', 120]), rule
    end
  end

  # A page that SHIPS `@keyframes shove` — the Bootstrap / Tailwind shape the name filter exists for.
  def animation_page(body, extra_css = '')
    kf = '@keyframes shove { from { transform: translateX(120px) } to { transform: translateX(120px) } }'
    lambda {|_env|
      [200, {'content-type' => 'text/html'},
       ["<!DOCTYPE html><html><head><style>body { margin: 0 } #{kf} #{extra_css}</style></head>" \
        "<body>#{body}</body></html>"]]
    }
  end

  it 'empties a reused DECLARATIVE shadow root as the tree mutation it is' do
    # `attachShadow` on a host that already has a DECLARATIVE root reuses it, and HTML's reuse path
    # runs "replace all with null within shadow". Doing that silently left the host's old boxes laid
    # out (Chrome drops to 0, we kept 50), queued no MutationObserver record where Chrome queues a
    # childList one, and left every memo keyed on a child-list record describing a tree that no longer
    # exists — the enclosing-shadow-root stamp above among them. Chrome-verified: `[50, 0, 1]`.
    s = simulated_session(lambda {|_env|
      [200, {'content-type' => 'text/html'},
       ['<!DOCTYPE html><html><body><div id="h"><template shadowrootmode="open">' \
        '<div style="height:50px">y</div></template></div></body></html>']]
    })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const h = document.getElementById('h');
        const mo = new MutationObserver(() => {});
        mo.observe(h.shadowRoot, { childList: true, subtree: true });
        const before = h.getBoundingClientRect().height;
        h.attachShadow({ mode: 'open' });
        const records = mo.takeRecords();
        return [before, h.getBoundingClientRect().height,
                records.length === 1 && records[0].type === 'childList' ? records[0].removedNodes.length : -1];
      })()
    JS
    expect(got).to eq([50, 0, 1])
  end

  it 'relays out for a ::part rule that moves a box on a dynamic state flip' do
    # The mirror of the shadow-tree DYNAMIC rule case further up: a `::part()` rule lives in the
    # DOCUMENT sheet and styles a subject one tree in. The document-side list of dynamic subjects the
    # JS cascade once kept never carried it, and the part had to be scanned for separately; the
    # restyle reaches it like any other subject.
    [['#host::part(p):hover', 't'], ['#host:hover::part(p)', "document.getElementById('host')"]].each do |sel, hover|
      s = simulated_session(lambda {|_env|
        [200, {'content-type' => 'text/html'},
         [<<~HTML]]
           <!DOCTYPE html><html><head><style>#host::part(p) { width: 77px } #{sel} { width: 300px }</style></head>
           <body><div id="host"></div><script>
             document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<div part="p" id="t">x</div>';
           </script></body></html>
         HTML
      })
      s.visit '/'
      got = s.evaluate_script(<<~JS)
        (() => {
          const t = document.getElementById('host').shadowRoot.getElementById('t');
          const before = t.getBoundingClientRect().width;
          document._hoverElement = #{hover};
          return [before, t.getBoundingClientRect().width];
        })()
      JS
      expect(got).to eq([77, 300]), sel
    end
  end

  # `:defined` flips for each element as IT is upgraded, and a definition upgrades its elements one after another, each
  # connected callback running before the next upgrade. When the style state moved once per definition, before the
  # upgrades, the first callback that read layout consumed the flip, and every element upgraded after it kept its
  # undefined box. Each upgrade is its own flip, and each callback must see its own element defined.
  it 'lays out every element a definition upgrades as defined' do
    s = simulated_session(lambda {|_env|
      [200, {'content-type' => 'text/html'},
       ['<!DOCTYPE html><html><head><style>x-foo { display: block; width: 50px } x-foo:defined { width: 200px }</style>' \
        '</head><body><x-foo id="a"></x-foo><x-foo id="b"></x-foo></body></html>']]
    })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const own = [];
        document.body.offsetHeight;
        customElements.define('x-foo', class extends HTMLElement { connectedCallback() { own.push(this.getBoundingClientRect().width) } });
        return [own, ['a', 'b'].map((id) => document.getElementById(id).getBoundingClientRect().width)];
      })()
    JS
    expect(got).to eq([[200, 200], [200, 200]])
  end

  # …and a run of upgrades relays out the upgraded elements and what holds them, not the page. It once swept every
  # dynamic layout rule's subjects over the document — a state hint apiece ran past the hint list's cap of 32 — so
  # inserting 33 or more defined elements laid every `.row` a `:hover` rule names out again, on a page with no
  # `:defined` rule at all. A COUNT, not a wall.
  it 'relays out only the elements a run of upgrades inserts, not every hover-rule subject' do
    rows = (1..200).map { '<div class="row"><span>r</span><span class="actions">edit</span></div>' }.join
    s = simulated_session(lambda {|_env|
      [200, {'content-type' => 'text/html'},
       ['<!DOCTYPE html><html><head><style>.actions { display: none } .row:hover .actions { display: inline } ' \
        "x-item { display: block; height: 4px }</style></head><body><div id=\"c\"></div>#{rows}</body></html>"]]
    })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        customElements.define('x-item', class extends HTMLElement {});
        document.body.offsetHeight;
        const walked = () => __dom.layoutMeasureCounts()[4];   // …the records the Rust walk built, not spliced back
        const n = walked();
        document.getElementById('c').innerHTML = '<x-item></x-item>'.repeat(100);
        document.body.offsetHeight;
        return walked() - n;
      })()
    JS
    expect(got).to be < 200                                  # the hundred items and what holds them, not every row
  end

  # …and a tree's OWN `:host::part(p):hover`, which is matched by rewritten copies of the rule: the rule as written holds
  # `::part()`, which the ordinary shadow-rule walk cannot compile and flags `unmatchable` — so once that walk had run
  # (any other element of the tree read), the hover was memoised away, and the part kept 77.
  it "restyles a part on hover through its own tree's :host::part rule" do
    s = simulated_session(lambda {|_env|
      [200, {'content-type' => 'text/html'},
       [<<~HTML]]
         <!DOCTYPE html><html><body><div id="host"></div><script>
           document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
             '<style>:host::part(p) { width: 77px } :host::part(p):hover { width: 300px } #o { width: 10px }</style>' +
             '<div part="p" id="t">x</div><div id="o">o</div>';
         </script></body></html>
       HTML
    })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const root = document.getElementById('host').shadowRoot, t = root.getElementById('t');
        const out = [getComputedStyle(root.getElementById('o')).width, getComputedStyle(t).width];
        document._hoverElement = t;
        return [...out, getComputedStyle(t).width, t.getBoundingClientRect().width];
      })()
    JS
    expect(got).to eq(['10px', '77px', '300px', 300])
  end

  # …and a value already read: a mutation a shadow selector reads has to restyle the element the
  # selector styles. These two pin the shapes a narrowing once got wrong: a shadow rule's own input,
  # and a `::part()` rule in the OUTER sheet whose subject is inside the tree.
  it 'invalidates a memoised value when a shadow selector\'s own input changes' do
    s = simulated_session(shadow_page('.t { color: rgb(255, 0, 0) } .t.on { color: rgb(0, 128, 0) }', '<p class="t" id="t">x</p>'))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('host').shadowRoot.getElementById('t');
        const before = getComputedStyle(t).color;
        t.classList.add('on');
        return [before, getComputedStyle(t).color];
      })()
    JS
    expect(got).to eq(['rgb(255, 0, 0)', 'rgb(0, 128, 0)'])
  end

  it 'invalidates a ::part rule whose match depends on the outer tree' do
    # A `::part()` rule lives in the OUTER sheet and styles an element INSIDE the tree, so the class
    # that decides it sits on an ancestor in another tree: the part's context epoch has to move with
    # it, through the chain that crosses the shadow boundary. Once a memoised part value survived a
    # class change that should have repainted it (two css-shadow/part WPT invalidation files caught it).
    page = shadow_page('', '<p part="label" id="t">x</p>',
                       doc_css: '#host::part(label) { color: rgb(255, 0, 0) } .on #host::part(label) { color: rgb(0, 128, 0) }')
    s = simulated_session(page)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('host').shadowRoot.getElementById('t');
        const before = getComputedStyle(t).color;
        document.body.classList.add('on');
        return [before, getComputedStyle(t).color];
      })()
    JS
    expect(got).to eq(['rgb(255, 0, 0)', 'rgb(0, 128, 0)'])
  end

  it 'keeps the layout epoch still on a focus flip the dynamic rule cannot match' do
    s = simulated_session(styled_page('<input id="i"><p id="after">after</p>'))
    s.visit '/'
    moved = s.evaluate_script(<<~JS)
      (() => {
        document.getElementById('after').getBoundingClientRect();   // prime a layout pass
        const before = globalThis.__csimLayoutEpoch();
        document.getElementById('i').focus();
        return globalThis.__csimLayoutEpoch() !== before;
      })()
    JS
    expect(moved).to be(false)
  end

  it 'relays out on focus when the dynamic rule CAN match' do
    body = '<div class="dd" tabindex="0"><div class="dd-content">content</div></div><p id="after">after</p>'
    s = simulated_session(styled_page(body))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const after = document.getElementById('after');
        const before = after.getBoundingClientRect().y;
        document.querySelector('.dd').focus();
        return [before, after.getBoundingClientRect().y];
      })()
    JS
    expect(got[1]).to be > got[0]
  end

  it 'relays out on focus for a widget inserted after the first layout' do
    s = simulated_session(styled_page('<p id="after">after</p>'))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const after = document.getElementById('after');
        const before = after.getBoundingClientRect().y;              // laid out before the widget exists
        const dd = document.createElement('div');
        dd.className = 'dd';
        dd.tabIndex = 0;
        dd.innerHTML = '<div class="dd-content">content</div>';
        document.body.insertBefore(dd, after);
        dd.focus();
        return [before, after.getBoundingClientRect().y];
      })()
    JS
    expect(got[1]).to be > got[0]
  end

  it 'relays out on focus for a widget a class WRITE makes' do
    # …and the widget made by a class-attribute write rather than an insertion: the rule can match
    # only from the write on, and the focus flip after it must still move the box. (A presence gate
    # once had to be reopened by both kinds of arrival.)
    s = simulated_session(styled_page('<div id="w" tabindex="0"><div class="dd-content">content</div></div><p id="after">after</p>'))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const after = document.getElementById('after');
        const before = after.getBoundingClientRect().y;              // laid out before the rule can match
        const w = document.getElementById('w');
        w.className = 'dd';
        w.focus();
        return [before, after.getBoundingClientRect().y];
      })()
    JS
    expect(got[1]).to be > got[0]
  end

  # A dynamic rule's subject need not carry a class / id / tag for its effect to stay LOCAL: the
  # focus flip marks the one element it restyles, and the layout epoch — every box memo on the page
  # — stays put. Redmine's `.drdn-items>*:focus` was the one rule that once pushed the entire page
  # into an epoch fallback, relaying out ~400 elements per focus change.
  it 'relays out a keyless universal subject without moving the layout epoch' do
    css = '.dd>*:focus { border: 10px solid red }'
    s = simulated_session(styled_page('<div class="dd"><input id="i"></div><p id="after">after</p>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const after = document.getElementById('after');
        const before = after.getBoundingClientRect().y;
        const epoch = globalThis.__csimLayoutEpoch(), marks = globalThis.__csimSubtreeMarks();
        document.getElementById('i').focus();
        const moved = after.getBoundingClientRect().y > before;
        // One subtree marked: the subject the flip restyled, not every element a dynamic rule names.
        return [moved, globalThis.__csimLayoutEpoch() === epoch, globalThis.__csimSubtreeMarks() - marks];
      })()
    JS
    expect(got).to eq([true, true, 1])
  end

  # …and an attribute-only subject the same way (Discourse's `[contenteditable=true]:focus-within`).
  it 'relays out an attribute-only subject without moving the layout epoch' do
    css = '[contenteditable=true]:focus-within { padding: 30px }'
    body = '<div contenteditable="true"><span id="in" tabindex="0">x</span></div><p id="after">after</p>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const after = document.getElementById('after');
        const before = after.getBoundingClientRect().y;
        const epoch = globalThis.__csimLayoutEpoch();
        document.getElementById('in').focus();
        return [after.getBoundingClientRect().y > before, globalThis.__csimLayoutEpoch() === epoch];
      })()
    JS
    expect(got).to eq([true, true])
  end

  # A dynamic pseudo INSIDE a logical pseudo, where the flip makes the rule STOP matching: the box
  # it restyles must still move.
  it 'relays out for a dynamic pseudo nested in :not()' do
    css = '#t { width: 200px } #t:not(:focus) { width: 50px }'
    s = simulated_session(styled_page('<div id="t" tabindex="0">x</div>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('t');
        const before = t.getBoundingClientRect().width;
        t.focus();
        return [before, t.getBoundingClientRect().width];
      })()
    JS
    expect(got).to eq([50, 200])
  end

  # The inline var() consumer's page again, and the flip must leave the layout epoch where it was: a
  # custom property can only reach the subject's subtree. Folded into the epoch, the old escape valve
  # relaid out the whole page per flip (Discourse: seven
  # `:hover { --text-color }` rules plus one inline `--composer-height: var(…)`).
  it 'relays out a custom-property-only rule\'s subject without moving the layout epoch' do
    css = '#t:focus { --w: 200px }'
    s = simulated_session(styled_page('<div id="t" tabindex="0" style="width: var(--w, 50px)">x</div>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('t');
        const before = t.getBoundingClientRect().width;
        const epoch = globalThis.__csimLayoutEpoch();
        t.focus();
        return [before, t.getBoundingClientRect().width, globalThis.__csimLayoutEpoch() === epoch];
      })()
    JS
    expect(got).to eq([50, 200, true])
  end

  # The two shapes where the state does not sit on the subject: on an ANCESTOR compound (hover is
  # ancestor-matching, so hovering `#b` hovers `.a` too) and on a preceding SIBLING. Both must
  # still move the box — and without moving the layout epoch.
  it 'reaches a subject below the compound that carries the state (hover on an ancestor)' do
    css = '.b { height: 20px } .a:hover .b { height: 200px }'
    s = simulated_session(styled_page('<div class="a"><div class="b" id="b">z</div></div><p id="after">after</p>', css: css))
    s.visit '/'
    before = s.evaluate_script("[document.getElementById('b').getBoundingClientRect().height, globalThis.__csimLayoutEpoch()]")
    s.find('#b').hover
    after = s.evaluate_script("[document.getElementById('b').getBoundingClientRect().height, globalThis.__csimLayoutEpoch()]")
    expect([before[0], after[0]]).to eq([20, 200])
    expect(after[1]).to eq(before[1])
  end

  it 'reaches a subject that follows the state-carrying compound as a sibling' do
    css = '#b { width: 20px } #a:focus ~ #b { width: 200px }'
    s = simulated_session(styled_page('<div><div id="a" tabindex="0">x</div><div id="b">y</div></div>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const b = document.getElementById('b');
        const before = b.getBoundingClientRect().width;
        const epoch = globalThis.__csimLayoutEpoch();
        document.getElementById('a').focus();
        return [before, b.getBoundingClientRect().width, globalThis.__csimLayoutEpoch() === epoch];
      })()
    JS
    expect(got).to eq([20, 200, true])
  end

  # State read RELATIONALLY — inside `:has()` — flips on an element that is neither the subject
  # nor the compound that changes (`.a:has(.b:focus) .c`: focus lands on `.b`, the compound that
  # starts matching is `.a`, the box that moves is `.c`).
  it 'reaches a subject whose state sits inside :has()' do
    css = '.c { height: 20px } .a:has(.b:focus) .c { height: 200px }'
    body = '<div class="a"><div class="b" tabindex="0">x</div><div class="c" id="c">y</div></div>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const c = document.getElementById('c');
        const before = c.getBoundingClientRect().height;
        document.querySelector('.b').focus();
        return [before, c.getBoundingClientRect().height];
      })()
    JS
    expect(got).to eq([20, 200])
  end

  # Tailwind v4 compiles `group-hover:` into `:is(:where(.group):hover *)`: the state sits on an
  # ANCESTOR named inside the logical pseudo, so the element that flips is reached from the subject
  # only through the `:is()`.
  it 'reaches a subject whose state sits on an ancestor inside :is()' do
    css = '.x { height: 20px } .x:is(:where(.group):hover *) { height: 200px }'
    s = simulated_session(styled_page('<div class="group"><span>title</span><div class="x" id="x">z</div></div>', css: css))
    s.visit '/'
    before = s.evaluate_script("document.getElementById('x').getBoundingClientRect().height")
    s.find('.group span').hover
    after = s.evaluate_script("document.getElementById('x').getBoundingClientRect().height")
    expect([before, after]).to eq([20, 200])
  end

  # The focused element leaving the tree un-focuses its old ancestors with no focus call at all:
  # `:focus-within` stops matching on the panel it left, and a rule on the panel's other child must
  # un-apply. (By the time anything looks, the removed element's ancestors are gone from under it.)
  it 'un-applies a :focus-within rule when the focused element is removed' do
    css = '.s { height: 20px } .panel:focus-within .s { height: 200px }'
    s = simulated_session(styled_page('<div class="panel"><input id="i"><div class="s" id="s">y</div></div>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const sEl = document.getElementById('s');
        document.getElementById('i').focus();
        const focused = sEl.getBoundingClientRect().height;
        document.getElementById('i').remove();
        return [focused, sEl.getBoundingClientRect().height];
      })()
    JS
    expect(got).to eq([200, 20])
  end

  # With a hover rule and a focus rule both on the page, a focus flip marks exactly the subject it
  # restyles — one subtree mark — and not the hover rule's. (A sweep over every dynamic rule once
  # marked both.)
  it 'marks only the subject a focus flip restyles, not a hover rule\'s' do
    css = '.h:hover { padding: 10px } .f:focus { padding: 10px }'
    body = '<div class="h">hover me</div><div class="f" id="f" tabindex="0">focus me</div>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const f = document.getElementById('f');
        f.getBoundingClientRect();
        const marks = globalThis.__csimSubtreeMarks();
        f.focus();
        f.getBoundingClientRect();
        return globalThis.__csimSubtreeMarks() - marks;
      })()
    JS
    expect(got).to eq(1)
  end

  # Checkedness feeds validity too: a required checkbox becomes `:valid` when checked, so a
  # `:invalid` layout rule on it (and on its form) must un-apply when it is checked.
  it 'relays out an :invalid rule when a required checkbox is checked' do
    css = '#c { height: 20px } #c:invalid { height: 60px } form:invalid { padding-bottom: 100px }'
    body = '<form id="fm"><input type="checkbox" id="c" required></form><p id="after">after</p>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const c = document.getElementById('c'), after = document.getElementById('after');
        const before = [c.getBoundingClientRect().height, after.getBoundingClientRect().y];
        c.checked = true;
        return [before, [c.getBoundingClientRect().height, after.getBoundingClientRect().y]];
      })()
    JS
    expect(got[0][0]).to eq(60)
    expect(got[1][0]).to eq(20)
    expect(got[1][1]).to be < got[0][1]
  end

  # …and so does an option's selectedness for a required `<select>`.
  it 'relays out a select:invalid rule when a required select gains a value' do
    css = '#sel { height: 20px } #sel:invalid { height: 60px }'
    body = '<form><select id="sel" required><option value="">pick</option><option id="o" value="a">a</option></select></form>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const sel = document.getElementById('sel');
        const before = sel.getBoundingClientRect().height;
        document.getElementById('o').selected = true;
        return [before, sel.getBoundingClientRect().height];
      })()
    JS
    expect(got).to eq([60, 20])
  end

  it 'hit-tests fresh z-index after focus, without a relayout in between' do
    # A `:focus { z-index }` rule moves no box, so nothing need relay out — the paint order must
    # come out right anyway. `stackChain` bakes an ANCESTOR stacking context's
    # `paintRank` (a z-index read) into a per-pass memo, and the second hit-test has to read the
    # post-focus rank, not replay the pre-focus one. Siblings compare their own ranks live, so the
    # rule has to sit on the CONTEXT-ESTABLISHING ancestor for this to bite.
    css = '#a, #b { position: absolute; left: 0; top: 0; width: 50px; height: 50px; z-index: 0 } ' \
          '#ac, #bc { position: absolute; left: 0; top: 0; width: 50px; height: 50px } ' \
          '#a:focus { z-index: 10 }'
    body = '<div id="a" tabindex="0"><div id="ac">a</div></div><div id="b"><div id="bc">b</div></div>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const before = document.elementFromPoint(25, 25).id;   // equal ranks: tree order, b's child
        document.getElementById('a').focus();
        return [before, document.elementFromPoint(25, 25).id];
      })()
    JS
    expect(got).to eq(['bc', 'ac'])
  end

  it 'relays out on focus for a widget the STREAMING PARSER inserts after a mid-parse read' do
    # Parser insertions bypass `recordChildList`: they are noted as they land (`noteParsedChange`)
    # and marked at the next pass. The inline script's read lays the page out before the widget
    # exists; the widget the rest of the page parses in must still move a box on focus. (A presence
    # gate's memo once needed a parser-generation key of its own for this, and without it the
    # mid-parse answer "nothing can match" stuck for good.)
    body = '<script>document.documentElement.getBoundingClientRect();</script>' \
           '<div class="dd" tabindex="0"><div class="dd-content">content</div></div><p id="after">after</p>'
    s = simulated_session(styled_page(body))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const after = document.getElementById('after');
        const before = after.getBoundingClientRect().y;
        document.querySelector('.dd').focus();
        return [before, after.getBoundingClientRect().y];
      })()
    JS
    expect(got[1]).to be > got[0]
  end

  it 'keeps the layout epoch still on a focus flip after the widget leaves' do
    body = '<div class="dd" tabindex="0"><div class="dd-content">content</div></div><input id="i"><p id="after">after</p>'
    s = simulated_session(styled_page(body))
    s.visit '/'
    moved = s.evaluate_script(<<~JS)
      (() => {
        document.querySelector('.dd').remove();
        document.getElementById('after').getBoundingClientRect();   // lay out with the widget gone
        const before = globalThis.__csimLayoutEpoch();
        document.getElementById('i').focus();
        return globalThis.__csimLayoutEpoch() !== before;
      })()
    JS
    expect(moved).to be(false)
  end

  # ── class writes ────────────────────────────────────────────────────────────────────────────
  # A class write marks the writer's subtree, and the style engine's restyle marks whatever else the
  # flipped tokens reach. `__csimSubtreeMarks` is the observable for what is kept — geometry cannot
  # distinguish a surviving memo from an equal recompute.

  it 'relays out a descendant when a container gains a class a descendant rule reads' do
    css = '.panel { height: 20px } .open .panel { height: 120px }'
    s = simulated_session(styled_page('<div id="c"><div><div class="panel" id="p">x</div></div></div>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const p = document.getElementById('p');
        const before = p.getBoundingClientRect().height;
        document.getElementById('c').className = 'open';
        return [before, p.getBoundingClientRect().height];
      })()
    JS
    expect(got).to eq([20, 120])
  end

  it 'relays out a descendant through an identifier nested in :not()' do
    # A REMOVED class that a `:not()` reads starts the rule matching. A token collection that once
    # skipped identifiers nested in `:not` / `:is` left 'off' out, and the descendant stale.
    # The target sits TWO levels down: a direct child would be healed by the parent's own
    # usedSize re-read, and the spec would pass without the subtree mark it exists to pin.
    css = '.kid { height: 20px } .wrap:not(.off) .kid { height: 120px }'
    s = simulated_session(styled_page('<div class="wrap off" id="c"><div><div class="kid" id="k">x</div></div></div>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const k = document.getElementById('k');
        const before = k.getBoundingClientRect().height;
        document.getElementById('c').classList.remove('off');
        return [before, k.getBoundingClientRect().height];
      })()
    JS
    expect(got).to eq([20, 120])
  end

  it 'relays out a class write that only REORDERS tokens a literal [class="…"] rule reads' do
    # The one selector shape that can see serialization order: `b a` holds the same tokens as
    # `a b` and no longer matches `[class="a b"]`. A token-set gate once had to give up on any page
    # with such a rule; a class write marks the writer's subtree whatever its tokens.
    css = 'div { height: 20px } [class="a b"] { height: 120px }'
    s = simulated_session(styled_page('<div class="a b" id="p">x</div>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const p = document.getElementById('p');
        const before = p.getBoundingClientRect().height;
        const marks = globalThis.__csimSubtreeMarks();
        p.className = 'b a';
        return [before, p.getBoundingClientRect().height, globalThis.__csimSubtreeMarks() > marks];
      })()
    JS
    # (…the height is the writer's own box, marked whatever happens to its subtree; the count pins the subtree mark)
    expect(got).to eq([120, 20, true])
  end

  it 'relays out descendants of a subject-position box-property flip' do
    # A class write marks the writer's SUBTREE even when the rule it flips declares only box
    # properties: a heal through the parent's relayout looks sufficient for the `%` grandchild here,
    # but an abspos descendant anchored to the subject's containing block escapes it (next example).
    css = '.box { width: 100px } .box.wide { width: 200px } .half { width: 50% }'
    body = '<div class="box" id="c"><div class="half"><div class="half" id="g">x</div></div></div>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = document.getElementById('g');
        const before = g.getBoundingClientRect().width;
        document.getElementById('c').classList.add('wide');
        return [before, g.getBoundingClientRect().width];
      })()
    JS
    expect(got).to eq([25, 50])
  end

  it 'moves an abspos descendant anchored to a subject whose height flips' do
    # The case that rules out marking the writer alone: the anchor's placement only reruns inside a
    # relaid-out ancestor, and the auto-height element between them would otherwise be reused.
    css = '.box { position: relative; height: 200px } .box.tall { height: 400px }'
    body = '<div class="box" id="c"><div><div style="position: absolute; bottom: 0; height: 10px" id="a">x</div></div></div>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('a');
        const before = a.getBoundingClientRect().y;
        document.getElementById('c').classList.add('tall');
        return [before, a.getBoundingClientRect().y];
      })()
    JS
    expect(got[1] - got[0]).to eq(200)
  end

  # ── …and what a SHADOW sheet does to it ──────────────────────────────────────────────────────
  # A class write marks the writer's subtree and no more, whatever the shadow sheets on the page
  # declare: a single widget once cost every light-DOM class write on the page more than that — on the
  # perf gate's 400-row table, HALF the page's subtree reuse (`reuse_hit` 602 against 1200 for the
  # identical page without the host), which the wall could not see.
  #
  # The examples below are the ways a shadow sheet crosses its boundary. **`__csimSubtreeMarks` is
  # the only observable that pins the marks themselves**: the walk's splice (`spliceable`) refuses a subtree
  # holding an escaping out-of-flow box on its own, so geometry heals every one of these
  # shapes either way. Where a geometry assertion appears beside the count it pins the MATCHING, not
  # the mark; where none appears the rule does not match here yet (`:host(.x) .y`), and the count is
  # the whole test.

  it 'relays out a class write INSIDE a shadow tree' do
    # Only the tree's own sheet reaches the panel — the document's rules do not — and it sits two
    # levels below the writer. (A gate built from the document's rules once described nothing about
    # such a write and had to give it the subtree mark outright.)
    s = simulated_session(styled_page('<div id="h"></div>', css: '.noop-rule { width: 1px }'))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const sr = document.getElementById('h').attachShadow({mode: 'open'});
        sr.innerHTML = '<style>.wrap .panel { height: 120px } .panel { height: 20px }</style>' +
                       '<div id="w"><div><div class="panel" id="p">x</div></div></div>';
        const p = sr.getElementById('p');
        const before = p.getBoundingClientRect().height;
        sr.getElementById('w').className = 'wrap';
        return [before, p.getBoundingClientRect().height];
      })()
    JS
    expect(got).to eq([20, 120])
  end

  it 'marks a light child a ::slotted rule restyles on a class write' do
    # `::slotted(.x)` is written in a shadow sheet and styles a LIGHT child of the host — an element
    # whose class writes a gate over the document's rules once answered for completely. One mark,
    # the writer's subtree, and the shadow sheet's rule has to match it.
    css  = '.red { color: rgb(255, 0, 0) }'
    body = '<div id="h"><div id="c"><div id="p">x</div></div></div>'
    s    = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        document.getElementById('h').attachShadow({mode: 'open'}).innerHTML =
          '<style>::slotted(.red) { height: 120px }</style><slot></slot>';
        const c = document.getElementById('c');
        c.getBoundingClientRect();
        const marks = globalThis.__csimSubtreeMarks();
        c.classList.add('red');
        return [globalThis.__csimSubtreeMarks() - marks, c.getBoundingClientRect().height];
      })()
    JS
    expect(got).to eq([1, 120])
  end

  it 'relays out a host its own tree styles on a class write' do
    # `:host(.x)` is the mirror of `::slotted`: written inside the tree, matching the host, which
    # lives in the document scope. The tree carries NO bare `:host` rule on purpose, so the 120 can
    # only come from `:host(.red)` matching once the class lands.
    # (The document declares no HEIGHT for the host: its normal declaration would beat `:host(.red)`
    # outright — the outer context wins, Chrome and Firefox both leave such a host at the document's
    # figure — and the height would never move. The host's 20 before is its content's.)
    css  = '.hostbase { display: block } .red { color: rgb(255, 0, 0) }'
    s    = simulated_session(styled_page('<div id="h" class="hostbase"></div>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const h = document.getElementById('h');
        h.attachShadow({mode: 'open'}).innerHTML =
          '<style>:host(.red) { height: 120px }</style><p style="margin: 0; height: 20px">w</p>';
        h.getBoundingClientRect();
        const marks = globalThis.__csimSubtreeMarks();
        h.classList.add('red');
        return [globalThis.__csimSubtreeMarks() - marks, h.getBoundingClientRect().height];
      })()
    JS
    expect(got).to eq([1, 120])
  end

  it 'marks a host whose tree reads its class only through the :host(.x) COMBINATOR form' do
    # `:host(.x) .y` is an in-tree rule that reads the host's class through a combinator. The write
    # must be marked, so nothing goes stale. There is no geometry to assert
    # for the same reason: the count is the whole test.
    css  = '.red { color: rgb(255, 0, 0) }'
    s    = simulated_session(styled_page('<div id="h"></div>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const h = document.getElementById('h');
        h.attachShadow({mode: 'open'}).innerHTML =
          '<style>:host(.red) .p { height: 120px }</style><p class="p">w</p>';
        h.getBoundingClientRect();
        const marks = globalThis.__csimSubtreeMarks();
        h.classList.add('red');
        return globalThis.__csimSubtreeMarks() - marks;
      })()
    JS
    expect(got).to eq(1)
  end

  it 'keeps relaying out when a custom-prop rule feeds an inline var() consumer' do
    # The rule declares only a custom property, and its one consumer is an inline
    # `height: var(--h)` two levels below the writer: nothing in the sheets says the flip moves a
    # box. (A token gate built before the inline consumer was first seen once had to carry a VAR bit
    # for it, resolved at write time.)
    css = '.on { --h: 300px }'
    body = '<div id="c"><div><div style="height: var(--h, 50px)" id="g">x</div></div></div>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = document.getElementById('g');
        const before = g.getBoundingClientRect().height;
        document.getElementById('c').classList.add('on');
        return [before, g.getBoundingClientRect().height];
      })()
    JS
    expect(got).to eq([50, 300])
  end

  it 'relays out a descendant when the body LOSES a class a descendant rule reads' do
    css = '.host { height: 20px } body.chrome-x .host { height: 120px }'
    body = '<div class="host" id="h">x</div>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        document.body.classList.add('chrome-x');
        const h = document.getElementById('h');
        const grown = h.getBoundingClientRect().height;
        document.body.classList.remove('chrome-x');
        return [grown, h.getBoundingClientRect().height];
      })()
    JS
    expect(got).to eq([120, 20])
  end

  it 'relays out a descendant when a class flip declares an inherited property' do
    css = '.big-text { font-size: 32px }'
    body = '<div id="c"><div><div id="g">word</div></div></div>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = document.getElementById('g');
        const before = g.getBoundingClientRect().height;
        document.getElementById('c').classList.add('big-text');
        return [before, g.getBoundingClientRect().height];
      })()
    JS
    expect(got[1]).to be > got[0]
  end

  it 'reaches a later sibling INTERIOR through a sibling-combinator rule' do
    # The subject of a `~` rule is a later SIBLING of the writer, outside the subtree the write
    # marks, so the restyle has to mark it. The stale case is the sibling's INTERIOR — an inherited
    # property two levels down, where the parent's own re-derivation of the sibling's box cannot
    # heal (main once left the grandchild's text at the old font-size).
    css = '.a ~ .b { font-size: 32px }'
    body = '<div id="first">x</div><div class="b"><div><div id="deep">word</div></div></div>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const d = document.getElementById('deep');
        const before = d.getBoundingClientRect().height;
        document.getElementById('first').classList.add('a');
        return [before, d.getBoundingClientRect().height];
      })()
    JS
    expect(got[1]).to be > got[0]
  end

  # ── dynamic-state flips ─────────────────────────────────────────────────────────────────────
  # A focus / hover / checked flip must not move the layout epoch — that killed every box memo on
  # the page — and the boxes it restyles are marked by the restyle (layout.js `markRestyles`).

  it 'keeps the layout epoch still on a focus flip the dynamic rule matches' do
    body = '<div class="dd" tabindex="0"><div class="dd-content">content</div></div>' \
           '<div id="far"><div><div>quiet</div></div></div><p id="after">after</p>'
    s = simulated_session(styled_page(body))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const after = document.getElementById('after');
        const before = after.getBoundingClientRect().y;
        const epoch = globalThis.__csimLayoutEpoch();
        document.querySelector('.dd').focus();
        const after2 = after.getBoundingClientRect().y;
        return [after2 > before, globalThis.__csimLayoutEpoch() === epoch];
      })()
    JS
    expect(got).to eq([true, true])
  end

  it 'relays out a table grid when a dynamic display rule flips a row' do
    # A `display` flip on a row changes which rows the table's grid holds, with no child-list
    # change and no move of the layout epoch — so the restyle has to mark it as the structural
    # change it is (`__csimMarkRestyled`): marked as none, the grid kept the hidden row.
    css = '.toggle:checked ~ table .maybe-row { display: none }'
    body = '<input type="checkbox" class="toggle" id="t">' \
           '<table><tbody><tr class="maybe-row"><td>a</td></tr><tr><td id="keep">b</td></tr></tbody></table>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const keep = document.getElementById('keep');
        const before = keep.getBoundingClientRect().y;
        document.getElementById('t').checked = true;
        return [before > 0, keep.getBoundingClientRect().y < before];
      })()
    JS
    expect(got).to eq([true, true])
  end

  it 'delivers an IntersectionObserver update for a state-revealed target' do
    # The IO recheck early-returns on layoutGeneration(); the restyle marks move neither
    # settleGen nor the epoch, so the generation carries the dirty sequence too.
    s = simulated_session(styled_page('<div class="dd" tabindex="0"><div class="dd-content" id="c">content</div></div>'))
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      let delivered = false;
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!delivered) {
            // The INITIAL delivery is unconditional; the RE-check after the flip is what the
            // layoutGeneration gate can wrongly skip — flip only after the first delivery.
            delivered = true;
            if (e.isIntersecting) { io.disconnect(); done('early'); return; }
            document.querySelector('.dd').focus();
          } else if (e.isIntersecting) { io.disconnect(); done(true); return; }
        }
      });
      io.observe(document.getElementById('c'));
      setTimeout(() => done(false), 2000);
    JS
    expect(got).to be(true)
  end

  it 'relays out Tailwind-style colon classes on a state flip and on a class write' do
    # A class with a colon in it (`checked:block`, `peer:pane`). The scoped-state sweep and a class
    # write's descendant path once fed it to querySelectorAll unescaped, where `checked:block`
    # parsed as a pseudo-class and THREW.
    css = '.toggle:checked ~ .checked\\:block { display: block } ' \
          '.checked\\:block { display: none } ' \
          'body.mode-x .peer\\:pane { height: 120px } .peer\\:pane { height: 20px }'
    body = '<input type="checkbox" class="toggle" id="t">' \
           '<div class="checked:block" id="rev">revealed</div>' \
           '<div class="peer:pane" id="pane">x</div>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const rev = document.getElementById('rev');
        const pane = document.getElementById('pane');
        document.getElementById('t').checked = true;              // a state flip
        const revealed = rev.getBoundingClientRect().height > 0;
        document.body.classList.add('mode-x');                    // a class write
        return [revealed, pane.getBoundingClientRect().height];
      })()
    JS
    expect(got).to eq([true, 120])
  end

  it 'relays out for a checkedness flip from the CLICK path too' do
    # Every checkedness writer goes through `setCheckedness`; when only the IDL setter said the
    # state had flipped, a plain el.click() left stale geometry.
    css = 'input:checked { height: 100px }'
    body = '<input type="checkbox" id="t"><p id="after">after</p>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const after = document.getElementById('after');
        const before = after.getBoundingClientRect().y;
        document.getElementById('t').click();
        return [before, after.getBoundingClientRect().y];
      })()
    JS
    expect(got[1]).to be > got[0]
  end

  it 'relays out the children a :focus-within rule reaches through `> *`' do
    css = '.dd:focus-within > * { margin-top: 100px }'
    body = '<div class="dd" tabindex="0"><div id="k">x</div></div>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const k = document.getElementById('k');
        const before = k.getBoundingClientRect().y;
        document.querySelector('.dd').focus();
        return [before, k.getBoundingClientRect().y];
      })()
    JS
    # The 100px margin lands — and COLLAPSES out through `.dd` and the body, so the child ends up
    # AT 100 rather than 100 below where it was (Chrome: 8 -> 100).
    expect(got).to eq([8, 100])
  end

  it 'relays out a :target rule on a fragment navigation' do
    css = '#t { height: 20px } #t:target { height: 120px }'
    s = simulated_session(styled_page('<div id="t">x</div><p id="after">after</p>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const after = document.getElementById('after');
        const before = after.getBoundingClientRect().y;
        location.hash = '#t';
        return [before, after.getBoundingClientRect().y];
      })()
    JS
    expect(got[1] - got[0]).to eq(100)
  end

  it 'relays out a :checked-driven rule when an option is selected programmatically' do
    # Style reads are the engine's and always fresh — the layer that can go STALE is layout: the select's box memo keys on the layout epoch, which a selectedness change
    # does not move, so the restyle has to mark the select whose `:has()` reads an option's state.
    css = 'select { height: 20px } select:has(option:checked[value="b"]) { height: 120px }'
    body = '<select id="s"><option value="a">a</option><option value="b">b</option></select><p id="after">after</p>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const after = document.getElementById('after');
        const before = after.getBoundingClientRect().y;
        document.getElementById('s').value = 'b';
        return [before, after.getBoundingClientRect().y];
      })()
    JS
    expect(got[1] - got[0]).to eq(100)
  end

  it 'relays out an :invalid-driven rule on setCustomValidity' do
    css = '#t { height: 20px } #t:invalid { height: 120px }'
    body = '<input id="t"><p id="after">after</p>'
    s = simulated_session(styled_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const after = document.getElementById('after');
        const before = after.getBoundingClientRect().y;
        document.getElementById('t').setCustomValidity('bad');
        return [before, after.getBoundingClientRect().y];
      })()
    JS
    expect(got[1] - got[0]).to eq(100)
  end

  it 'drops :modal styling on show() after showModal() and close()' do
    # `:modal` is internal state with no attribute behind it: closing has to say it flipped. (A show() while it is
    # still open as a modal is an InvalidStateError — Chrome's, measured — so the dialog is closed between.)
    css = '#t { height: 20px } #t:modal { height: 120px }'
    s = simulated_session(styled_page('<dialog id="t">x</dialog>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('t');
        t.showModal();
        const modal = t.getBoundingClientRect().height;
        t.close();
        t.show();
        return [modal, t.getBoundingClientRect().height];
      })()
    JS
    # (Border boxes: the dialog UA's `padding: 1em` and 3px `border: solid` add 38 — Chrome reports 158 and 58.)
    expect(got).to eq([158, 58])
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
