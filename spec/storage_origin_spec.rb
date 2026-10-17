# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# Web Storage is an area per storage key (HTML §12.2: "obtain a storage key"): the origin, and the site of the top-level
# document it is under (storage partitioning, Chrome and Firefox both) — a frame of another origin has its own
# `localStorage` and `sessionStorage`, and a change of the page's fires `storage` at its same-origin frame alone, a
# third-party frame's area is not its origin's first-party one but under the same site; a document of an opaque origin
# has no storage key, its getters a SecurityError (Chrome's words).
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

  let(:partitioned) {
    lambda do |env|
      body = case env['PATH_INFO']
      when '/f'
        '<script>window.E = []; addEventListener("storage", (e) => E.push(e.key)); localStorage.setItem("3p", "1");</script>'
      when '/1p'
        '<script>localStorage.setItem("1p", "1");</script>'
      else
        '<iframe id="other" src="http://other.test/f"></iframe><iframe id="sub" src="http://sub.example.com/f"></iframe>'
      end
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8">' + body]]
    end
  }

  it "keeps a third-party frame's area apart from its origin's first-party one, but under the same site, and its events" do
    s = simulated_session(partitioned)
    s.visit '/'
    poll_until { s.within_frame('other') { s.evaluate_script('localStorage.length') } == 1 && s.within_frame('sub') { s.evaluate_script('localStorage.length') } == 1 }
    w = s.open_new_window
    first_party = %w[other.test sub.example.com].map {|host|
      s.within_window(w) do
        s.visit "http://#{host}/1p"
        s.evaluate_script('Object.keys(localStorage)')
      end
    }
    expect(first_party).to eq([['1p'], %w[3p 1p]])
    expect(s.within_frame('other') { s.evaluate_script('[Object.keys(localStorage), E]') }).to eq([['3p'], []])
    expect(s.within_frame('sub') { poll_until { r = s.evaluate_script('E'); r unless r.empty? } }).to eq(['1p'])
  end
end
