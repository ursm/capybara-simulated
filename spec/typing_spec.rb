# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# The user typing into a text control (text_selection.rs `type_text`): at its selection, `maxlength` cutting it short,
# a number field refusing a keystroke that leaves no number being entered. Every expectation is Chrome's.
RSpec.describe 'typing into a text control' do
  it 'inserts at the selection, cut at maxlength, a number field keeping a number' do
    html = <<~HTML
      <!DOCTYPE html><input id=m maxlength=3><input id=n type=number><input id=s value=hello><textarea id=t maxlength=" 4x"></textarea>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|session| session.visit '/' }
    s.find(:css, '#m').send_keys('abcde')
    s.find(:css, '#n').send_keys('1e+1-')
    s.execute_script("const s = document.getElementById('s'); s.focus(); s.setSelectionRange(1, 3);")
    s.find(:css, '#s').send_keys('X')
    s.find(:css, '#t').send_keys('abcdef')
    expect(s.evaluate_script(<<~JS)).to eq(['abc', '1e+1', false, 'hXlo', 2, 'abcd'])
      (() => {
        const g = (id) => document.getElementById(id);
        return [g('m').value, g('n').value, g('n').validity.badInput, g('s').value, g('s').selectionStart, g('t').value];
      })()
    JS
  end
end
