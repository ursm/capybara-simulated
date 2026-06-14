require 'capybara/simulated'
require 'action_cable'
require 'concurrent/timer_task'   # AC's heartbeat needs this loaded outside Rails
require 'logger'
require_relative 'support/js_engine'

# Action Cable end-to-end, self-contained in csim (no Rails): a standalone
# `ActionCable::Server::Base` with the in-process async adapter, mounted at
# `/cable`, plus the gem's OWN JavaScript client (`actioncable.esm.js`). The
# real `@rails/actioncable` consumer connects over csim's WebSocket (which
# rides the connection Action Cable hijacks), subscribes to a channel, and
# receives a server-side broadcast — exercising the whole stack in-process.
RSpec.describe 'Action Cable' do
  before do
    # csim's WebSocket connects via the rack.hijack socket, which only the V8
    # engine drives reliably for this flow; gate to V8 (text protocol).
    skip 'Action Cable end-to-end needs the V8 engine' unless CsimEngine.v8?
  end

  # One process-wide Action Cable server (the `ActionCable.server` singleton),
  # configured for standalone in-process use.
  before(:all) do
    ActionCable.server.config.cable   = {'adapter' => 'async'}
    ActionCable.server.config.logger  = Logger.new(IO::NULL)
    ActionCable.server.config.disable_request_forgery_protection = true
    ActionCable.server.config.connection_class = -> { ChatConnection }
  end

  class ChatConnection < ActionCable::Connection::Base; end

  class ChatChannel < ActionCable::Channel::Base
    def subscribed = stream_from('room')
  end

  AC_CLIENT_JS = File.read(File.join(
    Gem::Specification.find_by_name('actioncable').full_gem_path,
    'app/assets/javascripts/actioncable.esm.js'
  ))

  let(:app) {
    lambda do |env|
      case env['PATH_INFO']
      when '/cable'
        ActionCable.server.call(env)
      when '/actioncable.esm.js'
        [200, {'content-type' => 'text/javascript'}, [AC_CLIENT_JS]]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><title>chat</title></head>
          <body><div id="log"></div>
          <script type="module">
            import { createConsumer } from '/actioncable.esm.js';
            const consumer = createConsumer('/cable');
            consumer.subscriptions.create('ChatChannel', {
              connected() { document.title = 'subscribed'; },
              received(data) {
                const li = document.createElement('div');
                li.className = 'msg';
                li.textContent = data.body;
                document.getElementById('log').appendChild(li);
              }
            });
          </script></body></html>
        HTML
      end
    end
  }
  let(:session) { Capybara::Session.new(:simulated, app) }

  it 'connects, subscribes, and receives a server broadcast' do
    session.visit('/')
    expect(session).to have_title('subscribed')           # consumer subscribed (connected callback)

    ActionCable.server.broadcast('room', {body: 'hello from the server'})
    expect(session).to have_css('#log .msg', text: 'hello from the server')

    ActionCable.server.broadcast('room', {body: 'second message'})
    expect(session).to have_css('#log .msg', text: 'second message')
    expect(session).to have_css('#log .msg', count: 2)
  end
end
