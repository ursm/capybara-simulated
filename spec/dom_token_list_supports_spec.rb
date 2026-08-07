require_relative 'spec_helper'
require_relative 'support/session_teardown'

# https://dom.spec.whatwg.org/#dom-domtokenlist-supports
# `supports(token)` throws TypeError only when the associated attribute defines
# no supported tokens (class). For `rel` (link/a/area) and `sandbox` (iframe) it
# returns whether the ASCII-lowercased token is in the supported set — Vite's
# modulepreload polyfill feature-detects `link.relList.supports('modulepreload')`
# on boot, and a throw there aborts the whole module-script chain.
RSpec.describe 'DOMTokenList#supports' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><head>
          <link id="lnk" rel="stylesheet" href="/x.css">
        </head><body>
          <a id="anc" rel="noopener" href="#">a</a>
          <form id="frm" rel="noopener"></form>
          <iframe id="ifr" sandbox></iframe>
          <div id="dv" class="a b"></div>
        </body></html>
      HTML
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  it 'returns true for a supported link rel token (modulepreload), case-insensitively' do
    expect(session.evaluate_script("document.getElementById('lnk').relList.supports('modulepreload')")).to be true
    expect(session.evaluate_script("document.getElementById('lnk').relList.supports('MODULEPRELOAD')")).to be true
    expect(session.evaluate_script("document.getElementById('lnk').relList.supports('preload')")).to be true
  end

  it 'returns false for an unsupported rel token' do
    expect(session.evaluate_script("document.getElementById('lnk').relList.supports('bogus-token')")).to be false
  end

  it 'supports a/area rel and iframe sandbox token sets' do
    expect(session.evaluate_script("document.getElementById('anc').relList.supports('noreferrer')")).to be true
    expect(session.evaluate_script("document.getElementById('ifr').sandbox.supports('allow-scripts')")).to be true
    expect(session.evaluate_script("document.getElementById('ifr').sandbox.supports('allow-nope')")).to be false
  end

  it 'exposes form.relList and reflects the same hyperlink keyword set as <a>' do
    expect(session.evaluate_script("document.getElementById('frm').relList.supports('opener')")).to be true
    expect(session.evaluate_script("document.getElementById('frm').relList.supports('noreferrer')")).to be true
  end

  # Guard against regressing to the over-broad "valid-rel-keyword" sets: supports()
  # must reflect the engine's actual registered tokens (observed in Chromium 148),
  # not every keyword merely valid on the attribute.
  it 'matches real-browser narrowing — rel keywords valid-but-unsupported return false' do
    expect(session.evaluate_script("document.getElementById('anc').relList.supports('prefetch')")).to be false
    expect(session.evaluate_script("document.getElementById('anc').relList.supports('alternate')")).to be false
    expect(session.evaluate_script("document.getElementById('lnk').relList.supports('author')")).to be false
    expect(session.evaluate_script("document.getElementById('lnk').relList.supports('noopener')")).to be false
    expect(session.evaluate_script("document.getElementById('ifr').sandbox.supports('allow-top-navigation-to-custom-protocols')")).to be false
  end

  it 'still throws TypeError for classList (no supported tokens defined)' do
    threw = session.evaluate_script(<<~JS)
      (() => { try { document.getElementById('dv').classList.supports('a'); return false; }
               catch (e) { return e instanceof TypeError; } })()
    JS
    expect(threw).to be true
  end
end
