# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The CORS-preflight cache (Fetch §4.9, cors.rs): a credentialed request's grant serves an uncredentialed request after
# it, not the other way round; a preflight that fails lets every entry of its origin and URL go ("clear cache entries");
# and a response's Access-Control-Expose-Headers that names a non-token exposes none of its names.
RSpec.describe 'the CORS-preflight cache' do
  def cors_session(options)
    app = lambda {|env|
      origin = env['HTTP_ORIGIN'].to_s
      grant  = {
        'access-control-allow-origin'      => origin,
        'access-control-allow-credentials' => 'true'
      }

      case [env['REQUEST_METHOD'], env['PATH_INFO']]
      in ['OPTIONS', '/data']
        options << env['HTTP_ACCESS_CONTROL_REQUEST_METHOD']
        next [500, {}, ['']] if env['HTTP_ACCESS_CONTROL_REQUEST_METHOD'] == 'DELETE'

        [200, grant.merge('access-control-allow-methods' => env['HTTP_ACCESS_CONTROL_REQUEST_METHOD'], 'access-control-max-age' => '600'), ['']]
      in [_, '/data']
        [200, grant.merge('content-type' => 'text/plain', 'x-shown' => '1', 'access-control-expose-headers' => 'x-shown, a b'), ['ok']]
      else
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']]
      end
    }
    simulated_session(app).tap {|s| s.visit '/' }
  end

  def send_js(method, credentialed)
    <<~JS
      (() => {
        const x = new XMLHttpRequest();
        x.open(#{method.to_json}, 'http://other.example.com/data', false);
        x.withCredentials = #{credentialed};
        try { x.send(); return x.status + ' ' + x.getResponseHeader('x-shown'); } catch (e) { return e.name; }
      })()
    JS
  end

  it "serves an uncredentialed request with a credentialed one's grant, not the other way round" do
    options = []
    s       = cors_session(options)
    expect(s.evaluate_script(send_js('PUT', true))).to eq('200 null')
    expect(s.evaluate_script(send_js('PUT', false))).to eq('200 null')
    expect(options).to eq(%w[PUT])
    expect(s.evaluate_script(send_js('PATCH', false))).to eq('200 null')
    expect(s.evaluate_script(send_js('PATCH', true))).to eq('200 null')
    expect(options).to eq(%w[PUT PATCH PATCH])
  end

  it "lets a URL's entries go when a preflight to it fails" do
    options = []
    s       = cors_session(options)
    expect(s.evaluate_script(send_js('PUT', false))).to eq('200 null')
    expect(s.evaluate_script(send_js('DELETE', false))).to eq('NetworkError')
    expect(s.evaluate_script(send_js('PUT', false))).to eq('200 null')
    expect(options).to eq(%w[PUT DELETE PUT])
  end
end
