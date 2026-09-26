require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/js_engine'

# The cascade matches selectors LIVE on every read — that is how a DYNAMIC pseudo-class takes effect
# at all. Anything that CACHES a cascade result therefore has to be invalidated by every input those
# selectors read. Most already move `settleGen` (an attribute, the tree, the location) or
# `cascadeVersion` (a stylesheet); the rest are kept OUT of the cache by the taint bracket (a read
# that considered a dynamic-pseudo rule is never memoised), and move `styleStateGen` only for the
# layout-side sweep.
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
       "document.getElementById('t').setCustomValidity('bad');",              'rgb(0, 128, 0)'],
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
          active:       d('#t:active'),             // matcher-constant: isActive is () => false
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
      'active'       => false,
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

  # …and the same state change has to reach the BOXES, not just the CSSOM. Layout keyed its memos on
  # the rule-set version, which no state change moves, so an element styled by a dynamic selector
  # kept the box it was first laid out with — `getBoundingClientRect` served the placeholder-shown
  # 300px after the field was filled. Chrome 151, same page: 308 then 108 — a text `<input>` is
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
  # PAINTS must not invalidate layout at all. Keyed on the style-state generation unconditionally,
  # one `setRangeText` on a page with a `:hover { background: … }` rule relaid out the whole
  # document — 1 ms became 2.9 s for 100 type-and-measure rounds on a 300-row page.
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

  # ── the dynamic-layout PRESENCE gate ─────────────────────────────────────────────────────────
  # A dynamic rule that can move boxes makes the layout epoch listen to focus / hover / checked
  # state — the whole document relays out per state change. The gate narrows that to "while every
  # identifier the rule's compounds require exists in the document": widget CSS shipped site-wide
  # (EasyMDE, flatpickr) stops taxing the pages that never render the widget. These specs pin both
  # sides: the epoch must NOT move while the rule can't match, and MUST take effect the moment it
  # can — including when the widget arrives only after the gate has answered once.

  # Methods, not constants, for the same reason as `cases` above: a constant assigned inside a
  # `describe` block lands at top level and collides across spec files.
  def gated_css
    '.dd-content { display: none } .dd:focus-within .dd-content { display: block }'
  end

  def gated_page(body, css: nil)
    lambda {|_env|
      [200, {'content-type' => 'text/html'},
       ["<!DOCTYPE html><html><head><style>#{css || gated_css}</style></head><body>#{body}</body></html>"]]
    }
  end

  # ── What a shadow tree's own sheets reach, and the gates that answer for the WHOLE DOCUMENT ───────
  #
  # Several document-wide O(1) gates — "does anything here declare this property / a `@keyframes` / a
  # transition?" — cannot see a shadow tree's sheets, which are in no document index, so they answer
  # YES for the entire page the moment one shadow host exists. That is correct and very expensive: a
  # 400-row table beside one `<my-widget>` relays out 5.4x slower (51 ms → 280 ms, measured), with
  # every light-DOM element paying for a component stylesheet that cannot reach it — see
  # `shadow_host_gates_fail_open` for the decomposition and why narrowing them is its own increment.
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
    # …read at its FIRST frame, so the assertion needs no clock: the animation's own `from` is 25px
    # where the element would otherwise be at the initial 0.
    css = '@keyframes slide { from { margin-left: 25px } to { margin-left: 40px } } .t { animation: slide 10s linear both }'
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
    s.evaluate_script("document.getElementById('host').shadowRoot.getElementById('t').classList.add('on')")
    colour = s.evaluate_script("getComputedStyle(document.getElementById('host').shadowRoot.getElementById('t')).color")
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

  it 'folds each distinct shadow stylesheet once, past the parse cache\'s limit' do
    # Components share a PARSED sheet only while `parseSheetCached`'s LRU holds it — 256 texts. Past
    # that a re-parse is a new object, so deduping on identity re-folds the sheet and re-lists it, and
    # the context gate is rebuilt over a pile that grows with every write: 500 components with distinct
    # sheets produced 92,610 entries and were SLOWER than not narrowing the gates at all. The dedupe
    # keys on the sheet's cache key, which does not evict.
    n = 300
    s = simulated_session(lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body><div id="root"></div></body></html>']]
    })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const root = document.getElementById('root');
        for (let i = 0; i < #{n}; i++) {
          const h = document.createElement('div');
          root.appendChild(h);
          h.attachShadow({ mode: 'open' }).innerHTML =
            '<style>.p' + i + ' { color: #3' + (i % 10) + '3 }</style><p class="p' + i + '">w</p>';
        }
        document.body.offsetHeight;
        // …and the CHURN that makes eviction bite: a DOCUMENT stylesheet change bumps the cascade
        // version, every tree's rules are rebuilt on the next pass, and a sheet the LRU has dropped is
        // re-parsed into a NEW object. Nothing here changes what any tree declares, so the count must
        // not move.
        for (let k = 0; k < 3; k++) {
          const st = document.createElement('style');
          st.textContent = '.churn' + k + ' { color: #' + k + k + k + ' }';
          document.head.appendChild(st);
          document.body.offsetHeight;
          st.remove();
          document.body.offsetHeight;
        }
        return globalThis.__csimShadowSheetCount();
      })()
    JS
    expect(got).to eq(n)
  end

  it 'relays out for a DYNAMIC rule that moves a box inside a shadow tree' do
    # Two gates are a pair here: the scoped-state hook cannot sweep a shadow rule's subjects (the
    # subject list is the document's), so the layout EPOCH carries dynamic state instead. Both used to
    # switch on "is there a host at all" — which cost every page with one a `styleStateGeneration()`
    # call per element per pass, for a widget that may declare nothing dynamic. They ask the trees'
    # own sheets now, and this is what that has to keep working. Narrowing one without the other is
    # how a page ends up both sweeping nothing AND keying on nothing.
    [
      ['#t { width: 40px } #t:hover { width: 300px }',
       "document._hoverElement = document.getElementById('host').shadowRoot.getElementById('t');", 300],
      ['#t { width: 40px } #t:focus { width: 300px }',
       "const el = document.getElementById('host').shadowRoot.getElementById('t'); el.setAttribute('tabindex', '0'); el.focus();", 300],
      # …and one that only PAINTS moves no box, so it must NOT drag dynamic state into the epoch
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
    # …and the paint-only case needs a barrier of its own: a width that did not move is what a rule
    # dragging state into the epoch produces TOO (it costs work, it does not change the answer). The
    # epoch is the observable, so ask it directly.
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
    # Whether document rules reach an element is decided by walking to its enclosing shadow root, and
    # that walk is memoised per element against a tree generation — `cascadedProperty` makes it for
    # every property read, and on a 400-row table beside one widget it was half of what the host still
    # cost the page. The generation moves on every child-list record, which is the only way the answer
    # can change; these are the two moves that prove it, and Chrome agrees with all four figures.
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
    # The mirror of the case above, and the one thing neither list carries: a `::part()` rule lives in
    # the DOCUMENT sheet, so no shadow sheet declares it — and `collectDynamicLayoutRules` drops every
    # rule whose subject is a pseudo-element, so the document's dynamic-subject list does not carry it
    # either. Nothing would relay out for it: the scoped hook cannot sweep a subject one tree in, and
    # the epoch would have stopped keying on dynamic state. The document's part rules are scanned for
    # it (`dynamicPartRule`).
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

  # …and the STRUCTURAL-CONTEXT gate, which decides whether a memoised computed value survives a
  # mutation. It used to be switched off entirely by the presence of a host — the single biggest part
  # of that 5.4x — and now indexes the shadow sheets too, so a mutation a shadow selector reads has to
  # still invalidate. `:host-context()` (an ancestor OF the host) and `::part()` (a rule in the OUTER
  # sheet whose subject is inside the tree) are the two forms the index cannot model; both keep it
  # conservative, which is what these two pin.
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
    # A `::part()` rule lives in the OUTER sheet and styles an element INSIDE the tree, so the
    # structural-context index — which keys on the element a rule is written against — cannot answer
    # for it, and the gate stays conservative whenever the document has one. Without that, a memoised
    # part value survived a class change that should have repainted it (two css-shadow/part WPT
    # invalidation files caught it).
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

  it 'keeps dynamic state out of the declared-value memo key, and lets a rule-set change in' do
    # The taint bracket is what keeps a CACHED value independent of focus / typing / checkedness;
    # moving the memo's key on every state write on top of it only cold-started every element's
    # memo per keystroke (a third of all memo entries on a Discourse subset).
    body = '<input id="i"><input id="c" type="checkbox"><p id="after">after</p>'
    s = simulated_session(gated_page(body))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const after = document.getElementById('after');
        getComputedStyle(after).color;                                   // prime the memo
        const before = globalThis.__csimStyleEpoch();
        document.getElementById('i').focus();
        document.getElementById('i').value = 'typed';
        document.getElementById('c').checked = true;
        const afterState = globalThis.__csimStyleEpoch();
        const style = document.createElement('style');
        style.textContent = 'p { color: rgb(0, 128, 0) }';
        document.head.appendChild(style);
        const color = getComputedStyle(after).color;                     // a rule-set change reaches the memo
        return [afterState === before, globalThis.__csimStyleEpoch() !== before, color];
      })()
    JS
    expect(got).to eq([true, true, 'rgb(0, 128, 0)'])
  end

  it 'keeps dynamic state out of the layout epoch while the rule cannot match' do
    s = simulated_session(gated_page('<input id="i"><p id="after">after</p>'))
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
    s = simulated_session(gated_page(body))
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

  it 're-arms the gate when the widget arrives after the gate has answered' do
    s = simulated_session(gated_page('<p id="after">after</p>'))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const after = document.getElementById('after');
        const before = after.getBoundingClientRect().y;              // gate answers "unarmed"
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

  it 're-arms the gate when the widget arrives by a class WRITE' do
    # The other half of the invalidation contract the gate rests on: a class-attribute write,
    # not just an insertion, must reopen it.
    s = simulated_session(gated_page('<div id="w" tabindex="0"><div class="dd-content">content</div></div><p id="after">after</p>'))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const after = document.getElementById('after');
        const before = after.getBoundingClientRect().y;              // gate answers "unarmed"
        const w = document.getElementById('w');
        w.className = 'dd';
        w.focus();
        return [before, after.getBoundingClientRect().y];
      })()
    JS
    expect(got[1]).to be > got[0]
  end

  it 'keeps relaying out for an inline style that consumes a custom property' do
    # The escape valve for the one consumer the sheet-side reachability scan cannot see: an
    # inline `width: var(--w)` with a dynamic rule writing `--w` must keep moving geometry.
    css = '#t:focus { --w: 200px }'
    s = simulated_session(gated_page('<div id="t" tabindex="0" style="width: var(--w, 50px)">x</div>', css: css))
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

  # A dynamic rule's subject need not carry a class / id / tag for its effect to be SCOPED: the
  # query is the whole selector with the state taken out (`.dd>*`), so the focus flip dirties the
  # elements it can reach and the layout epoch — every box memo on the page — stays put. Redmine's
  # `.drdn-items>*:focus` was the one rule that used to push the entire page into the epoch
  # fallback, relaying out ~400 elements per focus change.
  it 'scopes a keyless universal subject instead of moving the layout epoch' do
    css = '.dd>*:focus { border: 10px solid red }'
    s = simulated_session(gated_page('<div class="dd"><input id="i"></div><p id="after">after</p>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const after = document.getElementById('after');
        const before = after.getBoundingClientRect().y;
        const epoch = globalThis.__csimLayoutEpoch(), marks = globalThis.__csimSubtreeMarks();
        document.getElementById('i').focus();
        const moved = after.getBoundingClientRect().y > before;
        // One subject dirtied — the hinted sweep, not a fallback over every dynamic rule.
        return [moved, globalThis.__csimLayoutEpoch() === epoch, globalThis.__csimSubtreeMarks() - marks];
      })()
    JS
    expect(got).to eq([true, true, 1])
  end

  # …and an attribute-only subject the same way (Discourse's `[contenteditable=true]:focus-within`).
  it 'scopes an attribute-only subject instead of moving the layout epoch' do
    css = '[contenteditable=true]:focus-within { padding: 30px }'
    body = '<div contenteditable="true"><span id="in" tabindex="0">x</span></div><p id="after">after</p>'
    s = simulated_session(gated_page(body, css: css))
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

  # A dynamic pseudo INSIDE a logical pseudo: the scoped query drops the whole qualifier (a
  # superset), so the flip still reaches the box it restyles.
  it 'relays out for a dynamic pseudo nested in :not()' do
    css = '#t { width: 200px } #t:not(:focus) { width: 50px }'
    s = simulated_session(gated_page('<div id="t" tabindex="0">x</div>', css: css))
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

  # A rule that writes only a custom property is scoped to its SUBJECT once an inline var()
  # consumer exists (a custom property can only reach the subject's subtree), not folded into
  # the epoch — the old escape valve relaid out the whole page per flip (Discourse: seven
  # `:hover { --text-color }` rules plus one inline `--composer-height: var(…)`).
  it 'scopes a custom-property-only rule to its subject, off the layout epoch' do
    css = '#t:focus { --w: 200px }'
    s = simulated_session(gated_page('<div id="t" tabindex="0" style="width: var(--w, 50px)">x</div>', css: css))
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

  # …and such a rule whose subject is ABSENT arms nothing: no epoch move and no dirtying sweep.
  it 'does not arm for a custom-property-only rule whose subject is absent' do
    css = '.absent:focus { --w: 200px }'
    s = simulated_session(gated_page('<div id="t" tabindex="0" style="width: var(--w, 50px)">x</div>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('t');
        t.getBoundingClientRect();
        const epoch = globalThis.__csimLayoutEpoch(), marks = globalThis.__csimSubtreeMarks();
        t.focus();
        t.getBoundingClientRect();
        return [globalThis.__csimLayoutEpoch() === epoch, globalThis.__csimSubtreeMarks() === marks];
      })()
    JS
    expect(got).to eq([true, true])
  end

  # The hinted sweep's two non-subject shapes: the state sits on an ANCESTOR compound (hover is
  # ancestor-matching, so the hovered element's chain is walked up to the one matching `.a`) and
  # on a preceding SIBLING (the subjects are queried under the parent). Both must still move the
  # box — and without moving the layout epoch.
  it 'reaches a subject below the compound that carries the state (hover on an ancestor)' do
    css = '.b { height: 20px } .a:hover .b { height: 200px }'
    s = simulated_session(gated_page('<div class="a"><div class="b" id="b">z</div></div><p id="after">after</p>', css: css))
    s.visit '/'
    before = s.evaluate_script("[document.getElementById('b').getBoundingClientRect().height, globalThis.__csimLayoutEpoch()]")
    s.find('#b').hover
    after = s.evaluate_script("[document.getElementById('b').getBoundingClientRect().height, globalThis.__csimLayoutEpoch()]")
    expect([before[0], after[0]]).to eq([20, 200])
    expect(after[1]).to eq(before[1])
  end

  it 'reaches a subject that follows the state-carrying compound as a sibling' do
    css = '#b { width: 20px } #a:focus ~ #b { width: 200px }'
    s = simulated_session(gated_page('<div><div id="a" tabindex="0">x</div><div id="b">y</div></div>', css: css))
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

  # State read RELATIONALLY — inside `:has()` — flips on an element the prefix cannot be asked
  # of (`.a:has(.b:focus)`: focus lands on `.b`, the compound is `.a`); the hinted sweep must
  # fall back to the whole selector for that kind.
  it 'reaches a subject whose state sits inside :has()' do
    css = '.c { height: 20px } .a:has(.b:focus) .c { height: 200px }'
    body = '<div class="a"><div class="b" tabindex="0">x</div><div class="c" id="c">y</div></div>'
    s = simulated_session(gated_page(body, css: css))
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
  # ANCESTOR named inside the logical pseudo, so the flipping element cannot be asked to match a
  # prefix — the kind is relational, and the hinted sweep queries the whole selector for it.
  it 'reaches a subject whose state sits on an ancestor inside :is()' do
    css = '.x { height: 20px } .x:is(:where(.group):hover *) { height: 200px }'
    s = simulated_session(gated_page('<div class="group"><span>title</span><div class="x" id="x">z</div></div>', css: css))
    s.visit '/'
    before = s.evaluate_script("document.getElementById('x').getBoundingClientRect().height")
    s.find('.group span').hover
    after = s.evaluate_script("document.getElementById('x').getBoundingClientRect().height")
    expect([before, after]).to eq([20, 200])
  end

  # The focused element leaving the tree is a flip the lazy diff cannot place (its ancestors and
  # siblings are gone from under it by the time it looks), so removal announces it with the
  # parent it left as the hint's root — a `:focus-within` sibling rule must un-apply.
  it 'un-applies a :focus-within rule when the focused element is removed' do
    css = '.s { height: 20px } .panel:focus-within .s { height: 200px }'
    s = simulated_session(gated_page('<div class="panel"><input id="i"><div class="s" id="s">y</div></div>', css: css))
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

  # The hinted sweep touches only the rules that read the kind that flipped: with a hover rule and
  # a focus rule both armed, a focus flip dirties exactly the focus rule's subject — one subtree
  # mark — where a full sweep over every dynamic rule would mark both.
  it 'sweeps only the rules that read the kind that flipped' do
    css = '.h:hover { padding: 10px } .f:focus { padding: 10px }'
    body = '<div class="h">hover me</div><div class="f" id="f" tabindex="0">focus me</div>'
    s = simulated_session(gated_page(body, css: css))
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
  # `:invalid` layout rule on it (and on its form) must un-apply on the checkedness hint.
  it 'relays out an :invalid rule when a required checkbox is checked' do
    css = '#c { height: 20px } #c:invalid { height: 60px } form:invalid { padding-bottom: 100px }'
    body = '<form id="fm"><input type="checkbox" id="c" required></form><p id="after">after</p>'
    s = simulated_session(gated_page(body, css: css))
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
    s = simulated_session(gated_page(body, css: css))
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

  # An `animation` declaration moves no box in this engine, so a dynamic rule that only animates
  # is paint-only: no epoch move, no dirtying.
  it 'does not relay out for a dynamic rule that only animates' do
    css = '#t:focus { animation: spin 1s linear infinite }'
    s = simulated_session(gated_page('<div id="t" tabindex="0">x</div><p id="after">after</p>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('t');
        t.getBoundingClientRect();
        const epoch = globalThis.__csimLayoutEpoch(), marks = globalThis.__csimSubtreeMarks();
        t.focus();
        t.getBoundingClientRect();
        return [globalThis.__csimLayoutEpoch() === epoch, globalThis.__csimSubtreeMarks() === marks];
      })()
    JS
    expect(got).to eq([true, true])
  end

  it 'hit-tests fresh z-index after focus, without a relayout in between' do
    # z-index is PAINT_ONLY, so a `:focus { z-index }` rule no longer forces a pass — the paint
    # order must come out right anyway. `stackChain` bakes an ANCESTOR stacking context's
    # `paintRank` (a z-index read) into a per-pass memo; the dynamic-rule taint bracket keeps a
    # chain that considered such a rule uncached, so the second hit-test re-reads it live
    # instead of replaying the pre-focus rank. Siblings compare their own ranks live, so the
    # rule has to sit on the CONTEXT-ESTABLISHING ancestor for this to bite.
    css = '#a, #b { position: absolute; left: 0; top: 0; width: 50px; height: 50px; z-index: 0 } ' \
          '#ac, #bc { position: absolute; left: 0; top: 0; width: 50px; height: 50px } ' \
          '#a:focus { z-index: 10 }'
    body = '<div id="a" tabindex="0"><div id="ac">a</div></div><div id="b"><div id="bc">b</div></div>'
    s = simulated_session(gated_page(body, css: css))
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

  it 're-arms the gate for a widget the STREAMING PARSER inserts after a mid-parse read' do
    # Parser insertions bypass the dirtySeq funnel (recordChildList is observer-gated), so the
    # armed memo carries its own parser-generation key. Without it, the inline script's read
    # memoises "unarmed" and the widget the rest of the page parses in never reopens the gate.
    body = '<script>document.documentElement.getBoundingClientRect();</script>' \
           '<div class="dd" tabindex="0"><div class="dd-content">content</div></div><p id="after">after</p>'
    s = simulated_session(gated_page(body))
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

  it 'disarms the gate again when the widget leaves' do
    body = '<div class="dd" tabindex="0"><div class="dd-content">content</div></div><input id="i"><p id="after">after</p>'
    s = simulated_session(gated_page(body))
    s.visit '/'
    moved = s.evaluate_script(<<~JS)
      (() => {
        document.querySelector('.dd').remove();
        document.getElementById('after').getBoundingClientRect();   // re-answer with the widget gone
        const before = globalThis.__csimLayoutEpoch();
        document.getElementById('i').focus();
        return globalThis.__csimLayoutEpoch() !== before;
      })()
    JS
    expect(moved).to be(false)
  end

  # ── the class-TOKEN layout gate ──────────────────────────────────────────────────────────────
  # A class write used to mark the whole subtree layout-dirty unconditionally. Now only a flipped
  # token that some box-moving rule mentions does; a paint-utility flip or a same-set rewrite
  # keeps every descendant's box memo. `__csimSubtreeMarks` is the observable for the "kept"
  # side — geometry cannot distinguish a surviving memo from an equal recompute.

  it 'relays out a descendant when a container gains a class a descendant rule reads' do
    css = '.panel { height: 20px } .open .panel { height: 120px }'
    s = simulated_session(gated_page('<div id="c"><div><div class="panel" id="p">x</div></div></div>', css: css))
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
    # The collection descends into `:not` / `:is`: skipping nested identifiers is permissive for
    # the presence gate but STALE for invalidation — 'off' must be in the token set.
    # The target sits TWO levels down: a direct child would be healed by the parent's own
    # usedSize re-read, and the spec would pass without the subtree mark it exists to pin.
    css = '.kid { height: 20px } .wrap:not(.off) .kid { height: 120px }'
    s = simulated_session(gated_page('<div class="wrap off" id="c"><div><div class="kid" id="k">x</div></div></div>', css: css))
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

  it 'keeps descendant layout memos across a paint-only class flip' do
    css = '.panel { height: 20px } .red { color: rgb(255, 0, 0) }'
    s = simulated_session(gated_page('<div id="c"><div class="panel" id="p">x</div></div>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        document.getElementById('p').getBoundingClientRect();
        const marks = globalThis.__csimSubtreeMarks();
        const c = document.getElementById('c');
        c.classList.add('red');
        c.className = c.className;                          // same-string rewrite
        c.className = 'red ';                               // same token set, reserialized
        const h = document.getElementById('p').getBoundingClientRect().height;
        return [globalThis.__csimSubtreeMarks() - marks, h, getComputedStyle(c).color];
      })()
    JS
    expect(got).to eq([0, 20, 'rgb(255, 0, 0)'])
  end

  it 'stays conservative when a literal [class="…"] layout rule exists' do
    # The one selector shape that can see serialization order makes the gate ungateable.
    css = 'div { height: 20px } [class="a b"] { height: 120px }'
    s = simulated_session(gated_page('<div class="a b" id="p">x</div>', css: css))
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
    expect(got[0]).to eq(120)
    expect(got[2]).to be(true)
  end

  # A `[class^=…]` rule reads the class ATTRIBUTE, with a value condition the layout gate carries (`attrWriteMatters`):
  # a write that satisfies it before or after moves the element's box; one that satisfies it neither time moves nothing.
  # (The class-token gate this replaced could not place the shape and marked the writer's subtree on every class write.)
  it 'marks a class write by the [class^=…] rule it can flip, and not otherwise' do
    css = '[class^="col-"] { width: 50px } .panel { height: 20px }'
    s = simulated_session(gated_page('<div id="c"><div class="panel" id="p">x</div></div>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const c = document.getElementById('c');
        c.getBoundingClientRect();
        const m0 = globalThis.__csimSubtreeMarks();
        c.classList.add('unrelated');
        const m1 = globalThis.__csimSubtreeMarks();
        c.className = 'col-x';
        return [m1 - m0, globalThis.__csimSubtreeMarks() > m1, c.getBoundingClientRect().width];
      })()
    JS
    expect(got).to eq([0, true, 50])
  end

  it 'relays out descendants of a subject-position box-property flip' do
    # Subject-position tokens take the SUBTREE mark even for pure box properties: a heal through
    # the parent's relayout looked sufficient, but an abspos descendant anchored to the subject's
    # containing block escapes it (see ruleMovesBoxes) — so the classification stays conservative.
    css = '.box { width: 100px } .box.wide { width: 200px } .half { width: 50% }'
    body = '<div class="box" id="c"><div class="half"><div class="half" id="g">x</div></div></div>'
    s = simulated_session(gated_page(body, css: css))
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
    # The case that demoted SELF: the anchor's placement only reruns inside a relayouted
    # ancestor, and the intermediate auto-height element would otherwise reuse.
    css = '.box { position: relative; height: 200px } .box.tall { height: 400px }'
    body = '<div class="box" id="c"><div><div style="position: absolute; bottom: 0; height: 10px" id="a">x</div></div></div>'
    s = simulated_session(gated_page(body, css: css))
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
  # Unlike the document-wide gates further up, this one is asked about ONE ELEMENT — so it does not
  # need to know what the shadow sheets declare, only whether a class written on THIS element can
  # change what any of them matches (`shadowRulesMayReach`). Keyed on the host COUNT instead, a
  # single widget cost every light-DOM class write on the page the subtree mark: on the perf gate's
  # 400-row table that was HALF the page's subtree reuse (`reuse_hit` 602 against 1200 for the
  # identical page without the host), which the wall could not see.
  #
  # The examples below are the ways a shadow sheet crosses its boundary, and then the queue that has
  # to carry a LATE sheet to the fold. **`__csimSubtreeMarks` is the only observable that pins the
  # gate itself**: `reuseSubtree` refuses a subtree holding an escaping abspos or a changed
  # containing block on its own, so geometry heals every one of these shapes either way. Where a
  # geometry assertion appears beside the count it pins the MATCHING, not the gate; where none
  # appears the rule either does not match here yet (`:host(.x) .y`) or does not turn on the class
  # being written (`::part()`), and the count is the whole test.

  it 'stays conservative for a class write INSIDE a shadow tree' do
    # A shadow tree's in-tree rules are in no document index, and the document's own rules do not
    # reach the element either — so the token gate describes nothing about it.
    s = simulated_session(gated_page('<div id="h"></div>', css: '.noop-rule { width: 1px }'))
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

  it "keeps a light-DOM element's memos across a paint-only flip beside a shadow host" do
    # The win: the widget's sheet cannot match `#c` or anything under it, so the class write is the
    # same question it would be on a page with no shadow root at all.
    css  = '.panel { height: 20px } .red { color: rgb(255, 0, 0) }'
    body = '<div id="h"></div><div id="c"><div class="panel" id="p">x</div></div>'
    s    = simulated_session(gated_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        document.getElementById('h').attachShadow({mode: 'open'}).innerHTML =
          '<style>.p { color: #333; padding: 2px }</style><p class="p">widget</p>';
        const p = document.getElementById('p');
        p.getBoundingClientRect();
        const marks = globalThis.__csimSubtreeMarks();
        document.getElementById('c').classList.add('red');
        return [globalThis.__csimSubtreeMarks() - marks, p.getBoundingClientRect().height];
      })()
    JS
    expect(got).to eq([0, 20])
  end

  it 'stays conservative for a light child a ::slotted rule can style' do
    # `::slotted(.x)` is written in a shadow sheet and styles a LIGHT child of the host — an element
    # the document's token gate otherwise answers for completely.
    css  = '.red { color: rgb(255, 0, 0) }'
    body = '<div id="h"><div id="c"><div id="p">x</div></div></div>'
    s    = simulated_session(gated_page(body, css: css))
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

  it 'stays conservative for a class write on a host its own tree styles' do
    # `:host(.x)` is the mirror of `::slotted`: written inside the tree, matching the host, which
    # lives in the document scope. The tree carries NO bare `:host` rule on purpose — one would
    # fill the routed host bucket by itself and the example would pass without `:host(` doing
    # anything. And the answer comes off the sheet's TEXT rather than that bucket precisely so the
    # `:host(.x) .y` form, which `scopedRulesFor` leaves in-tree and which does not match here yet,
    # cannot silently make this unsound the day it starts matching.
    # (The document's base rule is a CLASS, not `#h`: an ID would out-specify `:host(.red)` and the
    # height would never move.)
    css  = '.hostbase { display: block; height: 20px } .red { color: rgb(255, 0, 0) }'
    s    = simulated_session(gated_page('<div id="h" class="hostbase"></div>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const h = document.getElementById('h');
        h.attachShadow({mode: 'open'}).innerHTML =
          '<style>:host(.red) { height: 120px }</style><p>w</p>';
        h.getBoundingClientRect();
        const marks = globalThis.__csimSubtreeMarks();
        h.classList.add('red');
        return [globalThis.__csimSubtreeMarks() - marks, h.getBoundingClientRect().height];
      })()
    JS
    expect(got).to eq([1, 120])
  end

  it 'stays conservative for a host whose tree only uses the :host(.x) COMBINATOR form' do
    # The landmine the sheet-text answer defuses. `scopedRulesFor`'s routing sends only the
    # STANDALONE `:host(.x)` to the host bucket; `:host(.x) .y` stays an in-tree rule, where it
    # fails to match at all today (`shadow_dom_cascade_gaps`). A bucket-shaped answer would call
    # this host unreachable — correct only for as long as that bug stays unfixed, and nothing here
    # would go red the day it is. There is no geometry to assert for the same reason: the count is
    # the whole test.
    css  = '.red { color: rgb(255, 0, 0) }'
    s    = simulated_session(gated_page('<div id="h"></div>', css: css))
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

  it 'stays conservative for the whole page while a ::part() rule exists' do
    # `::part()` and `:host-context()` are decided by an element the rule is not indexed against, so
    # no per-element question can answer for them and `shadowUnsafe` latches the page instead — the
    # same latch `ctxGateReady` reads. The class write here is on an element as far from the host as
    # the page allows, which is the point: the answer is the PAGE's, not this element's.
    #
    # The rule lives in the DOCUMENT sheet, where a real `::part()` lives — that half of the latch is
    # a scan of `state.layoutRules` keyed on `cascadeVersion`, a different invalidation story from
    # the per-sheet flag, and the shadow-sheet half is already pinned by the `:host-context()` route
    # of the late-arrival example below (same field, same code path).
    css  = '.panel { height: 20px } .red { color: rgb(255, 0, 0) } #h::part(p) { height: 120px }'
    body = '<div id="h"></div><div id="c"><div class="panel" id="p">x</div></div>'
    s    = simulated_session(gated_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        document.getElementById('h').attachShadow({mode: 'open'}).innerHTML =
          '<style>.p { color: #333 }</style><p class="p" part="p">w</p>';
        const p = document.getElementById('p');
        p.getBoundingClientRect();
        const marks = globalThis.__csimSubtreeMarks();
        document.getElementById('c').classList.add('red');
        return globalThis.__csimSubtreeMarks() - marks;
      })()
    JS
    expect(got).to eq(1)
  end

  it 'folds a shadow sheet that arrives AFTER the tree was first folded' do
    # The hole the per-element answer opens, and the reason `stylesheetChanged` and the
    # `adoptedStyleSheets` hook re-queue the root: `shadowSheetFacts` folds a tree once and re-folds
    # only what the queue hands it, so a sheet edited or inserted after the first fold reached none
    # of the gates its rules arm. The old host-COUNT bail was immune to that; this one is not, and
    # `ctxGateReady` — which reads the same `shadowUnsafe` latch — was already exposed to it, which
    # is why the observable here is that gate rather than a subtree mark.
    #
    # Two things contaminate a naive version of this example, and the control (a late sheet with
    # nothing the latch cares about, which must leave the gate ACTIVE) is what catches both:
    #   - writing `.textContent` on a DETACHED `<style>`, or `replaceSync` on a constructed sheet,
    #     calls `scheduleCascadeRefresh` — `cascadeStale` then shuts every gate for a reason that
    #     has nothing to do with folding. The document-scope read below clears it without going
    #     near the shadow tree;
    #   - nothing may read STYLE inside the tree between the arrival and the observation: such a
    #     read rebuilds `scopedRulesFor`, which re-queues the root ITSELF, and the example would
    #     pass with both queue pushes removed.
    body     = '<div id="h"></div><div id="c"><div class="panel" id="p">x</div></div>'
    rules    = {
      harmful:  ':host-context(.red) .p { height: 120px }',    # the latch's own selector
      harmless: '.p { height: 120px }'
    }
    arrivals = {
      'edited <style> text' => ->(css) { "sr.getElementById('s').textContent = #{css};" },
      'appended <style>'    => ->(css) { "const st = document.createElement('style'); sr.appendChild(st); st.textContent = #{css};" },
      'adoptedStyleSheets'  => ->(css) { "const sheet = new CSSStyleSheet(); sheet.replaceSync(#{css}); sr.adoptedStyleSheets = [sheet];" }
    }
    got = arrivals.transform_values {|arrival|
      rules.transform_values {|rule|
        with_simulated_session(gated_page(body, css: '.panel { height: 20px }')) {|s|
          s.visit '/'
          s.evaluate_script(<<~JS)
            (() => {
              const sr = document.getElementById('h').attachShadow({mode: 'open'});
              sr.innerHTML = '<style id="s">.p { color: #333 }</style><p class="p">w</p>';
              document.getElementById('p').getBoundingClientRect();   // folds the tree as it is now
              #{arrival.call(rule.to_json)}
              getComputedStyle(document.body).color;                  // clears cascadeStale, tree untouched
              return globalThis.__csimCtxGateActive();
            })()
          JS
        }
      }
    }
    expect(got).to eq(arrivals.transform_values { {harmful: false, harmless: true} })
  end

  it 'arms the :host() answer from a late sheet too, which the gate above cannot see' do
    # The queue carries more than the `shadowUnsafe` latch — `shadowHostFn` and `shadowSlotted` ride
    # it as well, and `__csimCtxGateActive` reads only the latch. Without this example, gating the
    # queue push on `::part(` / `:host-context(` would read as a safe optimisation and would stop
    # arming `:host(` with nothing going red.
    body  = '<div id="h"></div>'
    rules = {harmful: ':host(.red) { height: 120px }', harmless: '.q { height: 120px }'}
    got   = rules.transform_values {|rule|
      with_simulated_session(gated_page(body, css: '.red { color: rgb(255, 0, 0) }')) {|s|
        s.visit '/'
        s.evaluate_script(<<~JS)
          (() => {
            const h  = document.getElementById('h');
            const sr = h.attachShadow({mode: 'open'});
            sr.innerHTML = '<style id="s">.p { color: #333 }</style><p class="p">w</p>';
            h.getBoundingClientRect();                             // folds the tree as it is now
            sr.getElementById('s').textContent = #{rule.to_json};
            getComputedStyle(document.body).color;                 // clears cascadeStale, tree untouched
            const marks = globalThis.__csimSubtreeMarks();
            h.classList.add('red');
            return globalThis.__csimSubtreeMarks() - marks;
          })()
        JS
      }
    }
    expect(got).to eq({harmful: 1, harmless: 0})
  end

  it 'keeps relaying out when a custom-prop rule feeds an inline var() consumer' do
    # The rule's custom property is unreachable from the sheets; the inline consumer is sighted
    # only at first layout — after the gate was built — so the token carries a VAR bit resolved
    # against the sticky flag at write time.
    css = '.on { --h: 300px }'
    body = '<div id="c"><div><div style="height: var(--h, 50px)" id="g">x</div></div></div>'
    s = simulated_session(gated_page(body, css: css))
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

  it 'scopes token REMOVAL through the DESC path too' do
    css = '.host { height: 20px } body.chrome-x .host { height: 120px }'
    body = '<div class="host" id="h">x</div>'
    s = simulated_session(gated_page(body, css: css))
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

  it 'keeps the subtree mark for a subject flip declaring an inherited property' do
    css = '.big-text { font-size: 32px }'
    body = '<div id="c"><div><div id="g">word</div></div></div>'
    s = simulated_session(gated_page(body, css: css))
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

  it 'scopes a non-subject flip on <body> to the matching subjects' do
    # The os-pc shape: widget CSS mentions a body-level class in ancestor position; stamping it
    # must not cost the whole page its layout memos — exactly one subject takes the subtree mark.
    css = '.host { height: 20px } body.chrome-x .host { height: 120px }'
    body = '<div id="other"><div>quiet</div></div><div class="host" id="h">x</div>'
    s = simulated_session(gated_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const h = document.getElementById('h');
        const before = h.getBoundingClientRect().height;
        const marks = globalThis.__csimSubtreeMarks();
        document.body.classList.add('chrome-x');
        return [before, h.getBoundingClientRect().height, globalThis.__csimSubtreeMarks() - marks];
      })()
    JS
    expect(got).to eq([20, 120, 1])
  end

  it 'reaches a later sibling INTERIOR through a sibling-combinator rule' do
    # Scope for `~` is the writer's PARENT: the affected subject is not inside the writer's
    # subtree. The stale case is the sibling's INTERIOR — an inherited property two levels down,
    # where the parent's own re-derivation of the sibling's box cannot heal (main previously
    # left the grandchild's text at the old font-size).
    css = '.a ~ .b { font-size: 32px }'
    body = '<div id="first">x</div><div class="b"><div><div id="deep">word</div></div></div>'
    s = simulated_session(gated_page(body, css: css))
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

  # ── scoped dynamic-state dirtying ────────────────────────────────────────────────────────────
  # An ARMED dynamic layout rule used to put the style-state generation into the layout epoch:
  # every focus/hover/checked flip killed every box memo on the page. Now the flip dirties
  # exactly the armed rules' subject matches (at ensureLayout entry), and the epoch stays still.

  it 'keeps the epoch still on an ARMED page: a state flip dirties only the subjects' do
    body = '<div class="dd" tabindex="0"><div class="dd-content">content</div></div>' \
           '<div id="far"><div><div>quiet</div></div></div><p id="after">after</p>'
    s = simulated_session(gated_page(body))
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
    # The scoped marks carry `structural=true` for display/visibility rules: the grid memo
    # (structFresh) keys on the epoch this path deliberately keeps still.
    css = '.toggle:checked ~ table .maybe-row { display: none }'
    body = '<input type="checkbox" class="toggle" id="t">' \
           '<table><tbody><tr class="maybe-row"><td>a</td></tr><tr><td id="keep">b</td></tr></tbody></table>'
    s = simulated_session(gated_page(body, css: css))
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
    # The IO recheck early-returns on layoutGeneration(); the scoped marks move neither
    # settleGen nor the epoch, so the generation carries the dirty sequence too.
    s = simulated_session(gated_page('<div class="dd" tabindex="0"><div class="dd-content" id="c">content</div></div>'))
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

  it 'queries Tailwind-style colon classes safely from both scoped paths' do
    # The subject key is fed to querySelectorAll: an unescaped `checked:block` parses as a
    # pseudo-class and THREW from inside the sweep (and from a class write's DESC path).
    css = '.toggle:checked ~ .checked\\:block { display: block } ' \
          '.checked\\:block { display: none } ' \
          'body.mode-x .peer\\:pane { height: 120px } .peer\\:pane { height: 20px }'
    body = '<input type="checkbox" class="toggle" id="t">' \
           '<div class="checked:block" id="rev">revealed</div>' \
           '<div class="peer:pane" id="pane">x</div>'
    s = simulated_session(gated_page(body, css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const rev = document.getElementById('rev');
        const pane = document.getElementById('pane');
        document.getElementById('t').checked = true;              // scoped state sweep
        const revealed = rev.getBoundingClientRect().height > 0;
        document.body.classList.add('mode-x');                    // class-write DESC path
        return [revealed, pane.getBoundingClientRect().height];
      })()
    JS
    expect(got).to eq([true, 120])
  end

  it 'relays out for a checkedness flip from the CLICK path too' do
    # The style-state bump lives in setCheckedness — the funnel every checkedness writer
    # shares. Bumping only in the IDL setter left a plain el.click() with stale geometry.
    css = 'input:checked { height: 100px }'
    body = '<input type="checkbox" id="t"><p id="after">after</p>'
    s = simulated_session(gated_page(body, css: css))
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

  it 'falls back to the epoch for a keyless dynamic subject' do
    css = '.dd:focus-within > * { margin-top: 100px }'
    body = '<div class="dd" tabindex="0"><div id="k">x</div></div>'
    s = simulated_session(gated_page(body, css: css))
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

  it 'extracts a subject per selector GROUP for the scoped path' do
    css = '.never:hover .x { width: 1px } .dd:focus-within .dd-content { display: block }'
    body = '<div class="dd" tabindex="0"><div class="dd-content">content</div></div><p id="after">after</p>'
    s = simulated_session(gated_page(body, css: "#{css} .dd-content { display: none }"))
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

  it 'relays out a :target rule on a fragment navigation' do
    css = '#t { height: 20px } #t:target { height: 120px }'
    s = simulated_session(gated_page('<div id="t">x</div><p id="after">after</p>', css: css))
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
    # Style reads under a dynamic rule are taint-uncached and always fresh — the STALE layer is
    # layout: the select's box memo keys on the epoch, which only the selectedness funnel's
    # style-state bump moves.
    css = 'select { height: 20px } select:has(option:checked[value="b"]) { height: 120px }'
    body = '<select id="s"><option value="a">a</option><option value="b">b</option></select><p id="after">after</p>'
    s = simulated_session(gated_page(body, css: css))
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
    s = simulated_session(gated_page(body, css: css))
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

  it 'drops :modal styling on show() after showModal()' do
    # `:modal` is internal state: with `open` already set, show()'s setAttribute is
    # value-identical and nothing else said the state flipped.
    css = '#t { height: 20px } #t:modal { height: 120px }'
    s = simulated_session(gated_page('<dialog id="t">x</dialog>', css: css))
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('t');
        t.showModal();
        const modal = t.getBoundingClientRect().height;
        t.show();
        return [modal, t.getBoundingClientRect().height];
      })()
    JS
    expect(got).to eq([120, 20])
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
