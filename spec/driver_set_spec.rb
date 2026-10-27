# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Capybara's `Element#set` decides what to do by what the element is (keys.rs `set_plan`) — asked again once it is
# focused, as its focus handlers left it: a checkbox one checked needs no click, an input one made a checkbox is clicked,
# an element one made read-only, or focused instead of it, is not written. An element of another namespace named `input`
# in an editing host is the host's content, typed into a key at a time as the host's — not given a value.
RSpec.describe 'Element#set' do
  def session_for(body)
    html = "<!DOCTYPE html><meta charset=\"utf-8\"><body>#{body}<script>window.log = []; " \
           "for (const t of ['keydown', 'input', 'change', 'keyup']) document.addEventListener(t, (e) => log.push(t), true);</script>"
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|s| s.visit '/' }
  end

  it 'decides what to do with the element as its focus handlers left it' do
    s = session_for(<<~HTML)
      <input type=checkbox id=c onfocus="this.checked = true">
      <input id=t onfocus="this.type = 'checkbox'">
      <div contenteditable id=h onfocus="document.getElementById('ro').focus()"><input id=ro readonly value=orig></div>
    HTML
    s.find('#c').set(true)
    s.find('#t').set(true)
    s.find('#h').set('x')
    expect(s.evaluate_script(<<~JS)).to eq([true, ['checkbox', true], 'orig'])
      [document.getElementById('c').checked,
       [document.getElementById('t').type, document.getElementById('t').checked],
       document.getElementById('ro').value]
    JS
  end

  it "types into another namespace's input in an editing host as the host's content" do
    s = session_for('<div contenteditable><svg><input xmlns="http://www.w3.org/2000/svg" id=i>t</input></svg></div>')
    s.find('#i', visible: :all).set('ab')
    expect(s.evaluate_script("log.filter((t) => t === 'keydown').length")).to eq(2)
  end
end
