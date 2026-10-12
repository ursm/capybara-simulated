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

  # The editing keys: Backspace / Delete remove the selection or the character before / after the caret, a surrogate
  # pair one; the arrows collapse a selection to its start / end or step a character; Home / End go to the ends of the
  # caret's line in a textarea.
  it 'takes the editing keys as Chrome does' do
    html = "<!DOCTYPE html><meta charset=utf-8><input id=i value=hello><textarea id=t>ab\ncd</textarea>"
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|session| session.visit '/' }
    state = ->(id) { s.evaluate_script("(() => { const e = document.getElementById('#{id}'); return [e.value, e.selectionStart, e.selectionEnd]; })()") }
    press = ->(id, from, to, key, value = nil) {
      s.execute_script("(() => { const e = document.getElementById('#{id}'); #{value ? "e.value = #{value.to_json};" : ''} e.focus(); e.setSelectionRange(#{from}, #{to}); })()")
      s.find(:css, "##{id}").send_keys(key)
      state.(id)
    }
    expect([
      press.('i', 1, 3, :left), press.('i', 1, 3, :right), press.('i', 1, 3, :delete), press.('i', 1, 1, :delete),
      press.('i', 3, 3, :backspace, "a\u{1F600}b"), press.('i', 1, 1, :delete, "a\u{1F600}b"), press.('i', 1, 1, :right, "a\u{1F600}b"),
      press.('t', 4, 4, :home), press.('t', 1, 1, :end), press.('i', 0, 0, :backspace)
    ]).to eq([
      ['hello', 1, 1], ['hello', 3, 3], ['hlo', 1, 1], ['ho', 1, 1], ['ab', 1, 1], ['ab', 1, 1], ["a\u{1F600}b", 3, 3],
      ["ab\ncd", 3, 3], ["ab\ncd", 2, 2], ["a\u{1F600}b", 0, 0]
    ])
  end
end
