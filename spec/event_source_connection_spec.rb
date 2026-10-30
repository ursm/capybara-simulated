# frozen_string_literal: true

require 'socket'
require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# HTML "establish the connection" of an EventSource over the network: its request fetched as every request is (Fetch: a
# CORS GET of `text/event-stream`, the HTTP cache bypassed, its credentials as `withCredentials` says), a 200 of
# `text/event-stream` (its parameters and case aside — Fetch's "extract a MIME type", a header's bytes each a character)
# opening it, any other status or type, or a response the CORS check refuses, failing it — an `error` and no `open` — a
# redirect followed first (redirect mode "follow"), and its messages of the origin of the URL the stream came from.
RSpec.describe 'an EventSource connection' do
  # A server that answers its connections in turn with `responses` — each a status, its headers, a stream's open to any
  # origin unless they say otherwise, and its body, `data: <status>` unless it says otherwise; the request heads it read
  # kept in `heads`.
  def serve(*responses)
    server = TCPServer.new('127.0.0.1', 0)
    heads  = Queue.new
    Thread.new do
      responses.each do |status, headers, body|
        client = server.accept
        heads << client.gets("\r\n\r\n")
        headers = {'Access-Control-Allow-Origin' => '*'}.merge(headers)
        head    = ["HTTP/1.1 #{status} X", *headers.compact.map {|k, v| "#{k}: #{v}" }]
        client.write((head.join("\r\n") + "\r\n\r\n" + (body || "data: #{status}\n\n")).b)
        Thread.new(client) {|c| sleep 0.5; c.close }
      end
    rescue StandardError
      nil
    end
    [server.addr[1], heads]
  end

  # The request head's fields, by lowercased name.
  def fields(head)
    head.split("\r\n").drop(1).to_h {|line| line.split(': ', 2).then {|k, v| [k.downcase, v] } }
  end

  # What the page's source saw first — its first message's data and origin, or `error`.
  def first_event(url, with_credentials: false)
    session.execute_script(<<~JS)
      window.got = null;
      const es = new EventSource(#{url.to_json}, {withCredentials: #{with_credentials}});
      es.onmessage = (e) => { window.got ??= [e.data, e.origin]; es.close(); };
      es.onerror = () => { window.got ??= 'error'; es.close(); };
    JS
    poll_until { session.evaluate_script('window.got') }
  end

  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8>']] }) }

  before { session.visit '/' }

  {
    [200, 'text/event-stream'] => 'open',
    [200, 'Text/Event-Stream; charset=utf-8'] => 'open',
    [200, "text/event-stream; x=\"\xE9\"".b] => 'open',
    [200, 'text/plain'] => 'error',
    [200, nil] => 'error',
    [204, 'text/event-stream'] => 'error'
  }.each do |(status, type), want|
    it "takes a #{status} of #{type.inspect} as #{want}" do
      port, = serve([status, type ? {'Content-Type' => type} : {}])
      session.execute_script(<<~JS)
        window.got = null;
        const es = new EventSource('http://127.0.0.1:#{port}/');
        es.onopen = () => { window.got ??= 'open'; es.close(); };
        es.onerror = () => { window.got ??= 'error'; es.close(); };
      JS
      expect(poll_until { session.evaluate_script('window.got') }).to eq(want)
    end
  end

  it 'follows a redirect to the stream' do
    port, = serve([302, {'Location' => '/next'}], [200, {'Content-Type' => 'text/event-stream'}])
    expect(first_event("http://127.0.0.1:#{port}/")).to eq(['200', "http://127.0.0.1:#{port}"])
  end

  it 'sends a CORS request of the event stream type, past every cache, referred by the page' do
    port, heads = serve([200, {'Content-Type' => 'text/event-stream'}])
    first_event("http://127.0.0.1:#{port}/")
    page = session.evaluate_script('location.origin')
    expect(fields(heads.pop(timeout: 5).to_s)).to include(
      'accept'         => 'text/event-stream',
      'cache-control'  => 'no-cache',
      'pragma'         => 'no-cache',
      'origin'         => page,
      'referer'        => "#{page}/",
      'sec-fetch-mode' => 'cors',
      'sec-fetch-dest' => 'empty',
      'sec-fetch-site' => 'cross-site'
    )
  end

  it 'fails a stream of another origin that does not share itself' do
    port, = serve([200, {'Content-Type' => 'text/event-stream', 'Access-Control-Allow-Origin' => nil}])
    expect(first_event("http://127.0.0.1:#{port}/")).to eq('error')
  end

  it 'sends cookies to another origin only with credentials, which it must allow' do
    page    = session.evaluate_script('location.origin')
    allowed = {'Content-Type' => 'text/event-stream', 'Access-Control-Allow-Origin' => page, 'Access-Control-Allow-Credentials' => 'true'}
    port, heads = serve(
      [200, allowed.merge('Set-Cookie' => 'k=v; SameSite=None; Secure')],
      [200, {'Content-Type' => 'text/event-stream'}],
      [200, allowed],
      [200, {'Content-Type' => 'text/event-stream'}]
    )
    url = "http://127.0.0.1:#{port}/"
    expect(first_event(url, with_credentials: true)).to eq(['200', "http://127.0.0.1:#{port}"])
    expect(first_event(url)).to eq(['200', "http://127.0.0.1:#{port}"])
    expect(first_event(url, with_credentials: true)).to eq(['200', "http://127.0.0.1:#{port}"])
    # (…a credentialed response must name the origin it shares itself with: `*` refuses it)
    expect(first_event(url, with_credentials: true)).to eq('error')
    cookies = Array.new(4) { fields(heads.pop(timeout: 5).to_s)['cookie'] }
    expect(cookies).to eq([nil, nil, 'k=v', 'k=v'])
  end

  # (…a reconnection's `Last-Event-ID` is the user agent's, and sent to another origin with no CORS-preflight, where a
  # page's fetch() of the same header asks one — fetch_plan.rs `ua_headers`)
  it 'reconnects to another origin with its last event ID, asking no preflight' do
    stream = {'Content-Type' => 'text/event-stream'}
    port, heads = serve([200, stream, "id: 7\nretry: 10\ndata: a\n\n"], [200, stream, "data: b\n\n"])
    session.execute_script(<<~JS)
      window.got = [];
      const es = new EventSource('http://127.0.0.1:#{port}/');
      es.onmessage = (e) => { got.push(e.data); if (e.data === 'b') es.close(); };
    JS
    expect(poll_until { session.evaluate_script('window.got.length') == 2 }).to be(true)
    second = heads.pop(timeout: 5) && heads.pop(timeout: 5)
    expect(second).to start_with('GET ')
    expect(fields(second.to_s)).to include('last-event-id' => '7')
  end

  it "asks a preflight for a page's fetch() of the same header" do
    port, heads = serve([204, {'Access-Control-Allow-Headers' => 'last-event-id'}], [200, {}])
    session.execute_script("fetch('http://127.0.0.1:#{port}/', {headers: {'Last-Event-ID': '7'}}).catch(() => {})")
    # (…the page's event loop stepped while the request goes out)
    expect(poll_until { session.evaluate_script('1') && !heads.empty? }).to be(true)
    expect(heads.pop.to_s).to start_with('OPTIONS ')
  end

  it 'gives its messages the origin of the URL a redirect led to' do
    to, = serve([200, {'Content-Type' => 'text/event-stream'}])
    from, = serve([302, {'Location' => "http://localhost:#{to}/"}])
    expect(first_event("http://127.0.0.1:#{from}/")).to eq(['200', "http://localhost:#{to}"])
  end
end
