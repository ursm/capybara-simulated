require 'capybara/simulated'
require_relative 'support/session_teardown'

# The HTML element interfaces the bindings generate (gen_bindings.mjs), where their implementations hold what the
# reflection WPT files do not ask: a table's parts are HTML elements of their names, a row of a table its index among
# the table's rows; a srcdoc document's <base> resolves against the base it inherits; an attribute name given an HTML
# element in an XML document is not lowercased; a group's insertion steps run however a node comes in; and a dialog
# takes the Escape key's close request.
RSpec.describe 'HTML element bindings' do
  let(:app) {
    lambda {|_|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><table id=t></table><iframe srcdoc="<base href=x/>"></iframe>']]
    }
  }
  let(:session) { simulated_session(app) }

  it 'takes a table part by its namespace as well as its name' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const SVG = 'http://www.w3.org/2000/svg', t = document.getElementById('t');
        t.append(document.createElementNS(SVG, 'caption'), document.createElementNS(SVG, 'tr'));
        const row = document.createElement('tr');
        row.append(document.createElementNS(SVG, 'td'), document.createElement('td'));
        return [t.caption, t.rows.length, row.cells.length, row.lastChild.cellIndex];
      })()
    JS
    expect(got).to eq([nil, 0, 1, 0])
  end

  it "indexes a table's own row among the table's rows" do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('t');
        t.createTHead().insertRow();
        const tr = t.appendChild(document.createElement('tr'));
        return [tr.sectionRowIndex, tr.rowIndex];
      })()
    JS
    expect(got).to eq([1, 1])
  end

  it "resolves a srcdoc document's base against the base it inherits" do
    session.visit '/'
    got = session.evaluate_script("document.querySelector('iframe').contentDocument.querySelector('base').href")
    expect(got).to end_with('/x/')
    expect(got).to start_with('http')
  end

  it 'keeps the case of an attribute name given an HTML element in an XML document' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const ol = document.implementation.createDocument(null, 'r').createElementNS('http://www.w3.org/1999/xhtml', 'ol');
        ol.setAttribute('START', '5');
        return [ol.getAttributeNames(), ol.start, ol.getAttribute('start')];
      })()
    JS
    expect(got).to eq([['START'], 1, nil])
  end

  it 'closes the rest of a group however its member comes in' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const host = document.body.appendChild(document.createElement('div'));
        host.innerHTML = '<details name=g open></details><b></b><i></i>';
        host.replaceChild(Object.assign(document.createElement('details'), { name: 'g', open: true }), host.querySelector('b'));
        const form = document.body.appendChild(document.createElement('form'));
        form.innerHTML = '<input type=radio name=r checked><b></b><i></i>';
        const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'r', checked: true });
        form.replaceChild(radio, form.querySelector('b'));
        form.querySelector('i').outerHTML = '<input type=radio name=r checked>';
        const xml = new DOMParser().parseFromString('<details xmlns="http://www.w3.org/1999/xhtml" name="x" open=""/>', 'application/xml');
        const a = document.body.appendChild(document.importNode(xml.documentElement, true));
        const b = document.body.appendChild(document.importNode(xml.documentElement, true));
        return [
          [...host.querySelectorAll('details')].map((d) => d.open),
          [...form.querySelectorAll('input')].map((r) => r.checked),
          [a.open, b.open]
        ];
      })()
    JS
    expect(got).to eq([[true, false], [false, false, true], [true, false]])
  end

  it 'keeps the name of an attribute node as it is' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const div = document.createElement('div');
        div.setAttributeNode(document.createAttributeNS(null, 'FOO'));
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const box = document.createAttributeNS(null, 'viewBox');
        box.value = '0 0 1 1';
        svg.setAttributeNode(box);
        return [div.getAttributeNames(), div.getAttribute('FOO'), div.getAttributeNS(null, 'FOO'), svg.getAttribute('viewBox')];
      })()
    JS
    expect(got).to eq([['FOO'], nil, '', '0 0 1 1'])
  end

  it "clones a template's contents into the inert template document" do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const t = document.createElement('template');
        t.innerHTML = '<p>x</p>';
        return t.content.cloneNode(true).ownerDocument === t.content.ownerDocument;
      })()
    JS
    expect(got).to be(true)
  end

  it 'closes the dialog opened last on Escape' do
    session.visit '/'
    session.execute_script(<<~JS)
      document.body.insertAdjacentHTML('beforeend', '<dialog id=a closedby=any>a</dialog><dialog id=b>b</dialog>');
      window.cancels = [];
      for (const d of document.querySelectorAll('dialog')) d.addEventListener('cancel', () => cancels.push(d.id));
      document.getElementById('a').show();
      document.getElementById('b').showModal();
    JS
    session.find('body').send_keys(:escape)
    expect(session.evaluate_script("[cancels, a.open, b.open, b.closedBy]")).to eq([['b'], true, false, 'none'])
  end

  it 'clones a node into its own node document' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const hd = document.implementation.createHTMLDocument('');
        const i = hd.createElement('i');
        i.append(hd.createElement('b'), 'x');
        const copy = i.cloneNode(true);
        const t = document.createElement('template');
        t.innerHTML = '<p>x</p>';
        const content = t.content.cloneNode(true);
        return [copy, ...copy.childNodes].map((n) => n.ownerDocument === hd).concat(content.firstChild.ownerDocument === t.content.ownerDocument);
      })()
    JS
    expect(got).to eq([true, true, true, true])
  end

  it 'takes a removed dialog off the open dialogs' do
    session.visit '/'
    session.execute_script(<<~JS)
      document.body.insertAdjacentHTML('beforeend', '<dialog id=a>a</dialog><dialog id=b>b</dialog>');
      const [a, b] = document.querySelectorAll('dialog');
      a.showModal();
      b.showModal();
      b.remove();
      document.body.append(b);
    JS
    session.find('body').send_keys(:escape)
    expect(session.evaluate_script('[a.open, b.open]')).to eq([false, true])
  end

  it "fires a link's load once, as it is connected or its href changes" do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], loads = [];
      const l = document.createElement('link');
      l.addEventListener('load', () => loads.push('a'));
      l.setAttribute('rel', 'stylesheet');
      l.setAttribute('href', 'data:text/css,p{}');
      document.head.append(l);
      setTimeout(() => {
        l.href = 'data:text/css,p{}';
        setTimeout(() => done([loads.length, document.createElement('script').async]), 20);
      }, 20);
    JS
    expect(got).to eq([1, true])
  end

  it 'takes a script the parser inserts for no force async' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const div = document.createElement('div');
        div.innerHTML = '<script>1<\\/script>';
        return div.firstChild.async;
      })()
    JS
    expect(got).to be(false)
  end

  it 'counts an HTML iframe as a child navigable, not an element only named so' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const before = window.length;
        document.body.append(document.createElementNS('http://www.w3.org/1999/xhtml', 'IFRAME'));
        document.body.append(document.createElementNS('http://www.w3.org/2000/svg', 'iframe'));
        return [before, window.length, frames.length];
      })()
    JS
    expect(got).to eq([1, 1, 1])
  end
end
