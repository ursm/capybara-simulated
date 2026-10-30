# frozen_string_literal: true

require 'timeout'
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

  # A finite stream whose body takes a while to be let go of, as a framework's executor completing in a body proxy does.
  EventSourceSlowCloseBody = Struct.new(:closing) {
    def each = yield("data: x\n\n")

    def close
      closing << true
      sleep 0.5
    end
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
      when '/slow-close'
        [200, {'content-type' => 'text/event-stream'}, EventSourceSlowCloseBody.new(closed)]
      when '/slow'
        # (…an app's own timeout around something slow, answering 503 where it fires)
        begin
          Timeout.timeout(0.2) { sleep 1 }
          [200, {'content-type' => 'text/event-stream'}, ["data: late\n\n"]]
        rescue Timeout::Error
          [503, {'content-type' => 'text/plain'}, ['timed out']]
        end
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

  # (…the session's own cancellation deferred through the app's call, but nothing else: the app's timeout fires as it
  # would under any server, and its answer fails the source)
  it "lets the app's own timeout interrupt it" do
    session.execute_script(<<~JS)
      window.got = null;
      const es = new EventSource('/slow');
      es.onerror = () => { window.got = 'error ' + es.readyState; };
      es.onmessage = (e) => { window.got = e.data; };
    JS
    expect(poll_until { session.evaluate_script('window.got') }).to eq('error 2')
  end

  # (…the session's cancellation never raised into a reader letting go of what it holds, nor out of `reset!`)
  it 'lets reset! cancel a reader in the middle of letting go of its body' do
    session.execute_script("new EventSource('/slow-close')")
    expect(closed.pop(timeout: 10)).to be(true)
    expect { session.reset! }.not_to raise_error
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
