# frozen_string_literal: true

# A constant a spec file defines inside its `describe` block is a TOP-LEVEL constant (a block is no class body), shared
# with every other file loaded into the same process: two files defining one by the same name each run against
# whichever loaded last — under flatware, as the worker buckets happen to fall, so a file's examples fail only on some
# runs (`PAGES`, named_navigable_spec and geometry_cross_realm_spec, 2026-10-16). A spec redefining one fails its load.
# Config-only, as `.rspec` requires must be (spec/support/example_persistence.rb: FORK DISCIPLINE).
module SpecConstantCollisions
  COLLISION = %r{/spec/[^:]*\.rb:\d+: warning: already initialized constant}

  def warn(message, *args, **kwargs)
    raise message.strip if COLLISION.match?(message)

    super
  end
end
Warning.singleton_class.prepend(SpecConstantCollisions)
