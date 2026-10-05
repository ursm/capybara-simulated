# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A live range is the engine's (ranges.rs), updated by every mutation whichever realm's code makes it and whichever
# path writes the edge (tree.js runs the insert and remove steps with each), and compared over node trees. Each
# expectation below is Chrome's.
RSpec.describe 'live range steps' do
  let(:pages) {
    {
      '/' => '<!DOCTYPE html><meta charset=utf-8><body><p id=p>ab</p><div id=d><b>1</b><i>2</i></div><iframe src="/f"></iframe>',
      '/f' => '<!DOCTYPE html><meta charset=utf-8><body><p>one</p><p>two</p>'
    }
  }
  let(:session) {
    pages = self.pages
    simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'], '')]] })
  }

  before do
    session.visit '/'
    session.within_frame(0) { session.find('p', text: 'two') }
  end

  def run(js) = session.evaluate_script("(() => { #{js} })()")

  it "updates a range for a mutation another realm's code makes, and a NodeIterator too" do
    got = run(<<~JS)
      const fd = document.querySelector('iframe').contentDocument;
      const r = document.createRange(); r.setStart(fd.body, 2);
      const it = document.createNodeIterator(fd.body); it.nextNode(); it.nextNode();
      fd.body.removeChild(fd.body.firstChild);   // the frame's removeChild
      return [r.startOffset, it.referenceNode === fd.body];
    JS
    expect(got).to eq([1, true])
  end

  it 'runs the steps for every way children go: textContent, a fragment emptied, normalize, splitText' do
    got = run(<<~JS)
      const p = document.getElementById('p'), d = document.getElementById('d');
      const r1 = document.createRange(); r1.setStart(d.firstChild, 0); r1.setEnd(d, 2);
      d.textContent = 'x';
      const f = document.createDocumentFragment(); f.append(document.createElement('x'), document.createElement('y'));
      const r2 = document.createRange(); r2.setStart(f.lastChild, 0); r2.setEnd(f, 2);
      d.appendChild(f);
      p.appendChild(document.createTextNode('cd'));
      const r3 = document.createRange(); r3.setStart(p.lastChild, 1); r3.setEnd(p, 2);
      p.normalize();
      const merged = [r3.startContainer === p.firstChild, r3.startOffset, r3.endOffset];
      p.appendChild(document.createElement('b'));
      const r4 = document.createRange(); r4.setStart(p, 2);
      p.firstChild.splitText(1);
      return [r1.startContainer === d, r1.startOffset, r1.endOffset, r2.startContainer === f, r2.startOffset, r2.endOffset,
              ...merged, r4.startOffset];
    JS
    expect(got).to eq([true, 0, 0, true, 0, 0, true, 3, 1, 3])
  end

  it "holds an Attr as a boundary of its own, and a shadow root as its tree's root" do
    got = run(<<~JS)
      const a1 = document.createAttribute('a'), a2 = document.createAttribute('b');
      const r = document.createRange(); r.setStart(a1, 0); r.setEnd(a2, 0);
      const h = document.createElement('div'); document.body.appendChild(h);
      const sr = h.attachShadow({mode: 'open'}); sr.innerHTML = '<b>x</b><i>y</i>';
      const s = document.createRange(); s.setStart(sr, 0); s.setEnd(sr.lastChild, 0);
      let before; try { s.setStartBefore(sr); } catch (e) { before = e.name; }
      return [r.startContainer === a2, r.collapsed, s.intersectsNode(sr), before];
    JS
    expect(got).to eq([true, true, true, 'InvalidNodeTypeError'])
  end

  it 'stringifies by the boundary offsets, and the selection by its anchor and focus' do
    got = run(<<~JS)
      const d = document.getElementById('d');
      const r = document.createRange(); r.setStart(d, 1); r.setEnd(d, 2);
      const c = document.createRange(); c.setStart(document.body, 0);
      const t = document.getElementById('p').firstChild, sel = getSelection();
      sel.collapse(t, 2); sel.extend(t, 0);
      return [r.toString(), c.toString(), String(sel), sel.anchorOffset, sel.focusOffset, sel.getRangeAt(0).startOffset];
    JS
    expect(got).to eq(['2', '', 'ab', 2, 0, 0])
  end

  it 'refuses what is no Range where a Range is asked for' do
    got = run(<<~JS)
      const r = document.createRange(), out = [];
      try { r.compareBoundaryPoints(0, {}); } catch (e) { out.push(e.name); }
      try { Object.getOwnPropertyDescriptor(Range.prototype, 'startContainer').get.call({}); } catch (e) { out.push(e.name); }
      try { getSelection().addRange(new StaticRange({startContainer: document.body, startOffset: 0, endContainer: document.body, endOffset: 0})); } catch (e) { out.push(e.name); }
      return out;
    JS
    expect(got).to eq(%w[TypeError TypeError TypeError])
  end
end
