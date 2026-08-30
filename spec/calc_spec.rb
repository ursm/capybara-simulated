require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# CSS math functions. Every expectation is real Chrome's, read off the same declarations with
# `--headless --dump-dom` at 1024x768 with a 16px root font.
#
# A math function that RESOLVES collapses to a plain value — `calc(10px + 5px)` computes to `15px`,
# not to `calc(15px)`. All of these reported '' before, which is the "we can't know" answer for
# something a browser knows exactly.
RSpec.describe 'CSS math functions' do
  def computed(decls, props, extra_css: '', selector: '#t')
    html = <<~HTML
      <!DOCTYPE html>
      <html><head><style>:root { --gap: 8px } #{extra_css} #t { #{decls} }</style></head>
      <body><div id="t"></div></body></html>
    HTML
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [html]] }
    with_simulated_session(app) {|s|
      s.visit '/'
      s.evaluate_script("(() => { const c = getComputedStyle(document.querySelector('#{selector}')); return #{props.inspect}.map(p => c[p]); })()")
    }
  end

  it 'reduces an arithmetic expression to a single length' do
    expect(computed('margin-left: calc(10px + 5px)', %w[marginLeft])).to eq(['15px'])
    expect(computed('margin-left: calc(10px * 3)',   %w[marginLeft])).to eq(['30px'])
    expect(computed('margin-left: calc(10px/4)',     %w[marginLeft])).to eq(['2.5px'])
    expect(computed('margin-left: calc(10px + 2 * (3px + 1px))', %w[marginLeft])).to eq(['18px'])
  end

  it 'resolves font- and viewport-relative terms before combining them' do
    expect(computed('font-size: 16px; margin-left: calc(2em + 4px)', %w[marginLeft])).to eq(['36px'])
    # The em is the element's OWN font-size, so a larger one moves the result.
    expect(computed('font-size: 20px; margin-left: calc(2em + 4px)', %w[marginLeft])).to eq(['44px'])
  end

  it 'runs after substitution, so a token can supply a term' do
    expect(computed('margin-left: calc(var(--gap) * 2)', %w[marginLeft])).to eq(['16px'])
  end

  it 'evaluates min, max and clamp' do
    expect(computed('margin-left: min(10px, 20px)', %w[marginLeft])).to eq(['10px'])
    expect(computed('font-size: 16px; margin-left: max(10px, 2em)', %w[marginLeft])).to eq(['32px'])
    expect(computed('font-size: 16px; margin-left: clamp(5px, 3em, 40px)', %w[marginLeft])).to eq(['40px'])
  end

  it 'treats units case-insensitively and ignores surrounding space' do
    expect(computed('margin-left: calc(10PX + 5Px)',   %w[marginLeft])).to eq(['15px'])
    expect(computed('margin-left: calc( 10px  +  5px )', %w[marginLeft])).to eq(['15px'])
  end

  it 'drops the declaration when the expression is type-invalid' do
    # `length + number` has no meaning, so the whole declaration is invalid and the property falls
    # to its initial — Chrome reports `0px`, not the author's text and not ''.
    expect(computed('margin-left: calc(1px + 1)', %w[marginLeft])).to eq(['0px'])
  end

  it 'reduces every component of a shorthand independently' do
    expect(computed('padding: calc(2px + 3px) calc(1px + 1px)', %w[paddingTop paddingRight]))
      .to eq(['5px', '2px'])
  end

  it 'resolves a percentage expression at layout, where the basis exists' do
    # A percentage needs a per-property basis the COMPUTED stage doesn't have — so the
    # expression survives to layout, which does, and the resolved value is the used one.
    # Written against the basis measured in the page (the body's content width, since
    # the UA margin makes it narrower than the viewport) rather than a copied figure:
    # Chrome 151 resolves both the same way on the same fixture.
    basis = computed('', %w[width], selector: 'body').first.to_f
    px = ->(n) { "#{n.to_i == n ? n.to_i : n}px" }
    expect(computed('margin-left: calc(100% - 10px)', %w[marginLeft])).to eq([px[basis - 10]])
    expect(computed('width: calc(50% + 10px)',        %w[width])).to eq([px[(basis / 2) + 10]])
  end

  # The cases below were all invisible to the table above, which only exercised length math on
  # non-`font-size` properties with a well-ordered clamp. Each was a real defect.

  it 'resolves a math function IN font-size, against the parent size' do
    # `em` on `font-size` means the INHERITED size, so resolving it against the element's own
    # font-size recursed until the stack blew — `getComputedStyle` threw outright, taking the layout
    # pass with it. `font-size: clamp(...)` is ordinary responsive typography.
    expect(computed('font-size: calc(10px + 5px)', %w[fontSize])).to eq(['15px'])
    expect(computed('font-size: calc(1rem + 2px)', %w[fontSize])).to eq(['18px'])
    expect(computed('font-size: min(20px, 30px)',  %w[fontSize])).to eq(['20px'])
    expect(computed('font-size: calc(2em + 1px)',  %w[fontSize], extra_css: 'body { font-size: 20px }'))
      .to eq(['41px'])
  end

  it 'keeps each dimension apart instead of treating every unit as a length' do
    # A driver that converts blindly answers `calc(1s + 500ms)` with `501px`.
    expect(computed('transition-duration: calc(1s + 500ms)', %w[transitionDuration])).to eq(['1.5s'])
    expect(computed('transform: rotate(calc(10deg + 20deg))', %w[transform]))
      .to eq(['matrix(0.866025, 0.5, -0.5, 0.866025, 0, 0)'])
    # Mixing dimensions is a type error, so the declaration is dropped.
    expect(computed('margin-left: calc(10deg + 5px)', %w[marginLeft])).to eq(['0px'])
  end

  it 'treats the dynamic viewport units as the viewport' do
    # There is no browser chrome to retract here, so `dvh` is `vh`. Reading them as unitless numbers
    # made `calc(100dvh - 50px)` come out as `50px` — and that went straight into layout.
    expect(computed('height: calc(100dvh - 50px)', %w[height])).to eq(['718px'])
    expect(computed('height: calc(100vh - 50px)',  %w[height])).to eq(['718px'])
  end

  it 'lets clamp MIN win over MAX' do
    # `clamp(MIN, VAL, MAX)` is `max(MIN, min(VAL, MAX))`, which is deliberately asymmetric: an
    # inverted pair (two `var()` tokens a theme override crosses) resolves to MIN, not MAX.
    expect(computed('margin-left: clamp(40px, 10px, 20px)', %w[marginLeft])).to eq(['40px'])
    expect(computed('margin-left: clamp(5px, 10px, 20px)',  %w[marginLeft])).to eq(['10px'])
  end

  it 'drops an invalid declaration so the next one in the cascade wins' do
    # An invalid math function is a PARSE error: the declaration never enters the cascade. Resolving
    # it and reporting the property's INITIAL instead skipped the loser entirely — Chrome measured
    # `7px` here, where reporting the initial gives `0px`.
    expect(computed('margin-left: calc(1px + 1)', %w[marginLeft], extra_css: 'div { margin-left: 7px }'))
      .to eq(['7px'])
  end

  it 'reduces a math function in place, leaving the value structure alone' do
    # A property value is not one expression: the `/` in `aspect-ratio` is a separator, and
    # `background-position` has two components. Parsing the whole value as one sum ate both.
    expect(computed('aspect-ratio: calc(1 + 1) / 2', %w[aspectRatio])).to eq(['2 / 2'])
    expect(computed('background-position: calc(10px + 5px) 0', %w[backgroundPosition]))
      .to eq(['15px 0px'])
  end

  it 'resolves rem inside the ROOT font-size against the initial size' do
    # `rem` normally reads the root's computed font-size — but while resolving the ROOT's own
    # `font-size` that re-enters this resolver forever, and `html { font-size: calc(1rem + 1vw) }`
    # is the fluid-typography idiom. Per spec it is the INITIAL 16px there (Chrome measured: 18px).
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'},
       ['<!DOCTYPE html><html><head><style>html { font-size: calc(1rem + 2px) }</style></head>' \
        '<body></body></html>']]
    }
    s = simulated_session(app)
    s.visit '/'
    expect(s.evaluate_script('getComputedStyle(document.documentElement).fontSize')).to eq('18px')
  end

  it 'never reduces a math function inside a quoted string' do
    # A math function is only a math function in VALUE syntax. Rewriting one inside a string changed
    # the text a page displays, and — worse — a type error inside a string made the STATIC check drop
    # the whole declaration. Chrome keeps both verbatim.
    expect(computed('content: "calc(1px + 2px)"', %w[content])).to eq(['"calc(1px + 2px)"'])
    expect(computed("font-family: 'calc(1px + 1)'", %w[fontFamily])).to eq(['"calc(1px + 1)"'])
  end

  it 'clamps a negative result where the property cannot be negative' do
    # `width: calc(50vw - 800px)` is `0px` in Chrome, not `-288px` — and a negative used width
    # propagates into scrollWidth, hit-testing and the geometry `visible?` reads. `margin` is
    # deliberately NOT clamped: it may be negative.
    expect(computed('width: calc(50vw - 800px)', %w[width])).to eq(['0px'])
    expect(computed('margin-left: calc(10px - 30px)', %w[marginLeft])).to eq(['-20px'])
  end

  it 'agrees between the CSSOM setter and the cascade about invalid math' do
    # A statically-invalid math function is a parse error, so the assignment is IGNORED — Chrome
    # leaves the property at '' and writes no attribute. The cascade already dropped it; a page that
    # writes a computed `calc()` and reads it back to see whether it applied needs the same answer
    # from both surfaces.
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] }
    s = simulated_session(app)
    s.visit '/'
    expect(s.evaluate_script(<<~JS)).to eq(['', nil])
      (() => {
        const d = document.createElement('div');
        d.style.marginLeft = 'calc(1px + 1)';
        return [d.style.marginLeft, d.getAttribute('style')];
      })()
    JS
  end

  it 'keeps a declaration it cannot reduce rather than dropping it' do
    # Two CONSERVATIVE divergences, both deliberate. Division by zero is infinity in CSS, not a
    # type error — calling it invalid dropped the declaration and handed the cascade to a lower
    # one, which is the bug that mattered. An unknown UNIT is kept for the same reason: this table
    # has no `lh` / `cqw` / `ic`, so rejecting what it doesn't list would drop real CSS.
    #
    # Both now report the USED margin the box ended up with, which for a value layout can't make a
    # length of is `0px` — where Chrome clamps the infinity to `3.35544e+07px` and agrees on the
    # `0px` for the unknown unit. The remaining divergence is that one clamp.
    expect(computed('margin-left: calc(10px / 0)', %w[marginLeft], extra_css: 'div { margin-left: 7px }'))
      .to eq(['0px'])
    expect(computed('margin-left: calc(1toString + 2px)', %w[marginLeft])).to eq(['0px'])
  end

  it 'agrees across ALL the CSSOM write surfaces about invalid math' do
    # Three ways to write a declaration, one answer. The per-property setter, the block parse
    # (`cssText` / `setAttribute`) and the cascade each judge it, and the check had only reached the
    # first — so `style.marginLeft = …` was ignored while `style.cssText = …` stored it. Every
    # expectation below is Chrome's, measured.
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] }
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const mk = () => document.createElement('div');
        const a = mk(); a.style.marginLeft = 'calc(1px + 1)';
        const b = mk(); b.style.cssText = 'margin-left: calc(1px + 1)';
        const c = mk(); c.setAttribute('style', 'margin-left: calc(1px + 1); color: red');
        return [[a.style.marginLeft, a.getAttribute('style')],
                [b.style.marginLeft, b.getAttribute('style')],
                [c.style.marginLeft, c.style.color, c.getAttribute('style')]];
      })()
    JS
    expect(got).to eq([['', nil],
                       ['', ''],
                       # The ATTRIBUTE is the author's text and is never rewritten; only the parsed
                       # block drops the invalid declaration, so the sibling survives.
                       ['', 'red', 'margin-left: calc(1px + 1); color: red']])
  end

  it 'does not judge a CUSTOM property or a substitution fallback by math validity' do
    # A custom property's value is `<declaration-value>` — any token sequence, with no grammar to be
    # invalid against — and the inner `calc(` of a `var()` FALLBACK is only reached down one path.
    # Rejecting either dropped a declaration Chrome stores (both measured).
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] }
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const a = document.createElement('div');
        a.style.setProperty('--x', 'calc(1px + 1)');
        const b = document.createElement('div');
        b.style.width = 'var(--w, calc(1px + 1))';
        return [[a.style.getPropertyValue('--x'), a.getAttribute('style')],
                [b.style.width, b.getAttribute('style')]];
      })()
    JS
    expect(got).to eq([['calc(1px + 1)', '--x: calc(1px + 1);'],
                       ['var(--w, calc(1px + 1))', 'width: var(--w, calc(1px + 1));']])
  end

  it 'never rewrites a negative literal inside an expression it could not reduce' do
    # The non-negative clamp is for a RESULT. Applied to text, it rewrote a negative term inside an
    # expression that stayed unresolved and changed what the expression means — `calc(100% -
    # var(--x))` with `--x: -10px` became `calc(100% - 0px)`, i.e. plain `100%`.
    #
    # A leftover mixture of a length and a percentage HAS a canonical computed form — the
    # percentage first, a negative length subtracted — and a value that is only that mixture takes
    # it (Chrome-measured: `calc(-10px + 100%)` computes to `calc(100% - 10px)`). A value with more
    # in it than the mixture is still handed back as the substitution wrote it: same expression,
    # different spelling, and simplifying an arbitrary unresolved calc is a separate open gap.
    expect(computed('background-size: calc(100% - var(--neg))', %w[backgroundSize],
                    extra_css: ':root { --neg: -10px }')).to eq(['calc(100% - -10px)'])
    expect(computed('flex-basis: calc(-10px + 100%)', %w[flexBasis])).to eq(['calc(100% - 10px)'])
  end

  it 'keeps the calc() wrapper on the SPECIFIED surface, with its contents reduced' do
    # Not the computed surface, which reduces to a plain value. Chrome keeps the WRAPPER here and
    # simplifies inside it, and only for ABSOLUTE units — there is no element at this stage, so a
    # font- or viewport-relative term is left exactly as written. Every string below is Chrome's.
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body><div id="x" ' \
        'style="margin-left: min(10px, 20px); margin-right: calc(2em + 4px); ' \
        'margin-top: calc(100% + 10px); padding: clamp(1px, 5px, 9px)"></div></body></html>']]
    }
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const x = document.getElementById('x');
        x.style.color = 'red';                       // an unrelated write re-serializes the block
        return [[x.style.marginLeft, x.style.marginRight, x.style.marginTop, x.style.padding],
                x.getAttribute('style')];
      })()
    JS
    expect(got).to eq([
      ['calc(10px)', 'calc(2em + 4px)', 'calc(100% + 10px)', 'calc(5px)'],
      'margin-left: calc(10px); margin-right: calc(2em + 4px); ' \
      'margin-top: calc(100% + 10px); padding: calc(5px); color: red;'
    ])
  end

  it 'reduces the specified value identically from both write surfaces' do
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] }
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const a = document.createElement('div'); a.style.borderRadius = 'calc(10px + 5px)';
        const b = document.createElement('div'); b.style.cssText = 'border-radius: calc(10px + 5px)';
        return [a.style.borderRadius, b.style.borderRadius];
      })()
    JS
    expect(got).to eq(['calc(15px)', 'calc(15px)'])
  end

  it 'hands a custom property back unreduced' do
    # An unregistered custom property's computed value is a TOKEN SEQUENCE — Chrome does not
    # evaluate it, exactly as it does not canonicalise `.5px` or `url(a.png)` there.
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'},
       ['<!DOCTYPE html><html><head><style>#t { --x: calc(1px + 1px) }</style></head>' \
        '<body><div id="t"></div></body></html>']]
    }
    s = simulated_session(app)
    s.visit '/'
    expect(s.evaluate_script("getComputedStyle(document.getElementById('t')).getPropertyValue('--x')"))
      .to eq('calc(1px + 1px)')
  end
end
