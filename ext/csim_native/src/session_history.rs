// A top-level traversable's session history (HTML §7.4.1): ONE joint history of the page and every frame of it. Each
// navigable's entries are a list — the page's the traversable's own, a frame's a NESTED HISTORY in the document state of
// its parent's entry — and each entry has a STEP, the traversable's current one which the navigables' active entries are
// the entries of: a navigable's active entry is its entry of the greatest step not past it. A navigation of any of them
// adds the step after the current one (and clears every navigable's forward entries), a replacement keeps its entry's
// step, and `history.length` is the number of steps used; `history.back()` in the page or in any frame traverses the
// traversable by one step, which moves whichever navigable's entry the step is (Chrome: a frame navigated, the page's
// `history.length` is one more and its `history.back()` takes the FRAME back).
//
// The entries here are what the joint history is made of — their steps, their document states, their URLs; what a
// replay of one sends and restores (a POST's body, the classic history API state, form state) is the host's, by the
// entry's id (browser.rb). A frame's navigable is the id navigables.rs gives it, and that of the page document build it
// was made under (`rebuilt`): a document the page traverses back to is made again with navigables of its own, which
// the nested histories its document state kept from before are not (they still count their steps).

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Clone)]
struct Entry {
    id: u64,
    step: i64,
    url: String,
    doc: u64,
}

#[derive(Clone)]
struct Nested {
    navigable: u32,
    build: u32,
    entries: Vec<Entry>,
}

#[derive(Clone, Default)]
struct State {
    entries: Vec<Entry>,
    // Each document state's nested histories, by its id: the session histories of the child navigables of its document.
    docs: HashMap<u64, Vec<Nested>>,
    current: i64,
}

#[derive(Default)]
struct Traversable {
    state: State,
    made: u64,
    build: u32,
    // The history as it stood before a navigation that may end in no document (a download, a hand-off), by slot: the
    // page's (0) and a frame's (1).
    saved: [Option<State>; 2],
}

// The navigable a list belongs to: 0 the traversable's own.
const TOP: u32 = 0;

// One navigable's change of active entry a traversal makes: its navigable, the entry, and whether that is of the same
// document as the entry it leaves (a popstate, not a document made again).
pub(crate) type Change = (u32, u64, bool);

fn active(list: &[Entry], step: i64) -> Option<&Entry> {
    list.iter().filter(|e| e.step <= step).max_by_key(|e| e.step)
}

impl State {
    fn new() -> Self {
        State { current: -1, ..Default::default() }
    }

    // The entry list of navigable `nav` in the tree of active entries, or None where it has none there.
    fn list(&self, nav: u32, build: u32) -> Option<&Vec<Entry>> {
        if nav == TOP {
            return Some(&self.entries);
        }
        let mut lists = vec![&self.entries];
        while let Some(list) = lists.pop() {
            let Some(entry) = active(list, self.current) else { continue };
            for nested in self.docs.get(&entry.doc).into_iter().flatten() {
                if nested.navigable == nav && nested.build == build {
                    return Some(&nested.entries);
                }
                if nested.build == build {
                    lists.push(&nested.entries);
                }
            }
        }
        None
    }

    fn list_mut(&mut self, nav: u32, build: u32) -> Option<&mut Vec<Entry>> {
        if nav == TOP {
            return Some(&mut self.entries);
        }
        let doc = self.parent_doc_of(nav, build)?;
        self.docs.get_mut(&doc)?.iter_mut().find(|n| n.navigable == nav && n.build == build).map(|n| &mut n.entries)
    }

    // The document state whose nested histories hold navigable `nav`'s, in the tree of active entries.
    fn parent_doc_of(&self, nav: u32, build: u32) -> Option<u64> {
        let mut lists = vec![&self.entries];
        while let Some(list) = lists.pop() {
            let Some(entry) = active(list, self.current) else { continue };
            for nested in self.docs.get(&entry.doc).into_iter().flatten().filter(|n| n.build == build) {
                if nested.navigable == nav {
                    return Some(entry.doc);
                }
                lists.push(&nested.entries);
            }
        }
        None
    }

