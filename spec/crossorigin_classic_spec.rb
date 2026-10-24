# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/https_app_host'

# A classic script's or a style sheet's `crossorigin` makes its fetch a CORS request (HTML "potentially CORS-enabled
# request"): a response of another origin that does not allow it no script or sheet — its element's `error` — where one
# without the attribute, a no-cors request, loads whatever it says.
RSpec.describe 'a crossorigin classic script or style sheet', :https do
  include PollUntil

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # the other origin served in-process
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  let(:modes) { {} }
  let(:session) do
    simulated_session(lambda {|env|
      modes[env['PATH_INFO']] = env['HTTP_SEC_FETCH_MODE']
      allow = env['QUERY_STRING'] == 'allow' ? {'access-control-allow-origin' => '*'} : {}
      case env['PATH_INFO']
      when '/s.js' then [200, {'content-type' => 'text/javascript'}.merge(allow), ['']]
      when '/c.css' then [200, {'content-type' => 'text/css'}.merge(allow), ['p{}']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8>']]
      end
    })
  end

  it 'is fetched as a CORS request only where it says so' do
    session.visit '/'
    session.execute_script(<<~JS)
      window.events = [];
      const o = 'https://other.example.com';
      for (const [tag, attr, url, cors] of [['script', 'src', `${o}/s.js`, ''], ['script', 'src', `${o}/s.js?allow`, 'anonymous'],
                                             ['script', 'src', `${o}/s.js?deny`, 'anonymous'], ['link', 'href', `${o}/c.css?deny`, 'anonymous'],
                                             ['link', 'href', `${o}/c.css?allow`, 'anonymous']]) {
        const el = document.createElement(tag);
        if (tag === 'link') el.rel = 'stylesheet';
        if (cors) el.crossOrigin = cors;
        el.onload = () => events.push(`load ${url.split('/').pop()}`);
        el.onerror = () => events.push(`error ${url.split('/').pop()}`);
        el[attr] = url;
        document.head.append(el);
      }
    JS
    expect(poll_until { session.evaluate_script('events.length') == 5 && session.evaluate_script('events.sort()') }).to eq(
      ['error c.css?deny', 'error s.js?deny', 'load c.css?allow', 'load s.js', 'load s.js?allow']
    )
  end
end
