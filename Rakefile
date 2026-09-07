require 'bundler/gem_tasks'

# The native extension (Rust): V8 engine (rusty_racer, linked as a library) + the native DOM.
# `rake compile` builds ext/csim_native into lib/capybara/simulated/csim_native.<dlext> for dev/CI
# (the gem's own extension isn't auto-compiled by `bundle install` — that only happens for downstream
# consumers installing the gem). A prebuilt (fat) gem ships it already compiled.
require 'rb_sys/extensiontask'

GEMSPEC = Gem::Specification.load('capybara-simulated.gemspec')

RbSys::ExtensionTask.new('csim_native', GEMSPEC) do |ext|
  ext.lib_dir = 'lib/capybara/simulated'
end
