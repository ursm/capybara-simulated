# frozen_string_literal: true

require 'capybara/node/base'

module Capybara
  module Simulated
    # `Capybara::Node::WhitespaceNormalizer` was extracted in capybara
    # 3.40 — Forem (and other apps that pin `~> 3.37`) still ship the
    # older release where the module doesn't exist. Inline copies of
    # `normalize_spacing` / `normalize_visible_spacing` keep the gem
    # working against the whole 3.37+ range; they're stable text-
    # processing helpers, no behavioural drift to worry about.
    module WhitespaceNormalizer
      NON_BREAKING_SPACE  = " "
      LINE_SEPERATOR      = " "
      PARAGRAPH_SEPERATOR = " "
      BREAKING_SPACES     = "[[:space:]&&[^#{NON_BREAKING_SPACE}]]".freeze
      SQUEEZED_SPACES     = " \n\f\t\v#{LINE_SEPERATOR}#{PARAGRAPH_SEPERATOR}".freeze
      LEADING_SPACES      = /\A#{BREAKING_SPACES}+/
      TRAILING_SPACES     = /#{BREAKING_SPACES}+\z/
      ZERO_WIDTH_SPACE    = "​"
      LEFT_TO_RIGHT_MARK  = "‎"
      RIGHT_TO_LEFT_MARK  = "‏"
      REMOVED_CHARACTERS  = [ZERO_WIDTH_SPACE, LEFT_TO_RIGHT_MARK, RIGHT_TO_LEFT_MARK].join
      EMPTY_LINES         = /[\ \n]*\n[\ \n]*/

      def normalize_spacing(text)
        text
          .delete(REMOVED_CHARACTERS)
          .tr(SQUEEZED_SPACES, ' ')
          .squeeze(' ')
          .sub(LEADING_SPACES, '')
          .sub(TRAILING_SPACES, '')
          .tr(NON_BREAKING_SPACE, ' ')
      end

      def normalize_visible_spacing(text)
        text
          .squeeze(' ')
          .gsub(EMPTY_LINES, "\n")
          .sub(LEADING_SPACES, '')
          .sub(TRAILING_SPACES, '')
          .tr(NON_BREAKING_SPACE, ' ')
      end
    end

    class Node < Capybara::Driver::Node
      include WhitespaceNormalizer

      def initialize(driver, handle)
        # Pass `self` as the Capybara `native`: tests routinely write
        # `find(...).native.send_keys(...)` (Selenium / Cuprite return
        # an Element with that method), so exposing the integer handle
        # directly would error out. Our Node already implements
        # `send_keys`, `[]`, `click`, etc.
        super(driver, self)
        @handle_id = handle
        # Pinning the original Nokogiri node here is what lets `==` and
        # stale-checks survive integer-handle reuse after page reloads.
        @initial_node = driver.browser.lookup_node(handle)
      end

      attr_reader :handle_id

      def all_text
        check_stale
        normalize_spacing(browser.all_text(handle_id))
      end

      def visible_text
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

      def [](name)
        check_stale
        browser.attr(handle_id, name.to_s)
      end

      # `delay:` is replayed as a real `sleep` between mousedown and
      # mouseup so JS reading `Date.now()` sees the gap. `offset:` is
      # `:center` when `Capybara.w3c_click_offset = true`, otherwise nil.
      def click(keys = [], delay: 0, x: nil, y: nil, offset: nil, **_opts)
        check_stale
        browser.click(handle_id, keys, delay: delay, x: x, y: y, offset: offset)
      end

      def right_click(keys = [], delay: 0, x: nil, y: nil, offset: nil, **_opts)
        browser.right_click(handle_id, keys, delay: delay, x: x, y: y, offset: offset)
      end

      def double_click(keys = [], delay: 0, x: nil, y: nil, offset: nil, **_opts)
        browser.double_click(handle_id, keys, delay: delay, x: x, y: y, offset: offset)
      end

      # Capybara hover dispatches mouseenter / mouseover so listeners
      # that toggle hover-only UI fire. We can't drive CSS `:hover` (no
      # layout engine), but most uses are JS event hooks — Redmine's
      # tooltip dismissal calls `find('body').hover` to push a
      # mouseleave to the previously-hovered element.
      def hover(**_opts)
        browser.hover(handle_id)
        self
      end

      # `scroll_to` exists in Capybara to bring an element into view —
      # without a layout engine there's no scroll position to update,
      # but tests routinely call it as a noop pre-amble to a click /
      # find. Returning self keeps method chaining alive.
      def scroll_to(*_args, **_opts)
        self
      end

      def send_keys(*keys)
        browser.send_keys(handle_id, keys)
        true
      end

      # Capybara's Element#trigger surfaces here with a String/Symbol
      # event name. Bubbling matches what Capybara's selenium driver
      # produces for synthesised events.
      def trigger(event)
        browser.dispatch_event(handle_id, event.to_s)
        true
      end

      # Element#drop — Capybara's HTML5 drag-and-drop entry point.
      # Accepts file paths (Strings / Pathnames) and / or one Hash
      # `{mime_type => value}` for non-file dataTransfer items. Forwards
      # to Browser#drop which fires the drag event sequence with a
      # dataTransfer payload constructed from the args.
      def drop(*args)
        browser.drop(handle_id, args)
        true
      end

      def set(value, **_opts)
        browser.set_value_with_events(handle_id, value)
      end

      def select_option
        browser.select_option(handle_id)
      end

      def unselect_option
        browser.unselect_option(handle_id)
      end

      def submit(*_args)
        browser.submit_form(handle_id)
      end

      def find_xpath(query)
        browser.find_xpath(query, handle_id).map { |id| self.class.new(driver, id) }
      end

      def find_css(query)
        browser.find_css(query, handle_id).map { |id| self.class.new(driver, id) }
      end

      def shadow_root
        h = browser.shadow_root_handle(handle_id)
        h && self.class.new(driver, h)
      end

      def disabled?    = browser.disabled?(handle_id)
      # `selected?` mirrors the HTMLOptionElement IDL attribute (which
      # Capybara consults for `have_select(selected: 'X')`): a `<select>`
      # without `multiple` and no explicitly-selected option implicitly
      # selects its first non-disabled option, so we have to ask
      # Browser#option_selected? rather than just reading the attribute.
      def selected? = browser.option_selected?(handle_id)
      def checked?     = !!self['checked']
      def readonly?    = !!self['readonly']
      def obscured?(*) = !visible?

      def synchronize(*) = yield

      # Capybara's `style(*names)` / `matches_style?` consult computed
      # style. We resolve through the cascade (real CSS rules) and fall
      # back to inline `style="..."` declarations so authors using
      # `matches_style?(display: "inline-block")` and similar see the
      # value the stylesheet actually computed, not the empty hash that
      # the no-layout-engine fallback used to return.
      def style(*styles)
        names = styles.flatten.map(&:to_s)
        return {} if names.empty?
        browser.computed_style(handle_id, names)
      end
      def path           = browser.node_path(handle_id)

      def ==(other)
        other.is_a?(Node) && other.initial_node.equal?(@initial_node)
      end

      protected

      attr_reader :initial_node

      private

      def browser = driver.browser
      def check_stale = browser.check_stale(handle_id, @initial_node)
    end
  end
end
