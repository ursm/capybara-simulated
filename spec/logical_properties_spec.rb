require 'capybara/simulated'
require 'rack'

# The flow-relative (logical) properties. Which PHYSICAL side one lands on depends on the element's
# writing mode and direction, so the mapping can't happen at parse time, where there is no element:
# both names are captured, and a read of either consults both and lets the cascade pick the winner.
# Every expectation here is real Chrome's, read off the same declarations with `--headless
# --dump-dom` at 1024x768.
RSpec.describe 'logical properties' do
  def computed(css, body, props)
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [<<~HTML]] }
      <!DOCTYPE html>
      <html><head><style>#{css}</style></head><body>#{body}</body></html>
    HTML
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    s.evaluate_script(<<~JS)
      (() => {
        const c = getComputedStyle(document.getElementById('t'));
        return #{props.inspect}.map(p => c[p]);
      })()
    JS
  end

  it 'maps the block and inline sides in the default writing mode' do
    expect(computed('#t { border-block-end: 3px solid red }', '<div id="t">t</div>',
                    %w[borderBottomStyle borderBottomWidth borderBottomColor borderTopStyle]))
      .to eq(['solid', '3px', 'rgb(255, 0, 0)', 'none'])
    expect(computed('#t { margin-block: 10px 20px; padding-inline: 5px 15px }', '<div id="t">t</div>',
                    %w[marginTop marginBottom paddingLeft paddingRight]))
      .to eq(['10px', '20px', '5px', '15px'])
  end

  it 'maps the inset longhands to the bare physical sides, in the LAYOUT too' do
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html>
        <html><head><style>
          body { margin: 0 }
          #t { position: absolute; inset-block: 10px 2px; inset-inline: 30px 4px; width: 50px; height: 20px }
        </style></head><body><div id="t">t</div></body></html>
      HTML
    }
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    # `inset-block-start` IS `top` — the layout reader runs the same logical merge, so a page that
    # positions flow-relatively lands where a browser puts it. (The computed `top` itself stays
    # layout-only in this driver, which is why the box is what's asserted.)
    expect(s.evaluate_script(<<~JS)).to eq([30, 10])
      (b => [Math.round(b.x), Math.round(b.y)])(document.getElementById('t').getBoundingClientRect())
    JS
  end

  it 'maps the logical sizes to width and height' do
    expect(computed('#t { block-size: 50px; inline-size: 60px }', '<div id="t">t</div>',
                    %w[height width]))
      .to eq(['50px', '60px'])
  end

  it 'follows direction: inline-start is the right edge in rtl' do
    expect(computed('#t { direction: rtl; border-inline-start: 2px dotted blue }',
                    '<div id="t">t</div>', %w[borderRightStyle borderRightWidth borderLeftStyle]))
      .to eq(['dotted', '2px', 'none'])
  end

  it 'follows writing-mode: block-start is the right edge in vertical-rl' do
    expect(computed('#t { writing-mode: vertical-rl; border-block-start: 4px dashed green; margin-block-start: 7px }',
                    '<div id="t">t</div>',
                    %w[borderRightStyle borderLeftStyle borderTopStyle marginRight marginLeft marginTop]))
      .to eq(['dashed', 'none', 'none', '7px', '0px', '0px'])
  end

  it 'sets both sides of an axis from the axis shorthand' do
    expect(computed('#t { border-inline: 1px solid black }', '<div id="t">t</div>',
                    %w[borderLeftStyle borderRightStyle borderTopStyle]))
      .to eq(['solid', 'solid', 'none'])
  end

  it 'inherits the writing mode when resolving a descendant' do
    # `writing-mode` inherits, so a nested box resolves its own logical sides the way its ancestor
    # does — the mapping reads the INHERITED value, not just the element's own declaration.
    expect(computed('#w { writing-mode: vertical-rl } #t { border-block-start: 5px solid red }',
                    '<div id="w"><div id="t">t</div></div>', %w[borderRightStyle borderTopStyle]))
      .to eq(['solid', 'none'])
  end

  it 'lets the cascade decide between a physical and a logical declaration' do
    # Both names are real properties; the later declaration wins, as it would between two physical
    # ones. (Chrome: the `margin-block-start` at higher specificity takes the top edge.)
    expect(computed('div { margin-top: 1px } #t { margin-block-start: 9px }',
                    '<div id="t">t</div>', %w[marginTop]))
      .to eq(['9px'])
  end

  it 'swaps the logical SIZES with the writing mode, in both directions' do
    # In a vertical mode `inline-size` is the height. The sides were writing-mode aware; the sizes
    # were a fixed map, so they weren't.
    expect(computed('#t { writing-mode: vertical-rl; inline-size: 60px; block-size: 30px }',
                    '<div id="t">t</div>', %w[width height]))
      .to eq(['30px', '60px'])
    # And the mapping answers the other way too: a physical declaration is what a logical read sees.
    expect(computed('#t { height: 50px; width: 20px }', '<div id="t">t</div>', %w[blockSize inlineSize]))
      .to eq(['50px', '20px'])
  end

  it 'follows the dir ATTRIBUTE, not just a CSS declaration' do
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html>
        <html dir="rtl"><head><style>#t { padding-inline-start: 7px }</style></head>
        <body><div id="t">t</div></body></html>
      HTML
    }
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    # `<html dir="rtl">` is how essentially every RTL app sets direction. The computed `direction`
    # comes from the HTML directionality algorithm, so reading only the CSS side put every
    # `*-inline-start` on the mirrored edge — in the layout too.
    expect(s.evaluate_script(<<~JS)).to eq(['rtl', '7px', '0px'])
      (() => { const c = getComputedStyle(document.getElementById('t'));
        return [c.direction, c.paddingRight, c.paddingLeft]; })()
    JS
  end

  it 'breaks a physical/logical tie by declaration order within the block' do
    # Every declaration of a rule shares one source, so neither specificity nor source order
    # separates these — the winner is simply the one written last, both in a rule and inline.
    expect(computed('#t { margin-block-start: 9px; margin-top: 1px }', '<div id="t">t</div>', %w[marginTop]))
      .to eq(['1px'])
    expect(computed('#t { margin-top: 1px; margin-block-start: 9px }', '<div id="t">t</div>', %w[marginTop]))
      .to eq(['9px'])
    expect(computed('', '<div id="t" style="margin-top:1px; margin-block-start:9px">t</div>', %w[marginTop]))
      .to eq(['9px'])
    expect(computed('', '<div id="t" style="margin-block-start:9px; margin-top:1px">t</div>', %w[marginTop]))
      .to eq(['1px'])
  end
end
