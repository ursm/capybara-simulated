// The caret of an editing host as the driver's keys and clicks move it (form-fields.js): a step over one character —
// across the host's text leaves where it crosses a node's edge, never out of the host — a move to the edge of the block
// holding it, and a double click's word, which runs on across inline leaves of one block. A caret stops at a text leaf
// or at a void element (an image, a `<br>`): the atoms a browser places it beside.

use crate::dom::{nid_arg, NodeData, NodeId, NodeKind, RealmArena};
use crate::style::StyleEngine;

pub(crate) const CARET_VOID_TAGS: [&str; 11] = ["audio", "br", "canvas", "embed", "hr", "iframe", "img", "input", "object", "svg", "video"];

fn is_text(n: &NodeData) -> bool {
    n.kind == NodeKind::Text
}

impl RealmArena {
    // The first (last, with `from_end`) caret stop under `root`, searching its children inward from that edge: a text
    // leaf, or a void element — an EMPTY non-void one passed over (ProseMirror parks empty cursor `<span>`s at mark
    // boundaries, where a plain deepest-child walk read "no text here" and stopped).
    fn caret_leaf(&self, root: NodeId, from_end: bool) -> Option<NodeId> {
        let n = self.get(root)?;
        if is_text(n) {
            return Some(root);
        }
        if n.kind != NodeKind::Element {
            return None;
        }
        if n.children.is_empty() {
            return CARET_VOID_TAGS.contains(&&*n.local_name).then_some(root);
        }
        let mut kids: Box<dyn Iterator<Item = &NodeId>> = if from_end { Box::new(n.children.iter().rev()) } else { Box::new(n.children.iter()) };
        kids.find_map(|&c| self.caret_leaf(c, from_end))
    }

    // The text leaf before (after, with `forward`) `start` in its editing host — none past the host's edge: the caret
    // never leaves it (ArrowLeft at the start of an editor stays put).
    fn adjacent_text_leaf(&self, start: NodeId, forward: bool) -> Option<NodeId> {
        let element = match self.get(start)? {
            n if n.kind == NodeKind::Element => Some(start),
            n => n.parent,
        };
        let host = element.and_then(|e| self.editing_host(e));
        let mut at = start;
        while Some(at) != host {
            let n = self.get(at)?;
            let parent = n.parent?;
            let siblings = &self.get(parent)?.children;
            let i = self.child_index(at);
            let next = if forward { siblings.get(i + 1).copied() } else { i.checked_sub(1).map(|j| siblings[j]) };
            match next {
                Some(sibling) => {
                    if let Some(leaf) = self.caret_leaf(sibling, !forward).filter(|&l| self.get(l).is_some_and(is_text)) {
                        return Some(leaf);
                    }
                    at = sibling;
                }
                None => at = parent,
            }
        }
        None
    }

    // The nearest inclusive ancestor of `node` that is a block, by its tag (`rendered::is_block_tag`).
    fn block_of(&self, node: NodeId) -> Option<NodeId> {
        let mut at = Some(node);
        while let Some(id) = at {
            let n = self.get(id)?;
            if n.kind == NodeKind::Element && crate::rendered::is_block_tag(&n.local_name) {
                return Some(id);
            }
            at = n.parent;
        }
        None
    }

    // What a caret passes stepping from (`node`, `offset`) on (back, without `forward`), in its editing host — the
    // document, outside one (`Walk`) — as the style engine has the page at `now`.
    fn walk<'a>(&'a self, engine: &'a mut StyleEngine, now: f64, node: NodeId, offset: u32, forward: bool) -> Option<Walk<'a>> {
        engine.flush(self, now);
        let n = self.get(node)?;
        let element = if n.kind == NodeKind::Element { Some(node) } else { n.parent };
        let host = element.and_then(|e| self.editing_host(e));
        let (at, index, text) = if is_text(n) { (node, 0, Some((node, offset))) } else { (node, offset as usize, None) };
        // (…a page the engine styles — one it does not, a DOMParser's, taken by its tags)
        let styled = element.is_some_and(|e| crate::style::primary_style(self, e).is_some());
        let mut walk = Walk { arena: self, engine, now, styled, host, forward, at, index, text, space_seen: false, ahead: None };
        // (…a space just passed where the place is in white space: what comes of it collapses)
        let behind = is_text(n).then(|| if forward { offset.checked_sub(1) } else { Some(offset) }).flatten();
        walk.space_seen = behind.and_then(|i| n.data.get(i as usize)).is_some_and(|&u| crate::rendered::is_collapsible_ws(u)) && walk.collapses(n.parent);
        Some(walk)
    }

