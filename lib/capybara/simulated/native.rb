# frozen_string_literal: true

# The native cascade accelerator (Rust, ext/native_cascade). It is REQUIRED — there is deliberately
# NO JS/Ruby fallback. Each piece of the cascade that moves into Rust then lives in exactly ONE
# place: the JS cascade shrinks as slices migrate and calls native for them, so the two never
# duplicate logic and can't drift, and the WPT gate always exercises the one real path.
#
# An installed gem always carries the extension: the prebuilt (fat) gem ships it precompiled, and a
# source install compiles it or fails loudly (ext/native_cascade/extconf.rb). In a dev checkout or a
# `:path` dependency, run `rake compile` first — `bundle install` does not build the gem's OWN
# extension. The extension's init defines `Capybara::Simulated::Native`.
require 'capybara/simulated/native_cascade'
