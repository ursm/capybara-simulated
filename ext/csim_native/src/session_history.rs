// A top-level traversable's session history (HTML §7.4.1): ONE joint history of the page and every frame of it. Each
// navigable's entries are a list — the page's the traversable's own, a frame's a NESTED HISTORY in the document state of
// its parent's entry — and each entry has a STEP, the traversable's current one which the navigables' active entries are
// the entries of: a navigable's active entry is its entry of the greatest step not past it. A navigation of any of them
// adds the step after the current one (and clears every navigable's forward entries), a replacement keeps its entry's
// step, and `history.length` is the number of steps used; `history.back()` in the page or in any frame traverses the
// traversable by one step, which moves whichever navigable's entry the step is (Chrome: a frame navigated, the page's
// `history.length` is one more and its `history.back()` takes the FRAME back).
//
// The entries here are what the joint history is made of — their steps, their document states, their URLs — and what a
// replay of one sends and restores (`Data`), which the host gives and reads by the entry's id (browser.rb). A frame's
// navigable is the id navigables.rs gives it, and that of the page document build it was made under (`rebuilt`): a
// document the page traverses back to is made again with navigables of its own, which the nested histories its document
// state kept from before are not (they still count their steps).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError, Weak};

use magnus::{RHash, RString, Symbol, TryConvert};

#[derive(Clone)]
struct Entry {
    id: u64,
    step: i64,
    url: String,
    doc: u64,
    // (…shared with the copies a saved history keeps, a change to it made on its own: `Arc::make_mut`)
    data: Arc<Data>,
}

// The text fields of an entry's `Data`: the origin, Referer and referrer policy its request was sent with, and its
// document's referrer.
const TEXT_FIELDS: [&str; 4] = ["origin", "referer", "referrer_policy", "referrer"];

// What a replay of an entry sends and restores: how it was reached — a POST's body and content type, the origin, Referer
// and referrer policy its request was sent with (HTML's document state) — its document's referrer, a frame's, and its
// classic history API state and its document's persisted form state, serialized (StructuredSerializeForStorage).
#[derive(Clone, Default)]
struct Data {
    post: Option<(Arc<[u8]>, Option<String>)>,
    // (…by `TEXT_FIELDS`)
    texts: [Option<String>; 4],
    state: Option<Arc<[u8]>>,
    form_state: Option<Arc<[u8]>>,
}

impl Data {
    fn of(ruby: &magnus::Ruby, fields: RHash) -> Result<Self, magnus::Error> {
        let mut data = Data::default();
        data.merge(ruby, fields)?;
        Ok(data)
    }

    // The fields `fields` names made what it gives them — nil none — `:body` and `:content_type` a POST's together.
    fn merge(&mut self, ruby: &magnus::Ruby, fields: RHash) -> Result<(), magnus::Error> {
        let text = |key: &str| -> Result<Option<Option<String>>, magnus::Error> {
            let Some(v) = fields.get(ruby.to_symbol(key)) else { return Ok(None) };
            Ok(Some(Option::<String>::try_convert(v)?))
        };
        let bytes = |key: &str| -> Result<Option<Option<Arc<[u8]>>>, magnus::Error> {
            let Some(v) = fields.get(ruby.to_symbol(key)) else { return Ok(None) };
            Ok(Some(Option::<RString>::try_convert(v)?.map(|s| crate::fetch_rules::ruby_bytes(s).into())))
        };
        if let Some(body) = bytes("body")? {
            let content_type = text("content_type")?.flatten();
            self.post = body.map(|body| (body, content_type));
        }
        for (key, field) in TEXT_FIELDS.iter().zip(&mut self.texts) {
            if let Some(v) = text(key)? {
                *field = v;
            }
        }
        if let Some(v) = bytes("state")? {
            self.state = v;
        }
        if let Some(v) = bytes("form_state")? {
            self.form_state = v;
        }
        Ok(())
    }

    // The text field `key` names, where it has one.
    fn text(&self, key: &str) -> Option<&str> {
        self.texts[TEXT_FIELDS.iter().position(|&k| k == key)?].as_deref()
    }

