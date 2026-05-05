#!/usr/bin/env ruby
# Higher-level repro — runs the actual Capybara shared spec against
# the v2 (Nokogiri + QuickJS) driver. Each "test" calls reset_session!
# then visits /with_js, which loads jQuery + jquery-ui + test.js into
# the persistent VM. After ~600-1000 visits the process core-dumps.
#
# This is the code path the project surfaced the bug from. The
# pure-quickjs repro is a smaller, gem-only standalone version of
# the same workload.
#
# Usage: bundle exec ruby upstream_repros/capybara_simulated_repro.rb [ITER]

$LOAD_PATH.unshift File.expand_path('../../lib', __FILE__)
require 'capybara/simulated'
require 'capybara/spec/test_app'

ITER = (ARGV[0] || 1500).to_i

session = Capybara::Session.new(:simulated_v2, TestApp)

ITER.times do |i|
  session.reset_session!
  session.visit '/with_js'
  session.find('h1', text: 'FooBar')  # exercise a query
  if (i % 50).zero?
    puts "iter #{i}: rss=#{`ps -o rss= -p #{$$}`.strip} KB"
  end
end

puts 'survived'
