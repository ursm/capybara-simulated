require_relative 'spec_helper'

RSpec.describe 'fetch routed through Rack' do
  let(:app) {
    lambda do |env|
      req = Rack::Request.new(env)
      case req.path_info
      when '/'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><body>
            <div id="out"></div>
            <script>
              window.runFetch = async function() {
                const r = await fetch('/api/echo', {
                  method: 'POST',
                  headers: {'Content-Type': 'application/json', 'X-CSRF-Token': 'tok'},
                  body: JSON.stringify({hello: 'world'})
                });
                const json = await r.json();
                document.getElementById('out').textContent =
                  r.status + ' ' + json.received + ' ' + json.csrf;
              };
            </script>
          </body></html>
        HTML
      when '/api/echo'
        body = req.body.read
        parsed = JSON.parse(body) rescue {}
        payload = {received: parsed['hello'], csrf: req.env['HTTP_X_CSRF_TOKEN']}
        [200, {'content-type' => 'application/json'}, [JSON.dump(payload)]]
      when '/redirect'
        [302, {'location' => '/api/echo', 'content-type' => 'text/plain'}, ['redirected']]
      else
        [404, {}, ['nope']]
      end
    end
  }

  let(:driver) { Capybara::Simulated::Driver.new(app) }

  it 'GETs through Rack with current cookies and content negotiation' do
    driver.visit('/')
    body = driver.evaluate_async_script(<<~JS)
      var cb = arguments[0];
      fetch('/api/echo', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{"hello":"capybara"}'})
        .then(r => r.json())
        .then(j => cb(j.received));
    JS
    expect(body).to eq('capybara')
  end

  it 'forwards request headers and parses JSON response' do
    driver.visit('/')
    driver.evaluate_async_script(<<~JS)
      var cb = arguments[0];
      window.runFetch().then(() => cb(document.getElementById('out').textContent));
    JS
    expect(driver.find_css('#out').first.all_text).to eq('200 world tok')
  end

  it 'follows 302 redirects and reports redirected/url' do
    driver.visit('/')
    result = driver.evaluate_async_script(<<~JS)
      var cb = arguments[0];
      fetch('/redirect', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{"hello":"x"}'})
        .then(r => cb([r.status, r.redirected, r.url.endsWith('/api/echo')]));
    JS
    expect(result).to eq([200, true, true])
  end
end