    // …and as a hash of the ones it has.
    fn to_hash(&self, ruby: &magnus::Ruby, url: &str) -> Result<RHash, magnus::Error> {
        let hash = ruby.hash_new();
        hash.aset(ruby.to_symbol("url"), url)?;
        if let Some((body, content_type)) = &self.post {
            hash.aset(ruby.to_symbol("body"), ruby.str_from_slice(body))?;
            hash.aset(ruby.to_symbol("content_type"), content_type.as_deref())?;
        }
        for key in TEXT_FIELDS {
            if let Some(v) = self.text(key) {
                hash.aset(ruby.to_symbol(key), v)?;
            }
        }
        for (key, field) in [("state", &self.state), ("form_state", &self.form_state)] {
            if let Some(v) = field {
                hash.aset(ruby.to_symbol(key), ruby.str_from_slice(v))?;
            }
        }
        Ok(hash)
    }
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
    // The session history traversal queue (HTML §7.4.1.2): the traversals a page's `history` asked for, each applied as
    // its task runs, in order — and the token the next one is given.
    queued: Vec<Queued>,
    tokens: u64,
}

// A traversal queued: its token, its delta, the realm whose `history` asked for it, and whether it makes a document
// again (one it moves within the documents waits a turn: its `popstate` after what is due as the script ends).
#[derive(Clone, Copy)]
struct Queued {
    token: u64,
    delta: i64,
    realm: i32,
    documents: bool,
}

// The navigable a list belongs to: 0 the traversable's own.
const TOP: u32 = 0;

// Whether a frame's entry at `url` can be made again by a traversal alone: one of an http(s) URL, or about:blank's —
// what a frame's document at another records no entry for.
pub(crate) fn recordable(url: &str) -> bool {
    let scheme = url.split_once(':').map_or("", |(s, _)| s);
    if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") {
        return url[scheme.len()..].starts_with("://");
    }
    let rest = url.get(..11).filter(|s| s.eq_ignore_ascii_case("about:blank")).map(|_| &url[11..]);
    rest.is_some_and(|rest| rest.is_empty() || rest.starts_with(['?', '#']))
}

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

    fn entry_mut(&mut self, id: u64) -> Option<&mut Entry> {
        let State { entries, docs, .. } = self;
        std::iter::once(entries).chain(docs.values_mut().flatten().map(|n| &mut n.entries)).flatten().find(|e| e.id == id)
    }

    fn all_lists(&self) -> Vec<&Vec<Entry>> {
        let mut lists = vec![&self.entries];
        lists.extend(self.docs.values().flatten().map(|n| &n.entries));
        lists
    }

    // `history.length`: the number of steps used, at least 1.
    fn length(&self) -> usize {
        self.used_steps().len().max(1)
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
        if self.held.is_empty() {
            return;
        }
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
        let entry = Entry { id, step, url: url.to_owned(), doc: entry_doc, data: Default::default() };
        self.state.docs.entry(doc).or_default().push(Nested { navigable: nav, build, entries: vec![entry] });
        Some(id)
    }

    // A navigation of `nav` to `url` committed: an entry of the step after the current one (its forward entries, and
    // every other navigable's, cleared first: HTML "finalize a cross-document navigation") — or, `replace`, in place of
    // its active entry, of that one's step — what a replay of it sends and restores `data`. `same_document` keeps the
    // entry's document state (a pushState / a fragment's / a replaceState).
    fn commit(&mut self, nav: u32, parent: u32, url: &str, same_document: bool, replace: bool, data: Data) -> Option<u64> {
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
                list[at] = Entry { id, step: old.step, url: url.to_owned(), doc, data: Arc::new(data) };
                self.state.collect_docs();
                return Some(id);
            }
        }
        let step = current + 1;
        list.push(Entry { id, step, url: url.to_owned(), doc, data: Arc::new(data) });
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

    // …the plan of a traversal by `delta` as the host applies it: past a step whose frame's entry it cannot make again
    // alone — a srcdoc or a blob document it left, a data: one's, which have no bytes to come back to (`recordable`) —
    // on to the next step that way.
    fn traversal(&self, mut delta: i64) -> Option<(i64, Vec<Change>)> {
        let way = if delta > 0 { 1 } else { -1 };
        loop {
            let plan = self.plan(delta)?;
            let stuck = plan.1.iter().any(|&(nav, id, same_document)| {
                nav != TOP && !same_document && !self.state.entry(id).is_some_and(|e| recordable(&e.url))
            });
            if !stuck {
                return Some(plan);
            }
            delta += way;
        }
    }

    // A traversal by `delta` that realm `realm`'s `history` asked for queued: [its token, the delay of its task] — none
    // for one making a document again, whose task goes ahead of a navigation the script plans after it (a frame's `src`
    // set, Chrome and Firefox: never requested), a turn for one within the documents. Judged from the step those queued
    // before it reach.
    fn queue(&mut self, delta: i64, realm: i32) -> (u64, u32) {
        self.tokens += 1;
        let token = self.tokens;
        let ahead: i64 = self.queued.iter().map(|q| q.delta).sum();
        let documents = self.traversal(ahead + delta).is_some_and(|(_, changes)| changes.iter().any(|&(_, _, same)| !same));
        self.queued.push(Queued { token, delta, realm, documents });
        (token, if documents { 0 } else { 1 })
    }
    // …those queued up to and with the one of `token`, taken off the queue to be applied in order: none where it is not
    // queued (the host applied it already).
    fn take_queued(&mut self, token: u64) -> Vec<Queued> {
        let Some(at) = self.queued.iter().position(|q| q.token == token) else { return Vec::new() };
        self.queued.drain(..=at).collect()
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
}

