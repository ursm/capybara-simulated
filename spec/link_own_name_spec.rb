# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A link whose target is its own navigable's name chooses that navigable (HTML "the rules for choosing a navigable"):
# to a fragment of its document it moves within it (HTML "navigate to a fragment") — its document kept, `hashchange`
# fired — and a `javascript:` one runs in it (navigables.rs `targetsOwnNavigable`).
RSpec.describe "a link targeting its own window's name" do
  let(:hits) { [] }
  let(:session) do
    seen = hits
    simulated_session(lambda {|env|
      seen << env['PATH_INFO']
      body = '<a id=frag href="#x" target=me>frag</a> <a id=js href="javascript:void(document.title=\'ran\')" target=me>js</a>' \
             '<p id=x>x</p><script>window.name = "me"; window.marker = 1; ' \
             'addEventListener("hashchange", () => { document.title = "hashed"; })</script>'
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><title>start</title><body>#{body}"]]
    })
  end

  it 'moves to a fragment within its document' do
    session.visit '/'
    session.click_link 'frag'
    expect([session.evaluate_script('window.marker'), session.evaluate_script('location.hash'), session.title, hits]).to eq([1, '#x', 'hashed', ['/']])
  end

  it 'runs a javascript: URL in it' do
    session.visit '/'
    session.click_link 'js'
    expect([session.title, session.windows.size]).to eq(['ran', 1])
  end
end
