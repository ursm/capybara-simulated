# frozen_string_literal: true

module Capybara
  module Simulated
    # A top-level traversable `window.open` made in a Browser's isolate — its documents realms of that isolate, its event
    # loop the isolate's, its page's script reaching it as a native WindowProxy — as the driver addresses it: a window of
    # the session like any other (Driver#window_entries), whose handle Capybara switches to, finds in, clicks in,
    # evaluates in and paints. The commands a Browser answers for its page's document (`SCOPED`) it answers for this
    # window's, its host running them in its scope (Browser#in_window: its document's realm the root, the frames it
    # entered its own); what is the window's own — its URL, its title, its navigations, its viewport, its response, its
    # close — its host does to its realm. Nothing else of the host's — its page, its session history, its teardown — is
    # reached through it. It is known by its key (navigables.rs `window_keys`: the realm of its first document, which
    # outlives the realms its navigations replace it with).
    class RealmWindow
      # The host's commands that act on the document addressed — Capybara's finds, node operations, scripts, paint, keys
      # and modals (Driver, Node).
      SCOPED = %i[
        active_element_handle all_text async_io_pending? attr check_stale click computed_style context_gen
        current_realm_id disabled? dispatch_event double_click drag_to drop evaluate_async_script evaluate_script
        execute_script find_css find_xpath hover html inner_html lookup_node node_path obscured? option_selected?
        outer_html peek_script rect right_click screenshot_png scroll_by scroll_to select_option send_keys
        send_session_keys set_geolocation set_header set_value_with_events shadow_root_handle submit_form
        switch_to_frame tag_name tick_for_read tick_real_time timer_wait_elapsed? trace_screenshot unselect_option value
        visible? visible_text polling?
      ].freeze

      attr_reader :host, :key
      attr_accessor :window_handle, :frame_stack

      def initialize(host, key)
        @host        = host
        @key         = key
        @frame_stack = []
      end

      SCOPED.each do |name|
        define_method(name) do |*args, **opts, &block|
          host.in_window(self) { host.public_send(name, *args, **opts, &block) }
        end
      end

      # The realm of the document it shows now — none once it is gone — and whether its close was asked or ran: asked of
      # its host again only once a window of the host's was made, navigated, closed or let go of since (its generation,
      # Browser#window_realm_gen), not per command.
      def realm        = state[0]
      def closing?     = state[1]
      def discard_due? = state[2]

      # ── The window's own
      # (…read as the page's are: the clock stepped first, its timers' navigations taken — Browser#current_url)
      def current_url
        host.tick_real_time
        raw_current_url
      end
      def raw_current_url = (r = realm) ? host.window_realm_url(r) : ''
      def title
        host.tick_real_time
        host.window_realm_title(realm!)
      end
      def visit(url)      = host.visit_window_realm(realm!, host.resolve_visit_url(url, raw_current_url))
      def refresh         = host.refresh_window_realm(realm!)
      def go_back         = host.traverse_window_realm(realm!, -1)
      def go_forward      = host.traverse_window_realm(realm!, 1)
      def viewport_width  = host.window_realm_viewport(realm!)[0]
      def viewport_height = host.window_realm_viewport(realm!)[1]
      def screen_size     = host.screen_size
      def set_viewport(w, h)
        host.set_window_realm_viewport(realm!, w, h)
      end
      # The response its document was made of, as the page's (Browser#status_code, #response_headers).
      def status_code      = host.window_realm_response(realm!)[0].to_i
      def response_headers = Browser.capitalized_headers(host.window_realm_response(realm!)[1])

      # The user's close (Capybara's `Window#close`), and its realms let go of after a script's close discarded it.
      def close!   = host.close_window_realm(key)
      def discard! = host.discard_window_realm(key)

      # The modal handler its isolate's, the commands of the block each in the scope of the window it addresses.
      def with_modal(handler, &block) = host.with_modal(handler, &block)

      # ── What it shares with its host: its browsing context group, its isolate's busy-ness
      def browsing_context_group = host.browsing_context_group
      def window_busy?           = host.window_busy?

      private def realm! = realm || raise(Capybara::WindowError, "Window #{window_handle} is closed; switch to another window")
      private def state
        gen = host.window_realm_gen
        return @state if @state_gen == gen

        @state_gen = gen
        @state     = host.window_realm_state(key)
      end
    end
  end
end
