# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A Rack response is read as an HTTP/1.1 client reads one off the wire (RFC 9112 §6.3, Browser#framed_response): its
# body as long as its Content-Length says — what is past it dropped, what falls short of it a body that fails as it is
# read — and Content-Length values that differ a network error. Chrome and Firefox measured: a fetch's `text()` of a
# cut-short body rejects, a synchronous XHR of either throws NetworkError, a navigation to differing values fails (an
# error page), and one to a cut-short body renders what came (Firefox; Chrome commits an empty document).
RSpec.describe 'a response framed by its Content-Length' do
  def framing_app
    lambda {|env|
      case env['PATH_INFO']
      when '/long'    then [200, {'content-type' => 'text/plain', 'content-length' => '4'}, ['four and more']]
      when '/short'   then [200, {'content-type' => 'text/plain', 'content-length' => '50'}, ['cut short']]
      when '/differ'  then [200, {'content-type' => 'text/plain', 'content-length' => ['5', '6']}, ['hello!']]
      when '/same'    then [200, {'content-type' => 'text/plain', 'content-length' => '3, 3'}, ['abc']]
      when '/ignored' then [200, {'content-type' => 'text/plain', 'content-length' => 'abc'}, ['read whole']]
      when '/head'    then [200, {'content-type' => 'text/plain', 'content-length' => '20'}, []]
      when '/page'    then [200, {'content-type' => 'text/html', 'content-length' => '2'}, ['<p>cut</p>']]
      when '/bad-page' then [200, {'content-type' => 'text/html', 'content-length' => ['5', '6']}, ['<p>no</p>']]
      when '/short-page' then [200, {'content-type' => 'text/html', 'content-length' => '500'}, ['<p id=got>came</p>']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><a href="/bad-page">bad</a>']]
      end
    }
  end

  it 'reads a fetch as far as its length, and a body cut short as one that fails' do
    s = simulated_session(framing_app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = null;
      const read = (url, init) => fetch(url, init).then(
        (r) => r.text().then((t) => r.status + ' ' + JSON.stringify(t), (e) => r.status + ' text: ' + e.name),
        (e) => 'fetch: ' + e.name);
      Promise.all(['/long', '/short', '/differ', '/same', '/ignored'].map((u) => read(u)).concat(read('/head', { method: 'HEAD' })))
        .then((all) => { window.got = all; });
    JS
    expect(poll_until { s.evaluate_script('window.got') }).to eq([
      '200 "four"',
      '200 text: TypeError',
      'fetch: TypeError',
      '200 "abc"',
      '200 "read whole"',
      '200 ""'
    ])
  end

  it 'fails an XHR whose body is cut short after its headers came, and one whose lengths differ at once' do
    s = simulated_session(framing_app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = null;
      const events = (url) => new Promise((done) => {
        const x = new XMLHttpRequest(), seen = [];
        x.onreadystatechange = () => seen.push('rs' + x.readyState + ':' + x.status);
        for (const type of ['progress', 'load', 'error']) x.addEventListener(type, () => seen.push(type));
        x.onloadend = () => { seen.push('loadend'); done(seen.join(' ')); };
        x.open('GET', url);
        seen.length = 0;
        x.send();
      });
      const sync = (url) => { const x = new XMLHttpRequest(); x.open('GET', url, false); try { x.send(); return x.status + ' ' + x.responseText; } catch (e) { return e.name; } };
      Promise.all([events('/short'), events('/differ')]).then((async) => {
        window.got = async.concat([sync('/short'), sync('/differ'), sync('/long')]);
      });
    JS
    expect(poll_until { s.evaluate_script('window.got') }).to eq([
      'rs2:200 rs3:200 progress rs4:0 error loadend',
      'rs4:0 error loadend',
      'NetworkError',
      'NetworkError',
      '200 four'
    ])
  end

  it 'fails a navigation whose lengths differ, and renders what came of one cut short' do
    s = simulated_session(framing_app)
    s.visit '/page'
    expect(s.html).to include('<body></body>')   # `<p` and the end of the file: no tag
    s.visit '/short-page'
    expect(s).to have_css('#got', text: 'came')
    s.visit '/'
    s.click_link 'bad'
    expect(s.current_url).to end_with('/bad-page')
    expect(s.status_code).to eq(0)
    expect(s).to have_no_text('no')
  end
end
