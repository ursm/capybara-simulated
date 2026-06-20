require 'capybara/simulated'
require 'rack'

# The customizable-`<select>` content model (HTML "SelectParserRelaxation",
# shipped by default in Chromium ≥134): the "in select" / "in select in table"
# insertion modes were removed, so a `<select>`'s content is parsed with the
# in-body rules. Flow content (`<div>`, `<button>`, …) and `<textarea>` /
# `<keygen>` are KEPT inside the select; only `<input>` and a nested `<select>`
# still break out. We emulate this over parse5@8 (parse5-adapter.js
# RelaxedSelectParser); each expectation below mirrors Google Chrome 149's
# observable parse. The DOM-side select machinery already collects options via
# `querySelectorAll('option')`, so options nested under wrappers still work.
RSpec.describe 'customizable-select content model' do
  let(:app) {
    lambda do |env|
      [200, {'content-type' => 'text/html'}, [@html]]
    end
  }

  let(:session) { Capybara::Session.new(:simulated, app) }

  def visit_html(html)
    @html = html
    session.visit '/'
  end

  it 'keeps a <div> wrapper (and its <option>) inside a <select>' do
    visit_html '<!doctype html><html><body><select id=s><div class=w><option class=o>one</option></div></select></body></html>'

    expect(session.evaluate_script("document.querySelectorAll('#s div.w').length")).to eq(1)
    expect(session.evaluate_script("document.querySelectorAll('#s option.o').length")).to eq(1)
    expect(session.evaluate_script("document.getElementById('s').options.length")).to eq(1)
    # selectedness still initialises the wrapped option as the implicit default.
    expect(session.evaluate_script("document.querySelector('#s option.o').selected")).to be(true)
  end

  it 'keeps <textarea> and <keygen> inside a <select>' do
    visit_html '<!doctype html><html><body><select id=s><textarea>t</textarea><keygen><option>z</option></select></body></html>'

    expect(session.evaluate_script("document.querySelectorAll('#s textarea').length")).to eq(1)
    expect(session.evaluate_script("document.querySelectorAll('#s keygen').length")).to eq(1)
    expect(session.evaluate_script("document.getElementById('s').options.length")).to eq(1)
  end

  it 'breaks out of an open <select> on <input> and a nested <select>' do
    visit_html '<!doctype html><html><body><select id=a><input value=x><option>z</option></select>' \
               '<select id=b><select id=inner><option>i</option></select><option>z</option></select></body></html>'

    # <input> closes select#a (everything after lands outside it).
    expect(session.evaluate_script("document.getElementById('a').children.length")).to eq(0)
    # The nested <select> closes select#b without nesting.
    expect(session.evaluate_script("document.querySelectorAll('#b select').length")).to eq(0)
  end

  it 'keeps sibling <optgroup>s siblings (implied end tags)' do
    visit_html '<!doctype html><html><body><select id=og>' \
               '<optgroup label=g1><option class=a>a</optgroup>' \
               '<optgroup label=g2><option class=b>b</select></body></html>'

    expect(session.evaluate_script("document.querySelectorAll('#og > optgroup').length")).to eq(2)
    expect(session.evaluate_script("document.querySelector('#og option.a').closest('optgroup').getAttribute('label')")).to eq('g1')
    expect(session.evaluate_script("document.querySelector('#og option.b').closest('optgroup').getAttribute('label')")).to eq('g2')
  end

  it 'inserts <hr> as a direct child of the <select>, closing open option/optgroup' do
    visit_html '<!doctype html><html><body><select id=hr><option class=h1>a<hr><option class=h2>b</select></body></html>'

    expect(session.evaluate_script("document.querySelectorAll('#hr > hr').length")).to eq(1)
    expect(session.evaluate_script("document.querySelectorAll('#hr > option').length")).to eq(2)
  end

  it 'lets table-structure tags break a <select> nested in a table cell out' do
    visit_html '<!doctype html><html><body><table id=t><tr><td>' \
               '<select id=s><tr><td>X</select></td></tr></table></body></html>'

    # The stray <tr> closes the cell (and the select), opening a new row — the
    # select ends up empty and the table has two rows, matching a real browser.
    expect(session.evaluate_script("document.getElementById('s').children.length")).to eq(0)
    expect(session.evaluate_script("document.querySelectorAll('#t tr').length")).to eq(2)
  end

  it 'closes the <select> on </select> even with open flow content inside it' do
    # `</select>` uses regular scope, so it closes through an open `<div>`/`<b>`
    # (the legacy in-select mode used select-scope, where they are boundaries,
    # and would leave the select open to swallow following content).
    visit_html '<!doctype html><html><body><div id=wrap><select><div></select>x</div></body></html>'

    expect(session.evaluate_script("document.querySelectorAll('#wrap > select').length")).to eq(1)
    expect(session.evaluate_script("document.querySelectorAll('#wrap > select div').length")).to eq(1)
    # The "x" lands AFTER the select (outside it), not swallowed by the inner div.
    expect(session.evaluate_script("document.querySelector('#wrap > select').textContent.trim()")).to eq('')
    expect(session.evaluate_script("document.getElementById('wrap').textContent.trim()")).to eq('x')
  end

  it 'keeps wrappers inside a <select> when set via innerHTML (fragment path)' do
    visit_html '<!doctype html><html><body><select id=s></select></body></html>'
    session.execute_script("document.getElementById('s').innerHTML = '<div class=w><option class=o>x</option></div>'")

    expect(session.evaluate_script("document.querySelectorAll('#s div.w').length")).to eq(1)
    expect(session.evaluate_script("document.getElementById('s').options.length")).to eq(1)
  end

  it 'inherits disabledness from the owning <select> through a wrapper' do
    visit_html '<!doctype html><html><body>' \
               '<select id=d disabled><div><option id=od>x</option></div></select>' \
               '<select id=e><div><option id=oe>y</option></div></select></body></html>'

    # The owning-select disabled walk (host-queries.js __csimDisabled, backing
    # Capybara's `disabled?`) now steps past the wrapper to the select.
    expect(session.find('#od', visible: :all).disabled?).to be(true)
    expect(session.find('#oe', visible: :all).disabled?).to be(false)
  end
end
