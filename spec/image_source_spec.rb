# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# Which image an <img> fetches (image_source.rs): a <picture>'s selected <source>, a srcset's candidates over src —
# held to what Chrome fetched for the same images.
RSpec.describe 'image source selection' do
  it 'fetches the candidates Chrome does' do
    png = File.binread(Dir.glob('spec/wpt/resource-timing/resources/blue.png').first)
    doc = <<~HTML
      <!DOCTYPE html><html><body>
        <picture><source srcset=", /i.png?b1"><img src="/i.png?a1"></picture>
        <picture><source srcset="/i.png?b2 2x, /i.png?c2 1x"><img src="/i.png?a2"></picture>
        <img src="/i.png?a3" srcset="/i.png?b3 2x">
        <img src="/i.png?a4" srcset="/i.png?b4 100w, /i.png?c4 200w" sizes="50px">
        <picture><source type="" srcset="/i.png?b5"><img src="/i.png?a5"></picture>
      </body></html>
    HTML
    app = ->(env) { env['PATH_INFO'] == '/i.png' ? [200, {'content-type' => 'image/png'}, [png]] : [200, {'content-type' => 'text/html'}, [doc]] }
    s = simulated_session(app)
    s.visit 'http://www.example.com/'
    got = poll_until do
      names = s.evaluate_script("performance.getEntriesByType('resource').map(function (e) { return e.name.split('?').pop(); })")
      names.length >= 5 ? names.sort : nil
    end
    # A source whose srcset's first comma-piece is empty still has a candidate (b1); a density list picks 1x (c2);
    # src joins a density-only srcset as its 1x (a3); a width list's first, for one at 50px (b4); a source with an empty
    # `type` names no format to refuse (b5).
    expect(got).to eq(%w[a3 b1 b4 b5 c2])
  end
end
