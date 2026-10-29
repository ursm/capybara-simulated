# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The page's navigation as the app sees it, hop by hop (HTML "create navigation params by fetching", Fetch
# "HTTP-network fetch"): a GET's request carries no body's length, a POST's — an empty one's `0` — does; a redirect a
# Rack status String answers with is one; a POST to a URL no HTTP(S) one is a network error, an about:blank one an empty
# document, each of them an entry of the session history.
RSpec.describe 'the page navigation request' do
  let(:seen) { [] }
  let(:session) do
    seen = self.seen
    simulated_session(lambda {|env|
      seen << [env['REQUEST_METHOD'], env['PATH_INFO'], env['CONTENT_LENGTH']]
      next ['302', {'location' => '/final'}, []] if env['PATH_INFO'] == '/r'

      body = case env['PATH_INFO']
             when '/top' then '<form id=g action="/r"></form><form id=p method=post action="/r"></form>' \
                              '<form id=b method=post action="blob:http://www.example.com/x"></form>'
             else env['PATH_INFO']
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
  end

  it "sends a GET's request with no length, an empty POST's with `0`, and follows a String status's redirect" do
    session.visit '/top'
    session.execute_script('g.submit()')
    expect(session).to have_current_path('/final')
    session.visit '/top'
    session.execute_script('p.submit()')
    expect(session).to have_current_path('/final')

    expect(seen).to eq([['GET', '/top', nil], ['GET', '/r', nil], ['GET', '/final', nil], ['GET', '/top', nil], ['POST', '/r', '0'], ['GET', '/final', nil]])
  end

  it 'commits an error document for a POST to a blob: URL' do
    session.visit '/top'
    session.execute_script('b.submit()')
    expect(session).to have_current_path('blob:http://www.example.com/x', url: true)
    expect(session.evaluate_script('document.body?.textContent || ""')).to eq('')
  end

  it 'adds an entry of the session history for about:blank' do
    session.visit '/one'
    session.visit '/top'
    session.execute_script("location = 'about:blank'")
    expect(session).to have_current_path('about:blank', url: true)
    expect(session.evaluate_script('history.length')).to eq(3)
    session.go_back
    expect(session).to have_current_path('/top')
  end

  # …but none for a window's initial about:blank, which the navigation after it replaces.
  it "replaces a window's initial about:blank" do
    session.visit 'about:blank'
    session.visit '/a'
    expect(session.evaluate_script('history.length')).to eq(1)
    window = session.open_new_window
    session.within_window(window) do
      session.visit '/x'
      expect(session.evaluate_script('history.length')).to eq(1)
    end
  end
end
