# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A frame nested past the depth limit has no realm of its own (v8_runtime.rb `MAX_FRAME_DEPTH`): its window is one over
# its parent realm's global (bridge.entry.js `makeFrameWindow`), and its document is that realm's — same-origin with it,
# so its parent reads `contentDocument`, as before the origin checks became the engine's (where it read as another
# realm's, cross-origin, and answered null) — and it is its response's, decoded as a realm's is: the bytes had been
# written into it as their numbers, `60,33,…`, so no frame past the limit had a frame in it.
RSpec.describe 'a frame past the nesting limit' do
  it "is the parent realm's, same-origin with it" do
    app = ->(env) {
      depth = Rack::Utils.parse_query(env['QUERY_STRING'])['d'].to_i
      body = if depth < 20
        "<!DOCTYPE html><meta charset=utf-8><iframe src='/?d=#{depth + 1}'></iframe>"
      else
        '<!DOCTYPE html><meta charset=utf-8><p>leaf</p>'
      end
      [200, {'content-type' => 'text/html'}, [body]]
    }
    s = simulated_session(app)
    s.visit '/?d=0'
    got = s.evaluate_script(<<~JS)
      (() => {
        // (…each frame's document its own, the next one down — whose frame names the depth after it — past the limit
        // too, to the leaf, which has none)
        const seen = [];
        let doc = document;
        for (let depth = 0; depth < 25; depth++) {
          const frame = doc.querySelector('iframe');
          if (!frame) break;
          const inner = frame.contentDocument;
          if (inner === null) { seen.push('null'); break; }
          const next = inner.querySelector('iframe');
          const own = inner !== doc && frame.contentWindow.document === inner;
          seen.push(!own ? 'shared' : next ? (next.getAttribute('src') === `/?d=${depth + 2}` ? 'built' : 'other') : 'empty');
          doc = inner;
        }
        return seen;
      })()
    JS
    expect(got).to eq(['built'] * 19 + ['empty'])
  end
end
