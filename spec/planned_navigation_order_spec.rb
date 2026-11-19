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

  # Frames' and a window's `location` set in one task are requested in that order, plan by plan — not kind by kind
  # (Chrome 157, Firefox 159: /f then /w).
  it "takes frames' navigations and a window's in the order they were planned" do
    session, log = logged_session('<iframe id=fr src=/f0></iframe><iframe id=fr2 src=/g0></iframe><script>window.w = open("/w0")</script>')
    session.visit '/two'
    poll_until { (%w[/w0 /f0 /g0] - log).empty? }
    log.clear
    session.execute_script("fr.contentWindow.location = '/f'; w.location = '/w'; fr2.contentWindow.location = '/g'")
    session.evaluate_script('1')
    expect(log).to eq(%w[/f /w /g])
  end

  # A frame's `location` and then its own form submitted to its sibling: the form's task runs before the frame's
  # navigation's response, its document still there — Chrome 157 and Firefox 159 request /z, then post.
  it "posts a frame's form submitted after its own `location`, in that order" do
    log = []
    session = simulated_session(lambda {|env|
      log << "#{env['REQUEST_METHOD']} #{env['PATH_INFO']}"
      body = case env['PATH_INFO']
             when '/two' then '<iframe name=x src=/gx></iframe><iframe name=y src=/y0></iframe>'
             when '/gx' then '<form id=f method=post action=/posted target=y></form>'
             else env['PATH_INFO']
             end
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8>#{body}"]]
    })
    session.visit '/two'
    poll_until { log.include?('GET /y0') }
    log.clear
    session.execute_script("frames[0].location = '/z'; frames[0].f.submit()")
    session.evaluate_script('1')
    expect(log).to eq(['GET /z', 'POST /posted'])
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

# What a pass of the queue left — a navigation the document it made plans as it loads, of a kind the pass already took
# (`plannedThrough`) — is taken as the driver next reads the page, whichever read a Capybara wait re-calls: a matcher's
# wait polls a page that has no timer to step, and would otherwise see the chain stop where the driver's last call left it
# (browser.rb `take_plans_left`).
RSpec.describe 'a navigation the document a navigation made plans as it loads' do
  let(:session) do
    simulated_session(lambda {|env|
      n    = env['QUERY_STRING'].to_i
      body = if env['PATH_INFO'] == '/chain'
               "<title>chain#{n}</title><p id=c#{n}>c#{n}</p><script>#{"location = '/chain?#{n - 1}'" if n.positive?}</script>"
             else
               '<title>top</title><p>top</p>'
             end
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8>#{body}"]]
    })
  end

  waits = {
    'has_title?' => ->(s) { s.has_title?('chain0', wait: 2) },
    'has_css?'   => ->(s) { s.has_css?('#c0', wait: 2) },
    'find'       => ->(s) { s.find('#c0', wait: 2).text == 'c0' }
  }

  waits.each do |name, wait|
    [2, 3].each do |hops|
      it "is taken under #{name} in a pop-up that redirects itself #{hops} times" do
        session.visit '/top'
        popup = session.window_opened_by { session.execute_script("open('/chain?#{hops}', 'chain')") }
        expect(session.within_window(popup) { wait.(session) }).to be(true)
      end
    end

    it "is taken under #{name} after a navigation a script the driver ran made" do
      session.visit '/top'
      session.execute_script("location = '/chain?1'")
      expect(wait.(session)).to be(true)
      expect(session).to have_text('c0')
    end

    it "is taken under #{name} after a navigation a timer made" do
      session.visit '/top'
      session.execute_script("setTimeout(() => { location = '/chain?1' }, 10)")
      expect(wait.(session)).to be(true)
    end
  end

  # (…by a read that waits for nothing: the page it reads is the one a browser would show, its match or not)
  {
    'find'        => ->(s) { s.find('p', wait: 0).text },
    'title'       => ->(s) { s.title },
    'status_code' => ->(s) { s.status_code && s.evaluate_script('document.title') }
  }.each do |name, read|
    it "is taken by #{name} that waits for nothing" do
      session.visit '/top'
      session.execute_script("location = '/chain?3'")
      expect(read.(session)).to eq(name == 'find' ? 'c0' : 'chain0')
    end
  end

  # (…several passes a poll: a chain of documents each redirecting the next is followed as a browser follows it, at once,
  # not a hop a poll — and a `<meta>` refresh of 0 that never ends goes on at the next poll, never without end)
  it 'follows a long chain within one wait' do
    session.visit '/top'
    session.execute_script("location = '/chain?40'")
    expect(session).to have_title('chain0', wait: 2)
  end
end
