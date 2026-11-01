# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A response's Location fields as they came — Rack 2's repeated header one String its fields joined by newlines, as
# Set-Cookie's are — of which more than one is a network error (Fetch "extract header list values" step 2: a header
# whose ABNF allows a single one, given more than once, is failure; "HTTP-redirect fetch": a location URL that is
# failure is a network error), a fetch's and a navigation's alike: the navigation commits an error document at the
# redirect's URL rather than the redirect's own body.
RSpec.describe 'a response with two Location fields' do
  let(:session) {
    simulated_session(lambda {|env|
      case env['PATH_INFO']
      when '/two'
        locations = "/a\n/b"
        [302, {'content-type' => 'text/html', 'location' => locations}, ['<!DOCTYPE html><body>stayed']]
      when '/nl'
        location = "/a\n"
        [302, {'content-type' => 'text/html', 'location' => location}, ['<!DOCTYPE html><body>stayed']]
      when '/pairs'
        [302, [%w[Content-Type text/html], %w[Location /b]], ['<!DOCTYPE html><body>stayed']]
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

  # (…a Rack 2 String's newline-joined fields read as Ruby splits them, the empty one it ends in none of them)
  it 'is one field where the String ends in a newline' do
    session.visit '/nl'
    expect(session).to have_text('went /a')
  end

  # (…a Rack 2 app's headers an Array of pairs, as its SPEC allows: anything whose `each` gives them)
  it 'is read off headers given as pairs' do
    session.visit '/pairs'
    expect(session).to have_text('went /b')
  end

  it 'fails a navigation to it' do
    session.visit '/'
    session.visit '/two'
    expect(session).to have_no_text('stayed')
    expect(session).to have_no_text('went')
    expect(session.current_url).to end_with('/two')
  end
end
