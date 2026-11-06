# frozen_string_literal: true

require 'capybara/simulated'
require 'tmpdir'
require_relative 'support/session_teardown'

# A navigation's response loads by its computed MIME type (HTML "load a document", MIME Sniffing §7; mime.rs
# `document_type`): one of no type to go by — none, an empty or invalid one, `unknown/unknown` — sniffed from its first
# bytes, text a `text/plain` document and binary a download; an Apache-bug `text/plain` that is binary a download; a
# type no document is made of — an unsupported image type among them — a download. A download leaves the window at the
# document it shows: `current_url` is that one's, `about:blank` for a window that has none yet. A `blob:` URL's
# navigation goes by the blob's type the same way, its download named by the blob URL's UUID and its type's extension
# (Chrome 156).
RSpec.describe 'a navigation response by its type' do
  let(:hits) { [] }
  let(:session) do
    seen = hits
    simulated_session(lambda {|env|
      seen << env['PATH_INFO']
      case env['PATH_INFO']
      when '/none' then [200, {}, ['plain words']]
      when '/nonebin' then [200, {}, ["\x00\x01\x02bin".b]]
      when '/invalid' then [200, {'content-type' => 'garbage'}, ['<p id=p>sniffed']]
      when '/unknown' then [200, {'content-type' => 'unknown/unknown'}, ["PK\x03\x04zip".b]]
      when '/apache' then [200, {'content-type' => 'text/plain'}, ["\x00\x01\x02bin".b]]
      when '/apachetext' then [200, {'content-type' => 'text/plain; charset=UTF-8'}, ['words']]
      when '/img' then [200, {'content-type' => 'image/x-foo'}, ['abc']]
      when '/x.csv' then [200, {'content-type' => 'text/csv'}, ["a,b\n"]]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><title>start</title><p id=start>start']]
      end
    })
  end

  around do |example|
    Dir.mktmpdir do |dir|
      @downloads = dir
      prev = ENV['CSIM_DOWNLOADS_DIR']
      ENV['CSIM_DOWNLOADS_DIR'] = dir
      example.run
    ensure
      ENV['CSIM_DOWNLOADS_DIR'] = prev
    end
  end

  {'/none' => 'text/plain', '/invalid' => 'text/html', '/apachetext' => 'text/plain'}.each do |path, type|
    it "makes a #{type} document of #{path}" do
      session.visit path
      expect([session.current_path, session.evaluate_script('document.contentType'), Dir.children(@downloads)]).to eq([path, type, []])
    end
  end

  # (…named by its URL, an extensionless one given its supplied type's extension where that has one: downloads.rs)
  {'/nonebin' => 'nonebin', '/unknown' => 'unknown', '/apache' => 'apache.txt', '/img' => 'img', '/x.csv' => 'x.csv'}.each do |path, name|
    it "downloads #{path}, the page staying at its document" do
      session.visit '/'
      session.visit path
      expect([session.current_path, session.has_css?('#start'), Dir.children(@downloads)]).to eq(['/', true, [name]])
    end
  end

  it "reports a fresh window's about:blank after a download" do
    session.visit '/x.csv'
    expect([session.current_url, Dir.children(@downloads)]).to eq(['about:blank', ['x.csv']])
  end

  it "downloads a blob: URL's of a type no document is made of, by its UUID and type" do
    session.visit '/'
    url = session.evaluate_script("window.u = URL.createObjectURL(new Blob(['x'], {type: 'application/zip'}))")
    session.execute_script('location.href = u')
    session.evaluate_script('1')
    expect([session.current_path, Dir.children(@downloads)]).to eq(['/', ["#{url.split('/').last}.zip"]])
  end

  it "navigates a visit to a fragment of the page's document in it" do
    session.visit '/'
    session.visit '#vx'
    session.visit "#{session.current_url.sub(/#.*/, '')}#vy"
    expect([session.current_url, hits, session.evaluate_script('history.length')]).to eq(['http://www.example.com/#vy', ['/'], 3])
  end
end
