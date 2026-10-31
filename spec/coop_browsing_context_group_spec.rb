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
      '/framed' => {'cross-origin-opener-policy' => 'same-origin'},
      '/hop'    => {'cross-origin-opener-policy' => 'same-origin', 'cross-origin-embedder-policy' => 'require-corp'},
      '/sbx'    => {'cross-origin-opener-policy' => 'same-origin', 'content-security-policy' => 'sandbox allow-scripts'}
    }
  }
  let(:session) {
    policies = self.policies
    simulated_session(lambda {|env|
      headers = {'content-type' => 'text/html'}.merge(policies.fetch(env['PATH_INFO'], {}))
      return [302, headers.merge('location' => 'http://a.test/plain'), []] if env['PATH_INFO'] == '/hop'

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

  # (…none of theirs reaching the page's new document: the WindowProxy one held of the page's a discarded browsing
  # context's, `closed`, and no name of theirs found from the page, nor the page's from them — HTML's lookup is of the
  # group's set)
  it 'leaves the windows a page opened as the page leaves its group' do
    session.visit('http://a.test/plain')
    session.execute_script('window.name = "page"')
    window = session.window_opened_by { session.execute_script("window.w = open('http://a.test/plain', 'pw')") }
    session.within_window(window) do
      session.has_css?('#p')
      session.execute_script('window.held = opener')
      expect(session.evaluate_script('[opener === null, held.closed]')).to eq([false, false])
    end
    session.visit('http://a.test/coi')
    session.execute_script("window.heard = []; addEventListener('message', (e) => heard.push(e.data))")
    expect(session.evaluate_script('crossOriginIsolated')).to be(true)
    session.within_window(window) do
      expect(session.evaluate_script('[opener === null, crossOriginIsolated, held.closed, held.parent, held.top]')).to eq([true, false, true, nil, nil])
      expect(session.evaluate_script("(() => { try { return held.document.title; } catch (e) { return e.name; } })()")).not_to eq('/coi')
      # (…its messages delivered nowhere, its Location's navigations going nowhere: a browsing context gone)
      session.execute_script("held.postMessage('stale', '*'); held.location.href = 'http://a.test/plain#stale'; held.location = 'http://a.test/x'")
    end
    session.has_css?('#none', wait: 0.2)
    expect(session.evaluate_script('[location.href, heard]')).to eq(['http://a.test/coi', []])
    expect(session.evaluate_script("open('', 'pw').location.href")).to eq('about:blank')
    expect(session.windows.size).to eq(3)
  end

  # (…HTML "the rules for choosing a navigable": a frame of another origin than its top-level document's, that one's
  # policy "same-origin", opens without its opener — `open()` null — the page itself with it)
  it "opens a frame's pop-up without its opener under a same-origin policy of another origin" do
    session.visit('http://a.test/framed')
    session.within_frame('fr') { expect(session.evaluate_script("open('http://b.test/plain')")).to be_nil }
    expect(session.evaluate_script("open('/plain') === null")).to be(false)
    expect(session.windows.size).to eq(3)
  end

  # (…each response enforced as it comes, a redirect's too — HTML "enforce a response's opener policy": a redirect of
  # another policy switches the group, though the response it redirects to is of the opener's)
  it "switches a pop-up's group at a redirect of another policy" do
    session.visit('http://a.test/plain')
    window = popup('http://a.test/hop')
    expect(session.evaluate_script('w.closed')).to be(true)
    session.within_window(window) { expect(isolation).to eq(['http://a.test/plain', false, 'undefined', true]) }
  end

  it 'switches the group at a page redirect of another policy' do
    session.visit('http://a.test/plain')
    window = popup('http://a.test/plain')
    session.visit('http://a.test/hop')
    session.within_window(window) { expect(session.evaluate_script('opener === null')).to be(true) }
  end

  # (…a switch replaces the browsing context, not the traversable: a pop-up that leaves its opener's isolate keeps its
  # session history, its name and its session storage)
  it 'keeps a pop-up\'s session history, name and session storage across its switch' do
    session.visit('http://a.test/plain')
    window = popup('http://a.test/one')
    session.execute_script("w.name = 'nm'; w.sessionStorage.setItem('s', 'kept'); w.location = 'http://a.test/two'")
    session.within_window(window) { session.has_css?('#p', text: '/two') }
    session.execute_script("w.location = 'http://b.test/coi'")
    session.within_window(window) do
      session.has_css?('#p', text: '/coi')
      expect(session.evaluate_script('[location.href, history.length, name, opener === null]')).to eq(['http://b.test/coi', 3, 'nm', true])
      session.go_back
      expect(session).to have_css('#p', text: '/two')
      expect(session.evaluate_script("[location.href, sessionStorage.getItem('s')]")).to eq(['http://a.test/two', 'kept'])
    end
  end

  # (…HTML "create navigation params by fetching" step 12.3: a sandboxed navigation of a top-level traversable to a
  # response of an opener policy but "unsafe-none" a network error)
  it 'refuses a sandboxed pop-up a response of an opener policy' do
    session.visit('http://a.test/plain')
    session.execute_script(<<~JS)
      const f = document.createElement('iframe');
      f.sandbox = 'allow-scripts allow-popups';
      f.srcdoc = '<script>open("http://b.test/coi")<\\/script>';
      document.body.appendChild(f);
    JS
    session.has_css?('#none', wait: 0.3)
    expect(session.windows.size).to eq(2)
    session.within_window(session.windows.last) { expect(session.evaluate_script('[location.href, document.title]')).to eq(['about:blank', '']) }
  end

  # (…and a page's, by its response's own Content-Security-Policy sandbox: an error document)
  it 'refuses a page a response of an opener policy that its own policy sandboxes' do
    session.visit('http://a.test/sbx')
    expect(session).to have_no_css('#p')
    expect(session.evaluate_script('origin')).to eq('null')
  end
end
