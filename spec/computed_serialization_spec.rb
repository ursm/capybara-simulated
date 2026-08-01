require 'capybara/simulated'
require 'rack'

# A RESOLVED value is reported canonically, not as the author wrote it. The inline declaration block
# has always canonicalized on the way in; the cascade returned raw source text, so the same
# declaration read differently depending on where it was written. Every expectation here is real
# Chrome's, read off the same declarations with `--headless --dump-dom` at 1024x768.
RSpec.describe 'computed value serialization' do
  def computed(css, props, body = '<div id="t">t</div>')
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [<<~HTML]] }
      <!DOCTYPE html>
      <html><head><style>#t { #{css} }</style></head><body>#{body}</body></html>
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

  it 'canonicalizes numbers, units and function names' do
    expect(computed('transition-duration: .4s; letter-spacing: .5px; z-index: 007; flex-grow: 2.0',
                    %w[transitionDuration letterSpacing zIndex flexGrow]))
      .to eq(['0.4s', '0.5px', '7', '2'])
    # A unit and a function name are ASCII case-insensitive and reported folded; a STRING inside
    # keeps its case.
    expect(computed('filter: BLUR(2PX); grid-template-columns: 1FR 2Fr; content: "Keep Me"',
                    %w[filter gridTemplateColumns content]))
      .to eq(['blur(2px)', '1fr 2fr', '"Keep Me"'])
  end

  it 'reports transform as the composed matrix' do
    expect(computed('transform: translateX(10px)', %w[transform])).to eq(['matrix(1, 0, 0, 1, 10, 0)'])
    expect(computed('transform: translate(10px, 20px)', %w[transform])).to eq(['matrix(1, 0, 0, 1, 10, 20)'])
    expect(computed('transform: scale(2, 3)', %w[transform])).to eq(['matrix(2, 0, 0, 3, 0, 0)'])
    expect(computed('transform: rotate(45deg)', %w[transform]))
      .to eq(['matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)'])
    # Composition is left-to-right, so the translate happens in the UNROTATED frame.
    expect(computed('transform: translateX(10px) rotate(90deg)', %w[transform])).to eq(['matrix(0, 1, -1, 0, 10, 0)'])
    expect(computed('transform: translateY(5px) scale(2)', %w[transform])).to eq(['matrix(2, 0, 0, 2, 0, 5)'])
    expect(computed('transform: skewX(10deg)', %w[transform])).to eq(['matrix(1, 0, 0.176327, 1, 0, 0)'])
    expect(computed('transform: none', %w[transform])).to eq(['none'])
    # A genuine 3D component escalates the whole thing to the 4x4 form.
    expect(computed('transform: translateZ(5px)', %w[transform]))
      .to eq(['matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1)'])
  end

  it 'reports a shadow colour-first with every omitted length filled in' do
    expect(computed('box-shadow: 0 0 4px red', %w[boxShadow])).to eq(['rgb(255, 0, 0) 0px 0px 4px 0px'])
    expect(computed('box-shadow: inset 1px 2px 3px 4px blue', %w[boxShadow]))
      .to eq(['rgb(0, 0, 255) 1px 2px 3px 4px inset'])
    expect(computed('box-shadow: 1px 2px red, 3px 4px blue', %w[boxShadow]))
      .to eq(['rgb(255, 0, 0) 1px 2px 0px 0px, rgb(0, 0, 255) 3px 4px 0px 0px'])
    # `text-shadow` has no spread, so three lengths.
    expect(computed('text-shadow: 1px 2px #ABCDEF', %w[textShadow])).to eq(['rgb(171, 205, 239) 1px 2px 0px'])
  end

  it 'absolutizes a url() however the author cased it' do
    expect(computed('background-image: URL(a.png)', %w[backgroundImage]))
      .to eq(['url("http://www.example.com/a.png")'])
  end

  it 'reads the same from a rule and from a style attribute' do
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html>
        <html><head><style>#r { transform: translateX(10px); transition-duration: .4s }</style></head>
        <body><div id="r">r</div>
          <div id="i" style="transform: translateX(10px); transition-duration: .4s">i</div></body></html>
      HTML
    }
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const read = id => {
          const c = getComputedStyle(document.getElementById(id));
          return [c.transform, c.transitionDuration];
        };
        return [read('r'), read('i')];
      })()
    JS
    expect(got[0]).to eq(got[1])
    expect(got[0]).to eq(['matrix(1, 0, 0, 1, 10, 0)', '0.4s'])
  end
end
