# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Which elements take focus (HTML "focusable area", focus.rs) and where Tab takes it. Each figure is Chrome's on this
# machine (measured), and Firefox agrees: a `<details>` is no focus stop and its summary is (only the first summary of
# a details); a control in a closed `<details>`, a `visibility: hidden` one and one in an inert host's shadow tree take
# no focus, nor content assigned to a slot inside an inert element; an `<input>` in the SVG namespace is no control; a
# `tabindex` past the IDL `long` is no tabindex at all.
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
      <div id=slothost><input id=slotted></div>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const takes = (el) => { document.activeElement.blur(); el.focus(); return document.activeElement === el; };
        const svgInput = document.body.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'input'));
        const sr = document.getElementById('inerthost').attachShadow({mode: 'open'});
        sr.innerHTML = '<button>b</button>';
        document.getElementById('slothost').attachShadow({mode: 'open'}).innerHTML = '<div inert><slot></slot></div>';
        const ids = ['d1', 's1', 'inclosed', 'd2', 's2', 's3', 's4', 'vh', 'big', 'slotted'];
        return ids.map((id) => takes(document.getElementById(id))).concat([takes(svgInput), takes(sr.firstChild), big.tabIndex]);
      })()
    JS
    expect(got).to eq([false, true, false, false, true, false, false, false, false, false, false, false, -1])
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

  # `tabIndex` with no `tabindex`: 0 for the elements HTML lists — an SVG `<a>`, and a `<summary>` only as its details'
  # summary, included — and -1 for the rest. Chrome and Firefox agree on every one (measured) but `<audio>` and
  # `<video>`, which both answer 0 for, against the spec's list.
  it 'defaults tabIndex by the HTML list' do
    s = session_with(<<~HTML)
      <a id=a1 href="#">a</a><a id=a2>a</a><button id=b>b</button><iframe id=f></iframe><object id=o></object>
      <details id=d><summary id=s1>x</summary><summary id=s2>y</summary></details><summary id=s3>z</summary>
      <embed id=e src="x"><video id=v controls></video><div id=ce contenteditable>ce</div>
      <svg><a id=sa><text>t</text></a></svg>
    HTML
    got = s.evaluate_script(<<~JS)
      ['a1', 'a2', 'b', 'f', 'o', 'd', 's1', 's2', 's3', 'e', 'v', 'ce', 'sa'].map((id) => document.getElementById(id).tabIndex)
        .concat([document.createElementNS('http://www.w3.org/2000/svg', 'input').tabIndex,
                 document.createElementNS('http://www.w3.org/1999/xhtml', 'BUTTON').tabIndex])
    JS
    expect(got).to eq([0, 0, 0, 0, 0, -1, 0, -1, -1, -1, -1, -1, 0, -1, -1])
  end

  # HTML "get the focusable area" of a shadow host that delegates focus: the focused element where it is under the host
  # already (slotted, or in a nested shadow tree), else its focus delegate — the tree's first `autofocus` descendant
  # standing for a focusable area (a nested delegating host its own), not one of a nested tree's, else its first
  # descendant standing for one. Chrome 2026-10-10, each of these (Firefox agrees on T1, T2, T5, T6).
  it 'focuses what a host that delegates focus stands for' do
    s = session_with('')
    got = s.evaluate_script(<<~'JS')
      function deepActive() { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a ? (a.id || a.tagName) : null; }
      function mk(html, df = true) { const h = document.createElement('div'); h.className = 'h'; document.body.append(h); h.attachShadow({ mode: 'open', delegatesFocus: df }).innerHTML = html; return h; }
      function nested(host, sel, html, df) { const n = host.shadowRoot.querySelector(sel); n.attachShadow({ mode: 'open', delegatesFocus: df }).innerHTML = html; return n; }
      function run() {
        const r = {};
        // T1 focused slotted light child
        let h = mk('<input id=a><slot></slot>'); h.innerHTML = '<input id=lb>'; h.querySelector('#lb').focus(); h.focus(); r.T1_slotted_focused = deepActive(); h.remove();
        // T2 focused elem inside nested non-delegating focusable host
        h = mk('<input id=a><div id=nh tabindex=-1></div>'); nested(h, '#nh', '<input id=ni>', false); h.shadowRoot.querySelector('#nh').shadowRoot.querySelector('#ni').focus(); r.T2_before = deepActive(); h.focus(); r.T2_nested_nondelegating = deepActive(); h.remove();
        // T3 autofocus inside nested NON-delegating host
        h = mk('<div id=nh></div><input id=y>'); nested(h, '#nh', '<input id=x autofocus>', false); document.body.focus(); document.activeElement.blur(); h.focus(); r.T3 = deepActive(); h.remove();
        // T4a slot fallback, no assigned
        h = mk('<slot><input id=fb></slot><input id=after>'); h.focus(); r.T4a_fallback = deepActive(); h.remove();
        // T4b slot fallback with assigned (fallback not rendered)
        h = mk('<slot><input id=fb></slot><input id=after>'); h.innerHTML = '<input id=lc>'; h.focus(); r.T4b_fallback_assigned = deepActive(); h.remove();
        // T5 autofocus on a delegating nested host
        h = mk('<input id=first><div id=xi autofocus></div>'); nested(h, '#xi', '<input id=inner1>', true); h.focus(); r.T5_autofocus_host = deepActive(); h.remove();
        // T6 autofocus deep in a nested delegating host (host no autofocus)
        h = mk('<input id=first><div id=xi></div>'); nested(h, '#xi', '<input id=i1><input id=i2 autofocus>', true); h.focus(); r.T6_nested_autofocus = deepActive(); h.remove();
        // T7 disabled / hidden / inert
        h = mk('<input id=dis disabled><input id=hid hidden><div inert><input id=inr></div><input id=vh style="visibility:hidden"><input id=ok>'); h.focus(); r.T7 = deepActive(); h.remove();
        // T8 nested delegating host whose shadow has a focused element, from outer focus
        h = mk('<input id=first><div id=xi></div>'); const xi = nested(h, '#xi', '<input id=i1><input id=i2>', true); xi.shadowRoot.querySelector('#i2').focus(); document.activeElement.blur(); h.focus(); r.T8_after_blur = deepActive(); h.remove();
        // T9 focused in nested delegating; host.focus again keeps
        h = mk('<input id=first><div id=xi></div>'); const xi2 = nested(h, '#xi', '<input id=i1><input id=i2>', true); xi2.shadowRoot.querySelector('#i2').focus(); h.focus(); r.T9_keep = deepActive(); h.remove();
        // T10 autofocus element that is not focusable followed by autofocus focusable
        h = mk('<input id=a1 autofocus disabled><input id=b><input id=a2 autofocus>'); h.focus(); r.T10 = deepActive(); h.remove();
        // T11 host itself focusable (tabindex) with delegatesFocus and no focusable in shadow
        h = mk('<span>t</span>'); h.tabIndex = 0; h.focus(); r.T11_host_tabindex_empty = deepActive(); h.remove();
        // T12 autofocus inside a slot fallback
        h = mk('<input id=first><slot><input id=fbaf autofocus></slot>'); h.focus(); r.T12 = deepActive(); h.remove();
        return r;
      }
      run()
    JS
    expect(got).to eq(
      'T1_slotted_focused' => 'lb', 'T2_before' => 'ni', 'T2_nested_nondelegating' => 'ni', 'T3' => 'y',
      'T4a_fallback' => 'fb', 'T4b_fallback_assigned' => 'after', 'T5_autofocus_host' => 'inner1',
      'T6_nested_autofocus' => 'first', 'T7' => 'ok', 'T8_after_blur' => 'first', 'T9_keep' => 'i2', 'T10' => 'a2',
      'T11_host_tabindex_empty' => 'BODY', 'T12' => 'fbaf'
    )
  end
end
