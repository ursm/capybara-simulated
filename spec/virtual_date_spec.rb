# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A page of a host whose clock is moved (a test's `travel_to`) reads that clock through `Date` — a Date as ECMA-262 has
# it all the same: called as a function, the string of now; constructed with no argument, now; its `name`, `length` and
# `prototype.constructor` the constructor's own.
RSpec.describe 'the virtual clock’s Date' do
  it 'is a Date as ECMA-262 has it' do
    later = Time.now + 86_400 * 400
    allow(Time).to receive(:now).and_return(later)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8">']] })
    s.visit '/'
    got = s.evaluate_script('[typeof Date(), Date.name, Date.length, Date.prototype.constructor === Date, new Date() instanceof Date, new Date().getFullYear()]')
    expect(got).to eq(['string', 'Date', 7, true, true, later.year])
  end
end
