# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A shadow tree is no part of its host's tree (DOM §4.8): `contains` asks for an inclusive DESCENDANT, which a node in a
# shadow tree is of its shadow root and of nothing above it — whatever the driver's own shadow-including ancestry says.
# Chrome 155: [false, false, false, true, true].
RSpec.describe 'a shadow tree and its host' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><div id=h></div>']] }) }

  before { session.visit '/' }

  it 'is no part of the tree its host is in' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const h = document.getElementById('h'), sr = h.attachShadow({mode: 'open'});
        const i = sr.appendChild(document.createElement('i'));
        return [h.contains(i), document.contains(i), h.contains(sr), sr.contains(i), i.isConnected];
      })()
    JS
    expect(got).to eq([false, false, false, true, true])
  end
end
