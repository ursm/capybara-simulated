# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# What the document a navigation commits is made of is decided once, for the page and a window `window.open` made alike
# (document_init.rs, HTML "create and initialize a Document object"): here, the service worker that controls it — the one
# its fetch matched (Service Workers §2.5.1), none for a document whose response's Content-Security-Policy sandboxes it
# into an opaque origin, though the worker answered its navigation ("Sandboxed iframes … result in having the active
# service worker value of null as their origin is an opaque origin"; Chrome 157 and Firefox 159, measured 2026-11-25: a
# top-level `sandbox allow-scripts` document's fetch goes to the network, a plain one's to the worker).
RSpec.describe 'a document a navigation commits' do
  include PollUntil

  let(:worker) {
    <<~JS
      self.addEventListener('install', e => self.skipWaiting());
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', e => {
        if (new URL(e.request.url).pathname === '/probe') e.respondWith(new Response('worker'));
      });
    JS
  }
  let(:app) {
    sw = worker
    show = "<script>fetch('/probe').then(r => r.text()).then(t => { document.title = t; })</script>"
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [sw]]
        when '/probe' then [200, {'content-type' => 'text/plain', 'access-control-allow-origin' => '*'}, ['network']]
        when '/sandboxed' then [200, {'content-type' => 'text/html', 'content-security-policy' => 'sandbox allow-scripts'}, ["<!doctype html>#{show}"]]
        when '/plain' then [200, {'content-type' => 'text/html'}, ["<!doctype html>#{show}"]]
        else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><body>page']]
        end
      }
    }.to_app
  }

  def registered(session)
    session.visit '/'
    session.execute_script("navigator.serviceWorker.register('/sw.js')")
    poll_until { session.evaluate_script('navigator.serviceWorker.controller !== null') }
  end

  it "is the page's, controlled by no worker where its response's CSP sandboxes it" do
    session = simulated_session(app)
    registered(session)
    session.visit '/plain'
    expect(poll_until { session.evaluate_script('document.title').then {|t| t.empty? ? nil : t } }).to eq('worker')
    session.visit '/sandboxed'
    expect(poll_until { session.evaluate_script('document.title').then {|t| t.empty? ? nil : t } }).to eq('network')
  end

  it "is a window's, controlled by no worker where its response's CSP sandboxes it" do
    session = simulated_session(app)
    registered(session)
    session.execute_script("window.w = open('/plain')")
    expect(poll_until { session.evaluate_script('w.document.title').then {|t| t.empty? ? nil : t } }).to eq('worker')
    session.execute_script("w.location = '/sandboxed'")
    session.switch_to_window(session.windows.last)
    expect(poll_until { session.evaluate_script('document.title').then {|t| t.empty? ? nil : t } }).to eq('network')
  end

  # …and the origin of the document a `javascript:` URL's string result makes of a window `open()` made: the document
  # it replaces' own — here a frame's, of another origin than the page — never the page's (HTML "evaluate a javascript:
  # URL": the new document's origin the navigable's active document's).
  it "is a window's javascript: URL document, of the origin of the one it replaces", :every_host_local do
    framed = lambda {|env|
      case env['HTTP_HOST']
      when 'b.test' then [200, {'content-type' => 'text/html'}, ['<!doctype html><script>window.w = open("")</script>']]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><iframe src="https://b.test/fr"></iframe>']]
      end
    }
    session = simulated_session(framed)
    session.visit 'https://a.test/top'
    session.within_frame(0) do
      expect(poll_until { session.evaluate_script('window.w && w.origin') }).to eq('https://b.test')
      session.execute_script(%q(w.location = 'javascript:"<p id=x>js</p>"'))
      expect(poll_until { session.evaluate_script('w.document.getElementById("x") && w.origin') }).to eq('https://b.test')
    end
  end

  # …and the policy container of an about:blank document its initiator's (HTML "determine navigation params policy
  # container" step 3), its CSP list with it: a page sandboxed by its response's CSP, but for forms, that navigates
  # itself to about:blank leaves a document whose form submits nothing (Chrome 157 and Firefox 159, measured 2026-11-25:
  # the pop-up stays at about:blank; with `allow-forms` it goes to the form's action) — and so does the document a
  # traversal back to its entry makes again, of the policy container the entry kept (step 1), no initiator's.
  context 'of a local URL' do
    let(:sandboxed_app) {
      lambda {|env|
        case env['PATH_INFO']
        when '/sbx'
          [200, {'content-type' => 'text/html', 'content-security-policy' => 'sandbox allow-scripts allow-same-origin'}, ["<!doctype html><script>location = 'about:blank'</script>"]]
        else [200, {'content-type' => 'text/html'}, ["<!doctype html><title>#{env['PATH_INFO']}</title>"]]
        end
      }
    }
    def submit_a_form(session)
      session.execute_script(%q(document.body.innerHTML = '<form action="http://www.example.com/submitted"><input name=q value=1></form>'; document.forms[0].submit()))
      session.evaluate_script('1')
      session.current_url
    end

    it "is its initiator's policy container, its CSP list's sandbox too, and its entry's on a traversal" do
      session = simulated_session(sandboxed_app)
      session.visit '/sbx'
      expect(poll_until { session.current_url == 'about:blank' }).to be(true)
      expect(submit_a_form(session)).to eq('about:blank')
      session.visit '/other'
      session.go_back
      expect(poll_until { session.current_url == 'about:blank' }).to be(true)
      expect(submit_a_form(session)).to eq('about:blank')
      # (…of the origin its entry's document state is of, the user's traversal no initiator of it: HTML "determine the
      # origin"; Chrome 157 and Firefox 159 alike, 2026-11-26: a pop-up back at an about:blank its opener made reads its
      # opener's origin)
      expect(session.evaluate_script('self.origin')).to eq('http://www.example.com')
    end

    # …its initiator's being the document that began its navigation, not its container's: a frame sandboxed by its CSP
    # that navigates itself to about:blank leaves a document sandboxed as it was, under a parent of no CSP (Chrome 157 and
    # Firefox 159, 2026-11-26: its form submits nothing, and does with `allow-forms`). (A sandboxed frame navigates no
    # sibling: both refuse it, "does not have permission to navigate the target frame".)
    it "is a frame's, the policy container of the document that navigated it" do
      framed = lambda {|env|
        case env['PATH_INFO']
        when '/a' then [200, {'content-type' => 'text/html', 'content-security-policy' => 'sandbox allow-scripts allow-same-origin'}, ['<!doctype html><p>a']]
        else [200, {'content-type' => 'text/html'}, ['<!doctype html><iframe name=a src=/a></iframe>']]
        end
      }
      session = simulated_session(framed)
      session.visit '/'
      session.within_frame('a') { session.execute_script("location = 'about:blank'") }
      expect(poll_until { session.evaluate_script('frames.a.location.href') == 'about:blank' }).to be(true)
      session.execute_script(%q(const d = frames.a.document; d.body.innerHTML = '<form action="http://www.example.com/submitted"><input name=q value=1></form>'; d.forms[0].submit()))
      session.evaluate_script('1')
      expect(session.evaluate_script('frames.a.location.href')).to eq('about:blank')
    end

    # …and a frame's about:blank document made again — a traversal back to it, a reload of it — of the policy container
    # its entry kept (step 1), the sandbox of its CSP list its flags too, as at first (Chrome 157 and Firefox 159 keep it).
    it "is a frame's entry's again on a traversal and a reload, its CSP sandbox with it" do
      framed = lambda {|env|
        case env['PATH_INFO']
        when '/a' then [200, {'content-type' => 'text/html', 'content-security-policy' => 'sandbox allow-same-origin'}, ['<!doctype html><a href="about:blank">go</a>']]
        when '/' then [200, {'content-type' => 'text/html'}, ['<!doctype html><iframe name=a src=/a></iframe>']]
        else [200, {'content-type' => 'text/html'}, ["<!doctype html><title>#{env['PATH_INFO']}</title>"]]
        end
      }
      runs = lambda {|s|
        s.evaluate_script(<<~JS)
          (() => {
            window.ran = 0;
            const d = frames.a.document, sc = d.createElement('script');
            sc.textContent = 'parent.ran = 1';
            (d.body || d.documentElement).append(sc);
            return window.ran ? 'scripts run' : 'sandboxed';
          })()
        JS
      }
      session = simulated_session(framed)
      session.visit '/'
      session.within_frame('a') { session.click_link 'go' }
      expect(poll_until { session.evaluate_script('frames.a.location.href') == 'about:blank' }).to be(true)
      seen = [runs.(session)]
      session.execute_script("frames.a.location = '/y'")
      poll_until { (session.evaluate_script('frames.a.document.title') rescue nil) == '/y' }
      session.go_back
      expect(poll_until { (session.evaluate_script('frames.a.location.href') rescue nil) == 'about:blank' }).to be(true)
      seen << runs.(session)
      session.execute_script('frames.a.location.reload()')
      session.evaluate_script('1')
      seen << runs.(session)
      expect(seen).to eq(%w[sandboxed sandboxed sandboxed])
    end

    # …and one a script's traversal makes again of the origin its entry's document state is of — none, the user's
    # about:blank: a new opaque origin, not the origin of the document whose script asked for it (HTML "determine the
    # origin").
    it "is of its entry's opaque origin on a script's traversal back" do
      session = simulated_session(sandboxed_app)
      session.visit 'about:blank'
      session.visit '/x'
      session.execute_script('history.back()')
      expect(poll_until { session.current_url == 'about:blank' }).to be(true)
      expect(session.evaluate_script('self.origin')).to eq('null')
    end
  end
end
