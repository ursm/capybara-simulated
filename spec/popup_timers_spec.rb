# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A window the page opens in its own isolate — `open('', name)`, an about:blank one — is stepped with its opener, so its
# being idle never stops the opener's timers: one the opener set after opening it still fires while Capybara waits.
RSpec.describe 'a timer beside an idle popup' do
  let(:page) {
    <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><body><script>
        onload = () => {
          window.open('', 'w2');
          setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p id="late">late</p>'), 150);
        };
      </script>
    HTML
  }

  it 'fires the opener’s timer' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    expect(s).to have_css('#late', wait: 3)
  end
end
