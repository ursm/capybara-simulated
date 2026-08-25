# frozen_string_literal: true

require 'capybara'

module Capybara
  module Simulated
    # Raised when an Element handle no longer refers to a node attached
    # to the document. Driver lists this as an `invalid_element_error`,
    # so Capybara's `synchronize` wrapper catches it and reloads the
    # cached element.
    class StaleElement < Capybara::ElementNotFound; end

    # Raised when the click point's hit-test lands on an unrelated element
    # painted over the target (WebDriver "element click intercepted") — a
    # modal backdrop mid-exit, a full-page overlay. Listed as an
    # `invalid_element_error`, so Capybara's `synchronize` retries the
    # find+click until the obstruction is gone, exactly as it does for a
    # real driver's ElementClickInterceptedError.
    class ClickIntercepted < Capybara::ElementNotFound; end

    # Raised by `switch_to_frame` when the active JS engine can't give the
    # target `<iframe>` its own browsing context (a real per-frame realm).
    # Only the V8 engine (rusty_racer) builds per-frame realms; under
    # QuickJS the frame stays a same-realm fallback we can't route DOM ops
    # into, so `within_frame` is unsupported there.
    class FrameNotSupported < Capybara::NotSupportedByDriverError; end

    # Raised by `save_screenshot` when the page could not be rastered — most often because
    # `ruby-vips` (the rasteriser behind the whole canvas stack) isn't in the bundle.
    class ScreenshotFailed < Capybara::CapybaraError; end
  end
end
