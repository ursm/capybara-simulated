# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# An XHR's `progress` total is the length the response's Content-Length gives — Fetch "extract a length", the engine's
# (headers.rs `extract_length`): its values all the same, of ASCII digits — and 0, not computable, where it gives none:
# `5, 6` had been read as 5 (`parseInt` of its first digits).
RSpec.describe 'XHR progress' do
  it "totals what the response's Content-Length extracts to" do
    lengths = {'/same' => '5, 5', '/differ' => '5, 6', '/junk' => '5x'}
    app = lambda {|env|
      next [200, {'content-type' => 'text/plain', 'content-length' => lengths[env['PATH_INFO']]}, ['hello']] if lengths.key?(env['PATH_INFO'])
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']]
    }
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = {};
      for (const path of ['/same', '/differ', '/junk']) {
        const x = new XMLHttpRequest();
        x.open('GET', path);
        x.onprogress = (e) => { got[path] = [e.total, e.lengthComputable]; };
        x.send();
      }
    JS
    got = poll_until { v = s.evaluate_script('window.got'); v.size == 3 ? v : nil }
    expect(got).to eq('/same' => [5, true], '/differ' => [0, false], '/junk' => [0, false])
  end
end
