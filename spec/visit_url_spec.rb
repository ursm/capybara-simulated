# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The URL a `visit` names is parsed as the page parses a URL (the URL Standard's parser, url_ops.rs): each position
# percent-encodes what its own set says. An RFC 3986 escape had encoded a `|` in a query, which the URL Standard
# keeps — `?include=(Document|Window)` reached the page as `(Document%7CWindow)`, and WPT's subset-by-key variants
# selected nothing. Each expectation is what Chrome (154.0.8037.92) navigates to for the same input.
RSpec.describe 'visit' do
  let(:seen) { [] }
  let(:session) {
    simulated_session(lambda {|env|
      seen << "#{env['PATH_INFO']}?#{env['QUERY_STRING']}"
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']]
    })
  }

  it 'requests the URL the URL Standard parses its argument to' do
    session.visit '/a b/x?include=(Document|Window)&q={1}^`#f g'
    expect(session.evaluate_script('[location.pathname, location.search, location.hash]')).to eq(['/a%20b/x', '?include=(Document|Window)&q={1}^`', '#f%20g'])
  end

  it 'hands the app the query as parsed' do
    session.visit '/x?include=(Document|Window)'
    expect(seen.last).to eq('/x?include=(Document|Window)')
  end

  # (…and what the URL Standard keeps, Ruby's URI refuses: the request is built from a URI-legal copy, and the app
  # handed the target as the URL has it — a `visit` of these had raised URI::InvalidURIError)
  it "requests a URL Ruby's URI would refuse, and the app sees its target as it is" do
    session.visit '/x.html#a^b{c}|d'
    session.visit '/dom/a|b?q={1}`'
    expect(seen).to eq(['/x.html?', '/dom/a|b?q={1}`'])
    expect([session.current_url, session.current_path]).to eq(['http://www.example.com/dom/a|b?q={1}`', '/dom/a|b'])
  end

  it "resolves a page's navigation the same way" do
    session.visit '/start'
    session.execute_script("location.href = '/dom/c|d.html'")
    session.execute_script("location.href = 'rel x.html'")
    expect(seen.last(2)).to eq(['/dom/c|d.html?', '/dom/rel%20x.html?'])
    expect(session.current_url).to eq('http://www.example.com/dom/rel%20x.html')
  end

  # (…and a page at such a URL is same-origin with its own requests: an origin read with Ruby's URI had been none,
  # so a same-origin fetch failed CORS, a link's Sec-Fetch-Site was `none`, and an action-less GET form raised)
  context "at a URL Ruby's URI refuses" do
    let(:requests) { [] }
    let(:session) {
      simulated_session(lambda {|env|
        requests << [env['PATH_INFO'], env['QUERY_STRING'], env['HTTP_SEC_FETCH_SITE'], env['HTTP_REFERER']]
        data = env['PATH_INFO'] == '/data'
        page = '<!DOCTYPE html><meta charset=utf-8><body><a href="/next">next</a><form><input name=q value="v"><button>go</button></form>'
        [200, {'content-type' => data ? 'text/plain' : 'text/html'}, [data ? 'DATA' : page]]
      })
    }

    it 'fetches from its own origin, sending a referrer with no fragment' do
      session.visit '/a|b#tab{1}'
      session.execute_script("fetch('/data').then((r) => r.text()).then((t) => { window.got = t; })")
      expect(session).to have_css('body')
      expect(session.evaluate_async_script('const done = arguments[0]; (function poll() { window.got ? done(window.got) : setTimeout(poll, 10); })()')).to eq('DATA')
      expect(requests.last).to eq(['/data', '', 'same-origin', 'http://www.example.com/a|b'])
    end

    it 'follows a link and submits an action-less form as same-origin' do
      session.visit '/a|b#tab{1}'
      session.click_link 'next'
      expect(requests.last).to eq(['/next', '', 'same-origin', 'http://www.example.com/a|b'])
      session.visit '/a|b'
      session.click_button 'go'
      expect(requests.last.first(3)).to eq(['/a|b', 'q=v', 'same-origin'])
    end
  end

  # (…and a document of a local scheme sends none: Referrer Policy's "strip url for use as a referrer" step 1 —
  # `about:blank` had gone out as `about://blank`)
  it 'sends no referrer from a document of a local scheme' do
    referrers = []
    session = simulated_session(lambda {|env|
      referrers << env.fetch('HTTP_REFERER', :none)
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']]
    })
    session.visit '/start'
    session.switch_to_window(session.open_new_window)
    session.execute_script("location.href = 'http://www.example.com/next'")
    expect(session).to have_css('body')
    expect(referrers.last).to eq(:none)
  end

  it 'encodes what is not ASCII as UTF-8, and resolves dot segments' do
    session.visit '/x/../ü?é'
    expect(session.evaluate_script('location.pathname + location.search')).to eq('/%C3%BC?%C3%A9')
  end
end
