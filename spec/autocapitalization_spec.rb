require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML autocapitalization and autocorrection (§6.8.6, §6.8.7), the engine's (reflect.rs): an element's own state, else —
# for a button, fieldset, input, output, select or textarea with a form owner — that form's, else the default. An
# empty `autocapitalize` is no state of its own (`off` is none, `on` and an invalid value sentences); an `autocorrect`
# present is its state whatever its value (on but for `off`), and an input whose type has no autocorrection has none.
RSpec.describe 'autocapitalization and autocorrection' do
  it "reads an element's own state, else a form control's form owner's" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8">']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const form = document.body.appendChild(document.createElement('form'));
        form.setAttribute('autocapitalize', 'words');
        form.setAttribute('autocorrect', 'off');
        const input = form.appendChild(document.createElement('input'));
        const empty = form.appendChild(document.createElement('textarea'));
        empty.setAttribute('autocapitalize', '');
        const div = form.appendChild(document.createElement('div'));
        const own = document.createElement('div');
        const states = ['off', 'on', 'CHARACTERS', 'bogus'].map((v) => { own.setAttribute('autocapitalize', v); return own.autocapitalize; });
        const email = document.createElement('input');
        email.type = 'email';
        email.setAttribute('autocorrect', 'on');
        const bogus = form.appendChild(document.createElement('select'));
        bogus.setAttribute('autocorrect', 'bogus');
        return [input.autocapitalize, empty.autocapitalize, div.autocapitalize, document.createElement('p').autocapitalize, states,
                input.autocorrect, div.autocorrect, email.autocorrect, bogus.autocorrect];
      })()
    JS
    expect(got).to eq(['words', 'words', '', '', ['none', 'sentences', 'characters', 'sentences'], false, true, false, true])
  end
end
