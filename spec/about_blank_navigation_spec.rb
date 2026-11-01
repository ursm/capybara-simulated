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
      req = Rack::Request.new(env)
      next [200, {'content-type' => 'text/html', 'content-security-policy' => 'sandbox allow-scripts'}, ['<!DOCTYPE html>boxed']] if req.path == '/boxed'

      page = "<!DOCTYPE html><meta name=referrer content=#{req.params['policy']}><base href=/sub/><body>page"
      [200, {'content-type' => 'text/html'}, [page]]
    })
  }

  def blank_from(policy)
    session.visit "/?policy=#{policy}"
    session.execute_script("location.href = 'about:blank'")
    session.evaluate_script('1')
    session.evaluate_script('[location.href, origin, document.baseURI, document.referrer]')
  end

  # (…an opaque initiator's — a sandboxed page's — of no tuple origin)
  it 'is of an opaque origin where its initiator is' do
    session.visit '/boxed'
    session.execute_script("location.href = 'about:blank'")
    session.evaluate_script('1')
    expect(session.evaluate_script('[location.href, origin]')).to eq(%w[about:blank null])
  end

  # (…a URL "matches about:blank" by its path compared as it is (URL Standard): `about:BLANK` is another about: URL, which
  # Fetch's "scheme fetch" answers with a network error — an error document at it, of a new opaque origin)
  it 'is not one to about:BLANK, which fails' do
    session.visit '/?policy=origin'
    session.execute_script("location.href = 'about:BLANK'")
    session.evaluate_script('1')
    expect(session.evaluate_script('[location.href, origin]')).to eq(%w[about:BLANK null])
  end

  # (…a window's alike, its location set or `open()` made on one: not left at its initial about:blank)
  it 'is not one of a window to about:BLANK or another about: URL, which fails' do
    session.visit '/?policy=origin'
    %w[about:BLANK about:foo].each do |url|
      session.execute_script("window.w1 = open('about:blank')")
      session.execute_script("w1.location.href = #{url.to_json}")
      window = session.window_opened_by { session.execute_script("window.w2 = open(#{url.to_json})") }
      session.within_window(session.windows[-2]) { expect(session.evaluate_script('[location.href, origin]')).to eq([url, 'null']) }
      session.within_window(window) { expect(session.evaluate_script('[location.href, origin]')).to eq([url, 'null']) }
      session.windows[1..].each(&:close)
      session.switch_to_window(session.windows.first)
    end
  end

  it "is of its initiator's origin and base URL, referred under its policy" do
    expect(blank_from('no-referrer')).to eq(['about:blank', 'http://www.example.com', 'http://www.example.com/sub/', ''])
    expect(blank_from('origin')).to eq(['about:blank', 'http://www.example.com', 'http://www.example.com/sub/', 'http://www.example.com/'])
  end
end
