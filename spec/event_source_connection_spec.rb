# frozen_string_literal: true

require 'socket'
require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# HTML "establish the connection" of an EventSource over the network: a 200 of `text/event-stream` (its parameters and
# case aside — Fetch's "extract a MIME type") opens it, any other status or type fails it, an `error` and no `open`.
RSpec.describe 'an EventSource connection' do
  def serve(status, content_type)
    server = TCPServer.new('127.0.0.1', 0)
    Thread.new do
      client = server.accept
      client.gets("\r\n\r\n")
      head = ["HTTP/1.1 #{status} X"]
      head << "Content-Type: #{content_type}" if content_type
      client.write(head.join("\r\n") + "\r\n\r\ndata: hi\n\n")
      sleep 0.5
      client.close
    rescue StandardError
      nil
    end
    server.addr[1]
  end

  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8>']] }) }

  before { session.visit '/' }

  {
    [200, 'text/event-stream'] => 'open',
    [200, 'Text/Event-Stream; charset=utf-8'] => 'open',
    [200, 'text/plain'] => 'error',
    [200, nil] => 'error',
    [204, 'text/event-stream'] => 'error'
  }.each do |(status, type), want|
    it "takes a #{status} of #{type.inspect} as #{want}" do
      port = serve(status, type)
      session.execute_script(<<~JS)
        window.got = null;
        const es = new EventSource('http://127.0.0.1:#{port}/');
        es.onopen = () => { window.got ??= 'open'; es.close(); };
        es.onerror = () => { window.got ??= 'error'; es.close(); };
      JS
      expect(poll_until { session.evaluate_script('window.got') }).to eq(want)
    end
  end
end
