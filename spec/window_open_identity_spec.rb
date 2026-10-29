# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# `window.open(url, target)` whose target chooses an existing navigable returns its WindowProxy (HTML "window open
# steps": the chosen navigable's active WindowProxy) — the same object this realm's `parent`, `top` and `window` are.
# (A frame a name chose returns the one its container's realm hands out: WindowProxies here are per realm, so another
# realm's `parent` of the same navigable is another object.)
RSpec.describe 'window.open choosing an existing navigable' do
  include PollUntil

  it "returns this realm's WindowProxy of it" do
    session = simulated_session(lambda {|env|
      body = case env['PATH_INFO']
             when '/'   then '<iframe name=f1 src=/one></iframe>'
             when '/one' then '<iframe name=f2 src=/two></iframe>'
             else
               '<p>two</p><script>window.result = [open("", "_parent") === parent, open("", "_top") === top, ' \
                 'open("", "f2") === window, open("", "_self") === window]</script>'
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/'
    expect(poll_until { session.evaluate_script('frames[0]?.frames[0]?.result') }).to eq([true, true, true, true])
  end
end
