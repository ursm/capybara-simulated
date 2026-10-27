# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An element's state the engine keeps — focus, `:checked`, `:popover-open`, `:modal`, `:indeterminate`, `:defined` —
# is a dynamic pseudo-class's input, and its write moves the style-state generation itself (dom.rs `set_state`): the
# memo of what is rendered (rendered.rs `Answered`) keys on it, and a state write moves no other generation. Each read
# below comes after a read that kept the memo, so a write the memo did not hear of answers from before it.
RSpec.describe 'the style-state generation' do
  it 'moves with each state the engine keeps, whoever writes it' do
    html = <<~HTML
      <!DOCTYPE html><meta charset="utf-8">
      <style>
        #f:focus + i, #c:indeterminate + i, #p:popover-open + i, x-e:defined + i { display: none }
      </style>
      <input id=f><i id=a>a</i>
      <input type=checkbox id=c><i id=b>b</i>
      <div id=p popover>p</div><i id=d>d</i>
      <x-e></x-e><i id=e>e</i>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    shown = -> { %w[a b d e].map {|id| s.find("##{id}", visible: :all).visible? } }
    expect(shown.call).to eq([true, true, true, true])
    s.execute_script("document.getElementById('f').focus()")
    s.execute_script("document.getElementById('c').indeterminate = true")
    s.execute_script("document.getElementById('p').showPopover()")
    s.execute_script("customElements.define('x-e', class extends HTMLElement {})")
    expect(shown.call).to eq([false, false, false, false])
  end
end
