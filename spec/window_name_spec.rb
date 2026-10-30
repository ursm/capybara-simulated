# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/every_host_local'

# A top-level window's `window.name` is its navigable's target name, which HTML keeps in the active document state: a
# navigation carries it to the next document — cleared where that one is of another origin and the window has no opener
# ("finalize a cross-document navigation") — a traversal brings back the one its entry had, a window `window.open` named
# has it from its first document on, and the name a script gives it is the one a later `window.open` finds it by.
RSpec.describe 'a top-level window’s name', :every_host_local do
  let(:session) {
    simulated_session(lambda {|env|
      req  = Rack::Request.new(env)
      body = "<!DOCTYPE html><body>#{req.host}#{req.path}<a id=same href=/next>same</a><a id=away href=http://b.test/next>away</a>"
      [200, {'content-type' => 'text/html'}, [body]]
    })
  }

  def name = session.evaluate_script('window.name')

  it 'is kept across a same-origin navigation and cleared by one to another origin' do
    session.visit 'http://a.test/'
    session.execute_script("window.name = 'kept'")
    session.click_link 'same'
    expect(name).to eq('kept')
    session.click_link 'away'
    expect(name).to eq('')
  end

  # (…the document a pagehide runs in still its own: the name it sets is the leaving document's — back with it on a
  # traversal — not the next one's, which took the name as the navigation began: the next one's 'orig' in Chrome and
  # Firefox, measured)
  it "set in a pagehide is the leaving document's" do
    session.visit 'http://a.test/'
    session.execute_script("window.name = 'orig'; addEventListener('pagehide', () => { window.name = 'fromhide' })")
    session.click_link 'same'
    expect(name).to eq('orig')
    session.go_back
    expect(name).to eq('fromhide')
  end

  # (…and so for a replace navigation's, whose entry takes the leaving document's away: the next document's name the one
  # the navigation began with, cleared across origins)
  it "set in the pagehide of a document a replace navigation leaves is the leaving document's" do
    session.visit 'http://a.test/'
    session.execute_script("window.name = 'orig'; addEventListener('pagehide', () => { window.name = 'fromhide' })")
    session.execute_script("location.replace('/next')")
    session.evaluate_script('1')
    expect(name).to eq('orig')
    session.execute_script("addEventListener('pagehide', () => { window.name = 'fromhide' }); location.replace('http://b.test/next')")
    session.evaluate_script('1')
    expect(name).to eq('')
  end

  # (…about:blank, a window's own and a visit's, a document like any other: of its initiator's origin, an opaque one
  # for a visit's; an error document of an opaque one too)
  it 'is cleared through about:blank and by an error document, as any document of another origin clears it' do
    session.visit 'http://a.test/'
    session.execute_script("window.name = 'n'")
    session.visit 'about:blank'
    expect(name).to eq('')
    session.visit 'http://a.test/'
    session.execute_script("window.name = 'n'; location.href = 'about:blank'")
    session.evaluate_script('1')
    session.visit 'http://b.test/'
    expect(name).to eq('')
    session.visit 'http://a.test/'
    session.execute_script("window.name = 'n'; location.href = 'blob:http://a.test/gone'")
    session.evaluate_script('1')
    expect(name).to eq('')
  end

  it 'is the one its entry had, after a traversal' do
    session.visit 'http://a.test/'
    session.execute_script("window.name = 'first'")
    session.click_link 'same'
    session.execute_script("window.name = 'second'")
    session.go_back
    expect(name).to eq('first')
    session.go_forward
    expect(name).to eq('second')
  end

  it "is a window's window.open named, kept across another origin while its opener is there" do
    session.visit 'http://a.test/'
    popup = session.window_opened_by { session.execute_script("window.open('/next', 'pop')") }
    session.within_window(popup) do
      expect(name).to eq('pop')
      session.click_link 'away'
      expect(name).to eq('pop')
    end
  end

  # (…found by a window of its browsing context group alone: a `noopener` one's naming the page's opens one of its own —
  # HTML "find a navigable by target name", Chrome and Firefox measured)
  it "is found by none of another browsing context group's windows" do
    session.visit 'http://a.test/'
    session.execute_script("window.name = 'prim'")
    popup = session.window_opened_by { session.execute_script("window.open('/next', '', 'noopener')") }
    session.within_window(popup) { session.execute_script("window.open('/hijack', 'prim')") }
    expect(session).to have_text('a.test/')
    expect(session).to have_no_text('hijack')
    expect(session.windows.size).to eq(3)
  end

  # (…and in it, by a window familiar with it alone: a cross-origin pop-up's naming the page's opens one of its own —
  # HTML "find a navigable by target name"; Firefox measured a new window)
  it 'is found by none of its group a window is not familiar with' do
    session.visit 'http://a.test/'
    session.execute_script("window.name = 'prim'")
    popup = session.window_opened_by { session.execute_script("window.open('http://b.test/next', 'pop')") }
    session.within_window(popup) { session.execute_script("window.open('http://a.test/hit', 'prim')") }
    expect(session).to have_text('a.test/')
    expect(session).to have_no_text('hit')
  end

  # (…and the name a page gives its window is the one another's `window.open` finds it by, not the one it opened with)
  it 'is found by the name its page gave it' do
    session.visit 'http://a.test/'
    popup = session.window_opened_by { session.execute_script("window.open('/next', 'pop')") }
    session.within_window(popup) { session.execute_script("window.name = 'renamed'") }
    session.execute_script("window.open('/again', 'renamed')")
    session.within_window(popup) { expect(session).to have_text('a.test/again') }
    expect(session.windows.size).to eq(2)
  end
end
