# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A navigation response of `text/plain`, `text/css`, `text/vtt`, a JavaScript or a JSON MIME type loads as a text
# document — its text, verbatim, in one `<pre>` (HTML "loading a document", mime.rs `document_kind`) — as Chrome 154
# loads each: a JSON or a style sheet response had been HTML-parsed, its markup elements.
RSpec.describe 'a text document' do
  # (…each path's Content-Type, its essence the document's, and its text)
  let(:responses) {
    {
      '/data.json' => ['application/json', '{"a":"<b>x</b>"}'],
      '/site.css'  => ['text/css; charset=utf-8', 'p { color: red } /* <i> */'],
      '/app.js'    => ['text/javascript', 'var x = "<b>&amp;";']
    }
  }
  let(:session) {
    simulated_session(lambda {|env|
      type, body = responses.fetch(env['PATH_INFO'], ['text/html', '<!DOCTYPE html><meta charset=utf-8><body>'])
      [200, {'content-type' => type}, [body]]
    })
  }

  it 'is its response text in a pre, whatever markup it holds' do
    responses.each do |path, (type, text)|
      session.visit path
      got = session.evaluate_script('[document.contentType, document.body.children.length, document.body.firstElementChild.localName, document.body.textContent]')
      expect(got).to eq([type.split(';').first, 1, 'pre', text]), path
    end
  end
end
