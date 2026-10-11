# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A click has ONE activation target (DOM dispatch): the target, or — the click bubbling — its nearest ancestor with
# activation behaviour. The hyperlink a scripted click follows is that one (element_state.rs `followed_link`): not for
# a click that does not bubble on what is inside the link, and not past a checkbox, a radio button, a details' summary
# or a label with a control, whose activation it is. Each expectation is headless Chrome's.
RSpec.describe 'the activation target of a click' do
  let(:page_html) {
    <<~HTML
      <!DOCTYPE html><meta charset=utf-8><body>
      <a href="#s1"><span id=s1>x</span></a>
      <a href="#i2"><input id=i2></a>
      <a href="#c4"><input type=checkbox id=c4></a>
      <a href="#lab"><label id=lab>lbl<input type=checkbox id=lc></label></a>
      <a href="#sm"><details><summary id=sm>s</summary>body</details></a>
      <a href="#b"><button type=button id=b>b</button></a>
    HTML
  }
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page_html]] }) }

  it 'follows the link only where the click activates it' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const click = (id, bubbles) => {
          location.hash = '';
          document.getElementById(id).dispatchEvent(new MouseEvent('click', {bubbles, cancelable: true}));
          return id + location.hash;
        };
        return [click('s1', false), click('i2', true), click('c4', true), click('lab', true), click('sm', true), click('b', true),
                document.getElementById('c4').checked, document.getElementById('lc').checked,
                document.getElementById('sm').parentNode.open];
      })()
    JS
    expect(got).to eq(['s1', 'i2#i2', 'c4', 'lab', 'sm', 'b#b', true, true, true])
  end
end
