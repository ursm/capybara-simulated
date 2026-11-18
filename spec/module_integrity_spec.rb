# frozen_string_literal: true

require 'capybara/simulated'
require 'digest'
require_relative 'support/session_teardown'

# A module script's response is checked against its integrity metadata — its element's `integrity`, an import's the
# import map's (HTML "resolve a module integrity metadata") — one that does not match no module, a network error: its
# `error`, its graph none (SRI; Chrome and Firefox, csim-bench r13 `rv_sri` `ime dcl ice iie load`).
RSpec.describe 'module script integrity' do
  BODY = 'document.title += "m"'
  GOOD = "sha256-#{Digest::SHA256.base64digest(BODY)}"
  BAD  = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

  def title_of(markup)
    app = ->(env) {
      next [200, {'content-type' => 'text/javascript'}, [BODY]] if env['PATH_INFO'] == '/m.js'

      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><title>t</title>#{markup}"]]
    }
    s = simulated_session(app)
    s.visit '/'
    s.evaluate_async_script('const done = arguments[0]; setTimeout(() => done(document.title), 100)')
  end

  it 'runs one whose integrity matches and fires error for one whose does not' do
    expect(title_of(%(<script type="module" integrity="#{GOOD}" src="/m.js" onerror="document.title += 'e'"></script>))).to eq('tm')
    expect(title_of(%(<script type="module" integrity="#{BAD}" src="/m.js" onerror="document.title += 'e'"></script>))).to eq('te')
  end

  # (…its graph none, the inline script's `error` fired: HTML "execute the script element" of a null result)
  it "checks an import against its import map's integrity" do
    map = %(<script type="importmap">{"imports": {"m": "/m.js"}, "integrity": {"/m.js": "#{BAD}"}}</script>)
    expect(title_of(%(#{map}<script type="module" onerror="document.title += 'e'">import "m"; document.title += "i"</script>))).to eq('te')
  end
end
