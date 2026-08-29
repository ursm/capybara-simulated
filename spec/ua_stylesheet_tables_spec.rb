# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The parts of HTML's rendering section that are TABLES rather than mechanisms: the attributes that
# map to a pixel length, the block margins, the resets every form control gets, the list counters,
# and the bidi rules. Each of them was simply absent, so a page's geometry started from the wrong
# numbers — headings sat flush against their text, a `<body marginheight=0>` kept the UA's 8px, and
# a control inside `text-transform: uppercase` shouted its own label.
#
# Every figure is Chrome 151-measured on this machine.
RSpec.describe 'UA stylesheet: the rendering tables' do
  def page(markup, doctype: '<!DOCTYPE html>')
    html = %(#{doctype}<html><head><meta charset="utf-8"></head><body>#{markup}</body></html>)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s
  end

  def computed(session, id, prop)
    session.evaluate_script("getComputedStyle(document.getElementById(#{id.inspect}))[#{prop.inspect}]")
  end

  # HTML's "maps to the pixel length property" is the rules for parsing NON-NEGATIVE INTEGERS: the
  # unit is whatever the page wrote and always ignored, the fraction is truncated, a negative value
  # is no value at all, and neither is one past the 32-bit range.
  it 'maps the pixel-length attributes' do
    {
      '200' => '200px', '   00523   ' => '523px', '200.' => '200px', '200.7' => '200px',
      '+200' => '200px', '200in' => '200px', '200%' => '200px', '-0' => '0px',
      '-200' => '0px', '+-200' => '0px', 'abc' => '0px', '99999999999' => '0px'
    }.each do |value, expected|
      s = page(%(<img id="i" border="#{value}">))
      expect(computed(s, 'i', 'borderTopWidth')).to eq(expected)
      # The attribute being THERE is what draws the border: a value that is no length still maps
      # `solid`, at a width of zero.
      expect(computed(s, 'i', 'borderTopStyle')).to eq('solid')
    end
    # …and no attribute at all leaves the image with no border.
    plain = page('<img id="i">')
    expect(computed(plain, 'i', 'borderTopStyle')).to eq('none')
  end

  it 'maps the body margin attributes, including the frame that holds it' do
    own = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body marginwidth="10" topmargin="5">x</body></html>']]
    })
    own.visit '/'
    expect(own.evaluate_script('getComputedStyle(document.body).marginLeft')).to eq('10px')
    expect(own.evaluate_script('getComputedStyle(document.body).marginRight')).to eq('10px')
    expect(own.evaluate_script('getComputedStyle(document.body).marginTop')).to eq('5px')
    # Each attribute maps BOTH sides of its own axis — `topmargin` sets the bottom margin too, and
    # `marginwidth` / `marginheight` are asked first (WHATWG's table; Chrome applies them in source
    # order instead, and `body-margin-3a` is the row where the two disagree).
    expect(own.evaluate_script('getComputedStyle(document.body).marginBottom')).to eq('5px')

    ignored = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body rightmargin="100" bottommargin="100">x</body></html>']]
    })
    ignored.visit '/'
    # `rightmargin` / `bottommargin` are not in the table at all.
    expect(ignored.evaluate_script('getComputedStyle(document.body).marginRight')).to eq('8px')
    expect(ignored.evaluate_script('getComputedStyle(document.body).marginBottom')).to eq('8px')

    # …and the body of a FRAMED document takes its margins from the FRAME, which is the one
    # presentational mapping that crosses documents.
    framed = simulated_session(->(env) {
      html = env['PATH_INFO'] == '/framed' ? '<!DOCTYPE html><html><body>x</body></html>'
                                           : '<!DOCTYPE html><html><body><iframe id="f" src="/framed" ' \
                                             'marginheight="7" marginwidth="3"></iframe></body></html>'
      [200, {'content-type' => 'text/html'}, [html]]
    })
    framed.visit '/'
    framed.within_frame('f') do
      expect(framed.evaluate_script('getComputedStyle(document.body).marginTop')).to eq('7px')
      expect(framed.evaluate_script('getComputedStyle(document.body).marginLeft')).to eq('3px')
    end
  end

  # The block margins are `em` of the element's OWN font, which is what makes an `<h1>` (2em text)
  # sit 21.44px from what follows it and an `<h6>` (0.67em text) 24.98px.
  it 'gives the block elements their UA margins' do
    s = page('<h1 id="h1">x</h1><h6 id="h6">x</h6><p id="p">x</p><blockquote id="bq">x</blockquote><pre id="pre">x</pre><hr id="hr">')
    expect(computed(s, 'h1', 'marginTop')).to eq('21.44px')
    expect(computed(s, 'h6', 'marginTop')).to eq('24.9776px')
    expect(computed(s, 'p',  'marginTop')).to eq('16px')
    expect([computed(s, 'bq', 'marginTop'), computed(s, 'bq', 'marginLeft')]).to eq(['16px', '40px'])
    expect(computed(s, 'hr', 'marginTop')).to eq('8px')
    # `<pre>`'s em is its own 13px monospace one.
    expect([computed(s, 'pre', 'fontSize'), computed(s, 'pre', 'marginTop')]).to eq(['13px', '13px'])
  end

  # 13px is the monospace family's `medium`, not a rule of its own: a size declared anywhere up the
  # chain is inherited like any other.
  it 'treats the fixed font size as a medium, not a constant' do
    s = page('<pre id="a">x</pre><div style="font-size:20px"><code id="b">y</code></div>' \
             '<div style="font:16px monospace"><pre id="c">z</pre></div>')
    expect(computed(s, 'a', 'fontSize')).to eq('13px')
    expect(computed(s, 'b', 'fontSize')).to eq('20px')
    expect(computed(s, 'c', 'fontSize')).to eq('16px')
  end

  # HTML's sheet resets the inherited text properties on every control, so a control shows its own
  # label rather than the page's typography.
  it 'resets the inherited text properties on a control' do
    s = page('<div style="text-transform:uppercase;word-spacing:5px;text-indent:5px;text-shadow:0 0 5px red">' \
             '<button id="b">go</button><input id="i"><span id="s">x</span></div>')
    %w[b i].each do |id|
      expect(computed(s, id, 'textTransform')).to eq('none')
      expect(computed(s, id, 'wordSpacing')).to eq('0px')
      expect(computed(s, id, 'textIndent')).to eq('0px')
      expect(computed(s, id, 'textShadow')).to eq('none')
    end
    # …and everything else still inherits them.
    expect(computed(s, 's', 'textTransform')).to eq('uppercase')
  end

  it 'numbers a list through the counter properties' do
    s = page('<ol id="o1"><li id="l1">a</li></ol><ol id="o2" start="10"><li>a</li></ol>' \
             '<ol id="o3" reversed start="20"><li>a</li></ol><ul id="u"><li id="l2" value="7">a</li></ul>')
    expect(computed(s, 'o1', 'counterReset')).to eq('list-item')
    expect(computed(s, 'o2', 'counterReset')).to eq('list-item 9')
    expect(computed(s, 'o3', 'counterReset')).to eq('reversed(list-item) 21')
    expect(computed(s, 'u',  'counterReset')).to eq('list-item')
    expect(computed(s, 'l1', 'counterIncrement')).to eq('list-item')
    expect(computed(s, 'l2', 'counterSet')).to eq('list-item 7')
  end

  # A stray `<li>` shows its marker INSIDE its box in quirks mode, and outside once it is in a list.
  it 'moves a quirks-mode list marker inside' do
    quirks = page('<li id="a">x</li><ul><li id="b">y</li></ul>', doctype: '')
    expect(computed(quirks, 'a', 'listStylePosition')).to eq('inside')
    expect(computed(quirks, 'b', 'listStylePosition')).to eq('outside')

    standards = page('<li id="a">x</li>')
    expect(computed(standards, 'a', 'listStylePosition')).to eq('outside')
  end

  # HTML's bidi rules: the block elements isolate, `<bdo>` overrides, a valid `dir` isolates
  # whatever the element is, and `dir=auto` asks for `plaintext` on the elements that hold plain
  # text.
  it 'applies the bidi UA rules' do
    s = page('<div id="d">x</div><span id="s">x</span><span id="sd" dir="LtR">x</span>' \
             '<bdo id="bdo" dir="rtl">x</bdo><pre id="pre" dir="auto">x</pre>' \
             '<input id="i" dir="auto"><input id="ie" type="email" dir="auto">' \
             '<span id="bad" dir="INVALID">x</span>')
    expect(computed(s, 'd',   'unicodeBidi')).to eq('isolate')
    expect(computed(s, 's',   'unicodeBidi')).to eq('normal')
    expect(computed(s, 'sd',  'unicodeBidi')).to eq('isolate')
    expect(computed(s, 'bdo', 'unicodeBidi')).to eq('isolate-override')
    expect(computed(s, 'pre', 'unicodeBidi')).to eq('plaintext')
    expect(computed(s, 'i',   'unicodeBidi')).to eq('isolate')
    expect(computed(s, 'ie',  'unicodeBidi')).to eq('plaintext')
    expect(computed(s, 'bad', 'unicodeBidi')).to eq('normal')
  end
  # A control clips its own widget, and the type decides how: Chrome measured across all 22 input
  # types — everything clips except the three whose widget is painted outside the box it is given.
  it 'clips a control the way its type does' do
    s = page('<input id="text"><input id="range" type="range"><input id="checkbox" type="checkbox">' \
             '<input id="image" type="image"><input id="search" type="search"><select id="select"></select>')
    expect(computed(s, 'text',     'overflow')).to eq('clip')
    expect(computed(s, 'range',    'overflow')).to eq('visible')
    expect(computed(s, 'checkbox', 'overflow')).to eq('visible')
    # …and where it clips FROM: the content box for the two that draw an image, zero for the rest.
    expect(computed(s, 'image',  'overflowClipMargin')).to eq('content-box')
    expect(computed(s, 'select', 'overflowClipMargin')).to eq('content-box')
    expect(computed(s, 'text',   'overflowClipMargin')).to eq('0px')
    # `search` is the one text field that is a border box.
    expect(computed(s, 'search', 'boxSizing')).to eq('border-box')
    expect(computed(s, 'text',   'boxSizing')).to eq('content-box')
  end

  it 'gives a table, an hr and a marquee the boxes HTML asks for' do
    s = page('<div style="text-indent:5px"><table id="t"><tr><td id="c">x</td></tr></table></div>' \
             '<hr id="hr"><marquee id="m">x</marquee>')
    expect(computed(s, 't', 'boxSizing')).to eq('border-box')
    expect([computed(s, 't', 'textIndent'), computed(s, 'c', 'textIndent')]).to eq(['0px', '0px'])
    # An `<hr>` is a 2px box: a 1px inset border in grey, and it clips.
    expect([computed(s, 'hr', 'borderTopWidth'), computed(s, 'hr', 'borderTopStyle')]).to eq(['1px', 'inset'])
    expect(s.evaluate_script("document.getElementById('hr').getBoundingClientRect().height")).to eq(2)
    expect(computed(s, 'm', 'display')).to eq('inline-block')
  end

  # `<hr>`'s own attributes: `size` is how thick the line is, and `color` / `noshade` turn the
  # etched groove into a solid block whose border is half that size on every side.
  it 'sizes an hr from its attributes' do
    s = page('<hr id="a" size="50"><hr id="b" size="1"><hr id="c" size="50" noshade>')
    expect(s.evaluate_script("document.getElementById('a').getBoundingClientRect().height")).to eq(50)
    expect(computed(s, 'a', 'boxSizing')).to eq('border-box')
    # A one-pixel rule is the top border alone.
    expect(computed(s, 'b', 'borderBottomWidth')).to eq('0px')
    expect(s.evaluate_script("document.getElementById('b').getBoundingClientRect().height")).to eq(1)
    expect([computed(s, 'c', 'borderTopWidth'), computed(s, 'c', 'borderTopStyle')]).to eq(['25px', 'solid'])
  end

  # A value that is a LENGTH computes as one, whatever keyword the page wrote it as.
  it 'computes the length keywords as lengths' do
    s = page('<div id="a" style="word-spacing:normal;overflow-clip-margin:0">x</div>' \
             '<div id="b" style="border-style:solid">y</div>')
    expect(computed(s, 'a', 'wordSpacing')).to eq('0px')
    expect(computed(s, 'a', 'overflowClipMargin')).to eq('0px')
    # …and `medium` is never a computed border width: it is the 3px it stands for.
    expect(computed(s, 'b', 'borderTopWidth')).to eq('3px')
  end

end
