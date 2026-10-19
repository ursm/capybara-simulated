require 'capybara/simulated'
require_relative 'support/session_teardown'

# What the platform does is the engine's, not the page's: a page may redefine a member of an interface prototype (a
# polyfill, a test double, an analytics shim), and the platform's own algorithms — serializing, parsing, focusing,
# showing a popover — go on reading the node's own state, never the member the page replaced. In Chrome a throwing
# `Node.prototype.ownerDocument` breaks none of these.
RSpec.describe 'members a page overrides' do
  it "leaves the platform's own reads of a node's document alone" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><input id="i"><div id="p" popover>p</div>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        Object.defineProperty(Node.prototype, 'ownerDocument', { get() { throw new Error('page getter'); }, configurable: true });
        const d = document.createElement('div');
        d.innerHTML = '<b>x</b><i>y</i>';
        const html = d.innerHTML;
        d.insertAdjacentHTML('beforeend', '<u>z</u>');
        document.body.append(d);
        document.getElementById('i').focus();
        const focused = document.activeElement.id;
        document.getElementById('p').showPopover();
        const open = document.getElementById('p').matches(':popover-open');
        return [html, d.outerHTML, focused, open];
      })()
    JS
    expect(got).to eq(['<b>x</b><i>y</i>', '<div><b>x</b><i>y</i><u>z</u></div>', 'i', true])
  end

  # …and of the selection and its range: typing into an editing host, moving its caret and cutting go on where the
  # selection is, whatever a page made of `Selection.prototype.collapse` or a Range's boundary getters.
  it "types and moves the caret through the engine's selection, not its members" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><div id="ce" contenteditable></div>']] })
    s.visit '/'
    s.execute_script(<<~JS)
      const boom = () => { throw new Error('page member'); };
      for (const name of ['collapse', 'extend', 'setBaseAndExtent', 'getRangeAt']) Selection.prototype[name] = boom;
      for (const name of ['focusNode', 'isCollapsed', 'direction']) Object.defineProperty(Selection.prototype, name, { get: boom, configurable: true });
      for (const name of ['startContainer', 'startOffset', 'endContainer', 'endOffset', 'collapsed']) {
        Object.defineProperty(AbstractRange.prototype, name, { get: boom, configurable: true });
      }
    JS
    s.find('#ce').send_keys('ab', :left, 'c', :end, 'd')
    expect(s.evaluate_script('document.getElementById("ce").textContent')).to eq('acbd')
  end

  # …and a cut takes the selection's text from the engine — not the page's `toString` of a Selection or a Range, nor its
  # `activeElement` — and an `insertHTML` into a text control its markup's text, not through the page's `createElement`.
  it "cuts and inserts through the engine's text, not the page's members" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><div id="ce" contenteditable>hello</div><input id="i">']] })
    s.visit '/'
    s.execute_script(<<~JS)
      const boom = () => { throw new Error('page member'); };
      Selection.prototype.toString = boom;
      Range.prototype.toString = boom;
      Object.defineProperty(Document.prototype, 'activeElement', { get: boom, configurable: true });
      Document.prototype.createElement = boom;
      const ce = document.getElementById('ce');
      ce.focus();
      getSelection().selectAllChildren(ce);
    JS
    s.find('#ce').send_keys([:control, 'x'])
    s.execute_script('document.getElementById("i").focus(); document.execCommand("insertHTML", false, "<b>x</b><!--c-->y")')
    expect(s.evaluate_script('[document.getElementById("ce").textContent, document.getElementById("i").value]')).to eq(['', 'xy'])
  end

  # …and a fetch reads its signal's state, not the page's `AbortSignal.prototype.aborted` / `reason`: one not aborted
  # fetches, one aborted rejects with its reason.
  it "reads a fetch's signal as the engine holds it" do
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [env['PATH_INFO'] == '/' ? '<!DOCTYPE html><meta charset="utf-8"><body>' : 'ok']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const boom = () => { throw new Error('page member'); };
      for (const name of ['aborted', 'reason']) Object.defineProperty(AbortSignal.prototype, name, { get: boom, configurable: true });
      const aborted = new AbortController();
      aborted.abort('why');
      Promise.all([
        fetch('/x', { signal: new AbortController().signal }).then((r) => r.text(), (e) => 'rejected ' + e),
        fetch('/x', { signal: aborted.signal }).then(() => 'fetched', (e) => 'rejected ' + e)
      ]).then(done);
    JS
    expect(got).to eq(['ok', 'rejected why'])
  end

  # …and the driver's active element is the document's, not the page's `Document.prototype.activeElement`.
  it "answers the driver's active element from the engine" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><input id="i">']] })
    s.visit '/'
    s.execute_script(<<~JS)
      Object.defineProperty(Document.prototype, 'activeElement', { get() { throw new Error('page member'); }, configurable: true });
      document.getElementById('i').focus();
    JS
    expect(s.active_element[:id]).to eq('i')
  end

  # …and the keys the driver presses and the options it picks: Ctrl+A in a text field selects its text, an Arrow steps a
  # number field, `select` picks an option by its value — whatever a page made of `select()`, `value`, an option's
  # `value` (put back before the expectation reads them).
  it "presses keys and picks options through the engine's values" do
    s = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><input id="t" value="abc"><input id="n" type="number" value="1">' \
        '<select id="s"><option>one</option><option value="2">two</option></select><p id="log"></p>']]
    })
    s.visit '/'
    s.execute_script(<<~JS)
      const boom = () => { throw new Error('page member'); };
      window.saved = [
        [HTMLInputElement.prototype, 'select'], [HTMLInputElement.prototype, 'value'], [HTMLOptionElement.prototype, 'value']
      ].map(([proto, name]) => [proto, name, Object.getOwnPropertyDescriptor(proto, name)]);
      HTMLInputElement.prototype.select = boom;
      Object.defineProperty(HTMLInputElement.prototype, 'value', { get: boom, set: boom, configurable: true });
      Object.defineProperty(HTMLOptionElement.prototype, 'value', { get: boom, configurable: true });
      document.getElementById('n').addEventListener('change', () => document.getElementById('log').textContent += 'change');
    JS
    s.find('#t').send_keys([:control, 'a'], 'x')
    s.find('#n').send_keys(:up)
    s.find('#s').select('two')
    s.execute_script('for (const [proto, name, desc] of saved) Object.defineProperty(proto, name, desc)')
    expect(s.evaluate_script(<<~JS)).to eq(['x', '2', 'change', '2'])
      ['t', 'n', 'log', 's'].map((id) => { const el = document.getElementById(id); return el.id === 'log' ? el.textContent : el.value; })
    JS
  end

  # …and the tree's own reads: a node's text, its siblings, a frame's window, a document's window, `new Option(text)`,
  # the driver's page text — whatever a page made of `textContent`, `nextSibling`, `contentWindow`, `defaultView`,
  # `createElementNS`.
  it "reads the tree, a frame's window and a document's window through the engine" do
    s = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><p id="p"><b>b</b></p><iframe name="f" srcdoc="x"></iframe>']]
    })
    s.visit '/'
    s.evaluate_script('frames[0].length')
    got = s.evaluate_script(<<~JS)
      (() => {
        const boom = { get() { throw new Error('page member'); }, configurable: true };
        for (const name of ['textContent', 'nextSibling', 'previousSibling', 'firstChild']) Object.defineProperty(Node.prototype, name, boom);
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', boom);
        Object.defineProperty(Document.prototype, 'defaultView', boom);
        Document.prototype.createElementNS = () => { throw new Error('page member'); };
        const b = document.querySelector('b');
        b.before('a');
        b.after('c');
        const p = document.getElementById('p'), before = p.innerHTML;
        p.insertBefore(b, b);
        p.replaceChild(b, b);
        b.replaceWith(document.createElement('u'));
        const o = new Option('opt');
        return [before, p.innerHTML, o.text, typeof frames[0], typeof window.f];
      })()
    JS
    expect(got).to eq(['a<b>b</b>c', 'a<u></u>c', 'opt', 'object', 'object'])
    expect(s.text).to eq('ac')
  end
  # …nor a style read, an animation's committed styles, the font set's layout flush or a modal dialog's close request:
  # `isConnected`, `setProperty`, `getBoundingClientRect`, `defaultPrevented` replaced, each goes on (Chrome: below).
  it "reads its own state where a page replaced isConnected, setProperty, getBoundingClientRect or defaultPrevented" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><div id="t">x</div><dialog id="d">dlg</dialog>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const out = [];
        let calls = 0;
        const rect = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function () { calls++; return rect.call(this); };
        [...document.fonts];
        out.push(calls);
        Element.prototype.getBoundingClientRect = rect;
        const setProperty = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = () => {};
        const t = document.getElementById('t');
        const a = t.animate({opacity: [0.25, 0.25]}, {fill: 'forwards'});
        a.finish();
        a.commitStyles();
        CSSStyleDeclaration.prototype.setProperty = setProperty;
        out.push(t.style.opacity);
        const connected = Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected');
        Object.defineProperty(Node.prototype, 'isConnected', {get: () => false, configurable: true});
        out.push(getComputedStyle(document.body).display);
        Object.defineProperty(Node.prototype, 'isConnected', connected);
        return out;
      })()
    JS
    expect(got).to eq([0, '0.25', 'block'])
    s.execute_script(<<~JS)
      document.getElementById('d').showModal();
      Object.defineProperty(Event.prototype, 'defaultPrevented', {get: () => true, configurable: true});
    JS
    s.find(:css, '#d').send_keys(:escape)
    expect(s.evaluate_script("document.getElementById('d').open")).to be(false)
  end

  # …and `execCommand`'s alignment and colour: the text-align it gives the block and the style its span carries are the
  # engine's, whatever a page made of CSSStyleDeclaration's members.
  it "aligns and colours an editing host's text whatever a page made of CSSStyleDeclaration" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><div id="ce" contenteditable>hello</div>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const boom = () => { throw new Error('page member'); };
        for (const name of ['textAlign', 'color', 'cssText']) {
          Object.defineProperty(CSSStyleDeclaration.prototype, name, { get: boom, set: boom, configurable: true });
        }
        CSSStyleDeclaration.prototype.setProperty = boom;
        const ce = document.getElementById('ce');
        ce.focus();
        getSelection().selectAllChildren(ce);
        document.execCommand('justifyCenter');
        getSelection().selectAllChildren(ce);
        document.execCommand('foreColor', false, 'red');
        return ce.innerHTML;
      })()
    JS
    expect(got).to include('text-align: center').and include('color: red')
  end

  # …and the platform's own microtasks and tasks — a MutationObserver's delivery, a frame's postMessage — are queued by
  # the realm's intrinsics, whatever a page (a polyfill, a fake-timer library) made of `Promise`, its `then`,
  # `queueMicrotask` or `setTimeout`.
  it 'delivers mutations and messages whatever a page made of Promise, queueMicrotask and setTimeout' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] })
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = [];
      const frame = document.createElement('iframe');
      document.body.append(frame);
      addEventListener('message', (e) => got.push('message:' + e.data));
      new MutationObserver((records) => got.push('mutations:' + records.length)).observe(document.body, { childList: true });
      const boom = () => { throw new Error('page member'); };
      Promise.prototype.then = boom;
      window.Promise = function () { throw new Error('page Promise'); };
      window.queueMicrotask = boom;
      window.setTimeout = boom;
      document.body.append(document.createElement('p'));
      frame.contentWindow.eval("parent.postMessage('hi', '*')");
    JS
    expect(s.evaluate_script('got')).to eq(['mutations:1', 'message:hi'])
  end
end
