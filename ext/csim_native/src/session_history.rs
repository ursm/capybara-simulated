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
    // The navigables a traversal left at an entry other than the one the current step gives them — one whose target
    // entry's document was not made (a 204, a download): HTML "apply the history step" updates no such navigable, its
    // current entry the one it was at — by navigable, until a step gives it that entry again or it is navigated.
    // …each with the step it was at as it was held, which the navigables of its document are at with it.
    held: HashMap<u32, (u64, i64)>,
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

    // Navigable `nav`'s current entry of its list read at `step`: the one a traversal held it at, else that step's.
    fn current_of<'a>(&self, nav: u32, list: &'a [Entry], step: i64) -> Option<&'a Entry> {
        self.held.get(&nav).and_then(|&(id, _)| list.iter().find(|e| e.id == id)).or_else(|| active(list, step))
    }

    // The tree of current entries: each navigable in it — of page document build `build` — its entry list, the step
    // that list is read at (the current one, but under a navigable a traversal held, the step it was at as it was held)
    // and the document state whose nested histories hold it (none for the page's).
    fn tree(&self, build: u32) -> Vec<(u32, &Vec<Entry>, i64, Option<u64>)> {
        let mut out = Vec::new();
        let mut stack = vec![(TOP, &self.entries, self.current, None)];
        while let Some((nav, list, step, parent)) = stack.pop() {
            out.push((nav, list, step, parent));
            let Some(entry) = self.current_of(nav, list, step) else { continue };
            let below = self.held.get(&nav).map_or(step, |&(_, at)| at);
            for nested in self.docs.get(&entry.doc).into_iter().flatten().filter(|n| n.build == build) {
                stack.push((nested.navigable, &nested.entries, below, Some(entry.doc)));
            }
        }
        out
    }

    // Navigable `nav`'s entry list in the tree of current entries and the step it is read at, or None where it has
    // none there.
    fn find(&self, nav: u32, build: u32) -> Option<(&Vec<Entry>, i64)> {
        if nav == TOP {
            return Some((&self.entries, self.current));
        }
        self.tree(build).into_iter().find(|&(n, ..)| n == nav).map(|(_, list, step, _)| (list, step))
    }

    fn list(&self, nav: u32, build: u32) -> Option<&Vec<Entry>> {
        self.find(nav, build).map(|(list, _)| list)
    }

    // …and its current entry.
    fn current_entry(&self, nav: u32, build: u32) -> Option<&Entry> {
        let (list, step) = self.find(nav, build)?;
        self.current_of(nav, list, step)
    }

    fn list_mut(&mut self, nav: u32, build: u32) -> Option<&mut Vec<Entry>> {
        if nav == TOP {
            return Some(&mut self.entries);
        }
        let doc = self.parent_doc_of(nav, build)?;
        self.docs.get_mut(&doc)?.iter_mut().find(|n| n.navigable == nav && n.build == build).map(|n| &mut n.entries)
    }

    // The document state whose nested histories hold navigable `nav`'s, in the tree of current entries.
    fn parent_doc_of(&self, nav: u32, build: u32) -> Option<u64> {
        self.tree(build).into_iter().find(|&(n, ..)| n == nav).and_then(|(.., parent)| parent)
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
    // document states only they had, with the nested histories in them. A navigable whose current entry is past it —
    // one a traversal held there, a navigable of that one's document — keeps that entry, now the current step's: the one
    // it is at, whose document it shows, in place of that step's own, which it never went to.
    fn clear_forward(&mut self, build: u32) {
        let current = self.current;
        let at: HashSet<u64> = self.tree(build).into_iter().filter_map(|(nav, list, step, _)| self.current_of(nav, list, step)).map(|e| e.id).collect();
        let keep = |list: &mut Vec<Entry>| {
            if let Some(i) = list.iter().position(|e| e.step > current && at.contains(&e.id)) {
                list[i].step = current;
                let id = list[i].id;
                list.retain(|e| e.id == id || e.step != current);
            }
            list.retain(|e| e.step <= current);
        };
        keep(&mut self.entries);
        for nested in self.docs.values_mut().flatten() {
            keep(&mut nested.entries);
        }
        self.collect_docs();
        self.drop_stale_holds(build);
    }

    // …a hold of an entry gone, of a navigable out of the tree, or of the entry the step gives its navigable anyway, let
    // go of.
    fn drop_stale_holds(&mut self, build: u32) {
        if self.held.is_empty() {
            return;
        }
        let stands: HashSet<u32> = self
            .tree(build)
            .into_iter()
            .filter(|&(nav, list, step, _)| {
                self.held.get(&nav).is_some_and(|&(id, _)| list.iter().any(|e| e.id == id) && active(list, step).is_some_and(|e| e.id != id))
            })
            .map(|(nav, ..)| nav)
            .collect();
        self.held.retain(|nav, _| stands.contains(nav));
    }

    // …and one of a navigable the step `to` moves to another entry than the current one's: it is navigated by the
    // traversal, held at none (the host holding it again where that one's document is not made: `hold`).
    fn release_moved(&mut self, to: i64, build: u32) {
        let moved: HashSet<u32> = self
            .tree(build)
            .into_iter()
            .filter(|&(nav, list, step, _)| {
                self.held.contains_key(&nav) && active(list, step).map(|e| e.id) != active(list, to).map(|e| e.id)
            })
            .map(|(nav, ..)| nav)
            .collect();
        self.held.retain(|nav, _| !moved.contains(nav));
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
        if self.state.list(nav, build).is_some() {
            return self.state.current_entry(nav, build).map(|e| e.id);
        }
        let doc = self.state.current_entry(parent, build)?.doc;
        let parent_list = self.state.list(parent, build)?;
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
        let leaving = self.state.current_entry(nav, build).cloned();
        // (…navigated now: its entry the one it is given, held at none)
        self.state.held.remove(&nav);
        if !replace {
            self.state.clear_forward(build);
        }
        let list = self.state.list_mut(nav, build)?;
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
        self.state.drop_stale_holds(build);
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
        let mut lists = vec![(TOP, &self.state.entries, self.state.current)];
        while let Some((nav, list, step)) = lists.pop() {
            let (Some(from), Some(to)) = (self.state.current_of(nav, list, step), active(list, target)) else { continue };
            let same_document = from.doc == to.doc;
            if from.id != to.id {
                changes.push((nav, to.id, same_document));
            }
            if same_document {
                let below = self.state.held.get(&nav).map_or(step, |&(_, at)| at);
                for nested in self.state.docs.get(&to.doc).into_iter().flatten().filter(|n| n.build == self.build).rev() {
                    lists.push((nested.navigable, &nested.entries, below));
                }
            }
        }
        Some((target, changes))
    }

    // HTML "destroy a child navigable": navigable `nav`'s nested history removed from its parent's document state — its
    // steps, and its own frames' with it, counted no more.
    fn destroy(&mut self, nav: u32) {
        let build = self.build;
        let Some(doc) = self.state.parent_doc_of(nav, build) else { return };
        if let Some(nested) = self.state.docs.get_mut(&doc) {
            nested.retain(|n| !(n.navigable == nav && n.build == build));
        }
        self.state.held.remove(&nav);
        self.state.collect_docs();
        self.state.drop_stale_holds(build);
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
        t.state.current_entry(nav, t.build).map(|e| e.id)
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
        let mut t = self.0.borrow_mut();
        let build = t.build;
        t.state.release_moved(step, build);
        t.state.current = step;
        t.state.drop_stale_holds(build);
    }
    // #step -> the current step.
    fn step(&self) -> i64 {
        self.0.borrow().state.current
    }
    // #hold(navigable, entry, step): the navigable left at `entry` — the one it was at at `step` — by the traversal just
    // applied, its target entry's document not made (HTML "apply the history step").
    fn hold(&self, nav: u32, id: u64, step: i64) {
        let mut t = self.0.borrow_mut();
        let build = t.build;
        t.state.held.insert(nav, (id, step));
        t.state.drop_stale_holds(build);
    }
    // #destroyed(navigable): a frame's container removed from its document — its navigable gone, its session history
    // with it.
    fn destroyed(&self, nav: u32) {
        self.0.borrow_mut().destroy(nav);
    }
    // #rebuilt: the page's document made anew — its frames' navigables new ones.
    fn rebuilt(&self) {
        let mut t = self.0.borrow_mut();
        t.build += 1;
        t.state.held.clear();
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
    class.define_method("hold", method!(SessionHistory::hold, 3))?;
    class.define_method("step", method!(SessionHistory::step, 0))?;
    class.define_method("destroyed", method!(SessionHistory::destroyed, 1))?;
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

    // A frame's container removed: its steps are none of the page's (HTML "destroy a child navigable"; Chrome keeps them).
    #[test]
    fn a_destroyed_navigable_takes_its_steps() {
        let h = history();
        h.push(TOP, TOP, "/a".into(), false);
        h.seed(1, TOP, "/f1".into());
        h.push(1, TOP, "/f2".into(), false);
        h.seed(2, 1, "/in".into());
        assert_eq!(h.length(), 2);
        h.destroyed(1);
        assert_eq!(h.length(), 1);
        assert_eq!(h.active(1), None);
        assert_eq!(h.plan(-1).map(|p| p.1), None);
    }

    // A frame a step moves whose target entry's document is not made stays at its own (HTML "apply the history step"):
    // a later step that gives it that entry again is no change of it.
    #[test]
    fn a_held_navigable_stays_at_its_entry() {
        let h = history();
        h.push(TOP, TOP, "/top".into(), false);
        h.seed(1, TOP, "/blank".into());
        let fa = h.push(1, TOP, "/fa".into(), false).unwrap();
        h.seed(2, TOP, "/blank2".into());
        h.push(2, TOP, "/fb".into(), false);
        let (step, _) = h.plan(-2).unwrap();
        h.go_to(step);
        h.hold(1, fa, 2);
        assert_eq!(h.active(1), Some(fa));
        let changes = h.plan(1).unwrap().1;
        assert!(changes.iter().all(|c| c.0 != 1));
        let (step, _) = h.plan(2).unwrap();
        h.go_to(step);
        assert_eq!(h.active(1), Some(fa));
        assert!(h.0.borrow().state.held.is_empty());
    }

    // …and a navigation clearing the forward steps keeps it at that entry, now the current step's.
    #[test]
    fn a_held_navigable_keeps_its_entry_past_a_navigation() {
        let h = history();
        h.push(TOP, TOP, "/top".into(), false);
        h.seed(1, TOP, "/blank".into());
        let fa = h.push(1, TOP, "/fa".into(), false).unwrap();
        h.seed(2, TOP, "/blank2".into());
        h.push(2, TOP, "/fb".into(), false);
        let (step, _) = h.plan(-2).unwrap();
        h.go_to(step);
        h.hold(1, fa, 2);
        h.push(2, TOP, "/mz".into(), false);
        assert_eq!(h.active(1), Some(fa));
        assert_eq!(h.length(), 2);
        assert!(h.0.borrow().state.held.is_empty());
    }

    // …released where a later step moves it to another entry (its document made), and the frames of its document read
    // at the step it was held at.
    #[test]
    fn a_hold_goes_where_a_step_moves_the_navigable() {
        let h = history();
        h.push(TOP, TOP, "/top".into(), false);
        h.seed(1, TOP, "/blank".into());
        let fa = h.push(1, TOP, "/fa".into(), false).unwrap();
        h.seed(3, 1, "/c0".into());
        let cz = h.push(3, 1, "/cz".into(), false).unwrap();
        let fc = h.push(1, TOP, "/fc".into(), false).unwrap();
        h.seed(2, TOP, "/blank2".into());
        h.push(2, TOP, "/fb".into(), false);
        let before = h.step();
        let (step, _) = h.plan(-4).unwrap();
        h.go_to(step);
        h.hold(1, fc, before);
        assert_eq!(h.active(1), Some(fc));
        let (step, changes) = h.plan(2).unwrap();
        assert!(changes.contains(&(1, fa, false)));
        h.go_to(step);
        assert_eq!(h.active(1), Some(fa));
        assert_eq!(h.active(3), Some(cz));
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
