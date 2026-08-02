require 'capybara/simulated'
require 'rack'

# The shorthands the CSSOM registry had no expander for. Each was invisible to the cascade: it saw
# `transition: opacity 1s` and no `transition-duration`, so a resolved-value read of the longhand
# had to answer '' ("unknowable") rather than the value the page plainly set. Every expectation
# here is real Chrome's, read off the same declarations with `--headless --dump-dom` at 1024x768.
RSpec.describe 'shorthand expansion' do
  def session(body)
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [body]] }
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    s
  end

  # Both origins run one expander, so each case is asserted from a RULE and from a `style=`
  # attribute at once — the asymmetry between them surfaced as a different bug in five rounds.
  def both(decls, props)
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>#r { #{decls} }</style></head>
      <body><div id="r">r</div><div id="i" style="#{decls}">i</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const read = id => {
          const c = getComputedStyle(document.getElementById(id));
          return #{props.inspect}.map(p => c[p]);
        };
        return [read('r'), read('i')];
      })()
    JS
    expect(got[0]).to eq(got[1])
    got[0]
  end

  it 'expands transition, including a comma-separated layer list' do
    expect(both('transition: opacity 1s', %w[transitionProperty transitionDuration transitionTimingFunction transitionDelay]))
      .to eq(['opacity', '1s', 'ease', '0s'])
    expect(both('transition: opacity 1s ease-in 0.5s, transform 2s', %w[transitionProperty transitionDuration transitionDelay]))
      .to eq(['opacity, transform', '1s, 2s', '0.5s, 0s'])
  end

  it 'expands transition-behavior, the component transition-property would otherwise swallow' do
    # `transition: display .3s allow-discrete` is the popover / dialog idiom. `transition-property`
    # is a catch-all matcher, so `allow-discrete` matched nothing and the whole declaration was
    # dropped — leaving a confident `transition-duration: 0s` where the page plainly set 0.3s.
    expect(both('transition: opacity 0.3s allow-discrete',
                %w[transition transitionProperty transitionDuration transitionBehavior]))
      .to eq(['opacity 0.3s allow-discrete', 'opacity', '0.3s', 'allow-discrete'])
    expect(both('transition: display 0.3s allow-discrete, opacity 1s',
                %w[transition transitionBehavior]))
      .to eq(['display 0.3s allow-discrete, opacity 1s', 'allow-discrete, normal'])
    # `normal` is the BEHAVIOR's initial, not a property named `normal`: everything is at its
    # initial, so the shorthand reports its own "nothing set" token.
    expect(both('transition: normal', %w[transition transitionProperty transitionBehavior]))
      .to eq(['all', 'all', 'normal'])
    # The behavior serializes LAST, whichever order it was written in.
    expect(both('transition: allow-discrete 1s opacity linear 2s', %w[transition]))
      .to eq(['opacity 1s linear 2s allow-discrete'])
  end

  it 'expands animation, whose name is whatever is left over' do
    expect(both('animation: spin 2s', %w[animationName animationDuration animationIterationCount]))
      .to eq(['spin', '2s', '1'])
    expect(both('animation: spin 2s linear 1s infinite alternate both paused',
                %w[animationName animationDirection animationFillMode animationPlayState animationDelay]))
      .to eq(['spin', 'alternate', 'both', 'paused', '1s'])
  end

  it 'expands font, resetting the longhands it does not mention' do
    # Chrome computes `line-height: 2` against the 12px size, so it reports `24px`.
    expect(both('font: italic 12px/2 Arial, sans-serif', %w[fontStyle fontSize lineHeight fontFamily fontWeight]))
      .to eq(['italic', '12px', '24px', 'Arial, sans-serif', '400'])
    expect(both('font: bold 16px serif', %w[fontWeight fontSize fontFamily fontStyle lineHeight]))
      .to eq(['700', '16px', 'serif', 'normal', 'normal'])
  end

  it 'expands the grid placement shorthands' do
    expect(both('grid-area: 1 / 2 / 3 / 4', %w[gridRowStart gridColumnStart gridRowEnd gridColumnEnd]))
      .to eq(['1', '2', '3', '4'])
    expect(both('grid-row: 1 / 3', %w[gridRowStart gridRowEnd])).to eq(['1', '3'])
  end

  it 'expands the positional pair and box shorthands' do
    expect(both('gap: 10px 20px', %w[rowGap columnGap])).to eq(['10px', '20px'])
    expect(both('flex-flow: column wrap', %w[flexDirection flexWrap])).to eq(['column', 'wrap'])
    expect(both('place-items: center start', %w[alignItems justifyItems])).to eq(['center', 'start'])
    expect(both('border-radius: 4px 8px',
                %w[borderTopLeftRadius borderTopRightRadius borderBottomRightRadius borderBottomLeftRadius]))
      .to eq(['4px', '8px', '4px', '8px'])
  end

  it 'expands the column shorthands' do
    expect(both('columns: 3 100px', %w[columnCount columnWidth])).to eq(['3', '100px'])
    expect(both('column-rule: 2px dashed red', %w[columnRuleWidth columnRuleStyle columnRuleColor]))
      .to eq(['2px', 'dashed', 'rgb(255, 0, 0)'])
  end

  it 'leaves an omitted grid end at auto unless the start names a line' do
    # Chrome measured. The omitted end mirrors the start ONLY for a custom ident (a line name);
    # for an integer or a `span` it is `auto`, and `grid-column: N` is everywhere.
    expect(both('grid-column: 2', %w[gridColumnStart gridColumnEnd])).to eq(['2', 'auto'])
    expect(both('grid-area: span 2 / 3', %w[gridRowStart gridRowEnd gridColumnStart gridColumnEnd]))
      .to eq(['span 2', 'auto', '3', 'auto'])
    expect(both('grid-column: myline', %w[gridColumnStart gridColumnEnd])).to eq(['myline', 'myline'])
  end

  it 'binds an alignment modifier to the keyword it qualifies' do
    # `safe center` is ONE value, not two — Chrome gives both longhands `safe center`. And
    # `first baseline` is just `baseline`, the modifier being the default.
    expect(both('place-content: safe center', %w[alignContent justifyContent]))
      .to eq(['safe center', 'safe center'])
    expect(both('place-items: first baseline', %w[alignItems justifyItems])).to eq(['baseline', 'baseline'])
  end

  it 'fills every grid slot from a single line name' do
    # Each end mirrors the RESOLVED start, not the (absent) input slot.
    expect(both('grid-area: myarea', %w[gridRowStart gridRowEnd gridColumnStart gridColumnEnd]))
      .to eq(%w[myarea myarea myarea myarea])
  end

  it 'groups alignment modifiers before splitting the pair' do
    expect(both('place-content: safe center safe start', %w[alignContent justifyContent]))
      .to eq(['safe center', 'safe start'])
  end

  it 'cycles a shorter layer list across the layers' do
    # CSS repeats a shorter longhand list cyclically: with two durations and four properties,
    # layer 3 takes duration[1].
    expect(both('transition-property: a, b, c, d; transition-duration: 1s, 2s', %w[transitionDuration]))
      .to eq(['1s, 2s'])
    expect(both('transition: a 1s, b 2s, c 3s', %w[transitionDuration])).to eq(['1s, 2s, 3s'])
  end

  it 'handles the elliptical border-radius form' do
    # `border-radius: 50% / 20%` gives every corner a horizontal AND a vertical radius, and each
    # corner longhand carries both. Chrome measured; the plain 4-value expander wrote a literal `/`
    # into a declaration.
    expect(both('border-radius: 50% / 20%', %w[borderTopLeftRadius borderRadius]))
      .to eq(['50% 20%', '50% / 20%'])
    expect(both('border-radius: 10px 20px / 5px 8px', %w[borderTopLeftRadius borderRadius]))
      .to eq(['10px 5px', '10px 20px / 5px 8px'])
    expect(both('border-radius: 4px', %w[borderTopLeftRadius borderRadius])).to eq(['4px', '4px'])
  end

  it 'round-trips a newly registered shorthand through the style attribute' do
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] }
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const mk = () => { const d = document.createElement('div'); document.body.appendChild(d); return d; };
        const a = mk(); a.style.transition = 'opacity 1s';
        const b = mk(); b.style.animation = 'spin 2s linear infinite';
        const c = mk(); c.style.borderRadius = '50% / 20%';
        const d = mk(); d.style.gap = '10px'; d.style.color = 'red';
        return [a, b, c, d].map(e => e.getAttribute('style'));
      })()
    JS
    # The block serializer re-serializes on EVERY write, so a shorthand missing from its list has
    # the attribute exploded into longhands the first time any property is set. All Chrome measured.
    expect(got).to eq([
      'transition: opacity 1s;',
      'animation: 2s linear 0s infinite normal none running spin;',
      'border-radius: 50% / 20%;',
      'gap: 10px; color: red;'
    ])
  end

  it 'reports the shorthand a plain element has' do
    got = both('color: black', %w[animation transition flexFlow textEmphasis placeItems columns columnRule borderRadius gap])
    # All Chrome measured. `animation` is `none` and `transition` is `all` — the shorthand's own
    # "nothing set" token, not whichever component happens to be listed first.
    expect(got).to eq(['none', 'all', 'row nowrap', 'none rgb(0, 0, 0)', 'normal', 'auto',
                       '3px rgb(0, 0, 0)', '0px', 'normal'])
  end

  it 'drops a transform a browser would reject' do
    expect(both('transform: matrix(1,2,3)', %w[transform])).to eq(['none'])
  end

  it 'keeps a shorthand carrying a substitution and resolves it per element' do
    # `transition: <prop> var(--dur) <easing>` is a standard themed-CSS idiom. The parser can't
    # decompose it — a substitution resolves per ELEMENT, later — and dropping the declaration whole
    # made the element look like it had no transition at all. Chrome resolves it; so do we, at the
    # read, where the custom property is in scope.
    expect(both('transition: all var(--d, 2s) ease', %w[transitionDuration transitionProperty transition]))
      .to eq(['2s', 'all', '2s'])
  end

  it 'serializes a block more tersely than the computed value' do
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] }
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const mk = (css) => { const d = document.createElement('div'); d.setAttribute('style', css);
                              document.body.appendChild(d); d.style.color = 'red'; return d; };
        const ff = mk('flex-flow: row nowrap'), te = mk('text-emphasis: red');
        return [ff.getAttribute('style'), te.getAttribute('style'),
                getComputedStyle(ff).flexFlow, getComputedStyle(te).textEmphasis];
      })()
    JS
    # Chrome uses DIFFERENT rules for the two: a computed `flex-flow` is `row nowrap`, but the
    # style attribute keeps only what isn't at its initial. One `serialize` feeds both paths.
    expect(got).to eq(['flex-flow: row; color: red;', 'text-emphasis: red; color: red;',
                       'row nowrap', 'none rgb(255, 0, 0)'])
  end

  it 'serializes a specified animation in full and its computed value tersely' do
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] }
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const d = document.createElement('div');
        d.setAttribute('style', 'animation: spin 2s linear infinite');
        document.body.appendChild(d);
        return [getComputedStyle(d).animation, d.style.animation];
      })()
    JS
    # `animation`'s polarity is the REVERSE of `flex-flow`'s: the specified surface (`.style` and
    # the style attribute alike — see the round-trip case above) lists every component, and the
    # computed value omits the initials.
    expect(got).to eq(['2s linear infinite spin',
                       '2s linear 0s infinite normal none running spin'])
  end
end
