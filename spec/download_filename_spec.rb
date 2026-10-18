# frozen_string_literal: true

require 'capybara/simulated'
require 'tmpdir'
require_relative 'support/session_teardown'

# A download is saved under the filename its Content-Disposition gives (RFC 6266 §4.3, Browser#disposition_filename):
# `filename*`'s ext-value (RFC 8187, its charset's bytes percent-encoded) over `filename`, whose raw UTF-8 bytes are
# UTF-8 (Chrome) — they had been read each byte a code point (`café` saved as `cafÃ©`), `filename*` not decoded — and no
# directory of it.
RSpec.describe 'a download' do
  around do |example|
    Dir.mktmpdir do |dir|
      prev = ENV['CSIM_DOWNLOADS_DIR']
      ENV['CSIM_DOWNLOADS_DIR'] = dir
      @dir = dir
      example.run
    ensure
      ENV['CSIM_DOWNLOADS_DIR'] = prev
    end
  end

  it "is saved under the name its Content-Disposition gives" do
    dispositions = {
      '/ext'  => %q{attachment; filename*=UTF-8''%C3%A9t%C3%A9.csv; filename="fallback.csv"},
      '/raw'  => "attachment; filename=\"caf\xC3\xA9.txt\"".b,
      '/path' => 'attachment; filename="../../escape.txt"'
    }
    app = lambda {|env|
      next [200, {'content-type' => 'text/plain', 'content-disposition' => dispositions[env['PATH_INFO']]}, ['x']] if dispositions.key?(env['PATH_INFO'])
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><a href="/ext">e</a><a href="/raw">r</a><a href="/path">p</a>']]
    }
    s = simulated_session(app)
    %w[e r p].each do |link|
      s.visit '/'
      s.click_link link
    end
    expect(Dir.children(@dir).sort).to eq(%w[café.txt escape.txt été.csv].sort)
  end
end
