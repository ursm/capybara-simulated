require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

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
    s = simulated_session(app)
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
    # `translate3d` — the GPU-compositing idiom — is composed, not reported as written. A ZERO Z
    # doesn't escalate: `translateZ(0)` is a plain 2D matrix in Chrome, so the compositing hint
    # stays invisible to page code parsing the matrix back out.
    expect(computed('transform: translate3d(10px, 20px, 0)', %w[transform])).to eq(['matrix(1, 0, 0, 1, 10, 20)'])
    expect(computed('transform: translateZ(0)', %w[transform])).to eq(['matrix(1, 0, 0, 1, 0, 0)'])
    expect(computed('transform: translate3d(10px, 20px, 5px)', %w[transform]))
      .to eq(['matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 5, 1)'])
    # A percentage is no valid Z translation — there is nothing to resolve it against — so the
    # whole declaration is invalid rather than silently resolving against the height.
    expect(computed('transform: translateZ(50%); height: 40px', %w[transform])).to eq(['none'])
  end

  it 'reports a shadow colour-first with every omitted length filled in' do
    expect(computed('box-shadow: 0 0 4px red', %w[boxShadow])).to eq(['rgb(255, 0, 0) 0px 0px 4px 0px'])
    expect(computed('box-shadow: inset 1px 2px 3px 4px blue', %w[boxShadow]))
      .to eq(['rgb(0, 0, 255) 1px 2px 3px 4px inset'])
    expect(computed('box-shadow: 1px 2px red, 3px 4px blue', %w[boxShadow]))
      .to eq(['rgb(255, 0, 0) 1px 2px 0px 0px, rgb(0, 0, 255) 3px 4px 0px 0px'])
    # `text-shadow` has no spread, so three lengths.
    expect(computed('text-shadow: 1px 2px #ABCDEF', %w[textShadow])).to eq(['rgb(171, 205, 239) 1px 2px 0px'])
    # Every length is reported as its USED value — the colour-first form exists to be parsed, and an
    # em / viewport unit left in it defeats that. At the 1024x768 viewport `2vw` is `20.48px`.
    expect(computed('font-size: 10px; box-shadow: 0 0 2em red', %w[boxShadow]))
      .to eq(['rgb(255, 0, 0) 0px 0px 20px 0px'])
    expect(computed('box-shadow: 0 0 2vw red', %w[boxShadow])).to eq(['rgb(255, 0, 0) 0px 0px 20.48px 0px'])
    # There is no such thing as a percentage shadow length, so the declaration is invalid whole and
    # the property falls back to its initial. Only a ZERO may omit its unit, so a bare `4` is
    # invalid the same way — reporting it as `4px` was inventing a unit the author never wrote.
    expect(computed('box-shadow: 0 0 2% red', %w[boxShadow])).to eq(['none'])
    expect(computed('box-shadow: 0 0 4 red', %w[boxShadow])).to eq(['none'])
    expect(computed('box-shadow: 0 0 4foo red', %w[boxShadow])).to eq(['none'])
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
    s = simulated_session(app)
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

  it 'resolves a percentage translate against the element box' do
    # `translate(-50%, -50%)` is the centring idiom; reporting a zero matrix there is worse than
    # not answering. Chrome on a 100x40 box: `matrix(1, 0, 0, 1, -50, -20)`.
    expect(computed('transform: translate(-50%, -50%); width: 100px; height: 40px', %w[transform]))
      .to eq(['matrix(1, 0, 0, 1, -50, -20)'])
    # A component we can't resolve leaves the author's value rather than inventing a matrix.
    expect(computed('transform: translateX(2em)', %w[transform])).to eq(['translateX(2em)'])
  end

  it 'keeps a colour word that is part of a path' do
    # `gold`, `red`, `tan`, `plum`, `snow`, `linen` are all named colours; inside a `url()` they are
    # filenames. Rewriting them made every such asset 404.
    expect(computed('background: url(/img/gold-star.png) no-repeat', %w[backgroundImage]))
      .to eq(['url("http://www.example.com/img/gold-star.png")'])
  end

  it 'reports a shadow with no colour using the element colour' do
    expect(computed('box-shadow: 1px 2px', %w[boxShadow])).to eq(['rgb(0, 0, 0) 1px 2px 0px 0px'])
    expect(computed('color: rgb(0, 128, 0); box-shadow: 1px 2px', %w[boxShadow]))
      .to eq(['rgb(0, 128, 0) 1px 2px 0px 0px'])
  end

  it 'keeps a transform function in its canonical spelling' do
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body><div id="t"></div></body></html>']] }
    s = simulated_session(app)
    s.visit '/'
    # Chrome preserves `translateX` in the style attribute while folding `BLUR(2PX)` — the rule is
    # the function's canonical spelling, not a blanket lowercase.
    expect(s.evaluate_script(<<~JS)).to eq('transform: translateX(10px) rotate(45deg); --state: collapsed;')
      (() => {
        const t = document.getElementById('t');
        t.style.transform = 'translateX(10px) rotate(45deg)';
        t.style.setProperty('--state', 'collapsed');
        return t.getAttribute('style');
      })()
    JS
  end

  it 'reads a scale percentage as a fraction' do
    # `parseFloat` strips the `%` and hands page code a 100x factor — and `transform` is exactly the
    # value Floating UI and Popper parse to recover a scale.
    expect(computed('transform: scale(50%)', %w[transform])).to eq(['matrix(0.5, 0, 0, 0.5, 0, 0)'])
    expect(computed('transform: scale(1.5, 50%)', %w[transform])).to eq(['matrix(1.5, 0, 0, 0.5, 0, 0)'])
  end

  it 'drops a transform whose angle has no unit' do
    # `rotate(1)` is not one degree — only a zero may omit its unit, so the declaration is invalid
    # and Chrome reports `none`.
    expect(computed('transform: rotate(1)', %w[transform])).to eq(['none'])
    expect(computed('transform: rotate(0)', %w[transform])).to eq(['matrix(1, 0, 0, 1, 0, 0)'])
  end

  it 'resolves a shadow length to the used px' do
    # The colour-first form exists to be parsed; a font-relative unit left in it defeats that.
    expect(computed('font-size: 16px; box-shadow: 0 0 1em red', %w[boxShadow]))
      .to eq(['rgb(255, 0, 0) 0px 0px 16px 0px'])
  end

  it 'keeps a function whose arguments contain spaces intact' do
    # A corner radius can be `calc(10px + 5px)`. Splitting each corner on whitespace to recover the
    # horizontal / vertical radii tore that into three tokens and wrote `border-radius: calc(10px /
    # +;` back into the style attribute — the block serializer runs on every write.
    # The COMPUTED value is fully reduced (Chrome measured: `15px`, not `calc(15px)`); a percentage
    # keeps the calc, because it needs a per-property basis (`calc(10% + 5px)` — also measured).
    expect(computed('border-radius: calc(10px + 5px)', %w[borderTopLeftRadius borderRadius]))
      .to eq(['15px', '15px'])
    expect(computed('border-radius: calc(10% + 5px)', %w[borderTopLeftRadius]))
      .to eq(['calc(10% + 5px)'])
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body><div id="w" style="border-radius: calc(10px + 5px)"></div></body></html>']] }
    s = simulated_session(app)
    s.visit '/'
    # The SPECIFIED surface is not the computed one: it keeps the calc WRAPPER and simplifies
    # inside it, so this is `calc(15px)` where the computed value is a plain `15px` (both Chrome
    # measured). The contract this example was written for still holds alongside it: an unrelated
    # write leaves the declaration intact rather than tearing it into `border-radius: calc(10px /`
    # + `;`.
    expect(s.evaluate_script("(() => { const w = document.getElementById('w'); w.style.color = 'red'; return w.getAttribute('style'); })()"))
      .to eq('border-radius: calc(15px); color: red;')
  end

  it 'accepts an explicit plus sign' do
    # CSS numbers, angles and times may carry one. Rejecting it made a transform report `none` —
    # the confident wrong answer Floating UI reads as "this ancestor is a containing block".
    expect(computed('transform: rotate(+45deg)', %w[transform]))
      .to eq(['matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)'])
    expect(computed('transform: scale(+2)', %w[transform])).to eq(['matrix(2, 0, 0, 2, 0, 0)'])
    expect(computed('transform: translateX(+10px)', %w[transform])).to eq(['matrix(1, 0, 0, 1, 10, 0)'])
    # The sign is dropped in the reported value, as a browser does.
    expect(computed('transition: opacity +2s', %w[transitionDuration])).to eq(['2s'])
  end

  it 'leaves a colour word inside a custom-property name alone' do
    # `--tan-100` is an identifier; `tan` in it is no more a colour than `gold` in a filename.
    expect(computed('background: var(--tan-100)', %w[backgroundImage])).to eq(['none'])
  end

  it 'reconstructs a border AXIS shorthand from its two flow sides' do
    # `border-block-width` is a shorthand over `border-block-start-width` / `-end-width`; without a
    # registry entry the axis name resolved to its initial `medium`. Chrome measured: equal sides
    # collapse, differing sides list both.
    expect(computed('border-block-start-width: 2px; border-block-end-width: 2px; border-block-style: solid',
                    %w[borderBlockWidth borderBlockStartWidth])).to eq(['2px', '2px'])
    expect(computed('border-block-start-width: 2px; border-block-end-width: 4px; border-block-style: solid',
                    %w[borderBlockWidth])).to eq(['2px 4px'])
    expect(computed('border-inline-start-width: 3px; border-inline-end-width: 3px; border-inline-style: solid',
                    %w[borderInlineWidth])).to eq(['3px'])
  end

  it 'reports a unitless zero with its unit in a list-valued length' do
    # The single-value path already did this; each component of a LIST carries its own unit, and
    # Chrome reports `0px` for all three of these (measured).
    expect(computed('background-position: 15px 0', %w[backgroundPosition])).to eq(['15px 0px'])
    expect(computed('background-size: 10px 0',     %w[backgroundSize])).to eq(['10px 0px'])
    expect(computed('border-spacing: 5px 0',       %w[borderSpacing])).to eq(['5px 0px'])
  end

end
