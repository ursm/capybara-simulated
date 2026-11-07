# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A page form's navigation of a frame its `target` names is PLANNED (HTML "plan to navigate"): its request sent as the
# planned navigation runs, and none where another navigation of the frame comes before it — the frame's `src` or
# `srcdoc` set, a link's targeting it, a reload (Chrome and Firefox, measured 2026-10-24: no POST, the frame at the later
# one's; Firefox sends a reload's POST).
RSpec.describe "a page form's planned navigation of a named frame" do
  def session_with(hits)
    simulated_session(lambda {|env|
      hits << "#{env['REQUEST_METHOD']} #{env['PATH_INFO']}"
      body = case env['PATH_INFO']
             when '/top' then '<iframe name=n id=fr src="/blank"></iframe><form id=f method=post target=n action="/x"></form><a id=l target=n href="/link">l</a>'
             else env['PATH_INFO']
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
  end

  {
    "the frame's src set" => ['fr.src = "/srcnav"', '/srcnav'],
    'a link targeting it' => ['l.click()', '/link']
  }.each do |name, (js, lands)|
    it "sends nothing where #{name} after it" do
      hits = []
      session = session_with(hits)
      session.visit '/top'
      session.execute_script("f.submit(); #{js}")
      expect(session.evaluate_script('frames[0].location.pathname')).to eq(lands)
      expect(hits).not_to include('POST /x')
    end
  end

  # …nor by one that starts no navigation: a javascript: URL's result, a fragment of the frame's document (HTML
  # "navigate" sets no ongoing navigation for either; Chrome and Firefox: the frame at /x, the POST sent).
  {
    "a javascript: URL's src" => 'fr.src = "javascript:\'<p>js\'"',
    "a link to the frame's own fragment" => 'l.href = "/blank#b"; l.click()'
  }.each do |name, js|
    it "goes on where #{name} comes after it" do
      hits = []
      session = session_with(hits)
      session.visit '/top'
      session.execute_script("f.submit(); #{js}")
      session.evaluate_script('1')
      expect(session.evaluate_script('frames[0].location.pathname')).to eq('/x')
      expect(hits).to include('POST /x')
    end
  end

  # A form's plan begins its navigation before a `javascript:` URL's task runs, which it ends in either order, whatever
  # HTML queues them on: no script run (Chrome and Firefox, measured 2026-11-07: whatwg/html#12120).
  ['f.submit(); frames[0].location = "javascript:parent.ran = true"', 'frames[0].location = "javascript:parent.ran = true"; f.submit()'].each do |js|
    it "runs no javascript: URL of a frame a form plans to navigate: #{js}" do
      hits = []
      session = session_with(hits)
      session.visit '/top'
      session.execute_script("window.ran = false; #{js}")
      session.evaluate_script('1')
      expect(session.evaluate_script('[ran, frames[0].location.pathname]')).to eq([false, '/x'])
      expect(hits).to include('POST /x')
    end
  end

  # A POST to a URL no network answers: `data:` and about:blank answer it as they answer a GET (Chrome and Firefox, measured
  # 2026-11-07), and a blob: URL with a network error — Fetch's blob scheme takes a GET alone (Chrome; Firefox renders it).
  it 'posts to a data: or an about:blank URL as it gets them, and a blob: one fails' do
    session = session_with([])
    session.visit '/top'
    session.execute_script('window.loads = 0; fr.onload = () => loads++; f.action = "about:blank"; f.submit()')
    session.evaluate_script('1')
    expect(session.evaluate_script('[frames[0].location.href, loads]')).to eq(['about:blank', 1])
    session.execute_script('f.action = "data:text/html,<title>dp</title>"; f.submit()')
    expect(session).to have_css('iframe')
    session.evaluate_script('1')
    expect(session.evaluate_script('loads')).to eq(2)
    expect(session.evaluate_script('fr.contentDocument')).to be_nil
    session.execute_script('f.action = URL.createObjectURL(new Blob(["<title>bl</title>"], {type: "text/html"})); f.submit()')
    session.evaluate_script('1')
    expect(session.evaluate_script('loads')).to eq(3)
    expect(session.evaluate_script('fr.contentDocument')).to be_nil
  end

  # An action that is no URL ends the submission and leaves what is planned (HTML "submit" step 14).
  it 'goes on with the plan before it where a submission of no URL comes after' do
    hits = []
    session = session_with(hits)
    session.visit '/top'
    session.execute_script('const g = document.createElement("form"); g.target = "n"; g.setAttribute("action", "http://[x"); document.body.append(g); f.submit(); g.submit()')
    session.evaluate_script('1')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/x')
    expect(hits).to include('POST /x')
  end

  # A frame whose navigation to its `src` has not got far makes none of it: the form's replaces it, in the entry of its
  # initial about:blank document (Chrome and Firefox, measured 2026-11-07: no script of it run, one `load`).
  it 'replaces the navigation to the src of a frame just inserted' do
    hits = []
    session = session_with(hits)
    session.visit '/top'
    hits.clear
    session.execute_script('window.loads = 0; const e = document.createElement("iframe"); e.name = "m"; e.src = "/src"; e.onload = () => loads++; document.body.append(e); f.target = "m"; f.submit()')
    session.evaluate_script('1')
    expect(session.evaluate_script('[frames[1].location.pathname, loads, history.length]')).to eq(['/x', 1, 1])
    expect(hits).not_to include('GET /src')
  end

  # …and goes to the frame that had the name as it was submitted, whatever it is called after (Chrome and Firefox).
  it 'navigates the frame it chose as it was submitted, its name changed since' do
    session = session_with([])
    session.visit '/top'
    session.execute_script('f.submit(); fr.name = "other"')
    session.evaluate_script('1')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/x')
  end

  # …into a frame of a frame's document too, its request the form's as it was submitted, whatever the page does after.
  it "navigates a frame of a frame's document, by that frame's form" do
    session = session_with([])
    session.visit '/top'
    session.execute_script('frames[0].document.body.innerHTML = "<iframe name=in></iframe><form id=g action=/in target=in><input name=a value=1></form>"')
    session.execute_script('frames[0].g.submit(); frames[0].g.a.value = 2')
    session.evaluate_script('1')
    expect(session.evaluate_script('frames[0].frames[0].location.pathname + frames[0].frames[0].location.search')).to eq('/in?a=1')
  end

  # A form's document no longer fully active takes its plan with it: its frame removed (HTML "plan to navigate" queues on the
  # form's document), reloaded (Chrome and Firefox send none, measured 2026-11-07).
  {
    "its document's frame removed"  => 'frames[0].g.submit(); fr.remove()',
    "its document's frame reloaded" => 'frames[0].g.submit(); frames[0].location.reload()'
  }.each do |name, js|
    it "sends nothing of a frame's form into its own frame, #{name}" do
      hits = []
      session = session_with(hits)
      session.visit '/top'
      session.execute_script('frames[0].document.body.innerHTML = "<iframe name=in></iframe><form id=g method=post action=/in target=in></form>"')
      session.execute_script(js)
      session.evaluate_script('1')
      expect(hits).not_to include('POST /in')
    end
  end

  # …the page's own reload likewise (Chrome and Firefox: the frame at its `src`).
  it "sends nothing of a page's form into its frame where the page reloads" do
    hits = []
    session = session_with(hits)
    session.visit '/top'
    session.execute_script('f.submit(); location.reload()')
    session.evaluate_script('1')
    expect(hits).not_to include('POST /x')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/blank')
  end

  # A navigation of a frame to a URL of no fetch scheme is handed to external software, the frame at its document: no entry,
  # no `load` (HTML "navigate"; Chrome and Firefox, measured 2026-11-07).
  ['frames[0].location = "mailto:a@b.test"', 'f.action = "mailto:a@b.test"; f.submit()'].each do |js|
    it "leaves a frame where it is on #{js}" do
      session = session_with([])
      session.visit '/top'
      session.execute_script("window.loads = 0; fr.onload = () => loads++; #{js}")
      session.evaluate_script('1')
      expect(session.evaluate_script('[frames[0].location.pathname, loads, history.length]')).to eq(['/blank', 0, 1])
    end
  end

  # A `<frame>`'s navigation is of the destination "frame" (Chrome and Firefox).
  it "tells a form's navigation of a <frame> so" do
    dest = nil
    session = simulated_session(lambda {|env|
      dest = env['HTTP_SEC_FETCH_DEST'] if env['PATH_INFO'] == '/x'
      body = env['PATH_INFO'] == '/top' ? '<body><script>const e = document.createElement("frame"); e.name = "n"; e.src = "/blank"; document.body.append(e)</script>' : 'x'
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8>#{body}"]]
    })
    session.visit 'http://localhost/top'
    session.execute_script('const f = document.createElement("form"); f.action = "/x"; f.method = "post"; f.target = "n"; document.body.append(f); f.submit()')
    session.evaluate_script('1')
    expect(dest).to eq('frame')
  end

  # A `javascript:` action into a frame just inserted is a navigation that ends the one to its `src`, as HTML "navigate" has
  # it — the ruling here; Chrome and Firefox run the script and go on to the `src`.
  it 'ends the navigation to a src with a javascript: action' do
    hits = []
    session = session_with(hits)
    session.visit '/top'
    session.execute_script('window.ran = false; const e = document.createElement("iframe"); e.name = "m"; e.src = "/src"; document.body.append(e); f.method = "get"; f.target = "m"; f.action = "javascript:parent.ran = true"; f.submit()')
    session.evaluate_script('1')
    expect(session.evaluate_script('ran')).to be(true)
    expect(hits).not_to include('GET /src')
  end

  # Every form that navigates a frame is planned by that frame's navigable as it is submitted, whichever document's it is — the
  # navigable's one, a later navigation replacing it — so a sibling's and the page's into one frame send one request, and a
  # location or a `javascript:` URL comes before or after it as any other navigation of the frame (Chrome and Firefox, measured
  # 2026-11-07).
  describe 'by whichever document' do
    def siblings(hits)
      simulated_session(lambda {|env|
        hits << "#{env['REQUEST_METHOD']} #{env['PATH_INFO']}#{"?#{env['QUERY_STRING']}" unless env['QUERY_STRING'].to_s.empty?}"
        body = case env['PATH_INFO']
               when '/top' then '<iframe id=a name=na src=/a></iframe><iframe id=b name=nb src=/b0></iframe><form id=x method=post action=/pg target=nb></form>'
               when '/a' then '<form id=x method=post action=/sib target=nb></form><form id=own method=post action=/self></form>'
               else env['PATH_INFO']
               end
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
      })
    end

    {
      'x.submit(); a.contentWindow.x.submit()' => ['/sib', 'POST /sib', 'POST /pg'],
      'a.contentWindow.x.submit(); x.submit()' => ['/pg', 'POST /pg', 'POST /sib']
    }.each do |js, (lands, sent, unsent)|
      it "sends the later's alone into one frame: #{js}" do
        hits = []
        session = siblings(hits)
        session.visit '/top'
        session.execute_script(js)
        session.evaluate_script('1')
        expect(session.evaluate_script('b.contentWindow.location.pathname')).to eq(lands)
        expect(hits).to include(sent)
        expect(hits).not_to include(unsent)
      end
    end

    {
      'a.contentWindow.x.submit(); b.contentWindow.location = "/b1"' => '/b1',
      'b.contentWindow.location = "/b1"; a.contentWindow.x.submit()' => '/sib'
    }.each do |js, lands|
      it "takes the later of a sibling's form and a location: #{js}" do
        hits = []
        session = siblings(hits)
        session.visit '/top'
        hits.clear
        session.execute_script(js)
        session.evaluate_script('1')
        expect(session.evaluate_script('b.contentWindow.location.pathname')).to eq(lands)
        expect(hits.size).to eq(1)
      end
    end

    # …a `javascript:` URL of the frame none, whether the form is of the frame's own document or its sibling's.
    {
      'a.contentWindow.x.submit(); b.src = "javascript:parent.ran = true"' => ['b', '/b0'],
      'a.contentWindow.own.submit(); a.contentWindow.location = "javascript:parent.ran = true"' => ['a', '/self']
    }.each do |js, (frame, lands)|
      it "runs no javascript: URL with a form planned: #{js}" do
        session = siblings([])
        session.visit '/top'
        session.execute_script("window.ran = false; #{js}")
        session.evaluate_script('1')
        expect(session.evaluate_script('ran')).to be(false)
        expect(session.evaluate_script("#{frame}.contentWindow.location.pathname")).to eq(lands) if frame == 'a'
      end
    end

    # …and a frame's parser goes on past a script of its submitting a form into it, as the plan queues the navigation.
    it "lets a frame's parser finish where its script submits its parent's form" do
      session = simulated_session(lambda {|env|
        body = case env['PATH_INFO']
               when '/top' then '<script>window.L = []</script><form id=x action=/x target=n></form><iframe name=n src=/in></iframe>'
               when '/in' then '<script>top.L.push(1); parent.x.submit(); top.L.push(2)</script><script>top.L.push(3)</script>'
               else env['PATH_INFO']
               end
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
      })
      session.visit '/top'
      session.evaluate_script('1')
      expect(session.evaluate_script('L')).to eq([1, 2, 3])
      expect(session.evaluate_script('frames[0].location.pathname')).to eq('/x')
    end
  end

  # A traversal queued with it applies first, the form's navigation pushing from where that leaves it (Chrome and Firefox,
  # measured 2026-11-07: one entry fewer than the other way about).
  it 'pushes from the step a traversal queued with it goes to' do
    session = session_with([])
    session.visit '/top'
    session.execute_script('frames[0].history.pushState(null, "", "/ps")')
    session.evaluate_script('1')
    session.execute_script('f.submit(); frames[0].history.back()')
    session.evaluate_script('1')
    expect(session.evaluate_script('[frames[0].location.pathname, history.length]')).to eq(['/x', 2])
  end

  # A GET to a fragment of the document the frame is at moves it within it, no request made (HTML "navigate to a fragment";
  # Chrome and Firefox, measured 2026-11-07).
  it "moves a frame within its document on a form's GET to a fragment of it" do
    hits = []
    session = session_with(hits)
    session.visit '/top'
    hits.clear
    session.execute_script('window.seen = 0; frames[0].kept = 1; frames[0].onhashchange = () => seen++; f.method = "get"; f.action = "/blank?#x"; fr.src = "/blank?"')
    session.evaluate_script('1')
    session.execute_script('frames[0].kept = 1; frames[0].onhashchange = () => seen++; f.submit()')
    session.evaluate_script('1')
    expect(session.evaluate_script('[frames[0].kept, frames[0].location.hash]')).to eq([1, '#x'])
  end

  # An entered frame's own: handed off from there too, and a `data:` URL's a document of it (Chrome and Firefox).
  describe 'in an entered frame' do
    it 'leaves the frame where it is on a mailto: form' do
      session = simulated_session(lambda {|env|
        body = env['PATH_INFO'] == '/top' ? '<iframe name=n src=/in></iframe>' : '<form action="mailto:a@b.test"><button id=go>go</button></form><p id=here>here</p>'
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
      })
      session.visit '/top'
      session.within_frame('n') do
        session.click_button('go')
        expect(session).to have_css('#here')
      end
    end

    it 'makes the document of a data: URL' do
      session = session_with([])
      session.visit '/top'
      session.within_frame('n') do
        session.execute_script('parent.frames[0].location = "data:text/html,<p id=made>made</p>"')
        expect(session).to have_css('#made')
      end
    end
  end

  # A link to a fragment of the frame's document moves it within it, fetching nothing (HTML "navigate to a fragment").
  it "fetches nothing for a link to the frame's own fragment" do
    hits = []
    session = session_with(hits)
    session.visit '/top'
    hits.clear
    session.execute_script('l.href = "/blank#b"; l.click()')
    expect(session.evaluate_script('frames[0].location.hash')).to eq('#b')
    expect(hits).to be_empty
  end

  # …and goes on with a cross-document navigation already under way (Chrome: the fragment's entry pushed, the frame at
  # /other).
  it 'keeps a navigation under way when a link moves the frame to a fragment' do
    hits = []
    session = session_with(hits)
    session.visit '/top'
    session.execute_script('frames[0].location = "/other"; l.href = "/blank#b"; l.click()')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/other')
    expect(session.evaluate_script('history.length')).to eq(3)
  end

  # …a document still loading too, moved at once — not loaded again, whose script would click again — its script reading
  # the fragment there and then, and its own `load`'s navigation after it (Chrome: one GET of /slow, length 3; `#e` in
  # the script, `#z` at the end — which, its document not completely loaded in its `load`, replaces the entry: HTML
  # "Location-object navigate").
  it 'moves a frame still loading to the fragment a link asks for' do
    hits = []
    session = simulated_session(lambda {|env|
      hits << env['PATH_INFO']
      body = case env['PATH_INFO']
             when '/top' then '<iframe name=n src="/blank"></iframe><a id=l target=n href="/slow#e">l</a>'
             when '/slow' then 'slow<script>parent.document.getElementById("l").click(); parent.seen = location.hash; ' \
                               'onload = () => { location.hash = "z" }</script><p id=e>e'
             else env['PATH_INFO']
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/top'
    session.execute_script('frames[0].location = "/slow"')
    expect(session.evaluate_script('seen')).to eq('#e')
    expect(session.evaluate_script('frames[0].location.hash')).to eq('#z')
    expect(hits.count('/slow')).to eq(1)
    expect(session.evaluate_script('history.length')).to eq(3)
  end

  # A navigation of the frame the page began before it gives way to it (Chrome: the frame at /x, one load).
  {'its location set' => 'frames[0].location = "/a"', 'a link targeting it' => 'l.click()'}.each do |name, js|
    it "takes over from #{name} before it" do
      hits = []
      session = session_with(hits)
      session.visit '/top'
      session.execute_script("window.loads = 0; fr.onload = () => loads++; #{js}; f.submit()")
      expect(session.evaluate_script('frames[0].location.pathname')).to eq('/x')
      expect(session.evaluate_script('loads')).to eq(1)
    end
  end

  # …and to one of the frame's own document's forms submitted to it after (Chrome: POST /g alone, one load).
  it "gives way to a form of the frame's own submitted after it" do
    hits = []
    session = session_with(hits)
    session.visit '/top'
    session.execute_script('frames[0].document.body.innerHTML = "<form id=g method=post action=/g></form>"')
    session.execute_script('window.loads = 0; fr.onload = () => loads++; f.submit(); frames[0].g.submit()')
    session.evaluate_script('1')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/g')
    expect(hits).not_to include('POST /x')
    expect(session.evaluate_script('loads')).to eq(1)
  end

  # …the frame's own name as its target alike (Chrome; `_parent` sends both).
  it "gives way to a form of the frame's own targeting it by name" do
    hits = []
    session = session_with(hits)
    session.visit '/top'
    session.execute_script('frames[0].document.body.innerHTML = "<form id=g method=post action=/g target=n></form>"')
    session.execute_script('f.submit(); frames[0].g.submit()')
    session.evaluate_script('1')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/g')
    expect(hits).not_to include('POST /x')
  end

  # A 204 / 205 makes no document (HTML "navigate"): every navigation of it leaves its navigable at the document it is
  # at, with no `load` and no session history entry (Chrome, measured 2026-10-24).
  describe 'a 204 response' do
    let(:app) do
      lambda {|env|
        next [204, {}, []] if env['PATH_INFO'] == '/204'

        body = case env['PATH_INFO']
               when '/top' then '<iframe name=n src="/blank"></iframe><form id=f method=post target=n action="/204"></form>' \
                                '<form id=g method=post action="/204"></form><a id=a href="/204">a</a><a id=fa target=n href="/204">fa</a>'
               else env['PATH_INFO']
               end
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
      }
    end

    # …a traversal to an entry whose response now is one too: the page, and its step, where they are (Chrome: forward
    # again does nothing).
    it 'keeps the page and its step where a traversal gets one' do
      no_content = false
      session = simulated_session(lambda {|env|
        next [204, {}, []] if no_content && env['PATH_INFO'] == '/top'

        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{env['PATH_INFO']}"]]
      })
      session.visit '/top'
      session.visit '/b'
      session.execute_script('window.marker = 1')
      no_content = true
      session.go_back
      expect(session.current_path).to eq('/b')
      session.go_forward
      expect(session.evaluate_script('window.marker')).to eq(1)
    end

    it "keeps a frame and its step where a traversal gets one" do
      no_content = false
      session = simulated_session(lambda {|env|
        next [204, {}, []] if no_content && env['PATH_INFO'] == '/blank'

        body = env['PATH_INFO'] == '/top' ? '<iframe src="/blank"></iframe>' : env['PATH_INFO']
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
      })
      session.visit '/top'
      session.execute_script('frames[0].location = "/a"')
      expect(session.evaluate_script('frames[0].location.pathname')).to eq('/a')
      session.execute_script('window.loads = 0; document.querySelector("iframe").onload = () => loads++')
      no_content = true
      session.go_back
      expect(session.evaluate_script('frames[0].location.pathname')).to eq('/a')
      session.go_forward
      expect(session.evaluate_script('loads')).to eq(0)
    end

    # …a frame's traversal to an entry that now downloads too (forward again does nothing); a reload's of it after
    # changing no history (its pushState entries kept).
    it "keeps a frame and its step where a traversal downloads, and a later reload's 204 its history" do
      answer = :page
      session = simulated_session(lambda {|env|
        if env['PATH_INFO'] == '/blank' && answer != :page
          next answer == :download ? [200, {'content-disposition' => 'attachment; filename=x.txt'}, ['x']] : [204, {}, []]
        end
        body = env['PATH_INFO'] == '/top' ? '<iframe src="/blank"></iframe>' : env['PATH_INFO']
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
      })
      session.visit '/top'
      session.execute_script('frames[0].location = "/a"')
      expect(session.evaluate_script('frames[0].location.pathname')).to eq('/a')
      session.execute_script('window.loads = 0; document.querySelector("iframe").onload = () => loads++')
      answer = :download
      session.go_back
      expect(session.evaluate_script('frames[0].location.pathname')).to eq('/a')
      session.go_forward
      expect(session.evaluate_script('loads')).to eq(0)
      session.execute_script('history.pushState(null, "", "/p1"); history.pushState(null, "", "/p2")')
      expect(session.evaluate_script('history.length')).to eq(4)
      answer = :no_content
      session.execute_script('frames[0].location.reload()')
      session.evaluate_script('1')
      expect(session.evaluate_script('history.length')).to eq(4)
    end

    # …one of two frames a step moves: the other moves, the step with it (HTML "apply the history step"; Chrome).
    it 'moves the step where one frame of it gets one' do
      no_content = false
      session = simulated_session(lambda {|env|
        next [204, {}, []] if no_content && env['PATH_INFO'] == '/blank'

        body = env['PATH_INFO'] == '/top' ? '<iframe src="/blank"></iframe><iframe src="/blank2"></iframe>' : env['PATH_INFO']
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
      })
      session.visit '/top'
      session.execute_script('frames[0].location = "/fa"')
      expect(session.evaluate_script('frames[0].location.pathname')).to eq('/fa')
      session.execute_script('frames[1].location = "/fb"')
      expect(session.evaluate_script('frames[1].location.pathname')).to eq('/fb')
      no_content = true
      session.execute_script('history.go(-2)')
      expect(session.evaluate_script('[frames[0].location.pathname, frames[1].location.pathname]')).to eq(['/fa', '/blank2'])
      # (…the frame whose was not made left at its own entry, which the next step gives it anyway: no change of it)
      session.execute_script('window.loads = 0; document.querySelector("iframe").onload = () => loads++; history.go(1)')
      expect(session.evaluate_script('[frames[0].location.pathname, frames[1].location.pathname, loads]')).to eq(['/fa', '/blank2', 0])
      # (…and kept there by a navigation clearing the forward steps: its reload the document it is at)
      session.execute_script('history.pushState(null, "", "/p")')
      session.execute_script('frames[0].location.reload()')
      session.evaluate_script('1')
      expect(session.evaluate_script('frames[0].location.pathname')).to eq('/fa')
    end

    # …and moved by a later step whose document is made: at that document from then on, its reload that one's.
    it 'lets a held frame go where a later step moves it' do
      no_content = false
      hits = []
      session = simulated_session(lambda {|env|
        hits << env['PATH_INFO']
        next [204, {}, []] if no_content && env['PATH_INFO'] == '/blank'

        body = env['PATH_INFO'] == '/top' ? '<iframe src="/blank"></iframe><iframe src="/blank2"></iframe>' : env['PATH_INFO']
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
      })
      session.visit '/top'
      %w[/fa /fc].each do |path|
        session.execute_script("frames[0].location = '#{path}'")
        expect(session.evaluate_script('frames[0].location.pathname')).to eq(path)
      end
      session.execute_script('frames[1].location = "/fb"')
      expect(session.evaluate_script('frames[1].location.pathname')).to eq('/fb')
      no_content = true
      session.execute_script('history.go(-3)')
      expect(session.evaluate_script('frames[0].location.pathname')).to eq('/fc')
      session.execute_script('history.go(1)')
      expect(session.evaluate_script('frames[0].location.pathname')).to eq('/fa')
      hits.clear
      session.execute_script('frames[0].location.reload()')
      session.evaluate_script('1')
      expect(hits).to eq(['/fa'])
    end

    # …a window `window.open` made on one at its initial about:blank, whichever side asks (Chrome).
    it 'leaves a new window on one at about:blank' do
      session = simulated_session(app)
      session.visit '/top'
      session.execute_script('window.w = open("/204")')
      session.within_window(session.windows.last) do
        expect(session.evaluate_script('location.href')).to eq('about:blank')
      end
      expect(session.evaluate_script('w.location.href')).to eq('about:blank')
    end

    # …a frame's first navigation to one at its initial about:blank, no `load` (Chrome).
    it "leaves a frame whose src gets one at its initial about:blank" do
      session = simulated_session(app)
      session.visit '/top'
      session.execute_script('window.loads = 0; const f = document.createElement("iframe"); f.onload = () => loads++; f.src = "/204"; document.body.append(f)')
      session.evaluate_script('1')
      expect(session.evaluate_script('[frames[1].location.href, loads]')).to eq(['about:blank', 0])
    end

    {'a link' => 'a.click()', 'a form' => 'g.submit()', 'its location set' => 'location.href = "/204"'}.each do |name, js|
      it "keeps the page where #{name} gets one" do
        session = simulated_session(app)
        session.visit '/top'
        session.execute_script(js)
        expect(session.current_path).to eq('/top')
        expect(session.evaluate_script('history.length')).to eq(1)
      end
    end

    {
      'a form targeting it' => 'f.submit()', 'a link targeting it' => 'fa.click()',
      'its location set' => 'frames[0].location = "/204"', 'its src set' => 'document.querySelector("iframe").src = "/204"'
    }.each do |name, js|
      it "keeps a frame where #{name} gets one" do
        session = simulated_session(app)
        session.visit '/top'
        session.execute_script("window.loads = 0; document.querySelector('iframe').onload = () => loads++; #{js}")
        session.evaluate_script('1')
        expect(session.evaluate_script('[frames[0].location.pathname, frames[0].document.body.textContent, loads]')).to eq(['/blank', '/blank', 0])
        expect(session.evaluate_script('history.length')).to eq(1)
      end
    end
  end

  it "sends nothing where the frame's srcdoc is set after it" do
    hits = []
    session = session_with(hits)
    session.visit '/top'
    session.execute_script('f.submit(); fr.srcdoc = "<p>doc"')
    expect(session.evaluate_script('frames[0].document.body.textContent')).to eq('doc')
    expect(hits).not_to include('POST /x')
  end

  # A frame removed after the submission and inserted again is a new navigable, its `src` loaded and its `load` fired
  # (Chrome: one load).
  it 'fires the load of a frame inserted again after it' do
    session = session_with([])
    session.visit '/top'
    session.execute_script('window.loads = 0; const e = fr; f.submit(); e.remove(); e.onload = () => loads++; document.body.append(e)')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/blank')
    expect(session.evaluate_script('loads')).to eq(1)
  end
end