    fn entry(&self, id: u64) -> Option<&Entry> {
        self.all_lists().into_iter().flatten().find(|e| e.id == id)
    }

    fn all_lists(&self) -> Vec<&Vec<Entry>> {
        let mut lists = vec![&self.entries];
        lists.extend(self.docs.values().flatten().map(|n| &n.entries));
        lists
    }

    // HTML "get all used history steps".
    fn used_steps(&self) -> Vec<i64> {
        self.all_lists().into_iter().flatten().map(|e| e.step).collect::<BTreeSet<_>>().into_iter().collect()
    }

    // HTML "clear the forward session history": every navigable's entries past the current step dropped — and the
    // document states only they had, with the nested histories in them.
    fn clear_forward(&mut self) {
        let current = self.current;
        self.entries.retain(|e| e.step <= current);
        for nested in self.docs.values_mut().flatten() {
            nested.entries.retain(|e| e.step <= current);
        }
        self.collect_docs();
    }

    fn collect_docs(&mut self) {
        let mut live = HashSet::new();
        let mut lists = vec![self.entries.clone()];
        while let Some(list) = lists.pop() {
            for e in list {
                if live.insert(e.doc) {
                    lists.extend(self.docs.get(&e.doc).into_iter().flatten().map(|n| n.entries.clone()));
                }
            }
        }
        self.docs.retain(|doc, _| live.contains(doc));
    }
}

impl Traversable {
    fn mint(&mut self) -> u64 {
        self.made += 1;
        self.made
    }

    // Navigable `nav`'s entry list, made — HTML "create a new child navigable": a nested history in its parent's active
    // document state, its one entry `url`'s of the step of that document state's first entry — where it has none.
    fn ensure(&mut self, nav: u32, parent: u32, url: &str) -> Option<u64> {
        let build = self.build;
        if let Some(list) = self.state.list(nav, build) {
            return active(list, self.state.current).map(|e| e.id);
        }
        let parent_list = self.state.list(parent, build)?;
        let doc = active(parent_list, self.state.current)?.doc;
        let step = parent_list.iter().filter(|e| e.doc == doc).map(|e| e.step).min()?;
        let (id, entry_doc) = (self.mint(), self.mint());
        let entry = Entry { id, step, url: url.to_owned(), doc: entry_doc };
        self.state.docs.entry(doc).or_default().push(Nested { navigable: nav, build, entries: vec![entry] });
        Some(id)
    }

    // A navigation of `nav` to `url` committed: an entry of the step after the current one (its forward entries, and
    // every other navigable's, cleared first: HTML "finalize a cross-document navigation") — or, `replace`, in place of
    // its active entry, of that one's step. `same_document` keeps the entry's document state (a pushState / a fragment's
    // / a replaceState).
    fn commit(&mut self, nav: u32, parent: u32, url: &str, same_document: bool, replace: bool) -> Option<u64> {
        if nav != TOP && self.state.list(nav, self.build).is_none() {
            self.ensure(nav, parent, "about:blank")?;
        }
        let (id, fresh_doc) = (self.mint(), self.mint());
        let build = self.build;
        let current = self.state.current;
        if !replace {
            self.state.clear_forward();
        }
        let list = self.state.list_mut(nav, build)?;
        let leaving = active(list, current).cloned();
        let doc = match (&leaving, same_document) {
            (Some(e), true) => e.doc,
            _ => fresh_doc,
        };
        if replace {
            if let Some(old) = leaving {
                let at = list.iter().position(|e| e.id == old.id)?;
                list[at] = Entry { id, step: old.step, url: url.to_owned(), doc };
                self.state.collect_docs();
                return Some(id);
            }
        }
        let step = current + 1;
        list.push(Entry { id, step, url: url.to_owned(), doc });
        self.state.current = step;
        Some(id)
    }

