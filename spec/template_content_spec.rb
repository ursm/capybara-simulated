require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# `<template>`'s contract: its children live in `template.content`
# (a DocumentFragment), not in the live tree. Selector queries that
# target the document or any live ancestor must skip them; form
# serialization must skip them too. Avo's polymorphic belongs-to
# render is a load-bearing example — without this, every commentable
# type's hidden `<select>` ends up in the request body.
RSpec.describe 'template content semantics' do
  let(:app) {
    lambda do |env|
      req = Rack::Request.new(env)
      case req.path_info
      when '/'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><body>
            <form action="/submit" method="post">
              <input type="text" name="live" value="live-val">
              <template id="t">
                <input type="text" name="from-template" value="template-val">
                <select name="from-template-select"><option value="x">X</option></select>
              </template>
              <button type="submit">submit</button>
            </form>
          </body></html>
        HTML
      when '/submit'
        body = req.params.map { |k, v| "<pre id=\"r-#{k}\">#{v}</pre>" }.join
        [200, {'content-type' => 'text/html'}, ["<!doctype html><html><body>#{body}</body></html>"]]
      else
        [404, {}, ['nope']]
      end
    end
  }
  let(:session) { simulated_session(app) }

  before { session.visit '/' }

  describe 'querySelectorAll' do
    it 'does not include nodes inside <template>' do
      live  = session.evaluate_script('document.querySelectorAll("input[name=\'live\']").length')
      tpl   = session.evaluate_script('document.querySelectorAll("input[name=\'from-template\']").length')
      expect(live).to eq(1)
      expect(tpl).to eq(0)
    end
  end

  describe 'querySelector / getElementById' do
    it 'returns null for fields that only exist inside <template>' do
      live = session.evaluate_script('document.querySelector("input[name=\'live\']")?.name')
      hit  = session.evaluate_script('document.getElementById("t")?.tagName')
      tpl  = session.evaluate_script('document.querySelector("input[name=\'from-template\']")')
      expect(live).to eq('live')
      expect(hit).to eq('TEMPLATE')
      expect(tpl).to be_nil
    end
  end

  describe 'Capybara find' do
    it 'does not see fields inside <template>' do
      expect(session).to have_field('live', with: 'live-val')
      expect(session).not_to have_field('from-template')
    end
  end

  describe 'form serialization' do
    it 'submits only live fields, skipping template descendants' do
      session.find_button('submit').click
      expect(session).to have_css('#r-live', text: 'live-val')
      expect(session).not_to have_css('#r-from-template')
      expect(session).not_to have_css('#r-from-template-select')
    end
  end
end
