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
      <input type="hidden" required id="req-hidden"><input type="color" required id="req-color">
      <input type="email" required id="req-email"><input type="nonsense" required id="req-bogus">
    </form>
    <details open id="det"><summary>s</summary></details>
    <dialog id="dlg">d</dialog>
    <div popover id="pop">p</div>
    <div id="hover-outer"><p id="hover-inner">h</p></div>
    <div id="host"></div>
    <x-later id="ce-later"></x-later><x-throws id="ce-throws"></x-throws><div is="x-div" id="ce-is"></div>
    <font-face id="ce-reserved"></font-face>
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
    expect(native_ids('input:read-write, textarea:read-write')).to eq(%w[in-legend ph ph-val ph-ta rw bogus-type ta req-email req-bogus])
    expect(native_ids('#ce :read-write, #ce:read-write')).to eq(%w[ce ce-kid])
    expect(native_ids('#ce-off:read-only')).to eq(%w[ce-off])
    # …and of the submit buttons, only the form's default one (the first).
    expect(native_ids(':default')).to eq(%w[c1 r2 c4 o2 b-submit])
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

  # An ignored `required` makes an input neither — HTML, and Firefox (Chrome calls a hidden or color one `:optional`).
  it 'answers :required and :optional where the attribute applies' do
    expect(native_ids(':required')).to eq(%w[req-email req-bogus])
    expect(native_ids('[id^=req]:optional')).to eq([])
    expect(native_ids('#s:optional, #ta:optional')).to eq(%w[s ta])
  end

  # A custom element is :defined once custom — constructed, or upgraded without its constructor throwing.
  it 'answers :defined from each custom element state' do
    expect(native_ids('[id^=ce-]:not(:defined)')).to eq(%w[ce-later ce-throws ce-is])
    session.execute_script(<<~JS)
      customElements.define('x-later', class extends HTMLElement {});
      customElements.define('x-throws', class extends HTMLElement { constructor() { super(); throw new Error('no'); } });
      document.body.appendChild(document.createElement('x-later')).id = 'ce-made';
    JS
    expect(native_ids('[id^=ce-]:not(:defined)')).to eq(%w[ce-throws ce-is])
    expect(native_ids('#ce-made:defined, #ce-later:defined')).to eq(%w[ce-later ce-made])
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

  # The state lives in bits no component names: its own `_state`, `_filtered` or `_modal` stay what it stored.
  it 'leaves a custom element its own fields' do
    got = session.evaluate_script(<<~JS)
      (() => {
        class XList extends HTMLElement {
          constructor() { super(); this._state = { open: false }; this._filtered = ['a', 'b']; this._modal = 'yes'; }
        }
        customElements.define('x-list', XList);
        const el = document.body.appendChild(document.createElement('x-list'));
        el.setAttribute('open', '');
        el.focus();
        return [JSON.stringify(el._state), JSON.stringify(el._filtered), el._modal, el.matches(':modal')];
      })()
    JS
    expect(got).to eq(['{"open":false}', '["a","b"]', 'yes', false])
    expect(native_ids('x-list:modal')).to eq([])
  end

  # `:optional` reads the input's type too: a hidden input is neither, so a rule on its sibling stops applying.
  it 're-styles a sibling when a type change moves :optional' do
    session.execute_script(<<~JS)
      const st = document.head.appendChild(document.createElement('style'));
      st.textContent = '#opt:optional + #opt-next { color: rgb(255, 0, 0) }';
      document.body.insertAdjacentHTML('beforeend', '<input id="opt"><p id="opt-next">p</p>');
    JS
    color = -> { session.evaluate_script("getComputedStyle(document.getElementById('opt-next')).color") }
    expect(color.call).to eq('rgb(255, 0, 0)')
    session.execute_script("document.getElementById('opt').type = 'hidden'")
    expect(color.call).to eq('rgb(0, 0, 0)')
  end

  # HTML "upgrade an element": a constructor that returns another object fails the upgrade — never :defined (Chrome).
  it 'leaves an upgrade whose constructor returns another object undefined' do
    session.execute_script(<<~JS)
      document.body.insertAdjacentHTML('beforeend', '<not-an-element id="nae"></not-an-element><other-el id="oe"></other-el>');
      window.onerror = () => true;
      customElements.define('not-an-element', class extends HTMLElement { constructor() { return new Text(); } });
      customElements.define('other-el', class extends HTMLElement { constructor() { super(); return document.createElement('div'); } });
    JS
    expect(native_ids('#nae:defined, #oe:defined')).to eq([])
  end

  # Review of the state commits, pre-existing in both engines — each against HTML, Chrome and Firefox.
  describe 'the rules both engines had wrong' do
    def fresh(html)
      session.execute_script("document.body.innerHTML = #{html.to_json}")
    end

    it 'finds a radio group with nothing checked, and a progress with no value, :indeterminate' do
      fresh('<form><input type=radio name=a id=a1><input type=radio name=a id=a2></form>' \
            '<input type=radio name=b id=b1 checked><input type=radio name=b id=b2><input type=radio id=lone>' \
            '<progress id=p1></progress><progress id=p2 value=1></progress>')
      expect(native_ids(':indeterminate')).to eq(%w[a1 a2 lone p1])
      session.execute_script("document.getElementById('a2').checked = true")
      expect(native_ids(':indeterminate')).to eq(%w[lone p1])
    end

    it "matches only a form's default button as :default" do
      fresh('<form id=f><button id=b1>1</button><input type=submit id=s2></form><button id=out>x</button>' \
            '<button form=g id=b3>3</button><form id=g></form>')
      expect(native_ids('button:default, input:default')).to eq(%w[b1 b3])
    end

    it 'takes the is value at creation only' do
      session.execute_script(<<~JS)
        const d = document.body.appendChild(document.createElement('div'));
        d.id = 'late-is';
        d.setAttribute('is', 'x-late');
      JS
      expect(native_ids('#late-is:defined')).to eq(%w[late-is])
    end

    it 'closes a removed popover and un-modals a removed dialog, with no toggle event' do
      fresh('<div popover id=pp>p</div><dialog id=dd>d</dialog>')
      toggles = session.evaluate_script(<<~JS)
        (() => {
          const p = document.getElementById('pp'), d = document.getElementById('dd');
          p.showPopover(); d.showModal();
          let n = 0;
          p.addEventListener('toggle', () => n++);
          p.remove(); d.remove();
          document.body.append(p, d);
          return n;
        })()
      JS
      expect(toggles).to eq(0)
      expect(native_ids(':popover-open, :modal')).to eq([])
    end

    it 'shows the placeholder by the sanitized value, where a placeholder applies' do
      fresh('<input id=n type=number value=abc placeholder=p><input id=e type=email value="  " placeholder=p>' \
            '<input id=t value="&#10;" placeholder=p><input id=c type=checkbox placeholder=p>' \
            '<input id=d type=date placeholder=p><input id=v value=v placeholder=p>')
      expect(native_ids(':placeholder-shown')).to eq(%w[n e t])
    end

    it 'drops focus and hover that document.open took away' do
      fresh('<input id=gone>')
      session.find('#gone').click
      # …and a script that kept the element and puts it back does not find it focused again.
      session.execute_script("const g = document.getElementById('gone'); document.open(); document.body.appendChild(g)")
      expect(native_ids(':focus, :focus-within')).to eq([])
    end

    it 'runs adoptedCallback after the whole fragment is inserted' do
      got = session.evaluate_script(<<~JS)
        (() => {
          const other = document.body.appendChild(document.createElement('div'));
          customElements.define('x-mover', class extends HTMLElement {
            adoptedCallback() { if (this.ownerDocument === document) other.appendChild(this); }
          });
          const doc = document.implementation.createHTMLDocument('');
          const frag = doc.createDocumentFragment();
          frag.append(doc.adoptNode(document.createElement('x-mover')), doc.createElement('b'));
          const root = document.body.appendChild(document.createElement('div'));
          root.appendChild(frag);
          return [root.children.length, other.children.length, root.firstChild.localName];
        })()
      JS
      expect(got).to eq([1, 1, 'b'])
    end
  end
end
