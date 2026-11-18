# frozen_string_literal: true

require 'capybara/simulated'
require 'json'
require_relative 'support/session_teardown'

# No list of the bindings' (nor of the vendored streams') is read past its end, or grown, through Array.prototype: a
# page that defines a getter and a setter at its indices 0-39 sees none of their elements, and hands them nothing in
# place of an absent one, across about a hundred APIs (forms, token lists, collections, geometry, CSSOM, fetch and
# streams, structured clone, URL, ranges, canvas, observers, custom elements, shadow trees, events, history, messaging,
# timers, crypto, caches, IndexedDB, fonts, storage, console).
RSpec.describe 'Array.prototype index accessors' do
  let(:page) { File.read(File.expand_path('fixtures/array_prototype/sweep.html', __dir__)) }
  let(:app) { ->(env) { [200, {'content-type' => 'text/html'}, [env['PATH_INFO'] == '/' ? page : 'data']] } }

  it 'meet no read or write of the bindings across the swept APIs' do
    session = simulated_session(app)
    session.visit '/'
    hits = nil
    20.times do
      text = session.evaluate_script('document.getElementById("out").textContent')
      hits = JSON.parse(text) unless text.to_s.empty?
      break if hits
      sleep 0.05
    end
    expect(hits).to eq([])
  end
end
