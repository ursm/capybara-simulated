# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A reset button's activation behaviour resets its form owner — a user's click on it as a script's `click()` does.
RSpec.describe 'clicking a reset button' do
  let(:page_html) {
    '<!DOCTYPE html><meta charset=utf-8><form id=f><input id=t value=orig><input type=checkbox id=c>' \
      '<button type=reset>R</button><input type=reset value=R2><button type=reset disabled>R3</button></form>'
  }
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page_html]] }) }

  it 'resets the form, unless it is disabled' do
    session.visit '/'
    got = %w[R R2].map do |button|
      session.fill_in 't', with: 'changed'
      session.check 'c'
      session.click_button button
      session.evaluate_script('[t.value, c.checked].join()')
    end
    session.fill_in 't', with: 'changed'
    session.execute_script("document.querySelector('[disabled]').click()")
    got << session.evaluate_script('t.value')
    expect(got).to eq(['orig,false', 'orig,false', 'changed'])
  end
end
