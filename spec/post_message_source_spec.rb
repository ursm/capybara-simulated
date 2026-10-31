require 'capybara/simulated'
require 'rusty_racer'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# A message's `source` is the WindowProxy of the incumbent settings object's global — the realm whose script called
# `postMessage` (HTML "window post message steps" 8) — whichever realm holds the WindowProxy it was called on: a frame
# posting through a reference its page keeps posts as the frame, not as the page (B10) — and through the page's own
# `postMessage` called on another window or on the page itself. Each `postMessage` is an operation of the engine's
# (`incumbentOperation`), a native function, which V8's incumbent context answers.
RSpec.describe "a message's source" do
  include PollUntil

  let(:app) {
    lambda do |env|
      body = case env['PATH_INFO']
             when '/frame' then "<script>window.up = () => parent.postMessage('up', '*'); window.over = () => top.w.postMessage('over', '*'); window.across = () => top.frames[1].postMessage('across', '*'); window.borrowed = () => { top.pm.call(top.w, 'borrowed', '*'); top.pm.call(top, 'home', '*'); }; window.queued = () => queueMicrotask(top.w.postMessage.bind(top.w, 'queued', '*')); top.kept = () => top.w.postMessage('kept', '*');</script>"
             when '/away' then '<p id=away>away</p>'
             when '/popup' then '<script>window.got = []; onmessage = (e) => got.push([e.data, e.source === opener.frames[0], e.source === opener]);</script>'
             when '/sibling' then '<script>window.got = []; onmessage = (e) => got.push([e.data, e.source === parent.frames[0], e.source === parent]);</script>'
             else '<script>window.pm = postMessage; window.got = []; onmessage = (e) => got.push([e.data, e.source === frames[0], e.source === window]);</script><iframe src=/frame></iframe><iframe src=/sibling></iframe>'
             end
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8>#{body}"]]
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit 'http://a.test/page' }

  it 'is the frame whose script posted through a WindowProxy its page holds' do
    session.execute_script("window.w = open('/popup')")
    poll_until { session.evaluate_script('w.document.readyState') == 'complete' }
    session.execute_script('frames[0].up(); frames[0].over(); frames[0].across()')
    poll_until { session.evaluate_script('got.length + w.got.length + frames[1].got.length') == 3 }

    expect(session.evaluate_script('got')).to eq([['up', true, false]])
    expect(session.evaluate_script('w.got')).to eq([['over', true, false]])
    expect(session.evaluate_script('frames[1].got')).to eq([['across', true, false]])
  end

  # (…the page's own `postMessage`, which a frame's script calls on the pop-up and on the page: the frame's still — and a
  # bound one the frame queued as a job, whose incumbent V8 takes from the job's own context, the frame's here)
  it "is the frame whose script called the page's own postMessage, or queued a bound one" do
    session.execute_script("window.w = open('/popup')")
    poll_until { session.evaluate_script('w.document.readyState') == 'complete' }
    session.execute_script('frames[0].borrowed(); frames[0].queued()')
    poll_until { session.evaluate_script('got.length + w.got.length') == 3 }

    expect(session.evaluate_script('got')).to eq([['home', true, false]])
    expect(session.evaluate_script('w.got')).to eq([['borrowed', true, false], ['queued', true, false]])
  end

  # (…and the script of a frame's document navigated away from, a function the page kept of it: its message that
  # document's — its source the frame's WindowProxy, which answers for the frame's document now, its origin the old
  # document's — never the page's whose WindowProxy it was posted through)
  it "is the frame's WindowProxy for a document of it navigated away from, its origin that document's", :every_host_local do
    session.execute_script("window.w = open('/popup')")
    poll_until { session.evaluate_script('w.document.readyState') == 'complete' }
    session.execute_script(%q{w.eval("addEventListener('message', (e) => { if (e.data === 'kept') opener.kept_seen = [e.source === opener.frames[0], e.source === opener, e.origin]; })")})
    session.execute_script("frames[0].location = 'http://b.test/away'")
    poll_until { session.within_frame(0) { session.evaluate_script("location.host") } == 'b.test' }
    session.execute_script('kept()')
    poll_until { session.evaluate_script('window.kept_seen') }

    expect(session.evaluate_script('kept_seen')).to eq([true, false, 'http://a.test'])
  end

  # (…the window's own `postMessage` one object as long as its Window is: kept as a pop-up's initial about:blank goes on
  # to a document of its origin)
  it "keeps a kept Window's own postMessage" do
    session.execute_script("window.w = open(''); window.before = w.eval('postMessage'); w.location = '/popup'")
    poll_until { session.evaluate_script('w.document.readyState === "complete" && w.location.pathname === "/popup"') }
    expect(session.evaluate_script("[w.eval('postMessage') === before, typeof w.got]")).to eq([true, 'object'])
  end

  it 'is no constructor' do
    session.execute_script("window.w = open('/popup')")
    expect(session.evaluate_script('[w, window].map((x) => { try { new x.postMessage("x", "*"); return "made"; } catch (e) { return e.name; } })')).to eq(%w[TypeError TypeError])
  end

  it 'is the page whose own script posted through the same WindowProxy' do
    session.execute_script("window.w = open('/popup')")
    poll_until { session.evaluate_script('w.document.readyState') == 'complete' }
    session.execute_script("w.postMessage('own', '*')")
    poll_until { session.evaluate_script('w.got.length') == 1 }

    expect(session.evaluate_script('w.got')).to eq([['own', false, true]])
  end
end
