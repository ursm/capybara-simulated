require 'spec_helper'
require 'capybara/simulated/trace'
require 'capybara/simulated/trace_persistence'
require 'capybara/minitest'  # defines Capybara::Minitest — the reason a bare `Minitest::Skip`
require 'capybara/simulated/minitest'  # inside the gem resolves wrong; keep this require BEFORE it
require 'json'
require 'open3'
require 'tmpdir'

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

  describe '.render_viewer' do
    it 'embeds the JSON, leaving no unreplaced placeholder' do
      html = described_class.render_viewer(sample_trace.to_json)

      expect(html).not_to include('__CSIM_TRACE_DATA__')
      expect(html).to include('capybara-simulated trace')  # the viewer chrome
    end

    it 'escapes `</` so an embedded </script> cannot close the data block' do
      html = described_class.render_viewer(sample_trace.to_json)

      data = html[%r{<script id="csim-trace"[^>]*>(.*?)</script>}m, 1]
      # The data block carries no raw `</`; the snapshot's `</script>`
      # survives only as the JSON escape `<\/script>`.
      expect(data).not_to include('</')
      expect(data).to include('<\\/script>')
    end

    it 'round-trips: the embedded JSON un-escapes back to the original trace' do
      html = described_class.render_viewer(sample_trace.to_json)

      data    = html[%r{<script id="csim-trace"[^>]*>(.*?)</script>}m, 1]
      decoded = JSON.parse(data.gsub('<\\/', '</'))

      expect(decoded['metadata']['title']).to eq('demo')
      expect(decoded['steps'].size).to eq(2)
      expect(decoded['steps'][1]['error']['class']).to eq('Capybara::ElementNotFound')
      expect(decoded['steps'][1]['dom_after']).to include('</script>')
    end
  end
end

RSpec.describe Capybara::Simulated::TracePersistence do
  # Minimal driver double: a real Trace, with stop_tracing writing JSON.
  fake_driver = Class.new do
    def initialize(trace) = (@trace = trace)
    def tracing?          = !@trace.nil?
    def current_trace     = @trace
    def stop_tracing(path:) = @trace.write_json(path)
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
    driver = Capybara::Simulated::Driver.new(app)
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
    browser = Capybara::Simulated::Driver.new(->(_) { [200, {}, ['']] }).browser
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
