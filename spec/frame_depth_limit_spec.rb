# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A frame nested past the depth limit has no realm of its own (v8_runtime.rb `MAX_FRAME_DEPTH`): its window is one over
# its parent realm's global (bridge.entry.js `makeFrameWindow`), and its document is that realm's — same-origin with it,
# so its parent reads `contentDocument`, as before the origin checks became the engine's (where it read as another
# realm's, cross-origin, and answered null).
RSpec.describe 'a frame past the nesting limit' do
  it "is the parent realm's, same-origin with it" do
    app = ->(env) {
      depth = Rack::Utils.parse_query(env['QUERY_STRING'])['d'].to_i
      body = if depth < 20
        "<!DOCTYPE html><meta charset=utf-8><iframe src='/?d=#{depth + 1}'></iframe>" \
          "<script>window.__depth = #{depth}</script>"
      else
        '<!DOCTYPE html><meta charset=utf-8><p>leaf</p>'
      end
      [200, {'content-type' => 'text/html'}, [body]]
    }
    s = simulated_session(app)
    s.visit '/?d=0'
    got = s.evaluate_script(<<~JS)
      (() => {
        const seen = [];
        let w = window;
        for (let i = 0; i < 25; i++) {
          const frame = w.document && w.document.querySelector('iframe');
          if (!frame) break;
          const doc = frame.contentDocument;
          seen.push(doc !== null);
          if (!doc) break;
          w = frame.contentWindow;
        }
        return seen;
      })()
    JS
    expect(got.length).to be > 16
    expect(got).to all(be(true))
  end
end
