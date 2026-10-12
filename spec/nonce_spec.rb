# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An element's nonce is the engine's (nonce.rs): the `nonce` IDL attribute reads and writes its [[CryptographicNonce]],
# which the content attribute's change steps set, connecting the element keeps as it empties the attribute, and the
# cloning steps copy (HTML §2.6.4: "set copy's [[CryptographicNonce]] to node's" — Firefox reads "xyz" below; Chrome
# reads "", copying nothing).
RSpec.describe 'Element nonce' do
  let(:app) {
    lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']]
    }
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  it 'writes the nonce, not the attribute' do
    expect(session.evaluate_script(<<~JS)).to eq(['b', 'a'])
      (() => {
        const el = document.createElement('div');
        el.setAttribute('nonce', 'a');
        el.nonce = 'b';
        return [el.nonce, el.getAttribute('nonce')];
      })()
    JS
  end

  it 'keeps the nonce of an element connected as its attribute empties' do
    expect(session.evaluate_script(<<~JS)).to eq(['a', 'a', ''])
      (() => {
        const el = document.createElement('div');
        el.setAttribute('nonce', 'a');
        const before = el.getAttribute('nonce');
        document.body.append(el);
        return [before, el.nonce, el.getAttribute('nonce')];
      })()
    JS
  end

  it 'copies the nonce to a clone, shallow or deep' do
    expect(session.evaluate_script(<<~JS)).to eq(%w[xyz xyz])
      (() => {
        const el = document.createElement('span');
        el.nonce = 'xyz';
        const wrapper = document.createElement('p');
        wrapper.append(el);
        return [el.cloneNode().nonce, wrapper.cloneNode(true).firstChild.nonce];
      })()
    JS
  end
end
