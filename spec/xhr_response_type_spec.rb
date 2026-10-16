# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# An XMLHttpRequest's response is read as the response type it has when it is read (XHR §3.6.9 "the response getter"):
# a type set while the request is still OPENED or HEADERS_RECEIVED — from an upload's handler, from the
# readystatechange of the headers — is the one `response` answers with.
RSpec.describe 'XMLHttpRequest response type' do
  include PollUntil

  def session
    s = simulated_session(->(env) {
      next [200, {'content-type' => 'text/plain'}, ['{"a":1}']] if env['PATH_INFO'] == '/d'

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']]
    })
    s.visit '/'
    s
  end

  it "answers with the type an upload's load handler set" do
    s = session
    s.execute_script(<<~JS)
      window.R = null;
      const x = new XMLHttpRequest();
      x.open('POST', '/d');
      x.upload.onload = () => { x.responseType = 'arraybuffer'; };
      x.onload = () => { R = [x.responseType, Object.prototype.toString.call(x.response), x.response.byteLength]; };
      x.send('payload');
    JS
    expect(poll_until { s.evaluate_script('R') }).to eq(['arraybuffer', '[object ArrayBuffer]', 7])
  end

  it 'answers with the type set at HEADERS_RECEIVED, and null for it until DONE' do
    s = session
    s.execute_script(<<~JS)
      window.R = [];
      const x = new XMLHttpRequest();
      x.open('GET', '/d');
      x.onreadystatechange = () => {
        if (x.readyState === 2) x.responseType = 'json';
        if (x.readyState === 3) R.push(x.response);
      };
      x.onload = () => { R.push(x.responseType, x.response); };
      x.send();
    JS
    expect(poll_until { s.evaluate_script('R.length === 3 && R') }).to eq([nil, 'json', {'a' => 1}])
  end
end
