# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A checked radio button inserted unchecks the rest of its group, the last in tree order winning (HTML §4.10.5.1.15,
# "the element is inserted") — whichever way it is inserted, the parser's way too (Chrome: `[false, true, …]`).
RSpec.describe 'the radio buttons\' insertion steps' do
  let(:page_html) {
    '<!DOCTYPE html><meta charset=utf-8><body><form><input type=radio name=a id=a1 checked>' \
      '<input type=radio name=a id=a2 checked></form><div id=d></div>'
  }
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page_html]] }) }

  it 'unchecks the rest of the group as a checked one is parsed, set as HTML or appended' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const r = [a1.checked, a2.checked];
        d.innerHTML = '<input type=radio name=b id=b1 checked><input type=radio name=b id=b2 checked>';
        r.push(b1.checked, b2.checked);
        const f = document.createElement('div');
        f.innerHTML = '<input type=radio name=a id=a3 checked>';
        document.querySelector('form').append(f);
        r.push(a1.checked, a2.checked, a3.checked);
        return r;
      })()
    JS
    expect(got).to eq([false, true, false, true, false, false, true])
  end
end
