# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A parser-blocking script of a document a service worker controls, which the worker lets through to the network, is dated
# as a preload scanner's fetch is — as its parse began — as the network's are where no worker controls it: two scripts of
# the network's markup whose servers take as long are fetched alongside, the second waited for only what is left of its
# server's time (Chrome and Firefox `b b2 inl`, rv-r13-probe `s6_dating`; subresource_obtain.rs `Leg::Worker`).
RSpec.describe 'a parser-blocking script a service worker lets through' do
  include PollUntil

  let(:app) {
    worker = <<~JS
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', () => {});
    JS
    page = '<!DOCTYPE html><meta charset="utf-8"><script>window.t0 = Date.now()</script>' \
           '<script src="/scope/b1.js"></script><script src="/scope/b2.js"></script><script>window.dt = Date.now() - t0</script>'
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'                then [200, {'content-type' => 'text/html'}, ['<html><body>main</body></html>']]
        when '/sw.js'           then [200, {'content-type' => 'text/javascript'}, [worker]]
        when '/scope/page.html' then [200, {'content-type' => 'text/html'}, [page]]
        when %r{\A/scope/b\d\.js\z}
          sleep 0.15
          [200, {'content-type' => 'text/javascript', 'cache-control' => 'no-store'}, ['window.ran = (window.ran || 0) + 1']]
        else [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  it 'waits for the second only what is left of its server time past the parse beginning' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__active = false;
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        globalThis.__active = true;
      });
    JS
    poll_until { session.evaluate_script('globalThis.__active') }
    session.visit '/scope/page.html'
    expect(session.evaluate_script('[window.ran, !!navigator.serviceWorker.controller]')).to eq([2, true])
    expect(session.evaluate_script('window.dt')).to be_between(140, 250)
  end
end
