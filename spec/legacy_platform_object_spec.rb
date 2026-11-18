# frozen_string_literal: true

require 'capybara/simulated'
require 'json'
require_relative 'support/session_teardown'

# Legacy platform objects (Web IDL §3.9) — every interface that supports indexed or named properties is made by one
# generated helper (gen_bindings.mjs `legacyKind`, webidl.js `legacyPlatformObject`), its behaviour its IDL's: a
# special operation's steps, [LegacyOverrideBuiltIns], [LegacyUnenumerableNamedProperties]. Each expectation below is
# the spec's, measured where the spec leaves room against Chrome and Firefox (2026-11-19).
RSpec.describe 'legacy platform objects' do
  let(:page) {
    <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><style>p {}</style>
      <form id="f" name="myform"><input name="submit"><input name="q"></form>
      <img name="forms"><div id="d" data-foo-bar="1"></div>
    HTML
  }
  let(:app) { ->(_env) { [200, {'content-type' => 'text/html'}, [page]] } }

  def probe(js)
    session = simulated_session(app)
    session.visit '/'
    JSON.parse(session.evaluate_script("JSON.stringify((() => { #{js} })())"))
  end

  # The document's named properties are [LegacyOverrideBuiltIns] (HTML §3.1.6): seen over its prototype chain's members
  # — `<img name=forms>` is `document.forms`, in Chrome and Firefox too.
  it 'answers a document name over its prototype chain, and of any document' do
    r = probe(<<~JS)
      const other = document.implementation.createHTMLDocument('');
      other.body.innerHTML = '<form name="zz"></form>';
      return {
        forms: String(document.forms),
        myform: String(document.myform),
        otherIn: 'zz' in other,
        otherValue: String(other.zz),
        otherKeys: Object.keys(other)
      };
    JS
    expect(r).to eq(
      'forms'      => '[object HTMLImageElement]',
      'myform'     => '[object HTMLFormElement]',
      'otherIn'    => true,
      'otherValue' => '[object HTMLFormElement]',
      'otherKeys'  => ['zz', 'location']
    )
  end

  # `'x' in doc` asked of the document it is asked of — it looked the name up in the window's document.
  it "answers `in` of a document by that document's names" do
    r = probe(<<~JS)
      const other = document.implementation.createHTMLDocument('');
      return ['myform' in other, 'myform' in document];
    JS
    expect(r).to eq([false, true])
  end

  # Its named property is read-only — Document has no named setter (Web IDL §3.9.7: writable is "has a named property
  # setter") — and enumerable, Document having no [LegacyUnenumerableNamedProperties]. It reported `writable: true`.
  it "describes a document's named property as read-only and enumerable" do
    r = probe(<<~JS)
      const d = Object.getOwnPropertyDescriptor(document, 'myform');
      return [d.writable, d.enumerable, d.configurable, Object.keys(document)];
    JS
    expect(r).to eq([false, true, true, ['myform', 'forms', 'location']])
  end

  # [[PreventExtensions]] returns false (Web IDL §3.9.5) — of a document as of a form (Firefox; Chrome lets a document
  # be sealed).
  it 'refuses to make a legacy platform object non-extensible' do
    r = probe(<<~JS)
      const refused = (o) => { try { Object.preventExtensions(o); return false; } catch (e) { return e instanceof TypeError; } };
      return [refused(document), refused(document.getElementById('f')), refused(localStorage), refused(document.body.childNodes)];
    JS
    expect(r).to eq([true, true, true, true])
  end

  # [LegacyOverrideBuiltIns] on a form: a control named `submit` shadows the method; [LegacyUnenumerableNamedProperties]:
  # its names are own properties, listed but not enumerable, read-only, never deleted.
  it "answers a form's controls by index and by name" do
    r = probe(<<~JS)
      const f = document.getElementById('f');
      const d = Object.getOwnPropertyDescriptor(f, 'q');
      return [f.submit instanceof HTMLInputElement, f[1] === f.q, Object.getOwnPropertyNames(f), d.enumerable, d.writable, delete f.q];
    JS
    expect(r).to eq([true, true, ['0', '1', 'submit', 'q'], false, false, false])
  end

  # A name an HTML element's NamedNodeMap would find another attribute by (`FOO` for `foo`) is no supported property
  # name: its getNamedItem answers it, its properties do not.
  it "takes a NamedNodeMap's supported names, not what its getter finds" do
    r = probe(<<~JS)
      const a = document.getElementById('d').attributes;
      return [String(a.id), a.ID, String(a.getNamedItem('ID')), 'ID' in a];
    JS
    expect(r).to eq(['[object Attr]', nil, '[object Attr]', false])
  end

  # [[Set]] on an object a legacy platform object is the prototype of: a supported index, read-only without an indexed
  # setter, refuses the write (Web IDL §3.9.2: ownDesc is the index's; Firefox); with one, the receiver gets its own
  # property, the setter not run (Chrome).
  it 'writes an index through an inheriting object as Web IDL says' do
    r = probe(<<~JS)
      const inheriting = Object.create(document.body.childNodes);
      inheriting[0] = 7;
      const select = document.createElement('select');
      select.add(new Option('a'));
      const ofSelect = Object.create(select);
      ofSelect[0] = 7;
      return [Object.getOwnPropertyNames(inheriting), Object.getOwnPropertyNames(ofSelect), select.length];
    JS
    expect(r).to eq([[], ['0'], 1])
  end

  # The named setter converts its value and runs as the area's / the element's own steps.
  it 'sets and deletes named properties through the setter and deleter' do
    r = probe(<<~JS)
      localStorage.clear();
      localStorage.a = 1;
      localStorage.getItem = 'x';
      const ds = document.getElementById('d').dataset;
      ds.bazQux = 3;
      let bad;
      try { ds['a-b'] = 1; } catch (e) { bad = e.name; }
      const out = [localStorage.a, localStorage.getItem('getItem'), typeof localStorage.getItem, Object.keys(localStorage),
        document.getElementById('d').getAttribute('data-baz-qux'), bad, Object.keys(ds), delete ds.fooBar,
        document.getElementById('d').hasAttribute('data-foo-bar')];
      localStorage.clear();
      return out;
    JS
    expect(r).to eq(['1', 'x', 'function', ['a'], '3', 'SyntaxError', ['fooBar', 'bazQux'], true, false])
  end

  # The window's named properties object (Web IDL §3.7.4) defines and deletes nothing, and keeps its prototype.
  it "keeps the window's named properties object as it is" do
    r = probe(<<~JS)
      const wp = Object.getPrototypeOf(Window.prototype);
      return [Object.prototype.toString.call(wp), Object.getPrototypeOf(wp) === EventTarget.prototype,
        Reflect.defineProperty(wp, 'zz', { value: 1 }), Reflect.deleteProperty(wp, Symbol.toStringTag),
        Reflect.setPrototypeOf(wp, null), String(window.myform), Object.getOwnPropertyDescriptor(wp, 'myform').enumerable];
    JS
    expect(r).to eq(['[object WindowProperties]', true, false, false, false, '[object HTMLFormElement]', false])
  end
end
