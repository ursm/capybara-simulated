# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A response's Location fields as they came — Rack 2's repeated header one String its fields joined by newlines, as
# Set-Cookie's are — of which more than one is a network error (Fetch "extract header list values" step 2: a header
# whose ABNF allows a single one, given more than once, is failure; "HTTP-redirect fetch": a location URL that is
# failure is a network error), a fetch's and a navigation's alike: the navigation commits an error document at the
# redirect's URL rather than the redirect's own body.
FROZEN_LOCATION_PAIRS = [['Location', ['/a'].freeze], ['Location', '/a'], ['Content-Type', 'text/html']].freeze

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
      when '/frozen'
        # (…an app's constant header list, its Array value frozen: read, never changed)
        [302, FROZEN_LOCATION_PAIRS, ['<!DOCTYPE html><body>stayed']]
      when '/pairscase'
        [302, [%w[Content-Type text/html], %w[Location /a], %w[location /b]], ['<!DOCTYPE html><body>stayed']]
      when '/pairs2'
        [302, [%w[Content-Type text/html], %w[Location /a], %w[Location /b]], ['<!DOCTYPE html><body>stayed']]
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

  # (…two pairs of the name each a field, as a header list has them — not the first followed)
  it 'is two where headers given as pairs name it twice' do
    session.visit '/'
    session.visit '/pairs2'
    expect(session).to have_no_text('went')
    expect(session.current_url).to end_with('/pairs2')
  end

  # (…a name's spellings one name, header names comparing ASCII case-insensitively: `Location` and `location` two fields)
  it 'is two where pairs name it twice in two spellings' do
    session.visit '/'
    session.visit '/pairscase'
    expect(session).to have_no_text('went')
    expect(session.current_url).to end_with('/pairscase')
  end

  it 'reads a frozen header list without changing it' do
    session.visit '/frozen'
    expect(session).to have_text('went /a')
  end


  it 'fails a navigation to it' do
    session.visit '/'
    session.visit '/two'
    expect(session).to have_no_text('stayed')
    expect(session).to have_no_text('went')
    expect(session.current_url).to end_with('/two')
  end
end
