# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A `<link rel=stylesheet>`'s fetch is begun as the link is connected, in parallel (HTML "fetch and process the linked
# resource"), its server's time counted as the request is made — the cascade joining that fetch — and its load task
# queued that much later on the virtual clock (sheet_fetch.rs `sheetFetchBegin`), which the document's load waits for;
# its document's abort cancels it, a network error.
RSpec.describe "a link's style sheet fetch" do
  def log_of(head, wait: 600)
    app = ->(env) {
      case env['PATH_INFO']
      when '/b.js'
        sleep 0.05
        [200, {'content-type' => 'text/javascript'}, ['R.push("b")']]
      when '/s.css', '/i.css'
        sleep 0.2
        [200, {'content-type' => 'text/css'}, ['p { color: red }']]
      when '/imp.css' then [200, {'content-type' => 'text/css'}, ['@import url(/i.css);']]
      else [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><title>t</title><script>window.R = []; addEventListener('DOMContentLoaded', () => R.push('dcl')); addEventListener('load', () => R.push('load'))</script>#{head}"]]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    s.evaluate_async_script("const done = arguments[0]; setTimeout(() => done(R.join(' ')), #{wait})")
  end

  # (…Chrome and Firefox `t0 b.js-ran inl dcl css load`, rv-end-probe `a08_sheet_during`: a sheet a timer inserts as the
  # parser waits on a script loads once its server's time is up, after the script, whose server took less)
  it 'loads a sheet inserted as the parser waits once its server has answered, after a script that answered first' do
    head = '<script>setTimeout(() => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/s.css"; ' \
           'l.onload = () => R.push("css"); document.head.append(l); R.push("t0") })</script><script src="/b.js"></script><script>R.push("inl")</script>'
    expect(log_of(head)).to eq('t0 b inl dcl css load')
  end

  # (…Chrome and Firefox `stopped csserr`, rv-r13-probe `s4_stopwait`)
  it "fires `error` at a sheet whose fetch a `stop()` cancelled" do
    head = '<script>setTimeout(() => { stop(); R.push("stopped") }, 50)</script>' \
           '<link rel=stylesheet href="/s.css" onload="R.push(\'css\')" onerror="R.push(\'csserr\')">'
    expect(log_of(head)).to eq('stopped csserr')
  end

  # (…and an `@import`'s, a `<style>`'s or a linked sheet's: its owner's `load` once its server has answered — Chrome and
  # Firefox `t0 b.js-ran inl dcl css load`, csim-bench theend5 `t6_timer_import`, `t6_timer_linkimport`)
  ['<style>@import url(/i.css);</style>', '<link rel=stylesheet href="/imp.css">'].each do |sheet|
    it "loads #{sheet} inserted as the parser waits once its import's server has answered" do
      insert = "const t = document.createElement('template'); t.innerHTML = #{sheet.inspect}; const s = t.content.firstChild; " \
               's.onload = () => R.push("css"); document.head.append(s); R.push("t0")'
      head = "<script>setTimeout(() => { #{insert} })</script><script src=\"/b.js\"></script><script>R.push(\"inl\")</script>"
      expect(log_of(head)).to eq('t0 b inl dcl css load')
    end
  end
end
