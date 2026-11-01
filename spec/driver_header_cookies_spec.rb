# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/every_host_local'

# A test's sticky request headers (`page.driver.header`) ride every request the session makes, but a request's `Cookie`
# is the cookie jar's for the request's URL alone — a navigation's and a subresource's by the same rule (Fetch: the user
# agent sets `Cookie`, a forbidden request header): a sticky `Cookie` header is replaced by the jar's, none sent where
# the jar has none, and a sticky `Host` changes no URL the jar is asked for. (…rack-test differs: its
# `env['HTTP_COOKIE'] ||= jar` lets a test's own Cookie header win — a test reaching for that sets the cookie through a
# response instead, as a browser's would be.) Nor does a sticky header forge the request's Fetch metadata: Sec-Fetch-*
# are the user agent's to set (forbidden request headers), so the engine's values win.
RSpec.describe 'a sticky request header and the cookie jar', :every_host_local do
  let(:seen) { [] }
  let(:metadata) { [] }
  let(:session) {
    simulated_session(lambda {|env|
      seen << [env['PATH_INFO'], env['HTTP_COOKIE']]
      metadata << [env['PATH_INFO'], env['HTTP_SEC_FETCH_SITE'], env['HTTP_SEC_FETCH_MODE']]
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

  it "sends the engine's Fetch metadata whatever Sec-Fetch-* a sticky header sends" do
    session.driver.header('Sec-Fetch-Site', 'forged')
    session.driver.header('Sec-Fetch-Mode', 'forged')
    session.visit 'https://www.example.com/page'
    expect(metadata.find {|p, *| p == '/page' }.drop(1)).to eq(%w[none navigate])
    fetch_cookie('/sub')
    expect(metadata.find {|p, *| p == '/sub' }.drop(1)).to eq(%w[same-origin cors])
  end
end
