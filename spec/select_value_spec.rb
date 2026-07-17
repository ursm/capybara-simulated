require 'capybara/simulated'
require_relative 'support/js_engine'

# What a `<select>` reports as its value, and how a user pick changes it.
#
# The one concept underneath all of this is HTML's "option's value": the `value`
# content attribute, or — when absent — the `text` IDL (the descendant text with
# <script> subtrees skipped and ASCII whitespace stripped and collapsed). Every
# reader defers to the `option.value` getter so the derivation can't drift; the
# entry-list side is pinned in form_data_spec.rb.
#
# Every expectation below was taken from headless Chrome, not from reading the spec.
RSpec.describe 'select value (IDL)' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <select id="hasval"><option value="  keep  ">   Foo   </option></select>
          <select id="scr"><option>A<script>var x = 1;</script>B</option></select>
          <select id="setter"><option>  Foo  Bar  </option><option>Other</option></select>
        </body></html>
      HTML
    end
  }
  let(:session) { Capybara::Session.new(:simulated, app) }
  before { session.visit '/' }

  it 'keeps a present value attribute verbatim, whitespace and all' do
    expect(session.evaluate_script('document.getElementById("hasval").value')).to eq('  keep  ')
  end

  it "never leaks an inline <script>'s source into the value" do
    expect(session.evaluate_script('document.getElementById("scr").value')).to eq('AB')
  end

  it 'matches an assignment against the collapsed text, not the raw text' do
    expect(session.evaluate_script(<<~JS)).to eq([0, 'Foo Bar'])
      (function () {
        const s = document.getElementById('setter');
        s.value = 'Foo Bar';
        return [s.selectedIndex, s.value];
      })()
    JS
    expect(session.evaluate_script(<<~JS)).to eq([-1, ''])
      (function () {
        const s = document.getElementById('setter');
        s.value = '  Foo  Bar  ';
        return [s.selectedIndex, s.value];
      })()
    JS
  end
end

# Capybara's `Node#value` for a select mirrors the SELENIUM driver (which reads the
# `value` IDL), not rack-test (which falls back to the first option and reads raw
# option text): this is a browser-shaped driver, so real-browser semantics win where
# the two differ.
RSpec.describe 'Capybara Node#value for a select' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <select id="size4" size="4"><option>A</option><option>B</option></select>
          <select id="disabledsel"><option disabled selected>X</option><option>Y</option></select>
          <select id="alldisabled"><option disabled>P</option><option disabled>Q</option></select>
          <select id="empty"></select>
          <select id="multi" multiple><option>R</option><option selected>  S  T  </option></select>
        </body></html>
      HTML
    end
  }
  let(:session) { Capybara::Session.new(:simulated, app) }
  before { session.visit '/' }

  def value_of(id)
    session.find(:css, "##{id}", visible: :all).value
  end

  it 'reads a selected option even when it is disabled' do
    expect(value_of('disabledsel')).to eq('X')
  end

  it 'reads empty string when nothing is selected, rather than the first option' do
    expect(value_of('size4')).to eq('')
    expect(value_of('alldisabled')).to eq('')
    expect(value_of('empty')).to eq('')
  end

  it 'collapses the text fallback of a multiple select' do
    expect(value_of('multi')).to eq(['S T'])
  end
end

# A disabled option is inert: a real browser ignores the pick entirely rather than
# selecting it. Capybara's `select_option` goes through a different entry point than
# a user click, and only the click path used to check — so `select` on a disabled
# option really did select it. Upstream's shared spec ("on a disabled option should
# not select") missed it because the value reader ALSO skipped disabled options,
# masking the bad selection behind a correct-looking read.
RSpec.describe 'picking a disabled option' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <select id="own"><option>Keep</option><option disabled>Nope</option></select>
          <select id="grp"><option>Keep</option><optgroup disabled><option>Nope</option></optgroup></select>
          <select id="multi" multiple>
            <option selected>Stay</option>
            <option disabled selected>Stuck</option>
          </select>
        </body></html>
      HTML
    end
  }
  let(:session) { Capybara::Session.new(:simulated, app) }
  before { session.visit '/' }

  it 'leaves the selection alone when select_option targets a disabled option' do
    session.find(:css, '#own option', text: 'Nope').select_option
    expect(session.find(:css, '#own').value).to eq('Keep')
  end

  it 'treats an option in a disabled optgroup the same way' do
    session.find(:css, '#grp option', text: 'Nope').select_option
    expect(session.find(:css, '#grp').value).to eq('Keep')
  end

  it 'refuses to unselect a disabled option' do
    session.find(:css, '#multi option', text: 'Stuck').unselect_option
    expect(session.find(:css, '#multi').value).to eq(['Stay', 'Stuck'])
  end
end
