# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A Rack 3 app may give a header as an Array of its fields; the driver's own reads of a response's headers — CORS's,
# a preflight's, a download's, the response's type — take them combined with ", " as a browser builds the header list
# (Browser#header_text), where they had read the Array's `inspect`.
RSpec.describe 'a response header given as an Array' do
  it 'is read as its fields combined, by CORS and a preflight' do
    app = lambda {|env|
      cors = {'access-control-allow-origin' => ['*'], 'access-control-allow-headers' => ['x-a', 'x-b'], 'access-control-allow-methods' => ['PUT']}
      case env['PATH_INFO']
      when '/data' then [200, {'content-type' => ['text/plain']}.merge(cors), ['cross']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = null;
      fetch('http://other.example.com/data', { method: 'PUT', headers: { 'x-b': '1' } })
        .then((r) => r.text(), (e) => e.name).then((t) => { window.got = t; });
    JS
    expect(poll_until { s.evaluate_script('window.got') }).to eq('cross')
  end
end
