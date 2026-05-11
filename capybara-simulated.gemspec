require_relative 'lib/capybara/simulated/version'

Gem::Specification.new do |spec|
  spec.name        = 'capybara-simulated'
  spec.version     = Capybara::Simulated::VERSION
  spec.authors     = ['Keita Urashima']
  spec.email       = ['ursm@ursm.jp']
  spec.summary     = 'Lightweight Capybara driver powered by Nokogiri + a pluggable JS engine'
  spec.description = "A Capybara driver that runs JavaScript against a Nokogiri-backed DOM. The JS engine is a soft dependency — pick QuickJS, V8 (mini_racer), or 'none' to disable JS entirely. Sits between rack-test and full headless browsers."
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
  spec.add_dependency 'p_css',    '>= 0.1.8'
  spec.add_dependency 'rack',     '>= 2.2'

  # JS engines are soft dependencies. Pick one in your own Gemfile:
  #
  #   gem 'quickjs',    '>= 0.17.0.pre' # interpreted, low Ruby↔JS overhead
  #   gem 'mini_racer'                  # V8, JIT-fast pure JS
  #
  # Select at runtime via `CSIM_JS_ENGINE={quickjs,v8,none}` (defaults
  # to whichever gem is loadable). Without either gem the driver
  # falls back to `none` — no `<script>` execution (rack-test parity)
  # but full DOM / forms / cookies / Nokogiri parsing.
end
