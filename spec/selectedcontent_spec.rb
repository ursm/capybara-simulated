require 'capybara/simulated'

# `<selectedcontent>` mirrors (deep-clones) the currently-selected `<option>`'s
# child nodes into itself, re-cloned whenever the selection settles. It is a
# SNAPSHOT — later mutations of the option's own subtree are not reflected. The
# WPT the-select-element/customizable-select/selectedcontent* files cover the spec
# contract; these pin the behaviour the driver's own paths (Capybara
# select_option, the IDL setters) must keep working.
RSpec.describe '<selectedcontent> mirroring' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <select id="s">
            <button><selectedcontent></selectedcontent></button>
            <option value="a"><b>Apple</b></option>
            <option value="b"><i>Banana</i></option>
          </select>
        </body></html>
      HTML
    end
  }
  let(:session) { Capybara::Session.new(:simulated, app) }
  before { session.visit '/' }

  def sc_html
    session.evaluate_script("document.querySelector('selectedcontent').innerHTML.trim()")
  end

  it 'initially mirrors the first (selected) option, cloning child elements' do
    expect(sc_html).to eq('<b>Apple</b>')
  end

  it 're-clones when select.value changes' do
    session.execute_script("document.getElementById('s').value = 'b'")
    expect(sc_html).to eq('<i>Banana</i>')
  end

  it 're-clones when an option is picked via Capybara select_option' do
    session.find(:option, 'Banana').select_option
    expect(sc_html).to eq('<i>Banana</i>')
  end

  it 'is a snapshot — later mutations of the option subtree are ignored' do
    session.execute_script("document.querySelector('option[value=a] b').textContent = 'Apricot'")
    expect(sc_html).to eq('<b>Apple</b>')
  end

  it 'updates a detached select on value change' do
    html = session.evaluate_script(<<~JS)
      (function () {
        const s = document.createElement('select');
        s.innerHTML = '<button><selectedcontent></selectedcontent></button>' +
                      '<option value=a>Apple</option><option value=b>Banana</option>';
        s.value = 'b';
        return s.querySelector('selectedcontent').textContent.trim();
      })()
    JS
    expect(html).to eq('Banana')
  end
end
