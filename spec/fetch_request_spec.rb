# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'

# Fetch `Request` value-type semantics: constructing a Request from another Request
# transfers (consumes) the source's body, `clone()` does not, and a relative input URL
# resolves against the realm's API base URL (`<base href>`-aware).
RSpec.describe 'Fetch Request semantics' do
  let(:app) {
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'      then [200, {'content-type' => 'text/html'}, ['<html><body>hi</body></html>']]
        when '/based' then [200, {'content-type' => 'text/html'}, ['<html><head><base href="sub/"></head><body>hi</body></html>']]
        else               [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  before { Capybara.app = app }

  it 'transfers the source body when constructing a Request from a Request' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    session.execute_script(<<~JS)
      const src = new Request('/x', {method: 'POST', body: "the body"});
      const originalBody = src.body;                     // expose the stream first
      const usedBefore = src.bodyUsed;                   // false
      const copy = new Request(src);
      globalThis.__r = {
        usedBefore,
        usedAfter:      src.bodyUsed,                    // true — source disturbed
        sameSourceBody: src.body === originalBody,       // identity preserved
        freshCopyBody:  copy.body !== originalBody,      // copy gets its own body
      };
      copy.text().then(t => { globalThis.__r.copyText = t; });
    JS
    sleep 0.05
    r = JSON.parse(session.evaluate_script('JSON.stringify(globalThis.__r)'))
    expect(r['usedBefore']).to be false
    expect(r['usedAfter']).to be true
    expect(r['sameSourceBody']).to be true
    expect(r['freshCopyBody']).to be true
    expect(r['copyText']).to eq('the body')
  end

  it 'transfers the source body even when init replaces it, and clone() does not disturb' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      const err = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return e.name; } };
      // Replacing the body still disturbs the source.
      const a = new Request('/x', {method: 'POST', body: "a"});
      const b = new Request(a, {body: "replaced"});
      const replacedDisturbs = a.bodyUsed;               // true
      // clone() yields two independently usable requests.
      const c = new Request('/x', {method: 'POST', body: "c"});
      const cc = c.clone();
      const cloneKeepsSource = !c.bodyUsed && !cc.bodyUsed;
      // A construction that throws must NOT disturb the source.
      const d = new Request('/x', {method: 'POST', body: "d"});
      const failThrew = err(() => new Request(d, {method: 'GET'}));   // GET + body -> TypeError
      const failNoDisturb = !d.bodyUsed;
      JSON.stringify({ replacedDisturbs, cloneKeepsSource, failThrew, failNoDisturb });
    JS
    r = JSON.parse(out)
    expect(r['replacedDisturbs']).to be true
    expect(r['cloneKeepsSource']).to be true
    expect(r['failThrew']).to eq('TypeError')
    expect(r['failNoDisturb']).to be true
  end

  it 'resolves a relative Request URL against the document base URI (<base href>)' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/based'   # <base href="sub/">
    out = session.evaluate_script(<<~JS)
      JSON.stringify({
        rel:  new Request('url').url,                    // resolved against .../sub/
        base: document.baseURI,
      });
    JS
    r = JSON.parse(out)
    expect(r['base']).to end_with('/sub/')
    expect(r['rel']).to eq("#{r['base']}url")
  end
end
