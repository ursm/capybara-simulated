# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A script's fetch is made in the event loop's order and lands as far after it began as its server took (script_fetch.rs):
# the Set-Cookie of its response is stored as it lands — Fetch processes its headers as its response comes in — so a script
# that runs before then reads none of it, whatever real time the server spent working (Chrome and Firefox: `inl:` empty,
# the script's own read `s=1`).
RSpec.describe 'a script fetch and cookies' do
  def log_with(busy_ms)
    app = ->(env) {
      if env['PATH_INFO'] == '/sc.js'
        t0 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        nil while Process.clock_gettime(Process::CLOCK_MONOTONIC) - t0 < busy_ms / 1000.0
        next [200, {'content-type' => 'text/javascript', 'set-cookie' => 's=1; path=/'}, ['R.push("sc:" + document.cookie)']]
      end
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><title>t</title><script async src="/sc.js"></script><script>window.R = ["inl:" + document.cookie]</script>']]
    }
    s = simulated_session(app)
    s.visit '/'
    s.evaluate_script('R.join(" ")')
  end

  [0, 150].each do |busy|
    it "stores an `async` script's cookie as it lands, its server busy #{busy} ms" do
      expect(log_with(busy)).to eq('inl: sc:s=1')
    end
  end
end
