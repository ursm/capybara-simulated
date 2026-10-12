# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The table API's create* / insert* / delete* steps and caption / tHead / tFoot setters are the engine's (tables.rs
# `tableInsert`, `tableRemove`, `tableReplace`): where a caption, a head, a foot, a body, a row or a cell goes, and what an
# index out of range throws. Every expectation is Chrome's.
RSpec.describe 'the table API' do
  it 'creates, inserts and deletes the parts of a table, a section and a row' do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>']] }).tap {|s| s.visit '/' }
    got = session.evaluate_script(<<~'JS')
      (() => {
        const out = [];
        const t = document.createElement('table');
        const ser = () => t.innerHTML;
        t.insertRow(); out.push(ser());
        t.insertRow(0).insertCell().textContent = 'a'; out.push(ser());
        t.createTHead().insertRow(); out.push(ser());
        t.createTFoot(); t.createCaption(); out.push(ser());
        const c = document.createElement('caption'); c.id = 'c2'; t.caption = c; out.push(ser());
        t.tHead = null; out.push(ser());
        t.createTBody(); out.push(ser());
        t.insertRow(-1); out.push(ser(), t.rows.length);
        t.deleteRow(-1); t.deleteRow(0); out.push(ser());
        try { t.insertRow(99); } catch (e) { out.push(e.name); }
        try { t.deleteRow(99); } catch (e) { out.push(e.name); }
        try { t.tFoot = document.createElement('div'); } catch (e) { out.push(e.name); }
        const t2 = document.createElement('table'); const tr = document.createElement('tr'); t2.appendChild(tr); t2.insertRow(); out.push(t2.innerHTML);
        const t3 = document.createElement('table'); t3.appendChild(document.createElement('colgroup')); t3.createTHead(); t3.createCaption(); out.push(t3.innerHTML);
        const t4 = document.createElement('table'); const f = t4.createTFoot(); t4.appendChild(document.createElement('tbody')); t4.tFoot = f; out.push(t4.innerHTML);
        const t5 = document.createElement('table'); const cap = t5.createCaption(); t5.caption = cap; out.push(t5.innerHTML);
        const row = document.createElement('tr'); row.insertCell(); row.insertCell(0).id = 'x'; row.deleteCell(-1); out.push(row.innerHTML);
        const empty = document.createElement('tr'); empty.deleteCell(-1); out.push(empty.innerHTML);
        return out;
      })()
    JS
    expect(got).to eq([
      '<tbody><tr></tr></tbody>',
      '<tbody><tr><td>a</td></tr><tr></tr></tbody>',
      '<thead><tr></tr></thead><tbody><tr><td>a</td></tr><tr></tr></tbody>',
      '<caption></caption><thead><tr></tr></thead><tbody><tr><td>a</td></tr><tr></tr></tbody><tfoot></tfoot>',
      '<caption id="c2"></caption><thead><tr></tr></thead><tbody><tr><td>a</td></tr><tr></tr></tbody><tfoot></tfoot>',
      '<caption id="c2"></caption><tbody><tr><td>a</td></tr><tr></tr></tbody><tfoot></tfoot>',
      '<caption id="c2"></caption><tbody><tr><td>a</td></tr><tr></tr></tbody><tbody></tbody><tfoot></tfoot>',
      '<caption id="c2"></caption><tbody><tr><td>a</td></tr><tr></tr><tr></tr></tbody><tbody></tbody><tfoot></tfoot>',
      3,
      '<caption id="c2"></caption><tbody><tr></tr></tbody><tbody></tbody><tfoot></tfoot>',
      'IndexSizeError',
      'IndexSizeError',
      'TypeError',
      '<tr></tr><tr></tr>',
      '<caption></caption><colgroup></colgroup><thead></thead>',
      '<tbody></tbody><tfoot></tfoot>',
      '<caption></caption>',
      '<td id="x"></td>',
      ''
    ])
  end
end
