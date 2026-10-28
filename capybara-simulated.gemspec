require_relative 'lib/capybara/simulated/version'

Gem::Specification.new do |spec|
  spec.name        = 'capybara-simulated'
  spec.version     = Capybara::Simulated::VERSION
  spec.authors     = ['Keita Urashima']
  spec.email       = ['ursm@ursm.jp']
  spec.summary     = 'Lightweight Capybara driver with an in-process JS-resident DOM, Chrome-free'
  spec.description = 'A Capybara driver that runs JavaScript against an in-process JS-resident DOM on V8 (via rusty_racer). No Chrome, no Node toolchain. Forms submit through Rack::MockRequest, inline <script> + event handlers run, Hotwire / Stimulus / Turbo work, and Capybara DSL is unchanged. Sits between rack-test and full headless browsers.'
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
    'Cargo.toml', 'Cargo.lock',                     # the Rust workspace root (rb-sys builds from here)
    'ext/csim_native/src/*.rs',                     # the native extension's source (V8 engine + DOM + layout)
    'ext/csim_native/src/*.cc',                     # …and its C++ shim over V8 (build.rs compiles it)
    'ext/csim_native/build.rs',
    'ext/csim_native/Cargo.toml',
    'ext/csim_native/extconf.rb',
    'exe/*',
    'README.md',
    'LICENSE'
  ]
  spec.bindir        = 'exe'
  spec.executables   = ['capybara-simulated']
  spec.require_paths = ['lib']

  # The native extension (Rust): the V8 engine (rusty_racer, linked as a library) + the native DOM,
  # built into one cdylib. Compiled at source-install; a prebuilt (fat) gem ships it precompiled.
  #
  # `spec.files` above has to carry the crate this builds — extconf.rb alone (which RubyGems adds here for
  # free) would ship a build script with nothing to build. `spec/gemspec_packaging_spec.rb` asserts that, and
  # that no pattern in the list matches nothing: `ext/native_cascade/*` outlived its directory by months
  # exactly because a dead glob is silent. A source install fetches rusty_racer's native source by its release
  # tag (ext/csim_native/Cargo.toml) — the version pinned below.
  spec.extensions = ['ext/csim_native/extconf.rb']

  spec.add_dependency 'capybara', '>= 3.37'
  spec.add_dependency 'rack',     '>= 2.2'
  # rb-sys drives the native extension's build (ext/csim_native/extconf.rb). Needed
  # only when compiling from source; a prebuilt (fat) gem carries the compiled extension already.
  spec.add_dependency 'rb_sys', '~> 0.9'
  # The JS engine: V8 via rusty_v8. Its native engine is linked into csim_native (above); the gem
  # supplies the Ruby API around it — so the two are ONE version, the tag the crate is built from: a gem's
  # wrappers call into the native source of their own release, and another's may name a method this one
  # lacks. (0.2.5: `eval_primitive`, `Module#evaluate(report:)`, a thrown value rethrown as itself, and a
  # released realm's host function that no longer runs its slot's next proc.)
  spec.add_dependency 'rusty_racer', '0.2.5'
end