    // ArrowLeft / ArrowRight, and `Selection.modify` by a character: the caret one character back (on, with `forward`)
    // — within its text, else at the next caret stop, as Chrome steps: across an inline edge it takes that stop's first
    // character too (`ab|<b>cd</b>` → `<b>c|d</b>`: the two places either side of the edge are one place on the line, an
    // empty leaf none at all), across a line's end it stops at the stop's edge; an atom (an image) is a stop it passes,
    // and an empty line — a `<br>` ending a line with nothing on it — one it stops on, before that `<br>`: on, the line
    // passed ended just before it; back, the next thing back ends one too (or there is none).
    pub(crate) fn caret_step(&self, engine: &mut StyleEngine, now: f64, node: NodeId, offset: u32, forward: bool) -> Option<(NodeId, u32)> {
        let mut line_end = false;
        let mut walk = self.walk(engine, now, node, offset, forward)?.peekable();
        while let Some(pass) = walk.next() {
            match pass {
                // (…an editing host met from outside one is gone over: a block, its edges lines' ends — Chrome)
                Pass::LineEnd | Pass::Editable => line_end = true,
                Pass::Br { parent, from, .. } if forward && line_end => return Some((parent, from)),
                Pass::Br { parent, to, .. } if !forward && walk.peek().is_none_or(Pass::ends_line) => return Some((parent, to)),
                Pass::Br { .. } => line_end = true,
                Pass::Char { leaf, from, to, .. } => return Some((leaf, if line_end { from } else { to })),
                Pass::Atom { parent, from, to } => return Some((parent, if line_end { from } else { to })),
            }
        }
        None
    }

    // The first caret position in `root` (the last, with `end`): where focusing an editing host with no selection in it
    // puts the caret (Chrome), and where WebDriver's keys sent to a contenteditable element that does not have focus
    // start, "after any child content". The first character it renders (the last's end) — white space a line starts
    // (ends) with collapsed away — or the place before its first `<br>` (its last), beside its first atom (its last), or
    // `root`'s start (end) where it has none: `<div contenteditable>  <b>x</b>` at `x`'s start, `<p><br></p>` at the
    // `<p>`'s either way.
    pub(crate) fn caret_edge(&self, engine: &mut StyleEngine, now: f64, root: NodeId, end: bool) -> (NodeId, u32) {
        let edge = if end { self.get(root).map_or(0, |n| if is_text(n) { n.data.len() } else { n.children.len() }) as u32 } else { 0 };
        let Some(mut walk) = self.walk(engine, now, root, edge, !end) else { return (root, edge) };
        // (…never out of `root`)
        walk.host = Some(root);
        walk.space_seen = true;
        for pass in walk {
            match pass {
                Pass::Char { leaf, from, .. } => return (leaf, from),
                Pass::Br { parent, from, to } => return (parent, if end { to } else { from }),
                Pass::Atom { parent, from, .. } => return (parent, from),
                Pass::LineEnd | Pass::Editable => {}
            }
        }
        (root, edge)
    }