// A window's session history: the host's handle on it, and the realms' (`__dom.historyLength`), by its number — the
// process's, as the isolates that read it and the host thread that writes it are.
#[magnus::wrap(class = "Capybara::Simulated::Native::SessionHistory", free_immediately)]
pub(crate) struct SessionHistory {
    id: u64,
    traversable: Arc<Mutex<Traversable>>,
}

static HISTORIES: LazyLock<Mutex<(u64, HashMap<u64, Weak<Mutex<Traversable>>>)>> = LazyLock::new(Default::default);
fn histories() -> MutexGuard<'static, (u64, HashMap<u64, Weak<Mutex<Traversable>>>)> {
    HISTORIES.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Drop for SessionHistory {
    fn drop(&mut self) {
        histories().1.remove(&self.id);
    }
}

impl SessionHistory {
    fn new() -> Self {
        let traversable = Arc::new(Mutex::new(Traversable { state: State::new(), ..Default::default() }));
        let mut registry = histories();
        registry.0 += 1;
        let id = registry.0;
        registry.1.insert(id, Arc::downgrade(&traversable));
        SessionHistory { id, traversable }
    }
    fn lock(&self) -> MutexGuard<'_, Traversable> {
        self.traversable.lock().unwrap_or_else(PoisonError::into_inner)
    }
    // #id -> its number, which its window's realms are told (`setSessionHistory`).
    fn id(&self) -> u64 {
        self.id
    }

    // #seed(navigable, parent, url) -> the id of the navigable's active entry, its session history made with `url`'s
    // entry where it has none; nil where its parent has none.
    fn seed(&self, nav: u32, parent: u32, url: String) -> Option<u64> {
        self.lock().ensure(nav, parent, &url)
    }
    // #push(navigable, parent, url, same_document, data) -> the id of the entry a navigation of the navigable adds, what
    // a replay of it sends and restores `data` (`#update`'s fields).
    fn push(&self, nav: u32, parent: u32, url: String, same_document: bool, data: Data) -> Option<u64> {
        self.lock().commit(nav, parent, &url, same_document, false, data)
    }
    // #replace(navigable, parent, url, same_document, data) -> …the id of the one it makes in place of its active entry.
    fn replace(&self, nav: u32, parent: u32, url: String, same_document: bool, data: Data) -> Option<u64> {
        let mut t = self.lock();
        let replace = nav != TOP || !t.state.entries.is_empty();
        t.commit(nav, parent, &url, same_document, replace, data)
    }
    fn push_for_ruby(ruby: &magnus::Ruby, rb_self: &Self, nav: u32, parent: u32, url: String, same_document: bool, fields: RHash) -> Result<Option<u64>, magnus::Error> {
        Ok(rb_self.push(nav, parent, url, same_document, Data::of(ruby, fields)?))
    }
    fn replace_for_ruby(ruby: &magnus::Ruby, rb_self: &Self, nav: u32, parent: u32, url: String, same_document: bool, fields: RHash) -> Result<Option<u64>, magnus::Error> {
        Ok(rb_self.replace(nav, parent, url, same_document, Data::of(ruby, fields)?))
    }
    // #active(navigable) -> the id of its active entry, or nil.
    fn active(&self, nav: u32) -> Option<u64> {
        let t = self.lock();
        t.state.current_entry(nav, t.build).map(|e| e.id)
    }
    // #url(entry) -> its URL, or nil for no such entry.
    fn url(&self, id: u64) -> Option<String> {
        self.lock().state.entry(id).map(|e| e.url.clone())
    }
    // #set_url(entry, url): its URL made `url` (a redirect's, a replaceState's).
    fn set_url(&self, id: u64, url: String) {
        if let Some(e) = self.lock().state.entry_mut(id) {
            e.url = url;
        }
    }
    // #entry(entry) -> {url:, body:, content_type:, origin:, referer:, referrer_policy:, referrer:, state:, form_state:}
    // of those it has (`Data`; a POST's body and content type, the classic history API state and the form state binary
    // strings) — {} for no such entry, or none (nil).
    fn entry(ruby: &magnus::Ruby, rb_self: &Self, id: Option<u64>) -> Result<RHash, magnus::Error> {
        match id.and_then(|id| rb_self.lock().state.entry(id).cloned()) {
            Some(e) => e.data.to_hash(ruby, &e.url),
            None => Ok(ruby.hash_new()),
        }
    }
    // #text(entry, name) -> its text field `name` (`TEXT_FIELDS`: :origin, :referer, :referrer_policy, :referrer), nil
    // for none — what `#entry` gives without copying its bytes out.
    fn text(ruby: &magnus::Ruby, rb_self: &Self, id: Option<u64>, name: Symbol) -> Result<Option<String>, magnus::Error> {
        let name = name.name()?;
        if !TEXT_FIELDS.contains(&&*name) {
            return Err(magnus::Error::new(ruby.exception_arg_error(), format!("no text field {name}")));
        }
        Ok(id.and_then(|id| rb_self.lock().state.entry(id).and_then(|e| e.data.text(&name).map(str::to_owned))))
    }
    // #update(entry, fields): the fields of what a replay of it sends and restores `fields` names made what it gives
    // them (`Data::merge`) — a history saved before keeping the ones it had.
    fn update(ruby: &magnus::Ruby, rb_self: &Self, id: u64, fields: RHash) -> Result<(), magnus::Error> {
        if let Some(e) = rb_self.lock().state.entry_mut(id) {
            Arc::make_mut(&mut e.data).merge(ruby, fields)?;
        }
        Ok(())
    }
    // #length -> `history.length`: the number of steps used, at least 1.
    fn length(&self) -> usize {
        self.lock().state.length()
    }
    // #traversal(delta) -> [step, [[navigable, entry, same_document], …]] of a traversal by `delta` as the host applies
    // it (`Traversable::traversal`), or nil for none.
    fn traversal(&self, delta: i64) -> Option<(i64, Vec<Change>)> {
        self.lock().traversal(delta)
    }
    // #queue(delta, realm) -> [token, delay] (`Traversable::queue`).
    fn queue(&self, delta: i64, realm: i32) -> (u64, u32) {
        self.lock().queue(delta, realm)
    }
    // #take_queued(token) -> [[token, delta, realm], …] (`Traversable::take_queued`); #take_all_queued -> every one.
    fn take_queued(&self, token: u64) -> Vec<(u64, i64, i32)> {
        self.lock().take_queued(token).into_iter().map(|q| (q.token, q.delta, q.realm)).collect()
    }
    fn take_all_queued(&self) -> Vec<(u64, i64, i32)> {
        self.lock().queued.drain(..).map(|q| (q.token, q.delta, q.realm)).collect()
    }
    // #queued? -> whether a traversal is queued; #queued_documents? -> whether one queued makes a document again.
    fn is_queued(&self) -> bool {
        !self.lock().queued.is_empty()
    }
    fn queued_documents(&self) -> bool {
        self.lock().queued.iter().any(|q| q.documents)
    }
    // #last_token -> the token of the traversal queued last, 0 for none ever: those up to it were asked for by now.
    fn last_token(&self) -> u64 {
        self.lock().tokens
    }
    // #clear_queued: the queue emptied — the page's document gone, whose traversals go with it.
    fn clear_queued(&self) {
        self.lock().queued.clear();
    }
    // …the plan with no step passed over (`Traversable::plan`), which the tests read.
    #[cfg(test)]
    fn plan(&self, delta: i64) -> Option<(i64, Vec<Change>)> {
        self.lock().plan(delta)
    }
    // #go_to(step): the traversal to `step` applied — the step a plan gave.
    fn go_to(&self, step: i64) {
        let mut t = self.lock();
        let build = t.build;
        t.state.release_moved(step, build);
        t.state.current = step;
        t.state.drop_stale_holds(build);
    }
    // #step -> the current step.
    fn step(&self) -> i64 {
        self.lock().state.current
    }
    // #hold(navigable, entry, step): the navigable left at `entry` — the one it was at at `step` — by the traversal just
    // applied, its target entry's document not made (HTML "apply the history step").
    fn hold(&self, nav: u32, id: u64, step: i64) {
        let mut t = self.lock();
        let build = t.build;
        t.state.held.insert(nav, (id, step));
        t.state.drop_stale_holds(build);
    }
    // #destroyed(navigable): a frame's container removed from its document — its navigable gone, its session history
    // with it.
    fn destroyed(&self, nav: u32) {
        self.lock().destroy(nav);
    }
    // #rebuilt: the page's document made anew — its frames' navigables new ones.
    fn rebuilt(&self) {
        let mut t = self.lock();
        t.build += 1;
        t.state.held.clear();
    }
    // #save(slot) / #restore(slot) -> whether there was one / #forget(slot): the history as it stands, kept for a
    // navigation that may end in no document.
    fn save(&self, slot: usize) {
        let mut t = self.lock();
        let state = t.state.clone();
        if let Some(s) = t.saved.get_mut(slot) {
            *s = Some(state);
        }
    }
    fn restore(&self, slot: usize) -> bool {
        let mut t = self.lock();
        let Some(state) = t.saved.get_mut(slot).and_then(Option::take) else { return false };
        t.state = state;
        true
    }
    fn forget(&self, slot: usize) {
        if let Some(s) = self.lock().saved.get_mut(slot) {
            *s = None;
        }
    }
    // #clear: no entries at all, nor traversals queued.
    fn clear(&self) {
        let mut t = self.lock();
        t.state = State::new();
        t.saved = Default::default();
        t.queued.clear();
    }
}

