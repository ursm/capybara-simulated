source 'https://rubygems.org'

gemspec

gem 'nokogiri'
gem 'quickjs', '0.17.0.pre'

group :development, :test do
  gem 'launchy'            # required by Capybara's shared save_and_open_page spec
  gem 'mini_racer'         # experimental V8 engine, opt-in via CSIM_JS_ENGINE=v8
  gem 'puma'               # for Capybara's :server tests (also used by spec helper)
  gem 'rack-test'
  gem 'rake',              require: false
  gem 'rspec',             '~> 3.13'
  gem 'selenium-webdriver' # bench/run.rb under :selenium
  gem 'sinatra',           '>= 4.0'
end
