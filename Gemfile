source 'https://rubygems.org'

gemspec

# JS engines: both installed in dev so the spec suite exercises both
# (CSIM_JS_ENGINE=v8 / =quickjs). Downstream apps add whichever one
# they want — neither is a hard dependency of the gem itself.
# Local path: the native engine is now linked INTO csim_native (ext/csim_native),
# so this provides rusty_racer's pure-Ruby API wrappers (Isolate.new / eval / …);
# its native require self-skips once csim_native has defined RustyRacer::*. Path
# (not the released gem) keeps the Ruby wrappers in lockstep with the linked
# native source during the native-DOM work.
gem 'rusty_racer', path: '../rusty_racer'
gem 'nokogiri'
gem 'quickjs', '~> 0.21.0'
gem 'quickjs-polyfill-intl'

group :development, :test do
  gem 'flatware-rspec', '~> 2.4' # multi-process spec runs (`flatware rspec spec`); the WPT / capybara-shared gates are
                                 # sharded to feed it, and it self-balances from the RSpec example-status file (see
                                 # spec/support/example_persistence.rb — includes the fork discipline flatware requires).
                                 # Pinned: Gemfile.lock is gitignored, so an unconstrained major bump would hit CI unbisectably.
  gem 'launchy'            # required by Capybara's shared save_and_open_page spec
  gem 'puma'               # for Capybara's :server tests (also used by spec helper)
  gem 'rack-test'
  gem 'rake',              require: false
  gem 'rake-compiler',     require: false # builds the native ext (ext/csim_native: V8 engine + native DOM) for dev/CI
  gem 'rspec',             '~> 3.13'
  gem 'selenium-webdriver' # bench/run.rb under :selenium
  gem 'stackprof',         require: false # sampling profiler for perf investigations
  gem 'sinatra',           '>= 4.0'
  gem 'websocket-driver'   # server side of the WebSocket spec's in-process echo app (Action Cable's own framing lib)
  gem 'actioncable'        # self-contained Action Cable end-to-end spec (standalone async-adapter server + the gem's own JS client)
  gem 'json', '< 3'        # activesupport 8.1.3 calls `JSON.parse(json, options)` with a 2nd POSITIONAL arg that
                           # json 3.0.0 removed (options are keyword-only now), so Action Cable's #decode raises
                           # `wrong number of arguments` on every incoming frame — the subscribe never processes
                           # and the cable spec's `connected()` never fires. csim's own JSON is 3.0-clean; this is
                           # purely the dev/test Rails stack. Pinned until activesupport ships a json-3 fix — and,
                           # like flatware above, because the gitignored lock let an unconstrained major hit CI
                           # unbisectably. gemspec stays unconstrained: the DRIVER runs fine on json 3.
end
