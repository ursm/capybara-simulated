# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/https_app_host'

# A navigation a controlling service worker passes through (`fetch(event.request)`) reaches the server with the request
# metadata of the navigation's own initiating document — an about:blank frame's its creator's, whose origin its POST's
# Origin is — as one no worker controls does.
RSpec.describe 'a service worker passthrough navigation' do
  include PollUntil

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # Service Workers are modeled only in a universal-server context
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  it "carries the Origin of an about:blank frame's creator", :https do
    seen = {}
    worker = "self.addEventListener('fetch', (e) => { if (e.request.mode === 'navigate') e.respondWith(fetch(e.request)); });"
    s = simulated_session(lambda {|env|
      seen[env['PATH_INFO']] = [env['HTTP_SEC_FETCH_SITE'], env['HTTP_ORIGIN']]
      next [200, {'content-type' => 'text/javascript'}, [worker]] if env['PATH_INFO'] == '/sw.js'

      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8>#{env['PATH_INFO']}"]]
    })
    s.visit '/'
    s.execute_script(<<~JS)
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async (reg) => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise((res) => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        window.ready = true;
      });
    JS
    poll_until { s.evaluate_script('window.ready') }
    s.execute_script(<<~JS)
      for (const path of ['/scope/post', '/noscope/post']) {
        const d = document.body.appendChild(document.createElement('iframe')).contentDocument;
        d.write(`<form method=post action="${location.origin}${path}"></form>`);
        d.close();
        d.forms[0].submit();
      }
    JS
    expect(poll_until { seen['/scope/post'] && seen['/noscope/post'] && seen.slice('/scope/post', '/noscope/post') }).to eq(
      '/scope/post' => ['same-origin', 'https://www.example.com'], '/noscope/post' => ['same-origin', 'https://www.example.com']
    )
  end
end
