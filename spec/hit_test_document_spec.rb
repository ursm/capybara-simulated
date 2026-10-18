# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# `elementFromPoint`, `elementsFromPoint` and `caretPositionFromPoint` hit-test the document they are asked of: a
# frame's, asked through the parent realm's members, answers the frame's own content; a document with no browsing
# context — `createHTMLDocument`'s — none at all. Every expectation is Chrome's.
RSpec.describe 'hit testing the document asked' do
  it "answers a frame's content through another realm's members, and nothing for a document with no browsing context" do
    html = <<~HTML
      <!DOCTYPE html><meta charset=utf-8><p id=a>hello</p>
      <iframe id=f style="width:300px;height:200px" srcdoc="<!DOCTYPE html><meta charset=utf-8><p id=in>inner</p>"></iframe>
    HTML
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|s| s.visit '/' }
    got = session.evaluate_script(<<~JS)
      (() => {
        const f = document.getElementById('f').contentDocument, d = document.implementation.createHTMLDocument('');
        const name = (e) => e === null ? 'null' : (e.id || e.nodeName);
        const caret = (p) => p === null ? 'null' : p.offsetNode.nodeName + ':' + (p.offsetNode.data ?? '') + ':' + p.offset;
        return [
          name(document.elementFromPoint(10, 10)), name(Document.prototype.elementFromPoint.call(f, 10, 10)),
          name(f.elementFromPoint(10, 10)), name(d.elementFromPoint(10, 10)), d.elementsFromPoint(10, 10).length,
          caret(document.caretPositionFromPoint(12, 20)), caret(Document.prototype.caretPositionFromPoint.call(f, 12, 20)),
          caret(f.caretPositionFromPoint(12, 20)), caret(d.caretPositionFromPoint(12, 20))
        ];
      })()
    JS
    expect(got).to eq(['HTML', 'HTML', 'HTML', 'null', 0, '#text:hello:0', '#text:inner:1', '#text:inner:1', 'null'])
  end
end
