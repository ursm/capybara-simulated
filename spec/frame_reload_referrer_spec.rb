# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A frame's reload is referred by the document reloading — its own URL, under its own policy — not under its container's
# `referrerpolicy` attribute, which a navigation of the container's makes alone (Chrome).
RSpec.describe "a frame's reload" do
  include PollUntil

  %w[no-referrer origin].each do |attribute|
    it "sends its own URL as the Referer, its container's referrerpolicy=#{attribute} none of it" do
      log = []
      session = simulated_session(lambda {|env|
        log << [env['PATH_INFO'], env['HTTP_REFERER']]
        body = env['PATH_INFO'] == '/' ? %(<iframe referrerpolicy=#{attribute} src="/f?x=1"></iframe>) : 'f'
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
      })
      session.visit '/?p=1'
      poll_until { session.evaluate_script('1') && log.count {|path, _| path == '/f' } == 1 }
      session.execute_script('frames[0].location.reload()')
      reload = poll_until { session.evaluate_script('1') && log.select {|path, _| path == '/f' }[1] }
      expect(reload[1]).to eq('http://www.example.com/f?x=1')
    end
  end
end