    // `Selection.modify` by a word, as Chrome moves: past the white space, then to the end (the start, back) of the word
    // or the punctuation there (`word_length`); an atom is one. Across a line's end before any, to the edge of what is
    // past it: the next paragraph's start (the last's end, back) — not past an editing host, from outside one.
    pub(crate) fn caret_word_step(&self, engine: &mut StyleEngine, now: f64, node: NodeId, offset: u32, forward: bool) -> Option<(NodeId, u32)> {
        let mut walk = self.walk(engine, now, node, offset, forward)?;
        let mut line_end = false;
        let first = loop {
            match walk.next()? {
                Pass::Char { ch, .. } if is_space(ch) => {}
                Pass::LineEnd | Pass::Br { .. } => line_end = true,
                // (…and nothing past an editing host met from outside one: the focus stays — Chrome)
                Pass::Editable => return None,
                Pass::Char { leaf, from, .. } if line_end => return Some((leaf, from)),
                Pass::Atom { parent, from, to } => return Some((parent, if line_end { from } else { to })),
                Pass::Char { leaf, to, ch, .. } => break (leaf, to, ch),
            }
        };
        // (…the characters from there to the next white space or line's end, in the walk's order)
        let mut run = vec![first];
        for pass in walk {
            match pass {
                Pass::Char { leaf, to, ch, .. } if !is_space(ch) => run.push((leaf, to, ch)),
                _ => break,
            }
        }
        // (…the text of a script written without spaces behind the place too, which the dictionary reads it in)
        let behind = || {
            let mut chars = Vec::new();
            for pass in self.walk(engine, now, node, offset, !forward).into_iter().flatten() {
                match pass {
                    Pass::Char { ch, .. } if is_word(ch) && crate::unicode::segmented_by_dictionary(ch) && chars.len() < CONTEXT => chars.push(ch),
                    _ => break,
                }
            }
            chars
        };
        let chars: Vec<u32> = run.iter().map(|&(.., c)| c).collect();
        let (leaf, to, _) = run[word_length(&chars, forward, behind) - 1];
        Some((leaf, to))
    }

    // Home / End: the caret at the start (end, with `end`) of the block holding `node` in its editing host — the host
    // itself at most (`<span contenteditable>` its own) — its first (last) caret position (`caret_edge`).
    pub(crate) fn caret_block_edge(&self, engine: &mut StyleEngine, now: f64, node: NodeId, end: bool) -> Option<(NodeId, u32)> {
        engine.flush(self, now);
        let n = self.get(node)?;
        let element = if n.kind == NodeKind::Element { node } else { n.parent? };
        let host = self.editing_host(element);
        let styled = crate::style::primary_style(self, element).is_some();
        let mut at = element;
        let block = loop {
            let e = self.get(at)?;
            let block = if styled { crate::rendered::is_block_level(self, at) } else { crate::rendered::is_block_tag(&e.local_name) };
            if block || Some(at) == host {
                break at;
            }
            match e.parent.filter(|&p| self.is_element(p)) {
                Some(p) => at = p,
                None => break at,
            }
        };
        Some(self.caret_edge(engine, now, block, end))
    }

    // A double click's word: from (`node`, `offset`) — or, where `node` is no text, its first non-empty text leaf's
    // start — the run of word characters (letters, numbers, `_`) either side, running on across the inline text leaves
    // of the one block (`<code>code</code><b>bold</b>` is one word, an empty leaf no boundary). None for no word there.
    pub(crate) fn caret_word(&self, node: NodeId, offset: u32) -> Option<(NodeId, u32, NodeId, u32)> {
        let (text, offset) = if self.get(node).is_some_and(is_text) { (node, offset) } else { (self.first_nonempty_text(node)?, 0) };
        let data = &self.get(text)?.data;
        let mut start = (offset as usize).min(data.len());
        let mut end = start;
        while start > 0 && word_unit(data[start - 1]) {
            start -= 1;
        }
        while end < data.len() && word_unit(data[end]) {
            end += 1;
        }
        let block = self.block_of(text);
        let (mut from, mut to) = ((text, start as u32), (text, end as u32));
        if start == 0 {
            from = self.extend_word(text, false, block);
        }
        if end == data.len() {
            to = self.extend_word(text, true, block);
        }
        (from != to).then_some((from.0, from.1, to.0, to.1))
    }
    // …the word's edge past `leaf`'s, back (on, with `forward`): leaf by leaf while the next leaf in the block starts
    // (ends) with a word character, to where its word ends.
    fn extend_word(&self, leaf: NodeId, forward: bool, block: Option<NodeId>) -> (NodeId, u32) {
        let mut edge = (leaf, if forward { self.get(leaf).map_or(0, |n| n.data.len() as u32) } else { 0 });
        let mut cur = self.adjacent_text_leaf(leaf, forward);
        while let Some(c) = cur.filter(|&c| self.block_of(c) == block) {
            let Some(d) = self.get(c).map(|n| &n.data) else { break };
            if d.is_empty() {
                cur = self.adjacent_text_leaf(c, forward);
                continue;
            }
            if !word_unit(if forward { d[0] } else { d[d.len() - 1] }) {
                break;
            }
            if forward {
                let off = d.iter().position(|&u| !word_unit(u)).unwrap_or(d.len());
                edge = (c, off as u32);
                if off < d.len() {
                    break;
                }
            } else {
                let off = d.iter().rposition(|&u| !word_unit(u)).map_or(0, |i| i + 1);
                edge = (c, off as u32);
                if off > 0 {
                    break;
                }
            }
            cur = self.adjacent_text_leaf(c, forward);
        }
        edge
    }
    // The first text leaf under `root` with any text, in tree order.
    fn first_nonempty_text(&self, root: NodeId) -> Option<NodeId> {
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            let n = self.get(id)?;
            if is_text(n) && !n.data.is_empty() {
                return Some(id);
            }
            stack.extend(n.children.iter().rev());
        }
        None
    }
}

