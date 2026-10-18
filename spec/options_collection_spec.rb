# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTMLOptionsCollection's own tree changes are the engine's (select_options.rs): the `length` setter's blank options and
# an indexed write's padding are appended at once — one DocumentFragment of them as HTML says, one mutation record (they
# were appended one by one, a record each) — shrinking removes options from the end, one removal each, and
# `remove(index)` and a null indexed write remove the index-th option.
RSpec.describe 'HTMLOptionsCollection' do
  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body><select id="s"><option>a</option><optgroup><option>b</option></optgroup></select>']] })
    s.visit '/'
    s
  }

  it 'appends blank options at once and removes options from the end, each its own record' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const s = document.getElementById('s'), records = [];
        const mo = new MutationObserver((rs) => records.push(...rs));
        mo.observe(s, { childList: true, subtree: true });
        const log = [];
        const flush = (label) => { records.push(...mo.takeRecords()); log.push(label + ':' + records.map((r) => r.addedNodes.length + '+' + r.removedNodes.length).join(',')); records.length = 0; };
        s.options.length = 5;
        flush('grow');
        s.options.length = 1;
        flush('shrink');
        s.options[3] = new Option('d');
        flush('pad');
        s.options[1] = null;
        s.remove(0);
        flush('remove');
        return log.concat(Array.from(s.options, (o) => o.text || '-').join(' '));
      })()
    JS
    expect(got).to eq(['grow:3+0', 'shrink:0+1,0+1,0+1,0+1', 'pad:2+0,1+0', 'remove:0+1,0+1', '- d'])
  end

  # The `length` setter grows the list to no more than 100,000 options — a greater value changes nothing (HTML; Chrome,
  # Firefox) — however few it holds; and the collection's `remove(index)` is its select's.
  it 'refuses a length over 100,000 and removes through the collection as through the select' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const big = document.createElement('select');
        big.length = 50000;
        big.length = 120000;
        const grown = big.length;
        const s = document.getElementById('s');
        s.length = 3;
        s.options.remove(1);
        return [grown, s.length, Array.from(s.options, (o) => o.text || '-').join(' ')];
      })()
    JS
    expect(got).to eq([50000, 2, 'a -'])
  end
end
