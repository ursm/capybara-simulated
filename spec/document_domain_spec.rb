# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'
require_relative 'support/https_app_host'

# `document.domain` is its origin's effective domain (HTML §7.5.2): none for an opaque origin — a document sandboxed
# without allow-same-origin, which may not set one — and its creator's for a document with no browsing context, which
# may not set one either. Chrome's figures and messages.
RSpec.describe 'document.domain' do
  include PollUntil

  def session
    page = <<~HTML
      <!DOCTYPE html><meta charset="utf-8">
      <script>window.onmessage = (e) => { window.R = e.data; };</script>
      <iframe sandbox="allow-scripts" srcdoc="<script>parent.postMessage([document.domain, (() => { try { document.domain = 'x'; return 'set' } catch (e) { return e.name + ': ' + e.message } })()], '*')</script>"></iframe>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    s
  end

  it 'is none for a sandboxed document, which may not set it' do
    s = session
    expect(poll_until { s.evaluate_script('window.R') }).to eq(
      ['', "SecurityError: Failed to set the 'domain' property on 'Document': Assignment is forbidden for sandboxed iframes."]
    )
  end

  # …an about:blank frame's its parent's, as its origin is; and a write is a host — lowercased — that the effective
  # domain is, or is a subdomain of where it is no public suffix (the Public Suffix List's: `com`), which it then is.
  it "is an inherited origin's, and set only to the domain or one it is a subdomain of" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><iframe></iframe>']] })
    s.visit '/'
    expect(s.evaluate_script(<<~JS)).to eq(['www.example.com', 'www.example.com', 'SecurityError', 'SecurityError', 'SecurityError', 'SecurityError', 'example.com', 'SecurityError'])
      (() => {
        const tried = (value) => { try { document.domain = value; return document.domain; } catch (e) { return e.name; } };
        return [frames[0].document.domain, tried('WWW.Example.COM'), tried('example.org'), tried('www.example.com:80'), tried(''), tried('com'), tried('example.com'), tried('www.example.com')];
      })()
    JS
  end

  # Same origin-domain (HTML §7.1.1): the access HTML grants a script to another window's members, a frame's
  # `contentDocument`, a window's `frameElement` and a javascript: URL's navigation is by its origin's DOMAIN where a
  # write set one on either — two documents that set the same one reach each other whatever their hosts, and one that
  # set it reaches no document of its own origin that did not.
  describe 'same origin-domain access', :every_host_local do
    let(:pages) do
      {
        '/'      => '<!DOCTYPE html><meta charset="utf-8"><iframe src="http://a.example.com/child"></iframe>',
        '/same'  => '<!DOCTYPE html><meta charset="utf-8"><iframe src="/child"></iframe><iframe></iframe>',
        '/blank' => '<!DOCTYPE html><meta charset="utf-8">',

        '/child' => <<~HTML
          <!DOCTYPE html><meta charset="utf-8"><title>child</title>
          <script>window.join = () => { document.domain = 'example.com'; };</script>
        HTML
      }
    end
    let(:session) do
      s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'], '')]] })
      s.visit '/'
      poll_until { s.within_frame(0) { s.evaluate_script('document.title') } == 'child' }
      s
    end
    let(:reach) do
      <<~JS
        (() => {
          const frame = document.querySelector('iframe');
          const read = (f) => { try { return f(); } catch (e) { return e.name; } };
          return [read(() => frames[0].document.title), frame.contentDocument === null, read(() => frames[0].frameElement === frame)];
        })()
      JS
    end

    it 'joins two origins that set the same domain, and only those' do
      expect(session.evaluate_script(reach)).to eq(['SecurityError', true, 'SecurityError'])
      session.execute_script("document.domain = 'example.com'")
      expect(session.evaluate_script(reach)).to eq(['SecurityError', true, 'SecurityError'])
      session.within_frame(0) { session.execute_script('join()') }
      expect(session.evaluate_script(reach)).to eq(['child', false, true])
      # (…and the frame's, its parent's container its frameElement)
      expect(session.within_frame(0) { session.evaluate_script('window.frameElement !== null && parent.document.querySelector("iframe") === frameElement') }).to be(true)
    end

    # …an origin a document inherited — an about:blank frame's, its parent's — the one record, a write to its domain the
    # frame's too (Chrome and Firefox, measured: a frame made before the write reads the domain it set); a document of
    # the same origin that did not set it no longer reached.
    it "shares its domain with a frame that inherited its origin, and parts with one that did not" do
      session.visit '/same'
      poll_until { session.evaluate_script("frames[0].document.title === 'child'") }
      expect(session.evaluate_script(<<~JS)).to eq(['example.com', false, true, 'SecurityError'])
        (() => {
          document.domain = 'example.com';
          const [own, blank] = document.querySelectorAll('iframe');
          let read;
          try { read = frames[0].document.title; } catch (e) { read = e.name; }
          return [blank.contentDocument.domain, blank.contentDocument === null, own.contentDocument === null, read];
        })()
      JS
    end

    # …but a document a frame or a window that inherited it goes on to — one of its URL's origin, a new origin — none
    # of the domain the creator set: its about:blank's Window not kept for it (HTML "create and initialize a Document
    # object": same origin-domain), no longer reached.
    it "gives a document an inherited about:blank goes on to an origin of its own" do
      session.visit '/blank'
      session.execute_script(<<~JS)
        window.frame = document.body.appendChild(document.createElement('iframe'));
        window.popup = open();
        void [frame.contentWindow.document, popup.document];
        document.domain = 'example.com';
        frame.src = '/child';
        popup.location = '/child';
      JS
      poll_until { session.evaluate_script("(() => { try { return frames[0].document.title === 'child'; } catch (e) { return true; } })()") }
      poll_until { session.evaluate_script("(() => { try { return popup.document.title === 'child'; } catch (e) { return true; } })()") }
      expect(session.evaluate_script(<<~JS)).to eq(['SecurityError', true, 'SecurityError'])
        (() => {
          const read = (f) => { try { return f(); } catch (e) { return e.name; } };
          return [read(() => frames[0].document.title), frame.contentDocument === null, read(() => popup.document.title)];
        })()
      JS
    end

    # …and a Location a script took while the two were same origin-domain refuses it its members once they are not
    # (HTML: each getter's, `assign()`'s and `reload()`'s check against the entry settings object) — its `href` setter
    # and `replace()` none, which have no check.
    it "refuses a Location's members to a script no longer same origin-domain with it" do
      session.visit '/same'
      poll_until { session.evaluate_script("frames[0].document.title === 'child'") }
      expect(session.evaluate_script(<<~JS)).to eq(['http://www.example.com/child', 'SecurityError', 'SecurityError', 'function'])
        (() => {
          const loc = frames[0].location;
          const before = loc.href;
          document.domain = 'example.com';
          const read = (f) => { try { return f(); } catch (e) { return e.name; } };
          return [before, read(() => loc.pathname), read(() => loc.reload()), typeof loc.replace];
        })()
      JS
    end

    # …a check of the Location's members alone, a script's: what the bindings' own steps read of the document's URL —
    # `pushState`'s, an XMLHttpRequest's, a host query's — no Location of its, which HTML puts no check on.
    it "keeps the members it puts no check on to a script no longer same origin-domain with the window" do
      session.visit '/same'
      poll_until { session.evaluate_script("frames[0].document.title === 'child'") }
      expect(session.within_frame(0) { session.evaluate_script(<<~JS) }).to eq(['pushed', 'opened', 'SecurityError'])
        (() => {
          const [history, xhr, loc] = [parent.history, new parent.XMLHttpRequest(), parent.location];
          document.domain = document.domain;
          const t = (f) => { try { return f(); } catch (e) { return e.name; } };
          return [t(() => { history.pushState(null, '', '/x'); return 'pushed'; }), t(() => { xhr.open('GET', '/blank'); return 'opened'; }), t(() => loc.pathname)];
        })()
      JS
      expect(session.evaluate_script('location.pathname')).to eq('/x')
    end

    # …and a javascript: URL runs in a frame of another origin same origin-domain with the navigating document (HTML
    # "navigate" step: the initiator origin same origin-domain with the target's document's).
    it 'runs a javascript: URL in a frame same origin-domain with the document navigating it' do
      session.execute_script("document.domain = 'example.com'")
      session.within_frame(0) { session.execute_script('join()') }
      session.execute_script("frames[0].location.href = 'javascript:void (window.ran = 1)'")
      expect(poll_until { session.evaluate_script('frames[0].ran') }).to eq(1)
    end

    # …but `document.open()` of a document not of its origin, however joined, is a SecurityError (HTML "document open
    # steps" step 3: same origin, not same origin-domain).
    it "refuses to open a document same origin-domain but not same origin" do
      session.execute_script("document.domain = 'example.com'")
      session.within_frame(0) { session.execute_script('join()') }
      expect(session.evaluate_script(<<~JS)).to eq(['child', 'SecurityError'])
        (() => {
          const doc = frames[0].document;
          try { doc.open(); return [doc.title, 'opened']; } catch (e) { return [doc.title, e.name]; }
        })()
      JS
    end
  end

  # A write is a no-op in an origin-keyed agent cluster (HTML setter step 6): a document whose response asked for one —
  # `Origin-Agent-Cluster: ?1`, heeded in a secure context alone — or one of an origin whose first document in its
  # browsing context group did (the historical agent cluster key map), its `originAgentCluster` true. HTML and Firefox
  # key by site unless asked (Chrome by origin unless asked not to, `?0`; measured).
  describe 'in an origin-keyed agent cluster', :https, :every_host_local do
    let(:pages) do
      {
        '/'      => ['?1', '<!DOCTYPE html><meta charset="utf-8"><iframe src="/plain"></iframe><iframe src="https://a.example.com/keyed"></iframe>'],
        '/plain' => [nil, '<!DOCTYPE html><meta charset="utf-8"><title>plain</title><iframe src="https://b.example.com/keyed"></iframe>'],
        '/keyed' => ['?1', '<!DOCTYPE html><meta charset="utf-8"><title>keyed</title>'],
        '/zero'  => ['?0', '<!DOCTYPE html><meta charset="utf-8">']
      }
    end
    let(:session) do
      simulated_session(lambda {|env|
        oac, body = pages.fetch(env['PATH_INFO'], [nil, ''])
        [200, {'content-type' => 'text/html'}.merge(oac ? {'origin-agent-cluster' => oac} : {}), [body]]
      })
    end
    let(:write) do
      "(() => { const before = [originAgentCluster, document.domain]; document.domain = 'example.com'; return [...before, document.domain]; })()"
    end

    # (…and the next document of the origin in the window's group keyed so too, whatever its response says)
    it 'leaves the domain as it is where the response asked for one' do
      session.visit '/'
      expect(session.evaluate_script(write)).to eq([true, 'www.example.com', 'www.example.com'])
      session.visit '/zero'
      expect(session.evaluate_script(write)).to eq([true, 'www.example.com', 'www.example.com'])
    end

    it 'sets it where none asked' do
      session.visit '/zero'
      expect(session.evaluate_script(write)).to eq([false, 'www.example.com', 'example.com'])
    end

    # (…a session reset a new browsing context's, of a group of its own: what a test's documents asked none of the next's)
    # (…nor a write counted: what a WindowProxy's memo keys on, and a Location's check skips nothing for, none again)
    it "keys a reset session's documents afresh" do
      session.visit '/'
      session.reset!
      session.visit '/zero'
      expect(session.evaluate_script(write)).to eq([false, 'www.example.com', 'example.com'])
      expect(session.evaluate_script('__dom.domainWrites[0]')).to be_positive
      session.reset!
      session.visit '/zero'
      expect(session.evaluate_script('__dom.domainWrites[0]')).to eq(0)
    end

    it 'keys a document by what the first of its origin in its group asked' do
      session.visit '/'
      poll_until { session.within_frame(1) { session.evaluate_script('document.title') } == 'keyed' }
      expect(session.within_frame(0) { session.evaluate_script('originAgentCluster') }).to be(true)
      expect(session.within_frame(1) { session.evaluate_script('originAgentCluster') }).to be(true)
      session.within_frame(0) do
        poll_until { session.within_frame(0) { session.evaluate_script('document.title') } == 'keyed' }
        expect(session.within_frame(0) { session.evaluate_script(write) }).to eq([true, 'b.example.com', 'b.example.com'])
      end
    end

    it 'heeds no request of a document that is no secure context' do
      session.visit 'http://www.example.com/'
      expect(session.evaluate_script(write)).to eq([false, 'www.example.com', 'example.com'])
    end
  end

  it "is its creator's for a document with no browsing context, which may not set it" do
    s = session
    expect(s.evaluate_script(<<~JS)).to eq([true, "SecurityError: Failed to set the 'domain' property on 'Document': A browsing context is required to set a domain."])
      (() => {
        const d = document.implementation.createHTMLDocument('');
        let set = 'set';
        try { d.domain = 'x'; } catch (e) { set = e.name + ': ' + e.message; }
        return [d.domain === document.domain && d.domain !== '', set];
      })()
    JS
  end
end
