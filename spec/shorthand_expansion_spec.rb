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
end
