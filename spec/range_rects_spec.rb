# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# A range's client rects (CSSOM View §6.1, text_geometry.rs `text_rects`, ranges.rs `range_rects`): a text node's part
# per line fragment, its font's content box tall, with the white space its line renders — one space of a collapsible
# run between two things on the line, every one of a preserved run, none at a line's start or end — and a place inside
# preserved white space a caret's rect of its own; the box of each element it selects whose parent it does not; all of
# it where the box's transforms put it. Every figure is Chrome's, to within half a pixel (its advances are in 1/64 px).
RSpec.describe 'range rects' do
  let(:html) {
    <<~HTML
      <!DOCTYPE html><body style="margin:0;font:16px monospace">
      <div id=ws>
      <div id=a style="width:60px">aaaa bbbb</div><div id=b>a    b</div><div id=c>x<span> lead</span></div><div id=d>end <span>s</span></div><div id=e>tail </div><div id=g>a <b>bold</b></div>
      </div>
      <p id=pre style="white-space:pre;margin:0">a    b</p>
      <div id=t style="transform:translate(50px,20px) scale(2);transform-origin:0 0;width:300px">hello world</div>
      <p id=p1 style="margin:0">abc</p><p id=p2 style="margin:0"><b>x</b>y</p>
    HTML
  }

  def near(got, want)
    got.size == want.size && got.zip(want).all? {|g, w| g.zip(w).all? {|a, b| (a - b).abs <= 0.5 } }
  end

  it 'reports a text node per line fragment, with the white space its line renders, under its transforms' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|session| session.visit '/' }
    got = s.evaluate_script(<<~JS)
      (() => {
        const f = (r) => [r.x, r.y, r.width, r.height];
        const out = {};
        for (const id of 'abcdeg') {
          const w = document.createTreeWalker(document.getElementById(id), NodeFilter.SHOW_TEXT), list = [];
          for (let n = w.nextNode(); n; n = w.nextNode()) {
            const range = document.createRange();
            range.selectNodeContents(n);
            list.push([...range.getClientRects()].map(f));
          }
          out[id] = list;
        }
        const pre = document.getElementById('pre').firstChild;
        let r = document.createRange();
        r.setStart(pre, 2);
        out.preCaret = [...r.getClientRects()].map(f);
        r = document.createRange();
        r.setStart(pre, 1);
        r.setEnd(pre, 4);
        out.preRange = [...r.getClientRects()].map(f);
        r = document.createRange();
        r.selectNodeContents(document.getElementById('t').firstChild);
        out.transform = [...r.getClientRects()].map(f);
        const tb = document.getElementById('t').getBoundingClientRect();
        out.transformCaret = document.caretPositionFromPoint(tb.x + 2 * 9.6 * 3 + 2, tb.y + 10).offset;
        r = document.createRange();
        r.setStart(document.getElementById('p1').firstChild, 1);
        r.setEnd(document.getElementById('p2'), 1);
        out.endChildren = [...r.getClientRects()].map(f);
        return out;
      })()
    JS
    chrome = {
      'a' => [[[0, 0, 38.41, 22], [0, 22, 38.41, 22]]],
      'b' => [[[0, 44, 28.81, 22]]],
      'c' => [[[0, 66, 9.61, 22]], [[9.61, 66, 48.02, 22]]],
      'd' => [[[0, 88, 38.41, 22]], [[38.41, 88, 9.61, 22]]],
      'e' => [[[0, 110, 38.41, 22]]],
      'g' => [[[0, 132, 19.2, 22]], [[19.2, 132, 38.41, 22]]],
      'preCaret' => [[19.19, 154, 0, 22]],
      'preRange' => [[9.59, 154, 28.81, 22]],
      'transform' => [[50, 196, 211.22, 44]],
      'endChildren' => [[9.59, 198, 19.22, 22], [0, 220, 9.61, 22], [0, 220, 9.61, 22]]
    }
    chrome.each do |key, want|
      ok = key.size == 1 ? got[key].size == want.size && got[key].zip(want).all? {|g, w| near(g, w) } : near(got[key], want)
      expect(ok).to be(true), "#{key}: got #{got[key].inspect}, Chrome #{want.inspect}"
    end
    expect(got['transformCaret']).to eq(3)
  end
end
