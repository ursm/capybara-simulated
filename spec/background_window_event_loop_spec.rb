require 'capybara/simulated'
require 'rusty_racer'
require_relative 'support/session_teardown'

# Every window's event loop runs, as a browser's does: a window a Browser of its own hosts — a `noopener` pop-up, a
# browsing context group of its own — that is not the active one runs what its channels bring it (a BroadcastChannel
# post another window sent) and the timers that sets, as a wait polls the active window, with no command sent to it
# (Browser#steps_pending?, B12).
RSpec.describe 'a background window of a browsing context group of its own' do
  let(:scripts) {
    {
      # (…a window that answers a BroadcastChannel post at once, one that answers on a timer, one whose own timer reports)
      '/echo'  => "new BroadcastChannel('c').onmessage = (e) => { localStorage.setItem('echo', e.data); };",
      '/later' => "new BroadcastChannel('c').onmessage = (e) => { setTimeout(() => localStorage.setItem('echo', 'late:' + e.data), 500); };",
      '/timer' => "setTimeout(() => new BroadcastChannel('d').postMessage('fired'), 300);",
      '/page'  => "new BroadcastChannel('d').onmessage = (e) => document.body.insertAdjacentHTML('beforeend', '<p id=' + e.data + '>' + e.data + '</p>');",
      # (…a window whose worker only listens, one whose long poll never answers)
      '/mute'  => "new Worker(URL.createObjectURL(new Blob(['onmessage = () => {};']))).postMessage('x');",
      '/poll'  => "fetch('/slow');"
    }
  }
  let(:app) {
    scripts = self.scripts
    lambda do |env|
      next [200, {'content-type' => 'text/plain'}, ['x']].tap { sleep 3 } if env['PATH_INFO'] == '/slow'

      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><title>t</title><body><script>#{scripts[env['PATH_INFO']]}</script>"]]
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit 'http://a.test/page' }

  def open_noopener(path) = session.execute_script("open(#{path.to_json}, '', 'noopener')")
  def echo = session.evaluate_script("localStorage.getItem('echo')")

  it 'delivers a BroadcastChannel post to it as a wait polls the active window' do
    open_noopener('/echo')
    expect(session.driver.window_browsers.size).to eq(2)
    session.execute_script("new BroadcastChannel('c').postMessage('hi')")
    session.document.synchronize(2) { raise Capybara::ExpectationNotMet unless echo == 'hi' }
  end

  it 'runs the timer a delivered post set, with no command sent to that window' do
    open_noopener('/later')
    session.execute_script("new BroadcastChannel('c').postMessage('hi')")
    session.document.synchronize(3) { raise Capybara::ExpectationNotMet unless echo == 'late:hi' }
  end

  it 'runs its own timer while a matcher waits in the active window' do
    open_noopener('/timer')
    expect(session).to have_css('#fired', wait: 3)
  end

  # …but a failing matcher of the active window waits on none of its work that is open-ended: a worker that only
  # listens (a message posted to it that it never answers), a long poll — nor on the active window's own such worker.
  %w[/mute /poll].each do |path|
    it "keeps no failing matcher waiting on a background #{path.delete_prefix('/')} window" do
      open_noopener(path)
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      expect(session.has_css?('#nope', wait: 5)).to be(false)
      expect(Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).to be < 2.5
    end
  end

  it "keeps no failing matcher waiting on the active window's own worker that only listens" do
    session.execute_script(scripts['/mute'])
    session.has_css?('body')
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    expect(session.has_css?('#nope', wait: 5)).to be(false)
    expect(Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).to be < 2.5
  end
end
