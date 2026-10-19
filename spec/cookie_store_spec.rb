# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A session's cookies are its cookie store's, the engine's (cookie_jar.rs), as RFC 6265bis has a user agent keep them: a
# cookie set with a Domain goes to every host that domain-matches it — a public suffix none — one set with a Path only to
# the paths under it, an HttpOnly one to no `document.cookie`, an expired one nowhere, and a `__Host-` one only where it
# is Secure, host-only and at `/`. (They had been a name → value table per host, which read none of these.)
RSpec.describe 'the cookie store' do
  include PollUntil

  let(:seen) { [] }
  let(:app) {
    seen = self.seen
    lambda {|env|
      req = Rack::Request.new(env)
      seen << [req.host, req.path, env['HTTP_COOKIE'].to_s]
      case req.path
      when '/sandboxed-worker'
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><iframe sandbox="allow-scripts" srcdoc="<script>const w = new Worker(\'http://www.example.com/w.js\'); w.onerror = () => parent.postMessage(\'error\', \'*\');</script>"></iframe><script>window.onmessage = (e) => { window.got = e.data; };</script>']]
      when '/w.js'
        [200, {'content-type' => 'text/javascript'}, ['']]
      when '/sandboxed'
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><iframe sandbox="allow-scripts" srcdoc="<script>try { document.cookie; parent.postMessage(\'read\', \'*\'); } catch (e) { parent.postMessage(e.name, \'*\'); }</script>"></iframe><script>window.onmessage = (e) => { window.got = e.data; };</script>']]
      when '/set'
        [200, {'content-type' => 'text/html', 'set-cookie' => [
          'shared=1; Domain=example.com; Path=/',
          'here=2; Path=/',
          'deep=3; Path=/app',
          'secret=4; HttpOnly; Path=/',
          'gone=5; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT',
          'suffix=6; Domain=com; Path=/',
          '__Host-bad=7; Path=/'
        ]}, ['<!DOCTYPE html><body>set']]
      else
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>page']]
      end
    }
  }

  it 'sends each cookie where its attributes scope it' do
    s = simulated_session(app)
    s.visit 'http://www.example.com/set'
    s.visit 'http://www.example.com/app/page'
    s.visit 'http://www.example.com/other'
    s.visit 'http://api.example.com/'
    expect(seen.drop(1)).to eq([
      ['www.example.com', '/app/page', 'deep=3; shared=1; here=2; secret=4'],
      ['www.example.com', '/other', 'shared=1; here=2; secret=4'],
      ['api.example.com', '/', 'shared=1']
    ])
  end

  it 'hides an HttpOnly cookie from document.cookie, which may not overwrite it' do
    s = simulated_session(app)
    s.visit 'http://www.example.com/set'
    expect(s.evaluate_script('document.cookie')).to eq('shared=1; here=2')
    s.execute_script("document.cookie = 'secret=x'; document.cookie = 'js=8'")
    s.visit 'http://www.example.com/other'
    expect(seen.last).to eq(['www.example.com', '/other', 'shared=1; here=2; secret=4; js=8'])
  end

  # A document of an opaque origin has no cookies: a SecurityError (HTML, Chrome).
  it 'refuses a sandboxed document its cookies' do
    s = simulated_session(app)
    s.visit 'http://www.example.com/sandboxed'
    expect(s.evaluate_script('window.got')).to eq('SecurityError')
  end

  # A load the host makes for a document — an image's, and a fetch() — is cross-site for cookies where its document is,
  # or the top-level one, or a `data:` one it is in, and stays so across its redirects, one the HTTP cache answers too:
  # no Strict or Lax cookie goes (Chrome measured) — a cross-site frame's fetch() back to its own site included, a
  # keepalive one's and a dedicated worker's it made too, the worker's keepalive one included.
  it "sends a cross-site document's image loads no SameSite cookie" do
    seen = []
    app = lambda {|env|
      req = Rack::Request.new(env)
      seen << [req.path, env['HTTP_COOKIE'].to_s] if req.path.start_with?('/echo')
      case req.path
      when '/set'   then [200, {'content-type' => 'text/plain', 'set-cookie' => ['s=1; SameSite=Strict; Path=/', 'l=1; SameSite=Lax; Path=/']}, ['set']]
      when '/fetcher' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><script>fetch("http://b.test/echo-fetch"); fetch("http://b.test/echo-keepalive", {keepalive: true}); new Worker("/w.js")</script>']]
      when '/w.js'    then [200, {'content-type' => 'text/javascript'}, ['fetch("http://b.test/echo-worker"); fetch("http://b.test/echo-wkeep", {keepalive: true})']]
      when '/frame' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><img src="http://a.test/echo-frame">']]
      when '/r301'  then [301, {'location' => 'http://a.test/echo-redirect', 'cache-control' => 'max-age=3600'}, ['']]
      when '/top'   then [200, {'content-type' => 'text/html'}, [
        '<!DOCTYPE html><iframe src="http://b.test/frame"></iframe>' \
        '<iframe src="data:text/html,<img src=http://a.test/echo-data>"></iframe>' \
        '<iframe src="http://b.test/fetcher"></iframe>' \
        '<img src="http://b.test/r301">'
      ]]
      else [200, {'content-type' => 'image/gif'}, ['GIF89a']]
      end
    }
    # (…every host the app's, so the cross-site frame is built as the page loads)
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'
    s = simulated_session(app)
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
    s.visit 'http://a.test/set'
    s.visit 'http://b.test/set'
    2.times { s.visit 'http://a.test/top' }
    # (…the worker's fetches on its own thread, in real time: waited for, a bounded while, rather than raced)
    50.times do
      break if (%w[/echo-worker /echo-wkeep] - seen.map(&:first)).empty?

      sleep 0.1
    end
    expect(seen.map(&:first).uniq.sort).to eq(%w[/echo-data /echo-fetch /echo-frame /echo-keepalive /echo-redirect /echo-wkeep /echo-worker])
    expect(seen.reject {|_, c| c.empty? }).to eq([])
  end

  # An image is fetched under its own `referrerpolicy` attribute where it has one, else its document's (HTML).
  it "refers an image's request under its referrerpolicy attribute" do
    seen = {}
    app = lambda {|env|
      req = Rack::Request.new(env)
      seen[req.params['id']] = env['HTTP_REFERER'] if req.path == '/i'
      next [200, {'content-type' => 'image/gif'}, ['GIF89a']] if req.path == '/i'

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><img src="/i?id=plain"><img referrerpolicy="no-referrer" src="/i?id=none"><img referrerpolicy="bogus" src="/i?id=bogus">']]
    }
    s = simulated_session(app)
    s.visit 'http://www.example.com/page'
    expect(seen).to eq('plain' => 'http://www.example.com/page', 'none' => nil, 'bogus' => 'http://www.example.com/page')
  end

  # …nor may it run a worker from an http(s) script: no script is same-origin with an opaque origin, so its fetch is a
  # network error and the worker's `error` fires (HTML "fetch a classic worker script", mode same-origin).
  it 'fails a sandboxed document a worker' do
    s = simulated_session(app)
    s.visit 'http://www.example.com/sandboxed-worker'
    expect(poll_until { s.evaluate_script('window.got') }).to eq('error')
    expect(seen.map {|_, path, _| path }).not_to include('/w.js')
  end
end
