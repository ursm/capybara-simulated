# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/https_app_host'

# A classic script's or a style sheet's `crossorigin` makes its fetch a CORS request (HTML "potentially CORS-enabled
# request"): a response of another origin that does not allow it no script or sheet — its element's `error` — where one
# without the attribute, a no-cors request, loads whatever it says — a link whose `crossorigin` changes fetched again, and
# a shadow tree's link of the one mode answered by none of the other's — and a sheet origin-clean only where its response
# is CORS-same-origin (CSSOM): its rules another origin's no-cors one hides, a SecurityError.
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
      when '/c.css' then [200, {'content-type' => 'text/css'}.merge(allow), ['p{color:rgb(1,2,3)}']]
      when '/missing.css' then [404, {'content-type' => 'text/css'}, ['']]
      when '/x.xhtml'
        pi = ->(href) { %(<?xml-stylesheet href="#{href}"?>) }
        [200, {'content-type' => 'application/xhtml+xml'}, [%(<?xml version="1.0"?>#{pi.('https://other.example.com/c.css')}#{pi.('/c.css')}<html xmlns="http://www.w3.org/1999/xhtml"/>)]]
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

  it "hides a no-cors sheet of another origin's rules" do
    session.visit '/'
    session.execute_script(<<~JS)
      for (const [id, href, cors] of [['plain', 'https://other.example.com/c.css', false], ['cors', 'https://other.example.com/c.css?allow', true],
                                       ['data', 'data:text/css,p{}', false], ['missing', '/missing.css', false]]) {
        const l = Object.assign(document.createElement('link'), {id, rel: 'stylesheet', href});
        if (cors) l.crossOrigin = 'anonymous';
        document.head.append(l);
      }
      // (…an `@import`ed one by its own response, whatever imports it)
      const style = document.head.appendChild(document.createElement('style'));
      style.textContent = '@import url(https://other.example.com/c.css); @import url(/c.css);';
      window.imported = (i) => style.sheet.cssRules[i].styleSheet;
    JS
    read = ->(sheet) { session.evaluate_script("(() => { try { return String(#{sheet}.cssRules.length); } catch (e) { return e.name; } })()") }
    links = %w[plain cors data missing].map { read.("document.getElementById('#{_1}').sheet") }
    expect(links).to eq(%w[SecurityError 1 1 0])
    expect([read.('imported(0)'), read.('imported(1)')]).to eq(%w[SecurityError 1])
  end

  it "hides an `<?xml-stylesheet?>` sheet of another origin's rules" do
    session.visit '/x.xhtml'
    sheets = session.evaluate_script(<<~JS)
      [...document.childNodes].filter((n) => n.nodeType === Node.PROCESSING_INSTRUCTION_NODE).map((pi) => {
        try { return String(pi.sheet.cssRules.length); } catch (e) { return e.name; }
      })
    JS
    expect(sheets).to eq(%w[SecurityError 1])
  end

  it 'fetches a link again as its crossorigin changes, and keys a shadow tree link by its mode' do
    session.visit '/'
    session.execute_script(<<~JS)
      window.events = [];
      window.l = Object.assign(document.createElement('link'), {rel: 'stylesheet', href: 'https://other.example.com/c.css?deny'});
      l.onload = () => events.push('load');
      l.onerror = () => events.push('error');
      document.head.append(l);
      document.body.innerHTML = '<p id=p>x</p>';
      for (const cors of [null, '']) {
        const host = document.body.appendChild(document.createElement('div'));
        const root = host.attachShadow({mode: 'open'});
        root.innerHTML = `<link rel=stylesheet ${cors == null ? '' : 'crossorigin'} href="https://other.example.com/c.css?shadow"><p>y</p>`;
      }
    JS
    expect(poll_until { session.evaluate_script('events.length') == 1 && session.evaluate_script('events') }).to eq(['load'])
    session.execute_script("l.setAttribute('crossorigin', '')")
    expect(poll_until { session.evaluate_script('events.length') == 2 && session.evaluate_script('events') }).to eq(%w[load error])
    expect(session.evaluate_script('getComputedStyle(p).color')).to eq('rgb(0, 0, 0)')
    colors = session.evaluate_script("[...document.querySelectorAll('div')].map((d) => getComputedStyle(d.shadowRoot.querySelector('p')).color)")
    expect(colors).to eq(['rgb(1, 2, 3)', 'rgb(0, 0, 0)'])
  end
end
