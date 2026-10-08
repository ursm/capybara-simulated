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
      if env['PATH_INFO'] == '/sub/doc.xml'
        [200, {'content-type' => 'text/xml'}, ['<a><b/></a>']]
      elsif env['REQUEST_METHOD'] == 'POST'
        [200, {'content-type' => 'text/plain'}, [env['rack.input'].read]]
      elsif env['PATH_INFO'] == '/frame'
        [200, {'content-type' => 'text/html'}, ['<!doctype html><body>frame</body>']]
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
          error(() => new DOMParser().parseFromString('x', 'TEXT/HTML')),
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
      "TypeError: Failed to execute 'parseFromString' on 'DOMParser': The provided value 'TEXT/HTML' is not a valid enum value of type DOMParserSupportedType.",
      "TypeError: Failed to execute 'serializeToString' on 'XMLSerializer': parameter 1 is not of type 'Node'.",
      'TypeError: Illegal invocation',
      '<a><b/></a>',
      [0, 0, 2]
    ])
  end

  # XHR "set a document response": its URL the response's, its content type the final MIME type — and parsed, as a
  # document body serialized, by the driver's own parser and serializer, whatever a page does to the globals.
  it "makes an XMLHttpRequest's document response and document body its own way" do
    session.execute_script(<<~JS)
      window.DOMParser = window.XMLSerializer = function () { throw new Error('page'); };
      const x = new XMLHttpRequest();
      x.open('GET', '/sub/doc.xml');
      x.onload = () => {
        const doc = x.responseXML;
        const post = new XMLHttpRequest();
        post.open('POST', '/echo');
        post.onload = () => { window.got = [doc.documentElement.localName, doc.URL, doc.documentURI, doc.contentType, post.responseText]; };
        post.send(doc);
      };
      x.send();
    JS
    poll_until { session.evaluate_script('window.got') }
    expect(session.evaluate_script('window.got')).to eq(
      ['a', 'http://www.example.com/sub/doc.xml', 'http://www.example.com/sub/doc.xml', 'text/xml', '<a><b/></a>']
    )
  end

  # Web IDL's realm is `this`'s: another realm's method on this realm's parser makes this realm's document (Chrome).
  it "makes a parsed document in its parser's realm" do
    session.execute_script("const f = document.createElement('iframe'); f.src = '/frame'; document.body.append(f);")
    poll_until { session.evaluate_script("frames[0] && frames[0].document.body && frames[0].document.body.textContent === 'frame'") }
    got = session.evaluate_script(<<~JS)
      (() => {
        const F = frames[0];
        const doc = F.DOMParser.prototype.parseFromString.call(new DOMParser(), '<p>x</p>', 'text/html');
        return [Object.getPrototypeOf(doc) === F.Document.prototype, doc.body.firstChild instanceof Element, doc.URL];
      })()
    JS
    expect(got).to eq([false, true, 'http://www.example.com/'])
  end
end
