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
  # 300px after the field was filled. Chrome 151, same page: 300 then 100.
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
    expect([before, s.evaluate_script(read)]).to eq([300, 100])
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
    expect([filled, s.evaluate_script(read)]).to eq([100, 300])
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

  # KNOWN GAPS, all pre-existing — each measured identically on the commit before any of this work,
  # so none is an invalidation bug:
  #   * `:user-invalid` / `:user-valid` don't respond to `reportValidity()` (the user-interacted
  #     flag isn't modelled);
  #   * `:selected` can't be cleared on a single-selection `<select>` — deselecting its only
  #     selected option re-selects one, per the selectedness rules;
  #   * clicking an INDETERMINATE checkbox doesn't clear `indeterminate`, where Chrome does.
  # All three belong to the form-state model, not to invalidation.
end
