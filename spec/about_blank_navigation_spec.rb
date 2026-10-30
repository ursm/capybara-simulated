# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A page's navigation to about:blank makes a document of its initiator's origin (HTML "determine the origin"), its base
# URL the initiator's base URL, its referrer the request's under the initiator's referrer policy — Chrome measured: a
# `no-referrer` page's about:blank none, an `origin` one's its origin, either's base URL its `<base href>` — and a
# `noopener` window's initial about:blank a new opaque origin, which no navigation made (window_open_features_spec).
RSpec.describe 'a navigation to about:blank' do
  let(:session) {
    simulated_session(lambda {|env|
      policy = Rack::Request.new(env).params['policy']
      page   = "<!DOCTYPE html><meta name=referrer content=#{policy}><base href=/sub/><body>page"
      [200, {'content-type' => 'text/html'}, [page]]
    })
  }

  def blank_from(policy)
    session.visit "/?policy=#{policy}"
    session.execute_script("location.href = 'about:blank'")
    session.evaluate_script('1')
    session.evaluate_script('[location.href, origin, document.baseURI, document.referrer]')
  end

  it "is of its initiator's origin and base URL, referred under its policy" do
    expect(blank_from('no-referrer')).to eq(['about:blank', 'http://www.example.com', 'http://www.example.com/sub/', ''])
    expect(blank_from('origin')).to eq(['about:blank', 'http://www.example.com', 'http://www.example.com/sub/', 'http://www.example.com/'])
  end
end