// What a caret passes stepping through its editing host (the document, outside one) in tree order — back, without
// `forward` — never out of the host, nor into what renders nothing (`display: none`, a `<script>`, a closed
// `<details>`'s content, text `visibility` hides): a character of a text leaf, from one place to the next (a surrogate
// pair one character, a run of collapsible white space one space, none at a line's either end); a line's end — a
// block-level box's edge — or a `<br>` that breaks a line, from the place before it to the place after; an atom, a
// replaced element (an image, an `<svg>`), likewise; an editing host, met from outside one, whole. A page the engine
// does not style is taken by its tags.
enum Pass {
    Char { leaf: NodeId, from: u32, to: u32, ch: u32 },
    LineEnd,
    Br { parent: NodeId, from: u32, to: u32 },
    Atom { parent: NodeId, from: u32, to: u32 },
    // …and, outside any editing host, one met: a caret outside goes over it, not into it.
    Editable,
}
struct Walk<'a> {
    arena: &'a RealmArena,
    engine: &'a mut StyleEngine,
    now: f64,
    styled: bool,
    host: Option<NodeId>,
    forward: bool,
    // The place between `at`'s children it has come to, before its `index`th — or in the text leaf `text`, at its offset.
    at: NodeId,
    index: usize,
    text: Option<(NodeId, u32)>,
    // Whether what it passed last was a space or a line's end, after which collapsible white space renders nothing; and
    // what it found looking past a space, to be passed next.
    space_seen: bool,
    ahead: Option<Pass>,
}

impl Iterator for Walk<'_> {
    type Item = Pass;
    // (…a run of collapsible white space passed as its first space, where something other than a line's end follows)
    fn next(&mut self) -> Option<Pass> {
        if let Some(pass) = self.ahead.take() {
            self.space_seen = pass.ends_line();
            return Some(pass);
        }
        loop {
            let (pass, collapsible) = self.pass()?;
            if !collapsible {
                self.space_seen = pass.ends_line();
                return Some(pass);
            }
            if self.space_seen {
                continue;
            }
            loop {
                match self.pass()? {
                    (_, true) => {}
                    (end, _) if end.ends_line() => {
                        self.space_seen = true;
                        return Some(end);
                    }
                    (next, _) => {
                        self.ahead = Some(next);
                        self.space_seen = true;
                        return Some(pass);
                    }
                }
            }
        }
    }
}

impl Pass {
    fn ends_line(&self) -> bool {
        matches!(self, Pass::LineEnd | Pass::Br { .. })
    }
}

