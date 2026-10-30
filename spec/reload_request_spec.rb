# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/https_app_host'

# A reload's request is made by the document it reloads where the page asks for it (`location.reload()`: HTML "apply
# the history step", no source snapshot given — the navigable's active document's is its fetch client), its
# Sec-Fetch-Site that document's — a GET's and a re-posted POST's alike (Chrome, measured 2026-10-30: `same-origin`) —
# and by none where the user does (the driver's `refresh`): `none`, as a visit is.
RSpec.describe 'the request a reload makes', :https do
  let(:seen) { [] }
  let(:session) {
    seen = self.seen
    simulated_session(lambda {|env|
      seen << [env['REQUEST_METHOD'], env['HTTP_SEC_FETCH_SITE']] if env['PATH_INFO'] == '/r'
      page = '<!DOCTYPE html><meta charset=utf-8><body><form action="/r" method="post"><button>go</button></form>'
      [200, {'content-type' => 'text/html'}, [page]]
    })
  }

  it "is the page's own where the page asks for it, the user's where the user does" do
    session.visit '/r'
    session.execute_script('location.reload()')
    session.evaluate_script('1')
    session.refresh
    session.click_button 'go'
    session.execute_script('location.reload()')
    session.evaluate_script('1')
    session.refresh
    expect(seen).to eq([
      %w[GET none],
      %w[GET same-origin],
      %w[GET none],
      %w[POST same-origin],
      %w[POST same-origin],
      %w[POST none]
    ])
  end
end
