require 'bundler/gem_tasks'

# The native cascade accelerator (Rust). `rake compile` builds ext/native_cascade into
# lib/capybara/simulated/native_cascade.<dlext> for dev/CI (the gem's own extension isn't
# auto-compiled by `bundle install` — that only happens for downstream consumers installing the
# gem). A prebuilt (fat) gem ships it already compiled.
require 'rb_sys/extensiontask'

GEMSPEC = Gem::Specification.load('capybara-simulated.gemspec')

RbSys::ExtensionTask.new('native_cascade', GEMSPEC) do |ext|
  ext.lib_dir = 'lib/capybara/simulated'
end