impl Walk<'_> {
    // What it asks of the page: whether an element renders — its text, its children — whether one is block-level,
    // whether a `<br>` breaks a line, whether a text child of `parent` is hidden by its `visibility`, and whether one
    // collapses its white space; by the style engine's values, or by the tags of a page it does not style.
    fn renders(&mut self, id: NodeId, n: &NodeData) -> bool {
        if self.styled {
            crate::rendered::generates_text_box(self.engine, self.arena, id, n, self.now)
        } else {
            !crate::rendered::is_invisible_tag(&n.local_name)
        }
    }
    fn block(&self, id: NodeId) -> bool {
        if self.styled {
            crate::rendered::is_block_level(self.arena, id)
        } else {
            self.arena.get(id).is_some_and(|n| n.kind == NodeKind::Element && crate::rendered::is_block_tag(&n.local_name))
        }
    }
    fn breaks(&self, br: NodeId) -> bool {
        !self.styled || crate::rendered::is_line_break(self.arena, br)
    }
    fn hidden(&self, parent: NodeId) -> bool {
        self.styled && self.arena.is_element(parent) && crate::rendered::hides_by_visibility(self.arena, parent, false)
    }
    fn collapses(&self, parent: Option<NodeId>) -> bool {
        !self.styled || crate::rendered::collapses_white_space(self.arena, parent)
    }

    // The next thing passed, and whether it is collapsible white space.
    fn pass(&mut self) -> Option<(Pass, bool)> {
        let arena = self.arena;
        let forward = self.forward;
        loop {
            if let Some((leaf, offset)) = self.text {
                let n = arena.get(leaf)?;
                let data = &n.data;
                let at = offset as usize;
                let unit = if forward { data.get(at) } else { at.checked_sub(1).and_then(|i| data.get(i)) };
                if let Some(&unit) = unit {
                    // (…a pair's two halves one character)
                    let pair = if forward {
                        data.get(at + 1).filter(|&&low| (0xD800..0xDC00).contains(&unit) && (0xDC00..0xE000).contains(&low)).map(|&low| (unit, low))
                    } else {
                        at.checked_sub(2).map(|i| data[i]).filter(|&high| (0xD800..0xDC00).contains(&high) && (0xDC00..0xE000).contains(&unit)).map(|high| (high, unit))
                    };
                    let (ch, width) = match pair {
                        Some((high, low)) => (0x10000 + ((u32::from(high) - 0xD800) << 10) + (u32::from(low) - 0xDC00), 2),
                        None => (u32::from(unit), 1),
                    };
                    let to = if forward { offset + width } else { offset - width };
                    self.text = Some((leaf, to));
                    let collapsible = crate::rendered::is_collapsible_ws(unit) && self.collapses(n.parent);
                    return Some((Pass::Char { leaf, from: offset, to, ch }, collapsible));
                }
                self.text = None;
                self.at = arena.parent_of(leaf)?;
                self.index = arena.child_index(leaf) + usize::from(forward);
                continue;
            }
            let container = arena.get(self.at)?;
            let next = if forward { container.children.get(self.index).copied() } else { self.index.checked_sub(1).map(|i| container.children[i]) };
            let Some(child) = next else {
                // (…out of the container, to the place after (before) it in its parent)
                if Some(self.at) == self.host {
                    return None;
                }
                let left = self.at;
                self.at = container.parent?;
                self.index = arena.child_index(left) + usize::from(forward);
                if self.block(left) {
                    return Some((Pass::LineEnd, false));
                }
                continue;
            };
            let c = arena.get(child)?;
            let past = if forward { self.index + 1 } else { self.index - 1 };
            let (before, after) = (self.index.min(past) as u32, self.index.max(past) as u32);
            let (from, to) = if forward { (before, after) } else { (after, before) };
            match c.kind {
                NodeKind::Text if !self.hidden(self.at) => {
                    self.text = Some((child, if forward { 0 } else { c.data.len() as u32 }));
                    continue;
                }
                NodeKind::Element if !self.renders(child, c) => {}
                NodeKind::Element if self.host.is_none() && c.contenteditable_state() == Some(true) => {
                    self.index = past;
                    return Some((Pass::Editable, false));
                }
                NodeKind::Element if c.is_html_named("br") => {
                    let parent = self.at;
                    self.index = past;
                    if self.breaks(child) {
                        return Some((Pass::Br { parent, from, to }, false));
                    }
                    continue;
                }
                NodeKind::Element if CARET_VOID_TAGS.contains(&&*c.local_name) => {
                    let parent = self.at;
                    self.index = past;
                    return Some((Pass::Atom { parent, from, to }, false));
                }
                NodeKind::Element => {
                    self.at = child;
                    self.index = if forward { 0 } else { c.children.len() };
                    if self.block(child) {
                        return Some((Pass::LineEnd, false));
                    }
                    continue;
                }
                _ => {}
            }
            self.index = past;
        }
    }
}

