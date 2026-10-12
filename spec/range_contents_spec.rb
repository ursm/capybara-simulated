# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What a range contains — its common ancestor, the partially contained children of that, the contained ones between —
# is the engine's (ranges.rs `rangeContents`); cloning, extracting and deleting it act on that. Each expectation below
# is Chrome's.
RSpec.describe 'range contents' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><div id=r><p id=a>abc<b>def</b>ghi</p><p id=c>jkl<i>mno</i></p>pqr</div>']] }) }

  before { session.visit '/' }

  it 'extracts across partially contained children, and collapses after the first' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const r = document.getElementById('r'), g = document.createRange();
        g.setStart(r.querySelector('b').firstChild, 1);
        g.setEnd(r.querySelector('i').firstChild, 2);
        const f = g.extractContents(), div = document.createElement('div');
        div.appendChild(f);
        return [div.innerHTML, r.innerHTML, g.startContainer === r && g.startOffset];
      })()
    JS
    expect(got).to eq(['<p id="a"><b>ef</b>ghi</p><p id="c">jkl<i>mn</i></p>', '<p id="a">abc<b>d</b></p><p id="c"><i>o</i></p>pqr', 1])
  end

  it 'surrounds only what no element is partially contained in' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('a'), g = document.createRange();
        const attempt = (f) => { try { f(); return 'ok'; } catch (e) { return e.name; } };
        g.setStart(a.querySelector('b').firstChild, 1);
        g.setEnd(a.lastChild, 2);
        const across = attempt(() => g.surroundContents(document.createElement('u')));
        g.setStart(a.firstChild, 1);
        g.setEnd(a.lastChild, 2);
        const within = attempt(() => g.surroundContents(document.createElement('u')));
        return [across, within, a.innerHTML, attempt(() => g.surroundContents({}))];
      })()
    JS
    expect(got).to eq(['InvalidStateError', 'ok', 'a<u>bc<b>def</b>gh</u>i', 'TypeError'])
  end

  # (…the check comes before any change: the comment the range starts in is left whole)
  it 'refuses a doctype before it changes anything' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const d = new DOMParser().parseFromString('<!--abc--><!DOCTYPE html><html><body>x</body></html>', 'text/html');
        const g = d.createRange();
        g.setStart(d.firstChild, 1);
        g.setEnd(d, 2);
        let refused = null;
        try { g.extractContents(); } catch (e) { refused = e.name; }
        return [refused, d.firstChild.data];
      })()
    JS
    expect(got).to eq(['HierarchyRequestError', 'abc'])
  end

  # A deletion whose removals take out a child it was to remove too — a frame's unload — goes on past it, and every
  # removal it made is finished: a custom element among them gets its disconnectedCallback (Chrome).
  it 'finishes every removal of a deletion past a child a removal took out' do
    s = simulated_session(lambda {|env|
      body = if env['PATH_INFO'] == '/frame'
        "<!DOCTYPE html><script>addEventListener('unload', () => parent.document.getElementById('q').remove())</script>f"
      else
        '<!DOCTYPE html><script>window.log = []; customElements.define("x-dc", class extends HTMLElement { disconnectedCallback() { log.push(this.id) } })</script>' \
          '<div id=d><x-dc id=a>a</x-dc><iframe src=/frame></iframe><p id=q>q</p><p id=z>z</p></div>'
      end
      [200, {'content-type' => 'text/html'}, [body]]
    }).tap {|session| session.visit '/' }
    expect(s.evaluate_script(<<~JS)).to eq([['a'], 0, true])
      (() => {
        const r = document.createRange();
        r.selectNodeContents(document.getElementById('d'));
        r.deleteContents();
        return [window.log, document.getElementById('d').childNodes.length, r.collapsed];
      })()
    JS
  end

  # A copy of a range the document itself starts in upgrades the custom elements it holds, as any of the document's
  # (Chrome).
  it "upgrades a copy of a range that starts in the document" do
    session.execute_script('customElements.define("x-up", class extends HTMLElement { constructor() { super(); this.made = 1 } }); document.body.appendChild(document.createElement("x-up"))')
    got = session.evaluate_script(<<~JS)
      (() => {
        const g = document.createRange();
        g.setStart(document, 1);
        g.setEnd(document.body, document.body.childNodes.length);
        return g.cloneContents().querySelector('x-up').made;
      })()
    JS
    expect(got).to eq(1)
  end
end
