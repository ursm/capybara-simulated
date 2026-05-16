require 'capybara/simulated'

# Each Capybara user-action method (fill_in / check / choose / select / etc.)
# should fire the same event sequence a real browser does. Lock the
# contract here so a regression in any control surfaces as a failed
# expectation rather than a silent listener miss in a downstream app.
RSpec.describe 'HTML control event dispatch' do
  let(:app) {
    lambda do |_env|
      body = <<~HTML
        <!doctype html><html><head></head><body>
          <form id="f" action="/post" method="post">
            <input type="text"     id="text"  name="text"  value="initial">
            <textarea              id="ta"    name="ta">initial</textarea>
            <input type="checkbox" id="cb"    name="cb"    value="yes">
            <input type="radio"    name="r" value="a" id="ra">
            <input type="radio" name="r" value="b" id="rb" checked>
            <select id="sel" name="sel">
              <option value="x">X</option>
              <option value="y" selected>Y</option>
              <option value="z">Z</option>
            </select>
            <select id="msel" name="msel" multiple>
              <option value="p">P</option>
              <option value="q">Q</option>
              <option value="r">R</option>
            </select>
            <input type="date" id="d" name="d">
          </form>
          <pre id="log"></pre>
          <script>
            const log = document.querySelector('#log');
            const record = (target, ev) => {
              const id = target.id || (target.name ? '@' + target.name : target.tagName);
              log.textContent += id + ':' + ev.type + '\\n';
            };
            for (const t of ['focus', 'blur', 'input', 'change', 'click']) {
              document.querySelector('#f').addEventListener(t, e => record(e.target, e), true);
            }
          </script>
        </body></html>
      HTML
      [200, {'content-type' => 'text/html; charset=utf-8'}, [body]]
    end
  }

  let(:session) { Capybara::Session.new(:simulated, app) }

  def event_log
    session.evaluate_script("document.querySelector('#log').textContent").lines.map(&:chomp)
  end

  before { session.visit '/' }

  it 'fill_in on a text input fires focus → input → change' do
    session.fill_in 'text', with: 'hello'
    expect(event_log).to eq(%w[text:focus text:input text:change])
    expect(session.find('#text').value).to eq('hello')
  end

  it 'fill_in on a textarea fires focus → input → change' do
    session.fill_in 'ta', with: 'multi\nline'
    expect(event_log).to eq(%w[ta:focus ta:input ta:change])
  end

  it 'check on an unchecked checkbox fires focus → click → input → change' do
    session.check 'cb'
    expect(event_log).to eq(%w[cb:focus cb:click cb:input cb:change])
    expect(session.find('#cb')).to be_checked
  end

  it 'uncheck on a checked checkbox fires click → input → change' do
    session.check 'cb'
    before_len = event_log.length
    session.uncheck 'cb'
    # No leading `cb:focus` — the prior `check` already focused it.
    expect(event_log.drop(before_len)).to eq(%w[cb:click cb:input cb:change])
    expect(session.find('#cb')).not_to be_checked
  end

  it 'choose on a radio fires focus → click → input → change and clears the peer' do
    session.choose 'ra'
    expect(event_log).to eq(%w[ra:focus ra:click ra:input ra:change])
    expect(session.find('#ra')).to be_checked
    expect(session.find('#rb', visible: :all)).not_to be_checked
  end

  it 'select on a single select fires input → change' do
    session.select 'X', from: 'sel'
    expect(event_log).to eq(%w[sel:input sel:change])
    expect(session.find('#sel').value).to eq('x')
  end

  it 'select on a multi-select fires input → change per pick' do
    session.select 'P', from: 'msel'
    session.select 'R', from: 'msel'
    expect(event_log).to eq(%w[msel:input msel:change msel:input msel:change])
    expect(session.find('#msel').value).to contain_exactly('p', 'r')
  end

  it 'unselect on a multi-select fires input → change' do
    session.select 'P', from: 'msel'
    before_len = event_log.length
    session.unselect 'P', from: 'msel'
    expect(event_log.drop(before_len)).to eq(%w[msel:input msel:change])
  end

  it 'fill_in on a date input fires focus → input → change' do
    session.fill_in 'd', with: '2026-05-06'
    expect(event_log).to eq(%w[d:focus d:input d:change])
    expect(session.find('#d').value).to eq('2026-05-06')
  end

  it 'a Stimulus-style change listener on a select reacts to Capybara select' do
    session.execute_script(<<~JS)
      window.__changes = [];
      document.querySelector('#sel').addEventListener('change', function() {
        window.__changes.push(this.value);
      });
    JS
    session.select 'Z', from: 'sel'
    expect(session.evaluate_script('window.__changes')).to eq(['z'])
  end
end
