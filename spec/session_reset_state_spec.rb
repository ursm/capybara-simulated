# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A session reset leaves the next test a fresh window: nothing the last test's documents were still to do is left for
# the next test's event loop to run, nor holds it busy.
RSpec.describe 'session reset' do
  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><p>page</p>']] })
    s.visit('/')
    s
  }
  let(:browser) { session.driver.browser }

  # A `storage` event another window's change queued for this window's documents, which they were still to fire.
  it 'lets go of the storage events the last documents were still to fire' do
    browser.enqueue_storage_event('local', 'k', nil, 'v', 'http://127.0.0.1/', 'http://127.0.0.1')
    expect(browser.window_message_pending?).to be(true)
    session.reset_session!
    expect(browser.window_message_pending?).to be(false)
    expect(browser.steps_pending?).to be(false)
  end

  # A navigation deferred on a service worker still activating, and one made due as it activated: neither is the next
  # test's to make, nor keeps its window stepping.
  it 'lets go of the navigations deferred on an activating worker' do
    made = []
    browser.instance_variable_get(:@sw_deferred_navigations) << [nil, -> { made << :deferred }]
    browser.instance_variable_get(:@sw_navigations_due) << [nil, -> { made << :due }]
    session.reset_session!
    expect(browser.steps_pending?).to be(false)
    browser.sw_navigations_due!
    browser.consume_sw_deferred_navigations
    expect(made).to be_empty
  end
end