    // HTML "traverse the history by a delta": the step `delta` used steps from the current one, and each navigable's
    // change of active entry applying it makes — the page's first, then its frames' (none of a navigable whose document
    // is made again, its frames made with it) — or None where there is no such step.
    fn plan(&self, delta: i64) -> Option<(i64, Vec<Change>)> {
        let steps = self.state.used_steps();
        let here = steps.iter().rposition(|&s| s <= self.state.current)? as i64;
        let target = *steps.get(usize::try_from(here + delta).ok()?)?;
        let mut changes = Vec::new();
        let mut lists = vec![(TOP, &self.state.entries)];
        while let Some((nav, list)) = lists.pop() {
            let (Some(from), Some(to)) = (active(list, self.state.current), active(list, target)) else { continue };
            let same_document = from.doc == to.doc;
            if from.id != to.id {
                changes.push((nav, to.id, same_document));
            }
            if same_document {
                for nested in self.state.docs.get(&to.doc).into_iter().flatten().filter(|n| n.build == self.build).rev() {
                    lists.push((nested.navigable, &nested.entries));
                }
            }
        }
        Some((target, changes))
    }

    fn ids(&self) -> Vec<u64> {
        let states = std::iter::once(&self.state).chain(self.saved.iter().flatten());
        states.flat_map(|s| s.all_lists().into_iter().flatten().map(|e| e.id).collect::<Vec<_>>()).collect()
    }
}

#[magnus::wrap(class = "Capybara::Simulated::Native::SessionHistory", free_immediately)]
pub(crate) struct SessionHistory(RefCell<Traversable>);

impl SessionHistory {
    fn new() -> Self {
        SessionHistory(RefCell::new(Traversable { state: State::new(), ..Default::default() }))
    }

    // #seed(navigable, parent, url) -> the id of the navigable's active entry, its session history made with `url`'s
    // entry where it has none; nil where its parent has none.
    fn seed(&self, nav: u32, parent: u32, url: String) -> Option<u64> {
        self.0.borrow_mut().ensure(nav, parent, &url)
    }
    // #push(navigable, parent, url, same_document) -> the id of the entry a navigation of the navigable adds.
    fn push(&self, nav: u32, parent: u32, url: String, same_document: bool) -> Option<u64> {
        self.0.borrow_mut().commit(nav, parent, &url, same_document, false)
    }
    // #replace(navigable, parent, url, same_document) -> …the id of the one it makes in place of its active entry.
    fn replace(&self, nav: u32, parent: u32, url: String, same_document: bool) -> Option<u64> {
        let mut t = self.0.borrow_mut();
        if nav == TOP && t.state.entries.is_empty() {
            return t.commit(nav, parent, &url, same_document, false);
        }
        t.commit(nav, parent, &url, same_document, true)
    }
    // #active(navigable) -> the id of its active entry, or nil.
    fn active(&self, nav: u32) -> Option<u64> {
        let t = self.0.borrow();
        active(t.state.list(nav, t.build)?, t.state.current).map(|e| e.id)
    }
    // #url(entry) -> its URL, or nil for no such entry.
    fn url(&self, id: u64) -> Option<String> {
        self.0.borrow().state.entry(id).map(|e| e.url.clone())
    }
    // #set_url(entry, url): its URL made `url` (a redirect's, a replaceState's).
    fn set_url(&self, id: u64, url: String) {
        let mut t = self.0.borrow_mut();
        let State { entries, docs, .. } = &mut t.state;
        let lists = std::iter::once(entries).chain(docs.values_mut().flatten().map(|n| &mut n.entries));
        if let Some(e) = lists.flatten().find(|e| e.id == id) {
            e.url = url;
        }
    }
    // #length -> `history.length`: the number of steps used, at least 1.
    fn length(&self) -> usize {
        self.0.borrow().state.used_steps().len().max(1)
    }
    // #plan(delta) -> [step, [[navigable, entry, same_document], …]] of a traversal by `delta`, or nil for none.
    fn plan(&self, delta: i64) -> Option<(i64, Vec<Change>)> {
        self.0.borrow().plan(delta)
    }
    // #go_to(step): the traversal to `step` applied — the step a plan gave.
    fn go_to(&self, step: i64) {
        self.0.borrow_mut().state.current = step;
    }
    // #rebuilt: the page's document made anew — its frames' navigables new ones.
    fn rebuilt(&self) {
        self.0.borrow_mut().build += 1;
    }
    // #save(slot) / #restore(slot) -> whether there was one / #forget(slot): the history as it stands, kept for a
    // navigation that may end in no document.
    fn save(&self, slot: usize) {
        let mut t = self.0.borrow_mut();
        let state = t.state.clone();
        if let Some(s) = t.saved.get_mut(slot) {
            *s = Some(state);
        }
    }
    fn restore(&self, slot: usize) -> bool {
        let mut t = self.0.borrow_mut();
        let Some(state) = t.saved.get_mut(slot).and_then(Option::take) else { return false };
        t.state = state;
        true
    }
    fn forget(&self, slot: usize) {
        if let Some(s) = self.0.borrow_mut().saved.get_mut(slot) {
            *s = None;
        }
    }
    // #clear: no entries at all.
    fn clear(&self) {
        let mut t = self.0.borrow_mut();
        t.state = State::new();
        t.saved = Default::default();
    }
    // #ids -> the ids of every entry there is, a saved history's included: the ones whose host data is still wanted.
    fn ids(&self) -> Vec<u64> {
        self.0.borrow().ids()
    }
}

