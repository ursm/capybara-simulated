# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# `adoptedStyleSheets` is a live ObservableArray<CSSStyleSheet>: in-place mutation
# (push / splice / index write) validates each new member and re-runs the cascade, and
# a constructed sheet adopted into a shadow tree does NOT leak into the document (and vice
# versa — document author rules don't reach shadow-tree elements).
RSpec.describe 'adoptedStyleSheets ObservableArray + shadow encapsulation' do
  let(:app) {
    Rack::Builder.new {
      run ->(_env) { [200, {'content-type' => 'text/html'}, [<<~HTML]] }
        <!DOCTYPE html><html><head><style>#target { background-color: red }</style></head>
        <body><span id="target">x</span></body></html>
      HTML
    }.to_app
  }

  before { Capybara.app = app }

  it 'validates + restyles on in-place mutation of document.adoptedStyleSheets' do
    session = simulated_session(app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      const cs = getComputedStyle(document.getElementById('target'));
      const bg = () => cs.backgroundColor;
      const s1 = new CSSStyleSheet(); s1.replaceSync('#target { background-color: lime !important }');
      const s2 = new CSSStyleSheet(); s2.replaceSync('#target { background-color: blue !important }');
      const nonc = document.createElement('style');
      document.head.appendChild(nonc); nonc.sheet.insertRule('.x {}', 0);
      const err = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return e.name; } };
      document.adoptedStyleSheets = [s1];
      const afterAssign = bg();
      document.adoptedStyleSheets.push(s2);   // in-place: s2 last → wins
      const afterPush = bg();
      document.adoptedStyleSheets.pop();       // back to [s1]
      const afterPop = bg();
      JSON.stringify({
        isArray:      Array.isArray(document.adoptedStyleSheets),
        afterAssign,
        afterPush,
        afterPop,
        nonConstructed: err(() => document.adoptedStyleSheets.push(nonc.sheet)),   // NotAllowedError
        notASheet:      err(() => document.adoptedStyleSheets.push('foo')),        // TypeError
        finalLen:       document.adoptedStyleSheets.length,                        // unchanged by the throws
      });
    JS
    r = JSON.parse(out)
    expect(r['isArray']).to be true
    expect(r['afterAssign']).to eq('rgb(0, 255, 0)')   # lime
    expect(r['afterPush']).to eq('rgb(0, 0, 255)')     # blue
    expect(r['afterPop']).to eq('rgb(0, 255, 0)')      # lime again
    expect(r['nonConstructed']).to eq('NotAllowedError')
    expect(r['notASheet']).to eq('TypeError')
    expect(r['finalLen']).to eq(1)
  end

  it 'keeps constructed sheets encapsulated between the document and a shadow tree' do
    session = simulated_session(app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      // An !important document rule that would otherwise win the cascade everywhere.
      const docSheet = new CSSStyleSheet();
      docSheet.replaceSync('#target { background-color: lime !important }');
      document.adoptedStyleSheets = [docSheet];

      const host = document.createElement('div');
      document.body.appendChild(host);
      const shadow = host.attachShadow({mode: 'open'});
      shadow.innerHTML = '<span id="target">y</span><style>#target { background-color: red }</style>';
      const shadowTarget = getComputedStyle(shadow.querySelector('#target')).backgroundColor;
      const docTarget    = getComputedStyle(document.getElementById('target')).backgroundColor;

      // Adopt a sheet into the shadow tree; it must not affect the document's #target.
      const shSheet = new CSSStyleSheet();
      shSheet.replaceSync('#target { background-color: blue !important }');
      shadow.adoptedStyleSheets.push(shSheet);
      const shadowAfter = getComputedStyle(shadow.querySelector('#target')).backgroundColor;
      const docAfter    = getComputedStyle(document.getElementById('target')).backgroundColor;
      JSON.stringify({ shadowTarget, docTarget, shadowAfter, docAfter });
    JS
    r = JSON.parse(out)
    expect(r['shadowTarget']).to eq('rgb(255, 0, 0)')   # shadow rule wins; document !important doesn't leak in
    expect(r['docTarget']).to eq('rgb(0, 255, 0)')      # document sheet applies in its own scope
    expect(r['shadowAfter']).to eq('rgb(0, 0, 255)')    # shadow-adopted sheet takes effect
    expect(r['docAfter']).to eq('rgb(0, 255, 0)')       # ...without leaking out to the document
  end
  # The assignment's steps are the platform's: a page that replaced Array.prototype.splice still adopts what it assigns,
  # into the document and into a shadow root. (Its array iterator is another matter: Web IDL converts the sequence
  # through it.)
  it 'adopts what is assigned whatever the page did to Array.prototype' do
    session = simulated_session(app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      (() => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync('#target { background-color: lime !important }');
        const host = document.body.appendChild(document.createElement('div'));
        const root = host.attachShadow({mode: 'open'});
        Array.prototype.splice = () => [];
        document.adoptedStyleSheets = [sheet];
        root.adoptedStyleSheets = [sheet];
        return [document.adoptedStyleSheets.length, root.adoptedStyleSheets.length,
          getComputedStyle(document.getElementById('target')).backgroundColor];
      })()
    JS
    expect(out).to eq([1, 1, 'rgb(0, 255, 0)'])
  end
  # The adopted sheets the cascade takes are the list's own, the engine's — not what a getter a page replaced answers:
  # a rebuild after `adoptedStyleSheets` was redefined to answer [] keeps the adopted rule (Chrome).
  it 'cascades the adopted list itself, whatever getter a page put over it' do
    session = simulated_session(app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      (() => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync('#target { color: rgb(255, 0, 0) }');
        document.adoptedStyleSheets = [sheet];
        const before = getComputedStyle(document.getElementById('target')).color;
        Object.defineProperty(document, 'adoptedStyleSheets', {get: () => [], configurable: true});
        document.head.append(document.createElement('style'));
        return [before, getComputedStyle(document.getElementById('target')).color];
      })()
    JS
    expect(out).to eq(['rgb(255, 0, 0)', 'rgb(255, 0, 0)'])
  end
  # A shadow root's list goes with it between realms' trees: one adopted into a frame's document takes that document's
  # sheets and its cascade styles by them; moved back, its list emptied (the frame's sheets are none of this document's),
  # it takes none — and no sheet of this realm's that happened to share an id. An index past the list's end is refused.
  it "follows a shadow root's list between realms, and refuses a hole" do
    page = '<!DOCTYPE html><meta charset=utf-8><body><b>b</b><iframe id=f srcdoc="<!DOCTYPE html><body>"></iframe>'
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] }).tap {|s| s.visit '/' }
    out = session.evaluate_script(<<~JS)
      (() => {
        const held = [];
        for (let i = 0; i < 30; i++) { const s = new CSSStyleSheet(); s.replaceSync('b { color: rgb(' + i + ', 0, 0) }'); held.push(s); }
        const fw = document.getElementById('f').contentWindow, fd = fw.document;
        const host = document.createElement('div');
        const sr = host.attachShadow({mode: 'open'});
        sr.innerHTML = '<p>x</p>';
        fd.adoptNode(host);
        const green = new fw.CSSStyleSheet();
        green.replaceSync('p { color: rgb(0, 128, 0) }');
        sr.adoptedStyleSheets = [green];
        fd.body.append(host);
        const inFrame = fw.getComputedStyle(sr.querySelector('p')).color;
        document.body.append(host);
        const back = [sr.adoptedStyleSheets.length, getComputedStyle(document.querySelector('b')).color];
        document.adoptedStyleSheets[3] = held[7];
        return [inFrame, back, document.adoptedStyleSheets.length, getComputedStyle(document.querySelector('b')).color];
      })()
    JS
    expect(out).to eq(['rgb(0, 128, 0)', [0, 'rgb(0, 0, 0)'], 0, 'rgb(0, 0, 0)'])
  end
  # ObservableArray takes no hole: an index past the end, a longer length and a delete but at the end are refused (WebIDL;
  # Chrome: the log below).
  it 'refuses every write that would leave a hole in the list' do
    session = simulated_session(app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      (() => {
        const [a, b, c] = [new CSSStyleSheet(), new CSSStyleSheet(), new CSSStyleSheet()];
        const list = document.adoptedStyleSheets;
        const out = [];
        list[3] = a;
        out.push(list.length);
        document.adoptedStyleSheets = [a, b, c];
        list.length = 5;
        out.push(list.length);
        out.push(delete list[1], list.length);
        out.push(delete list[2], list.length, list[1] === b);
        out.push(delete list[7], list.length);
        return out;
      })()
    JS
    expect(out).to eq([0, 3, false, 3, true, 2, true, false, 2])
  end
  # …nor a `defineProperty` that would: an index defined as a sheet is set and cascades, one past the end is refused
  # (WebIDL returns false — Chrome answers true, its length kept), a non-sheet throws, and the list stays whole.
  it 'defines an index as it sets one' do
    session = simulated_session(app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      (() => {
        const mk = (n) => { const s = new CSSStyleSheet(); s.replaceSync('#target { color: rgb(' + n + ', ' + n + ', ' + n + ') !important }'); return s; };
        const [a, b] = [mk(1), mk(2)];
        const list = document.adoptedStyleSheets;
        const data = (value) => ({value, writable: true, enumerable: true, configurable: true});
        const colour = () => getComputedStyle(document.getElementById('target')).color;
        const out = [Reflect.defineProperty(list, '0', data(a)), list.length, colour()];
        out.push(Reflect.defineProperty(list, '3', data(b)), list.length);
        try { Reflect.defineProperty(list, '1', data('x')); out.push('no throw'); } catch (e) { out.push(e.name); }
        out.push(list.push(b), colour());
        return out;
      })()
    JS
    expect(out).to eq([true, 1, 'rgb(1, 1, 1)', false, 1, 'TypeError', 2, 'rgb(2, 2, 2)'])
  end
end

