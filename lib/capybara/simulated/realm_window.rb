# frozen_string_literal: true

module Capybara
  module Simulated
    # A top-level traversable `window.open` made in a Browser's isolate — its documents realms of that isolate, its event
    # loop the isolate's, its page's script reaching it as a native WindowProxy — as the driver addresses it: a window of
    # the session like any other (Driver#window_entries), whose handle Capybara switches to, finds in, clicks in,
    # evaluates in and paints. Every command a Browser answers for its page it answers for this window's document, its
    # host's commands run in its scope (Browser#in_window: its document's realm the root, the frames it entered its own);
    # what is the window's own — its URL, its title, its navigations, its viewport, its close — its host does to its
    # realm. It is known by its key (navigables.rs `window_keys`: the realm of its first document, which outlives the
    # realms its navigations replace it with).
    class RealmWindow
      attr_reader :host, :key
      attr_accessor :window_handle, :frame_stack

      def initialize(host, key)
        @host        = host
        @key         = key
        @frame_stack = []
      end

      # The realm of the document it shows now — none once it is gone.
      def realm = host.window_realm(key)

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
      def window_name     = (r = realm) ? host.window_realm_name(r) : ''
      def viewport_width  = host.window_realm_viewport(realm!)[0]
      def viewport_height = host.window_realm_viewport(realm!)[1]
      def set_viewport(w, h) = host.set_window_realm_viewport(realm!, w, h)
      def screen_size     = host.screen_size
      # (…the response its document was made of is the host's to remember for its page alone: Capybara's
      # `status_code` / `response_headers` are a Selenium-less extension, which a window's document answers as one loaded)
      def status_code      = 200
      def response_headers = {}

      # Whether its close ran — a script's close task, or the user's — the window to be let go of, or it went with its
      # host's page (Driver#reap_closed_windows); whether its close was asked.
      def discard_due? = !host.window_realm?(key)
      def closing?     = host.window_realm_closing?(key)
      # The user's close (Capybara's `Window#close`), and its realms let go of after a script's close discarded it.
      def close!   = host.close_window_realm(key)
      def discard! = host.discard_window_realm(key)

      # ── What it shares with its host: its browsing context group, its isolate's event loop and what waits on it
      def browsing_context_group = host.browsing_context_group
      def window_busy?           = host.window_busy?
      def polling?               = host.polling?

      # ── Every other command its host's, for this window's document
      def method_missing(name, *args, **opts, &block)
        return super unless host.respond_to?(name)

        host.in_window(self) { host.public_send(name, *args, **opts, &block) }
      end

      def respond_to_missing?(name, include_private = false) = host.respond_to?(name) || super

      private def realm! = realm || raise(Capybara::WindowError, "Window #{window_handle} is closed; switch to another window")
    end
  end
end