// How many of `run`'s characters (code points, in the walk's order, from where a word step starts) the step passes: a run of
// punctuation (`~>>>>>` one stop), or a word — word characters of one script, joined by an apostrophe between letters,
// or a full stop, comma or semicolon between digits (Chrome: `don't` and `3.14` are one word each, `a.b` and `a:b`
// three) — or, of scripts written without spaces, as far as ICU's dictionary has its first word in the run of them
// (`東京|都庁`, `食べる|人`: kanji and kana are one text to it).
pub(crate) fn word_length(run: &[u32], forward: bool, behind: impl FnOnce() -> Vec<u32>) -> usize {
    let ch = |i: usize| run[i];
    if !is_word(ch(0)) {
        return run.iter().take_while(|&&c| !is_word(c)).count();
    }
    let joins = |before: u32, mid: u32, after: u32| {
        (matches!(mid, 0x27 | 0x2019) && crate::unicode::is_letter(before) && crate::unicode::is_letter(after))
            || (matches!(mid, 0x2C | 0x2E | 0x3B) && crate::unicode::is_number(before) && crate::unicode::is_number(after))
    };
    // (…a change of script a word's edge — but among scripts written without spaces, the dictionary's to say)
    let dictionary = crate::unicode::segmented_by_dictionary(ch(0));
    let mut script = crate::unicode::script(ch(0));
    let mut n = 1;
    while n < run.len() {
        let c = ch(n);
        if !is_word(c) {
            if n + 1 < run.len() && joins(ch(n - 1), c, ch(n + 1)) {
                n += 1;
                continue;
            }
            break;
        }
        let own = crate::unicode::script(c);
        let other = own.is_some() && if dictionary { !crate::unicode::segmented_by_dictionary(c) } else { script.is_some() && own != script };
        if other {
            break;
        }
        script = script.or(own);
        n += 1;
    }
    if !dictionary {
        return n;
    }
    // (…the dictionary's first word past the place: its boundaries in the text as it reads, the run and what is behind
    // the place — in the walk's order both, the other way round where it went back)
    let mut ahead: Vec<u32> = run[..n].to_vec();
    let mut behind = behind();
    let (text, at) = if forward {
        behind.reverse();
        let at = behind.len();
        (behind.into_iter().chain(ahead).collect::<Vec<u32>>(), at)
    } else {
        ahead.reverse();
        (ahead.into_iter().chain(behind).collect::<Vec<u32>>(), n)
    };
    let mut units = Vec::with_capacity(text.len() * 2);
    let mut ends = Vec::with_capacity(text.len());
    for &c in &text {
        let mut pair = [0u16; 2];
        units.extend_from_slice(char::from_u32(c).unwrap_or('\u{FFFD}').encode_utf16(&mut pair));
        ends.push(units.len());
    }
    let chars_to = |unit: usize| ends.iter().take_while(|&&e| e <= unit).count();
    let boundaries: Vec<usize> = word_segmenter().segment_utf16(&units).map(chars_to).collect();
    let passed = if forward {
        boundaries.iter().find(|&&b| b > at).map(|&b| b - at)
    } else {
        boundaries.iter().rev().find(|&&b| b < at).map(|&b| at - b)
    };
    passed.map_or(n, |p| p.clamp(1, n))
}
// How much of the text behind a place a word step reads its dictionary script's words in.
pub(crate) const CONTEXT: usize = 64;

// ICU4X's word segmenter (its dictionaries, and its models for the scripts it has none of), made once.
fn word_segmenter() -> icu_segmenter::WordSegmenterBorrowed<'static> {
    static SEGMENTER: std::sync::OnceLock<icu_segmenter::WordSegmenterBorrowed<'static>> = std::sync::OnceLock::new();
    *SEGMENTER.get_or_init(|| icu_segmenter::WordSegmenter::new_auto(icu_segmenter::options::WordBreakInvariantOptions::default()))
}

