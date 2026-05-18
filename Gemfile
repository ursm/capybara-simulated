source 'https://rubygems.org'

gemspec

# JS engines: both installed in dev so the spec suite exercises both
# (CSIM_JS_ENGINE=v8 / =quickjs). Downstream apps add whichever one
# they want — neither is a hard dependency of the gem itself.
gem 'mini_racer'
gem 'nokogiri'
gem 'quickjs', github: 'ursm/quickjs.rb', branch: 'combined-pr-40-and-42', submodules: true

group :development, :test do
  gem 'launchy'            # required by Capybara's shared save_and_open_page spec
  gem 'puma'               # for Capybara's :server tests (also used by spec helper)
  gem 'rack-test'
  gem 'rake',              require: false
  gem 'rspec',             '~> 3.13'
  gem 'ruby-vips'          # canvas/image-decode backend; soft-required at runtime
  gem 'selenium-webdriver' # bench/run.rb under :selenium
  gem 'sinatra',           '>= 4.0'
end
