# frozen_string_literal: true

# A session made under `every_host_local { … }` serves every host from the app in-process — another origin's page, a
# service worker's script — where by default only the app's own host is the app's, and a request of any other is a
# network error.
# The driver reads `CSIM_LOCAL_ALL_HOSTS` when the session is made and keeps the setting it was made with, so the block
# need hold only that. An example or a group tagged `:every_host_local` runs whole under it.
module EveryHostLocal
  def self.within
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'
    yield
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  def every_host_local(&)
    EveryHostLocal.within(&)
  end
end

RSpec.configure do |config|
  config.include EveryHostLocal

  config.around(:each, :every_host_local) do |example|
    EveryHostLocal.within { example.run }
  end

  # …and under `:app_answers_every_host` a request of another host goes to the network (the driver's `external_network:
  # true`), which here refuses every one, so the app answers it (Browser#dispatched) — another host the app's to serve, as
  # under `:every_host_local`, but the session's default host the secure stand-in it is by default, which
  # `:every_host_local` gives up (a secure context's spec: WebAuthn, a service worker, a cross-origin isolated page).
  # (…and under `:external_network` alone, the real network: a spec's own server on a port of this machine)
  config.before(:each) do |example|
    next unless example.metadata[:app_answers_every_host] || example.metadata[:external_network]

    allow(Capybara::Simulated::Driver).to receive(:new).and_wrap_original {|new, *args, **kw| new.call(*args, **kw.merge(external_network: true)) }
    allow_any_instance_of(Capybara::Simulated::Browser).to receive(:net_http_fetch).and_return(nil) unless example.metadata[:external_network]
  end
end
