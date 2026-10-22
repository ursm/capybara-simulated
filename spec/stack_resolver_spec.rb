# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A stack frame is annotated from the source map its script named in a `sourceMappingURL` comment as it ran — a
# parser's, an inserted one's, a module — and nothing else is requested: no `<url>.map` guess, no re-fetch of the script,
# never a frame's URL itself (an inline script's frame carries its DOCUMENT's URL, and a request for that would run the
# app's action again).
RSpec.describe Capybara::Simulated::StackResolver do
  let(:map_json) { '{"version":3,"sources":["src.js"],"names":[],"mappings":"AAAA"}' }

  before { described_class.clear }

  it 'reads the URL out of the last comment' do
    expect(described_class.mapping_url("x()\n//# sourceMappingURL=app.js.map\n")).to eq('app.js.map')
    expect(described_class.mapping_url("//@ sourceMappingURL=old.map")).to eq('old.map')
    expect(described_class.mapping_url("//# sourceMappingURL=a.map\nx()")).to be_nil
    expect(described_class.mapping_url('x()')).to be_nil
  end

  it 'notes each script’s map as it runs and fetches only that' do
    requests = []
    app = lambda {|env|
      requests << env['PATH_INFO']
      js = ->(name) { [200, {'content-type' => 'text/javascript'}, ["window.ran = (window.ran || 0) + 1;\n//# sourceMappingURL=#{name}.map\n"]] }
      case env['PATH_INFO']
      when '/app.js', '/dyn.js', '/mod.js' then js.(env['PATH_INFO'][1..])
      when '/app.js.map' then [200, {'content-type' => 'application/json'}, [map_json]]
      else [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset="utf-8"><script src="/app.js"></script><script type="module" src="/mod.js"></script>
        <script>document.head.appendChild(Object.assign(document.createElement('script'), { src: '/dyn.js' }));</script>
      HTML
      end
    }
    s = simulated_session(app)
    s.visit '/page'
    s.has_css?('body')
    browser = s.driver.browser
    expect(%w[app dyn mod].map {|n| browser.source_map_of("http://www.example.com/#{n}.js") }).to eq(%w[app.js.map dyn.js.map mod.js.map])
    requests.clear
    out = described_class.new(browser).annotate("Error\n    at f (http://www.example.com/app.js:1:1)\n    at g (http://www.example.com/page#frag:3:7)")
    expect(out).to include('(http://www.example.com/app.js:1:1) → src.js:1:1')
    expect(out).to include('(http://www.example.com/page#frag:3:7)')
    expect(requests).to eq(['/app.js.map'])
  end
end
