# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An element a frame's document hands to its parent's lives in the PARENT's arena from then on, and the parent's layout
# is what gives it a box — but every method it is called through is still the frame realm's code. Its geometry is asked
# of the realm that lays it out, which lays its document out first (native-query-shadow.js `laidOutArenaOf`).
#
# Chrome 153-measured on this machine (`--window-size=1024,855`).
RSpec.describe 'geometry across realms' do
  PAGES = {
    '/' => <<~HTML,
      <!DOCTYPE html><html><head><meta charset="utf-8"></head>
      <body style="margin:0;font:16px Arial"><div id="host" style="padding-top:10px"></div>
      <iframe id="fr" src="/frame" style="width:300px;height:100px"></iframe></body></html>
    HTML
    '/frame' => <<~HTML
      <!DOCTYPE html><html><head><meta charset="utf-8"></head>
      <body style="margin:8px"><div id="fd" style="height:20px">frame div</div></body></html>
    HTML
  }.freeze

  it "measures an element adopted from a frame where the parent's layout put it" do
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [PAGES.fetch(env['PATH_INFO'])]] })
    s.visit '/'
    result = s.evaluate_script(<<~JS)
      (() => {
        const d = document.getElementById('fr').contentDocument.getElementById('fd');
        document.getElementById('host').appendChild(d);
        const b = d.getBoundingClientRect();
        const hit = document.elementFromPoint(b.x + 2, b.y + 2);
        return [[b.x, b.y, b.width, b.height], hit && hit.id, d.offsetHeight];
      })()
    JS
    expect(result).to eq([[0, 10, 1024, 20], 'fd', 20])
  end
end
