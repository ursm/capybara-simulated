require 'capybara/simulated'
require 'rusty_racer'
require 'rack'
require_relative 'support/js_engine'
require_relative 'support/session_teardown'

# Zero-copy postMessage transfer to a Worker (rusty_racer >= 0.1.6): a buffer in
# the transfer list crosses the isolate boundary by moving its backing store
# (no byte copy), detaching the source — and the parked store must be released
# (no process-wide leak). V8 only; QuickJS falls back to a copy.
RSpec.describe 'Worker postMessage zero-copy transfer' do
  before { skip 'zero-copy transfer is a rusty_racer (V8) feature' unless CsimEngine.v8? }

  let(:worker_js) {
    <<~JS
      self.onmessage = function (e) {
        if (e.data && e.data.buf) {
          const bytes = new Uint8Array(e.data.buf);   // arrives over the same backing store
          let sum = 0;
          for (let i = 0; i < bytes.length; i++) sum += bytes[i];
          self.postMessage({sum: sum, len: bytes.length});
          return;
        }
        // A typed-array VIEW transferred directly (its whole backing store moves; the
        // far side must rebuild the SAME view window — byteOffset + length).
        const v = e.data;
        let vsum = 0;
        for (let i = 0; i < v.length; i++) vsum += v[i];
        self.postMessage({kind: v.constructor.name, len: v.length, off: v.byteOffset, sum: vsum});
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
            w.onmessage = e => {
              const d = e.data;
              document.title = ('kind' in d)
                ? 'kind=' + d.kind + ' len=' + d.len + ' off=' + d.off + ' sum=' + d.sum
                : 'sum=' + d.sum + ' len=' + d.len;
            };
            window.transferToWorker = function () {
              const buf = new Uint8Array([10, 20, 30, 40]).buffer;   // sum 100
              w.postMessage({buf: buf}, [buf]);                       // TRANSFER
              return buf.byteLength;                                  // 0 if detached
            };
            window.transferViewToWorker = function () {
              // A sub-view (byteOffset 2, length 4) over an 8-byte buffer: bytes [3,4,5,6],
              // sum 18. Posting the VIEW as data with its buffer transferred exercises the
              // view-window capture (byteOffset/length read BEFORE the transfer detaches it).
              const full = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
              const view = new Uint8Array(full.buffer, 2, 4);
              w.postMessage(view, [view.buffer]);
              return full.buffer.byteLength;                          // 0 if detached
            };
          </script></body></html>
        HTML
      end
    end
  }
  let(:session) { simulated_session(app) }
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

  it 'preserves a typed-array view window (byteOffset/length) across the transfer' do
    session.visit('/')
    src_len_after = session.evaluate_script('window.transferViewToWorker()')
    expect(src_len_after).to eq(0)                       # whole backing store detached

    # The worker must see the SAME view window — a Uint8Array of length 4 at
    # offset 2 with the right bytes (sum 18), not a zero-length view (the bug
    # when byteOffset/length were read AFTER transferOut detached the buffer).
    expect(session).to have_title('kind=Uint8Array len=4 off=2 sum=18')

    expect(RustyRacer.pending_transfer_count).to eq(0)
  end
end
