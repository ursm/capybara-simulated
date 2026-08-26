require 'spec_helper'
require 'capybara/simulated/trace'
require 'capybara/simulated/trace_persistence'
require 'capybara/minitest'  # defines Capybara::Minitest — the reason a bare `Minitest::Skip`
require 'capybara/simulated/minitest'  # inside the gem resolves wrong; keep this require BEFORE it
require 'json'
require 'open3'
require 'tmpdir'
require_relative 'support/session_teardown'

RSpec.describe Capybara::Simulated::Trace do
  def sample_trace
    described_class.new(metadata: {title: 'demo', outcome: 'failed'}).tap do |t|
      t.begin_step(:visit, description: '/', url_before: nil)
      t.log_console(:log, 'boot')
      t.finish_step(url_after: '/')
      t.begin_step(:click, description: 'Pay', url_before: '/')
      # A DOM snapshot whose inline script would close the embedding
      # <script> block early if it weren't escaped.
      t.finish_step(
        url_after: '/',
        dom_after: "<div>x</div><script>var s='</script>'</script>",
        error:     {class: 'Capybara::ElementNotFound', message: 'nope'}
      )
    end
  end

  describe '#log_network' do
    it 'records the rich fields and drops the ones the caller omitted' do
      t = described_class.new
      t.begin_step(:click, description: 'Pay')
      t.log_network('POST', '/api', 500,
                    content_type: 'application/json', size: 86, duration_ms: 42,
                    request_headers: {'X-CSRF-Token' => 'abc'}, request_body: '{"a":1}',
                    response_headers: {'content-type' => 'application/json'}, response_body: '{"error":"x"}')
      t.log_network('GET', '/style.css', 200)  # bare call — extras absent
      t.finish_step

      rich, bare = t.steps.first.network
      expect(rich).to include(
        method: 'POST', status: 500, content_type: 'application/json', size: 86,
        request_body: '{"a":1}', response_body: '{"error":"x"}'
      )
      expect(rich[:request_headers]).to eq({'X-CSRF-Token' => 'abc'})
      # compact: a bare call carries no nil keys for the fields it didn't set.
      expect(bare.keys).to contain_exactly(:method, :url, :status)
    end
  end

  describe 'screenshots' do
    # WHERE a screenshot is taken is the whole design. A paint costs ~50 ms on V8 and ~525 ms on
    # QuickJS, so taking one on an action's failure path puts it inside Capybara's retry window —
    # measured, a click waiting on an overlay went from 35 ms to 563 ms, which is enough to turn an
    # action a retry would have rescued into a failure. So the default mode paints ONCE, after the
    # example, only when it failed (`TracePersistence`), and per-step painting is `CSIM_TRACE=full`
    # only — where it must still not follow every RETRY, since Capybara records a step per attempt
    # and photographing each produced 60 identical PNGs for one failed click.
    it 'takes one per failing action, not one per retry' do
      t = described_class.new
      3.times do
        t.begin_step(:click, description: 'click Pay')
        expect(t.retrying_failure?(:click, 'click Pay')).to eq(t.steps.any?)
        t.finish_step(error: {class: 'X', message: 'nope'})
      end
      # …and a DIFFERENT action, or one that did not error, is not a retry of it.
      t.begin_step(:click, description: 'click Cancel')
      expect(t.retrying_failure?(:click, 'click Cancel')).to be false
      t.finish_step
      expect(t.retrying_failure?(:click, 'click Pay')).to be false
    end

    it 'carries the image inline, so the viewer stays a single file' do
      t = described_class.new
      t.begin_step(:click, description: 'click Pay')
      t.finish_step(shot_after: 'data:image/png;base64,AAA', error: {class: 'X', message: 'nope'})
      step = JSON.parse(t.to_json)['steps'].first
      expect(step['shot_after']).to eq('data:image/png;base64,AAA')
    end
  end

  describe '.render_viewer' do
    it 'embeds the JSON, leaving no unreplaced placeholder' do
      html = described_class.render_viewer(sample_trace.to_json)

      expect(html).not_to include('__CSIM_TRACE_DATA__')
      expect(html).to include('capybara-simulated trace')  # the viewer chrome
    end

    it 'escapes EVERY `<`, so nothing in a snapshot can steer the HTML tokenizer' do
      html = described_class.render_viewer(sample_trace.to_json)

      data = html[%r{<script id="csim-trace"[^>]*>(.*?)</script>}m, 1]
      expect(data).not_to include('<')
      expect(data).to include('\\u003c/script>')
    end

    # Escaping only `</` is the tempting half-measure, and it is worse than nothing: `<!--` puts
    # the tokenizer into script-data-escaped state and a following `<script` into DOUBLE-escaped
    # state, where a real `</script>` no longer closes the element — and `</` escaping guarantees
    # the one sequence that could leave that state never appears. The viewer swallowed itself and
    # rendered a blank page. A page with a commented-out script tag is all it takes.
    it 'survives a snapshot that comments out a script tag' do
      trace = described_class.new(metadata: {title: 'demo'})
      trace.begin_step(:visit, description: '/')
      trace.finish_step(dom_after: '<html><head><!-- <script src="/a.js"></script> --></head></html>')
      html = described_class.render_viewer(trace.to_json)

      data = html[%r{<script id="csim-trace"[^>]*>(.*?)</script>}m, 1]
      # The block ends where it should: everything after it is still the viewer, not swallowed text.
      expect(html[html.index(data) + data.length, 400]).to include('</script>')
      expect(JSON.parse(data.gsub('\\u003c', '<'))['steps'][0]['dom_after']).to include('<!-- <script')
    end

    it 'round-trips: the embedded JSON un-escapes back to the original trace' do
      html = described_class.render_viewer(sample_trace.to_json)

      data    = html[%r{<script id="csim-trace"[^>]*>(.*?)</script>}m, 1]
      decoded = JSON.parse(data.gsub('\\u003c', '<'))

      expect(decoded['metadata']['title']).to eq('demo')
      expect(decoded['steps'].size).to eq(2)
      expect(decoded['steps'][1]['error']['class']).to eq('Capybara::ElementNotFound')
      expect(decoded['steps'][1]['dom_after']).to include('</script>')
    end
  end
