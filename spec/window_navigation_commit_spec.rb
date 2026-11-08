# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# What a navigation of a top-level traversable does to its session history is the engine's (navigation_commit.rs), a
# window `window.open` made in the page's isolate's as the page's: its entry committed as its document is made, of the
# request it was reached by — what a traversal back to it makes its document of again, a `blob:` URL's the blob its
# entry kept — and an about:blank document made of a window's initial about:blank an entry of its own, which the next
# navigation comes after (HTML "navigate": the initial about:blank's entry replaced; Chrome 157 and Firefox 159,
# measured 2026-11-08: `history.length` 2 after `/a`).
RSpec.describe 'a top-level navigation commit' do
  include PollUntil

  let(:session) do
    simulated_session(lambda {|env|
      html = ->(body) { [200, {'content-type' => 'text/html; charset=utf-8'}, ["<!DOCTYPE html><meta charset=utf-8>#{body}"]] }
      case env['PATH_INFO']
      when '/' then html.('<title>home</title>')
      else html.("<title>#{env['PATH_INFO']}</title>")
      end
    })
  end

  def title_of(window) = session.evaluate_script("#{window}.document.title")

  it "makes a pop-up's blob: document again of the blob its entry kept, revoked since" do
    session.visit '/'
    session.execute_script(<<~JS)
      window.u = URL.createObjectURL(new Blob(['<title>blob doc</title>'], {type: 'text/html'}));
      window.w = open(u);
    JS
    expect(poll_until { title_of('w') == 'blob doc' }).to be(true)
    session.execute_script('URL.revokeObjectURL(u); w.location = "/a"')
    expect(poll_until { title_of('w') == '/a' }).to be(true)
    session.execute_script('w.history.back()')
    expect(poll_until { title_of('w') == 'blob doc' }).to be(true)
    expect(session.evaluate_script('[w.history.length, w.location.href === u]')).to eq([2, true])
  end

  it 'gives an about:blank document made of the initial about:blank an entry, the page\'s and a pop-up\'s' do
    session.visit 'about:blank'
    session.visit '/a'
    expect(session.evaluate_script('history.length')).to eq(2)
    session.execute_script('window.w = open(); w.location = "about:blank"')
    session.execute_script('setTimeout(() => { w.location = "/b" }, 10)')
    expect(poll_until { title_of('w') == '/b' }).to be(true)
    expect(session.evaluate_script('w.history.length')).to eq(2)
  end

  # …and a `javascript:` URL's document made of it alike: HTML replaces the initial about:blank's entry with one of a
  # document that is no initial about:blank (Chrome 157 and Firefox 159 leave it initial still, 1 after `/b`).
  it "gives a javascript: URL's document made of the initial about:blank an entry" do
    session.visit '/'
    session.execute_script(%q(window.w = open(); w.location = 'javascript:"<title>js</title>"'))
    expect(poll_until { title_of('w') == 'js' }).to be(true)
    session.execute_script('w.location = "/b"')
    expect(poll_until { title_of('w') == '/b' }).to be(true)
    expect(session.evaluate_script('w.history.length')).to eq(2)
  end
end
