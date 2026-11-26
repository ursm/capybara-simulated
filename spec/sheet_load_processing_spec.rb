# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A style sheet is made as its owner's load task processes it — HTML "process the linked resource" for a `<link>`, its
# `@import`s handed over as the task that lands them runs (sheet_fetch.rs `ImportTree`) — and nothing sees it before:
# `.sheet` null, the cascade without it. Its fetches run in parallel, dated as each request was made; a later fetch of
# the same owner supersedes the earlier one's task, and its document's abort cancels what is under way.
RSpec.describe 'a style sheet made as its load task processes it' do
  let(:requests) { [] }

  def log_of(head, wait: 600)
    app = ->(env) {
      requests << [env['PATH_INFO'], env['HTTP_REFERER']]
      case env['PATH_INFO']
      when '/a.js' then [200, {'content-type' => 'text/javascript'}, ['R.push("a")']]
      when '/b.js' then [200, {'content-type' => 'text/javascript'}, ['R.push("b")']]
      when '/s.css', '/t.css'
        sleep 0.3
        [200, {'content-type' => 'text/css'}, ['p { color: rgb(255, 0, 0) }']]
      when '/i.css'
        sleep 0.2
        [200, {'content-type' => 'text/css'}, ['p { color: rgb(255, 0, 0) }']]
      when '/imp.css' then [200, {'content-type' => 'text/css'}, ['@import url(/i.css);']]
      when '/imp2.css' then [200, {'content-type' => 'text/css'}, ['@import url(/imp.css);']]
      when '/missing.css' then [404, {'content-type' => 'text/css'}, ['']]
      else [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset=utf-8><title>t</title><p id=p>x</p>
        <script>window.R = []; window.C = () => getComputedStyle(document.getElementById('p')).color === 'rgb(255, 0, 0)' ? 'R' : 'B';
        addEventListener('DOMContentLoaded', () => R.push('dcl')); addEventListener('load', () => R.push('load'))</script>#{head}
      HTML
      end
    }
    s = simulated_session(app)
    s.visit '/'
    s.evaluate_async_script("const done = arguments[0]; setTimeout(() => done(R.join(' ')), #{wait})")
  end

  # (…Chrome and Firefox `i:B-1 dcl t0:B- t100:B-1 css:Rs load`, rv-sh-probe `q01_gcs_ins`)
  it "gives a link's sheet to nothing before its load task" do
    head = '<script>const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/s.css"; ' \
           'l.onload = () => R.push(`css:${C()}${l.sheet ? "s" : "-"}`); document.head.append(l); ' \
           'R.push(`i:${C()}${l.sheet ? "s" : "-"}${document.styleSheets.length}`); setTimeout(() => R.push(`t100:${C()}`), 100)</script>'
    expect(log_of(head)).to eq('i:B-0 dcl t100:B css:Rs load')
  end

  # (…nor its `@import`s' before they land: Chrome and Firefox `t150b:B sl:R`, rv-sh-probe `q14_nested_import`)
  it "applies a style's nested import as its load task lands it" do
    head = '<script>setTimeout(() => R.push(`t100:${C()}`), 100)</script><style onload="R.push(`sl:${C()}`)">@import url(/imp.css);</style>'
    expect(log_of(head)).to eq('dcl t100:B sl:R load')
  end

  # (…Chrome and Firefox `serr err:B`, rv-sh-probe `q11_import_fail`)
  it 'fires error at a style whose import failed' do
    head = '<style onload="R.push(\'sl\')" onerror="R.push(\'serr\')">@import url(/missing.css);</style>'
    expect(log_of(head)).to eq('dcl serr load')
  end

  # (…Firefox `dcl stopped serr lerr`, Chrome `stopped serr`, rv-sh-probe `q16_stop_style_import`)
  it "fires error at the owners whose imports a stop cancelled" do
    head = '<script>setTimeout(() => { stop(); R.push("stopped") }, 50)</script>' \
           '<style onload="R.push(\'sl\')" onerror="R.push(\'serr\')">@import url(/s.css);</style>' \
           '<link rel=stylesheet href="/imp.css" onload="R.push(\'ll\')" onerror="R.push(\'lerr\')">'
    expect(log_of(head)).to eq('dcl stopped serr lerr')
  end

  # (…Chrome and Firefox `dcl chg css:t.cssR`, one `load`, rv-sh-probe `q03_href_change`)
  it "fires the one load of a link whose href changed as it was fetched" do
    head = '<script>const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/s.css"; ' \
           'l.onload = () => R.push(`css:${l.href.split("/").pop()}${C()}`); document.head.append(l); ' \
           'setTimeout(() => { l.href = "/t.css"; R.push("chg") }, 50)</script>'
    expect(log_of(head, wait: 800)).to eq('dcl chg css:t.cssR load')
  end

  # (…Firefox `dcl chg t150:B sl:G load`, rv-sh-probe `q35_style_update_cross`: the first block's import lands with no
  # `load` of its own)
  it "lands a style's imports by the block it has now" do
    head = '<script>const s = document.createElement("style"); s.onload = () => R.push(`sl:${C()}`); ' \
           's.textContent = "@import url(/i.css);"; document.head.append(s); ' \
           'setTimeout(() => { s.textContent = "@import url(/s.css);"; R.push("chg") }, 20); ' \
           'setTimeout(() => R.push(`t250:${C()}`), 250)</script>'
    expect(log_of(head, wait: 800)).to eq('dcl chg t250:B sl:R load')
  end

  # (…none of a link removed as it was fetched, its server's time passing: rv-sh-probe `rm4.rb`)
  it 'never applies a link removed as it was fetched' do
    head = '<script>const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/s.css"; document.head.append(l); ' \
           'setTimeout(() => { l.remove(); R.push(`rm:${C()}`) }, 50); setTimeout(() => R.push(`t400:${C()}`), 400)</script>'
    expect(log_of(head)).to eq('dcl rm:B load t400:B')
  end

  # (…an `@import` fetched once, in parallel, referred by the sheet that imports it)
  it "fetches a link's import once, referred by its sheet" do
    log_of('<link rel=stylesheet href="/imp.css">')
    expect(requests.select {|(path, _)| path == '/i.css' }).to eq([['/i.css', 'http://www.example.com/imp.css']])
  end

  # (…an inserted script runs as it lands, a sheet blocking scripts or none: Chrome `ins i21.js-ran css`, Firefox
  # `dcl ins i21.js-ran css`, rv-sh-probe `q21_ins_during_sheet`)
  it 'runs an inserted script before a sheet blocking scripts' do
    head = '<script>setTimeout(() => { const s = document.createElement("script"); s.src = "/a.js"; document.head.append(s); R.push("ins") }, 50)</script>' \
           '<link rel=stylesheet href="/s.css" onload="R.push(\'css\')">'
    expect(log_of(head)).to eq('dcl ins a css load')
  end

  # (…the parser's blocking script waits for a sheet whose nested import comes in later still — HTML "spin the event loop
  # until … no style sheet that is blocking scripts", its timers running meanwhile)
  it "runs a parser-blocking script once a link's nested import is in" do
    head = '<script>setTimeout(() => R.push("t100"), 100)</script><link rel=stylesheet href="/imp2.css" onload="R.push(\'css\')">' \
           '<script src="/b.js"></script><script>R.push(`inl:${C()}`)</script>'
    expect(log_of(head)).to eq('t100 css b inl:R dcl load')
  end
end
