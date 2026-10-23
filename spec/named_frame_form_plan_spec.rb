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

  # …a document still loading too, moved once it is there — not loaded again, whose script would click again (Chrome:
  # one GET of /slow, length 3).
  it "moves a frame still loading to the fragment a link asks for" do
    hits = []
    session = simulated_session(lambda {|env|
      hits << env['PATH_INFO']
      body = case env['PATH_INFO']
             when '/top' then '<iframe name=n src="/blank"></iframe><a id=l target=n href="/slow#e">l</a>'
             when '/slow' then 'slow<script>parent.document.getElementById("l").click()</script><p id=e>e'
             else env['PATH_INFO']
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/top'
    session.execute_script('frames[0].location = "/slow"')
    expect(session.evaluate_script('frames[0].location.hash')).to eq('#e')
    expect(hits.count('/slow')).to eq(1)
    expect(session.evaluate_script('history.length')).to eq(3)
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
