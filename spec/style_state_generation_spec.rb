# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An element's state the engine keeps — focus, `:checked`, `:popover-open`, `:modal`, `:indeterminate`, `:defined` — a
# control's live value, a custom validity, a custom state and the target are dynamic pseudo-classes' inputs, and their
# writes move the style-state generation themselves (dom.rs `set_state`, `write_live_value`, `set_custom_states`,
# `set_target`; validity.rs `set_custom_validity`), which the memo of what is rendered (rendered.rs `Answered`) keys on.
# A state write moves no other generation, so the first example holds `set_state`'s alone; the second's writes move
# another one too as they are made today (a layout mark, the settle generation), and hold the answer, not the word. Each read
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
    # (…each write on its own, read after it: one that moved nothing reads as before)
    s.execute_script("document.getElementById('f').focus()")
    expect(shown.call).to eq([false, true, true, true])
    s.execute_script("document.getElementById('c').indeterminate = true")
    expect(shown.call).to eq([false, false, true, true])
    s.execute_script("document.getElementById('p').showPopover()")
    expect(shown.call).to eq([false, false, false, true])
    s.execute_script("customElements.define('x-e', class extends HTMLElement {})")
    expect(shown.call).to eq([false, false, false, false])
  end

  # …and in the realm whose arena holds the element, whichever realm's code writes it: one adopted from a frame into
  # the page, written by the frame's setters — its `:indeterminate`, `:checked` and `:invalid` — moves the page's memo.
  it "moves the element's realm's, written by another realm's code" do
    app = lambda {|env|
      body = if env['PATH_INFO'] == '/f'
               '<input type=checkbox id=c><input id=v>'
             else
               '<style>#c:indeterminate + i, #c:checked + i + b, #v:invalid + u { display: none }</style>' \
                 '<div id=h1></div><i id=i>i</i><b id=b>b</b><div id=h2></div><u id=u>u</u><iframe src="/f"></iframe>'
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{body}"]]
    }
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      const d = frames[0].document;
      document.getElementById('h1').replaceWith(d.getElementById('c'));
      document.getElementById('h2').replaceWith(d.getElementById('v'));
    JS
    shown = -> { %w[i b u].map {|id| s.find("##{id}", visible: :all).visible? } }
    expect(shown.call).to eq([true, true, true])
    s.execute_script("document.getElementById('c').indeterminate = true")
    expect(shown.call).to eq([false, true, true])
    s.execute_script("document.getElementById('c').click()")
    expect(shown.call).to eq([true, false, true])
    s.execute_script("document.getElementById('v').setCustomValidity('no')")
    expect(shown.call).to eq([true, false, false])
  end

  it 'moves with a live value, a custom validity, a custom state and the target' do
    html = <<~HTML
      <!DOCTYPE html><meta charset="utf-8">
      <style>
        #v:placeholder-shown + i, #c:invalid + i, x-s:state(on) + i, #t:target + i { display: none }
      </style>
      <input id=v placeholder=p value=x><i id=a>a</i>
      <input id=c><i id=b>b</i>
      <x-s></x-s><i id=d>d</i>
      <div id=t></div><i id=e>e</i>
      <script>
        customElements.define('x-s', class extends HTMLElement {
          constructor() { super(); this.i = this.attachInternals(); }
        });
      </script>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    shown = -> { %w[a b d e].map {|id| s.find("##{id}", visible: :all).visible? } }
    expect(shown.call).to eq([true, true, true, true])
    s.execute_script("document.getElementById('v').value = ''")
    s.execute_script("document.getElementById('c').setCustomValidity('no')")
    s.execute_script("document.querySelector('x-s').i.states.add('on')")
    s.execute_script("location.hash = '#t'")
    expect(shown.call).to eq([false, false, false, false])
  end
end
