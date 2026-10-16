# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

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
  # domain is, or is a subdomain of, which it then is.
  it "is an inherited origin's, and set only to the domain or one it is a subdomain of" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><iframe></iframe>']] })
    s.visit '/'
    expect(s.evaluate_script(<<~JS)).to eq(['www.example.com', 'www.example.com', 'SecurityError', 'SecurityError', 'example.com', 'SecurityError'])
      (() => {
        const tried = (value) => { try { document.domain = value; return document.domain; } catch (e) { return e.name; } };
        return [frames[0].document.domain, tried('WWW.Example.COM'), tried('example.org'), tried(''), tried('example.com'), tried('www.example.com')];
      })()
    JS
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