end

# The other half of the contract: which moments the DRIVER paints, live.
RSpec.describe 'trace screenshots, end to end' do
  include SimulatedSessionTeardown

  # A page whose only button is under an overlay that never clears, so a click retries for its
  # whole wait window and then raises — the exact shape that must not be photographed per attempt.
  def blocked_page
    <<~HTML
      <!DOCTYPE html><html><body>
        <button id="btn" onclick="window.__clicked = true">go</button>
        <div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5)"></div>
      </body></html>
    HTML
  end

  def traced_session(html, mode)
    prev = ENV['CSIM_TRACE']
    ENV['CSIM_TRACE'] = mode
    s = simulated_session(lambda {|_env| [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    yield s
  ensure
    prev.nil? ? ENV.delete('CSIM_TRACE') : ENV['CSIM_TRACE'] = prev
  end

  it 'paints nothing per step in the default mode, however an action fails' do
    traced_session(blocked_page, 'on-failure') do |s|
      expect { s.using_wait_time(0.3) { s.find('#btn').click } }.to raise_error(StandardError)
      steps = s.driver.current_trace.steps
      failed = steps.select(&:error)
      expect(failed).not_to be_empty                       # it did record the failure…
      expect(steps.map(&:shot_after).compact).to be_empty  # …and painted none of it
      # The DOM snapshot follows the same one-per-ACTION rule, so a retried click cannot serialize
      # the document on every attempt.
      expect(failed.count {|st| st.dom_after }).to eq(1)
    end
  end

  it 'paints a successful action in full mode, and still not a failing one' do
    traced_session(blocked_page, 'full') do |s|
      expect { s.using_wait_time(0.3) { s.find('#btn').click } }.to raise_error(StandardError)
      steps = s.driver.current_trace.steps
      # The `visit` succeeded, so it has one…
      expect(steps.first.shot_after).to start_with('data:image/png;base64,')
      # …and not one of the failing click's attempts does.
      expect(steps.select(&:error).map(&:shot_after).compact).to be_empty
    end
  end

  it 'paints the active window, not the primary one' do
    traced_session('<!DOCTYPE html><html><body><h1>PRIMARY</h1></body></html>', 'on-failure') do |s|
      shot = s.driver.trace_screenshot
      expect(shot).to start_with('data:image/png;base64,')
      # A test that ended inside `switch_to_window` must be handed the window it was looking at.
      expect(s.driver).to respond_to(:trace_screenshot)
    end
  end
end

RSpec.describe Capybara::Simulated::TracePersistence do
  # Minimal driver double: a real Trace, with stop_tracing writing JSON.
  fake_driver = Class.new do
    attr_reader :shots

    def initialize(trace, shot: 'data:image/png;base64,AAA')
      @trace = trace
      @shot  = shot
      @shots = 0
    end
    def tracing?          = !@trace.nil?
    def current_trace     = @trace
    def stop_tracing(path:) = @trace.write_json(path)
    def js_engine           = :v8
    # Counted, because WHEN this is called is the contract: a paint is ~50 ms on a small page and
    # several hundred on an app-scale one, so a passing example must not pay for one.
    def trace_screenshot
      @shots += 1
      @shot
    end
  end

  def traced
    Capybara::Simulated::Trace.new.tap do |t|
      t.begin_step(:visit, description: '/')
      t.finish_step
    end
  end

  describe '.slug' do
    it 'keeps word chars, collapses the rest, and caps length' do
      # `:` `#` ` ` `/` are all outside [A-Za-z0-9._-] → each run collapses to one `_`.
      expect(described_class.slug('Foo::Bar#baz qux/x')).to eq('Foo_Bar_baz_qux_x')
      expect(described_class.slug('a' * 500).length).to eq(200)
    end
  end

  describe '.persist' do
    it 'stamps the supplied metadata and writes <slug-of-title>.json' do
      Dir.mktmpdir do |dir|
        described_class.persist(fake_driver.new(traced), dir,
                                title: 'Widget does a thing', file: './spec/widget_spec.rb:9',
                                outcome: 'passed', exception: nil)

        path = File.join(dir, 'Widget_does_a_thing.json')
        expect(File).to exist(path)
        meta = JSON.parse(File.read(path))['metadata']
        expect(meta['outcome']).to eq('passed')
        expect(meta['title']).to eq('Widget does a thing')
      end
    end

    it 'records a failed outcome + message' do
      Dir.mktmpdir do |dir|
        described_class.persist(fake_driver.new(traced), dir,
                                title: 'boom', file: './x:1', outcome: 'failed', exception: 'kaboom')

        meta = JSON.parse(File.read(File.join(dir, 'boom.json')))['metadata']
        expect(meta['outcome']).to eq('failed')
        expect(meta['exception']).to eq('kaboom')
      end
    end

    # WHERE the screenshot is taken is the design (see `Browser#record_action`): never on an
    # action's failure path, where it would sit inside Capybara's retry window and can turn an
    # action a retry would have rescued into a failure. Here — after the example, once, and only
    # for one that failed.
    it 'paints the final state for a failing example, once' do
      Dir.mktmpdir do |dir|
        driver = fake_driver.new(traced)
        described_class.persist(driver, dir, title: 'boom', file: './x:1',
                                             outcome: 'failed', exception: 'kaboom')

        expect(driver.shots).to eq(1)
        meta = JSON.parse(File.read(File.join(dir, 'boom.json')))['metadata']
        expect(meta['screenshot']).to eq('data:image/png;base64,AAA')
      end
    end

    it 'records which engine produced the trace, and omits the key when the driver cannot say' do
      Dir.mktmpdir do |dir|
        described_class.persist(fake_driver.new(traced), dir, title: 'engine', file: './x:1',
                                                              outcome: 'passed', exception: nil)
        expect(JSON.parse(File.read(File.join(dir, 'engine.json')))['metadata']['engine']).to eq('v8')

        # A foreign driver — or one whose accessor raises — leaves the key out rather than
        # writing a null, and never costs the trace file.
        mute = fake_driver.new(traced)
        mute.define_singleton_method(:js_engine) { raise 'no' }
        described_class.persist(mute, dir, title: 'mute', file: './x:1', outcome: 'passed', exception: nil)
        expect(JSON.parse(File.read(File.join(dir, 'mute.json')))['metadata']).not_to have_key('engine')
      end
    end

    it 'paints nothing for an example that passed' do
      Dir.mktmpdir do |dir|
        driver = fake_driver.new(traced)
        described_class.persist(driver, dir, title: 'fine', file: './x:1',
                                             outcome: 'passed', exception: nil)

        expect(driver.shots).to eq(0)
        expect(JSON.parse(File.read(File.join(dir, 'fine.json')))['metadata']).not_to have_key('screenshot')
      end
    end

    it 'leaves a screenshot the host already took, and still writes the file when the paint fails' do
      Dir.mktmpdir do |dir|
        # Minitest paints BEFORE its own teardown resets the page, and stamps it here; persisting
        # must not overwrite that with a picture of the blank page the reset installed.
        early = traced.tap {|t| t.metadata[:screenshot] = 'data:image/png;base64,EARLY' }
        driver = fake_driver.new(early)
        described_class.persist(driver, dir, title: 'early', file: './x:1',
                                             outcome: 'failed', exception: 'k')
        expect(driver.shots).to eq(0)
        expect(JSON.parse(File.read(File.join(dir, 'early.json')))['metadata']['screenshot'])
          .to eq('data:image/png;base64,EARLY')

        # …and a paint that explodes loses the image, never the trace.
        boom = fake_driver.new(traced)
        def boom.trace_screenshot = raise(NoMemoryError, 'no')
        expect {
          described_class.persist(boom, dir, title: 'boom2', file: './x:1', outcome: 'failed', exception: 'k')
        }.to output(/trace screenshot failed/).to_stderr
        expect(File).to exist(File.join(dir, 'boom2.json'))
      end
    end

    it 'is a no-op for a driver that recorded nothing' do
      Dir.mktmpdir do |dir|
        described_class.persist(fake_driver.new(nil), dir,
                                title: 'x', file: 'y', outcome: 'passed', exception: nil)
        expect(Dir.empty?(dir)).to be(true)
      end
    end
  end
end

RSpec.describe Capybara::Simulated::MinitestTrace do
  describe '.real_failures' do
    it 'drops skips, keeping assertions and errors' do
      skip   = Minitest::Skip.new('later')
      assert = Minitest::Assertion.new('boom')
      test   = Struct.new(:failures).new([skip, assert])

      expect(described_class.real_failures(test)).to eq([assert])
    end
  end
end

RSpec.describe 'trace network capture' do
  # Regression: with tracing active, `trace_network` ran on every fetch.
  # A Rack-3 array-valued header made it raise, and rack_fetch's rescue
  # swallowed that as a failed fetch → the asset (e.g. jQuery) silently
  # failed to load. A trace-logging error must never break the fetch.
  it 'never breaks a fetch when a response header is array-valued' do
    app = lambda do |env|
      if env['PATH_INFO'] == '/data'
        [200, {'content-type' => ['application/json']}, ['{"ok":1}']]  # array value
      else
        [200, {'content-type' => 'text/html'},
         ['<!doctype html><html><body><script>' \
          'fetch("/data").then(function(r){return r.text()}).then(function(t){document.body.dataset.t=t})' \
          '</script></body></html>']]
      end
    end
    driver = simulated_driver(app)
    driver.start_tracing  # force a trace so trace_network runs on the fetch
    driver.visit('/')

    # Without the fix, trace_network raises on the array header (before it
    # even reaches the open-step check), rack_fetch swallows it, returns
    # nil, and the body is never set.
    expect(driver.evaluate_script('document.body.dataset.t || ""')).to eq('{"ok":1}')
  end

  # Regression: Rack response bodies are ASCII-8BIT. A body whose bytes are
  # valid UTF-8 but stays BINARY-tagged flowed through cap_trace_body still
  # BINARY; once it exceeded the size cap, the truncation-marker concat (and
  # otherwise the trace-buffer / JSON serialization) raised
  # Encoding::CompatibilityError on any byte ≥ 0x80 — the "trace network log
  # failed: Encoding::CompatibilityError" spam seen on Discourse.
  it 'reinterprets a binary-tagged (valid UTF-8) body as readable UTF-8, even past the size cap' do
    browser = simulated_driver(->(_) { [200, {}, ['']] }).browser
    big = ('日本語のテスト ' * 40_000).b   # ASCII-8BIT, valid UTF-8 bytes, > 256 KiB
    expect(big.encoding).to eq(Encoding::BINARY)

    out = nil
    expect { out = browser.send(:cap_trace_body, big) }.not_to raise_error
    expect(out.encoding).to eq(Encoding::UTF_8)
    expect(out).to include('日本語')      # readable, not mojibake
    expect(out).to include('truncated')   # past the 256 KiB cap
    # Must survive the downstream UTF-8 concat / JSON serialization that used to raise.
    expect { (+'utf8 ') << out; require 'json'; JSON.generate(b: out) }.not_to raise_error

    # A genuinely binary body still collapses to a placeholder (not mojibake).
    png = [0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00].pack('C*')
    expect(browser.send(:cap_trace_body, png)).to match(/\A\[binary, \d+ bytes\]\z/)
  end
end

RSpec.describe 'capybara-simulated CLI' do
  EXE = File.expand_path('../exe/capybara-simulated', __dir__)
  LIB = File.expand_path('../lib', __dir__)

  def run_cli(*args, **opts)
    Open3.capture2e(RbConfig.ruby, '-I', LIB, EXE, *args, **opts)
  end

  def write_trace(path)
    File.write(path, Capybara::Simulated::Trace.new.tap {|t|
      t.begin_step(:visit, description: '/')
      t.finish_step
    }.to_json)
  end

  it 'renders a trace JSON to the requested -o path (no browser launch with --no-open)' do
    Dir.mktmpdir do |dir|
      json = File.join(dir, 'flow.json')
      write_trace(json)
      html = File.join(dir, 'view.html')

      out, status = run_cli('trace', json, '-o', html, '--no-open')

      expect(status).to be_success
      expect(File).to exist(html)
      expect(File.read(html)).to include('csim-trace')
      expect(File.read(html)).not_to include('__CSIM_TRACE_DATA__')
      expect(out).to include('view.html')
    end
  end

  it 'defaults the output to a temp file named after the trace' do
    Dir.mktmpdir do |dir|
      json = File.join(dir, 'checkout.json')
      write_trace(json)

      out, status = run_cli('trace', json, '--no-open')

      expect(status).to be_success
      expected = File.join(Dir.tmpdir, 'checkout.html')
      expect(out).to include(expected)
      expect(File).to exist(expected)
    ensure
      File.delete(File.join(Dir.tmpdir, 'checkout.html')) rescue nil
    end
  end

  it 'writes to stdout with -o - (and does not open a browser)' do
    Dir.mktmpdir do |dir|
      json = File.join(dir, 't.json')
      File.write(json, '{"version":1,"metadata":{},"steps":[]}')

      out, status = run_cli('trace', json, '-o', '-')

      expect(status).to be_success
      expect(out).to start_with('<!DOCTYPE html>')
    end
  end

  it 'exits non-zero with a message on invalid JSON' do
    Dir.mktmpdir do |dir|
      json = File.join(dir, 'bad.json')
      File.write(json, 'not json{')

      out, status = run_cli('trace', json, '--no-open')

      expect(status).not_to be_success
      expect(out).to include('not valid JSON')
    end
  end

  it 'exits non-zero on an unknown option without a backtrace' do
    out, status = run_cli('trace', '--nope', '/tmp/whatever.json')

    expect(status).not_to be_success
    expect(out).to include('invalid option')
    expect(out).not_to include('(NoMethodError)')
  end
end
