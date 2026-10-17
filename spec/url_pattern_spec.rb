# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# URLPattern is the engine's (url_pattern.rs): its components parsed by rust-urlpattern and compiled by V8 alone, so a
# regular expression group may hold what only an ECMAScript engine reads — a lookaround — as Chrome's may; an `exec`
# result is the URLPatternResult dictionary WebIDL makes, its members in lexicographic order; and a pattern is a platform
# object, which no structured clone takes. Chrome, each.
RSpec.describe 'URLPattern' do
  it 'compiles its groups as ECMAScript, answers a dictionary, and clones as nothing' do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>']] })
    session.visit '/'
    got = session.evaluate_script(<<~'JS')
      (() => {
        const r = [];
        const p = new URLPattern({pathname: '/((?!admin).*)'});
        r.push(p.test('https://e.com/admin'), p.test('https://e.com/x'));
        r.push(new URLPattern('/(.*(?<=\\.js))', 'https://e.com').test('https://e.com/a.js'));
        r.push(new URLPattern('((?!ftp)[a-z]+)://e.com/*').protocol);
        const result = new URLPattern({pathname: '/:a'}).exec('https://e.com/x');
        r.push(Object.keys(result).join('|'), Object.keys(result.pathname).join('|'));
        try { structuredClone(new URLPattern({})); r.push('cloned'); } catch (e) { r.push(e.name); }
        return r;
      })()
    JS
    expect(got).to eq([
      false, true, true, '((?!ftp)[a-z]+)', 'hash|hostname|inputs|password|pathname|port|protocol|search|username', 'groups|input',
      'DataCloneError'
    ])
  end
end
