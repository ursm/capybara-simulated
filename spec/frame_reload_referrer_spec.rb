# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A frame's reload is referred as its entry's document's request was — the Referer its container's load sent, under its
# `referrerpolicy` attribute — HTML "create navigation params by fetching", the document state's request referrer
# (Firefox 159; Chrome 157 sends the reloading document's own URL: the text over it).
RSpec.describe "a frame's reload" do
  include PollUntil

  %w[no-referrer origin].each do |attribute|
    it "sends the Referer its container's referrerpolicy=#{attribute} load sent" do
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
      expect(reload[1]).to eq(attribute == 'origin' ? 'http://www.example.com/' : nil)
    end
  end
end
