# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# CSSOM asks for a used value from `top` / `right` / `bottom` / `left` on a POSITIONED box, and it is
# two different numbers depending on the side. A side that is not `auto` reports its own computed
# value absolutized against the containing block — which is why an OVER-CONSTRAINED box reports both
# sides rather than the one layout honoured — and a side that IS `auto` reports the distance layout
# ended up putting there. A static box reports what was written (`10%` stays `10%`), and a sticky
# box keeps `auto` as `auto`, because its offsets constrain a scroll rather than place the box.
#
# Every figure below is measured in Chrome 151.0.7922.169 on the same markup.
RSpec.describe 'the resolved value of an inset' do
  def insets(css, body, props = %w[top right bottom left])
    s = simulated_session(->(_env) do
      [200, {'content-type' => 'text/html'},
       ["<!DOCTYPE html><html><head><style>body { margin: 0 } #{css}</style></head><body>#{body}</body></html>"]]
    end)
    s.visit '/'
    s.evaluate_script("(() => { const c = getComputedStyle(document.getElementById('t'));" \
                      "         return #{props.inspect}.map(p => c[p]); })()")
  end

  # The containing block for an absolute box is the nearest positioned ancestor's PADDING box:
  # 400 + 2*10 padding = 420 wide, 200 + 20 = 220 tall, borders excluded.
  CB = '#cb { position: relative; width: 400px; height: 200px; padding: 10px; border: 5px solid }'

  it 'absolutizes a percentage against the containing block' do
    expect(insets("#{CB} #t { position: absolute; top: 10%; left: 25%; bottom: 50%; right: 75% }",
                  '<div id="cb"><div id="t"></div></div>'))
      .to eq(['22px', '315px', '110px', '105px'])
  end

  # A `calc()` mixing a percentage with a length has to be evaluated, not echoed.
  it 'absolutizes a calc() that mixes a percentage with a length' do
    expect(insets("#{CB} #t { position: absolute; top: calc(10% - 1px); left: calc(25% - 2px) }",
                  '<div id="cb"><div id="t"></div></div>', %w[top left]))
      .to eq(['21px', '103px'])
  end

  # Over-constrained: both sides given AND a size. Layout can only honour one, but CSSOM reports
  # each side's own computed value — reporting the used geometry here would answer 220-1-0 for
  # `bottom` instead of the 3px that was written.
  it 'reports both sides of an over-constrained box' do
    expect(insets("#{CB} #t { position: absolute; top: 1px; left: 2px; bottom: 3px; right: 4px; " \
                  'height: 0; width: 0 }', '<div id="cb"><div id="t"></div></div>'))
      .to eq(['1px', '4px', '3px', '2px'])
  end

  # An `auto` side takes the distance layout put there — measured to the box's MARGIN edge, which
  # is where CSS puts the inset.
  it 'resolves an auto side to the distance layout used' do
    expect(insets("#{CB} #t { position: absolute; top: auto; left: auto; bottom: 3px; right: 4px }",
                  '<div id="cb"><div id="t"></div></div>'))
      .to eq(['217px', '4px', '3px', '416px'])
  end

  # Both sides auto: the box sits at its STATIC position — where the flow would have put it — and
  # both sides report the distance to it.
  it 'resolves opposite auto sides to the static position' do
    expect(insets("#{CB} #t { position: absolute; width: 50px; height: 20px }",
                  '<div id="cb"><div id="t"></div></div>'))
      .to eq(['10px', '360px', '190px', '10px'])
  end

  # A relative box is SHIFTED from where the flow put it, so its used inset is that shift — and the
  # opposite side is its negation, not a distance to the containing block.
  it 'reports a relative box shift, and its negation on the far side' do
    expect(insets('#t { position: relative; top: auto; bottom: 3px; left: auto; right: 4px }',
                  '<div id="t"></div>'))
      .to eq(['-3px', '4px', '3px', '-4px'])
  end

  # A STATIC box owes no used value at all: a percentage stays a percentage and `auto` stays `auto`.
  it 'leaves a static box its computed value' do
    expect(insets('#t { position: static; top: 10%; left: 25% }', '<div id="t"></div>'))
      .to eq(['10%', 'auto', 'auto', '25%'])
  end

  # A sticky box keeps `auto`: its offsets are a constraint on scrolling, and there is no placement
  # for `auto` to name. A definite one still reports as the length it is.
  it 'keeps auto on a sticky box' do
    expect(insets('#c { width: 400px; height: 200px } #t { position: sticky; top: 5px; left: 7px }',
                  '<div id="c"><div id="t"></div></div>'))
      .to eq(['5px', 'auto', 'auto', '7px'])
  end

  # The flow-relative spellings are the same declaration seen from the writing mode, so they answer
  # the same number as the physical side they name — in both directions.
  it 'agrees with the flow-relative spelling of the same side' do
    expect(insets("#{CB} #t { position: absolute; top: 10%; left: 25% }",
                  '<div id="cb"><div id="t"></div></div>',
                  %w[top insetBlockStart left insetInlineStart]))
      .to eq(['22px', '22px', '105px', '105px'])
  end

  # …and it is the ELEMENT's own mode that names the side, not the containing block's — an `ltr`
  # box inside an `rtl` one still calls its left edge inline-start. The container-inherits case
  # cannot tell the two apart, so this sets both.
  it 'names the side from the element own writing mode, not the container' do
    expect(insets("#{CB} #cb { direction: rtl } #t { position: absolute; left: 25%; right: 75% }",
                  '<div id="cb"><div id="t"></div></div>',
                  %w[insetInlineStart insetInlineEnd]))
      .to eq(['315px', '105px'])
    expect(insets("#{CB} #cb { direction: rtl } " \
                  '#t { direction: ltr; position: absolute; left: 25%; right: 75% }',
                  '<div id="cb"><div id="t"></div></div>',
                  %w[insetInlineStart insetInlineEnd]))
      .to eq(['105px', '315px'])
  end

  # `display: contents` generates no box, and CSSOM makes the resolved value the computed one there
  # — the engine hangs geometry off such an element, and reporting it invented four numbers.
  it 'leaves a display:contents element its computed value' do
    expect(insets("#{CB} #t { position: absolute; display: contents; top: 10%; left: auto; bottom: 5px }",
                  '<div id="cb"><div id="t">x</div></div>'))
      .to eq(['10%', 'auto', '5px', 'auto'])
    # …and such an element is nobody's containing block either: the walk passes through it.
    expect(insets('#g { width: 600px; height: 300px } #pc { display: contents } ' \
                  '#t { position: relative; top: 10% }',
                  '<div id="g"><div id="pc"><div id="t">y</div></div></div>'))
      .to eq(['30px', '0px', '-30px', '0px'])
  end

  # A non-atomic INLINE box resolves a LENGTH inset but not a percentage one — and the axes decide
  # separately, so `top: 10%; left: 5px` answers a percentage down and a used offset across.
  it 'resolves a length but not a percentage on an inline box' do
    inline = '<p style="width:200px;height:100px">aaa <span id="t">bbb</span></p>'
    expect(insets('#t { position: relative; top: 10%; left: 5px }', inline))
      .to eq(['10%', '-5px', 'auto', '5px'])
    expect(insets('#t { position: relative; top: 7px; left: 5px }', inline))
      .to eq(['7px', '-5px', '-7px', '5px'])
  end

  # A percentage padding on the PARENT resolves against the parent's own containing block, not its
  # border box — the containing block a relative box's percentage inset then measures.
  it 'resolves the parent percentage padding against the parent containing block' do
    expect(insets('body { width: 1000px } #p { width: 400px; height: 300px; padding: 10% } ' \
                  '#t { position: relative; top: 50%; left: 50% }',
                  '<div id="p"><div id="t"></div></div>'))
      .to eq(['150px', '-200px', '-150px', '200px'])
  end
end