pub(crate) fn recordable_for_ruby(url: Option<String>) -> bool {
    url.as_deref().is_some_and(recordable)
}

pub(crate) fn define(native: magnus::RModule, ruby: &magnus::Ruby) -> Result<(), magnus::Error> {
    use magnus::{function, method, Module, Object};
    native.define_module_function("history_recordable_url", function!(recordable_for_ruby, 1))?;
    let class = native.define_class("SessionHistory", ruby.class_object())?;
    class.define_singleton_method("new", function!(SessionHistory::new, 0))?;
    class.define_method("id", method!(SessionHistory::id, 0))?;
    class.define_method("seed", method!(SessionHistory::seed, 3))?;
    class.define_method("push", method!(SessionHistory::push_for_ruby, 5))?;
    class.define_method("replace", method!(SessionHistory::replace_for_ruby, 5))?;
    class.define_method("active", method!(SessionHistory::active, 1))?;
    class.define_method("url", method!(SessionHistory::url, 1))?;
    class.define_method("set_url", method!(SessionHistory::set_url, 2))?;
    class.define_method("entry", method!(SessionHistory::entry, 1))?;
    class.define_method("text", method!(SessionHistory::text, 2))?;
    class.define_method("update", method!(SessionHistory::update, 2))?;
    class.define_method("length", method!(SessionHistory::length, 0))?;
    class.define_method("traversal", method!(SessionHistory::traversal, 1))?;
    class.define_method("queue", method!(SessionHistory::queue, 2))?;
    class.define_method("take_queued", method!(SessionHistory::take_queued, 1))?;
    class.define_method("take_all_queued", method!(SessionHistory::take_all_queued, 0))?;
    class.define_method("queued?", method!(SessionHistory::is_queued, 0))?;
    class.define_method("queued_documents?", method!(SessionHistory::queued_documents, 0))?;
    class.define_method("last_token", method!(SessionHistory::last_token, 0))?;
    class.define_method("clear_queued", method!(SessionHistory::clear_queued, 0))?;
    class.define_method("go_to", method!(SessionHistory::go_to, 1))?;
    class.define_method("hold", method!(SessionHistory::hold, 3))?;
    class.define_method("step", method!(SessionHistory::step, 0))?;
    class.define_method("destroyed", method!(SessionHistory::destroyed, 1))?;
    class.define_method("rebuilt", method!(SessionHistory::rebuilt, 0))?;
    class.define_method("save", method!(SessionHistory::save, 1))?;
    class.define_method("restore", method!(SessionHistory::restore, 1))?;
    class.define_method("forget", method!(SessionHistory::forget, 1))?;
    class.define_method("clear", method!(SessionHistory::clear, 0))?;
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
        let a = h.push(TOP, TOP, "/top".into(), false, Data::default()).unwrap();
        h.seed(1, TOP, "/f1".into()).unwrap();
        assert_eq!(h.length(), 1);
        let f2 = h.push(1, TOP, "/f2".into(), false, Data::default()).unwrap();
        assert_eq!(h.length(), 2);
        let (step, changes) = h.plan(-1).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!((changes[0].0, changes[0].2), (1, false));
        h.go_to(step);
        assert_eq!(h.url(h.active(1).unwrap()).as_deref(), Some("/f1"));
        assert_eq!(h.active(TOP), Some(a));
        assert_eq!(h.plan(1).unwrap().1, vec![(1, f2, false)]);
        h.push(1, TOP, "/f1x".into(), true, Data::default()).unwrap();
        assert_eq!(h.length(), 2);
        assert_eq!(h.url(f2), None);
        h.push(TOP, TOP, "/topx".into(), true, Data::default()).unwrap();
        assert_eq!(h.length(), 3);
        let (step, changes) = h.plan(-1).unwrap();
        assert_eq!(changes, vec![(TOP, a, true)]);
        h.go_to(step);
        let (step, changes) = h.plan(-1).unwrap();
        assert_eq!((changes[0].0, changes[0].2), (1, true));
        h.go_to(step);
        assert!(h.plan(-1).is_none());
    }

    // A traversal skips a step whose frame's entry no traversal can make again alone (a srcdoc one left), on to the
    // next that way; the queue is applied up to a token, in order, and judges a traversal by where those before it go.
    #[test]
    fn a_traversal_skips_an_entry_it_cannot_make_and_queues_in_order() {
        let h = history();
        h.push(TOP, TOP, "http://a.test/".into(), false, Data::default()).unwrap();
        h.seed(1, TOP, "http://a.test/f".into()).unwrap();
        h.push(1, TOP, "about:srcdoc".into(), false, Data::default()).unwrap();
        h.push(1, TOP, "http://a.test/g".into(), false, Data::default()).unwrap();
        assert_eq!(h.length(), 3);
        // (…back from /g: past the srcdoc entry, to /f)
        let (_, changes) = h.traversal(-1).unwrap();
        assert_eq!(h.url(changes[0].1).as_deref(), Some("http://a.test/f"));
        assert!(h.plan(-1).is_some_and(|(_, c)| h.url(c[0].1).as_deref() == Some("about:srcdoc")));
        let (t1, delay1) = h.queue(-1, 0);
        let (t2, _) = h.queue(-1, 0);
        // (…a document made again goes at once; one past the history's start is none, judged from where the first goes)
        assert_eq!(delay1, 0);
        assert!(h.queued_documents());
        assert_eq!(h.take_queued(t1), vec![(t1, -1, 0)]);
        assert!(h.take_queued(t1).is_empty());
        assert_eq!(h.take_all_queued(), vec![(t2, -1, 0)]);
        assert!(!h.is_queued());
        assert_eq!(h.last_token(), t2);
        assert!(recordable("about:blank#x") && recordable("HTTPS://a.test/") && !recordable("about:blanky") && !recordable("data:,x"));
    }

    // The page navigated to a new document: its frames' entries stay steps of the one it left; traversing back to that
    // makes it again, the frames with it (no change of theirs); a page document built again has new navigables.
    #[test]
    fn a_page_navigation_keeps_the_frames_steps() {
        let h = history();
        let a = h.push(TOP, TOP, "/a".into(), false, Data::default()).unwrap();
        h.seed(1, TOP, "/f1".into());
        h.push(1, TOP, "/f2".into(), false, Data::default());
        h.rebuilt();
        h.push(TOP, TOP, "/b".into(), false, Data::default());
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
        h.replace(TOP, TOP, "/a".into(), false, Data::default());
        h.replace(TOP, TOP, "/b".into(), false, Data::default());
        assert_eq!(h.length(), 1);
        h.replace(2, TOP, "/f".into(), false, Data::default()).unwrap();
        assert_eq!(h.length(), 1);
        assert_eq!(h.url(h.active(2).unwrap()).as_deref(), Some("/f"));
        h.push(TOP, TOP, "/c".into(), false, Data::default());
        assert_eq!(h.length(), 2);
    }

    // A nested frame's history is in its parent frame's entry's document state; the parent navigated, the child's steps
    // stay, the child itself is gone from the tree of active entries.
    #[test]
    fn a_nested_frame_is_its_parents() {
        let h = history();
        h.push(TOP, TOP, "/a".into(), false, Data::default());
        h.seed(1, TOP, "/mid".into());
        h.seed(2, 1, "/in1".into()).unwrap();
        h.push(2, 1, "/in2".into(), false, Data::default()).unwrap();
        assert_eq!(h.length(), 2);
        h.push(1, TOP, "/mid2".into(), false, Data::default());
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
        h.push(TOP, TOP, "/a".into(), false, Data::default());
        h.seed(1, TOP, "/f1".into());
        h.push(1, TOP, "/f2".into(), false, Data::default());
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
        h.push(TOP, TOP, "/top".into(), false, Data::default());
        h.seed(1, TOP, "/blank".into());
        let fa = h.push(1, TOP, "/fa".into(), false, Data::default()).unwrap();
        h.seed(2, TOP, "/blank2".into());
        h.push(2, TOP, "/fb".into(), false, Data::default());
        let (step, _) = h.plan(-2).unwrap();
        h.go_to(step);
        h.hold(1, fa, 2);
        assert_eq!(h.active(1), Some(fa));
        let changes = h.plan(1).unwrap().1;
        assert!(changes.iter().all(|c| c.0 != 1));
        let (step, _) = h.plan(2).unwrap();
        h.go_to(step);
        assert_eq!(h.active(1), Some(fa));
        assert!(h.lock().state.held.is_empty());
    }

    // …and a navigation clearing the forward steps keeps it at that entry, now the current step's.
    #[test]
    fn a_held_navigable_keeps_its_entry_past_a_navigation() {
        let h = history();
        h.push(TOP, TOP, "/top".into(), false, Data::default());
        h.seed(1, TOP, "/blank".into());
        let fa = h.push(1, TOP, "/fa".into(), false, Data::default()).unwrap();
        h.seed(2, TOP, "/blank2".into());
        h.push(2, TOP, "/fb".into(), false, Data::default());
        let (step, _) = h.plan(-2).unwrap();
        h.go_to(step);
        h.hold(1, fa, 2);
        h.push(2, TOP, "/mz".into(), false, Data::default());
        assert_eq!(h.active(1), Some(fa));
        assert_eq!(h.length(), 2);
        assert!(h.lock().state.held.is_empty());
    }

    // …released where a later step moves it to another entry (its document made), and the frames of its document read
    // at the step it was held at.
    #[test]
    fn a_hold_goes_where_a_step_moves_the_navigable() {
        let h = history();
        h.push(TOP, TOP, "/top".into(), false, Data::default());
        h.seed(1, TOP, "/blank".into());
        let fa = h.push(1, TOP, "/fa".into(), false, Data::default()).unwrap();
        h.seed(3, 1, "/c0".into());
        let cz = h.push(3, 1, "/cz".into(), false, Data::default()).unwrap();
        let fc = h.push(1, TOP, "/fc".into(), false, Data::default()).unwrap();
        h.seed(2, TOP, "/blank2".into());
        h.push(2, TOP, "/fb".into(), false, Data::default());
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
        let a = h.push(TOP, TOP, "/a".into(), false, Data::default()).unwrap();
        h.save(0);
        h.push(TOP, TOP, "/dl".into(), false, Data::default());
        assert!(h.restore(0));
        assert_eq!(h.active(TOP), Some(a));
        assert_eq!(h.length(), 1);
        assert!(!h.restore(0));
    }

    #[test]
    fn a_saved_history_keeps_the_data_it_had() {
        let h = history();
        let a = h.push(TOP, TOP, "/a".into(), false, Data { texts: [None, Some("/r".into()), None, None], ..Default::default() }).unwrap();
        h.save(0);
        Arc::make_mut(&mut h.lock().state.entry_mut(a).unwrap().data).texts[1] = Some("/changed".into());
        assert!(h.restore(0));
        assert_eq!(h.lock().state.entry(a).unwrap().data.text("referer"), Some("/r"));
    }
}

