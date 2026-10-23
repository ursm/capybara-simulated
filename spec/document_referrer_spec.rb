# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A document's referrer is the Referer its navigation's request sent (HTML §3.1.2 `document.referrer`): the document
# that navigated to it under its referrer policy — a frame's as the page's, a POST's as a GET's — and the empty string
# for a document no navigation that sent one made.
RSpec.describe 'document.referrer' do
  let(:session) do
    simulated_session(lambda {|env|
      body = case env['PATH_INFO']
             when '/top' then '<iframe src="/f"></iframe><a id=l target=n href="/g">l</a><iframe name=n src="/h"></iframe>' \
                              '<form id=p method=post action="/posted"></form>'
             else env['PATH_INFO']
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
  end

  it "is a frame's navigation's" do
    session.visit '/top'
    expect(session.evaluate_script('[frames[0].document.referrer, frames[1].document.referrer]')).to eq(%w[http://www.example.com/top http://www.example.com/top])
    session.execute_script('frames[0].location = "/f2"')
    expect(session.evaluate_script('frames[0].document.referrer')).to eq('http://www.example.com/f')
    session.execute_script('l.click()')
    expect(session.evaluate_script('frames[1].location.pathname')).to eq('/g')
    expect(session.evaluate_script('frames[1].document.referrer')).to eq('http://www.example.com/top')
  end

  it "is a POST navigation's" do
    session.visit '/top'
    session.execute_script('p.submit()')
    expect(session).to have_current_path('/posted')
    expect(session.evaluate_script('document.referrer')).to eq('http://www.example.com/top')
  end

  it 'is none for a visit' do
    session.visit '/top'
    expect(session.evaluate_script('document.referrer')).to eq('')
  end
end
