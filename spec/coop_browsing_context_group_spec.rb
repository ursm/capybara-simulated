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
      return [302, headers.merge('location' => 'https://a.test/plain'), []] if env['PATH_INFO'] == '/hop'
      return [302, policies['/framed'].merge('location' => 'https://a.test/sbx'), []] if env['PATH_INFO'] == '/hopsbx'
      return [204, policies['/coi'], []] if env['PATH_INFO'] == '/nocontent'

      frame = '<iframe name="fr" src="https://b.test/plain"></iframe>' if env['PATH_INFO'] == '/framed'
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
    session.visit('https://a.test/coi')
    window = popup('https://b.test/plain')
    expect(session.evaluate_script('[crossOriginIsolated, w.closed]')).to eq([true, true])
    session.within_window(window) { expect(isolation).to eq(['https://b.test/plain', false, 'undefined', true]) }
    expect(session.driver.window_browsers.size).to eq(2)
  end

  it 'moves a cross-origin isolated pop-up out of its opener\'s group, isolated' do
    session.visit('https://a.test/plain')
    window = popup('https://b.test/coi')
    expect(session.evaluate_script('[crossOriginIsolated, w.closed]')).to eq([false, true])
    session.within_window(window) { expect(isolation).to eq(['https://b.test/coi', true, 'function', true]) }
  end

  it 'keeps a pop-up of the same origin and policy in the group, isolated as it is' do
    session.visit('https://a.test/coi')
    window = popup('https://a.test/coi')
    expect(session.evaluate_script('[w.closed, w.document.title]')).to eq([false, '/coi'])
    session.within_window(window) { expect(isolation).to eq(['https://a.test/coi', true, 'function', false]) }
    expect(session.driver.window_browsers.size).to eq(1)
  end

  # (…the popup check: an opener's same-origin-allow-popups keeps its pop-up's initial about:blank going to unsafe-none)
  it "keeps a pop-up of no policy in a same-origin-allow-popups opener's group" do
    session.visit('https://a.test/popups')
    window = popup('https://b.test/plain')
    expect(session.evaluate_script('w.closed')).to be(false)
    session.within_window(window) { expect(session.evaluate_script('opener === null')).to be(false) }
  end

  # (…none of theirs reaching the page's new document: the WindowProxy one held of the page's a discarded browsing
  # context's, `closed`, and no name of theirs found from the page, nor the page's from them — HTML's lookup is of the
  # group's set)
  it 'leaves the windows a page opened as the page leaves its group' do
    session.visit('https://a.test/plain')
    session.execute_script('window.name = "page"')
    window = session.window_opened_by { session.execute_script("window.w = open('https://a.test/plain', 'pw')") }
    session.within_window(window) do
      session.has_css?('#p')
      session.execute_script('window.held = opener')
      expect(session.evaluate_script('[opener === null, held.closed]')).to eq([false, false])
    end
    session.visit('https://a.test/coi')
    session.execute_script("window.heard = []; addEventListener('message', (e) => heard.push(e.data))")
    expect(session.evaluate_script('crossOriginIsolated')).to be(true)
    session.within_window(window) do
      expect(session.evaluate_script('[opener === null, crossOriginIsolated, held.closed, held.parent, held.top]')).to eq([true, false, true, nil, nil])
      expect(session.evaluate_script("(() => { try { return held.document.title; } catch (e) { return e.name; } })()")).not_to eq('/coi')
      # (…its messages delivered nowhere, its Location's navigations going nowhere: a browsing context gone)
      session.execute_script("held.postMessage('stale', '*'); held.location.href = 'https://a.test/plain#stale'; held.location = 'https://a.test/x'")
      expect(session.evaluate_script("['close', 'focus', 'blur'].map((m) => (held[m](), typeof held[m]))")).to eq(%w[function function function])
    end
    # (…the page's own timer run after the worst its messages could have taken, a barrier: none came)
    expect(session.evaluate_async_script('const done = arguments[0]; setTimeout(() => done([location.href, heard]), 200)')).to eq(['https://a.test/coi', []])
    expect(session.evaluate_script("open('', 'pw').location.href")).to eq('about:blank')
    expect(session.windows.size).to eq(3)
  end

  # (…HTML "the rules for choosing a navigable": a frame of another origin than its top-level document's, that one's
  # policy "same-origin", opens without its opener — `open()` null — the page itself with it)
  it "opens a frame's pop-up without its opener under a same-origin policy of another origin" do
    session.visit('https://a.test/framed')
    session.within_frame('fr') { expect(session.evaluate_script("open('https://b.test/plain')")).to be_nil }
    expect(session.evaluate_script("open('/plain') === null")).to be(false)
    expect(session.windows.size).to eq(3)
  end

  # (…each response enforced as it comes, a redirect's too — HTML "enforce a response's opener policy": a redirect of
  # another policy switches the group, though the response it redirects to is of the opener's)
  it "switches a pop-up's group at a redirect of another policy" do
    session.visit('https://a.test/plain')
    window = popup('https://a.test/hop')
    expect(session.evaluate_script('w.closed')).to be(true)
    session.within_window(window) { expect(isolation).to eq(['https://a.test/plain', false, 'undefined', true]) }
  end

  it 'switches the group at a page redirect of another policy' do
    session.visit('https://a.test/plain')
    window = popup('https://a.test/plain')
    session.visit('https://a.test/hop')
    session.within_window(window) { expect(session.evaluate_script('opener === null')).to be(true) }
  end

  # (…a switch replaces the browsing context, not the traversable: a pop-up that leaves its opener's isolate keeps its
  # session history and its session storage. Not its target name, of whatever origin: Chrome and Firefox)
  it 'keeps a pop-up\'s session history and session storage across its switch, its name gone' do
    session.visit('https://a.test/plain')
    window = popup('https://a.test/one')
    session.execute_script("w.name = 'nm'; w.sessionStorage.setItem('s', 'kept'); w.location = 'https://a.test/two'")
    session.within_window(window) { session.has_css?('#p', text: '/two') }
    session.execute_script("w.location = 'https://b.test/coi'")
    session.within_window(window) do
      session.has_css?('#p', text: '/coi')
      expect(session.evaluate_script('[location.href, history.length, name, opener === null]')).to eq(['https://b.test/coi', 3, '', true])
      session.go_back
      expect(session).to have_css('#p', text: '/two')
      expect(session.evaluate_script("[location.href, sessionStorage.getItem('s')]")).to eq(['https://a.test/two', 'kept'])
    end
  end

  # (…HTML "create navigation params by fetching" step 12.3: a sandboxed navigation of a top-level traversable to a
  # response of an opener policy but "unsafe-none" a network error)
  it 'refuses a sandboxed pop-up a response of an opener policy' do
    session.visit('https://a.test/plain')
    session.execute_script(<<~JS)
      const f = document.createElement('iframe');
      f.sandbox = 'allow-scripts allow-popups';
      f.srcdoc = '<script>open("https://b.test/coi")<\\/script>';
      document.body.appendChild(f);
    JS
    expect(session).to have_css('#none', wait: 0, count: 0)
    session.document.synchronize(2) { raise Capybara::ElementNotFound if session.windows.size < 2 }
    # (…an error document at its URL, of a new opaque origin, as a page's network error makes: Browser#commit_error_document)
    session.within_window(session.windows.last) { expect(session.evaluate_script('[location.href, document.title, origin]')).to eq(['https://b.test/coi', '', 'null']) }
  end

  # (…and a page's, by its response's own Content-Security-Policy sandbox: an error document)
  it 'refuses a page a response of an opener policy that its own policy sandboxes' do
    session.visit('https://a.test/sbx')
    expect(session).to have_no_css('#p')
    expect(session.evaluate_script('origin')).to eq('null')
  end

  # (…and a pop-up's, its switch needed by the redirect before: its error document committed in the new group at the last
  # hop's URL, of a new opaque origin all the same)
  it "commits a switched pop-up's error document of an opaque origin at its last hop" do
    session.visit('https://a.test/plain')
    window = session.window_opened_by { session.execute_script("window.w = open('https://a.test/hopsbx')") }
    expect(session.evaluate_script('w.closed')).to be(true)
    session.within_window(window) { expect(session.evaluate_script('[location.href, origin, opener === null]')).to eq(['https://a.test/sbx', 'null', true]) }
  end

  # (…the switch a navigation's responses need its own, which a navigation that commits nothing — a 204's — leaves to none
  # after it)
  it "leaves no switch of a navigation that committed nothing to the next" do
    session.visit('https://a.test/plain')
    window = popup('https://a.test/plain')
    session.execute_script("window.stays = 1; location = 'https://a.test/nocontent'")
    # (…a fetch of a response that makes no document leaves the document standing: its next navigation made after it)
    expect(session.evaluate_async_script('const done = arguments[0]; setTimeout(() => done(window.stays), 100)')).to eq(1)
    session.execute_script("location = 'about:blank'")
    await_window("location.href === 'about:blank'")
    session.within_window(window) { expect(session.evaluate_script('opener === null')).to be(false) }
  end

  # (…a document in a context not secure has none: HTML "obtain an opener policy", WPT no-https)
  it 'takes no policy from a response to a context not secure' do
    session.visit('http://a.test/framed')
    popup('http://a.test/coi')
    expect(session.evaluate_script('[w.closed, crossOriginIsolated, w.crossOriginIsolated]')).to eq([false, false, false])
    expect(session.driver.window_browsers.size).to eq(1)
  end

  # A document's navigation committed: `w.location` at `url`, or `w` closed — what a switch makes of it — never a fixed wait.
  def await_window(script = 'true')
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 5
    until session.evaluate_script(script)
      raise "never: #{script}" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

      session.has_css?('#never', wait: 0.02)
    end
  end
  def blob_url(global, html, type = 'text/html') = "#{global}.URL.createObjectURL(new #{global}.Blob([#{html.to_json}], {type: #{type.to_json}}))"
  def window_at(prefix) = "w.closed || w.location.href.startsWith(#{prefix.to_json})"

  # An about:blank or `blob:` document inherits its initiator's top-level document's policy where that initiator is of its
  # origin (coop.rs `inherited`: whatwg/html#5198; WPT html/cross-origin-opener-policy/blob-popup, coep-blob-popup,
  # navigate-to-aboutblank, navigate-top-to-aboutblank; Chrome and Firefox measured 2026-11-06), and keeps its group.
  context 'a document of no headers, inheriting' do
    it 'keeps a pop-up of a policy in its group for about:blank' do
      session.visit('https://a.test/framed')
      popup('https://a.test/framed')
      session.execute_script("w.location = 'about:blank'")
      await_window(window_at('about:blank'))
      expect(session.evaluate_script('[w.closed, w.opener === window, w.origin]')).to eq([false, true, 'https://a.test'])
      expect(session.driver.window_browsers.size).to eq(1)
    end

    it 'keeps a pop-up of a policy in its group for a blob: URL' do
      session.visit('https://a.test/framed')
      popup('https://a.test/framed')
      session.execute_script("w.location = #{blob_url('w', '<p id=blob>blob</p>')}")
      await_window(window_at('blob:'))
      expect(session.evaluate_script('[w.closed, w.opener === window, w.document.getElementById("blob").textContent]')).to eq([false, true, 'blob'])
    end

    # (…a pop-up's initial about:blank its creator's policy, its blob: or about:blank the same, as WPT blob-popup holds)
    it 'opens a blob: URL in the group of a page of a policy, isolated as it is' do
      session.visit('https://a.test/coi')
      session.execute_script("window.w = open(#{blob_url('window', '<p id=blob>blob</p>')})")
      await_window(window_at('blob:'))
      expect(session.evaluate_script('[w.closed, w.crossOriginIsolated, w.opener === window]')).to eq([false, true, true])
      expect(session.driver.window_browsers.size).to eq(1)
    end

    it 'keeps an initial about:blank navigated to about:blank in its group' do
      session.visit('https://a.test/framed')
      session.window_opened_by { session.execute_script("window.w = open('')") }
      session.execute_script("w.document.title = 'old'; w.location = 'about:blank'")
      await_window("w.closed || w.document.title !== 'old'")
      expect(session.evaluate_script('[w.closed, w.opener === window]')).to eq([false, true])
    end

    # (…the document keeps it: its next navigation judged against that, a response of the same policy staying and one of
    # none leaving)
    it 'keeps the policy it inherited for its next navigation' do
      session.visit('https://a.test/framed')
      popup('https://a.test/framed')
      session.execute_script("w.location = 'about:blank'")
      await_window(window_at('about:blank'))
      session.execute_script("w.location = 'https://a.test/framed'")
      await_window(window_at('https://a.test/framed'))
      expect(session.evaluate_script('[w.closed, w.opener === window]')).to eq([false, true])
      session.execute_script("w.location = 'about:blank'")
      await_window(window_at('about:blank'))
      session.execute_script("w.location = 'https://a.test/plain'")
      await_window('w.closed')
      expect(session.driver.window_browsers.size).to eq(2)
    end

    # (…a reload and a traversal finding it in the entry: HTML's history policy container)
    it 'takes it again on a reload and a traversal' do
      session.visit('https://a.test/framed')
      popup('https://a.test/framed')
      session.execute_script("w.location = 'about:blank'")
      await_window(window_at('about:blank'))
      session.execute_script("w.document.title = 'old'; w.location.reload()")
      await_window("w.closed || w.document.title !== 'old'")
      expect(session.evaluate_script('w.closed')).to be(false)
      session.execute_script("w.location = 'https://a.test/framed'")
      await_window(window_at('https://a.test/framed'))
      session.execute_script('w.history.back()')
      await_window(window_at('about:blank'))
      expect(session.evaluate_script('w.closed')).to be(false)
    end

    it 'keeps a page of a policy, isolated, for about:blank, the windows it opened its' do
      session.visit('https://a.test/coi')
      window = popup('https://a.test/coi')
      session.execute_script("location = 'about:blank'")
      await_window("location.href === 'about:blank'")
      expect(session.evaluate_script('[crossOriginIsolated, typeof SharedArrayBuffer, origin]')).to eq([true, 'function', 'https://a.test'])
      session.within_window(window) { expect(session.evaluate_script('[opener === null, opener.closed]')).to eq([false, false]) }
    end

    it 'keeps a page of a policy, isolated, for a blob: URL of its own' do
      session.visit('https://a.test/coi')
      session.execute_script("location = #{blob_url('window', '<p id=blob>blob</p>')}")
      expect(session).to have_css('#blob')
      expect(session.evaluate_script('[crossOriginIsolated, origin]')).to eq([true, 'https://a.test'])
      expect(session.driver.window_browsers.size).to eq(1)
    end

    # (…an initiator of another origin than its top-level document's gives none: a switch. Chrome and WPT
    # navigate-top-to-aboutblank; Firefox keeps the group)
    it 'leaves the group for about:blank from a frame of another origin' do
      session.visit('https://a.test/framed')
      window = popup('https://a.test/framed')
      session.within_frame('fr') { session.execute_script("top.location = 'about:blank'") }
      await_window("location.href === 'about:blank'")
      session.within_window(window) { expect(session.evaluate_script('opener === null')).to be(true) }
    end

    # (…a blob PDF its viewer's inline content, of an opaque origin, in the group)
    it 'makes a blob PDF its viewer\'s document in the group' do
      session.visit('https://a.test/framed')
      window = popup('https://a.test/framed')
      session.execute_script("w.location = #{blob_url('w', '%PDF-1.7', 'application/pdf')}")
      session.within_window(window) do
        expect(session).to have_no_css('#p')
        expect(session.evaluate_script('[location.protocol, origin, document.contentType, document.body.textContent, opener === null]')).to eq(['blob:', 'null', 'text/html', '', false])
      end
      expect(session.evaluate_script('w.closed')).to be(false)
    end

    # (…none of it where neither has a policy)
    it 'stays in the group where neither has a policy' do
      session.visit('https://a.test/plain')
      popup('https://a.test/plain')
      session.execute_script("w.location = 'about:blank'")
      await_window(window_at('about:blank'))
      expect(session.evaluate_script('[w.closed, w.opener === window]')).to eq([false, true])
    end
  end

  # (…a `data:` URL inherits nothing: annevk on whatwg/html#5198, "always ensure that it's a fresh browsing context group")
  it 'leaves the group for a data: URL the user visits, of its origin or a PDF' do
    session.visit('https://a.test/framed')
    window = popup('https://a.test/framed')
    session.within_window(window) do
      session.visit('data:text/html,<p id=data>data</p>')
      expect(session).to have_css('#data')
      expect(session.evaluate_script('[origin, opener === null]')).to eq(['null', true])
    end
    expect(session.evaluate_script('w.closed')).to be(true)
  end

  # (…the history a switching window keeps: a switch replaces the browsing context, not the traversable, so what the
  # navigation is goes on being it. Chrome and Firefox: 2 for a replace, 3 for an assign, a traversal keeping the length and
  # its forward entry, a reload both, measured 2026-11-06)
  context 'a window leaving its group' do
    let(:flip) { {} }
    let(:session) {
      policies = self.policies
      flip     = self.flip
      simulated_session(lambda {|env|
        path    = env['PATH_INFO']
        headers = {'content-type' => 'text/html'}.merge(policies.fetch(path, {}))
        headers.merge!(policies['/framed']) if path == '/flip' && !flip[:on]
        [200, headers, ["<!doctype html><meta charset=utf-8><title>#{path}</title><p id=p>#{path}</p>"]]
      })
    }

    def so_popup(url)
      session.visit('https://a.test/framed')
      popup(url).tap { expect(session.evaluate_script('w.closed')).to be(false) }
    end

    it 'keeps its entries for a location.replace' do
      window = so_popup('https://a.test/flip')
      session.execute_script("w.history.pushState({}, '', '/flip?1'); w.location.replace('https://a.test/plain')")
      await_window('w.closed')
      session.within_window(window) do
        expect(session).to have_css('#p', text: '/plain')
        expect(session.evaluate_script('history.length')).to eq(2)
      end
    end

    it 'adds an entry for an assignment' do
      window = so_popup('https://a.test/flip')
      session.execute_script("w.history.pushState({}, '', '/flip?1'); w.location = 'https://a.test/plain'")
      await_window('w.closed')
      session.within_window(window) do
        expect(session).to have_css('#p', text: '/plain')
        expect(session.evaluate_script('history.length')).to eq(3)
      end
    end

    it 'goes to its entry for a traversal, its forward entry kept' do
      window = so_popup('https://a.test/flip')
      session.execute_script("w.location = 'https://a.test/framed'")
      await_window(window_at('https://a.test/framed'))
      flip[:on] = true
      session.execute_script('w.history.back()')
      await_window('w.closed')
      session.within_window(window) do
        expect(session).to have_css('#p', text: '/flip')
        expect(session.evaluate_script('history.length')).to eq(2)
        session.go_forward
        expect(session).to have_css('#p', text: '/framed')
      end
    end

    it 'keeps its entries for a reload' do
      window = so_popup('https://a.test/flip')
      session.execute_script("w.history.pushState({}, '', '/flip?1'); w.history.pushState({}, '', '/flip?2'); w.history.back()")
      await_window("w.location.search === '?1'")
      flip[:on] = true
      session.execute_script('w.location.reload()')
      await_window('w.closed')
      session.within_window(window) do
        expect(session).to have_css('#p', text: '/flip')
        expect(session.evaluate_script('[location.search, history.length]')).to eq(['?1', 3])
        session.go_forward
        expect(session.evaluate_script('location.search')).to eq('?2')
      end
    end
  end

  # (…a session's next test begins of no policy, whatever the last left)
  it 'forgets the policy across a session reset' do
    session.visit('https://a.test/coi')
    session.reset_session!
    session.visit('https://a.test/plain')
    window = popup('https://a.test/plain')
    session.execute_script("location = 'about:blank'")
    await_window("location.href === 'about:blank'")
    session.within_window(window) { expect(session.evaluate_script('opener === null')).to be(false) }
  end

  # (…a worker cross-origin isolated as the context that made it is: a pop-up's of the group its page left, not)
  it "makes a pop-up's worker as isolated as the pop-up, not as its page" do
    session.visit('https://a.test/plain')
    window = popup('https://a.test/plain')
    session.visit('https://a.test/coi')
    expect(session.evaluate_script('crossOriginIsolated')).to be(true)
    session.within_window(window) do
      source = 'postMessage([self.crossOriginIsolated, typeof SharedArrayBuffer])'
      script = "const wk = new Worker(URL.createObjectURL(new Blob([#{source.to_json}]))); wk.onmessage = (e) => arguments[0](e.data)"
      expect(session.evaluate_async_script(script)).to eq([false, 'undefined'])
    end
  end
end
