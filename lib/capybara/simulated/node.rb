# frozen_string_literal: true

require 'capybara/node/base'
require_relative 'errors'
require_relative 'whitespace_normalizer'

module Capybara
  module Simulated
    class Node < Capybara::Driver::Node
      include WhitespaceNormalizer

      def initialize(driver, handle)
        super(driver, self)
        @handle_id    = handle
        # Pin the Browser at construction so nodes from one window
        # stay valid even after `switch_to_window` flips to another.
        @browser      = driver.current_browser
        @initial_node = @browser.lookup_node(handle)
        @context_gen  = @browser.context_gen
      end

      attr_reader :handle_id, :context_gen

      # Tick the virtual clock unconditionally on the text path. Unlike
      # `Node#[]` (attribute reads), the text readers are NOT preceded by
      # a `find_css` that ticks under the wall throttle: `have_text` /
      # `assert_text` polls `.text` directly against an already-found,
      # cached scope node, so the find loop short-circuits without
      # re-ticking. Gating these behind `timer_wait_elapsed?` therefore
      # stalls a pure text-poll loop's virtual clock and scheduled
      # `setTimeout`s never fire (smoke_spec virtual-clock contract).
      # They run ~once per poll-scope (not once per matched result like
      # the attribute filters the audit targeted), so they are not the
      # O(N) hot path and are safe to tick every call.
      def all_text
        browser.tick_real_time
        check_stale
        normalize_spacing(browser.all_text(handle_id))
      end

      def visible_text
        browser.tick_real_time
        check_stale
        normalize_visible_spacing(browser.visible_text(handle_id))
      end

      def value
        check_stale
        browser.value(handle_id)
      end

      def visible?
        check_stale
        browser.visible?(handle_id)
      end

      def tag_name = browser.tag_name(handle_id)

      # Convenience accessors mirroring real browser nodes — Discourse
      # tests reach for `.native.inner_html` (e.g. reviewables XSS
      # checks); without this method `.native` (= self) raised
      # NoMethodError.
      def inner_html
        check_stale
        browser.inner_html(handle_id)
      end

      def outer_html
        check_stale
        browser.outer_html(handle_id)
      end

      def [](name)
        # Tick the virtual clock so Capybara's helpers that poll an
        # attribute in a tight `sleep(0.1) until` loop (e.g. Avo's
        # `wait_for_body_class_missing`) actually see the JS chain
        # progress. Without this the body class never transitions
        # because we only advance time during `find`, and the helper
        # caches the body node before its poll loop.
        #
        # Gated behind the same wall-clock throttle `find_css` uses
        # (`timer_wait_elapsed?`): on framework-runloop pages that keep
        # `@timers_active` permanently true, an ungated tick here would
        # drain timers on every per-result attribute filter / poll
        # iteration. The throttle still ticks the first time and once
        # per ~50 ms window thereafter, so poll loops that wait for a
        # timer to fire between reads still make progress.
        #
        # `tick_real_time` also drains the Worker / EventSource / hijacked
        # -fetch outboxes, so an attribute poll whose value is delivered
        # only by one of those channels (with no active timer) would
        # otherwise never see it. `async_io_pending?` is an O(1) gate
        # (three empty? checks) that lets those cases drain without paying
        # an unconditional tick on timer-driven runloop pages.
        browser.tick_real_time if browser.timer_wait_elapsed? || browser.async_io_pending?
        check_stale
        browser.attr(handle_id, name.to_s)
      end

      def click(keys = [], **opts)
        check_stale
        browser.click(handle_id, keys, **opts)
      end

      def right_click(keys = [], **opts)
        check_stale
        browser.right_click(handle_id, keys, **opts)
      end

      def double_click(keys = [], **opts)
        check_stale
        browser.double_click(handle_id, keys, **opts)
      end

      def hover(**_opts)
        check_stale
        browser.hover(handle_id)
        self
      end

      def scroll_to(*, **)       ; self ; end

      # Capybara's standard rect API. No layout engine — but
      # Discourse's `wait_for_animation` helper polls `element.rect[:x]`
      # twice and waits for the values to stabilise, which they
      # immediately do here (constant zeros) since we never animate.
      # That unblocks every test guarded by an animation settle.
      def rect
        check_stale
        {x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0}
      end

      def send_keys(*keys)
        check_stale
        browser.send_keys(handle_id, keys)
        true
      end

      def trigger(event)
        check_stale
        browser.dispatch_event(handle_id, event.to_s)
        true
      end
      def drop(*args)
        check_stale
        browser.drop(handle_id, args)
        true
      end

      def drag_to(target_node, **opts)
        check_stale
        target_node.check_stale if target_node.respond_to?(:check_stale)
        target_handle = target_node.respond_to?(:handle_id) ? target_node.handle_id : target_node.native
        browser.drag_to(handle_id, target_handle, **opts)
        self
      end
      def set(value, **_)
        check_stale
        browser.set_value_with_events(handle_id, value)
      end

      def select_option
        check_stale
        browser.select_option(handle_id)
      end

      def unselect_option
        check_stale
        browser.unselect_option(handle_id)
      end

      def submit(*_)
        check_stale
        browser.submit_form(handle_id)
      end

      def find_xpath(query)
        browser.find_xpath(query, handle_id).map {|id| self.class.new(driver, id) }
      end

      def find_css(query)
        browser.find_css(query, handle_id).map {|id| self.class.new(driver, id) }
      end

      def shadow_root
        check_stale
        h = browser.shadow_root_handle(handle_id)
        h && self.class.new(driver, h)
      end
      def disabled?        = browser.disabled?(handle_id)
      def selected?        = browser.option_selected?(handle_id)
      def checked?         = !!self['checked']
      def readonly?        = !!self['readonly']
      def obscured?(*)     = !visible?
      def synchronize(*)   = yield
      def style(names = [])
        check_stale
        browser.computed_style(handle_id, Array(names))
      end
      def path
        check_stale
        browser.node_path(handle_id)
      end

      # Both handle_id and context_gen are part of identity: after a
      # cross-page reload the new element can land on the same handle
      # id (JS-side counter resets per ctx) but a different generation.
      # Capybara's synchronize uses `old_base == @base` to decide
      # whether reload made progress, so id-only equality would mark
      # a successful reload as a no-op and raise the original error.
      def ==(other)
        other.is_a?(Node) &&
          other.handle_id == @handle_id &&
          other.context_gen == @context_gen
      end

      private

      def browser     = @browser
      def check_stale = browser.check_stale(handle_id, @initial_node, @context_gen)
    end
  end
end
