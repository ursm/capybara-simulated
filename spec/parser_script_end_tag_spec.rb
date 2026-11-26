# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML "prepare the script element" runs once for a parser's script, at its end tag: a deferred or `async` one goes on its
# list as it is then — what "the end" runs it as, whatever an earlier script does to its attributes since (script.rs
# `Listed`) — and one whose `src` is empty there fires `error`, queued as an element task, and is never listed.
RSpec.describe "a parser's script prepared at its end tag" do
  def log_of(markup)
    app = ->(env) {
      if (m = env['PATH_INFO'].match(%r{\A/(\w+)\.js\z}))
        next [200, {'content-type' => 'text/javascript'}, ["R.push('#{m[1]}.js-ran')"]]
      end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><title>t</title><script>window.R = []</script>#{markup}"]]
    }
    s = simulated_session(app)
    s.visit '/'
    s.evaluate_async_script('const done = arguments[0]; setTimeout(() => done(R.join(" ")), 50)')
  end

  # (…Chrome and Firefox, rv-end-probe `c01_defer_src_removed`, `c02_defer_src_emptied`, `c05_defer_src_changed`)
  it 'runs the script its end tag fetched, whatever became of its `src` since' do
    events = %(onload="R.push('load')" onerror="R.push('error')")
    expect(log_of(%(<script defer src="/d.js" id=d #{events}>R.push('child')</script><script>d.removeAttribute('src')</script>))).to eq('d.js-ran load')
    expect(log_of(%(<script defer src="/d.js" id=d #{events}>R.push('child')</script><script>d.src = ''</script>))).to eq('d.js-ran load')
    expect(log_of(%(<script defer src="/d1.js" id=d #{events}></script><script>d.src = '/d2.js'</script>))).to eq('d1.js-ran load')
  end

  # (…rv-end-probe `c04_async_src_removed`)
  it "runs an `async` one's fetch, its `src` removed" do
    expect(log_of(%(<script async src="/a.js" id=a onload="R.push('load')">R.push('child')</script><script>a.removeAttribute('src')</script>))).to eq('a.js-ran load')
  end

  # (…rv-end-probe `b13_defer_empty_src`, `c03_async_empty_child`: Chrome and Firefox `error`, after DOMContentLoaded, and
  # nothing run — its `src` set since, nor its text)
  it 'fires `error` for one whose `src` was empty at its end tag, and runs nothing' do
    expect(log_of(%(<script defer src="" id=d onerror="R.push('error')"></script><script>d.src = '/d.js'</script>))).to eq('error')
    expect(log_of(%(<script async src="" onerror="R.push('error')">R.push('child')</script>))).to eq('error')
  end
end
