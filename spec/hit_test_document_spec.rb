# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# `elementFromPoint`, `elementsFromPoint` and `caretPositionFromPoint` hit-test the document they are asked of: a
# frame's, asked through the parent realm's members, answers the frame's own content; a document with no browsing
# context — `createHTMLDocument`'s — none at all, and nor does a frame's its navigation or its removal left behind, which
# is no longer fully active. Every expectation is Chrome's.
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
  it "answers nothing in a frame's document once its navigation or its removal leaves it inactive" do
    html = <<~HTML
      <!DOCTYPE html><meta charset=utf-8>
      <iframe id=f style="width:300px;height:200px" srcdoc="<!DOCTYPE html><meta charset=utf-8><body style=margin:0><p id=a style=margin:0>old</p>"></iframe>
      <iframe id=g style="width:300px;height:200px" srcdoc="<!DOCTYPE html><meta charset=utf-8><body style=margin:0><p id=b style=margin:0>gone</p>"></iframe>
    HTML
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|s| s.visit '/' }
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const f = document.getElementById('f'), g = document.getElementById('g');
      const name = (e) => e === null ? 'null' : (e.id || e.nodeName);
      const old = f.contentDocument, gone = g.contentDocument;
      const out = [name(old.elementFromPoint(5, 5)), name(gone.elementFromPoint(5, 5))];
      g.remove();
      out.push(name(gone.elementFromPoint(5, 5)), gone.elementsFromPoint(5, 5).length, String(gone.caretPositionFromPoint(5, 5)));
      f.onload = () => {
        out.push(name(old.elementFromPoint(5, 5)), old.elementsFromPoint(5, 5).length, String(old.caretPositionFromPoint(5, 5)));
        out.push(name(f.contentDocument.elementFromPoint(5, 5)));
        done(out);
      };
      f.srcdoc = '<!DOCTYPE html><meta charset=utf-8><body style=margin:0><p id=c style=margin:0>new</p>';
    JS
    expect(got).to eq(%w[a b null] + [0, 'null', 'null', 0, 'null', 'c'])
  end
end