// White space, and a word character (`word_unit`'s, of a code point), to a caret moving by words.
pub(crate) fn is_space(ch: u32) -> bool {
    char::from_u32(ch).is_some_and(char::is_whitespace)
}
pub(crate) fn is_word(ch: u32) -> bool {
    ch == u32::from(b'_') || crate::unicode::is_letter(ch) || crate::unicode::is_number(ch)
}

// A word character, as a UTF-16 unit is one (`/[\p{L}\p{N}_]/u` tests the string's units): a letter, a number or `_`;
// a surrogate half none.
fn word_unit(u: u16) -> bool {
    u == u16::from(b'_') || (!(0xD800..=0xDFFF).contains(&u) && (crate::unicode::is_letter(u32::from(u)) || crate::unicode::is_number(u32::from(u))))
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "caretStep", caret_step, context_id);
    crate::dom::register(scope, ns, "caretWordStep", caret_word_step, context_id);
    crate::dom::register(scope, ns, "caretBlockEdge", caret_block_edge, context_id);
    crate::dom::register(scope, ns, "caretWord", caret_word, context_id);
    crate::dom::register(scope, ns, "caretEdge", caret_edge, context_id);
}

// [nodes, offsets…] for points of `nodes` — the nodes as `nodes_value` answers them.
fn points<'s>(scope: &mut v8::PinScope<'s, '_>, cid: i32, nodes: &[NodeId], offsets: &[u32]) -> v8::Local<'s, v8::Value> {
    let mut values = vec![crate::dom::nodes_value(scope, cid, nodes)];
    values.extend(offsets.iter().map(|&o| -> v8::Local<'_, v8::Value> { v8::Integer::new_from_unsigned(scope, o).into() }));
    v8::Array::new_with_elements(scope, &values).into()
}

// __dom.caretStep(nid, offset, forward, now) -> [[node], offset] (`caret_step`), or undefined where the caret stays (or
// the realm has no style engine).
fn caret_step(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    step_op(scope, args, rv, RealmArena::caret_step);
}
// __dom.caretWordStep(nid, offset, forward, now) -> …by a word (`caret_word_step`).
fn caret_word_step(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>) {
    step_op(scope, args, rv, RealmArena::caret_word_step);
}
type Step = fn(&RealmArena, &mut StyleEngine, f64, NodeId, u32, bool) -> Option<(NodeId, u32)>;
fn step_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>, step: Step) {
    let Some(node) = nid_arg(scope, &args, 0) else { return };
    let offset = args.get(1).uint32_value(scope).unwrap_or(0);
    let forward = args.get(2).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    if let Some((to, at)) = crate::rendered::with_engine(scope, &args, 3, |engine, arena, now| step(arena, engine, now, node, offset, forward)).flatten() {
        rv.set(points(scope, cid, &[to], &[at]));
    }
}

// __dom.caretBlockEdge(nid, end, now) -> [[node], offset] (`caret_block_edge`), or undefined.
fn caret_block_edge(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(node) = nid_arg(scope, &args, 0) else { return };
    let end = args.get(1).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    if let Some((to, at)) = crate::rendered::with_engine(scope, &args, 2, |engine, arena, now| arena.caret_block_edge(engine, now, node, end)).flatten() {
        rv.set(points(scope, cid, &[to], &[at]));
    }
}

// __dom.caretWord(nid, offset) -> [[startNode, endNode], startOffset, endOffset] (`caret_word`), or undefined.
fn caret_word(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(node) = nid_arg(scope, &args, 0) else { return };
    let offset = args.get(1).uint32_value(scope).unwrap_or(0);
    let cid = crate::dom::realm_id(scope, &args);
    if let Some((s, so, e, eo)) = crate::dom::realm(scope, cid).caret_word(node, offset) {
        rv.set(points(scope, cid, &[s, e], &[so, eo]));
    }
}

// __dom.caretEdge(nid, end, now) -> [[node], offset] (`caret_edge`), or undefined where the realm has no style engine.
fn caret_edge(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(root) = nid_arg(scope, &args, 0) else { return };
    let end = args.get(1).is_true();
    let cid = crate::dom::realm_id(scope, &args);
    if let Some((to, at)) = crate::rendered::with_engine(scope, &args, 2, |engine, arena, now| arena.caret_edge(engine, now, root, end)) {
        rv.set(points(scope, cid, &[to], &[at]));
    }
}
