# frozen_string_literal: true

# The native cascade accelerator (Rust). Built into lib/capybara/simulated/native_cascade.<dlext>.
# A prebuilt (fat) gem — the normal install — ships it already compiled and never reaches this file.
# A SOURCE install compiles it here, and a missing Rust toolchain (or rb_sys) FAILS the install
# loudly rather than silently installing a slow, JS-only gem: a clear "install the prebuilt gem or
# add a Rust toolchain" is easier to act on than an unexplained performance cliff.
require 'mkmf'
require 'rb_sys/mkmf'

create_rust_makefile('capybara/simulated/native_cascade')
