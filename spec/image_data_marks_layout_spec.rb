# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An image's data applied — whichever way it arrived: the network's, a `data:` URL's, a `blob:` URL's store's — moves
# what it shows (image_requests.rs `shown_changed`): the box after it lands where the image's size puts it, in its
# `load` listener and after, though the layout was read between its `src` set and its data, and an IntersectionObserver
# sees what it pushed out of view.
RSpec.describe "an image's data applied" do
  svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="3000"></svg>'
  app = lambda {|env|
    if env['PATH_INFO'] == '/i.svg'
      [200, {'content-type' => 'image/svg+xml'}, [svg]]
    else
      [200, {'content-type' => 'text/html'},
       ['<!DOCTYPE html><meta charset="utf-8"><body style="margin:0"><img id=im style="display:block">' \
        '<div id=t style="height:10px">T</div>']]
    end
  }

  {'network' => "'/i.svg'", 'data:' => "'data:image/svg+xml,' + encodeURIComponent(SVG)",
   'blob:' => "URL.createObjectURL(new Blob([SVG], {type: 'image/svg+xml'}))"}.each do |name, src|
    it "lays out what follows a #{name} image as its size puts it" do
      s = simulated_session(app)
      s.visit '/'
      s.execute_script(<<~JS)
        const SVG = '#{svg}';
        window.seen = []; window.loaded = [];
        const t = document.getElementById('t'), im = document.getElementById('im');
        new IntersectionObserver((es) => es.forEach((e) => seen.push(e.isIntersecting))).observe(t);
        im.onload = () => loaded.push(Math.round(t.getBoundingClientRect().top));
        setTimeout(() => { im.src = #{src}; t.getBoundingClientRect(); }, 30);
      JS
      sleep 0.3
      s.evaluate_script('1')
      top = s.evaluate_script("Math.round(document.getElementById('t').getBoundingClientRect().top)")
      expect([s.evaluate_script('loaded'), top, s.evaluate_script('seen').last]).to eq([[3000], 3000, false])
    end
  end
end
