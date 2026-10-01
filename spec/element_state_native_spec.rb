# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The element states no attribute records — checkedness, selectedness, focus, hover, an open popover, a modal dialog —
# live in the native arena beside the tree (dom.rs `STATE_*`, written wherever the JS DOM changes one), and the native
# matcher derives the rest from attributes and the tree (element_state.rs): `:disabled` through a `<fieldset>`,
# `:read-write`, `:default`. Each answer here is held against the HTML rule's.
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

  # The ids `sel` matches natively, in document order.
  def native_ids(sel)
    session.evaluate_script(<<~JS)
      (() => {
        const byNid = new Map([...document.getElementsByTagName('*')].map((e) => [e._nid, e]));
        return __dom.queryIds(document._nid, #{sel.to_json}, false).map((n) => byNid.get(n)?.id ?? '?');
      })()
    JS
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

  # Round 2 of that review.
  describe 'the follow-ups' do
    def fresh(html)
      session.execute_script("document.body.innerHTML = #{html.to_json}")
    end

    # Every radio asks its group, and every submit button its form: ONE walk of the tree answers them all (a walk per
    # element took 6.7 s for 4,000 radios, 2.3 s for 2,000 one-button forms).
    it 'answers a whole page of radios and forms in one walk' do
      fresh((1..2000).map {|i| "<input type=radio name=g#{i / 2} id=r#{i}>" }.join + (1..2000).map {|i| "<form><button id=b#{i}>b</button></form>" }.join)
      ms = session.evaluate_script(<<~JS)
        (() => {
          const t = performance.now();
          const nat = __dom.queryIds(document._nid, ':indeterminate', false).length + __dom.queryIds(document._nid, ':default', false).length;
          return [nat, performance.now() - t];
        })()
      JS
      expect(ms.first).to eq(4000)
      expect(ms.last).to be < 1000
    end

    it 'takes the is value of an XML-parsed HTML element' do
      got = session.evaluate_script(<<~JS)
        (() => {
          const x = new DOMParser().parseFromString('<root xmlns="http://www.w3.org/1999/xhtml"><div is="x-xml" id="xh"/></root>', 'application/xhtml+xml');
          const el = document.body.appendChild(document.adoptNode(x.getElementById('xh')));
          const before = el.matches(':defined');
          class XXml extends HTMLDivElement {}
          customElements.define('x-xml', XXml, { extends: 'div' });
          return [before, el.matches(':defined'), el instanceof XXml];
        })()
      JS
      expect(got).to eq([false, true, true])
    end

    it "runs the removing steps in a removed host's shadow tree" do
      session.execute_script(<<~JS)
        const host = document.body.appendChild(document.createElement('div'));
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<div popover id=sp>p</div><dialog id=sd>d</dialog>';
        root.getElementById('sp').showPopover();
        root.getElementById('sd').showModal();
        host.remove();
        document.body.append(host);
        window.__shadowState = [root.getElementById('sp').matches(':popover-open'), root.getElementById('sd').matches(':modal')];
      JS
      expect(session.evaluate_script('window.__shadowState')).to eq([false, false])
    end

    it 'carries nothing out of a conversion that threw' do
      got = session.evaluate_script(<<~JS)
        (() => {
          const log = [];
          customElements.define('x-ad2', class extends HTMLElement { adoptedCallback() { log.push('adopted'); } });
          const e = document.implementation.createHTMLDocument('').body.appendChild(document.createElement('x-ad2'));
          log.length = 0;
          const root = document.body.appendChild(document.createElement('div'));
          try { root.append(e, document); } catch (_) { log.push('threw'); }
          document.body.appendChild(document.createElement('p'));
          return log;
        })()
      JS
      expect(got).to eq(%w[threw])
    end

    it "runs a variadic insertion's adoptedCallback with the node in its new parent" do
      got = session.evaluate_script(<<~JS)
        (() => {
          const log = [];
          customElements.define('x-ad', class extends HTMLElement { adoptedCallback() { log.push(this.parentNode && this.parentNode.id); } });
          const e = document.createElement('x-ad');
          document.implementation.createHTMLDocument('').body.appendChild(e);
          const root = document.body.appendChild(document.createElement('div'));
          root.id = 'rc-root';
          root.replaceChildren(e, 'txt');
          return log;
        })()
      JS
      expect(got).to eq(['', 'rc-root'])   # into the other document's body (no id), then back under the root
    end
  end

  # `:target` is the document's indicated part for its fragment: the first element of its tree with that id, else the
  # first `<a name>` — not a second element with the id, not a shadow tree's (HTML; Chrome and Firefox).
  describe ':target and :state()' do
    it 'matches the indicated part only, and follows the fragment' do
      session.execute_script(<<~JS)
        document.body.innerHTML = '<p id=t1>1</p><p id=t1 class=dup>2</p><a name=n1>n</a><div id=sh></div>';
        document.getElementById('sh').attachShadow({ mode: 'open' }).innerHTML = '<p id=t2>s</p>';
        location.hash = '#t1';
      JS
      expect(native_ids(':target')).to eq(%w[t1])
      session.execute_script("location.hash = '#n1'")
      expect(native_ids(':target')).to eq([''])   # the <a name=n1>, which has no id
      expect(session.evaluate_script("document.querySelector('a[name=n1]').matches(':target')")).to be true
      session.execute_script("location.hash = '#t2'")
      expect(native_ids(':target')).to eq([])
      expect(session.evaluate_script("document.getElementById('sh').shadowRoot.getElementById('t2').matches(':target')")).to be false
    end

    it 'answers :lang() from lang and XML-namespace xml:lang, through shadow trees' do
      session.execute_script(<<~JS)
        document.body.innerHTML = '<div lang=en-CA id=ca><p id=cap>p</p><div lang="" id=unk><p id=unkp>u</p></div></div>' +
          '<svg lang=fr id=svgfr><text id=svgt>t</text></svg><div id=xl><p id=xlp>x</p></div><div id=nx><p id=nxp>n</p></div>' +
          '<div lang=DE id=host></div>';
        document.getElementById('xl').setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:lang', 'ja');
        document.getElementById('nx').setAttribute('xml:lang', 'ko');   // no namespace: names no language
        document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<p id=sp>s</p>';
      JS
      expect(native_ids(':lang(en)')).to eq(%w[ca cap])
      expect(native_ids(':lang("en-ca", fr)')).to eq(%w[ca cap svgfr svgt])
      expect(native_ids(':lang(ja)')).to eq(%w[xl xlp])
      expect(native_ids(':lang(ko)')).to eq([])
      expect(native_ids(':lang(fr)')).to eq(%w[svgfr svgt])   # an SVG element's own lang (Chrome)
      session.execute_script("document.getElementById('xl').setAttributeNS('http://www.w3.org/XML/1998/namespace', 'foo:lang', 'es')")
      expect(native_ids(':lang(es)')).to eq(%w[xl xlp])       # the XML-namespace lang, whatever its prefix
      expect(native_ids('#unk:lang(\\*), #unkp:lang(\\*)')).to eq([])
      expect(session.evaluate_script("document.getElementById('host').shadowRoot.getElementById('sp').matches(':lang(de)')")).to be true
    end

    it 'keeps the target through pushState, and tries the fragment raw before decoded' do
      session.execute_script(<<~JS)
        document.body.innerHTML = '<p id="%62">raw</p><p id=b>decoded</p><p id=c>c</p>';
        location.hash = '#%62';
      JS
      expect(native_ids(':target')).to eq(%w[%62])
      session.execute_script("history.pushState(null, '', '#c')")
      expect(native_ids(':target')).to eq(%w[%62])
      session.execute_script("history.replaceState(null, '', '#b')")
      expect(native_ids(':target')).to eq(%w[%62])
    end

    # An element can be the target only if its own id or name is the fragment: the rest answer without a walk (a walk
    # per element per mutation took 14 ms a mutation on 20,000 elements under an SPA-style hash).
    it 'answers :target without walking the tree for elements that cannot be it' do
      session.execute_script(<<~JS)
        document.body.innerHTML = Array.from({ length: 20000 }, (_, i) => '<div id=r' + i + '><span></span></div>').join('');
        location.hash = '#/users/1';
      JS
      ms = session.evaluate_script(<<~JS)
        (() => {
          const t = performance.now();
          for (let i = 0; i < 200; i++) {
            const p = document.body.appendChild(document.createElement('p'));
            p.matches(':target');
            __dom.queryIds(p._nid, ':scope:target', false);
          }
          return performance.now() - t;
        })()
      JS
      expect(ms).to be < 200
    end

    it "answers a custom element's :state() natively" do
      session.execute_script(<<~JS)
        customElements.define('x-st', class extends HTMLElement {
          constructor() { super(); this.i = this.attachInternals(); }
        });
        const x = document.body.appendChild(document.createElement('x-st'));
        x.id = 'st';
        x.i.states.add('open');
        x.i.states.add(1);
      JS
      expect(native_ids(':state(open)')).to eq(%w[st])
      expect(native_ids(':state(closed)')).to eq([])
      expect(native_ids(':state( open )')).to eq(%w[st])
      session.execute_script("document.getElementById('st').i.states.delete('open')")
      expect(native_ids(':state(open)')).to eq([])
    end
  end

  # Constraint validation in the arena (validity.rs): each constraint, a form by its controls, and the user-/range
  # pseudo-classes — held against the HTML rule.
  describe 'constraint validation' do
    it 'answers :valid / :invalid by every constraint' do
      session.execute_script(<<~JS)
        document.body.innerHTML =
          '<form id=f><input id=req required><input id=reqok required value=x>' +
          '<input id=em type=email value="a@b"><input id=embad type=email value="a@"><input id=emidn type=email value="u@お.com">' +
          '<input id=pat pattern="[a-z]{3}" value=abcd><input id=patok pattern="[a-z]{3}" value=abc><input id=patbad pattern="(" value=x>' +
          '<input id=num type=number min=1 max=5 step=2 value=4><input id=numok type=number min=1 max=5 step=2 value=3>' +
          '<input id=dt type=date min=2020-01-10 value=2020-01-01><input id=rng type=range min=0 max=10 value=50>' +
          '<input id=url type=url value=nope><input id=file type=file required>' +
          '<input type=radio name=g id=g1 required><input type=radio name=g id=g2>' +
          '<select id=sel required><option value="">choose</option><option>a</option></select>' +
          '<input id=cust value=x></form><form id=ok><input id=fine></form>';
        document.getElementById('cust').setCustomValidity('nope');
      JS
      expect(native_ids(':invalid')).to eq(%w[f req embad pat num dt url file g1 g2 sel cust])
      expect(native_ids('#ok:valid, #reqok:valid, #em:valid, #emidn:valid, #patok:valid, #patbad:valid, #numok:valid, #rng:valid'))
        .to eq(%w[reqok em emidn patok patbad numok rng ok])
      expect(native_ids(':out-of-range')).to eq(%w[dt])
      expect(native_ids('#num:in-range, #rng:in-range')).to eq(%w[num rng])
      session.execute_script("document.getElementById('g2').checked = true; document.getElementById('sel').value = 'a'")
      expect(native_ids('#g1:invalid, #sel:invalid')).to eq([])
      session.execute_script("document.getElementById('pat').value = 'xyz'")
      expect(native_ids('#pat:valid')).to eq(%w[pat])
    end

    it 'sets user validity on a committed user edit and on an interactive submission' do
      session.execute_script(<<~JS)
        document.body.innerHTML = '<form id=uf><input id=ut required><input id=un type=number min=5>' +
          '<input id=uu required><button id=ub>go</button></form>';
      JS
      expect(native_ids(':user-invalid')).to eq([])
      session.find('#ut').fill_in(with: 'x')
      session.find('#ut').fill_in(with: '')
      expect(native_ids(':user-invalid')).to eq(%w[ut])
      session.find('#un').fill_in(with: '3')   # kept as typed: out of range, as in a browser
      expect(native_ids('#un:user-invalid, #un:out-of-range')).to eq(%w[un])
      # A submission — click_button too — is interactive: refused while a control is invalid, and marks every control.
      session.click_button('go')
      expect(native_ids(':user-invalid')).to eq(%w[ut un uu])
      expect(session.current_url).not_to include('?')
    end

    it 'ignores a pattern V8 rejects, as the page does' do
      session.execute_script(<<~JS)
        document.body.innerHTML = '<input id=ph pattern="\\\\d{3}\\\\-\\\\d{4}" value=abc><input id=ok pattern="\\\\d{3}-\\\\d{4}" value=abc>';
      JS
      expect(native_ids('#ph:valid, #ok:invalid')).to eq(%w[ph ok])
    end

    it 'focuses the first control whose invalid event is not canceled when a submission is refused' do
      session.execute_script(<<~JS)
        document.body.innerHTML = '<form><input id=f1 required><input id=f2 required><button>go</button></form>';
        document.getElementById('f1').addEventListener('invalid', (e) => e.preventDefault());
      JS
      session.click_button('go')
      expect(session.evaluate_script('document.activeElement.id')).to eq('f2')
    end

    it 'submits implicitly by clicking the default button, which a click listener can cancel' do
      session.execute_script(<<~JS)
        document.body.innerHTML = '<form><input id=it name=it><button id=db>go</button></form>';
        document.getElementById('db').addEventListener('click', (e) => e.preventDefault());
      JS
      session.find('#it').fill_in(with: "x\n")
      expect(session.current_url).not_to include('it=')
    end

    it 'submits once the controls are valid, and only then — by click and by Enter' do
      session.execute_script(<<~JS)
        document.body.innerHTML = '<form id=vf><input id=vt name=vt required><button>go</button></form>' +
          '<form id=nv novalidate><input name=nt required><button>skip</button></form>';
      JS
      session.find('#vt').send_keys(:enter)
      expect(session.current_url).not_to include('?')
      session.find('#vt').fill_in(with: "ok\n")
      expect(session.current_url).to include('vt=ok')
      session.visit '/'
      session.execute_script("document.body.innerHTML = '<form novalidate><input name=nt required><button>skip</button></form>'")
      session.click_button('skip')
      expect(session.current_url).to include('nt=')
    end

    it 'counts a form-associated custom element, and a control by its form owner' do
      session.execute_script(<<~JS)
        customElements.define('x-field', class extends HTMLElement {
          static formAssociated = true;
          constructor() { super(); this.i = this.attachInternals(); }
        });
        document.body.innerHTML = '<form id=fo><x-field id=xf></x-field></form><form id=fa></form><input id=far form=fa required>';
        document.getElementById('xf').i.setValidity({ valueMissing: true }, 'fill me');
      JS
      expect(native_ids(':invalid')).to eq(%w[fo xf fa far])
      session.execute_script("document.getElementById('xf').i.setValidity({})")
      expect(native_ids('#fo:valid, #xf:valid')).to eq(%w[fo xf])
    end

    it 'matches a pattern over UTF-16, a lone surrogate included' do
      session.execute_script(<<~JS)
        document.body.innerHTML = '<input id=ls>';
        const e = document.getElementById('ls');
        e.setAttribute('pattern', '\\\\uD800');
        e.value = '\\uD800';
      JS
      expect(native_ids('#ls:valid')).to eq(%w[ls])
    end

    it 'waits for the user before :user-invalid, and for a user edit before a length check' do
      session.execute_script(<<~JS)
        document.body.innerHTML = '<select id=us required><option value="">-</option><option>a</option></select>' +
          '<input id=len maxlength=3 value=abcdef>';
      JS
      expect(native_ids(':user-invalid, :invalid')).to eq(%w[us])
      session.find('#us').select('-')
      expect(native_ids(':user-invalid')).to eq(%w[us])
      session.find('#len').fill_in(with: 'abcde')
      expect(session.evaluate_script("document.getElementById('len').value")).to eq('abc')
    end
  end

  # A frame's focus and hover are its container's in the parent document (HTML: the parent's focused area is the
  # navigable container); a hover leaving the container leaves the frame's document too.
  describe 'across a frame' do
    let(:session) {
      simulated_session(lambda {|env|
        body = env['PATH_INFO'] == '/f' ? '<!DOCTYPE html><input id=inner><p id=ip>p</p>' :
          '<!DOCTYPE html><div id=wrap><iframe id=fr src="/f"></iframe></div><input id=outer>'
        [200, {'content-type' => 'text/html'}, [body]]
      })
    }

    it 'blurs the parent control, committing its change, as focus goes into the frame' do
      session.execute_script(<<~JS)
        window.__log = [];
        const o = document.getElementById('outer');
        for (const t of ['change', 'blur', 'focusout']) o.addEventListener(t, () => __log.push(t));
      JS
      session.find('#outer').send_keys('abc')
      session.within_frame('fr') { session.find('#inner').click }
      expect(session.evaluate_script('window.__log')).to eq(%w[change blur focusout])
    end

    it "makes the iframe the parent's focused and hovered element" do
      session.within_frame('fr') { session.find('#inner').click }
      expect(session.evaluate_script('document.activeElement.id')).to eq('fr')
      expect(native_ids('#fr:focus, #wrap:focus-within')).to eq(%w[wrap fr])
      session.within_frame('fr') { session.find('#ip').hover }
      expect(native_ids('#wrap:hover, #fr:hover')).to eq(%w[wrap fr])
      session.find('#outer').hover
      expect(native_ids('#fr:hover')).to eq([])
      expect(session.evaluate_script("document.getElementById('fr').contentDocument.querySelectorAll(':hover').length")).to eq(0)
    end
  end
end
