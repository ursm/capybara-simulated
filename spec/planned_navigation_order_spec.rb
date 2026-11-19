# frozen_string_literal: true

require 'capybara/simulated'
require 'tmpdir'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# What the documents of a page planned is taken as one queue, in the order it was planned (navigation_plan.rs
# `plannedNext`, browser.rb `take_planned`): each `location`, each "plan to navigate" in turn, whatever kind of
# navigable it navigates.
RSpec.describe 'the navigations a page planned' do
  include PollUntil

  def logged_session(body)
    log = []
    session = simulated_session(lambda {|env|
      log << "#{env['PATH_INFO']}#{"?#{env['QUERY_STRING']}" unless env['QUERY_STRING'].to_s.empty?}"
      page = env['PATH_INFO'] == '/two' ? body : "<title>#{env['PATH_INFO']}</title>#{env['PATH_INFO']}"
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8>#{page}"]]
    })
    [session, log]
  end

  # A click's submission, and a 0 ms timer its handler queued that planned another navigation as the click's tasks ran:
  # the one planned after supersedes the submission (HTML "navigate" — a reload's history step, a traversal, a
  # hyperlink's navigation — Chrome 157 alike: reload `/two /two`, back `/first`, link `/hl`), taken as the click ends,
  # not left until the driver's next call.
  {
    'a reload'     => ['location.reload()', '/two'],
    'a hyperlink'  => ["document.getElementById('hl').click()", '/hl'],
    'a `location`'  => ["location = '/loc'", '/loc']
  }.each do |name, (script, landed)|
    it "takes #{name} a click's timer planned in place of its submission" do
      session, log = logged_session(<<~HTML)
        <title>two</title><a id=hl href=/hl>hl</a>
        <form action=/land><input name=k value=form><button id=b>sub</button></form>
        <script>document.getElementById('b').onclick = () => { setTimeout(() => { #{script} }, 0) }</script>
      HTML
      session.visit '/two'
      log.clear
      session.click_button 'b'
      expect(log).to eq([landed])
      expect(log).not_to include('/land?k=form')
    end
  end

  # (…a download its handler's hyperlink planned taken with the submission)
  it "downloads what a click's handler's `download` hyperlink planned, then submits" do
    Dir.mktmpdir do |dir|
      ENV['CSIM_DOWNLOADS_DIR'] = dir
      session, log = logged_session(<<~HTML)
        <title>two</title><form action=/land><input name=k value=form><button id=b>sub</button></form>
        <script>document.getElementById('b').onclick = () => { const a = document.createElement('a'); a.href = '/dl'; a.download = 'x'; document.body.append(a); a.click() }</script>
      HTML
      session.visit '/two'
      log.clear
      session.click_button 'b'
      expect(log).to eq(['/dl', '/land?k=form'])
    ensure
      ENV.delete('CSIM_DOWNLOADS_DIR')
    end
  end

  # A frame's `location` and a window's set in one task are requested in that order (Chrome 157, Firefox 159).
  it "takes a frame's navigation and a window's in the order they were planned" do
    session, log = logged_session('<iframe id=fr src=/f0></iframe><script>window.w = open("/w0")</script>')
    session.visit '/two'
    poll_until { log.include?('/w0') && log.include?('/f0') }
    log.clear
    session.execute_script("fr.contentWindow.location = '/f'; w.location = '/w'")
    session.evaluate_script('1')
    expect(log).to eq(['/f', '/w'])
  end

  # A form of a srcdoc frame navigates the frame to its action — about:blank's here, its query empty — not to the srcdoc
  # again: only "process the iframe attributes" reads `srcdoc` (Chrome and Firefox: `about:blank?`).
  it "navigates a srcdoc frame's form to its action" do
    session, = logged_session(%q(<iframe id=fr srcdoc='<form id=f action="about:blank"></form>'></iframe>))
    session.visit '/two'
    session.execute_script("fr.contentDocument.getElementById('f').submit()")
    expect(poll_until { session.evaluate_script('fr.contentWindow.location.href') == 'about:blank?' }).to be(true)
  end
end

# A response that downloads where its document may not download (a sandboxed frame's, a CSP-sandboxed page's) is saved
# by none, its body let go unread all the same: Rack's close contract.
RSpec.describe 'a download refused' do
  closes = Hash.new(0)
  let(:body_class) do
    Class.new do
      define_method(:initialize) {|key, closes| @key, @closes = key, closes }
      define_method(:each) {|&b| b.call('x') }
      define_method(:close) { @closes[@key] += 1 }
    end
  end
  let(:session) do
    body_class = self.body_class
    simulated_session(lambda {|env|
      case env['PATH_INFO']
      when %r{\A/dl/(\w+)} then [200, {'content-type' => 'application/octet-stream', 'content-disposition' => 'attachment; filename=a.bin'}, body_class.new($1, closes)]
      when '/top' then [200, {'content-type' => 'text/html'}, ['<!doctype html><iframe id=s sandbox="allow-scripts allow-same-origin" src="/x"></iframe>']]
      when '/csp' then [200, {'content-type' => 'text/html', 'content-security-policy' => 'sandbox allow-scripts allow-same-origin'}, ['<!doctype html><title>csp</title>']]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><title>x</title>']]
      end
    })
  end

  it 'closes its body' do
    session.visit '/top'
    session.execute_script("document.getElementById('s').contentWindow.location = '/dl/frame'")
    session.evaluate_script('1')
    session.visit '/csp'
    session.execute_script("location = '/dl/page'")
    session.evaluate_script('1')
    expect(closes.values_at('frame', 'page')).to eq([1, 1])
  end
end
