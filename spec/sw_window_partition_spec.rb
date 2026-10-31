# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/https_app_host'
require_relative 'support/every_host_local'

# An isolate keeps the service worker registrations of its page's storage partition (browser.rb `@sw_partition`). A
# same-site pop-up is a window of that isolate (Driver#hosts_partition?) — and stays one when a redirect, or a navigation
# of its own, takes it to another top-level site (HTML keeps its browsing context group, no COOP asking otherwise). Its
# document of that site is of another storage partition, whose registrations the isolate keeps none of: none of its
# registers lands in the page's (blob_rules.rs `registryPartition`), and no worker of the page's handles its navigation —
# a third-party frame of that site under the page sees none of it.
RSpec.describe 'the service worker registry of a pop-up gone to another site', :every_host_local, :https do
  include PollUntil

  let(:session) do
    simulated_session(lambda {|env|
      case env['PATH_INFO']
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, ['']]
      when '/redir' then [302, {'location' => 'https://other.test/reg'}, []]
      when '/reg'
        script = "navigator.serviceWorker.register('/sw.js').then(() => document.title = 'registered', (e) => document.title = e.name)"
        [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><title>reg</title><script>#{script}</script>"]]
      when '/count'
        script = "navigator.serviceWorker.getRegistrations().then((r) => parent.postMessage(r.length, '*'))"
        [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><script>#{script}</script>"]]
      when '/frame'
        script = "addEventListener('message', (e) => document.title = 'n=' + e.data)"
        [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><script>#{script}</script><iframe src='https://other.test/count'></iframe>"]]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><title>x</title>']]
      end
    })
  end

  it 'registers nothing in the page partition from a pop-up a redirect took to another site' do
    session.visit 'https://a.test/'
    session.execute_script("window.w = open('/redir')")
    popup = session.windows.last
    title = -> { session.within_window(popup) { session.title } }
    expect(poll_until { title.() != 'reg' && title.() }).to eq('SecurityError')
    session.visit 'https://a.test/frame'
    expect(poll_until { session.title.start_with?('n=') && session.title }).to eq('n=0')
  end
end
