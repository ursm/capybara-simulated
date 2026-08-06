require 'capybara/simulated'
require 'rack'

# CSS math functions. Every expectation is real Chrome's, read off the same declarations with
# `--headless --dump-dom` at 1024x768 with a 16px root font.
#
# A math function that RESOLVES collapses to a plain value — `calc(10px + 5px)` computes to `15px`,
# not to `calc(15px)`. All of these reported '' before, which is the "we can't know" answer for
# something a browser knows exactly.
RSpec.describe 'CSS math functions' do
  def computed(decls, props, extra_css: '')
    html = <<~HTML
      <!DOCTYPE html>
      <html><head><style>:root { --gap: 8px } #{extra_css} #t { #{decls} }</style></head>
      <body><div id="t"></div></body></html>
    HTML
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [html]] }
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    s.evaluate_script("(() => { const c = getComputedStyle(document.getElementById('t')); return #{props.inspect}.map(p => c[p]); })()")
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

  it 'leaves a percentage expression to layout' do
    # A percentage needs a per-property basis this stage doesn't have, so the value is kept as
    # written rather than guessed at. Chrome resolves these against the containing block (`754px` /
    # `392px` in the measured fixture); reporting '' is the same honest "needs layout" the driver
    # already gives for a bare `50%` width.
    expect(computed('margin-left: calc(100% - 10px)', %w[marginLeft])).to eq([''])
    expect(computed('width: calc(50% + 10px)',        %w[width])).to eq([''])
  end

  it 'hands a custom property back unreduced' do
    # An unregistered custom property's computed value is a TOKEN SEQUENCE — Chrome does not
    # evaluate it, exactly as it does not canonicalise `.5px` or `url(a.png)` there.
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'},
       ['<!DOCTYPE html><html><head><style>#t { --x: calc(1px + 1px) }</style></head>' \
        '<body><div id="t"></div></body></html>']]
    }
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    expect(s.evaluate_script("getComputedStyle(document.getElementById('t')).getPropertyValue('--x')"))
      .to eq('calc(1px + 1px)')
  end
end
