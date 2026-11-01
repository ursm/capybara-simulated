# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A Rack 2 app's response headers given as [name, value] pairs — its SPEC asks only for `each` — keep every field of a
# name given more than once, as a header list does, from the response to the document it makes (response_headers.rs
# `header_map`): two Content-Security-Policy headers are two policies, both in force — the first's `sandbox` too — and
# two Set-Cookie headers two cookies.
RSpec.describe 'a response whose headers are pairs' do
  let(:session) {
    simulated_session(lambda {|env|
      case env['PATH_INFO']
      when '/csp'
        pairs = [['Content-Type', 'text/html'], ['Content-Security-Policy', 'sandbox allow-scripts'], ['Content-Security-Policy', 'img-src *']]
        [200, pairs, ['<!DOCTYPE html><body>page']]
      when '/cookies'
        [200, [['Content-Type', 'text/html'], ['Set-Cookie', 'a=1; Path=/'], ['Set-Cookie', 'b=2; Path=/']], ['<!DOCTYPE html><body>set']]
      else [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><body>#{env['HTTP_COOKIE']}"]]
      end
    })
  }

  it 'puts each Content-Security-Policy it names in force' do
    session.visit '/csp'
    expect(session).to have_text('page')
    expect(session.evaluate_script('origin')).to eq('null')
  end

  it 'stores each Set-Cookie it names' do
    session.visit '/cookies'
    session.visit '/echo'
    expect(session).to have_text('a=1; b=2')
  end
end
