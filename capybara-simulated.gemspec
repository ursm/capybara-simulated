require_relative 'lib/capybara/simulated/version'

Gem::Specification.new do |spec|
  spec.name        = 'capybara-simulated'
  spec.version     = Capybara::Simulated::VERSION
  spec.authors     = ['Keita Urashima']
  spec.email       = ['ursm@ursm.jp']
  spec.summary     = 'Lightweight Capybara driver with an in-process JS-resident DOM, Chrome-free'
  spec.description = 'A Capybara driver that runs JavaScript against an in-process JS-resident DOM — V8 via mini_racer or QuickJS via quickjs.rb, whichever is installed. No Chrome, no Node toolchain. Forms submit through Rack::MockRequest, inline <script> + event handlers run, Hotwire / Stimulus / Turbo work, and Capybara DSL is unchanged. Sits between rack-test and full headless browsers.'
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
    'lib/capybara/simulated/js/*.js',  # bridge.bundle.js + snapshot_stubs.js — NOT src/
    'vendor/js/*.js',
    'README.md',
    'LICENSE'
  ]
  spec.require_paths = ['lib']

  spec.add_dependency 'capybara', '>= 3.37'
  spec.add_dependency 'rack',     '>= 2.2'

  # JS engine is a soft dependency — add exactly one to your Gemfile.
  # The engine is auto-selected based on which is loadable; `mini_racer`
  # wins when both are present. Override explicitly with
  # `CSIM_JS_ENGINE=v8|quickjs` or `Driver.new(app, js_engine: :…)`.
  #
  # mini_racer must come from the experimental fork until V8's native
  # ES Module API + cached_data surface lands upstream — stock 0.21.x
  # does not expose `Context#compile_module` /
  # `Context#dynamic_import_resolver=` and will NoMethodError on the
  # first `<script type="module">`.
  #
  #   gem 'mini_racer', git:    'https://github.com/ursm/mini_racer.git',
  #                     branch: 'experimental/cached-data-and-module-api'
  #   gem 'quickjs',    '>= 0.18' # QuickJS (interpreter, smaller per-VM
  #                               # footprint; wins on parallelism).
end
