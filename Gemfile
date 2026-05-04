source 'https://rubygems.org'

gemspec

gem 'mini_racer', '~> 0.18'
gem 'nokogiri'
gem 'quickjs'

group :development, :test do
  gem 'launchy'    # required by Capybara's shared save_and_open_page spec
  gem 'puma'       # for Capybara's :server tests (also used by spec helper)
  gem 'rack-test'
  gem 'rake',      require: false
  gem 'rspec',     '~> 3.13'
  gem 'sinatra',   '>= 4.0'
end
