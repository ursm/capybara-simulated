# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The arena is each realm's copy of the trees its document holds: a node moved into a frame's document is registered
# in the frame's, and what it brings must come with it without taking anything out of the tree it left.
RSpec.describe 'arena mirror' do
  let(:app) { ->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><iframe></iframe>']] } }

  # A control the parser gave a form owner keeps that pointer until it moves; one moved into a frame's document with
  # an ancestor dragged the form along, out of the document's own copy, and the form stopped matching any selector.
  it 'leaves a form where it is when a control under it moves into a frame' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const frame = document.querySelector('iframe').contentDocument;
        const holder = document.createElement('div');
        document.body.appendChild(holder);
        holder.innerHTML = '<form id=fm><label><p id=p1><input id=t13></p></label></form>';
        frame.body.appendChild(document.getElementById('p1'));
        return [document.querySelectorAll('form').length, document.querySelector('#fm') !== null,
                document.getElementById('fm').matches('div > form')];
      })()
    JS
    expect(got).to eq([1, true, true])
  end

  # A template the document made, put into a frame's document: its contents, made when first asked for, are the frame's
  # to serialize.
  it "serializes the contents of a template in a frame's document" do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const frame = document.querySelector('iframe').contentDocument;
        const t = document.createElement('template');
        t.id = 'tm';
        frame.body.append(t);
        t.innerHTML = '<i>x</i>';
        return [t.outerHTML, frame.body.innerHTML.includes('<i>x</i>')];
      })()
    JS
    expect(got).to eq(['<template id="tm"><i>x</i></template>', true])
  end
end
