require 'capybara/simulated'
require 'rusty_racer' if (ENV['CSIM_JS_ENGINE'].to_s.empty? ? Gem.loaded_specs.key?('rusty_racer') : ENV['CSIM_JS_ENGINE'] == 'v8')
require_relative 'support/js_engine'
require_relative 'support/session_teardown'

# Same-origin `window.open()` (and same-origin iframes) live as REALMS in the
# opener's V8 isolate (shared heap), not as separate Browsers/VMs. That makes
# `popup.document` a real same-isolate Document (cross-window adoptNode works)
# and lets BroadcastChannel span every same-origin browsing context in the
# isolate. These behaviours are V8-only (QuickJS has no realm support).
RSpec.describe 'same-isolate window realms' do
  before { skip 'same-isolate realms are a rusty_racer (V8) feature' unless CsimEngine.v8? }

  def session(body)
    app = ->(_env) { [200, {'content-type' => 'text/html'}, [body]] }
    simulated_session(app).tap {|s| s.visit '/' }
  end

  describe 'window.open() popup' do
    let(:s) { session('<!doctype html><title>opener</title><body>') }

    it 'is a real same-isolate window whose document is reachable' do
      result = s.evaluate_script(<<~JS)
        (function () {
          var w = window.open();
          return [typeof w, !!w.document, w.document !== document];
        })()
      JS
      expect(result).to eq(['object', true, true])
    end

    it 'wires window.opener to a working proxy for the opener' do
      result = s.evaluate_script(<<~JS)
        (function () {
          window.__marker = 42;
          var w = window.open();
          // Functional opener: reads forward to the opener's globals + document, and
          // postMessage is callable. (Strict `opener === window` identity is a
          // separate, architecture-wide cross-realm WindowProxy limitation.)
          return [w.opener.__marker, w.opener.document === document, typeof w.opener.postMessage];
        })()
      JS
      expect(result).to eq([42, true, 'function'])
    end

    it 'reports closed=false until close(), then true' do
      result = s.evaluate_script(<<~JS)
        (function () {
          var w = window.open();
          var before = w.closed;
          w.close();
          return [before, w.closed];
        })()
      JS
      expect(result).to eq([false, true])
    end
  end

  describe 'BroadcastChannel across same-isolate realms' do
    # Two sibling iframe realms + the main realm, each subscribed to one channel.
    let(:s) {
      session(<<~HTML)
        <!doctype html><title>bc</title><body>
        <iframe id="a" srcdoc='<script>window.__rx=[];window.__post=function(m){new BroadcastChannel("c").postMessage(m)};new BroadcastChannel("c").onmessage=function(e){window.__rx.push(e.data)}</script>'></iframe>
        <iframe id="b" srcdoc='<script>window.__rx=[];new BroadcastChannel("c").onmessage=function(e){window.__rx.push(e.data)}</script>'></iframe>
        <script>
          window.__rx = [];
          window.__post = function (m) { new BroadcastChannel('c').postMessage(m); };
          new BroadcastChannel('c').onmessage = function (e) { window.__rx.push(e.data); };
        </script>
      HTML
    }

    def rx(handle)
      s.evaluate_script("(function(){var f=document.getElementById(#{handle.inspect});return f?Array.from(f.contentWindow.__rx):'NOFRAME'})()")
    end

    # Each realm has a listener channel distinct from the posting channel, so the
    # posting realm receives once too (in-VM, per spec), and every other realm
    # receives exactly once (cross-realm, via the inbox) — never twice.
    it 'delivers a main-realm post to every realm exactly once' do
      s.evaluate_script("window.__post('fromMain')")
      s.evaluate_script('1')   # a fresh entry ticks the event loop, draining delivery
      expect(s.evaluate_script('Array.from(window.__rx)')).to eq(['fromMain'])
      expect(rx('a')).to eq(['fromMain'])
      expect(rx('b')).to eq(['fromMain'])
    end

    it 'delivers a sibling-realm post to every realm exactly once' do
      s.evaluate_script("document.getElementById('a').contentWindow.__post('fromA')")
      s.evaluate_script('1')
      expect(s.evaluate_script('Array.from(window.__rx)')).to eq(['fromA'])
      expect(rx('a')).to eq(['fromA'])
      expect(rx('b')).to eq(['fromA'])
    end
  end
end
