# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# What answers a subresource request is the engine's (fetch_rules.rs `fetch_route`), by the URL as it resolves: a
# `<link rel=stylesheet>` of a `blob:` URL loads its blob's sheet and applies it, and one whose `href` has white space
# around a `data:` URL is that data: URL's — neither is a request to the network.
RSpec.describe 'a subresource request route' do
  include PollUntil

  it 'loads a blob: or a spaced data: style sheet by its scheme' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><p id=a>a</p><p id=b>b</p>']] })
    s.visit '/'
    s.execute_script(<<~JS)
      window.seen = [];
      const add = (href, label) => {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = href;
        l.onload = () => seen.push(label + ' load');
        l.onerror = () => seen.push(label + ' error');
        document.head.appendChild(l);
      };
      add(URL.createObjectURL(new Blob(['#a { color: rgb(1, 2, 3) }'], { type: 'text/css' })), 'blob');
      add('  data:text/css,%23b%20%7B%20color%3A%20rgb(4%2C%205%2C%206)%20%7D', 'data');
    JS
    expect(poll_until { (v = s.evaluate_script('seen')).size == 2 && v }.sort).to eq(['blob load', 'data load'])
    expect(s.evaluate_script("['a', 'b'].map((id) => getComputedStyle(document.getElementById(id)).color)")).to eq(['rgb(1, 2, 3)', 'rgb(4, 5, 6)'])
  end
end
