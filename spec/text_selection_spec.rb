require 'capybara/simulated'
require_relative 'support/session_teardown'

# A text control's selection is into its RELEVANT VALUE — a clean `<input>`'s attribute sanitized for its type — and
# `setRangeText()`'s "preserve" mode moves a start inside the range to its start, an end inside it to the replacement's
# end, the direction none. Every figure Chrome's and Firefox's (2026-10-10).
RSpec.describe 'Text control selection' do
  let(:html) {
    <<~HTML
      <!doctype html><meta charset=utf-8><body>
      <input id=nl value="ab&#10;cd"><input id=url type=url value="  http://a  "><input id=t value="hello world">
    HTML
  }
  let(:session) { simulated_session(->(_) { [200, {'content-type' => 'text/html'}, [html]] }) }

  it 'selects in the value the user edits, and preserves a selection as the spec moves it' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const sel = (el) => [el.selectionStart, el.selectionEnd, el.selectionDirection];
        nl.setRangeText('Z', 3, 4, 'select');
        url.setRangeText('Z', 0, 2, 'end');
        const u2 = document.createElement('input'); u2.type = 'url'; u2.setAttribute('value', '  http://a  '); u2.setSelectionRange(100, 100);
        t.setSelectionRange(2, 8, 'backward'); t.setRangeText('XYZ', 0, 4);
        return [nl.value, sel(nl), url.value, u2.selectionStart, t.value, sel(t)];
      })()
    JS
    expect(got).to eq(['abcZ', [3, 4, 'none'], 'Ztp://a', 8, 'XYZo world', [0, 7, 'none']])
  end

  it 'types into a clean field from its sanitized value' do
    session.visit '/'
    session.find('#url').send_keys(:end, 'Q')
    session.find('#nl').send_keys(:end, 'Q')
    expect(session.evaluate_script('[url.value, nl.value]')).to eq(['http://aQ', 'abcdQ'])
  end
end
