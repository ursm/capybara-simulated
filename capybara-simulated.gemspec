require_relative 'lib/capybara/simulated/version'

Gem::Specification.new do |spec|
  spec.name        = 'capybara-simulated'
  spec.version     = Capybara::Simulated::VERSION
  spec.authors     = ['Keita Urashima']
  spec.email       = ['ursm@ursm.jp']
  spec.summary     = 'Lightweight Capybara driver with a V8-resident DOM, in-process and Chrome-free'
  spec.description = 'A Capybara driver that runs JavaScript against a V8-resident DOM via mini_racer — no Chrome, no Node toolchain. Forms submit through Rack::MockRequest, inline <script> + event handlers run, Hotwire / Stimulus / Turbo work, and Capybara DSL is unchanged. Sits between rack-test and full headless browsers.'
  spec.homepage    = 'https://github.com/ursm/capybara-simulated'
  spec.license     = 'MIT'

  spec.metadata = {
    'bug_tracker_uri'       => "#{spec.homepage}/issues",
    'changelog_uri'         => "#{spec.homepage}/releases",
    'rubygems_mfa_required' => 'true'
  }

  spec.required_ruby_version = '>= 3.3'

  spec.files = Dir[
    'lib/**/*.rb',
    'vendor/js/*.js',
    'README.md',
    'LICENSE'
  ]
  spec.require_paths = ['lib']

  spec.add_dependency 'capybara', '>= 3.37'
  spec.add_dependency 'nokogiri', '>= 1.18'
  spec.add_dependency 'p_css',    '>= 0.2.0.beta1'
  spec.add_dependency 'rack',     '>= 2.2'

  # JS engine is a soft dependency. The v3 driver (`:simulated_v3`)
  # requires V8 via mini_racer; the legacy v2 driver (`:simulated`)
  # additionally accepts QuickJS or `none`.
  #
  #   gem 'mini_racer'                  # V8 — required for :simulated_v3
  #   gem 'quickjs',    '>= 0.17.0.pre' # QuickJS — :simulated only
end