// The length of the session history numbered `id` (`SessionHistory#length`), none where it is gone.
pub(crate) fn length_of(id: u64) -> Option<usize> {
    let traversable = histories().1.get(&id)?.upgrade()?;
    let t = traversable.lock().unwrap_or_else(PoisonError::into_inner);
    Some(t.state.length())
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "setSessionHistory", set_session_history, context_id);
    crate::dom::register(scope, ns, "historyLength", history_length_op, context_id);
}

// __dom.setSessionHistory(id) — the session history of the isolate's window (`SessionHistory#id`), the host's to say.
fn set_session_history(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let id = args.get(0).number_value(scope).map_or(0, |n| n as u64);
    crate::dom::dom(scope).session_history = id;
}

// __dom.historyLength(realm) -> `history.length` of realm `realm`'s document: its window's session history's — the
// page's, its frames' with it — or, a realm of another traversable (a window `window.open` made in this isolate) or a
// frame's no longer in the page, 1: the one entry of its initial document.
fn history_length_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = args.get(0).int32_value(scope).unwrap_or(0);
    let cid = crate::dom::realm_id(scope, &args);
    let arena = crate::dom::realm(scope, cid);
    let of_page = arena.top_level_realm(realm) == 0 && (realm == 0 || arena.live_container(realm).is_some());
    let id = crate::dom::dom(scope).session_history;
    let length = if of_page { length_of(id).unwrap_or(1) } else { 1 };
    rv.set_uint32(length as u32);
}
