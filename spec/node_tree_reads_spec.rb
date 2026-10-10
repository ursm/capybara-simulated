require 'capybara/simulated'
require_relative 'support/session_teardown'

# The tree reads the engine answers (traversal.rs, collections.rs): `isEqualNode` comparing names exactly — a lone
# surrogate is no U+FFFD — and walking a tree of any depth; `getElementById` following every change, as cheap between
# writes as it is over a run of reads.
RSpec.describe 'Node tree reads' do
  let(:app) { ->(_) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><div id=d></div>']] } }
  let(:session) { simulated_session(app) }

  # Chrome and Firefox 2026-10-10: false for each pair.
  it 'compares the names isEqualNode reads exactly' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const d = document;
        const el = d.createElement('a\\uD800').isEqualNode(d.createElement('a\\uDBFF'));
        const ns = d.createElementNS('urn:\\uD800', 'x').isEqualNode(d.createElementNS('urn:\\uDBFF', 'x'));
        const a = d.createElement('a'), b = d.createElement('a');
        a.setAttributeNS('urn:\\uD800', 'x', '1');
        b.setAttributeNS('urn:\\uDBFF', 'x', '1');
        return [el, ns, a.isEqualNode(b), d.createElement('a\\uD800').isEqualNode(d.createElement('a\\uD800'))];
      })()
    JS
    expect(got).to eq([false, false, false, true])
  end

  it 'compares trees of any depth' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        // (…parsed: a script building it node by node runs each insertion's steps over the subtree it inserts)
        const t = document.createElement('template');
        t.innerHTML = '<b>'.repeat(60000) + 'leaf';
        const a = t.content;
        return [a.isEqualNode(a), a.textContent];
      })()
    JS
    expect(got).to eq([true, 'leaf'])
  end

  it 'finds an element by its id between writes and over a run of reads alike' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const seen = [];
        for (let i = 0; i < 4; i++) {
          document.getElementById('d').setAttribute('data-i', i);
          seen.push(document.getElementById('d') !== null);
        }
        const e = document.createElement('p');
        e.id = 'p';
        const before = [1, 2, 3].map(() => document.getElementById('p'));
        document.body.append(e);
        const after = [1, 2, 3].map(() => document.getElementById('p') === e);
        e.id = 'q';
        const renamed = [document.getElementById('p'), document.getElementById('q') === e];
        // (…a map made by a run of reads, through writes that move no id, then ones that do)
        for (let i = 0; i < 3; i++) document.getElementById('q').setAttribute('data-i', i);
        const earlier = document.createElement('i');
        earlier.id = 'q';
        document.body.prepend(earlier);
        const first = document.getElementById('q') === earlier;
        earlier.removeAttribute('id');
        const back = document.getElementById('q') === e;
        e.remove();
        return [seen, before, after, renamed, first, back, document.getElementById('q')];
      })()
    JS
    expect(got).to eq([[true, true, true, true], [nil, nil, nil], [true, true, true], [nil, true], true, true, nil])
  end
end
