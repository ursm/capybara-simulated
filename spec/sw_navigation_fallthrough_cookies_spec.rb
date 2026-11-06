# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A navigation's hop that its service worker leaves to the network (no `respondWith`) sends the cookies the jar has as
# that request is made — Fetch reads them in "HTTP-network-or-cache fetch", after the worker's leg — so one the hop's
# navigation preload response set on the way is sent with it.
RSpec.describe 'a navigation a service worker leaves to the network' do
  include PollUntil

  let(:sent) { [] }
  let(:app) {
    worker = <<~JS
      self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
      self.addEventListener('activate', (e) => e.waitUntil(self.registration.navigationPreload.enable().then(() => self.clients.claim())));
      self.addEventListener('fetch', () => {});
    JS
    sent = self.sent
    lambda {|env|
      preload = env['HTTP_SERVICE_WORKER_NAVIGATION_PRELOAD']
      sent << [env['PATH_INFO'], preload ? :preload : :network, env['HTTP_COOKIE']]
      headers = {'content-type' => 'text/html'}
      headers['set-cookie'] = 'pre=1; Path=/' if preload
      case env['PATH_INFO']
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [worker]]
      when '/reg'
        [200, headers, [%(<!DOCTYPE html><script>navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => document.title = 'ready')</script>)]]
      else [200, headers, ['<!DOCTYPE html><body>page']]
      end
    }
  }

  it 'sends the cookie its preload response set' do
    session = simulated_session(app)
    session.visit '/reg'
    expect(poll_until { session.title == 'ready' }).to be(true)
    session.visit '/page'
    expect(sent.select {|path, _| path == '/page' }.map {|_, kind, cookie| [kind, cookie] }).to eq([[:preload, nil], [:network, 'pre=1']])
  end
end
