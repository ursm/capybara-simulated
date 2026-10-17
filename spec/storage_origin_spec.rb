# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# Web Storage is an area per origin (HTML §12.2: "obtain a storage key"): a frame of another origin has its own
# `localStorage` and `sessionStorage`, and a change of the page's fires `storage` at its same-origin frame alone; a
# document of an opaque origin has no storage key, its getters a SecurityError (Chrome's words).
RSpec.describe 'Web Storage origins' do
  include PollUntil

  let(:frame) {
    <<~HTML
      <!DOCTYPE html><meta charset="utf-8">
      <script>
        let events = 0;
        addEventListener('storage', () => { events++; });
        addEventListener('message', (e) => {
          if (e.data === 'report') parent.postMessage([location.host, localStorage.getItem('k'), sessionStorage.length, events], '*');
        });
        parent.postMessage('ready', '*');
      </script>
    HTML
  }
  let(:app) {
    ->(env) {
      if env['PATH_INFO'] == '/f'
        [200, {'content-type' => 'text/html'}, [frame]]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><meta charset="utf-8">
          <script>
            localStorage.setItem('k', 'page'); sessionStorage.setItem('s', '1');
            window.R = []; window.ready = 0;
            addEventListener('message', (e) => { if (e.data === 'ready') ready++; else R.push(e.data); });
          </script>
          <iframe src="/f"></iframe><iframe src="http://other.test/f"></iframe>
          <iframe sandbox="allow-scripts" srcdoc="<script>try { localStorage; parent.postMessage('none', '*') } catch (e) { parent.postMessage(e.name + ': ' + e.message, '*') }</script>"></iframe>
        HTML
      end
    }
  }

  it "keeps a frame of another origin's areas apart, and fires `storage` at the page's origin alone" do
    s = simulated_session(app)
    s.visit '/'
    poll_until { s.evaluate_script('ready') == 2 }
    s.execute_script("localStorage.setItem('k', 'changed')")
    s.execute_script("frames[0].postMessage('report', '*'); frames[1].postMessage('report', '*')")
    got = poll_until { r = s.evaluate_script('R'); r if r.size == 3 }
    expect(got.sort_by(&:to_s)).to eq([
      ['other.test', nil, 0, 0],
      ['www.example.com', 'changed', 1, 1],
      "SecurityError: Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag."
    ].sort_by(&:to_s))
  end
end
