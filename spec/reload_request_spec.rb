# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/https_app_host'
require_relative 'support/every_host_local'

# A reload's request is made by the document it reloads where the page asks for it (`location.reload()`: HTML "apply
# the history step", no source snapshot given — the navigable's active document's is its fetch client), its
# Sec-Fetch-Site and a re-post's Origin that document's — a GET's and a re-posted POST's alike, a page another site's
# form led to too, one of an opaque origin cross-site (Chrome, measured 2026-10-30) — and by none where the user does
# (the driver's `refresh`): `none`, as a visit is, a re-post's Origin the one it was first sent with.
RSpec.describe 'the request a reload makes', :https do
  let(:seen) { [] }
  let(:session) {
    seen = self.seen
    every_host_local {
      simulated_session(lambda {|env|
        req = Rack::Request.new(env)
        seen << [req.request_method, req.path, env['HTTP_SEC_FETCH_SITE'], env['HTTP_ORIGIN']] unless req.path == '/form'
        headers = {'content-type' => 'text/html'}
        headers['content-security-policy'] = 'sandbox allow-scripts' if req.path == '/boxed'
        page = '<!DOCTYPE html><meta charset=utf-8><body><form action="https://www.example.com/r" method="post"><button>go</button></form>'
        [200, headers, [page]]
      })
    }
  }

  def reload_by_page
    session.execute_script('location.reload()')
    session.evaluate_script('1')
  end

  it "is the page's own where the page asks for it, the user's where the user does" do
    session.visit '/r'
    reload_by_page
    session.refresh
    session.click_button 'go'
    reload_by_page
    session.refresh
    expect(seen).to eq([
      ['GET', '/r', 'none', nil],
      ['GET', '/r', 'same-origin', nil],
      ['GET', '/r', 'none', nil],
      ['POST', '/r', 'same-origin', 'https://www.example.com'],
      ['POST', '/r', 'same-origin', 'https://www.example.com'],
      ['POST', '/r', 'none', 'https://www.example.com']
    ])
  end

  it "is the page's own after another site's form led to it" do
    session.visit 'https://other.test/form'
    session.click_button 'go'
    reload_by_page
    session.refresh
    expect(seen).to eq([
      ['POST', '/r', 'cross-site', 'https://other.test'],
      ['POST', '/r', 'same-origin', 'https://www.example.com'],
      ['POST', '/r', 'none', 'https://other.test']
    ])
  end

  # (…a sandboxed page's of no site at all, as each of its navigations is)
  it 'is cross-site where the page is of an opaque origin' do
    session.visit '/boxed'
    reload_by_page
    session.execute_script("location.href = '/next'")
    session.evaluate_script('1')
    expect(seen).to eq([
      ['GET', '/boxed', 'none', nil],
      ['GET', '/boxed', 'cross-site', nil],
      ['GET', '/next', 'cross-site', nil]
    ])
  end
end
