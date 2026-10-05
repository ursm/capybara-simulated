# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Location's operations are IDL operations: each checks its `this` is a Location and counts its arguments. Called on
# anything else, `assign` had navigated the page to `undefined` — which is how idlharness's "calling an operation on
# the wrong `this` must throw" check took html/dom/idlharness.https.html off its own page. Each expectation is Chrome's
# (154.0.8037.92).
RSpec.describe 'Location operations' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }) }

  before { session.visit '/start' }

  it "refuses a `this` that is no Location, and stays where it is" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const thrown = (f) => { try { f(); return 'no'; } catch (e) { return e.constructor.name + ': ' + e.message; } };
        return [
          thrown(() => location.assign.call({}, 'x')),
          thrown(() => location.replace.call(5, 'x')),
          thrown(() => location.reload.call({})),
          thrown(() => location.assign())
        ];
      })()
    JS
    expect(got).to eq([
      'TypeError: Illegal invocation',
      'TypeError: Illegal invocation',
      'TypeError: Illegal invocation',
      "TypeError: Failed to execute 'assign' on 'Location': 1 argument required, but only 0 present."
    ])
    expect(session.evaluate_script('location.pathname')).to eq('/start')
  end

  it 'gives each operation the length of its required arguments, and still navigates' do
    expect(session.evaluate_script('[location.assign.length, location.replace.length, location.reload.length]')).to eq([1, 1, 0])
    session.execute_script("location.assign('#zz')")
    expect(session.evaluate_script('location.hash')).to eq('#zz')
  end
end
