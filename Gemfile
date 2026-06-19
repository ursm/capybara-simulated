source 'https://rubygems.org'

gemspec

# JS engines: both installed in dev so the spec suite exercises both
# (CSIM_JS_ENGINE=v8 / =quickjs). Downstream apps add whichever one
# they want — neither is a hard dependency of the gem itself.
gem 'rusty_racer', '~> 0.1.9'
gem 'nokogiri'
gem 'quickjs', '>= 0.18'

group :development, :test do
  gem 'launchy'            # required by Capybara's shared save_and_open_page spec
  gem 'puma'               # for Capybara's :server tests (also used by spec helper)
  gem 'rack-test'
  gem 'rake',              require: false
  gem 'rspec',             '~> 3.13'
  gem 'ruby-vips'          # canvas/image-decode backend; soft-required at runtime
  gem 'selenium-webdriver' # bench/run.rb under :selenium
  gem 'stackprof',         require: false # sampling profiler for perf investigations
  gem 'sinatra',           '>= 4.0'
  gem 'websocket-driver'   # server side of the WebSocket spec's in-process echo app (Action Cable's own framing lib)
  gem 'actioncable'        # self-contained Action Cable end-to-end spec (standalone async-adapter server + the gem's own JS client)
end
