# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Two paths wrote an input's `value` CONTENT ATTRIBUTE straight into the attribute store: a type change carrying the
# live value into a default-mode type (HTML "value → content attribute"), and Capybara's `set('<string>')` on a
# checkbox / radio. Neither was recorded — no MutationObserver record, and no context change, so a `[value=…]` rule
# kept styling the old value. Both are ordinary attribute writes now. Chrome-measured for the type change: records
# `type` then `value`, and the rule applies.
RSpec.describe 'input value attribute writes' do
  def session(html)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s
  end

  it 'records the value a type change writes' do
    s = session('<!DOCTYPE html><style>input[value="x"] { margin-left: 5px }</style><input id="i">')
    got = s.evaluate_script(<<~JS)
      (() => {
        const i = document.getElementById('i'), mo = new MutationObserver(() => {});
        getComputedStyle(i).marginLeft;
        mo.observe(i, { attributes: true });
        i.value = 'x';
        i.setAttribute('type', 'radio');
        return [mo.takeRecords().map((m) => m.attributeName), i.getAttribute('value'), getComputedStyle(i).marginLeft];
      })()
    JS
    expect(got).to eq([%w[type value], 'x', '5px'])
  end

  it "records the value a checkbox's set(string) writes" do
    s = session('<!DOCTYPE html><style>input[value="foo"] { margin-left: 5px }</style><input type="checkbox" id="cb">')
    s.execute_script(<<~JS)
      const cb = document.getElementById('cb');
      getComputedStyle(cb).marginLeft;
      globalThis.__names = [];
      new MutationObserver((list) => { for (const m of list) __names.push(m.attributeName); }).observe(cb, { attributes: true });
    JS
    s.find(:css, '#cb').set('foo')
    got = s.evaluate_script("[__names, getComputedStyle(document.getElementById('cb')).marginLeft]")
    expect(got).to eq([%w[value], '5px'])
  end
end
