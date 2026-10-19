require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# Web Locks' lock managers are the session's (web_locks.rs): the windows of one session contend for an origin's locks
# as the tabs of a browser do. A lock granted to a window that is not the active one has its callback run all the same
# — its tasks that are due run as the grant is delivered — so what it releases reaches the window waiting for it.
RSpec.describe 'Web Locks across windows' do
  let(:app) { ->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] } }

  it "grants a background window its lock, and its release reaches the window that waits" do
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.__release = null;
      navigator.locks.request('W', () => new Promise((r) => { window.__release = r; }));
    JS
    poll_until { s.evaluate_script('window.__release !== null') }
    w = s.open_new_window
    s.within_window(w) do
      s.visit '/'
      s.execute_script("navigator.locks.request('W', () => { localStorage.setItem('b', 'ran'); })")
    end
    s.execute_script(<<~JS)
      window.__got = null;
      window.__release();
      navigator.locks.request('W', () => 'again').then((v) => { window.__got = [v, localStorage.getItem('b')]; });
    JS
    expect(poll_until { s.evaluate_script('window.__got') }).to eq(%w[again ran])
  end

  # …and each context's `clientId` is its own across the session's windows (§3.2.2: an id that "corresponds to a unique
  # context"): two windows' documents hold two locks under two ids.
  it "tells one window's client from another's" do
    s = simulated_session(app)
    s.visit '/'
    s.execute_script("navigator.locks.request('A', () => new Promise(() => {}))")
    w = s.open_new_window
    ids = s.within_window(w) do
      s.visit '/'
      s.execute_script("navigator.locks.request('B', () => new Promise(() => {}))")
      s.execute_script('window.__ids = null; navigator.locks.query().then((q) => { window.__ids = q.held.map((l) => l.clientId); })')
      poll_until { s.evaluate_script('window.__ids') }
    end
    expect(ids.uniq.size).to eq(2)
  end
end
