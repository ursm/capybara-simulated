# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A response's Location fields as they came — Rack 2's repeated header one String its fields joined by newlines, as
# Set-Cookie's are — of which more than one is no Location to follow: a network error for a fetch (Fetch "extract
# header list values"), no target for a navigation, which shows the redirect's own body.
RSpec.describe 'a response with two Location fields' do
  let(:session) {
    simulated_session(lambda {|env|
      case env['PATH_INFO']
      when '/two'
        locations = "/a\n/b"
        [302, {'content-type' => 'text/html', 'location' => locations}, ['<!DOCTYPE html><body>stayed']]
      when '/a', '/b' then [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><body>went #{env['PATH_INFO']}"]]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>page']]
      end
    })
  }

  it 'fails a fetch() of it' do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[arguments.length - 1];
      fetch('/two').then((r) => done('resolved ' + r.url), (e) => done(e.name));
    JS
    expect(got).to eq('TypeError')
  end

  it 'is no target for a navigation' do
    session.visit '/two'
    expect(session).to have_text('stayed')
  end
end
