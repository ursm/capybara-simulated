# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The author cascade, over shapes its matching has got wrong before.
RSpec.describe 'author cascade' do
  # A type selector matches an SVG element by its camelCase `localName` — asking for a lowercased `foreignobject` found
  # no rule, so none of them applied. Chrome-measured.
  it 'matches a camelCase SVG element by its type selector' do
    html = <<~HTML
      <!DOCTYPE html>
      <style>foreignObject { margin-left: 7px } svg > linearGradient { margin-top: 4px } clipPath:hover, clipPath { padding-left: 2px }</style>
      <svg id="s"></svg>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        for (const [n, id] of [['foreignObject', 'f'], ['linearGradient', 'g'], ['clipPath', 'c']]) {
          const e = document.createElementNS('http://www.w3.org/2000/svg', n);
          e.id = id;
          document.getElementById('s').appendChild(e);
        }
        const g = (id, p) => getComputedStyle(document.getElementById(id))[p];
        return [g('f', 'marginLeft'), g('g', 'marginTop'), g('c', 'paddingLeft')];
      })()
    JS
    expect(got).to eq(%w[7px 4px 2px])
  end

  # An element's inline declarations are part of its style however they are written: the style attribute and a CSSOM
  # `style` write alike, after the element was styled.
  it 'sees an inline style written after the element was styled' do
    html = '<!DOCTYPE html><style>.inl { width: 50px }</style><div class="inl" id="inl" style="width: 55px">i</div>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const el = document.getElementById('inl'), out = [];
        const w = () => out.push(getComputedStyle(el).width);
        w();
        el.style.width = '57px'; w();
        el.setAttribute('style', 'width: 58px !important'); w();
        el.removeAttribute('style'); w();
        return out;
      })()
    JS
    expect(got).to eq(%w[55px 57px 58px 50px])
  end
end
