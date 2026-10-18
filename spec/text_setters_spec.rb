# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The nodes the `innerText` / `outerText` setters put in place are of the element's realm's interfaces, whichever
# realm's setter is called on it (text_setters.rs): a frame's setter called on the page's element makes the page's Text
# and `<br>`, as Chrome 154 and Firefox do — they had been the frame's.
RSpec.describe 'the innerText and outerText setters' do
  it "make the element's realm's nodes, whichever realm's setter runs" do
    page = '<!DOCTYPE html><meta charset=utf-8><body><p id=p>x</p><span id=s>y</span><iframe srcdoc="<p>f"></iframe>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const setter = (name) => Object.getOwnPropertyDescriptor(frames[0].HTMLElement.prototype, name).set;
        const p = document.getElementById('p'), span = document.getElementById('s');
        setter('innerText').call(p, 'e\\nf');
        setter('outerText').call(span, 'g\\nh');
        const mine = (n) => n instanceof Text ? 'Text' : n instanceof HTMLBRElement ? 'BR' : 'other';
        return [[...p.childNodes].map(mine), [...document.body.childNodes].slice(1, 4).map(mine)];
      })()
    JS
    expect(got).to eq([%w[Text BR Text], %w[Text BR Text]])
  end
end
