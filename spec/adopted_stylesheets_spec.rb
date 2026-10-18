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
  it "cascades the adopted list itself, whatever getter a page put over it" do
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
end

