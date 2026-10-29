# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# `window.open(url, target)` whose target chooses an existing navigable returns its WindowProxy (HTML "window open
# steps": the chosen navigable's active WindowProxy) — the same object this realm's `parent`, `top` and `window` are.
# (Another frame a name chose returns the one its container's realm hands out: WindowProxies here are per realm, so
# another realm's view of the same navigable is another object.)
RSpec.describe 'window.open choosing an existing navigable' do
  include PollUntil

  it "returns this realm's WindowProxy of it" do
    session = simulated_session(lambda {|env|
      body = case env['PATH_INFO']
             when '/'   then '<iframe name=f1 src=/one></iframe>'
             when '/one' then '<iframe name=f2 src=/two></iframe>'
             else
               '<p>two</p><script>window.result = [open("", "_parent") === parent, open("", "_top") === top, ' \
                 'open("", "f1") === parent, open("", "f2") === window, open("", "_self") === window]</script>'
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/'
    expect(poll_until { session.evaluate_script('frames[0]?.frames[0]?.result') }).to eq([true, true, true, true, true])
  end

  # …and navigates its own window with history handling "auto": a new entry, even as its document loads, where a
  # `location.href` set then replaces it (HTML "Location-object navigate"; Chrome: `open(url, '_self')` pushes).
  %w[_self me].each do |target|
    it "adds a session history entry navigating its own window by #{target}" do
      session = simulated_session(lambda {|env|
        script = env['PATH_INFO'] == '/h1' ? %(<script>window.name = 'me'; open('/h2', '#{target}')</script>) : ''
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{env['PATH_INFO']}#{script}"]]
      })
      session.visit '/h0'
      session.visit '/h1'
      expect(poll_until { session.current_path == '/h2' && session.evaluate_script('history.length') }).to eq(3)
    end
  end
end
