# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Shapes the Rust walk used to decline, sending the pass to the JS walk (and from there, often, to the oracle): it lays
# each out itself now — and as the JS walk does, box for box, since that is what the pages and the gate were held to.
RSpec.describe 'Rust walk coverage' do
  def page(body)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{body}"]] })
    s.visit '/'
    s
  end

  BOXES_JS = <<~'JS'
    (() => [...document.querySelectorAll('*')].map((e) => {
      const r = e.getBoundingClientRect();
      return [e.localName, r.x, r.y, r.width, r.height].map((v) => typeof v === 'number' ? Math.round(v * 100) / 100 : v);
    }))()
  JS

  # Every element's box from the Rust walk, then from the JS walk on a page laid out again.
  def both_walks(body, script = nil)
    rust = page(body)
    rust.execute_script(script) if script
    boxes = rust.evaluate_script(BOXES_JS)
    expect(rust.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
    js = page(body)
    js.execute_script('globalThis.__csimRustWalk = false')
    js.execute_script(script) if script
    js.execute_script("document.body.setAttribute('data-relayout', '')")
    [boxes, js.evaluate_script(BOXES_JS)]
  end

  # An element of no namespace the walk knows is the box its style makes it (an `inline` one here — Chrome: 28.81 x 22
  # for "abc" in 16px monospace), where the walk refused every element outside HTML and the svg root.
  it 'lays a foreign element out as the box its style makes it' do
    script = <<~'JS'
      const u = document.createElementNS('urn:x', 'u');
      u.textContent = 'abc';
      document.getElementById('b').appendChild(u);
    JS
    rust, js = both_walks('<div id="b" style="font: 16px monospace"></div>', script)
    expect(rust).to eq(js)
    u = rust.find {|b| b[0] == 'u' }
    expect(u[3]).to be_within(0.02).of(28.81)
    expect(u[4]).to eq(22)
  end

  # The pass root in a vertical writing mode fills its room, as the JS model's root does (neither lays vertical text
  # out: a shared approximation, not this walk's own).
  it 'lays out a vertical root' do
    rust, js = both_walks('<html style="writing-mode: vertical-rl"><body style="margin: 0"><p>hello</p></body></html>')
    expect(rust).to eq(js)
  end

  # An orphan `display: table-row` — of block children, and of bare text — as the JS model lays it out: an equal-share
  # flex row, its text dropped and floored at a line.
  it 'lays out an orphan table row' do
    rust, js = both_walks(
      '<div style="width: 300px; font: 16px monospace"><div style="display: table-row"><div>aa</div><div>bbbb</div></div>' \
      '<div style="display: table-row">text</div><thead style="display: block"><tr><td>cell</td></tr></thead></div>'
    )
    expect(rust).to eq(js)
  end
end
