# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# An EventSource to the app under test is answered by the app itself, in process, as every request to it is — its body
# read as the app writes it (an `ActionController::Live` stream's shape: an `each` that yields as events come), not once
# it is done — and a worker's stream is the worker's: its events delivered into the worker, closed when the worker ends.
# A stream that ends reconnects (HTML "reestablish the connection"): an `error` with the source connecting, then, its
# reconnection time on, the request again with the last event ID its stream left (`Last-Event-ID`).
RSpec.describe 'an EventSource to the app' do
  # A body that yields `data: one`, then waits until it is released, then yields `data: two`; whether it was closed.
  EventSourceLocalAppBody = Struct.new(:release, :closed) {
    def each
      yield "data: one\n\n"
      release.pop
      yield "data: two\n\n"
    end

    def close = closed << true
  }

  let(:release) { Queue.new }
  let(:closed) { Queue.new }

  let(:session) {
    simulated_session(lambda {|env|
      case env['PATH_INFO']
      when '/stream'
        [200, {'content-type' => 'text/event-stream'}, EventSourceLocalAppBody.new(release, closed)]
      when '/again'
        # (…the first connection's stream: an id, a retry, a message; the reconnection's, what it was asked with)
        sent = env['HTTP_LAST_EVENT_ID']
        body = sent ? "data: b #{sent}\n\n" : "id: 7\nretry: 50\ndata: a\n\n"
        [200, {'content-type' => 'text/event-stream'}, [body]]
      when '/w.js'
        [200, {'content-type' => 'text/javascript'}, [<<~JS]]
          const es = new EventSource('/stream');
          es.onmessage = (e) => postMessage(e.data + ' ' + e.origin);
        JS
      else
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8>']]
      end
    })
  }

  before { session.visit '/' }

  it 'reads the stream as the app writes it' do
    session.execute_script(<<~JS)
      window.got = [];
      window.es = new EventSource('/stream');
      es.onmessage = (e) => got.push(e.data);
    JS
    expect(poll_until { session.evaluate_script('window.got.length') == 1 }).to be(true)
    expect(session.evaluate_script('window.got')).to eq(['one'])
    release << true
    expect(poll_until { session.evaluate_script('window.got.length') == 2 }).to be(true)
    expect(session.evaluate_script('window.got')).to eq(%w[one two])
  end

  it 'reconnects once its stream ends, asking with the last event ID it left' do
    session.execute_script(<<~JS)
      window.got = [];
      const es = new EventSource('/again');
      es.onerror = () => got.push('error ' + es.readyState);
      es.onmessage = (e) => { got.push(e.data + ' ' + e.lastEventId); if (got.length === 3) es.close(); };
    JS
    expect(poll_until { session.evaluate_script('window.got.length') == 3 }).to be(true)
    expect(session.evaluate_script('window.got')).to eq(['a 7', 'error 0', 'b 7 7'])
  end

  it "delivers a worker's events into the worker, and closes its stream as the worker ends" do
    session.execute_script(<<~JS)
      window.got = [];
      window.w = new Worker('/w.js');
      w.onmessage = (e) => got.push(e.data);
    JS
    expect(poll_until { session.evaluate_script('window.got.length') == 1 }).to be(true)
    expect(session.evaluate_script('window.got')).to eq(["one #{session.evaluate_script('location.origin')}"])
    session.execute_script('w.terminate()')
    expect(closed.pop(timeout: 10)).to be(true)
  end
end
