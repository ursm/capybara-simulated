# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What makes an insertion, a replacement or a move valid is the engine's (mutation.rs): a node may not go under one of
# its host-including descendants — through a shadow root's host and a template's contents' template alike — and a
# Document keeps one element and one doctype. Each expectation below is Chrome's.
RSpec.describe 'insertion validity' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><template id=t><p>x</p></template>']] }) }

  before { session.visit '/' }

  it 'refuses a template into its own contents, and a host into its shadow tree' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('t'), out = [];
        const tryIt = (f) => { try { f(); out.push('ok'); } catch (e) { out.push(e.name); } };
        tryIt(() => t.content.appendChild(t));
        tryIt(() => t.content.firstChild.appendChild(t));
        const h = document.body.appendChild(document.createElement('div'));
        const sr = h.attachShadow({mode: 'open'});
        tryIt(() => sr.appendChild(h));
        tryIt(() => h.appendChild(document.createAttribute('a')));
        tryIt(() => document.appendChild(document.createElement('x')));
        tryIt(() => document.replaceChild(document.createElement('html'), document.documentElement));
        return out;
      })()
    JS
    expect(got).to eq(%w[HierarchyRequestError HierarchyRequestError HierarchyRequestError HierarchyRequestError HierarchyRequestError ok])
  end
end
