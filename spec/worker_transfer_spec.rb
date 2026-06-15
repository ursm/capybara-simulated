require 'capybara/simulated'
require 'rusty_racer'
require 'rack'
require_relative 'support/js_engine'

# Zero-copy postMessage transfer to a Worker (rusty_racer >= 0.1.6): a buffer in
# the transfer list crosses the isolate boundary by moving its backing store
# (no byte copy), detaching the source — and the parked store must be released
# (no process-wide leak). V8 only; QuickJS falls back to a copy.
RSpec.describe 'Worker postMessage zero-copy transfer' do
  before { skip 'zero-copy transfer is a rusty_racer (V8) feature' unless CsimEngine.v8? }

  let(:worker_js) {
    <<~JS
      self.onmessage = function (e) {
        const buf = e.data.buf;                       // arrives over the same backing store
        const bytes = new Uint8Array(buf);
        let sum = 0;
        for (let i = 0; i < bytes.length; i++) sum += bytes[i];
        self.postMessage({sum: sum, len: bytes.length});
      };
    JS
  }

  let(:app) {
    j = worker_js
    lambda do |env|
      case Rack::Request.new(env).path_info
      when '/worker.js'
        [200, {'content-type' => 'application/javascript'}, [j]]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><title>start</title></head><body>
          <script>
            const w = new Worker('/worker.js');
            w.onmessage = e => { document.title = 'sum=' + e.data.sum + ' len=' + e.data.len; };
            window.transferToWorker = function () {
              const buf = new Uint8Array([10, 20, 30, 40]).buffer;   // sum 100
              w.postMessage({buf: buf}, [buf]);                       // TRANSFER
              return buf.byteLength;                                  // 0 if detached
            };
          </script></body></html>
        HTML
      end
    end
  }
  let(:session) { Capybara::Session.new(:simulated, app) }
  before { Capybara.app = app }

  it 'moves the buffer zero-copy, detaches the source, and leaves no parked store' do
    session.visit('/')
    src_len_after = session.evaluate_script('window.transferToWorker()')
    expect(src_len_after).to eq(0)                       # source detached by the transfer

    expect(session).to have_title('sum=100 len=4')       # bytes arrived intact in the worker

    # The token was imported by the worker, so nothing stays parked in the
    # process-wide transfer registry.
    expect(RustyRacer.pending_transfer_count).to eq(0)
  end
end
