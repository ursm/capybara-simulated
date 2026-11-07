# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A frame nested past the depth limit has no window and no document (navigables.rs `MAX_FRAME_DEPTH`), and no `load`, as
# Firefox's (depth 9 there; Chrome 157 had none at 40, measured 2026-11-07) — nothing fetched for it, however often it is
# read — and its document's own load is none the later.
RSpec.describe 'a frame past the nesting limit' do
  # …a form into one holding nothing up either (Firefox at its limit, measured 2026-11-07).
  it "takes a form into it without holding its document's load" do
    limit = Capybara::Simulated::Native::MAX_FRAME_DEPTH
    app = ->(env) {
      depth = Rack::Utils.parse_query(env['QUERY_STRING'])['d'].to_i
      submit = depth == limit ? '<form id=x action=/x target=n></form><script>x.submit()</script>' : ''
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><iframe name=n src='/?d=#{depth + 1}'></iframe>#{submit}"]]
    }
    s = simulated_session(app)
    s.visit '/?d=0'
    expect(s.evaluate_script('document.readyState')).to eq('complete')
  end

  it 'has no window, no document and no load, and costs no request' do
    hits = Hash.new(0)
    app = ->(env) {
      depth = Rack::Utils.parse_query(env['QUERY_STRING'])['d'].to_i
      hits[depth] += 1
      body = "<!DOCTYPE html><meta charset=utf-8><iframe src='/?d=#{depth + 1}' onload='top.loads.push(#{depth + 1})'></iframe>"
      [200, {'content-type' => 'text/html'}, ["#{'<script>window.loads = []</script>' if depth.zero?}#{body}"]]
    }
    s = simulated_session(app)
    s.visit '/?d=0'
    limit = Capybara::Simulated::Native::MAX_FRAME_DEPTH
    got = s.evaluate_script(<<~JS)
      (() => {
        const seen = [];
        let doc = document, last = null;
        for (let depth = 0; depth < 25; depth++) {
          last = doc.querySelector('iframe');
          const inner = last.contentDocument;
          if (inner === null) break;
          seen.push(inner !== doc && last.contentWindow.document === inner);
          doc = inner;
        }
        return [seen, last.contentDocument, last.contentWindow, last.contentWindow];
      })()
    JS
    expect(got).to eq([[true] * limit, nil, nil, nil])
    expect(hits.keys.max).to eq(limit)
    expect(s.evaluate_script('[loads.length, Math.max(...loads), document.readyState]')).to eq([limit, limit, 'complete'])
  end
end
