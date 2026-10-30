# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/every_host_local'

# Each style sheet request's response is its own (browser.rb `external_asset_response`, sheet_fetch.rs `fetch`):
# two `<link>`s of one URL of another origin that allows it — one `crossorigin`, one not — are a CORS response and an
# opaque one, the CORS link's sheet origin-clean (its rules readable) and the other's not (CSSOM: a SecurityError),
# whichever was inserted first.
# (…the other origin served in-process)
RSpec.describe 'a style sheet response, per request', :every_host_local do
  def outcome(order)
    links = order.map {|cors| %(<link rel=stylesheet id=#{cors ? 'cors' : 'plain'} href="http://other.test/s.css"#{' crossorigin' if cors}>) }.join
    s = simulated_session(lambda {|env|
      case env['PATH_INFO']
      when '/s.css' then [200, {'content-type' => 'text/css', 'access-control-allow-origin' => '*'}, ['p { color: red }']]
      else [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8>#{links}<p>x</p>"]]
      end
    })
    s.visit '/'
    s.evaluate_script(<<~JS)
      ['cors', 'plain'].map((id) => { try { return document.getElementById(id).sheet.cssRules.length; } catch (e) { return e.name; } })
    JS
  end

  it 'judges each link by the response it got, either way round' do
    expect(outcome([true, false])).to eq([1, 'SecurityError'])
    expect(outcome([false, true])).to eq([1, 'SecurityError'])
  end
end
