# frozen_string_literal: true

require 'capybara'

module Capybara
  module Simulated
    # Raised when an Element handle no longer refers to a node attached
    # to the document. Driver lists this as an `invalid_element_error`,
    # so Capybara's `synchronize` wrapper catches it and reloads the
    # cached element.
    class StaleElement < Capybara::ElementNotFound; end

    # Raised by `switch_to_frame` when the active JS engine can't give the
    # target `<iframe>` its own browsing context (a real per-frame realm).
    # Only the V8 engine (rusty_racer) builds per-frame realms; under
    # QuickJS the frame stays a same-realm fallback we can't route DOM ops
    # into, so `within_frame` is unsupported there.
    class FrameNotSupported < Capybara::NotSupportedByDriverError; end
  end
end
