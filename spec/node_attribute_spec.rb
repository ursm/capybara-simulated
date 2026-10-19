# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Capybara's `node[name]`: the IDL attribute where one reflects it as a number, as Selenium's `getProperty` and Cuprite
# answer — its reflection's parse (HTML: a `colspan` of 0 is 1, one past 1000 is 1000; a `maxlength` that is no
# non-negative integer -1) — where its content attribute is there; any other name the content attribute.
RSpec.describe 'node[name]' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><meta charset="utf-8">
        <ol id="ol" start="5"><li id="li" value=" 7x">a</li></ol>
        <table><tr><td id="zero" colspan="0" rowspan="70000">a</td><td id="plain">b</td></tr></table>
        <input id="input" maxlength="-3" size="20" data-n="4">
        <constructor id="ctor" name="x" length="7"></constructor>
      HTML
    end
  }

  it "reads an integer IDL attribute's reflection, and the content attribute otherwise" do
    session = simulated_session(app)
    session.visit '/'
    got = [
      session.find('#ol')[:start], session.find('#li')[:value],
      session.find('#zero')[:colspan], session.find('#zero')['rowSpan'], session.find('#plain')[:colspan],
      session.find('#input')[:maxlength], session.find('#input')[:size], session.find('#input')['data-n'],
      session.find('#ctor')[:name], session.find('#ctor')[:length]
    ]
    expect(got).to eq([5, 7, 1, 65_534, nil, -1, 20, '4', 'x', '7'])
  end
end
