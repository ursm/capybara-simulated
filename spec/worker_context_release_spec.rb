require 'capybara/simulated'
require_relative 'support/session_teardown'

# A worker gone with its session leaves nothing behind. rusty_racer roots an isolate's owner Thread for as long as its Context
# lives; a dead worker Thread that still reached its Context through what `run_worker`'s closures keep was a cycle through that
# root: the Context, and all the closures with it, for the life of the process, about 1 MB a worker of any kind.
RSpec.describe 'a worker at the end of its session' do
  let(:app) {
    lambda {|env|
      case env['PATH_INFO']
      when '/w.js' then [200, {'content-type' => 'text/javascript'}, ['postMessage(1)']]
      when '/shared.js' then [200, {'content-type' => 'text/javascript'}, ['onconnect = (e) => e.ports[0].postMessage(1)']]
      when '/service.js' then [200, {'content-type' => 'text/javascript'}, ["self.addEventListener('install', () => skipWaiting());"]]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><p>x</p>']]
      end
    }
  }
  let(:session) { simulated_session(app) }
  after { session.reset_session! }

  def contexts_after(count)
    count.times do
      session.visit('/')
      session.evaluate_async_script(yield)
      session.reset_session!
    end
    GC.start
    ObjectSpace.each_object(RustyRacer::Context).count
  end

  {
    'dedicated' => "const d = arguments[0]; new Worker('/w.js').onmessage = () => d();",
    'shared'    => "const d = arguments[0]; const w = new SharedWorker('/shared.js'); w.port.onmessage = () => d();",
    'service'   => "const d = arguments[0]; navigator.serviceWorker.register('/service.js').then(() => navigator.serviceWorker.ready).then(() => d());"
  }.each do |kind, script|
    it "keeps no Context of a #{kind} worker" do
      session.visit('/')
      GC.start
      before = ObjectSpace.each_object(RustyRacer::Context).count
      # (…a conservative GC may hold one or two off the machine stack: never the twenty)
      expect(contexts_after(20) { script } - before).to be < 10
    end
  end
end
