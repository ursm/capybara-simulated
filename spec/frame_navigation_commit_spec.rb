# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A frame's navigation adds its entry to the joint session history only as it makes its document (HTML "finalize a
# cross-document navigation", navigation_commit.rs): `history.length` read as its response is awaited the one before it,
# and one that makes none — a 204, a download — leaves the history as it was. Chrome 157 and Firefox 159 alike, measured
# 2026-11-08 (~/.local/share/csim-bench/nc2/probe): a frame at /a navigated to a response that takes 1.5 s reads `1 /a`
# 300 ms in and `2 /slow` once it is in, by its location, its container's `src` and a link in it alike; to a 204 or a
# download `1 /a` before and after.
RSpec.describe 'a frame navigation’s session history entry' do
  include PollUntil

  let(:session) {
    simulated_session(lambda {|env|
      path = env['PATH_INFO']
      sleep(0.3) if path.start_with?('/slow')
      next [204, {}, []] if path == '/nc'
      next [200, {'content-type' => 'application/octet-stream', 'content-disposition' => 'attachment; filename=x.bin'}, ['x']] if path == '/dl'

      body = {
        '/top'   => '<iframe src="/a"></iframe>',
        '/blank' => '<iframe></iframe>',
        '/nest'  => '<iframe src="/mid"></iframe>',
        '/mid'   => '<iframe name=inner></iframe><form id=f method=post target=inner action=/echo><input name=q value=v></form>',
        '/echo'  => env['REQUEST_METHOD']
      }.fetch(path) { "<a id=l href='/slow'>slow</a>#{path}" }
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><title>#{path}</title><body>#{body}"]]
    })
  }

  def frame_path = session.evaluate_script('frames[0].location.pathname')
  def length = session.evaluate_script('history.length')

  # (…its container's `src` alike in both browsers; here that navigation's fetch is made inside the task that makes its
  # document, so no timer runs as its response is awaited — a gap of the fetch's, not of the entry's)
  {
    'its location' => "frames[0].location = '/slow'",
    'a link in it' => "frames[0].document.getElementById('l').click()"
  }.each do |by, script|
    it "is made as its document is, by #{by}" do
      session.visit('/top')
      session.execute_script("sessionStorage.n = ''; #{script}; setTimeout(() => { sessionStorage.n = history.length + ' ' + frames[0].location.pathname; }, 30)")
      expect(poll_until { frame_path == '/slow' }).to be(true)
      expect(session.evaluate_script('sessionStorage.n')).to eq('1 /a')
      expect(length).to eq(2)
      session.go_back
      expect(frame_path).to eq('/a')
    end
  end

  {'a 204' => '/nc', 'a download' => '/dl'}.each do |what, path|
    it "is none of #{what}, the history as it was" do
      session.visit('/top')
      session.execute_script("frames[0].location = '/b'")
      expect(poll_until { frame_path == '/b' }).to be(true)
      session.execute_script("frames[0].location = '#{path}'")
      session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 50))')
      expect([frame_path, length]).to eq(['/b', 2])
      session.go_back
      expect(frame_path).to eq('/a')
      session.go_forward
      expect(frame_path).to eq('/b')
    end
  end

  # (…and in place of the frame's initial about:blank — HTML "navigate": a navigable whose active document is its initial
  # about:blank replaces it — still where one before made no document there, or was ended by another)
  ["frames[0].location = '/nc'", "frames[0].location = '/dl'", "frames[0].location = '/slow'; setTimeout(() => { frames[0].location = '/b'; }, 30)"].each do |first|
    it "replaces the initial about:blank after #{first}" do
      session.visit('/blank')
      session.execute_script(first)
      session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 50))')
      session.execute_script("frames[0].location = '/b'") unless first.include?("'/b'")
      expect(poll_until { frame_path == '/b' }).to be(true)
      session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 400))')
      expect([frame_path, length]).to eq(['/b', 1])
    end
  end

  # (…and a frame's frame's alike, its parent's entry made as it is: a POST's result a reload re-posts — Chrome)
  it 'is made for a frame two levels down replacing its initial about:blank, a reload re-posting it' do
    session.visit('/nest')
    expect(poll_until { session.evaluate_script('frames[0].document.readyState') == 'complete' }).to be(true)
    session.execute_script("frames[0].document.getElementById('f').submit()")
    expect(poll_until { session.evaluate_script('frames[0].frames[0].location.pathname') == '/echo' }).to be(true)
    session.execute_script('frames[0].frames[0].location.reload()')
    session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 300))')
    expect(session.evaluate_script('frames[0].frames[0].document.body.textContent')).to eq('POST')
  end

  # (…and goes on past a traversal that changes another navigable's entry alone — HTML "apply the history step" ends the
  # ongoing navigations of the navigables whose current entry changes: Chrome 157 and Firefox 159 reach /slow, `history.length`
  # 2, the hash gone)
  it 'is made past a traversal of the page within its document as its response is awaited' do
    session.visit('/top')
    expect(poll_until { frame_path == '/a' }).to be(true)
    session.execute_script("history.pushState(null, '', '#x')")
    session.execute_script("frames[0].location = '/slow'; setTimeout(() => { history.back(); }, 30)")
    expect(poll_until { frame_path == '/slow' }).to be(true)
    session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 400))')
    expect([frame_path, length, session.evaluate_script('location.hash')]).to eq(['/slow', 2, ''])
  end

  # (…and none of a navigation handed to another application from an entered frame, which no reload after makes either)
  it 'is none of a URL handed off, a reload after it making none' do
    session.visit('/top')
    session.within_frame(0) do
      session.execute_script("location = '/b'")
      expect(poll_until { session.evaluate_script('location.pathname') == '/b' }).to be(true)
      session.execute_script("location = 'mailto:x@example.com'")
      session.execute_script('location.reload()')
      session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 50))')
    end
    expect([frame_path, length]).to eq(['/b', 2])
  end

  # (…and the entry a navigation that ended another one makes is its own alone: the first one's never made)
  it 'is the last navigation’s alone where one ends another as its response is awaited' do
    session.visit('/top')
    session.execute_script("frames[0].location = '/slow'; setTimeout(() => { frames[0].location = '/b'; }, 30)")
    expect(poll_until { frame_path == '/b' }).to be(true)
    session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 400))')
    expect([frame_path, length]).to eq(['/b', 2])
    session.go_back
    expect(frame_path).to eq('/a')
  end
end
