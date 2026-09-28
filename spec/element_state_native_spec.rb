# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The element states no attribute records — checkedness, selectedness, focus, hover, an open popover, a modal dialog —
# live in the native arena beside the tree (dom.rs `STATE_*`, written wherever the JS DOM changes one), and the native
# matcher derives the rest from attributes and the tree (element_state.rs): `:disabled` through a `<fieldset>`,
# `:read-write`, `:default`. So a state pseudo-class is answered natively, not handed back to css-select, and each
# answer here is held against both css-select's and the HTML rule's.
RSpec.describe 'element state in the native arena' do
  STATE_PAGE = <<~HTML
    <!DOCTYPE html>
    <form id="f">
      <input type="checkbox" id="c1" checked><input type="checkbox" id="c2"><input type="checkbox" id="c3">
      <input type="radio" name="r" id="r1"><input type="radio" name="r" id="r2" checked>
      <input type="CheckBox" id="c4" checked>
      <select id="s"><option id="o1">a</option><option id="o2" selected>b</option><option id="o3">c</option></select>
      <fieldset disabled id="fs">
        <legend><input id="in-legend"></legend>
        <input id="in-fs"><optgroup id="og"></optgroup>
      </fieldset>
      <select disabled><optgroup><option id="o-dis">x</option></optgroup></select>
      <input id="ph" placeholder="p"><input id="ph-val" placeholder="p" value="v"><textarea id="ph-ta" placeholder="p"></textarea>
      <input id="ro" readonly><input id="rw"><input id="bogus-type" type="nonsense"><textarea id="ta"></textarea>
      <div contenteditable id="ce"><span id="ce-kid">k</span><b contenteditable="false" id="ce-off">o</b></div>
      <button id="b-submit">s</button><button type="button" id="b-button">b</button><button type="Nonsense" id="b-odd">o</button>
      <input type="submit" id="i-submit">
    </form>
    <details open id="det"><summary>s</summary></details>
    <dialog id="dlg">d</dialog>
    <div popover id="pop">p</div>
    <div id="hover-outer"><p id="hover-inner">h</p></div>
    <div id="host"></div>
  HTML

  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [STATE_PAGE]] }) }

  # The ids `sel` matches natively, or :fallback when native declined it, after checking it against css-select.
  def native_ids(sel)
    got = session.evaluate_script(<<~JS)
      (() => {
        const sel = #{sel.to_json};
        const nids = __dom.queryIds(document._nid, sel, false);
        if (nids === undefined) return 'FALLBACK';
        const byNid = new Map([...document.querySelectorAll('*')].map((e) => [e._nid, e]));
        const nat = nids.map((n) => byNid.get(n)?.id ?? '?');
        const css = [...document.querySelectorAll(sel)].map((e) => e.id);
        return JSON.stringify(nat) === JSON.stringify(css) ? nat : 'MISMATCH native=' + nat + ' css=' + css;
      })()
    JS
    got == 'FALLBACK' ? :fallback : got
  end

  before { session.visit '/' }

  it 'answers checkedness and selectedness, dirty or clean' do
    expect(native_ids('input:checked')).to eq(%w[c1 r2 c4])
    session.execute_script(<<~JS)
      document.getElementById('c1').checked = false;
      document.getElementById('c2').click();
      document.getElementById('r1').checked = true;
      document.getElementById('c3').indeterminate = true;
      document.getElementById('s').value = 'c';
    JS
    expect(native_ids('input:checked')).to eq(%w[c2 r1 c4])
    expect(native_ids(':indeterminate')).to eq(%w[c3])
    # The disabled select's one option is its selected one.
    expect(native_ids('option:checked')).to eq(%w[o3 o-dis])
    expect(native_ids(':selected')).to eq(%w[o3 o-dis])
    # A form reset drops the dirty flag: the `checked` attribute stands for checkedness again.
    session.execute_script("document.querySelector('form').reset()")
    expect(native_ids('input:checked')).to eq(%w[c1 r2 c4])
  end

  it 'derives :disabled, :enabled, :read-write, :read-only and :default from the tree' do
    expect(native_ids('input:disabled')).to eq(%w[in-fs])
    # An `<optgroup>` is disabled by its own attribute only; an option by its `<select>`'s too.
    expect(native_ids('#og:disabled, #o-dis:disabled, #in-legend:enabled')).to eq(%w[in-legend o-dis])
    expect(native_ids('input:read-write, textarea:read-write')).to eq(%w[in-legend ph ph-val ph-ta rw bogus-type ta])
    expect(native_ids('#ce :read-write, #ce:read-write')).to eq(%w[ce ce-kid])
    expect(native_ids('#ce-off:read-only')).to eq(%w[ce-off])
    expect(native_ids(':default')).to eq(%w[c1 r2 c4 o2 b-submit b-odd i-submit])
    session.execute_script("document.getElementById('fs').disabled = false")
    expect(native_ids('input:disabled')).to eq([])
  end

  it 'answers :placeholder-shown from the live value' do
    expect(native_ids(':placeholder-shown')).to eq(%w[ph ph-ta])
    session.find('#ph').fill_in(with: 'x')
    session.execute_script(<<~JS)
      document.getElementById('ph-val').value = '';
      document.getElementById('ph-ta').textContent = 'text';
    JS
    expect(native_ids(':placeholder-shown')).to eq(%w[ph-val])
    session.execute_script("document.querySelector('form').reset()")
    expect(native_ids(':placeholder-shown')).to eq(%w[ph])
  end

  it 'answers :open, :modal and :popover-open' do
    session.execute_script(<<~JS)
      document.getElementById('dlg').showModal();
      document.getElementById('pop').showPopover();
    JS
    expect(native_ids(':open')).to eq(%w[det dlg])
    expect(native_ids(':modal')).to eq(%w[dlg])
    expect(native_ids(':popover-open')).to eq(%w[pop])
    session.execute_script(<<~JS)
      document.getElementById('dlg').close();
      document.getElementById('pop').hidePopover();
    JS
    expect(native_ids(':modal, :popover-open')).to eq([])
  end

  it 'follows focus and hover up the tree' do
    session.find('#rw').click
    expect(native_ids(':focus')).to eq(%w[rw])
    expect(native_ids('#f:focus-within, #rw:focus-within')).to eq(%w[f rw])
    session.find('#hover-inner').hover
    expect(native_ids(':hover').last(2)).to eq(%w[hover-outer hover-inner])
    session.execute_script("document.getElementById('rw').blur()")
    expect(native_ids(':focus, :focus-within')).to eq([])
  end

  it 'matches a shadow host while focus is inside its shadow tree' do
    session.execute_script(<<~JS)
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<input id="inner">';
      root.getElementById('inner').focus();
    JS
    expect(native_ids('#host:focus')).to eq(%w[host])
    expect(native_ids('#host:focus-within')).to eq(%w[host])
  end
end