pub(crate) fn define(native: magnus::RModule, ruby: &magnus::Ruby) -> Result<(), magnus::Error> {
    use magnus::{function, method, Module, Object};
    let class = native.define_class("SessionHistory", ruby.class_object())?;
    class.define_singleton_method("new", function!(SessionHistory::new, 0))?;
    class.define_method("seed", method!(SessionHistory::seed, 3))?;
    class.define_method("push", method!(SessionHistory::push, 4))?;
    class.define_method("replace", method!(SessionHistory::replace, 4))?;
    class.define_method("active", method!(SessionHistory::active, 1))?;
    class.define_method("url", method!(SessionHistory::url, 1))?;
    class.define_method("set_url", method!(SessionHistory::set_url, 2))?;
    class.define_method("length", method!(SessionHistory::length, 0))?;
    class.define_method("plan", method!(SessionHistory::plan, 1))?;
    class.define_method("go_to", method!(SessionHistory::go_to, 1))?;
    class.define_method("rebuilt", method!(SessionHistory::rebuilt, 0))?;
    class.define_method("save", method!(SessionHistory::save, 1))?;
    class.define_method("restore", method!(SessionHistory::restore, 1))?;
    class.define_method("forget", method!(SessionHistory::forget, 1))?;
    class.define_method("clear", method!(SessionHistory::clear, 0))?;
    class.define_method("ids", method!(SessionHistory::ids, 0))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history() -> SessionHistory {
        SessionHistory::new()
    }

    // Chrome, measured 2026-10-24: a frame navigated adds the page a step; the page's back takes the frame back, its
    // forward forth; a frame's pushState after a back clears the forward step; a page's pushState after it, two backs:
    // the page's popstate, then the frame's.
    #[test]
    fn a_frame_navigation_is_a_step_of_the_page() {
        let h = history();
        let a = h.push(TOP, TOP, "/top".into(), false).unwrap();
        h.seed(1, TOP, "/f1".into()).unwrap();
        assert_eq!(h.length(), 1);
        let f2 = h.push(1, TOP, "/f2".into(), false).unwrap();
        assert_eq!(h.length(), 2);
        let (step, changes) = h.plan(-1).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!((changes[0].0, changes[0].2), (1, false));
        h.go_to(step);
        assert_eq!(h.url(h.active(1).unwrap()).as_deref(), Some("/f1"));
        assert_eq!(h.active(TOP), Some(a));
        assert_eq!(h.plan(1).unwrap().1, vec![(1, f2, false)]);
        h.push(1, TOP, "/f1x".into(), true).unwrap();
        assert_eq!(h.length(), 2);
        assert_eq!(h.url(f2), None);
        h.push(TOP, TOP, "/topx".into(), true).unwrap();
        assert_eq!(h.length(), 3);
        let (step, changes) = h.plan(-1).unwrap();
        assert_eq!(changes, vec![(TOP, a, true)]);
        h.go_to(step);
        let (step, changes) = h.plan(-1).unwrap();
        assert_eq!((changes[0].0, changes[0].2), (1, true));
        h.go_to(step);
        assert!(h.plan(-1).is_none());
    }

    // The page navigated to a new document: its frames' entries stay steps of the one it left; traversing back to that
    // makes it again, the frames with it (no change of theirs); a page document built again has new navigables.
    #[test]
    fn a_page_navigation_keeps_the_frames_steps() {
        let h = history();
        let a = h.push(TOP, TOP, "/a".into(), false).unwrap();
        h.seed(1, TOP, "/f1".into());
        h.push(1, TOP, "/f2".into(), false);
        h.rebuilt();
        h.push(TOP, TOP, "/b".into(), false);
        assert_eq!(h.length(), 3);
        let (step, changes) = h.plan(-1).unwrap();
        assert_eq!(changes, vec![(TOP, a, false)]);
        h.go_to(step);
        h.rebuilt();
        assert_eq!(h.active(1), None);
        assert_eq!(h.plan(-1).unwrap().1, vec![]);
    }

    // A replacement keeps its entry's step; a frame's first navigation from its initial about:blank adds none.
    #[test]
    fn a_replacement_adds_no_step() {
        let h = history();
        h.replace(TOP, TOP, "/a".into(), false);
        h.replace(TOP, TOP, "/b".into(), false);
        assert_eq!(h.length(), 1);
        h.replace(2, TOP, "/f".into(), false).unwrap();
        assert_eq!(h.length(), 1);
        assert_eq!(h.url(h.active(2).unwrap()).as_deref(), Some("/f"));
        h.push(TOP, TOP, "/c".into(), false);
        assert_eq!(h.length(), 2);
    }

    // A nested frame's history is in its parent frame's entry's document state; the parent navigated, the child's steps
    // stay, the child itself is gone from the tree of active entries.
    #[test]
    fn a_nested_frame_is_its_parents() {
        let h = history();
        h.push(TOP, TOP, "/a".into(), false);
        h.seed(1, TOP, "/mid".into());
        h.seed(2, 1, "/in1".into()).unwrap();
        h.push(2, 1, "/in2".into(), false).unwrap();
        assert_eq!(h.length(), 2);
        h.push(1, TOP, "/mid2".into(), false);
        assert_eq!(h.length(), 3);
        assert_eq!(h.active(2), None);
        let (step, changes) = h.plan(-1).unwrap();
        assert_eq!(changes.iter().map(|c| c.0).collect::<Vec<_>>(), vec![1]);
        h.go_to(step);
        assert_eq!(h.url(h.active(2).unwrap()).as_deref(), Some("/in2"));
    }

    #[test]
    fn a_saved_history_is_restored() {
        let h = history();
        let a = h.push(TOP, TOP, "/a".into(), false).unwrap();
        h.save(0);
        h.push(TOP, TOP, "/dl".into(), false);
        assert!(h.restore(0));
        assert_eq!(h.active(TOP), Some(a));
        assert_eq!(h.length(), 1);
        assert!(!h.restore(0));
    }
}
