require_relative 'lib/capybara/simulated/version'

Gem::Specification.new do |spec|
  spec.name        = 'capybara-simulated'
  spec.version     = Capybara::Simulated::VERSION
  spec.authors     = ['Keita Urashima']
  spec.email       = ['ursm@ursm.jp']
  spec.summary     = 'Lightweight Capybara driver with an in-process JS-resident DOM, Chrome-free'
  spec.description = 'A Capybara driver that runs JavaScript against an in-process JS-resident DOM — V8 via rusty_racer or QuickJS via quickjs.rb, whichever is installed. No Chrome, no Node toolchain. Forms submit through Rack::MockRequest, inline <script> + event handlers run, Hotwire / Stimulus / Turbo work, and Capybara DSL is unchanged. Sits between rack-test and full headless browsers.'
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
    'lib/capybara/simulated/*.html',   # trace_viewer.html — the `trace` CLI's viewer template
    'vendor/js/*.js',
    'exe/*',
    'README.md',
    'LICENSE'
  ]
  spec.bindir        = 'exe'
  spec.executables   = ['capybara-simulated']
  spec.require_paths = ['lib']

  spec.add_dependency 'capybara', '>= 3.37'
  spec.add_dependency 'rack',     '>= 2.2'
  # WHATWG/UTS46 IDNA (domain-to-ASCII/Unicode) for the URL parser's host
  # processing — the JS tr46 stub delegates non-ASCII / xn-- hosts here so the V8
  # snapshot doesn't carry the ~600KB Unicode IDNA mapping table.
  spec.add_dependency 'uri-idna', '~> 0.3'

  # JS engine is a soft dependency — add exactly one to your Gemfile.
  # The engine is auto-selected based on which is loadable; `:v8` wins when
  # both are present. Override explicitly with
  # `CSIM_JS_ENGINE=v8|quickjs` or `Driver.new(app, js_engine: :…)`.
  #
  #   gem 'rusty_racer' # V8 via rusty_v8 (JIT, fastest per spec)
  #   gem 'quickjs', '>= 0.18' # QuickJS (interpreter, smaller per-VM
  #                            # footprint; wins on parallelism).
end
