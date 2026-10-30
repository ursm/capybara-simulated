# frozen_string_literal: true

# A session made under `every_host_local { … }` serves every host from the app in-process — another origin's page, a
# service worker's script — where by default only the app's own host is local and the rest is fetched off the network.
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
end
