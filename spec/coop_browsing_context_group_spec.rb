require 'capybara/simulated'
require_relative 'support/session_teardown'

# A navigation response whose cross-origin opener policy its document's browsing context group cannot hold switches the
# top-level traversable to a new browsing context group (HTML "obtain a browsing context to use for a navigation
# response", coop.rs): a pop-up so switched leaves its opener's isolate for a Browser of its own — the opener's
# WindowProxy of it `closed`, its own `opener` null, cross-origin isolated as its own response makes it — and a page so
# switched leaves the windows it opened, whose `opener` is null from then on.
RSpec.describe "a navigation response's cross-origin opener policy", :every_host_local do
  let(:policies) {
    {
      '/coi'    => {'cross-origin-opener-policy' => 'same-origin', 'cross-origin-embedder-policy' => 'require-corp'},
      '/popups' => {'cross-origin-opener-policy' => 'same-origin-allow-popups'},
      '/framed' => {'cross-origin-opener-policy' => 'same-origin'}
    }
  }
  let(:session) {
    policies = self.policies
    simulated_session(lambda {|env|
      headers = {'content-type' => 'text/html'}.merge(policies.fetch(env['PATH_INFO'], {}))
      frame = '<iframe name="fr" src="http://b.test/plain"></iframe>' if env['PATH_INFO'] == '/framed'
      [200, headers, ["<!doctype html><meta charset=utf-8><title>#{env['PATH_INFO']}</title><p id=p>#{env['PATH_INFO']}</p>#{frame}"]]
    })
  }
  after { session.reset_session! }

  def popup(url)
    window = session.window_opened_by { session.execute_script("window.w = open(#{url.to_json})") }
    session.within_window(window) { session.has_css?('#p') }
    window
  end
  def isolation = session.evaluate_script('[location.href, crossOriginIsolated, typeof SharedArrayBuffer, opener === null]')

  it 'moves a pop-up of another policy out of a cross-origin isolated opener\'s group' do
    session.visit('http://a.test/coi')
    window = popup('http://b.test/plain')
    expect(session.evaluate_script('[crossOriginIsolated, w.closed]')).to eq([true, true])
    session.within_window(window) { expect(isolation).to eq(['http://b.test/plain', false, 'undefined', true]) }
    expect(session.driver.window_browsers.size).to eq(2)
  end

  it 'moves a cross-origin isolated pop-up out of its opener\'s group, isolated' do
    session.visit('http://a.test/plain')
    window = popup('http://b.test/coi')
    expect(session.evaluate_script('[crossOriginIsolated, w.closed]')).to eq([false, true])
    session.within_window(window) { expect(isolation).to eq(['http://b.test/coi', true, 'function', true]) }
  end

  it 'keeps a pop-up of the same origin and policy in the group, isolated as it is' do
    session.visit('http://a.test/coi')
    window = popup('http://a.test/coi')
    expect(session.evaluate_script('[w.closed, w.document.title]')).to eq([false, '/coi'])
    session.within_window(window) { expect(isolation).to eq(['http://a.test/coi', true, 'function', false]) }
    expect(session.driver.window_browsers.size).to eq(1)
  end

  # (…the popup check: an opener's same-origin-allow-popups keeps its pop-up's initial about:blank going to unsafe-none)
  it "keeps a pop-up of no policy in a same-origin-allow-popups opener's group" do
    session.visit('http://a.test/popups')
    window = popup('http://b.test/plain')
    expect(session.evaluate_script('w.closed')).to be(false)
    session.within_window(window) { expect(session.evaluate_script('opener === null')).to be(false) }
  end

  it 'leaves the windows a page opened as the page leaves its group' do
    session.visit('http://a.test/plain')
    window = popup('http://a.test/plain')
    session.within_window(window) { expect(session.evaluate_script('opener === null')).to be(false) }
    session.visit('http://a.test/coi')
    expect(session.evaluate_script('crossOriginIsolated')).to be(true)
    session.within_window(window) { expect(session.evaluate_script('[opener === null, crossOriginIsolated]')).to eq([true, false]) }
  end

  # (…HTML "the rules for choosing a navigable": a frame of another origin than its top-level document's, that one's
  # policy "same-origin", opens without its opener — `open()` null — the page itself with it)
  it "opens a frame's pop-up without its opener under a same-origin policy of another origin" do
    session.visit('http://a.test/framed')
    session.within_frame('fr') { expect(session.evaluate_script("open('http://b.test/plain')")).to be_nil }
    expect(session.evaluate_script("open('/plain') === null")).to be(false)
    expect(session.windows.size).to eq(3)
  end
end
