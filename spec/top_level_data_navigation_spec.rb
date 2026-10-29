# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A document's navigation of the top-level browsing context to a `data:` URL is refused — a link's, a form's,
# `location`'s, `open(url, '_self')`'s, the page's own or a frame's `_top` (Chrome, measured 2026-10-30) — the page
# staying where it is.
RSpec.describe 'a top-level navigation to a data: URL' do
  let(:target) { 'data:text/html,<title>landed</title>' }
  let(:session) do
    data = target
    simulated_session(lambda {|env|
      body = case env['PATH_INFO']
             when '/' then %(<a id=link href="#{data}">link</a><iframe src=/frame></iframe>)
             else %(<a id=top href="#{data}" target=_top>top</a>)
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><title>start</title><body>#{body}"]]
    })
  end

  it 'opens a new window at about:blank for open(data:)' do
    session.visit '/'
    session.execute_script("window.popup = open('#{target}')")
    expect([session.evaluate_script('popup.location.href'), session.title]).to eq(['about:blank', 'start'])
  end

  {
    'a link'              => "document.getElementById('link').click()",
    'location'            => "location.href = 'TARGET'",
    "open(url, '_self')"  => "open('TARGET', '_self')",
    "a frame's _top link" => "frames[0].document.getElementById('top').click()"
  }.each do |what, script|
    it "refuses #{what}'s" do
      session.visit '/'
      session.execute_script(script.sub('TARGET', target))
      session.evaluate_script('1')
      expect([session.title, session.current_path]).to eq(['start', '/'])
    end
  end
end
