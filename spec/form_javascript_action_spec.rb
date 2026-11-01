# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A form whose action is a `javascript:` URL navigates its target to it — the URL's script run in that document, no
# request made of it (HTML "submit": "navigate to a javascript: URL") — and one whose action is a `data:` URL navigates
# the page to none: the top-level browsing context refuses a document's navigation to one, as its `location`'s.
RSpec.describe 'a form submitted to a javascript: or a data: URL' do
  include PollUntil

  let(:hits) { [] }
  let(:session) do
    seen = hits
    simulated_session(lambda {|env|
      seen << "#{env['REQUEST_METHOD']} #{env['PATH_INFO']}"
      body = case env['PATH_INFO']
             when '/'
               %(<form action="javascript:void(document.title='ran')"><button>go</button></form>) +
                 '<form action="data:text/html,x" method=post><button>to</button></form>' +
                 %(<form action="javascript:void(document.title='popped')" target=_blank><button>pop js</button></form>) +
                 '<form action="data:text/html,x" target=_blank><button>pop data</button></form>'
             when '/frame'
               '<iframe name=f src=/inner></iframe>' +
                 %(<form action="javascript:void(document.title='in frame')" target=f><button>go</button></form>)
             else '<p>inner</p>'
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><title>start</title><body>#{body}"]]
    })
  end

  it "runs a javascript: action's script in the page, making no request of it" do
    session.visit '/'
    session.click_button 'go'
    expect([poll_until { session.title == 'ran' && session.title }, hits]).to eq(['ran', ['GET /']])
  end

  it "runs it in the frame the form's target chooses" do
    session.visit '/frame'
    session.click_button 'go'
    expect(poll_until { session.evaluate_script('frames[0].document.title') == 'in frame' && session.title }).to eq('start')
  end

  it 'opens no window for a javascript: one' do
    session.visit '/'
    session.click_button 'pop js'
    expect([session.title, session.windows.size, hits]).to eq(['start', 1, ['GET /']])
  end

  # (…a new window for a data: one, whose navigation to it the window refuses — left at its initial about:blank, as
  # Chrome 156 leaves a `target=_blank` form's, a link's and `open()`'s, measured 2026-11-01: navigation_fetch.rs `start`)
  it 'opens a window at about:blank for a data: one, requesting nothing' do
    session.visit '/'
    popup = session.window_opened_by { session.click_button 'pop data' }
    session.within_window(popup) { expect(session.current_url).to eq('about:blank') }
    expect([session.title, hits]).to eq(['start', ['GET /']])
  end

  it 'navigates the page to no data: URL' do
    session.visit '/'
    session.click_button 'to'
    expect([session.title, session.current_path, hits]).to eq(['start', '/', ['GET /']])
  end
end
