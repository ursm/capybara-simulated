# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A `<style>` fires `load` once its sheet's `@import`s are in (HTML "update a style block") — the `@import`s the style
# engine's parse took: one after a rule it refuses still imports (CSS Syntax: a rule that does not parse is dropped, its
# state not moved on), one after a `@layer` statement that follows an `@import` does not (the rules that may import are
# over). The wait an import's `?pipe=trickle(dN)` asks (the WPT server's) is the observable: Chrome waits for the sheets
# it imports, and loads one with none at once.
RSpec.describe 'a style block waiting on its @imports' do
  let(:app) {
    lambda {|env|
      if env['PATH_INFO'].end_with?('.css')
        [200, {'content-type' => 'text/css'}, ['p { color: rgb(1, 2, 3) }']]
      else
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><p>x</p>']]
      end
    }
  }

  def load_after(css)
    s = simulated_session(app).tap {|session| session.visit '/' }
    s.execute_script(<<~JS)
      window.waited = null;
      const style = document.createElement('style'), at = performance.now();
      style.onload = () => { window.waited = performance.now() - at; };
      style.textContent = #{css.to_json};
      document.head.append(style);
    JS
    poll_until { s.evaluate_script('window.waited') }
  end

  it 'waits for an @import after a rule the parser drops' do
    expect(load_after("@foo; @import '/b.css?pipe=trickle(d1)';")).to be >= 1000
    expect(load_after("!!! {} @import '/c.css?pipe=trickle(d1)';")).to be >= 1000
  end

  it 'waits for none past the rules that may import, nor in a comment' do
    expect(load_after("@import '/d.css'; @layer x; @import '/e.css?pipe=trickle(d1)';")).to be < 1000
    expect(load_after("/* @import '/f.css?pipe=trickle(d1)'; */ p {}")).to be < 1000
  end
end
