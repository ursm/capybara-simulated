# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# DOMParser and XMLSerializer, generated from their IDL: their arguments required and converted, their brand checked —
# and XMLHttpRequest's document response parsed by the driver's own parser, whatever a page does to DOMParser. The
# figures are headless Chrome's, but for the enum's name: the IDL's DOMParserSupportedType, where Chrome's message keeps
# its old name, SupportedType.
RSpec.describe 'DOMParser bindings' do
  let(:app) {
    lambda do |env|
      if env['PATH_INFO'] == '/doc.xml'
        [200, {'content-type' => 'application/xml'}, ['<a><b/></a>']]
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8">']]
      end
    end
  }
  let(:session) {
    s = simulated_session(app)
    s.visit('/')
    s
  }

  it 'is what its IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        return [
          error(() => new DOMParser().parseFromString('x')),
          error(() => new DOMParser().parseFromString('x', 'text/plain')),
          error(() => new XMLSerializer().serializeToString({})),
          error(() => DOMParser.prototype.parseFromString.call({}, 'x', 'text/html')),
          new XMLSerializer().serializeToString(new DOMParser().parseFromString('<a><b/></a>', 'application/xml')),
          [DOMParser.length, XMLSerializer.length, DOMParser.prototype.parseFromString.length]
        ];
      })()
    JS
    expect(got).to eq([
      "TypeError: Failed to execute 'parseFromString' on 'DOMParser': 2 arguments required, but only 1 present.",
      "TypeError: Failed to execute 'parseFromString' on 'DOMParser': The provided value 'text/plain' is not a valid enum value of type DOMParserSupportedType.",
      "TypeError: Failed to execute 'serializeToString' on 'XMLSerializer': parameter 1 is not of type 'Node'.",
      'TypeError: Illegal invocation',
      '<a><b/></a>',
      [0, 0, 2]
    ])
  end

  it "parses an XMLHttpRequest's document response with its own parser" do
    session.execute_script(<<~JS)
      window.DOMParser = function () { throw new Error('page'); };
      const x = new XMLHttpRequest();
      x.open('GET', '/doc.xml');
      x.onload = () => { window.got = x.responseXML && x.responseXML.documentElement.localName; };
      x.send();
    JS
    poll_until { session.evaluate_script('window.got') }
    expect(session.evaluate_script('window.got')).to eq('a')
  end
end
