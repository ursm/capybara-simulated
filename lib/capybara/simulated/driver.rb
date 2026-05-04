require 'capybara/driver/base'

module Capybara
  module Simulated
    class Driver < Capybara::Driver::Base
      DEFAULT_WINDOW_HANDLE = 'main'.freeze

      attr_reader :app

      def initialize(app)
        @app = app
      end

      def browser
        @browser ||= begin
          b = Browser.new(app)
          b.driver_for_results = self
          b
        end
      end

      def needs_server?      = false
      def javascript_enabled? = true
      # Capybara's synchronize loop will retry on ElementNotFound only
      # when the driver opts into waiting. Even though our DOM updates
      # happen in-process, async setTimeout-style behaviours need
      # Capybara to give them time.
      def wait?              = true

      def visit(path)         = browser.visit(path)
      def refresh             = browser.refresh
      def go_back             = browser.go_back
      def go_forward          = browser.go_forward
      def current_url         = browser.current_url
      def html                = browser.html
      def title               = browser.title
      def status_code         = browser.status_code
      def response_headers    = browser.response_headers || {}

      def find_xpath(query, **_)
        browser.find_xpath(query).map {|id| Node.new(self, id) }
      end

      def find_css(query, **_)
        browser.find_css(query).map {|id| Node.new(self, id) }
      end

      def execute_script(script, *args)
        browser.execute_script(script, args)
      end

      def evaluate_script(script, *args)
        browser.evaluate_script(script, args)
      end

      def evaluate_async_script(script, *args)
        browser.evaluate_async_script(script, args)
      end

      def send_keys(*keys)
        # Capybara calls session-level `send_keys` to drive global key
        # navigation (typically `:tab`). Even when nothing has been
        # focused yet, `<body>` is a valid sink so Tab handling can
        # advance to the first focusable descendant.
        handle_id = browser.active_element || browser.find_css('body').first
        return unless handle_id
        browser.send_keys(handle_id, keys)
      end

      def active_element
        handle_id = browser.active_element
        Node.new(self, handle_id) if handle_id
      end

      def save_screenshot(path, **_options)
        File.write(path, html)
        path
      end

      def reset!
        return unless @browser
        @browser.reset_state!
      end

      def invalid_element_errors
        [Capybara::Simulated::StaleElementReferenceError]
      end

      def no_such_window_error
        Capybara::WindowError
      end

      def current_window_handle = DEFAULT_WINDOW_HANDLE
      def window_handles         = [DEFAULT_WINDOW_HANDLE]
      def open_new_window
        raise NotImplementedError, 'capybara-simulated supports a single window'
      end
      def close_window(_handle)
        raise NotImplementedError, 'capybara-simulated supports a single window'
      end
      def switch_to_window(handle)
        return if handle == DEFAULT_WINDOW_HANDLE || handle.respond_to?(:handle) && handle.handle == DEFAULT_WINDOW_HANDLE
        raise Capybara::WindowError, "no such window: #{handle.inspect}"
      end

      def window_size(_handle)        = [1024, 768]
      def resize_window_to(_h, _w, _h2); end
      def maximize_window(_handle); end
      def fullscreen_window(_handle); end

      def switch_to_frame(_frame)
        raise NotImplementedError, 'frames are not supported by capybara-simulated'
      end

      def frame_title
        browser.title
      end

      def frame_url
        browser.current_url
      end

      def accept_modal(type, **options, &blk)
        push_modal_handler(type, options, accept: true)
        wait_for_modal(type, options, &blk)
      end

      def dismiss_modal(type, **options, &blk)
        push_modal_handler(type, options, accept: false)
        wait_for_modal(type, options, &blk)
      end

      private

      # Modals fired from `setTimeout` callbacks don't appear synchronously
      # when the block runs `click_link`. Advance the virtual clock in
      # short slices until either a matching modal arrives or the wait
      # budget runs out, matching Capybara's `accept_modal` semantics for
      # asynchronous alerts.
      MODAL_POLL_STEP_MS = 50
      def wait_for_modal(type, options, &blk)
        blk.call if blk
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) +
                   (options[:wait] || Capybara.default_max_wait_time || 2).to_f
        text_matcher = options[:text]
        loop do
          browser.modal_inbox.concat(browser.drain_modal_queue)
          match = browser.modal_inbox.find {|m|
            m['type'].to_s == type.to_s && modal_text_matches?(m['message'], text_matcher)
          }
          if match
            browser.modal_inbox.delete(match)
            pop_modal_handler(type, options)
            return match['message']
          end
          break if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
          browser.advance_virtual_clock_step(MODAL_POLL_STEP_MS)
        end
        pop_modal_handler(type, options)
        raise Capybara::ModalNotFound, "Unable to find modal dialog#{" with text matching #{text_matcher.inspect}" if text_matcher}"
      end

      def modal_text_matches?(message, matcher)
        return true if matcher.nil?
        case matcher
        when Regexp then matcher.match?(message.to_s)
        else             message.to_s.include?(matcher.to_s)
        end
      end

      # Modal handlers stack in registration order; the JS modal stub
      # picks the first whose text predicate matches the firing message.
      # Required for nested `dismiss_confirm { accept_confirm { ... } }`
      # blocks where two confirms fire in one synchronous click handler.
      def push_modal_handler(type, options, accept:)
        response = case type
                   when :alert   then true
                   when :confirm then accept
                   when :prompt  then accept ? options[:with] : false
                   end
        browser.add_modal_handler(type: type.to_s, text: options[:text], response: response)
      end

      def pop_modal_handler(type, options)
        browser.remove_modal_handler(type: type.to_s, text: options[:text])
      end

      public
    end
  end
end
