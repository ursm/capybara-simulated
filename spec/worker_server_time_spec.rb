# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A worker's script and what its script imports come in as late as their servers take, on the clock the worker follows:
# a timer its window set due meanwhile runs first, and what the worker does next observes the time (Chrome and Firefox,
# csim-bench mod8 `w_cl`, `w_main`, 2026-11-27).
RSpec.describe "a worker's server time" do
  def log_of(page, files)
    session = simulated_session(lambda {|env|
      path = env['PATH_INFO']
      if (slow = path.match(%r{\A/slow/(\d+)(/.*)\z}))
        sleep(slow[1].to_i / 1000.0)
        path = slow[2]
      end
      next [200, {'content-type' => 'text/javascript'}, [files.fetch(path)]] if files.key?(path)

      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset="utf-8"><title>x</title><pre id="out"></pre>
        <script>
          const L = window.L = [];
          window.done = () => { document.getElementById('out').textContent = L.join(' '); document.title = 'done'; };
          setTimeout(() => L.push('t100'), 100);
          setTimeout(() => L.push('t300'), 300);
        </script>#{page}
      HTML
    })
    session.visit '/'
    expect(session).to have_title('done', wait: 10)
    session.find('#out', visible: :all).text(:all)
  end

  # `importScripts` is synchronous: its server's time on the worker's clock as its script waits inside it.
  it "moves a classic worker's clock by what its importScripts' server took" do
    files = {'/zc.js' => 'self.zc = 1;',
             '/w.js' => "const p0 = performance.now(), d0 = Date.now(); importScripts('/slow/200/zc.js'); postMessage((performance.now() - p0 >= 190) + ':' + (Date.now() - d0 >= 190));"}
    expect(log_of(<<~HTML, files)).to eq('t100 true:true t300')
      <script>new Worker('/w.js').onmessage = (e) => { L.push(e.data); setTimeout(done, 300); };</script>
    HTML
  end

  # A nested worker's message its parent relays reaches the page at the time it was posted: the parent taking it as a
  # message the window posts it is taken, its window's step waiting on it (Chrome `306@314`, rvmod `p_wrelT`).
  it "relays a nested worker's message as it was posted" do
    files = {'/child.js' => "setTimeout(() => postMessage('ready'), 300);",
             '/parent.js' => "new Worker('/child.js').onmessage = () => postMessage(String(performance.now() < 380));"}
    expect(log_of(<<~HTML, files)).to eq('t100 t300 true:true')
      <script>
        new Worker('/parent.js').onmessage = (e) => { L.push(e.data + ':' + (performance.now() < 380)); setTimeout(done, 300); };
      </script>
    HTML
  end

  # A worker's script is fetched in parallel, its creator going on meanwhile; the worker runs it that much later — and
  # the messages posted to it meanwhile reach it after, in order.
  it "runs a worker's script as late as its server took" do
    files = {'/w.js' => "const got = []; onmessage = (e) => { got.push(e.data); if (got.length === 2) postMessage('got:' + got.join(',')); }; postMessage('ran');"}
    expect(log_of(<<~HTML, files)).to eq('t100 ran got:a,b t300')
      <script>
        const w = new Worker('/slow/200/w.js');
        w.onmessage = (e) => { L.push(e.data); if (e.data !== 'ran') setTimeout(done, 300); };
        w.postMessage('a'); w.postMessage('b');
      </script>
    HTML
  end
end
