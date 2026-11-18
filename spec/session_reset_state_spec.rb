# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/https_app_host'
require_relative 'support/every_host_local'

# A session reset leaves the next test a fresh window: nothing the last test's documents were still to do is left for the
# next test's event loop to run, nor keeps it stepping (Browser#steps_pending?, which every poll of the session reads).
# What was left reached no page of the next test — a `storage` event goes to the documents there were as the change was
# made (storage_areas.rs `storage_event_targets`), a deferred navigation is made again only while it is its navigable's
# ongoing one, none after the reset — so the host's own account of its work is what the leak showed in.
RSpec.describe 'session reset' do
  include PollUntil

  # A `storage` event another window's change queued for this window's documents, which they were still to fire.
  it 'lets go of the storage events the last documents were still to fire' do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><p>page</p>']] })
    session.visit('/')
    browser = session.driver.browser
    other = session.open_new_window
    session.within_window(other) do
      session.visit('/')
      session.execute_script("localStorage.setItem('k', 'v')")
    end
    expect(browser.window_message_pending?).to be(true)
    session.reset_session!
    expect(browser.window_message_pending?).to be(false)
    expect(browser.steps_pending?).to be(false)
  end

  # A navigation deferred on a service worker still activating: not the next test's to make, nor to keep it stepping.
  context 'with a navigation deferred on an activating worker', :every_host_local, :https do
    let(:session) do
      simulated_session(lambda {|env|
        html = ->(body) { [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8>#{body}"]] }
        case env['PATH_INFO']
        when '/sw.js'
          [200, {'content-type' => 'text/javascript'}, [<<~JS]]
            self.addEventListener('install', () => self.skipWaiting());
            self.addEventListener('activate', (e) => e.waitUntil(new Promise((r) => self.addEventListener('message', (m) => { if (m.data === 'go') r(); }))));
            self.addEventListener('fetch', (e) => e.respondWith(new Response('<!doctype html><title>FROM-SW</title>', {headers: {'content-type': 'text/html'}})));
          JS
        when '/reg'
          html.(<<~HTML)
            <title>reg</title>
            <script>
              navigator.serviceWorker.register('/sw.js', {scope: '/sw/'}).then((r) => {
                const worker = r.installing || r.waiting || r.active;
                const seen = () => { if (worker.state === 'activating') document.title = 'activating'; };
                seen();
                worker.addEventListener('statechange', seen);
              });
            </script>
          HTML
        else html.("<title>NET#{env['PATH_INFO']}</title>")
        end
      })
    end

    it 'lets go of it' do
      session.visit('https://a.test/reg')
      expect(poll_until { session.evaluate_script('document.title') == 'activating' }).to be(true)
      session.execute_script("location.href = '/sw/deferred'")
      expect(session.title).to eq('activating')
      session.reset_session!
      browser = session.driver.browser
      browser.sw_navigations_due!
      expect(browser.steps_pending?).to be(false)
      session.visit('https://a.test/plain')
      expect(session).to have_title('NET/plain')
    end
  end
end
