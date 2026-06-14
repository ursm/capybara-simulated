require 'capybara/simulated'
require 'open3'

# A runaway script must NOT abort the whole process. rusty_racer's per-isolate
# `memory_limit` (wired in v8_runtime.rb) turns V8's fatal "Reached heap limit"
# OOM — which used to kill the test process and every remaining example with it,
# uncatchable from Ruby — into a catchable `RustyRacer::V8OutOfMemoryError`,
# after which the isolate recovers and stays usable. This guards against a
# future rusty upgrade silently regressing to the fatal abort.
#
# The limit is read once at require time, so the scenario runs in a subprocess
# with a small `CSIM_V8_MEMORY_LIMIT_MB` (the 3.5 GB default would take far too
# long / too much RAM to trip).
RSpec.describe 'V8 memory_limit backstop' do
  before do
    env = ENV['CSIM_JS_ENGINE'].to_s
    v8  = env.empty? ? Gem.loaded_specs.key?('rusty_racer') : env == 'v8'
    skip 'memory_limit is a rusty_racer (V8) feature' unless v8
  end

  it 'raises a catchable error on heap exhaustion and the isolate recovers' do
    script = <<~RUBY
      require 'capybara/simulated'
      require 'capybara/simulated/v8_runtime'
      c = Capybara::Simulated::V8Runtime::Ctx.new
      begin
        c.eval('var a = []; while (true) { a.push(new Array(200000).fill(7)); }')
        print 'NO_ERROR'
      rescue RustyRacer::V8OutOfMemoryError
        # The isolate should recover (forced GC + ceiling reset) and stay usable.
        print(c.eval('1 + 1') == 2 ? 'CAUGHT_AND_RECOVERED' : 'CAUGHT_NO_RECOVERY')
      rescue => e
        print "WRONG_ERROR:\#{e.class}"
      end
    RUBY

    out, status = Open3.capture2e(
      ENV.to_h.merge('CSIM_JS_ENGINE' => 'v8', 'CSIM_V8_MEMORY_LIMIT_MB' => '128'),
      RbConfig.ruby, '-e', script
    )

    # A fatal V8 OOM would dump core / print "Reached heap limit" and exit
    # non-zero; the catchable path exits cleanly with the sentinel.
    expect(out).to include('CAUGHT_AND_RECOVERED'), "subprocess output: #{out}"
    expect(status).to be_success
    expect(out).not_to match(/Fatal JavaScript out of memory|Reached heap limit/)
  end
end
