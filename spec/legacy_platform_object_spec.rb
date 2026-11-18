# frozen_string_literal: true

require 'capybara/simulated'
require 'json'
require_relative 'support/session_teardown'

# Legacy platform objects (Web IDL §3.9) — every interface that supports indexed or named properties is made by one
# generated helper (gen_bindings.mjs `legacyKind`, webidl.js `legacyPlatformObject`), its behaviour its IDL's: a
# special operation's steps, [LegacyOverrideBuiltIns], [LegacyUnenumerableNamedProperties]. Each expectation below is
# the spec's, measured where the spec leaves room against Chrome and Firefox (2026-11-19). Two follow explicit spec text
# where BOTH differ (measured 2026-11-19): a form's own keys list its names, and a NamedNodeMap's upper-case name is no
# property of an HTML element's — each quoted at its example.
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
  # its names are own properties, listed but not enumerable, read-only, never deleted. Web IDL §3.9.6 [[OwnPropertyKeys]]:
  # "If O supports named properties, then for each P of O's supported property names that is visible according to the
  # named property visibility algorithm, append P to keys" — where Chrome and Firefox both list `["0", "1"]` alone.
  it "answers a form's controls by index and by name" do
    r = probe(<<~JS)
      const f = document.getElementById('f');
      const d = Object.getOwnPropertyDescriptor(f, 'q');
      return [f.submit instanceof HTMLInputElement, f[1] === f.q, Object.getOwnPropertyNames(f), d.enumerable, d.writable, delete f.q];
    JS
    expect(r).to eq([true, true, ['0', '1', 'submit', 'q'], false, false, false])
  end

  # A name an HTML element's NamedNodeMap would find another attribute by (`FOO` for `foo`) is no supported property
  # name: its getNamedItem answers it, its properties do not. DOM §4.9.1: its supported property names drop, "if this
  # NamedNodeMap object's element is in the HTML namespace and its node document is an HTML document", each name whose
  # "lowercaseName is not name" — where Chrome and Firefox both answer `attributes.ID` with the attribute (Firefox's
  # `'ID' in attributes` true too).
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

  # An observable array's attribute set (Web IDL §3.7.6): the list emptied, then each value set in turn — a sheet its
  # "set an indexed value" refuses leaves those before it adopted (Chrome and Firefox alike).
  it 'sets adoptedStyleSheets value by value' do
    r = probe(<<~JS)
      const good = new CSSStyleSheet();
      document.adoptedStyleSheets = [new CSSStyleSheet()];
      let threw;
      try { document.adoptedStyleSheets = [good, document.styleSheets[0]]; } catch (e) { threw = e.name; }
      return [threw, document.adoptedStyleSheets.length, document.adoptedStyleSheets[0] === good];
    JS
    expect(r).to eq(['NotAllowedError', 1, true])
  end

  # The driver's own reads of a document go through its steps, not its members, which a page's element of the name
  # answers first ([LegacyOverrideBuiltIns]).
  context 'with elements named after document members' do
    let(:page) {
      <<~HTML
        <!DOCTYPE html><meta charset="utf-8"><title>Real</title>
        <form name="title"></form><img name="URL"><img name="createElementNS"><img name="fonts"><img name="characterSet">
      HTML
    }

    it "reads the document's own state" do
      session = simulated_session(app)
      session.visit '/'
      r = JSON.parse(session.evaluate_script(<<~JS))
        JSON.stringify([
          String(new Image()), String(new Audio()),
          typeof new DOMParser().parseFromString('<p>', 'text/html').URL, typeof document.cloneNode().URL
        ])
      JS
      expect(session.title).to eq('Real')
      expect(r).to eq(['[object HTMLImageElement]', '[object HTMLAudioElement]', 'string', 'string'])
    end
  end

  # A resolved-value declaration refuses a property attribute's write, but keeps an expando and an own property defined
  # on it, which its reads then answer (Firefox; Chrome refuses the definition).
  it "writes a computed style's expandos as onto any object" do
    r = probe(<<~JS)
      const cs = getComputedStyle(document.body);
      cs.foo = 1;
      let refused;
      try { cs.color = 'red'; } catch (e) { refused = e.name; }
      Object.defineProperty(cs, 'color', { value: 1 });
      return [cs.foo, refused, cs.color];
    JS
    expect(r).to eq([1, 'NoModificationAllowedError', 1])
  end

  # A Storage area's named setter fails as a named property's set (Chrome's message), its setItem as the operation's.
  it "names a named property's quota failure as Chrome does" do
    r = probe(<<~JS)
      const big = 'a'.repeat(12 * 1024 * 1024), out = [];
      localStorage.clear();
      try { localStorage.huge = big; } catch (e) { out.push(e.name + ' ' + e.message); }
      try { localStorage.setItem('huge', big); } catch (e) { out.push(e.name + ' ' + e.message); }
      localStorage.clear();
      return out;
    JS
    expect(r).to eq([
      "QuotaExceededError Failed to set a named property 'huge' on 'Storage': Setting the value of 'huge' exceeded the quota.",
      "QuotaExceededError Failed to execute 'setItem' on 'Storage': Setting the value of 'huge' exceeded the quota."
    ])
  end

  # A select's namedItem is its options collection's steps, not that collection's member a page may replace.
  it "answers a select's namedItem by its options' steps" do
    r = probe(<<~JS)
      const s = document.createElement('select');
      s.innerHTML = '<option id="o1">a</option>';
      HTMLOptionsCollection.prototype.namedItem = () => 'replaced';
      return String(s.namedItem('o1'));
    JS
    expect(r).to eq('[object HTMLOptionElement]')
  end

  # A supported name that looks like an index past the indices is listed by [[OwnPropertyKeys]] (the spec's list, and
  # Chrome's and Firefox's); one below `length` is listed once, as the index.
  it "lists a collection's index-like name past its indices" do
    r = probe(<<~JS)
      document.body.insertAdjacentHTML('beforeend', '<i class="k"></i><i id="1" class="k"></i><i id="7" class="k"></i>');
      return Object.getOwnPropertyNames(document.getElementsByClassName('k'));
    JS
    expect(r).to eq(%w[0 1 2 7])
  end

  # Any embed or object is a named element, nested or not: "it is an embed, form, iframe, img, or object element whose
  # name content attribute's value is name" (HTML §3.1.6) — the "exposed" rule that hid one in an object is withdrawn
  # (Chrome, Firefox).
  it "names an embed or object inside an object" do
    r = probe(<<~JS)
      document.body.insertAdjacentHTML('beforeend', '<object><embed name="x1"></object><object><object name="x2"></object></object>');
      return [String(document.x1), String(window.x1), String(document.x2)];
    JS
    expect(r).to eq(['[object HTMLEmbedElement]', '[object HTMLEmbedElement]', '[object HTMLObjectElement]'])
  end

  # A name set through another realm's method is the gate of the realm whose document the element is in (Chrome) — and
  # one an element brings into a document, adopted or imported, that document's realm's.
  it "finds a name another realm's method gave a frame's element" do
    session = simulated_session(app)
    session.visit '/'
    r = JSON.parse(session.evaluate_script(<<~JS))
      (() => {
        const frame = document.createElement('iframe');
        document.body.append(frame);
        const fd = frame.contentDocument;
        const img = fd.body.appendChild(fd.createElement('img'));
        Element.prototype.setAttribute.call(img, 'name', 'r1');
        const adopted = fd.adoptNode(document.createElement('img'));
        fd.body.append(adopted);
        adopted.name = 'r2';
        frame.contentWindow.eval("parent.document.body.appendChild(parent.document.createElement('img')).name = 'r3'");
        return JSON.stringify([String(fd.r1), String(fd.r2), String(document.r3)]);
      })()
    JS
    expect(r).to eq(['[object HTMLImageElement]'] * 3)
  end

  # A CSS declaration's implementation is no property a page can name (it was `Symbol.for(…)`'s).
  it "keeps a declaration's implementation out of reach" do
    r = probe(<<~JS)
      const key = Symbol.for('capybara-simulated.declarationImplementation'), style = document.body.style;
      return [style[key] === undefined, key in style, typeof style.getPropertyValue('color')];
    JS
    expect(r).to eq([true, false, 'string'])
  end

  # A cross-origin frame's index is its child navigable's WindowProxy, or nothing — never a property its page defined.
  context 'with a cross-origin frame' do
    let(:app) {
      lambda {|env|
        body = if env['HTTP_HOST'].to_s.include?('other')
                 '<!DOCTYPE html><meta charset="utf-8"><script>window.secret = "XO";' \
                   'Object.defineProperty(window, "0", { value: { fn: Function }, configurable: true });</script>'
               else
                 '<!DOCTYPE html><meta charset="utf-8"><iframe id="fr" src="http://other.test/x"></iframe>'
               end
        [200, {'content-type' => 'text/html'}, [body]]
      }
    }

    it "answers an index of the frame by its child navigables alone" do
      session = simulated_session(app)
      session.visit '/'
      r = session.evaluate_script(<<~JS)
        (() => {
          try { return String(document.getElementById('fr').contentWindow[0]); } catch (e) { return e.name; }
        })()
      JS
      expect(r).to eq('SecurityError')
    end
  end

  # An element adopted into a document is that document's realm's from then on: a name it is given before any tree
  # takes it, and a control given a name in a form moved from a frame, are found by the document and the form (Chrome).
  it "finds names given after an adoption from a frame" do
    session = simulated_session(app)
    session.visit '/'
    r = JSON.parse(session.evaluate_script(<<~JS))
      (() => {
        const frame = document.createElement('iframe');
        document.body.append(frame);
        const fd = frame.contentDocument;
        fd.body.innerHTML = '<img id="i"><form id="fm"></form>';
        const img = fd.getElementById('i');
        document.adoptNode(img);
        img.name = 'late';
        document.body.append(img);
        const fm = fd.getElementById('fm');
        document.body.append(fm);
        const input = document.createElement('input');
        fm.append(input);
        input.name = 'q';
        return JSON.stringify([String(document.late), String(window.late), String(fm.q)]);
      })()
    JS
    expect(r).to eq(['[object HTMLImageElement]', '[object HTMLImageElement]', '[object HTMLInputElement]'])
  end

  # No list of the bindings' is grown through Array.prototype: a page's index setter there sees none of their values.
  it "hands a page's Array.prototype index setters nothing of the bindings'" do
    r = probe(<<~JS)
      const got = [];
      for (let i = 0; i < 4; i++) {
        Object.defineProperty(Array.prototype, i, {
          configurable: true,
          set(v) { Object.defineProperty(this, i, { value: v, writable: true, enumerable: true, configurable: true }); got[got.length] = typeof v; }
        });
      }
      console.log('%s x', 'a', { b: 1 });
      customElements.define('x-legacy-arr', class extends HTMLElement { connectedCallback() {} });
      document.body.append(document.createElement('x-legacy-arr'));
      for (let i = 0; i < 4; i++) delete Array.prototype[i];
      return got.length;
    JS
    expect(r).to eq(0)
  end
end
