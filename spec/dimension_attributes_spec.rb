require 'spec_helper'
require_relative 'support/session_teardown'

# HTML's presentational dimension attributes — `<img width>`, `<td height>`, `<img hspace>` — map
# into the cascade below every author rule (cascade.js `presentationalHint`). The WPT suite
# (html/rendering/dimension-attributes.html) pins the value GRAMMAR exhaustively and the gate runs
# it, so what is here is the three things that suite cannot see: how a `<picture>` hands its
# `<source>`'s dimensions to the `<img>`, that a later mutation of that source reaches the img at
# all, and the CSSOM serialization of the mapped number.
RSpec.describe 'dimension attributes' do
  # Rendered in a `display: none` container, the way the WPT suite does it: on a rendered element
  # `getComputedStyle(el).width` reports the USED width, which would answer for the layout engine
  # rather than for the mapping under test. With no box, the computed value is what comes back.
  def page_with(body)
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [
        %(<!DOCTYPE html><html><head><style>.anchor{color:red}</style></head>) +
        %(<body><div id="box" style="display: none">#{body}</div></body></html>)
      ]]
    })
    session.visit '/'
    session
  end

  # The style element above is not decoration: without a stylesheet the cascade takes a
  # conservative path that hides a stale memo, which is exactly the bug the source mutation covers.
  def size_of(session, id)
    session.evaluate_script(<<~JS)
      (() => { const s = getComputedStyle(document.getElementById('#{id}')); return [s.width, s.height]; })()
    JS
  end

  describe 'an <img> in a <picture>' do
    # Chrome-measured, all of it: the rule is all-or-nothing per ELEMENT, not per axis.
    it 'takes the selected source\'s dimensions over its own' do
      s = page_with('<picture><source srcset="/a.png" width="100"><img id=i width="11" height="22"></picture>')
      expect(size_of(s, 'i')).to eq(['100px', 'auto'])
    end

    it 'drops its own attribute on an axis the source does not name' do
      s = page_with('<picture><source srcset="/a.png" height="50"><img id=i width="11" height="22"></picture>')
      expect(size_of(s, 'i')).to eq(['auto', '50px'])
    end

    it 'falls back to its own attribute on an axis the source names INVALIDLY' do
      s = page_with('<picture><source srcset="/a.png" width="-5" height="50"><img id=i width="11" height="22"></picture>')
      expect(size_of(s, 'i')).to eq(['11px', '50px'])
    end

    it 'keeps its own attributes when the source names neither' do
      s = page_with('<picture><source srcset="/a.png"><img id=i width="11" height="22"></picture>')
      expect(size_of(s, 'i')).to eq(['11px', '22px'])
    end

    it 'ignores a source written after it — selection stops at the img' do
      s = page_with('<picture><img id=i width="11"><source srcset="/a.png" width="100"></picture>')
      expect(size_of(s, 'i').first).to eq('11px')
    end

    it 'skips a source whose media query does not match' do
      s = page_with('<picture><source media="print" srcset="/a.png" width="100">' \
                    '<source srcset="/b.png" width="33"><img id=i></picture>')
      expect(size_of(s, 'i').first).to eq('33px')
    end

    it 'skips a source whose type names no image format' do
      s = page_with('<picture><source type="image/bogus" srcset="/a.png" width="100">' \
                    '<source srcset="/b.png" width="33"><img id=i></picture>')
      expect(size_of(s, 'i').first).to eq('33px')
    end

    # The img reads a SIBLING's attributes, which no per-element epoch tracks — a memo here served
    # the old width for the rest of the read burst, and the box was never re-laid-out either.
    it 'follows a later change to the source it selected' do
      s = page_with('<picture><source id=src srcset="/a.png" width="100"><img id=i></picture>')
      expect(size_of(s, 'i').first).to eq('100px')
      s.execute_script("document.getElementById('src').setAttribute('width', '300')")
      expect(size_of(s, 'i').first).to eq('300px')
    end
  end

  describe 'the mapped value' do
    it 'serializes the number the way CSSOM does' do
      s = page_with('<img id=a width="1.50"><img id=b width="12.340"><img id=c width="   00523   ">')
      expect(%w[a b c].map {|id| size_of(s, id).first }).to eq(['1.5px', '12.34px', '523px'])
    end

    # `Number()` would report `1e-9px`, which no consumer downstream parses — it fell through
    # every branch and reported an EMPTY computed value.
    it 'keeps a tiny value as a decimal rather than exponential' do
      s = page_with('<img id=a width="0.000000001">')
      expect(size_of(s, 'a').first).to eq('0.000000001px')
    end
  end

  # HTML's "(ignoring zero)" variant is per element AND per property.
  describe 'zero' do
    it 'is ignored on a <td> but applied on a <table> height' do
      s = page_with('<table id=t height="0"><tr><td id=d width="0" height="0">x</td></tr></table>')
      expect(size_of(s, 'd').first).to eq('auto')
      expect(size_of(s, 't').last).to eq('0px')
    end
  end
end
