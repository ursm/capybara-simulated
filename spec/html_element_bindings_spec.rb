require 'capybara/simulated'
require_relative 'support/session_teardown'

# The HTML element interfaces the bindings generate (gen_bindings.mjs), where their implementations hold what the
# reflection WPT files do not ask: a table's parts are HTML elements of their names, a row of a table its index among
# the table's rows; a srcdoc document's <base> resolves against the base it inherits; an attribute name given an HTML
# element in an XML document is not lowercased.
RSpec.describe 'HTML element bindings' do
  let(:app) {
    lambda {|_|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><table id=t></table><iframe srcdoc="<base href=x/>"></iframe>']]
    }
  }
  let(:session) { simulated_session(app) }

  it 'takes a table part by its namespace as well as its name' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const SVG = 'http://www.w3.org/2000/svg', t = document.getElementById('t');
        t.append(document.createElementNS(SVG, 'caption'), document.createElementNS(SVG, 'tr'));
        const row = document.createElement('tr');
        row.append(document.createElementNS(SVG, 'td'), document.createElement('td'));
        return [t.caption, t.rows.length, row.cells.length, row.lastChild.cellIndex];
      })()
    JS
    expect(got).to eq([nil, 0, 1, 0])
  end

  it "indexes a table's own row among the table's rows" do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('t');
        t.createTHead().insertRow();
        const tr = t.appendChild(document.createElement('tr'));
        return [tr.sectionRowIndex, tr.rowIndex];
      })()
    JS
    expect(got).to eq([1, 1])
  end

  it "resolves a srcdoc document's base against the base it inherits" do
    session.visit '/'
    got = session.evaluate_script("document.querySelector('iframe').contentDocument.querySelector('base').href")
    expect(got).to end_with('/x/')
    expect(got).to start_with('http')
  end

  it "keeps the case of an attribute name given an HTML element in an XML document" do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const ol = document.implementation.createDocument(null, 'r').createElementNS('http://www.w3.org/1999/xhtml', 'ol');
        ol.setAttribute('START', '5');
        return [ol.getAttributeNames(), ol.start, ol.getAttribute('start')];
      })()
    JS
    expect(got).to eq([['START'], 1, nil])
  end
end
