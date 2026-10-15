require 'capybara/simulated'
require_relative 'support/session_teardown'

# Key events go to the focused element (UI Events) — inside a shadow tree too, which `document.activeElement`
# retargets to its host: keys sent to a container whose shadow-tree input has focus type into that input, and its
# keydown, keypress and keyup are that input's.
RSpec.describe 'keys to a focused element in a shadow tree' do
  it 'types into the focused input and fires its key events there' do
    s = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset="utf-8"><div id="wrap"><span id="host"></span></div>
        <script>
          const input = document.getElementById('host').attachShadow({mode: 'open'}).appendChild(document.createElement('input'));
          window.seen = [];
          for (const type of ['keydown', 'keypress', 'keyup']) input.addEventListener(type, (e) => seen.push(type + ':' + e.key));
          input.focus();
        </script>
      HTML
    })
    s.visit '/'
    s.find('#wrap').send_keys('a')
    expect(s.evaluate_script("[document.getElementById('host').shadowRoot.querySelector('input').value, seen]")).to eq(
      ['a', ['keydown:a', 'keypress:a', 'keyup:a']]
    )
  end
end
