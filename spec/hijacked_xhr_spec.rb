# frozen_string_literal: true

require 'capybara/simulated'
require 'json'
require_relative 'support/session_teardown'

# An async XHR's Rack call is offered `rack.hijack`, as a server offers every request one (Browser#rack_fetch_async):
# middleware that takes it answers later from its own thread, and the response arrives as any other would — to the
# realm whose XHR made it, a frame's too; its Set-Cookie stored, its body bytes as they were (a chunked one's chunks
# joined). A worker's XHR is offered none and is answered at once.
RSpec.describe 'a hijacked XHR' do
  HIJACKED_XHR_PAGE = <<~HTML
    <!DOCTYPE html><meta charset=utf-8><body>
    <script>
      window.__got = [];
      const send = (XHR, name) => {
        const x = new XHR();
        x.open('GET', '/poll');
        x.responseType = 'arraybuffer';
        x.onload = () => __got.push(name + ':' + x.status + ':' + Array.from(new Uint8Array(x.response)).join(','));
        x.onerror = () => __got.push(name + ':error');
        x.send();
      };
      send(XMLHttpRequest, 'main');
      const f = document.createElement('iframe');
      f.src = '/frame';
      f.onload = () => send(f.contentWindow.XMLHttpRequest, 'frame');
      document.body.append(f);
      const w = new Worker('/worker.js');
      w.onmessage = (e) => __got.push(e.data);
    </script>
  HTML

  HIJACKED_XHR_WORKER = <<~JS
    const x = new XMLHttpRequest();
    x.open('GET', '/poll');
    x.responseType = 'arraybuffer';
    x.onload = () => postMessage('worker:' + x.status + ':' + Array.from(new Uint8Array(x.response)).join(','));
    x.onerror = () => postMessage('worker:error');
    x.send();
  JS

  let(:app) {
    lambda {|env|
      case env['PATH_INFO']
      when '/' then [200, {'content-type' => 'text/html'}, [HIJACKED_XHR_PAGE]]
      when '/frame' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><p>frame']]
      when '/worker.js' then [200, {'content-type' => 'text/javascript'}, [HIJACKED_XHR_WORKER]]
      when '/poll'
        bytes = [0, 255, 128].pack('C*')
        next [200, {'content-type' => 'application/octet-stream'}, [bytes]] unless env['rack.hijack?']
        io = env['rack.hijack'].call
        Thread.new do
          sleep 0.05
          io.write("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nSet-Cookie: held=1; Path=/\r\n" \
                   "Transfer-Encoding: chunked\r\n\r\n1\r\n#{bytes[0]}\r\n2\r\n#{bytes[1, 2]}\r\n0\r\n\r\n")
          io.close
        end
        [-1, {}, []]
      end
    }
  }

  it 'reaches the realm that sent it, its cookie stored and its bytes kept' do
    session = simulated_session(app).tap {|s| s.visit '/' }
    session.assert_selector(:css, 'body', wait: 5)
    got = nil
    5.times do
      got = session.evaluate_script('__got.slice().sort()')
      break if got.size == 3
      sleep 0.2
    end
    expect(got).to eq(['frame:200:0,255,128', 'main:200:0,255,128', 'worker:200:0,255,128'])
    expect(session.evaluate_script('document.cookie')).to include('held=1')
  end
end
