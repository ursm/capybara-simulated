# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What placed an out-of-flow box — `position: fixed` against the viewport, or its containing block — is what the geometry
# reads after the pass: a viewport-fixed box stays where it is as the page scrolls and is no scrollable content of it,
# an absolute one moves with the page, and a `fixed` one under a transformed ancestor is that ancestor's, and moves
# with it (CSS Transforms 1 §2). The pass the style engine's walk builds says all three itself, off its own records.
# Chrome: 2050, 10, 10, 2010, then 10, -90, 1910 after scrolling 100.
RSpec.describe 'the placement an out-of-flow box keeps' do
  [nil, '1'].each do |stylo|
    it "keeps a fixed box, moves an absolute one and a fixed one under a transform#{stylo ? ' (stylo)' : ''}" do
      saved = ENV['CSIM_STYLO']
      ENV['CSIM_STYLO'] = stylo
      html = <<~HTML
        <!DOCTYPE html><html><head><style>
          body { margin: 0 } #tall { height: 2000px }
          #f { position: fixed; top: 10px; height: 5px; width: 5px }
          #far { position: fixed; top: 3000px; height: 5px; width: 5px }
          #a { position: absolute; top: 10px; height: 5px; width: 5px }
          #t { transform: translateX(0); height: 50px } #ft { position: fixed; top: 10px; height: 5px; width: 5px }
        </style></head>
        <body><div id="tall"></div><div id="f"></div><div id="far"></div><div id="a"></div><div id="t"><div id="ft"></div></div></body></html>
      HTML
      s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
      s.visit '/'
      got = s.evaluate_script(<<~JS)
        (() => {
          const y = (id) => document.getElementById(id).getBoundingClientRect().y;
          const out = [document.documentElement.scrollHeight, y('f'), y('a'), y('ft')];
          window.scrollTo(0, 100);
          out.push(y('f'), y('a'), y('ft'));
          return out;
        })()
      JS
      expect(got).to eq([2050, 10, 10, 2010, 10, -90, 1910])
    ensure
      ENV['CSIM_STYLO'] = saved
    end
  end

  # …and a containing block REPLACED by an element that takes its place leaves every number of the box's answer as it
  # was — the same record, the same box — while the element it is placed against is another. (Chrome: 190px.)
  [nil, '1'].each do |stylo|
    it "follows a containing block replaced in place#{stylo ? ' (stylo)' : ''}" do
      saved = ENV['CSIM_STYLO']
      ENV['CSIM_STYLO'] = stylo
      html = '<!DOCTYPE html><body><div id="A" style="position:relative;height:100px"><div><p>one</p>' \
             '<div id="ab" style="position:absolute;top:0;left:0;width:10px;height:10px"></div><p>two</p></div></div></body>'
      s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
      s.visit '/'
      got = s.evaluate_script(<<~JS)
        (() => {
          const a = document.getElementById('A'), b = document.createElement('div');
          document.body.offsetHeight;
          b.style.cssText = a.style.cssText;
          b.append(...a.childNodes);
          a.replaceWith(b);
          document.body.offsetHeight;
          b.style.height = '200px';
          document.body.offsetHeight;
          return getComputedStyle(document.getElementById('ab')).bottom;
        })()
      JS
      expect(got).to eq('190px')
    ensure
      ENV['CSIM_STYLO'] = saved
    end
  end
end
