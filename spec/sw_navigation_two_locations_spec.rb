# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# A navigation a service worker answers with a redirect follows it by the rule the network's redirects are followed by
# (response_headers.rs `redirect_locations`): two different Location fields are a network error (Fetch "extract header
# list values" step 2) — an opaque-redirect's the worker passed on from its own `redirect: 'manual'` fetch, and a
# Response the worker makes with two `location` entries (headers.rs `HeaderList`: each header a field of its own).
# (…service Workers are modeled only in a universal-server context)
RSpec.describe 'a navigation a service worker answers with two Location fields', :every_host_local do
  include PollUntil

  let(:app) {
    worker = <<~JS
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', e => {
        const u = new URL(e.request.url);
        if (u.pathname === '/scope/manual') e.respondWith(fetch('/two', {redirect: 'manual'}));
        else if (u.pathname === '/scope/bytes') e.respondWith(fetch('/twobytes', {redirect: 'manual'}));
        else if (u.pathname === '/scope/one') e.respondWith(new Response(null, {status: 302, headers: [['location', '/a']]}));
        else if (u.pathname === '/scope/made') e.respondWith(new Response(null, {status: 302, headers: [['location', '/a'], ['Location', '/b']]}));
      });
    JS
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [worker]]
      when '/two'
        locations = "/a\n/b"
        [302, {'content-type' => 'text/html', 'location' => locations}, ['<!DOCTYPE html><body>stayed']]
      when '/twobytes'
        locations = "/a\n/\xE9".b
        [302, {'content-type' => 'text/html', 'location' => locations}, ['<!DOCTYPE html><body>stayed']]
      when '/a', '/b' then [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><body>went #{env['PATH_INFO']}"]]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>main']]
      end
    }
  }

  # The frame's document text once its navigation of `path` settled ('' an error document's).
  def frame_text(session, path)
    session.execute_script(<<~JS, path)
      globalThis.__text = null;
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const f = document.createElement('iframe');
        f.onload = () => { globalThis.__text = f.contentDocument?.body?.textContent ?? ''; };
        f.src = arguments[0];
        document.body.appendChild(f);
      });
    JS
    poll_until { session.evaluate_script('globalThis.__text') }
  end

  it 'fails the navigation where the worker passes on an opaque-redirect' do
    session = simulated_session(app)
    session.visit '/'
    expect(frame_text(session, '/scope/manual')).to eq('')
  end

  # (…its fields no UTF-8 text crossing the worker's wire as text all the same: isomorphic-decoded)
  it 'fails the navigation where they are bytes no UTF-8' do
    session = simulated_session(app)
    session.visit '/'
    expect(frame_text(session, '/scope/bytes')).to eq('')
  end

  it 'fails the navigation where the worker makes a Response with two' do
    session = simulated_session(app)
    session.visit '/'
    expect(frame_text(session, '/scope/made')).to eq('')
  end

  it 'follows one' do
    session = simulated_session(app)
    session.visit '/'
    expect(frame_text(session, '/scope/one')).to eq('went /a')
  end
end
