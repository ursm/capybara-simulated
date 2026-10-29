# frozen_string_literal: true

require 'json'
require 'capybara/simulated'
require_relative 'support/session_teardown'

# Fetch "HTTP-network-or-cache fetch": what a request's cache mode appends to the header list each hop sends, where the
# request has no such header of its own — a no-cache request a `Cache-Control: max-age=0`, a no-store or reload one
# `Pragma: no-cache` and `Cache-Control: no-cache` — and a default-mode request with a conditional header made a no-store
# one first. (WPT's request-cache tests cannot see a missing one: an expected header absent from what the server
# recorded passes their check.)
RSpec.describe 'the headers a fetch of a cache mode sends' do
  let(:session) {
    simulated_session(lambda {|env|
      case env['PATH_INFO']
      when '/echo'
        seen = {pragma: env['HTTP_PRAGMA'], cache_control: env['HTTP_CACHE_CONTROL']}
        [200, {'content-type' => 'application/json', 'cache-control' => 'no-store'}, [seen.to_json]]
      when '/tagged'
        # (…a 304 where the request's validator is the current one, else the body with the validator it was asked by)
        sent = env['HTTP_IF_NONE_MATCH']
        next [304, {'etag' => '"y"'}, []] if sent == '"y"'

        [200, {'content-type' => 'text/plain', 'etag' => '"y"', 'cache-control' => 'max-age=3600'}, ["sent #{sent.inspect}"]]
      else
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8>']]
      end
    })
  }

  before { session.visit '/' }

  def sent(init)
    session.evaluate_async_script(<<~JS)
      const done = arguments[arguments.length - 1];
      fetch('/echo', #{init.to_json}).then((r) => r.json()).then(done, (e) => done(String(e)));
    JS
  end

  # (…a request of its own validators an externally conditionalized one, whatever its mode: the cache neither answers it
  # nor puts its own validators in their place, and its 304 is the page's — RFC 9111 §4.3.2, Chrome's and Firefox's)
  it "keeps a request's own validators and its 304, whatever its cache mode" do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[arguments.length - 1];
      const read = (init) => fetch('/tagged', init).then(async (r) => r.status + ' ' + await r.text());
      (async () => [
        await read({}),
        await read({cache: 'no-cache', headers: {'If-None-Match': '"x"'}}),
        await read({cache: 'no-cache', headers: {'If-None-Match': '"y"'}}),
        await read({cache: 'force-cache', headers: {'If-None-Match': '"x"'}})
      ])().then(done, (e) => done(String(e)));
    JS
    expect(got).to eq(['200 sent nil', '200 sent "\\"x\\""', '304 ', '200 sent "\\"x\\""'])
  end

  {
    {}                                                             => [nil, nil],
    {cache: 'force-cache'}                                         => [nil, nil],
    {cache: 'no-cache'}                                            => [nil, 'max-age=0'],
    {cache: 'no-store'}                                            => %w[no-cache no-cache],
    {cache: 'reload'}                                              => %w[no-cache no-cache],
    {headers: {'If-None-Match' => '"x"'}}                          => %w[no-cache no-cache],
    {cache: 'no-store', headers: {'Cache-Control' => 'max-age=5'}} => ['no-cache', 'max-age=5']
  }.each do |init, (pragma, cache_control)|
    it "sends Pragma #{pragma.inspect} and Cache-Control #{cache_control.inspect} for #{init.to_json}" do
      expect(sent(init)).to eq('pragma' => pragma, 'cache_control' => cache_control)
    end
  end
end
