require 'capybara/simulated'

# `new FormData(form)` must mirror real-browser submission semantics:
# the option's `value` attribute, NOT its visible text. Most apps put
# a placeholder option like `<option value="">Choose...</option>`
# first, expecting an empty submitted value when nothing is picked —
# coercing that to "Choose..." breaks the server side (e.g. Avo's
# friendly_id lookup raises "can't find record").
RSpec.describe 'FormData serialization' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <form id="f">
            <select name="placeholder">
              <option value="">Choose an option</option>
              <option value="a">Alpha</option>
            </select>
            <select name="missing-attr">
              <option>FromText</option>
              <option>OtherText</option>
            </select>
            <select name="picked">
              <option value="">none</option>
              <option value="b" selected>Beta</option>
            </select>
          </form>
        </body></html>
      HTML
    end
  }
  let(:session) { Capybara::Session.new(:simulated, app) }

  before { session.visit '/' }

  def fd_get(name)
    session.evaluate_script(<<~JS)
      (function () {
        const fd = new FormData(document.getElementById('f'));
        return fd.get(#{name.to_json});
      })()
    JS
  end

  it 'serializes an explicit empty value attribute as empty string' do
    expect(fd_get('placeholder')).to eq('')
  end

  it 'falls back to textContent when the value attribute is missing' do
    expect(fd_get('missing-attr')).to eq('FromText')
  end

  it 'serializes the explicitly selected option' do
    expect(fd_get('picked')).to eq('b')
  end
end
