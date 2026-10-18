require 'capybara/simulated'
require_relative 'support/session_teardown'

# A ProcessingInstruction's attribute map (DOM §4.13): written back as its data by its attribute members, kept as it
# was written — a name no XML Name, which its data then does not parse back to — until its data is replaced, which a
# replacement that throws before it changes anything is not; and none of it any other CharacterData's.
RSpec.describe 'ProcessingInstruction attributes' do
  let(:app) { ->(_) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><p>x']] } }
  let(:session) { simulated_session(app) }

  it 'keeps the map it wrote till its data is replaced' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const p = document.createProcessingInstruction('t', '');
        p.setAttribute('$', 'v');
        const written = [p.data, p.getAttribute('$')];
        try { p.deleteData(100, 1); } catch (e) { written.push(e.name); }
        written.push(p.getAttribute('$'));
        p.data = p.data;
        written.push(p.getAttribute('$'));
        const t = document.createTextNode('a');
        t.data = 'b';
        return [written, Object.getOwnPropertyNames(t).some((k) => k.startsWith('_pi'))];
      })()
    JS
    expect(got).to eq([['$="v"', 'v', 'IndexSizeError', 'v', nil], false])
  end

  # (…and a write its data cannot take — longer than a string can be — a RangeError that leaves the data and the map as
  # they were, where the data had become "undefined"; and the map read natively, a page's `Array.prototype.flat` in
  # nobody's way)
  it 'refuses a write its data cannot take, and writes past a page that patched the built-ins' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const p = document.createProcessingInstruction('t', 'a="1"');
        let error = null;
        try { p.setAttribute('k', '&'.repeat(2 ** 27)); } catch (e) { error = e.name; }
        const flat = Array.prototype.flat;
        Array.prototype.flat = () => ['evil', 'x'];
        const q = document.createProcessingInstruction('t', '');
        q.setAttribute('k', 'v');
        Array.prototype.flat = flat;
        return [error, p.data, p.getAttribute('k'), q.data];
      })()
    JS
    expect(got).to eq(['RangeError', 'a="1"', nil, 'k="v"'])
  end
end
