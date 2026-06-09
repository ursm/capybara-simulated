require_relative 'spec_helper'
require 'json'

# Regression test for the find-tick delivery gate (`find_with_timer_fallback`):
# a message delivered to an ESTABLISHED held long-poll must be reflected by
# Capybara's find-polling. Uses a minimal `rack.hijack` long-poll bus (no
# Discourse / message_bus dependency) mirroring MessageBus's load-bearing
# behaviours:
#
#   * many channels batched into ONE poll connection,
#   * a brand-new channel (lastId -1) is caught up via a `/__status` reset,
#     a channel already at a real id replays its backlog,
#   * a publish from another session writes to the held connections.
#
# The bug fixed: once the subscriber's poll is HELD at a real position (no
# pending JS timer → `@timers_active` is false), a cross-session publish lands
# on the held connection and is processed by the client, but the find-polling
# loop never re-ticked — so the DOM mutation it caused was invisible to
# `find` (only `evaluate_script`, which ticks unconditionally, saw it). The
# gate now also re-ticks when `async_io_pending?` (a Worker / EventSource /
# held long-poll has unsettled traffic).
#
# NOTE: this drives the subscription to its held steady state with the test's
# OWN polling (`assert_selector('body.caught-up')`) — the in-process lazy
# virtual clock doesn't establish a background poll on its own the way a real
# browser does over wall time. That establishment-at-page-load gap (which the
# Discourse `member_upcoming_changes` MessageBus test needs) is a separate,
# deeper async-runtime limitation, out of scope here.
class HijackLongPollBus
  def initialize
    @mutex   = Mutex.new
    @current = Hash.new(0)   # channel → latest message id
    @held    = []            # write-ios of connections parked waiting for a publish
  end

  PAGE = <<~HTML
    <!doctype html>
    <html><body>
      <script>
        var channels = {'/always': -1, '/test': -1};
        var clientId = 'c1';
        var inflight = null;

        function poll() {
          if (inflight) return;
          var xhr = inflight = new XMLHttpRequest();
          xhr.open('POST', '/message-bus/' + clientId + '/poll');
          xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
          xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            inflight = null;
            var aborted = (xhr.status === 0);
            if (!aborted) {
              try {
                JSON.parse(xhr.responseText || '[]').forEach(function (m) {
                  if (m.channel === '/__status') {
                    for (var k in m.data) {
                      if (Object.prototype.hasOwnProperty.call(channels, k)) channels[k] = m.data[k];
                    }
                  } else if (Object.prototype.hasOwnProperty.call(channels, m.channel)) {
                    channels[m.channel] = m.message_id;
                    if (m.channel === '/test') document.body.classList.add('got-message');
                  }
                });
              } catch (e) {}
            }
            // Caught up = every channel has adopted its real (>= 0) position.
            if (channels['/always'] >= 0 && channels['/test'] >= 0) {
              document.body.classList.add('caught-up');
            }
            setTimeout(poll, aborted ? 10 : 50);
          };
          var body = Object.keys(channels).map(function (k) {
            return encodeURIComponent(k) + '=' + channels[k];
          }).join('&');
          xhr.send(body);
        }

        poll();
        document.body.classList.add('subscribed');
      </script>
    </body></html>
  HTML

  def call(env)
    req = Rack::Request.new(env)
    case req.path_info
    when '/'
      [200, {'content-type' => 'text/html'}, [PAGE]]
    when %r{\A/message-bus/[^/]+/poll\z}
      handle_poll(env, req)
    when '/publish'
      publish('/test')
      [200, {'content-type' => 'text/plain'}, ['ok']]
    else
      [404, {'content-type' => 'text/plain'}, ['not found']]
    end
  end

  private

  def handle_poll(env, req)
    reqs = req.params.select {|k, _| k.start_with?('/') }
    @mutex.synchronize do
      # Any brand-new channel → status RESET for every requested channel.
      if reqs.any? {|_, v| v.to_i == -1 }
        data = reqs.each_key.with_object({}) {|ch, h| h[ch] = @current[ch] }
        return hijack_write(env, [{'channel' => '/__status', 'data' => data}])
      end
      # Backlog replay for any channel behind the current id.
      msgs = []
      reqs.each do |ch, v|
        ((v.to_i + 1)..@current[ch]).each {|i| msgs << {'channel' => ch, 'message_id' => i, 'data' => 'x'} }
      end
      return hijack_write(env, msgs) unless msgs.empty?
      # All caught up → hold the connection until a publish (or the test ends).
      @held << env['rack.hijack'].call
      [200, {}, []]
    end
  end

  def publish(ch)
    @mutex.synchronize do
      @current[ch] += 1
      msg  = {'channel' => ch, 'message_id' => @current[ch], 'data' => 'x'}
      held = @held
      @held = []
      held.each do |io|
        write_http(io, [msg])
      rescue StandardError
        nil
      ensure
        io.close rescue nil
      end
    end
  end

  # Immediate response delivered over a hijacked connection (async, on the
  # driver's pipe-read thread) — the realistic MessageBus path even for
  # `/__status` / backlog, NOT a synchronous Rack body.
  def hijack_write(env, payload)
    io = env['rack.hijack'].call
    write_http(io, payload)
    io.close
    [200, {}, []]
  end

  def write_http(io, payload)
    body = JSON.generate(payload)
    io.write("HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n\r\n#{body}")
  end
end

RSpec.describe 'long-poll cross-session delivery through the simulated driver' do
  let(:app) { HijackLongPollBus.new }

  it 'reflects a publish delivered to an established held poll in find-polling' do
    subscriber = Capybara::Session.new(:simulated, app)
    publisher  = Capybara::Session.new(:simulated, app)

    subscriber.visit('/')
    # Drive the subscription to its held steady state via the test's own
    # polling (see class note). Once caught up, the next poll holds at the
    # real position, ready to receive a publish.
    subscriber.assert_selector(:css, 'body.caught-up', wait: 2)

    publisher.visit('/publish')

    subscriber.assert_selector(:css, 'body.got-message', wait: 2)
  end
end
