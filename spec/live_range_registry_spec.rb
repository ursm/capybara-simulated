# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A document updates its live ranges on every mutation (DOM §4.5), and holds them weakly: a range a script dropped is
# neither updated nor walked again, where the strong set kept every range ever made for the page's life — each walked,
# ancestor by ancestor, on every removal. A range the page still holds keeps being updated.
RSpec.describe 'live range registry' do
  it 'lets go of the ranges a script dropped and keeps updating the ones it holds' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body><p id=p>a<b>b</b>c</p>']] })
    s.visit '/'
    s.execute_script(<<~JS)
      const p = document.getElementById('p');
      for (let i = 0; i < 5000; i++) { const r = document.createRange(); r.selectNodeContents(p); }
      window.__held = document.createRange();
      __held.setStart(p, 2);
    JS
    s.evaluate_script('0')
    2.times { s.driver.browser.instance_variable_get(:@runtime).ctx.low_memory_notification }
    got = s.evaluate_script(<<~JS)
      (() => {
        const p = document.getElementById('p');
        p.removeChild(p.firstChild);                 // walks the registry: the dropped ranges leave it
        return [document._liveRanges.size, __held.startOffset];
      })()
    JS
    expect(got).to eq([1, 1])
  end
end
