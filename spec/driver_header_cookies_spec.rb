# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A test's sticky request headers (`page.driver.header`) ride every request the session makes, but a request's `Cookie`
# is the cookie jar's for the request's URL alone — a navigation's and a subresource's by the same rule (Fetch: the user
# agent sets `Cookie`, a forbidden request header): a sticky `Cookie` header is replaced by the jar's, none sent where
# the jar has none, and a sticky `Host` changes no URL the jar is asked for.
RSpec.describe 'a sticky request header and the cookie jar' do
  let(:seen) { [] }
  let(:session) {
    simulated_session(lambda {|env|
      seen << [env['PATH_INFO'], env['HTTP_COOKIE']]
      headers = {'content-type' => 'text/html'}
      headers['set-cookie'] = 'jar=1; Path=/' if env['PATH_INFO'] == '/set'
      [200, headers, ['<!DOCTYPE html><meta charset=utf-8><body>ok']]
    })
  }

  def fetch_cookie(path)
    session.evaluate_async_script(<<~JS, path)
      const [path, done] = [arguments[0], arguments[arguments.length - 1]];
      fetch(path).then(() => done(null), (e) => done(String(e)));
    JS
    seen.reverse.find {|p, _| p == path }&.last
  end

  it 'sends no sticky Cookie where the jar has none, the navigation and its subresources alike' do
    session.driver.header('Cookie', 'sticky=1')
    session.visit '/page'
    expect(seen.find {|p, _| p == '/page' }.last).to be_nil
    expect(fetch_cookie('/sub')).to be_nil
  end

  it "sends the jar's cookies in a sticky one's place" do
    session.visit '/set'
    session.driver.header('Cookie', 'sticky=1')
    session.visit '/page'
    expect(seen.find {|p, _| p == '/page' }.last).to eq('jar=1')
    expect(fetch_cookie('/sub')).to eq('jar=1')
  end

  it "asks the jar for the request's URL whatever Host a sticky header sends" do
    session.visit '/set'
    session.driver.header('Host', 'other.example.com')
    session.visit '/page'
    expect(seen.find {|p, _| p == '/page' }.last).to eq('jar=1')
    expect(fetch_cookie('/sub')).to eq('jar=1')
  end
end
