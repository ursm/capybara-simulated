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
