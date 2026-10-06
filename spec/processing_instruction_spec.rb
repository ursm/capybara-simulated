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
end
