# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A script element is an HTML or an SVG `script` (HTML §4.12.1, SVG 2 §15.2) — by its local name in its namespace, not
# its lowercased tag name: `createElementNS(XHTML, 'SCRIPT')` is an HTMLUnknownElement, whose text runs nowhere. A
# prefixed one is a script. Chrome 155: ["h:script", "svg", "html"].
RSpec.describe 'a script element' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }) }

  before { session.visit '/' }

  it 'runs as an HTML or SVG script, and not as an element with a script-like tag name' do
    got = session.evaluate_script(<<~JS)
      (() => {
        window.ran = [];
        const XHTML = 'http://www.w3.org/1999/xhtml', SVG = 'http://www.w3.org/2000/svg';
        const upper = document.createElementNS(XHTML, 'SCRIPT');
        upper.textContent = "ran.push('SCRIPT')";
        document.body.append(upper);
        const prefixed = document.createElementNS(XHTML, 'h:script');
        prefixed.textContent = "ran.push('h:script')";
        document.body.append(prefixed);
        const svg = document.body.appendChild(document.createElementNS(SVG, 'svg'));
        const svgScript = document.createElementNS(SVG, 'script');
        svgScript.textContent = "ran.push('svg')";
        svg.append(svgScript);
        const html = document.createElement('script');
        html.textContent = "ran.push('html')";
        document.body.append(html);
        return ran;
      })()
    JS
    expect(got).to eq(['h:script', 'svg', 'html'])
  end
end
