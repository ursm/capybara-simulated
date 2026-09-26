# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What `elementFromPoint` answers where boxes overlap: the one PAINTED on top, by CSS 2.1 appendix E. Inside a
# stacking context the block backgrounds paint first, then the floats, then the inline-level content, then the
# positioned boxes; a float, an atomic inline and a `z-index: auto` positioned box each paint as ONE unit, their
# positioned descendants excepted. Placement order is not paint order — a float placed before a block still covers
# it. Every answer below is Chrome's, read off this markup with `--headless --dump-dom` (each probe is 50px in and
# 25px down from the shape's top-left corner unless it says otherwise). A "was" names what the placement-order
# ranking said, which knew no phases and no stacking context but a positioned box's.
RSpec.describe 'paint order' do
  def hit(body, x: 50, y: 25)
    html = %(<!DOCTYPE html><html><head><style>body{margin:0} div,span{box-sizing:border-box}</style></head><body>#{body}</body></html>)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s.evaluate_script("(e => e && (e.id || e.tagName))(document.elementFromPoint(#{x}, #{y}))")
  end

  def with_negative_child(style, before: '')
    %(#{before}<div id="ctx" style="#{style};height:120px"><div id="neg" style="position:relative;z-index:-1;width:100px;height:100px"></div></div>)
  end

  it 'paints a float over the block backgrounds of its context' do
    expect(hit(<<~HTML)).to eq('float')   # was: block
      <div id="float" style="float:left;width:100px;height:100px"></div><div id="block" style="height:50px"></div>
    HTML
  end

  it 'paints an inline-level box over a float' do
    expect(hit(<<~HTML)).to eq('ib')      # was: float
      <div style="height:100px"><span id="ib" style="display:inline-block;width:80px;height:40px"></span></div>
      <div id="float" style="float:left;width:100px;height:100px;margin-top:-100px"></div>
    HTML
  end

  it 'paints what is inside an atomic inline with it, over a later float' do
    expect(hit(<<~HTML)).to eq('inner')
      <span style="display:inline-block;width:100px;height:100px;vertical-align:top"><div id="inner" style="height:100px"></div></span><div
        id="float" style="float:left;width:100px;height:100px;margin-left:-100px"></div>
    HTML
  end

  it 'paints what is inside a float with it, under a later float' do
    expect(hit(<<~HTML)).to eq('later')
      <div style="float:left;width:100px;height:100px"><div id="inner" style="height:100px"></div></div><div
        id="later" style="float:left;width:100px;height:100px;margin-left:-100px"></div>
    HTML
  end

  it 'lifts a positioned box out of the float it sits in' do
    expect(hit(<<~HTML)).to eq('rel')
      <div style="float:left;width:100px;height:100px"><div id="rel" style="position:relative;height:100px"></div></div><div
        id="later" style="float:left;width:100px;height:100px;margin-left:-100px"></div>
    HTML
  end

  it 'keeps a float over a block whose line runs beside it' do
    expect(hit(<<~HTML)).to eq('float')   # was: block — the line is shortened, so nothing of it is at the point
      <div id="float" style="float:left;width:100px;height:100px"></div><div id="block" style="height:100px"><span>xxxxxxxxxxxx</span></div>
    HTML
  end

  it 'paints a negative z-index child over the background of the context it belongs to' do
    expect(hit(<<~HTML)).to eq('neg')     # was: ctx
      <div id="ctx" style="position:relative;z-index:0;height:120px"><div id="neg" style="position:absolute;z-index:-1;width:100px;height:100px"></div></div>
    HTML
  end

  it 'paints a negative z-index child under a positioned parent that makes no context' do
    expect(hit(<<~HTML)).to eq('parent')
      <div id="parent" style="position:relative;height:120px"><div style="position:absolute;z-index:-1;width:100px;height:100px"></div></div>
    HTML
  end

  it 'paints flex items as inline-blocks, in the order their container placed them' do
    expect(hit(<<~HTML)).to eq('second')
      <div style="display:flex;width:300px"><div id="second" style="order:1;width:100px;height:100px"></div><div
        id="first" style="width:100px;height:100px;margin-right:-100px"></div></div>
    HTML
  end

  it 'makes a stacking context of a static flex item with a z-index' do
    expect(hit(<<~HTML)).to eq('raised')
      <div style="display:flex;width:300px"><div id="raised" style="z-index:1;width:100px;height:100px;margin-right:-100px"></div><div
        style="width:100px;height:100px;position:relative"></div></div>
    HTML
  end

  it 'makes a stacking context of every effect that composites a subtree' do
    [
      'transform:scale(1)',
      'opacity:0.5',
      'isolation:isolate',
      'transform-style:preserve-3d',
      'position:relative;will-change:z-index',
      'mask:linear-gradient(black,black)',
      'view-transition-name:foo'
    ].each do |effect|
      expect(hit(with_negative_child(effect))).to eq('neg'), effect
    end
    # …a CURRENT animation of one — for these, still in its delay — and a `z-index` inherited from a parent that has one.
    keyframes = ->(decl) { "<style>@keyframes k{from{#{decl}}to{#{decl}}}</style>" }
    %w[backdrop-filter:blur(1px) clip-path:inset(0) opacity:1 transform:none].each do |decl|
      expect(hit(with_negative_child('animation:k 100s 100s', before: keyframes.(decl)))).to eq('neg'), decl
    end
    # …where a blend mode, an isolation or a mask makes one only while its animated value is in effect.
    %w[isolation:isolate mix-blend-mode:multiply mask-image:linear-gradient(black,black)].each do |decl|
      expect(hit(with_negative_child('animation:k 100s', before: keyframes.(decl)))).to eq('neg'), decl
      expect(hit(with_negative_child('animation:k 100s 100s', before: keyframes.(decl)))).to eq('ctx'), decl
    end
    expect(hit(%(<div style="z-index:3">#{with_negative_child('position:relative;z-index:inherit')}</div>))).to eq('neg')
    # …but not an opacity a transition leaves at 1 (the transition is not running).
    expect(hit(with_negative_child('transition:opacity 100s;opacity:1'))).to eq('ctx')
  end

  # A box-less element — `display: contents`, a `<slot>` — is no level of the paint order: nothing it declares
  # makes a unit or a context, and the children it hands its parent are that parent's items.
  it 'looks through a box-less element' do
    expect(hit(<<~HTML)).to eq('b')
      <div style="display:contents;position:relative"><div id="a" style="height:100px"></div></div><div
        id="b" style="margin-top:-100px;height:100px"></div>
    HTML
    expect(hit(<<~HTML)).to eq('b')
      <div style="display:contents;position:relative;z-index:5"><div id="a" style="position:relative;height:100px"></div></div><div
        id="b" style="position:relative;margin-top:-100px;height:100px"></div>
    HTML
    expect(hit(<<~HTML)).to eq('a')
      <div style="display:flex;width:300px"><div style="display:contents"><div id="a" style="z-index:1;width:100px;height:100px;margin-right:-100px"></div></div><div
        id="b" style="width:100px;height:100px;position:relative"></div></div>
    HTML
    expect(hit(<<~HTML)).to eq('a')
      <div id="host"><div id="a" style="width:100px;height:100px"></div></div>
      <script>document.getElementById('host').attachShadow({mode: 'open'}).innerHTML = '<div style="display:flex;width:300px"><div id="sib" style="width:100px;height:100px;margin-right:-100px"></div><slot></slot></div>'</script>
    HTML
  end

  it 'paints a floated flex item as the item it is' do
    expect(hit(<<~HTML)).to eq('b')
      <div style="display:flex;width:300px"><div id="a" style="width:100px;height:100px"></div><div
        id="b" style="float:left;margin-left:-100px;width:100px;height:100px"></div></div>
    HTML
  end

  # An INLINE box paints its own fragments in the inline phase — over the floats inside it, and, when it is a
  # stacking context, over its own negative children (appendix E 7.2.1), where a block context's background is under
  # them.
  it 'paints a non-atomic inline over what appendix E puts under it' do
    expect(hit(<<~HTML, x: 50, y: 50)).to eq('s')
      <div style="font:40px/100px monospace"><span id="s" style="opacity:.9"><span style="position:relative;z-index:-1">XXXXXXX</span></span></div>
    HTML
    %w[position:relative opacity:.9].each do |unit|
      expect(hit(<<~HTML, x: 50, y: 20)).to eq('s'), unit
        <div style="font:20px/40px monospace"><span id="s" style="#{unit}">XXXXXXXXXX<span
          style="float:left;width:100px;height:100px;margin-right:-100px"></span></span></div>
      HTML
    end
    expect(hit(<<~HTML, x: 20, y: 10)).to eq('a')
      <p style="font:16px/20px sans-serif;margin:0"><a id="a" href="#">link text here that is long<img
        style="float:left;width:60px;height:60px;margin-right:-60px"></a></p>
    HTML
  end

  it 'paints a replaced element with the lines, over a float' do
    expect(hit(<<~HTML)).to eq('c')
      <canvas id="c" style="display:block;width:100px;height:100px"></canvas><div
        style="float:left;width:100px;height:100px;margin-top:-100px"></div>
    HTML
    # …and so is a `<select>`'s face — but not an input, a textarea or a checkbox, where what shows is text or chrome,
    # and the float is over it (text is not hit-tested; neither is a button's label, beside which the float wins).
    {
      '<select style="display:block;width:200px;height:50px;margin:0" id="c"><option>x</option></select>' => 'c',
      '<input style="display:block;width:200px;height:50px;margin:0;border:0;padding:0">' => 'f',
      '<textarea style="display:block;margin:0"></textarea>' => 'f',
      '<input type="checkbox" style="display:block;width:50px;height:50px;margin:0">' => 'f',
      '<button style="display:block;width:200px;height:50px;margin:0">go</button>' => 'f'
    }.each do |control, want|
      expect(hit(%(#{control}<div id="f" style="float:left;width:100px;height:100px;margin-top:-50px"></div>), x: 25)).to eq(want), control
    end
  end

  # An animation's context lasts as long as the animation: a fade-in that has run out leaves the box an ordinary one
  # again, where a cached chain kept it a context — and a dropdown inside it trapped under whatever came later.
  it 'drops the stacking context an animation made once it has run out' do
    html = <<~HTML
      <!DOCTYPE html><html><head><style>body{margin:0} @keyframes k{from{opacity:1}to{opacity:1}}</style></head><body>
      #{with_negative_child('animation:k 1s')}</body></html>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    probe = '(e => e && e.id)(document.elementFromPoint(50, 25))'
    expect(s.evaluate_script(probe)).to eq('neg')
    expect(s.evaluate_async_script("const done = arguments[0]; setTimeout(() => done(#{probe}), 1500)")).to eq('ctx')
  end

  # CSSOM View: the hit is RETARGETED against the tree asked — a document sees a web component's host, the shadow
  # root the element inside it; `elementsFromPoint` lists every element painted there, topmost first; and a point
  # outside the viewport has none, however far a box reaches past it.
  it 'retargets the hit out of a shadow tree' do
    html = <<~HTML
      <!DOCTYPE html><body style="margin:0"><div id="host"></div><script>
        window.sr = document.getElementById('host').attachShadow({mode: 'open'});
        sr.innerHTML = '<div id="inner" style="width:100px;height:100px"></div>';
      </script></body>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    ids = 'es => es.map(e => e.id || e.tagName)'
    expect(s.evaluate_script('document.elementFromPoint(50, 50).id')).to eq('host')
    expect(s.evaluate_script('sr.elementFromPoint(50, 50).id')).to eq('inner')
    expect(s.evaluate_script("(#{ids})(document.elementsFromPoint(50, 50))")).to eq(%w[host BODY HTML])
    expect(s.evaluate_script("(#{ids})(sr.elementsFromPoint(50, 50))")).to eq(%w[inner host BODY HTML])
    expect(s.evaluate_script('sr.elementFromPoint(50, 500).tagName')).to eq('HTML')
    expect(s.evaluate_script("(#{ids})(sr.elementsFromPoint(50, 500))")).to eq(%w[HTML])
  end

  it 'lists what is painted at a point, and nothing past the viewport' do
    html = <<~HTML
      <!DOCTYPE html><body style="margin:0"><div id="a" style="height:100px"></div><div id="b" style="margin-top:-100px;height:100px"></div>
      <div id="p" style="height:0"><div id="c" style="height:50px"></div></div><div id="wide" style="width:3000px;height:20px"></div>
      <div id="host"><div id="light" style="height:50px"></div></div><script>
        window.sr = document.getElementById('host').attachShadow({mode: 'open'});
        sr.innerHTML = '<div id="wrap"><slot></slot></div>';
      </script></body>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    ids = 'es => es.map(e => e.id || e.tagName)'
    expect(s.evaluate_script("(#{ids})(document.elementsFromPoint(50, 50))")).to eq(%w[b a BODY HTML])
    expect(s.evaluate_script("(#{ids})(document.elementsFromPoint(50, 110))")).to eq(%w[wide c BODY HTML])   # not `p`
    expect(s.evaluate_script("(#{ids})(document.elementsFromPoint(50, 125))")).to eq(%w[light host c BODY HTML])
    expect(s.evaluate_script("(#{ids})(sr.elementsFromPoint(50, 125))")).to eq(%w[light wrap host c BODY HTML])
    expect(s.evaluate_script('document.elementFromPoint(2000, 110)')).to be_nil
  end
end
