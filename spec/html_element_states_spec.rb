require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTMLElement's states its reflected members answer, the engine's (reflect.rs `elementReflection`).
#
# Autocapitalization and autocorrection (§6.8.6, §6.8.7): an element's own state, else —
# for a button, fieldset, input, output, select or textarea with a form owner — that form's, else the default. An
# empty `autocapitalize` is no state of its own (`off` is none, `on` and an invalid value sentences); an `autocorrect`
# present is its state whatever its value (on but for `off`), and an input whose type has no autocorrection has none.
RSpec.describe 'HTML element states' do
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

  # `spellcheck`: true or '' on, false off — any other value, or none, the parent element's (Chrome 155 and Firefox both
  # inherit it; with no parent element on, as Chrome has it, where Firefox says off).
  it 'inherits spellcheck where an element states none' do
    s = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><div spellcheck=false><span id=s></span><p id=p spellcheck=bogus></p><i id=e spellcheck=""></i></div><b spellcheck=true><u id=u></u></b>']]
    })
    s.visit '/'
    expect(s.evaluate_script("['s', 'p', 'e', 'u'].map((id) => document.getElementById(id).spellcheck).concat(document.createElement('div').spellcheck)")).to eq(
      [false, false, true, true, true]
    )
  end

  # `draggable` (§6.11.7): true or false, ASCII case-insensitive — any other value, or none, auto: an img's and an `a`
  # with an href's true. Chrome 155 and Firefox: `TRUE` true, an invalid value auto; an `area` with an href Chrome says
  # true, the spec and Firefox false.
  it 'reads draggable by its state' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8">']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const mk = (tag, attrs) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e.draggable; };
        return [mk('div', {draggable: 'TRUE'}), mk('img', {draggable: 'bogus'}), mk('img', {draggable: 'auto'}), mk('area', {href: '/x'}),
                mk('a', {href: '/x'}), mk('a', {}), mk('img', {draggable: 'False'})];
      })()
    JS
    expect(got).to eq([true, true, true, false, true, false, false])
  end
end
