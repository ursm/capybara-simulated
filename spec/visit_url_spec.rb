# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The URL a `visit` names is parsed as the page parses a URL (the URL Standard's parser, url_ops.rs): each position
# percent-encodes what its own set says. An RFC 3986 escape had encoded a `|` in a query, which the URL Standard
# keeps — `?include=(Document|Window)` reached the page as `(Document%7CWindow)`, and WPT's subset-by-key variants
# selected nothing. Each expectation is what Chrome (154.0.8037.92) navigates to for the same input.
RSpec.describe 'visit' do
  let(:seen) { [] }
  let(:session) {
    simulated_session(lambda {|env|
      seen << "#{env['PATH_INFO']}?#{env['QUERY_STRING']}"
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']]
    })
  }

  it 'requests the URL the URL Standard parses its argument to' do
    session.visit '/a b/x?include=(Document|Window)&q={1}^`#f g'
    expect(session.evaluate_script('[location.pathname, location.search, location.hash]')).to eq(['/a%20b/x', '?include=(Document|Window)&q={1}^`', '#f%20g'])
  end

  it 'hands the app the query as parsed' do
    session.visit '/x?include=(Document|Window)'
    expect(seen.last).to eq('/x?include=(Document|Window)')
  end

  # (…and what the URL Standard keeps, Ruby's URI refuses: the request is built from a URI-legal copy, and the app
  # handed the target as the URL has it — a `visit` of these had raised URI::InvalidURIError)
  it "requests a URL Ruby's URI would refuse, and the app sees its target as it is" do
    session.visit '/x.html#a^b{c}|d'
    session.visit '/dom/a|b?q={1}`'
    expect(seen).to eq(['/x.html?', '/dom/a|b?q={1}`'])
    expect([session.current_url, session.current_path]).to eq(['http://www.example.com/dom/a|b?q={1}`', '/dom/a|b'])
  end

  it "resolves a page's navigation the same way" do
    session.visit '/start'
    session.execute_script("location.href = '/dom/c|d.html'")
    session.execute_script("location.href = 'rel x.html'")
    expect(seen.last(2)).to eq(['/dom/c|d.html?', '/dom/rel%20x.html?'])
    expect(session.current_url).to eq('http://www.example.com/dom/rel%20x.html')
  end

  it 'encodes what is not ASCII as UTF-8, and resolves dot segments' do
    session.visit '/x/../ü?é'
    expect(session.evaluate_script('location.pathname + location.search')).to eq('/%C3%BC?%C3%A9')
  end
end
