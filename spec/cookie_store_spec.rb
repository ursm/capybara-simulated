# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A session's cookies are its cookie store's, the engine's (cookie_jar.rs), as RFC 6265bis has a user agent keep them: a
# cookie set with a Domain goes to every host that domain-matches it — a public suffix none — one set with a Path only to
# the paths under it, an HttpOnly one to no `document.cookie`, an expired one nowhere, and a `__Host-` one only where it
# is Secure, host-only and at `/`. (They had been a name → value table per host, which read none of these.)
RSpec.describe 'the cookie store' do
  let(:seen) { [] }
  let(:app) {
    seen = self.seen
    lambda {|env|
      req = Rack::Request.new(env)
      seen << [req.host, req.path, env['HTTP_COOKIE'].to_s]
      case req.path
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
end
