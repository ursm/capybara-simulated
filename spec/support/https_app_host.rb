# frozen_string_literal: true

# An example tagged `https: true` has its app served at `https://www.example.com`: a relative `visit` lands there, and
# that origin is the app's own, local, as `http://www.example.com` is by default. A request's Fetch Metadata goes to a
# potentially trustworthy URL alone (Fetch "append the Fetch metadata headers for a request"), so an example reading
# Sec-Fetch-* is one of these — an `https://www.example.com` visited without it is another host, fetched off the network.
RSpec.configure do |config|
  config.around(:each, :https) do |example|
    prev = Capybara.app_host
    Capybara.app_host = 'https://www.example.com'
    example.run
  ensure
    Capybara.app_host = prev
  end
end
