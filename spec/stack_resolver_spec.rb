# frozen_string_literal: true

require 'capybara/simulated'

# A stack frame is annotated from the source map of a script the page loaded through the asset cache — its body read
# from there — and no other URL is ever requested: an inline script's frame carries its document's URL, and a request for
# that would run the app's action again.
RSpec.describe Capybara::Simulated::StackResolver do
  let(:browser) {
    Class.new {
      attr_reader :requested

      def initialize = @requested = []

      def external_asset_meta(url) = url == 'http://a.test/app.js' ? {'headers' => {'content-type' => 'text/javascript'}} : nil
      def external_asset_source(_url) = "x()\n//# sourceMappingURL=data:application/json,%7B%22version%22%3A3%2C%22sources%22%3A%5B%22src.js%22%5D%2C%22names%22%3A%5B%5D%2C%22mappings%22%3A%22AAAA%22%7D"

      def rack_fetch_body(url)
        @requested << url
        nil
      end
    }.new
  }

  before { described_class.clear }

  it 'reads a loaded script’s map and requests nothing for a document’s frame' do
    out = described_class.new(browser).annotate("Error\n    at f (http://a.test/app.js:1:1)\n    at g (http://a.test/page#frag:3:7)")
    expect(out).to include('(http://a.test/app.js:1:1) → src.js:1:1')
    expect(out).to include('(http://a.test/page#frag:3:7)')
    expect(browser.requested).to eq(['http://a.test/app.js.map'])
  end
end
