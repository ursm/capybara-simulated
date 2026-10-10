# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A form's named controls ([LegacyOverrideBuiltIns], HTML §4.10.3) shadow its prototype's members — `form.submit` is
# an `<input name=submit>` — but not the driver's own: a control named like one of its `_`-prefixed internals
# (`_ownerDoc`, `_nodeName`) left the form's document, tag name and clones the driver's to read, where it had answered
# them with the input. An author's `_`-prefixed name that is no member (Rails's `_method`) still resolves.
RSpec.describe 'a form named control' do
  let(:session) {
    simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset=utf-8><body>
        <form id=f><input name="_ownerDoc"><input name="_nodeName"><input name="_method"><input name="submit"></form>
      HTML
    })
  }

  before { session.visit '/' }

  it "resolves an author's names, the driver's internals not" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const f = document.getElementById('f');
        return [f.ownerDocument === document, f.tagName, f._method.name, f.submit.name, f.cloneNode(true).ownerDocument === document];
      })()
    JS
    expect(got).to eq([true, 'FORM', '_method', 'submit', true])
  end
end
