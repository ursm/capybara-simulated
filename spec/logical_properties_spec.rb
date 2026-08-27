require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

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
    s = simulated_session(app)
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
    s = simulated_session(app)
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
    s = simulated_session(app)
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

  it 'lets an INLINE flow-relative declaration outrank a stylesheet physical rule' do
    # The precedence comparator knows an inline INCUMBENT outranks a rule, but had no parameter for
    # an inline CANDIDATE — so the inline logical value was compared on specificity [0,0,0] and
    # lost. Chrome: 10px. JS-positioned and RTL-aware UI writes logical insets inline constantly.
    expect(computed('.x { margin-left: 5px }',
                    '<div class="x" id="t" style="margin-inline-start: 10px">t</div>', %w[marginLeft]))
      .to eq(['10px'])
  end

  it 'expands the flow-relative scroll shorthands' do
    # These had no expander, yet were excluded from the unknowable-shorthand gate on the claim that
    # every logical shorthand was expanded — so `scroll-margin-top` confidently reported `0px`.
    expect(computed('#t { scroll-margin-block: 10px; scroll-padding-inline: 4px }', '<div id="t">t</div>',
                    %w[scrollMarginTop scrollMarginBottom scrollPaddingLeft]))
      .to eq(['10px', '10px', '4px'])
  end

  it 'agrees between a physical size and its flow-relative twin' do
    # Chrome computes a `min-*` size as `0px`, not mdn's specified `auto` — and the two names are
    # the same declaration, which is the premise of the whole merge, so they must not disagree.
    expect(computed('', '<div id="t">t</div>', %w[minWidth minInlineSize maxWidth minHeight]))
      .to eq(['0px', '0px', 'none', '0px'])
  end

  it 'keeps a presentational hint below a layered author rule' do
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html>
        <html><head><style>@layer base { #t { inline-size: 50px } }</style></head>
        <body><img id="t" width="100"></body></html>
      HTML
    }
    s = simulated_session(app)
    s.visit '/'
    # A hint sits BELOW every author rule. Leaving its layer rank unset read as "unlayered", which
    # ranks HIGHEST, so the `width` attribute beat the `@layer` rule once the logical/physical merge
    # started comparing the two records. Chrome: 50px.
    expect(s.evaluate_script("getComputedStyle(document.getElementById('t')).width")).to eq('50px')
  end

  it 'leaves a flex item min-size at auto' do
    expect(computed('#f { display: flex }', '<div id="f"><div id="t"></div></div>', %w[minWidth]))
      .to eq(['auto'])
    expect(computed('', '<div id="t"></div>', %w[minWidth])).to eq(['0px'])
    # An ABSOLUTELY POSITIONED child is out of flow — not a flex item — and computes `0px`. A float
    # still is one, since the container blockifies it. Both Chrome measured.
    expect(computed('#f { display: flex }',
                    '<div id="f"><div id="t" style="position:absolute"></div></div>', %w[minWidth]))
      .to eq(['0px'])
    expect(computed('#f { display: flex }',
                    '<div id="f"><div id="t" style="float:left"></div></div>', %w[minWidth]))
      .to eq(['auto'])
    # An EXPLICIT `min-width: auto` — what flex-reset CSS writes — resolves exactly the same way as
    # the initial one. Resolving only the initial answered `auto` on a plain block.
    expect(computed('', '<div id="t" style="min-width:auto; min-height:auto"></div>',
                    %w[minWidth minHeight])).to eq(['0px', '0px'])
    expect(computed('#f { display: flex }',
                    '<div id="f"><div id="t" style="min-width:auto"></div></div>', %w[minWidth]))
      .to eq(['auto'])
  end

  it 'agrees between a physical inset and its flow-relative twin' do
    # `inset-block: 3px` reported `3px` for `insetBlockStart` and nothing for `top`, though they are
    # the same declaration. A DEFINITE inset is reported as written in every case Chrome was
    # measured in — static, relative, absolute, and over-constrained.
    expect(computed('', '<div id="t" style="position:absolute; inset-block: 3px"></div>',
                    %w[top bottom insetBlockStart])).to eq(['3px', '3px', '3px'])
    expect(computed('', '<div id="t" style="position:absolute; inset: 5px"></div>',
                    %w[top left])).to eq(['5px', '5px'])
    expect(computed('', '<div id="t" style="position:absolute; inset-inline-start: 7px"></div>',
                    %w[left insetInlineStart])).to eq(['7px', '7px'])
    # `auto` and a percentage are layout-dependent, and a POSITIONED box owes the used value for
    # both — the percentage absolutized against the containing block, `auto` resolved to where the
    # box actually sits. All six match Chrome 151.0.7922.169 exactly on this page.
    positioned = '#cb { position: relative; width: 400px; height: 200px; padding: 10px; border: 5px solid } ' \
                 '#t { position: absolute; top: auto; left: 10%; width: 50px; height: 20px }'
    expect(computed(positioned, '<div id="cb"><div id="t"></div></div>',
                    %w[top left bottom right insetBlockStart insetInlineStart]))
      .to eq(['10px', '42px', '190px', '328px', '10px', '42px'])
  end
end
