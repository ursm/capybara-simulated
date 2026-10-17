# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# `window.open`'s features (HTML window open steps, "tokenize the features"): `noopener` opens a window with no opener —
# the call returns null, and its about:blank document is a new opaque origin, not the opener's — and `noreferrer`, which
# implies it, one whose navigation sends no referrer; any other, or none, an auxiliary window, loaded with the calling
# document's URL as its referrer.
RSpec.describe 'window.open features' do
  let(:app) {
    lambda do |env|
      body = if env['PATH_INFO'] == '/popup'
        <<~HTML
          <!doctype html><meta charset="utf-8"><title>popup</title>
          <p id="r"></p><script>document.getElementById('r').textContent = JSON.stringify([!!window.opener, document.referrer]);</script>
        HTML
      else
        '<!doctype html><meta charset="utf-8"><title>main</title>'
      end
      [200, {'content-type' => 'text/html'}, [body]]
    end
  }

  def opened(features)
    session = simulated_session(app)
    session.visit '/'
    window = session.window_opened_by { session.execute_script("window.R = window.open('/popup', '', #{features.to_json})") }
    [session.evaluate_script('R === null'), *session.within_window(window) { JSON.parse(session.find('#r').text) }]
  end

  it 'opens an auxiliary window with the referrer, but for `noopener` and `noreferrer`' do
    expect(opened('')).to eq([false, true, 'http://www.example.com/'])
    expect(opened('width=100, noopener=0')).to eq([false, true, 'http://www.example.com/'])
    expect(opened('noopener')).to eq([true, false, 'http://www.example.com/'])
    expect(opened(' NOOPENER = yes ')).to eq([true, false, 'http://www.example.com/'])
    expect(opened('noreferrer')).to eq([true, false, ''])
  end

  it "gives a `noopener` about:blank window — an empty URL's too — a new opaque origin, not the opener's" do
    session = simulated_session(app)
    session.visit '/'
    got = ['about:blank', ''].map {|url|
      window = session.window_opened_by { session.execute_script("window.open('#{url}', '', 'noopener')") }
      session.within_window(window) {
        session.evaluate_script("[location.href, origin, (() => { try { return localStorage.length; } catch (e) { return e.name; } })()]")
      }
    }
    expect(got).to eq([%w[about:blank null SecurityError]] * 2)
  end
end
