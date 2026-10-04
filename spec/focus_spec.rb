# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Which elements take focus (HTML "focusable area", focus.rs) and where Tab takes it. Each figure is Chrome's on this
# machine (measured), and Firefox agrees: a `<details>` is no focus stop and its summary is (only the first summary of
# a details); a control in a closed `<details>`, a `visibility: hidden` one and one in an inert host's shadow tree take
# no focus; an `<input>` in the SVG namespace is no control; a `tabindex` past the IDL `long` is no tabindex at all.
RSpec.describe 'focus' do
  def session_with(html)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><body>#{html}"]] })
    s.visit '/'
    s
  end

  it 'takes focus only to a focusable area' do
    s = session_with(<<~HTML)
      <details id=d1><summary id=s1>S</summary><input id=inclosed></details>
      <details id=d2 open><summary id=s2>S2</summary><summary id=s3>S3</summary></details>
      <summary id=s4>loose</summary>
      <input id=vh style="visibility:hidden">
      <div id=big tabindex="99999999999">big</div>
      <div id=inerthost inert></div>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const takes = (el) => { document.activeElement.blur(); el.focus(); return document.activeElement === el; };
        const svgInput = document.body.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'input'));
        const sr = document.getElementById('inerthost').attachShadow({mode: 'open'});
        sr.innerHTML = '<button>b</button>';
        const ids = ['d1', 's1', 'inclosed', 'd2', 's2', 's3', 's4', 'vh', 'big'];
        return ids.map((id) => takes(document.getElementById(id))).concat([takes(svgInput), takes(sr.firstChild), big.tabIndex]);
      })()
    JS
    expect(got).to eq([false, true, false, false, true, false, false, false, false, false, false, -1])
  end

  # An element made in a frame's document and adopted into this one is focused in this one, and a host adopted so keeps
  # delegating focus: Tab goes on into its shadow tree.
  it 'focuses an element adopted from a frame where it is now' do
    s = session_with('<button id=before>before</button><iframe></iframe>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const frameDoc = document.querySelector('iframe').contentDocument;
        const x = document.body.appendChild(frameDoc.createElement('input'));
        x.focus();
        const focusedHere = document.activeElement === x;
        const host = frameDoc.createElement('div');
        host.tabIndex = 0;
        host.attachShadow({mode: 'open', delegatesFocus: true}).innerHTML = '<input id=inner>';
        document.body.insertBefore(host, document.querySelector('iframe'));
        return focusedHere;
      })()
    JS
    expect(got).to be(true)
    s.find(:css, '#before').click
    s.send_keys(:tab)
    expect(s.evaluate_script("document.activeElement.shadowRoot && document.activeElement.shadowRoot.activeElement.id")).to eq('inner')
  end
end
