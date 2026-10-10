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

    # Raised when `set` targets a control the user cannot reach — an inert one (behind a modal dialog, under `inert`),
    # which takes no focus and so no typing (WebDriver "element not interactable": Element Send Keys refuses an element
    # that is not keyboard-interactable). Retryable as ClickIntercepted is: the dialog may be closing.
    class ElementNotInteractable < Capybara::ElementNotFound; end

    # Raised by `save_screenshot` when the page could not be rastered: it painted nothing.
    class ScreenshotFailed < Capybara::CapybaraError; end

    # Raised by `evaluate_script` for an answer that holds itself — a Window, an object with a reference back to it —
    # which no serialization can hand over (WebDriver: a JavaScript error, "cyclic object value").
    class CyclicScriptResult < Capybara::CapybaraError; end
  end
end
