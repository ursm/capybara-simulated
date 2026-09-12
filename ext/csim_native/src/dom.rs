// Native DOM: the per-realm node arena that backs native CSS cascade matching.
//
// Lives in capybara-simulated's OWN native extension (not in rusty_racer, which stays a pure V8
// binding). rusty_racer is linked as a library and exposes one generic seam — set_realm_init_hook —
// which calls `install` in every realm. State lives in the isolate's own TypeId-keyed slot (`Dom`,
// reached via `dom(scope)`), independent of rusty_racer's IsolateState.
//
// `Dom` holds ONE `RealmArena` per realm (keyed by rusty_racer's context_id; see `install` / `realm`),
// so main and frame realms each match over their own tree. The JS side (native-query-shadow.js) builds
// a realm's arena from its parsed document (importNode + syncChildren) and keeps it current at the DOM
// mutation seams; the Servo `selectors` matcher (selector.rs) reads a RealmArena directly. This is the
// READER half of the DOM-in-Rust flip — the store stays in JS; only MATCHING is native.
//
// GENERATIONAL ARENA. A node lives in a SLOT (`Vec<Slot>`); a slot carries a `gen` counter and, when
// free, an empty `data`. A `NodeId` is a `(index, gen)` pair — and so is every INTERNAL edge
// (`parent` / `children`). Freeing a node bumps its slot's gen and lists the index for reuse; a later
// `importNode` hands the recycled index a fresh gen. The point: a STALE edge (a `children` entry left
// pointing at an index whose node was since freed + the slot reused — the class of bug the DOM has
// ~30 unsynced `_children` splice sites that can plant) carries the OLD gen, so following it
// gen-mismatches and is SKIPPED rather than aliasing the new occupant. That converts the silent
// tree corruption naive index-reuse caused (proven on Avo) into safe, self-healing behaviour, which
// is what lets the JS side reclaim a collected node's slot (FinalizationRegistry -> dropNode) and
// bound arena growth in a long no-navigation session. See native-query-shadow.js for the JS lifecycle.
//
// The `nid` that crosses the FFI is the `(index, gen)` pair PACKED into one JS Number (index in the
// low `INDEX_BITS`, gen above — both fit exactly under 2^53); JS treats it as an opaque token and only
// hands it back. `attrsView(nid)` is the native-backed `_attrs` (a named interceptor over a node's
// attributes Vec), installed by the Element constructor in place of the JS `{}`.

// How a NodeId splits across a JS Number: the low INDEX_BITS are the slot index, the rest the
// generation. A packed nid must stay an EXACT f64, i.e. below 2^53 (NID_BITS) — so index and
// generation share those 53 bits. 26 index bits = up to ~67M live slots (a page's high-water element
// count); the remaining 53 - 26 = 27 gen bits = ~134M reuses of one slot before it must retire (see
// `free_node`). JS never unpacks — it stores the Number and passes it back — so the split is private
// to this file + selector.rs.
const NID_BITS: u32 = 53;
const INDEX_BITS: u32 = 26;
const INDEX_MASK: i64 = (1 << INDEX_BITS) - 1;
// Largest generation the pack can represent while keeping the whole nid < 2^53. NOT tied to u32 width:
// the ceiling is the f64 exact-integer budget above the index bits (27 bits here, ~134M), so a hot
// slot is reused ~134M times before it retires — not 63, which a `32 - INDEX_BITS` split would give
// and which would starve the free-list (defeating reclamation) almost immediately in a churny session.
const GEN_MAX: u32 = (1 << (NID_BITS - INDEX_BITS)) - 1;

// A stable reference to an arena node: which slot, and which generation of it. Held both as the JS
// `nid` (packed) and as every internal tree edge, so a reference outliving its node's freeing is
// detectable (the slot's live gen no longer equals `gen`). `Copy` so the matcher's Element-returning
// methods stay cheap.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) struct NodeId {
    pub(crate) idx: u32,
    pub(crate) generation: u32,
}

impl NodeId {
    // Pack into one JS Number (exact f64). gen above INDEX_BITS, index below.
    fn to_f64(self) -> f64 {
        (((self.generation as i64) << INDEX_BITS) | (self.idx as i64)) as f64
    }
    // Unpack a non-negative wire value; a negative value (the JS `-1` "no node" sentinel) is None.
    fn from_i64(n: i64) -> Option<NodeId> {
        if n < 0 {
            return None;
        }
        Some(NodeId {
            idx: (n & INDEX_MASK) as u32,
            generation: (n >> INDEX_BITS) as u32,
        })
    }
}

// One arena node's data: what the selector matcher reads. Attributes are the source of truth
// (ordered, as the DOM keeps them).
pub(crate) struct NodeData {
    // The ASCII-lowercased element name the selector engine matches on (`localName`, not the
    // possibly-upper-cased `tagName` — the matcher is case-normalized).
    pub(crate) local_name: String,
    // Element namespace URL ("" = HTML). Read by the selector engine's namespace matching.
    pub(crate) ns: String,
    pub(crate) attributes: Vec<(String, String)>,
    // Lossless override for the rare attribute value that carries a LONE SURROGATE (unpaired U+D800..
    // U+DFFF) — valid in a JS DOMString (UTF-16) but not in Rust's UTF-8 `String`, where it degrades to
    // U+FFFD. The selector matcher reads `attributes` (the lossy UTF-8) — a lone surrogate can't appear in
    // a spec-parsed selector anyway (an escape resolves to U+FFFD), so matching is unaffected — but the
    // attrsView GETTER must return exactly what was written (getAttribute / css-select identity), so it
    // reads the original UTF-16 units from here when present. Empty for virtually every element; only the
    // value that actually lost data lands here, keyed by attribute name.
    pub(crate) attr_u16: Vec<(String, Vec<u16>)>,
    pub(crate) parent: Option<NodeId>,
    pub(crate) children: Vec<NodeId>,
    // Position within `parent.children`, kept current on every link/unlink, so the
    // selector engine's prev/next-sibling nav is O(1) — without it `:nth-child` is
    // O(n²) per query on a wide parent (a 500-sibling list measured 2.5x slower than
    // css-select; O(1) flips it). It counts ALL entries (a stale edge included), so the
    // sibling walks step from it and skip any stale neighbour they land on.
    pub(crate) child_index: usize,
    // Whether the node has any text/comment child content — so `:empty` is correct even
    // though the arena is element-only (children holds only elements).
    pub(crate) has_text: bool,
    // The border-box a native layout pass wrote for this node (document coords), read back by the JS
    // geometry getters (getBoundingClientRect / offset* / scroll*). None until a pass lays it out;
    // overwritten each pass. See mod layout + the layoutPass / boxOf ops.
    pub(crate) layout_box: Option<crate::layout::Box>,
}

impl NodeData {
    pub(crate) fn get_attr(&self, name: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    // Set the lossy-UTF-8 value the matcher reads, plus (only when the write lost a lone surrogate) the
    // lossless UTF-16 units the getter needs (attrs_get / setAttr). A clean value clears any stale override.
    fn set_attr_full(&mut self, name: &str, value: String, u16: Option<Vec<u16>>) {
        match self.attributes.iter_mut().find(|(k, _)| k == name) {
            Some(slot) => slot.1 = value,
            None => self.attributes.push((name.to_string(), value)),
        }
        match u16 {
            Some(u) => match self.attr_u16.iter_mut().find(|(k, _)| k == name) {
                Some(slot) => slot.1 = u,
                None => self.attr_u16.push((name.to_string(), u)),
            },
            None => {
                if !self.attr_u16.is_empty() {
                    self.attr_u16.retain(|(k, _)| k != name);
                }
            }
        }
    }

    fn clear_attr_u16(&mut self, name: &str) {
        if !self.attr_u16.is_empty() {
            self.attr_u16.retain(|(k, _)| k != name);
        }
    }

    fn get_attr_u16(&self, name: &str) -> Option<&[u16]> {
        if self.attr_u16.is_empty() {
            return None;
        }
        self.attr_u16.iter().find(|(k, _)| k == name).map(|(_, u)| u.as_slice())
    }
}

// Does this UTF-16 unit sequence contain an unpaired surrogate (a high with no following low, or a lone
// low)? Only such a value needs the lossless override — a well-formed value round-trips through UTF-8.
fn has_lone_surrogate(u: &[u16]) -> bool {
    let mut i = 0;
    while i < u.len() {
        let c = u[i];
        if (0xD800..=0xDBFF).contains(&c) {
            if i + 1 < u.len() && (0xDC00..=0xDFFF).contains(&u[i + 1]) {
                i += 2;
                continue;
            }
            return true; // lone high surrogate
        }
        if (0xDC00..=0xDFFF).contains(&c) {
            return true; // lone low surrogate
        }
        i += 1;
    }
    false
}

// Read a V8 value as (lossy UTF-8, optional lossless UTF-16). The UTF-8 is what the matcher stores; the
// UTF-16 is filled ONLY when the value degraded — detected cheaply, since a lost surrogate shows up as a
// U+FFFD in the lossy string (so a value with no U+FFFD skips the second read entirely).
fn read_v8_value(scope: &mut v8::PinScope<'_, '_>, val: v8::Local<'_, v8::Value>) -> (String, Option<Vec<u16>>) {
    let utf8 = val.to_rust_string_lossy(scope);
    if !utf8.contains('\u{FFFD}') {
        return (utf8, None);
    }
    let Some(vs) = val.to_string(scope) else {
        return (utf8, None);
    };
    let mut u = vec![0u16; vs.length()];
    vs.write_v2(scope, 0, &mut u, v8::WriteFlags::empty());
    if has_lone_surrogate(&u) {
        (utf8, Some(u))
    } else {
        (utf8, None) // the U+FFFD was a genuine replacement char in the source, not a lost surrogate
    }
}

// One slot of the arena: the current generation, and the node (None = free). A NodeId referring to a
// slot is live only while `gen` still equals the id's gen — freeing bumps `gen`, so the id (and any
// tree edge holding it) reads as absent afterwards.
#[derive(Default)]
struct Slot {
    generation: u32,
    data: Option<NodeData>,
}

// ONE realm's node arena. The selector matcher reads it through NodeRef, so a match resolves the
// realm's arena ONCE and then does direct slot indexing (no per-node-access map lookup). Element-tree
// navigation lives here: the arena is element-only, so children/siblings are already element nodes.
// Every navigation and deref goes through `get` (gen-checked), so a stale edge self-elides.
#[derive(Default)]
pub(crate) struct RealmArena {
    slots: Vec<Slot>,
    // Indices whose slot is free, LIFO. `importNode` pops one before growing `slots`, so a page's
    // live-node high-water mark bounds `slots.len()` even as nodes churn.
    free: Vec<u32>,
}

impl RealmArena {
    // The live node for `id`, or None if the slot was freed / reused (its gen moved past id.generation) or the
    // index is out of range. The one deref both the ops and the matcher route through.
    pub(crate) fn get(&self, id: NodeId) -> Option<&NodeData> {
        let slot = self.slots.get(id.idx as usize)?;
        if slot.generation == id.generation {
            slot.data.as_ref()
        } else {
            None
        }
    }
    fn get_mut(&mut self, id: NodeId) -> Option<&mut NodeData> {
        let slot = self.slots.get_mut(id.idx as usize)?;
        if slot.generation == id.generation {
            slot.data.as_mut()
        } else {
            None
        }
    }

    // Put `data` in a free slot (reusing a recycled index when one is listed, else growing), returning
    // its NodeId at the slot's CURRENT generation. A recycled slot's gen was already bumped at free.
    fn alloc(&mut self, data: NodeData) -> NodeId {
        if let Some(idx) = self.free.pop() {
            let slot = &mut self.slots[idx as usize];
            slot.data = Some(data);
            NodeId { idx, generation: slot.generation }
        } else {
            let idx = self.slots.len() as u32;
            // The index must fit in INDEX_BITS or it would overflow into the generation bits when packed
            // (to_f64), silently ALIASING a different node — the very corruption this arena prevents. The
            // ceiling (~67M live slots in one realm) is astronomically above any real page, so this is a
            // loud dev-time tripwire on a can't-happen breach, not a production branch.
            debug_assert!((idx as i64) <= INDEX_MASK, "arena index overflowed INDEX_BITS ({idx} > {INDEX_MASK})");
            self.slots.push(Slot { generation: 0, data: Some(data) });
            NodeId { idx, generation: 0 }
        }
    }

    // Free `id`'s slot: drop the node, bump the gen (so every surviving reference — the JS nid, an
    // attrsView holder, a stale tree edge — now reads absent), and list the index for reuse. A gen at
    // the pack ceiling RETIRES the slot instead (dropped but not recycled) so its index can never be
    // handed out with a gen that would collide with an outstanding reference; a no-op if `id` is
    // already stale (double-free / a FinalizationRegistry callback for a slot resetArena already
    // recycled). Idempotent and safe against any wire id.
    fn free_node(&mut self, id: NodeId) {
        let Some(slot) = self.slots.get_mut(id.idx as usize) else {
            return;
        };
        if slot.generation != id.generation || slot.data.is_none() {
            return;
        }
        slot.data = None;
        if slot.generation < GEN_MAX {
            slot.generation += 1;
            self.free.push(id.idx);
        }
    }

    // Drop every node, bumping each occupied slot's gen and listing it for reuse. This is the per-page
    // reset (a navigation) — NOT a Vec clear: bumping (rather than restarting gens from 0) means a
    // detached element from the previous page, still held across the navigation, carries a nid whose
    // gen no longer matches, so it reads absent instead of ALIASING whichever new-page node reused its
    // index. Growth stays bounded because the freed indices feed the next page's allocations.
    fn reset(&mut self) {
        for idx in 0..self.slots.len() {
            let slot = &mut self.slots[idx];
            if slot.data.is_some() {
                slot.data = None;
                if slot.generation < GEN_MAX {
                    slot.generation += 1;
                    self.free.push(idx as u32);
                }
            }
        }
    }

    // Append `child` at the end of `parent`'s children, recording its position so prev/next-sibling
    // nav is O(1). The one place children are linked (create / import), so child_index can never drift
    // from the list.
    fn link_child(&mut self, parent: NodeId, child: NodeId) {
        let pos = match self.get(parent) {
            Some(p) => p.children.len(),
            None => return,
        };
        if let Some(p) = self.get_mut(parent) {
            p.children.push(child);
        }
        if let Some(c) = self.get_mut(child) {
            c.child_index = pos;
        }
    }

    // Rewrite child_index for every child of `parent` from its list position. Called after a removal,
    // which shifts the positions of the siblings that followed.
    fn reindex_children(&mut self, parent: NodeId) {
        let kids: Vec<NodeId> = match self.get(parent) {
            Some(p) => p.children.clone(),
            None => return,
        };
        for (i, &c) in kids.iter().enumerate() {
            if let Some(node) = self.get_mut(c) {
                node.child_index = i;
            }
        }
    }

    // ── element-tree navigation (all gen-checked: a stale edge is skipped, never followed) ──

    pub(crate) fn parent_of(&self, id: NodeId) -> Option<NodeId> {
        let parent = self.get(id)?.parent?;
        // Only report a parent whose slot still holds that gen — a stale upward edge (parent freed +
        // reused) reads as no parent, so the node matches as a detached root rather than under an alias.
        self.get(parent).map(|_| parent)
    }
    pub(crate) fn first_child(&self, id: NodeId) -> Option<NodeId> {
        let node = self.get(id)?;
        node.children.iter().copied().find(|&c| self.get(c).is_some())
    }
    pub(crate) fn prev_sibling(&self, id: NodeId) -> Option<NodeId> {
        let node = self.get(id)?;
        let parent = self.get(node.parent?)?;
        // Step back from this child's position, skipping any stale edge, to the nearest live sibling.
        // With no stale edges (the synced document tree) this is the single `child_index - 1` step.
        let mut i = node.child_index;
        while i > 0 {
            i -= 1;
            if let Some(&c) = parent.children.get(i) {
                if self.get(c).is_some() {
                    return Some(c);
                }
            }
        }
        None
    }
    pub(crate) fn next_sibling(&self, id: NodeId) -> Option<NodeId> {
        let node = self.get(id)?;
        let parent = self.get(node.parent?)?;
        let mut i = node.child_index + 1;
        while let Some(&c) = parent.children.get(i) {
            if self.get(c).is_some() {
                return Some(c);
            }
            i += 1;
        }
        None
    }
    // Whether `id` has any LIVE element child — `:empty` (with has_text) is correct even when a stale
    // edge lingers in `children`.
    pub(crate) fn has_element_child(&self, id: NodeId) -> bool {
        match self.get(id) {
            Some(node) => node.children.iter().any(|&c| self.get(c).is_some()),
            None => false,
        }
    }
    // Is `parent`'s live node the synthetic '#document' root? (used by the matcher's `:root`.)
    pub(crate) fn is_document(&self, id: NodeId) -> bool {
        self.get(id).is_some_and(|n| n.local_name == "#document")
    }
    // The live element children of `root`, for the matcher's descendant walk (preorder seed).
    pub(crate) fn element_children(&self, id: NodeId) -> Vec<NodeId> {
        match self.get(id) {
            Some(node) => node.children.iter().copied().filter(|&c| self.get(c).is_some()).collect(),
            None => Vec::new(),
        }
    }
    // A stable count for the matcher's cycle backstop (see selector::query).
    pub(crate) fn slot_count(&self) -> usize {
        self.slots.len()
    }
}

// The per-isolate DOM: ONE node arena PER REALM (keyed by rusty_racer's context_id — main = 0, frames
// 1,2,…) plus the isolate-scoped instance templates every wrapper is stamped from. Reached from any
// callback via dom(scope); the node ops route to their realm's arena by the context_id carried as
// each realm's `__dom` function data (see `realm_id` / `realm` / `install`). Templates serve every realm.
#[derive(Default)]
pub(crate) struct Dom {
    pub(crate) realms: std::collections::HashMap<i32, RealmArena>,
    // The store-flip's native-backed `_attrs`: a full named-interceptor view over a node's
    // attributes Vec (get/set/query/delete/enumerate/descriptor), so `el._attrs.foo`, `for..in`,
    // `hasOwnProperty`, `Object.keys`, `delete` all work against the arena in C++ — faster than a
    // JS Proxy and a faithful stand-in for the native-backed endgame.
    attrs_view_template: Option<v8::Global<v8::ObjectTemplate>>,
}

// Borrow the isolate's Dom, lazily creating the slot on first touch. rusty_v8
// stores slots in a TypeId->value map, so this `Dom` coexists with rusty_racer's
// own IsolateState slot without either knowing about the other. Used in SHORT
// bursts (the borrow is released before any V8 call), the same discipline
// rusty_racer's istate! macro follows — and, like it, the borrow checker enforces
// it: get_slot_mut borrows the scope, which every V8 call also needs.
fn dom<'s>(scope: &'s mut v8::PinScope<'_, '_>) -> &'s mut Dom {
    if scope.get_slot::<Dom>().is_none() {
        scope.set_slot(Dom::default());
    }
    scope
        .get_slot_mut::<Dom>()
        .expect("Dom slot was just set")
}

// The context_id of the realm whose `__dom` invoked this callback — carried as each realm's `__dom`
// function DATA (set in `install`), so a node op routes to its OWN realm's arena. `0` (main) when
// unset. This is how the isolate-global `Dom` is partitioned per realm without threading a realm id
// through the JS op signatures.
fn realm_id(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> i32 {
    args.data().int32_value(scope).unwrap_or(0)
}

// The arena for realm `cid` (created empty on first touch). The node ops resolve this from their
// function data instead of touching a single shared arena.
fn realm<'s>(scope: &'s mut v8::PinScope<'_, '_>, cid: i32) -> &'s mut RealmArena {
    dom(scope).realms.entry(cid).or_default()
}

// A NodeId argument off the JS wire: reads arg `i` as a Number and unpacks it, or None for a negative
// sentinel / non-number. Does NOT check liveness — the op does that via `realm(...).get(id)`.
fn nid_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, i: i32) -> Option<NodeId> {
    args.get(i).integer_value(scope).and_then(NodeId::from_i64)
}

// Set a NodeId return value as its packed JS Number.
fn set_nid(scope: &mut v8::PinScope<'_, '_>, rv: &mut v8::ReturnValue<'_, v8::Value>, id: NodeId) {
    rv.set(v8::Number::new(scope, id.to_f64()).into());
}

// Read a flat [name, value, name, value, …] attributes array into (attributes, attr_u16 override).
fn read_attrs_flat(scope: &mut v8::PinScope<'_, '_>, val: v8::Local<'_, v8::Value>) -> (Vec<(String, String)>, Vec<(String, Vec<u16>)>) {
    let mut attributes = Vec::new();
    let mut attr_u16: Vec<(String, Vec<u16>)> = Vec::new();
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(val) {
        let len = arr.length();
        let mut i = 0;
        while i + 1 < len {
            let name = arr.get_index(scope, i).map(|v| v.to_rust_string_lossy(scope));
            let value = arr.get_index(scope, i + 1);
            if let (Some(name), Some(value)) = (name, value) {
                let (utf8, u16) = read_v8_value(scope, value);
                if let Some(u) = u16 {
                    attr_u16.push((name.clone(), u));
                }
                attributes.push((name, utf8));
            }
            i += 2;
        }
    }
    (attributes, attr_u16)
}

// Install `globalThis.__dom` (the arena build / query / match surface + attrsView) into |ctx|, building
// the isolate-shared templates on first call. Mirrors install_host_namespace's shape (its own
// HandleScope + ContextScope, safe to re-run per realm — each realm gets its own function set carrying
// its context_id).
pub(crate) fn install(scope: &mut v8::PinScope<'_, '_, ()>, ctx: &v8::Global<v8::Context>, context_id: i32) {
    v8::scope!(let scope, &mut *scope);
    let context = v8::Local::new(scope, ctx);
    let scope = &mut v8::ContextScope::new(scope, context);

    ensure_templates(scope);

    // The arena for this realm is created lazily (realm(scope, cid) on first touch) and cleared per
    // page by resetArena, so a re-installed realm (main = context_id 0 on every reset) reuses its slot
    // rather than accumulating. Each op below carries `context_id` as its function data so it routes to
    // THIS realm's arena.
    let ns = v8::Object::new(scope);
    // Bulk import + id-level query: build the arena from an already-parsed page (importNode /
    // syncChildren) and match over it natively (queryIds / matchesId / matchesCompiled).
    register(scope, ns, "importNode", import_node, context_id);
    register(scope, ns, "queryIds", query_ids, context_id);
    register(scope, ns, "matchesId", matches_id, context_id);
    // Authoritative cascade matching: compile a rule's selector once to an integer handle, then match
    // by handle with no per-call string marshalling (compileSelector / matchesCompiled).
    register(scope, ns, "compileSelector", compile_selector, context_id);
    register(scope, ns, "matchesCompiled", matches_compiled, context_id);
    register(scope, ns, "resetArena", reset_arena, context_id);
    register(scope, ns, "nowNanos", now_nanos, context_id);
    // Incremental-sync primitives (the store-flip F1 foundation): keep the arena current
    // as the DOM mutates, instead of rebuilding it. syncChildren relinks one parent's
    // element children; setAttr/removeAttr mirror attribute writes.
    register(scope, ns, "syncChildren", sync_children, context_id);
    register(scope, ns, "setAttr", set_attr, context_id);
    register(scope, ns, "removeAttr", remove_attr, context_id);
    register(scope, ns, "syncAttrs", sync_attrs, context_id);
    // The store-flip's native-backed `_attrs`: __dom.attrsView(nid) -> an interceptor object over
    // that node's attributes (the Element constructor installs it in place of the JS `{}`).
    register(scope, ns, "attrsView", attrs_view, context_id);
    // Store flip: eager-create a node (importNode with no parent/attrs) at Element construction, then
    // fix its namespace once finalized (setNodeMeta) — the arena becomes the element's `_attrs` store.
    register(scope, ns, "setNodeMeta", set_node_meta, context_id);
    // Reclamation: free ONE node's slot when its JS wrapper is garbage-collected (the
    // FinalizationRegistry callback in native-query-shadow.js calls this), so a long no-navigation
    // session's transient/detached nodes don't accumulate. Safe by construction — the generational
    // slot bumps its gen, so any surviving reference reads absent.
    register(scope, ns, "dropNode", drop_node, context_id);
    // Free a disposed realm's arena — csim calls this before tearing down a frame realm (main reuses
    // slot 0). Takes an explicit id (the realm being dropped), not the caller's own.
    register(scope, ns, "dropRealm", drop_realm, context_id);
    // Native layout (reader-flip endgame, stage L1 = block flow): lay a subtree out from a flat buffer
    // of per-node used values in ONE crossing, writing a border-box per node into the arena; boxOf reads
    // one back for the JS geometry getters.
    register(scope, ns, "layoutPass", layout_pass, context_id);
    register(scope, ns, "boxOf", box_of, context_id);
    // Native text metrics (fontations) for native inline layout (L2): register a font (fontconfig path
    // or in-memory SFNT bytes) to a handle JS puts in the layout inputs; native measures runs in-process.
    register(scope, ns, "registerFontPath", register_font_path, context_id);
    register(scope, ns, "registerFontBytes", register_font_bytes, context_id);
    if let Some(key) = v8::String::new(scope, "__dom") {
        let global = context.global(scope);
        global.set(scope, key.into(), ns.into());
    }
}

// Register one `__dom.<name>` for a realm, carrying the realm's `context_id` as the function's DATA so
// `realm_id(scope, &args)` can route the op to that realm's arena (each realm gets its own `__dom` with
// its own functions, so the data is per-realm).
fn register(
    scope: &mut v8::PinScope<'_, '_>,
    ns: v8::Local<'_, v8::Object>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
    context_id: i32,
) {
    let data: v8::Local<v8::Value> = v8::Integer::new(scope, context_id).into();
    if let (Some(f), Some(k)) = (
        v8::Function::builder(callback).data(data).build(scope),
        v8::String::new(scope, name),
    ) {
        ns.set(scope, k.into(), f.into());
    }
}

// __dom.importNode(tagName, localName, ns, hasText, parentNid, attrsFlat) -> nid. Adds an arena
// node — the bulk path that builds the arena from an already-parsed document, and the per-element
// eager create at construction. `attrsFlat` is a flat [name, value, name, value, …] array;
// `parentNid` < 0 makes a root, else the node is appended to that (live) parent. `tagName` (arg 0) is
// accepted for call-site compatibility but not stored — the matcher works off the lowercased `localName`.
fn import_node(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let local_name = args.get(1).to_rust_string_lossy(scope);
    let ns = args.get(2).to_rust_string_lossy(scope);
    let has_text = args.get(3).boolean_value(scope);
    let parent = nid_arg(scope, &args, 4);
    let (attributes, attr_u16) = read_attrs_flat(scope, args.get(5));
    let cid = realm_id(scope, &args);
    let st = realm(scope, cid);
    // Only link under a still-live parent; a stale parent nid leaves the node a detached root.
    let parent = parent.filter(|&p| st.get(p).is_some());
    let new_id = st.alloc(NodeData {
        local_name,
        ns,
        attributes,
        attr_u16,
        parent,
        children: Vec::new(),
        child_index: 0,
        has_text,
        layout_box: None,
    });
    if let Some(p) = parent {
        st.link_child(p, new_id);
    }
    set_nid(scope, &mut rv, new_id);
}

// __dom.syncChildren(parentNid, childNids, hasText): make parentNid's element children EXACTLY
// `childNids` (in document order) and set its has_text (whether it has non-empty text content).
// Each child is detached from any current parent first, so a MOVED node — still listed under its
// old parent until that parent is itself synced — is re-homed correctly whichever order the two
// syncs arrive in. The single structural-sync primitive the incremental (parse + mutation) arena
// upkeep drives, replacing the shadow path's full rebuild. New nodes are created with
// importNode(parent = -1) first, then linked here.
fn sync_children(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(parent) = nid_arg(scope, &args, 0) else {
        return;
    };
    let has_text = args.get(2).boolean_value(scope);
    let mut raw: Vec<NodeId> = Vec::new();
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(args.get(1)) {
        for i in 0..arr.length() {
            if let Some(id) = arr.get_index(scope, i).and_then(|v| v.integer_value(scope)).and_then(NodeId::from_i64) {
                raw.push(id);
            }
        }
    }
    let cid = realm_id(scope, &args);
    let st = realm(scope, cid);
    if st.get(parent).is_none() {
        return;
    }
    // Sanitize the delta: keep only LIVE children (a stale id would plant a dangling edge), drop the
    // parent itself (a self-cycle) and duplicates (a node can't be its own sibling), preserving order.
    // The matcher assumes an ACYCLIC tree; these cheap checks kill the footguns a malformed delta could
    // plant. A transient ANCESTOR inversion during a multi-parent move (child re-homed before its old
    // parent is re-synced) is legitimate and self-heals, so it is NOT rejected here — the invariant is
    // "mirror an acyclic tree and sync every affected parent before the next query."
    let mut seen: std::collections::HashSet<NodeId> = std::collections::HashSet::with_capacity(raw.len());
    let mut kids: Vec<NodeId> = Vec::with_capacity(raw.len());
    for &k in &raw {
        if k != parent && st.get(k).is_some() && seen.insert(k) {
            kids.push(k);
        }
    }
    // Detach each incoming child from a DIFFERENT current parent (a same-parent reorder skips this).
    for &k in &kids {
        let old = st.get(k).and_then(|node| node.parent);
        if old != Some(parent) {
            if let Some(op) = old {
                if let Some(o) = st.get_mut(op) {
                    o.children.retain(|&c| c != k);
                }
                st.reindex_children(op);
            }
            if let Some(kn) = st.get_mut(k) {
                kn.parent = Some(parent);
            }
        }
    }
    // Null the .parent of children DROPPED from this parent (were here, gone now, still pointing
    // here). Otherwise a detached subtree keeps a phantom upward chain and an element-rooted query
    // inside it could match an ancestor it no longer has. A child that MOVED to another parent was
    // already retained-out above, so it isn't in the old list here; only truly-dropped ones are nulled
    // (and a later syncChildren re-homing one re-sets its parent).
    let dropped: Vec<NodeId> = match st.get(parent) {
        Some(p) => p.children.iter().copied().filter(|c| !seen.contains(c)).collect(),
        None => Vec::new(),
    };
    for d in dropped {
        if st.get(d).and_then(|node| node.parent) == Some(parent) {
            if let Some(dn) = st.get_mut(d) {
                dn.parent = None;
            }
        }
    }
    if let Some(p) = st.get_mut(parent) {
        p.children = kids;
        p.has_text = has_text;
    }
    st.reindex_children(parent);
}

// __dom.setAttr(nodeNid, name, value) / __dom.removeAttr(nodeNid, name): mirror an attribute write
// into the arena. Names arrive already lowercased for HTML (the JS side passes the stored key).
fn set_attr(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let name = args.get(1).to_rust_string_lossy(scope);
    let (utf8, u16) = read_v8_value(scope, args.get(2));
    let cid = realm_id(scope, &args);
    if let Some(node) = realm(scope, cid).get_mut(id) {
        node.set_attr_full(&name, utf8, u16);
    }
}

fn remove_attr(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let name = args.get(1).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    if let Some(node) = realm(scope, cid).get_mut(id) {
        node.attributes.retain(|(k, _)| k != &name);
        node.clear_attr_u16(&name);
    }
}

// __dom.syncAttrs(nodeNid, attrsFlat): replace a node's attributes with the flat [name, value, …]
// list wholesale. The mutation hook mirrors an element's current _attrs on any attribute change —
// wholesale (attrs per element are few) so it can't drift on attribute-name CASE (the arena keys
// then match the initial mirror exactly, both taken from the same _attrs iteration).
fn sync_attrs(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let (attributes, attr_u16) = read_attrs_flat(scope, args.get(1));
    let cid = realm_id(scope, &args);
    if let Some(node) = realm(scope, cid).get_mut(id) {
        node.attributes = attributes;
        node.attr_u16 = attr_u16;
    }
}

// __dom.queryIds(rootNid, selector) -> [nid, …] when native matching answers the selector;
// `undefined` when it needs the JS engine (a live-state selector like `:hover` / `:checked`);
// `null` for an invalid selector. Returns nids (not wrappers) so the query layer can map
// results back to the JS tree cheaply, and lets it distinguish "defer to css-select" (undefined)
// from "SyntaxError" (null) — this is the shape the host-query layer uses.
fn query_ids(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(root) = nid_arg(scope, &args, 0) else {
        return;
    };
    let selector = args.get(1).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    match crate::selector::query_text(realm(scope, cid), root, &selector, false) {
        crate::selector::QueryOutcome::Matched(ids) => {
            let array = v8::Array::new(scope, ids.len() as i32);
            for (i, id) in ids.iter().enumerate() {
                let v: v8::Local<v8::Value> = v8::Number::new(scope, id.to_f64()).into();
                array.set_index(scope, i as u32, v);
            }
            rv.set(array.into());
        }
        crate::selector::QueryOutcome::NeedsJsFallback => {
            let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
            rv.set(undef);
        }
        crate::selector::QueryOutcome::Invalid => rv.set_null(),
    }
}

// __dom.matchesId(nodeNid, selector) -> bool when native matching answers it; `undefined` when it
// needs the JS engine (a live-state selector / pseudo-element); `null` for an invalid selector. The
// single-element match the cascade uses (does this element match this rule?), distinct from queryIds'
// descendant search.
fn matches_id(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let selector = args.get(1).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    match crate::selector::matches_text(realm(scope, cid), id, &selector) {
        crate::selector::QueryOutcome::Matched(ids) => rv.set_bool(!ids.is_empty()),
        crate::selector::QueryOutcome::NeedsJsFallback => {
            let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
            rv.set(undef);
        }
        crate::selector::QueryOutcome::Invalid => rv.set_null(),
    }
}

// __dom.compileSelector(text) -> handle. The authoritative cascade path calls this ONCE per rule and
// caches the integer, then matches by handle (matchesCompiled) with no per-call string marshalling.
// `>= 0` = a natively-matchable compiled selector; `-1` = invalid or needs JS fallback → use css.
fn compile_selector(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let text = args.get(0).to_rust_string_lossy(scope);
    rv.set_int32(crate::selector::compile_selector(&text));
}

// __dom.matchesCompiled(nid, handle) -> bool, or undefined when the handle/node is out of range so the
// caller falls back to css. The per-match hot path of authoritative cascade matching: a nid + an
// integer handle, no string.
fn matches_compiled(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let handle = match args.get(1).integer_value(scope) {
        Some(h) => h as i32,
        _ => return,
    };
    let cid = realm_id(scope, &args);
    if let Some(hit) = crate::selector::matches_compiled(realm(scope, cid), id, handle) {
        rv.set_bool(hit);
    }
}

// __dom.resetArena() — free the CALLING REALM's nodes for a new page (a navigation). Each occupied
// slot's gen is bumped (not zeroed), so a detached element held across the navigation can't alias a
// new-page node that reuses its index; the freed indices feed the new page.
fn reset_arena(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let cid = realm_id(scope, &args);
    realm(scope, cid).reset();
}

// __dom.setNodeMeta(nid, localName, ns) — update a node's localName + namespace after creation. The
// store flip eager-creates arena nodes in the Element ctor, where `_ns` is still the HTML default;
// createElementNS / parser foreign content finalize a non-HTML namespace AFTER construction and call
// this so the arena node's namespace matching is correct.
fn set_node_meta(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let local_name = args.get(1).to_rust_string_lossy(scope);
    let ns = args.get(2).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    if let Some(node) = realm(scope, cid).get_mut(id) {
        node.local_name = local_name;
        node.ns = ns;
    }
}

// __dom.dropNode(nid) — free ONE node's slot (its JS wrapper was garbage-collected). Routes to the
// CALLING realm's arena (the FinalizationRegistry that fires it was created in that realm). Idempotent
// and safe against a stale nid (a slot resetArena already recycled): free_node no-ops on a gen mismatch.
fn drop_node(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let cid = realm_id(scope, &args);
    // NON-creating lookup on purpose: a frame's FR cleanup can fire AFTER dropRealm removed its arena.
    // `realm()` would resurrect an empty RealmArena (a lingering HashMap entry per such frame); freeing
    // nothing from a dropped realm is exactly right, so skip when the realm is gone.
    if let Some(arena) = dom(scope).realms.get_mut(&cid) {
        arena.free_node(id);
    }
}

// __dom.dropRealm(id) — free realm `id`'s arena entirely (not the caller's own). csim calls this as it
// disposes a frame realm, so a page's frame arenas don't accumulate across visits. Main (id 0) is not
// dropped — it reuses its slot across resets, cleared per page by resetArena.
fn drop_realm(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    if let Some(id) = args.get(0).integer_value(scope) {
        dom(scope).realms.remove(&(id as i32));
    }
}

// __dom.registerFontPath(path) -> handle (>=0), or -1 when the file can't be read/parsed. The host
// resolved `path` via fontconfig; native parses it (skrifa) into an advance table, cached.
fn register_font_path(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let path = args.get(0).to_rust_string_lossy(scope);
    rv.set_int32(crate::font::register_path(&path));
}

// __dom.registerFontBytes(uint8array) -> handle. In-memory SFNT bytes for a web / buffer face the host
// already fetched + decoded. -1 for anything but a Uint8Array.
fn register_font_bytes(
    _scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    if let Ok(ta) = v8::Local::<v8::Uint8Array>::try_from(args.get(0)) {
        let mut buf = vec![0u8; ta.byte_length()];
        ta.copy_contents(&mut buf);
        rv.set_int32(crate::font::register_bytes(&buf));
    } else {
        rv.set_int32(-1);
    }
}

// Fields per node in the layoutPass input buffer, and per run in the runs buffer (flat Float64Arrays).
// Order MUST match the JS packer (layout.js `__csimLayoutShadowRun`) and layout::Input / layout::Run.
const LAYOUT_STRIDE: usize = 68;
const RUN_STRIDE: usize = 8;

// Decode a V8 Float64Array argument into a Vec<f64> (native-endian raw bytes).
fn read_f64_array(val: v8::Local<'_, v8::Value>) -> Vec<f64> {
    let Ok(arr) = v8::Local::<v8::Float64Array>::try_from(val) else {
        return Vec::new();
    };
    let mut bytes = vec![0u8; arr.length() * 8];
    arr.copy_contents(&mut bytes);
    bytes.chunks_exact(8).map(|c| f64::from_ne_bytes(c.try_into().unwrap())).collect()
}

// __dom.layoutPass(inputsFlat, runsFlat, runTexts, rootX, rootY, rootCbW) -> bool. Decode the flat
// per-node record buffer (root at record 0), the per-run buffer, and the parallel `runTexts` string
// array (a run's text, else non-string), run native layout, and write each node's border-box into its
// arena slot. Returns false when the subtree uses a feature the native engine doesn't model
// (Outcome::Unsupported) — the caller then lays it out in JS. One crossing per pass.
fn layout_pass(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let node_floats = read_f64_array(args.get(0));
    if node_floats.is_empty() {
        rv.set_bool(false);
        return;
    }
    let mut inputs: Vec<crate::layout::Input> = Vec::with_capacity(node_floats.len() / LAYOUT_STRIDE);
    for r in node_floats.chunks_exact(LAYOUT_STRIDE) {
        inputs.push(crate::layout::Input {
            nid: r[0],
            parent: r[1] as i32,
            display: r[2] as u8,
            border_box: r[3] != 0.0,
            width: r[4],
            height: r[5],
            min_w: r[6],
            max_w: r[7],
            min_h: r[8],
            max_h: r[9],
            mt: r[10],
            mr: r[11],
            mb: r[12],
            ml: r[13],
            pt: r[14],
            pr: r[15],
            pb: r[16],
            pl: r[17],
            bt: r[18],
            br: r[19],
            bb: r[20],
            bl: r[21],
            run_start: r[22] as i32,
            run_count: r[23] as i32,
            strut_lh: r[24],
            height_adjoins: r[25] != 0.0,
            minh_adjoins: r[26] != 0.0,
            strut_asc: r[27],
            float_kind: r[28] as u8,
            clear: r[29] as u8,
            starts_bfc: r[30] != 0.0,
            flex_justify: r[31] as u8,
            flex_main_gap: r[32],
            flex_cross_align: r[33] as u8,
            flex_main_is_x: r[34] != 0.0,
            flex_wrap: r[35] != 0.0,
            flex_align_content: r[36] as u8,
            flex_cross_gap: r[37],
            flex_main_reverse: r[38] != 0.0,
            rel_x: r[39],
            rel_y: r[40],
            flex_item_auto: r[41] as u8,
            flex_baseline_asc: r[42],
            out_of_flow: r[43] as u8,
            sp_x: r[44],
            sp_y: r[45],
            cell_col: r[46] as usize,
            cell_colspan: r[47] as usize,
            cell_rowspan: r[48] as usize,
            caption_side: r[49] as u8,
            rtl: r[50] as u8,
            cell_va_offset: r[51],
            anon_cross: r[52],
            ws_mode: r[53] as u8,
            item_auto_height: r[54] != 0.0,
            grid_start: r[55] as i32,
            decl_w: r[56],
            decl_min_w: r[57],
            decl_max_w: r[58],
            flex_basis: r[59],
            flex_grow: r[60],
            decl_border_box: r[61] != 0.0,
            flex_shrink: r[62],
            flex_basis_cb: r[63],
            flex_basis_kw: r[64] as u8,
            scrolls_x: (r[65] as u32) & 1 != 0,
            scrolls_y: (r[65] as u32) & 2 != 0,
            flex_dir_reverse: (r[65] as u32) & 4 != 0,
            flex_stretch: r[66] != 0.0,
            flex_native: r[67] != 0.0,
        });
    }
    let run_floats = read_f64_array(args.get(1));
    let mut runs: Vec<crate::layout::Run> = Vec::with_capacity(run_floats.len() / RUN_STRIDE);
    for r in run_floats.chunks_exact(RUN_STRIDE) {
        runs.push(crate::layout::Run { kind: r[0] as u8, font: r[1] as i32, size: r[2], ls: r[3], ws: r[4], line_height: r[5], asc: r[7], metric: r[6] });
    }
    // Parallel run-text channel: run_texts[r] = run r's text (a string), read as UTF-16 to iterate
    // exactly as JS does. Done before any arena borrow.
    let mut run_texts: Vec<Option<Vec<u16>>> = Vec::with_capacity(runs.len());
    if let Ok(tarr) = v8::Local::<v8::Array>::try_from(args.get(2)) {
        for i in 0..tarr.length() {
            match tarr.get_index(scope, i) {
                Some(val) if val.is_string() => {
                    let s = val.to_string(scope).unwrap();
                    let mut u = vec![0u16; s.length()];
                    s.write_v2(scope, 0, &mut u, v8::WriteFlags::empty());
                    run_texts.push(Some(u));
                }
                _ => run_texts.push(None),
            }
        }
    }
    let root_x = args.get(3).number_value(scope).unwrap_or(0.0);
    let root_y = args.get(4).number_value(scope).unwrap_or(0.0);
    let root_cb_w = args.get(5).number_value(scope).unwrap_or(0.0);
    // Parallel grid channel: a computed grid container's `grid_start` indexes this buffer (parsed column
    // template + gaps + per-item placement). Empty when the pass has no computed grid.
    let grids = read_f64_array(args.get(6));
    match crate::layout::layout_block(&inputs, &runs, &run_texts, &grids, root_x, root_y, root_cb_w) {
        crate::layout::Outcome::Unsupported => rv.set_bool(false),
        crate::layout::Outcome::LaidOut(boxes) => {
            let cid = realm_id(scope, &args);
            let st = realm(scope, cid);
            for b in boxes {
                if let Some(id) = NodeId::from_i64(b.nid as i64) {
                    if let Some(node) = st.get_mut(id) {
                        node.layout_box = Some(b);
                    }
                }
            }
            rv.set_bool(true);
        }
    }
}

// __dom.boxOf(nid) -> [x, y, w, h, autoHeight] (document coords, border-box) or undefined when the node
// has no native box (never laid out this pass / stale nid). The JS geometry getters read this.
fn box_of(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let cid = realm_id(scope, &args);
    let b = match realm(scope, cid).get(id).and_then(|node| node.layout_box) {
        Some(b) => b,
        None => return,
    };
    let arr = v8::Array::new(scope, 5);
    let vals = [b.x, b.y, b.w, b.h, if b.auto_height { 1.0 } else { 0.0 }];
    for (i, v) in vals.iter().enumerate() {
        let num: v8::Local<v8::Value> = v8::Number::new(scope, *v).into();
        arr.set_index(scope, i as u32, num);
    }
    rv.set(arr.into());
}

// __dom.nowNanos() -> a process-monotonic wall time in nanoseconds (as a Number).
// The measurement path times native matching against css-select from INSIDE JS, but
// csim's own clock (Date.now / performance.now) is the VIRTUAL event-loop clock,
// frozen for the whole of a synchronous JS turn — so it can't separate the two.
// This is a REAL monotonic clock, exposed only for the shadow-measurement harness
// (not a web API). Anchored to the first call so the value stays a small integer that
// an f64 represents exactly (nanos fit exactly below 2^53 ≈ 104 days of uptime).
fn now_nanos(
    scope: &mut v8::PinScope<'_, '_>,
    _args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    static ORIGIN: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let origin = ORIGIN.get_or_init(std::time::Instant::now);
    let ns = origin.elapsed().as_nanos() as f64;
    rv.set(v8::Number::new(scope, ns).into());
}

// Build the native-backed `_attrs` instance template once per isolate. Reserves internal field 0 for
// the owner nid (packed) and field 1 for its realm's context_id (attrsView stamps both), so the
// interceptors resolve the RIGHT realm's arena and the RIGHT node generation — the template is
// isolate-shared but its instances are per realm.
fn ensure_templates(scope: &mut v8::PinScope<'_, '_>) {
    if dom(scope).attrs_view_template.is_none() {
        let tmpl = v8::ObjectTemplate::new(scope);
        tmpl.set_internal_field_count(2);
        tmpl.set_named_property_handler(
            v8::NamedPropertyHandlerConfiguration::new()
                .getter(attrs_get)
                .setter(attrs_set)
                .query(attrs_query)
                .deleter(attrs_delete)
                .enumerator(attrs_enumerate)
                .descriptor(attrs_descriptor),
        );
        let global = v8::Global::new(scope, tmpl);
        dom(scope).attrs_view_template = Some(global);
    }
}

// ── native-backed _attrs (store flip): a full named-interceptor view over a node's attributes ──
// The Element constructor installs one of these in place of the JS `_attrs` object, so every
// `el._attrs.foo` / `el._attrs[k]=v` / `k in el._attrs` / `delete` / `for..in` / `Object.keys` /
// `hasOwnProperty` runs against the arena in C++. Keys are matched EXACTLY (the JS side already
// lowercases HTML attribute names before storing), and enumeration returns them in insertion
// (Vec) order — the serialization / NamedNodeMap order contract.

fn attrs_view(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let cid = realm_id(scope, &args);
    let Some(template) = dom(scope).attrs_view_template.clone() else {
        return;
    };
    let template = v8::Local::new(scope, &template);
    if let Some(obj) = template.new_instance(scope) {
        let id_value: v8::Local<v8::Value> = v8::Number::new(scope, id.to_f64()).into();
        obj.set_internal_field(0, id_value.into());
        let cid_value: v8::Local<v8::Value> = v8::Integer::new(scope, cid).into();
        obj.set_internal_field(1, cid_value.into());
        rv.set(obj.into());
    }
}

// A string property key, or None for a Symbol (which falls through to normal lookup so the
// attrs-view's prototype methods — hasOwnProperty etc. — still resolve).
fn name_string(scope: &mut v8::PinScope<'_, '_>, key: v8::Local<'_, v8::Name>) -> Option<String> {
    let key: v8::Local<v8::Value> = key.into();
    if !key.is_string() {
        return None;
    }
    Some(key.to_rust_string_lossy(scope))
}

fn attrs_get(
    scope: &mut v8::PinScope<'_, '_>,
    key: v8::Local<'_, v8::Name>,
    args: v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) -> v8::Intercepted {
    let Some(id) = holder_node_id(scope, &args) else {
        return v8::Intercepted::kNo;
    };
    let cid = holder_realm_id(scope, &args);
    let Some(name) = name_string(scope, key) else {
        return v8::Intercepted::kNo;
    };
    // Prefer the lossless UTF-16 override (a value that carried a lone surrogate); else the UTF-8. Clone
    // the chosen representation out of the node borrow so the V8 string can be built with the scope after.
    let value: Option<Result<Vec<u16>, String>> = realm(scope, cid).get(id).and_then(|n| {
        match n.get_attr_u16(&name) {
            Some(u) => Some(Ok(u.to_vec())),
            None => n.get_attr(&name).map(|v| Err(v.to_string())),
        }
    });
    match value {
        Some(Ok(u)) => {
            if let Some(js) = v8::String::new_from_two_byte(scope, &u, v8::NewStringType::Normal) {
                rv.set(js.into());
            }
            v8::Intercepted::kYes
        }
        Some(Err(v)) => {
            if let Some(js) = v8::String::new(scope, &v) {
                rv.set(js.into());
            }
            v8::Intercepted::kYes
        }
        None => v8::Intercepted::kNo,
    }
}

fn attrs_set(
    scope: &mut v8::PinScope<'_, '_>,
    key: v8::Local<'_, v8::Name>,
    value: v8::Local<'_, v8::Value>,
    args: v8::PropertyCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, ()>,
) -> v8::Intercepted {
    let Some(id) = holder_node_id(scope, &args) else {
        return v8::Intercepted::kNo;
    };
    let cid = holder_realm_id(scope, &args);
    let Some(name) = name_string(scope, key) else {
        return v8::Intercepted::kNo;
    };
    let (utf8, u16) = read_v8_value(scope, value);
    if let Some(node) = realm(scope, cid).get_mut(id) {
        node.set_attr_full(&name, utf8, u16);
    }
    v8::Intercepted::kYes
}

fn attrs_query(
    scope: &mut v8::PinScope<'_, '_>,
    key: v8::Local<'_, v8::Name>,
    args: v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Integer>,
) -> v8::Intercepted {
    let Some(id) = holder_node_id(scope, &args) else {
        return v8::Intercepted::kNo;
    };
    let cid = holder_realm_id(scope, &args);
    let Some(name) = name_string(scope, key) else {
        return v8::Intercepted::kNo;
    };
    let present = realm(scope, cid).get(id).is_some_and(|n| n.get_attr(&name).is_some());
    if present {
        // PropertyAttribute::NONE (0) = enumerable + writable + configurable.
        rv.set_uint32(0);
        v8::Intercepted::kYes
    } else {
        v8::Intercepted::kNo
    }
}

fn attrs_delete(
    scope: &mut v8::PinScope<'_, '_>,
    key: v8::Local<'_, v8::Name>,
    args: v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Boolean>,
) -> v8::Intercepted {
    let Some(id) = holder_node_id(scope, &args) else {
        return v8::Intercepted::kNo;
    };
    let cid = holder_realm_id(scope, &args);
    let Some(name) = name_string(scope, key) else {
        return v8::Intercepted::kNo;
    };
    if let Some(node) = realm(scope, cid).get_mut(id) {
        node.attributes.retain(|(k, _)| k != &name);
        node.clear_attr_u16(&name);
    }
    rv.set_bool(true);
    v8::Intercepted::kYes
}

fn attrs_enumerate(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Array>,
) {
    let Some(id) = holder_node_id(scope, &args) else {
        return;
    };
    let cid = holder_realm_id(scope, &args);
    let names: Vec<String> = realm(scope, cid)
        .get(id)
        .map(|n| n.attributes.iter().map(|(k, _)| k.clone()).collect())
        .unwrap_or_default();
    let array = v8::Array::new(scope, names.len() as i32);
    for (i, name) in names.iter().enumerate() {
        if let Some(js) = v8::String::new(scope, name) {
            array.set_index(scope, i as u32, js.into());
        }
    }
    rv.set(array);
}

fn attrs_descriptor(
    scope: &mut v8::PinScope<'_, '_>,
    key: v8::Local<'_, v8::Name>,
    args: v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) -> v8::Intercepted {
    let Some(id) = holder_node_id(scope, &args) else {
        return v8::Intercepted::kNo;
    };
    let cid = holder_realm_id(scope, &args);
    let Some(name) = name_string(scope, key) else {
        return v8::Intercepted::kNo;
    };
    let value: Option<Result<Vec<u16>, String>> = realm(scope, cid).get(id).and_then(|n| {
        match n.get_attr_u16(&name) {
            Some(u) => Some(Ok(u.to_vec())),
            None => n.get_attr(&name).map(|v| Err(v.to_string())),
        }
    });
    match value {
        Some(rep) => {
            // A data descriptor consistent with the enumerator: enumerable + writable + configurable,
            // so Object.keys / hasOwnProperty / Object.assign see a valid own property (V8 invariant). The
            // value round-trips losslessly (the UTF-16 override wins over the lossy UTF-8 when present).
            let desc = v8::Object::new(scope);
            let vstr = match rep {
                Ok(u) => v8::String::new_from_two_byte(scope, &u, v8::NewStringType::Normal),
                Err(s) => v8::String::new(scope, &s),
            };
            if let (Some(k), Some(v)) = (v8::String::new(scope, "value"), vstr) {
                desc.set(scope, k.into(), v.into());
            }
            desc_set_bool(scope, desc, "writable", true);
            desc_set_bool(scope, desc, "enumerable", true);
            desc_set_bool(scope, desc, "configurable", true);
            rv.set(desc.into());
            v8::Intercepted::kYes
        }
        None => v8::Intercepted::kNo,
    }
}

fn desc_set_bool(scope: &mut v8::PinScope<'_, '_>, obj: v8::Local<'_, v8::Object>, key: &str, value: bool) {
    if let Some(k) = v8::String::new(scope, key) {
        let b = v8::Boolean::new(scope, value);
        obj.set(scope, k.into(), b.into());
    }
}

// ── NodeId plumbing ─────────────────────────────────────────────────────────

// The NodeId packed into the accessor holder's internal field 0.
fn holder_node_id(
    scope: &mut v8::PinScope<'_, '_>,
    args: &v8::PropertyCallbackArguments<'_>,
) -> Option<NodeId> {
    let data = args.holder().get_internal_field(scope, 0)?;
    let value = v8::Local::<v8::Value>::try_from(data).ok()?;
    NodeId::from_i64(value.integer_value(scope)?)
}

// The realm context_id stamped into the holder's internal field 1 (attrsView), so the interceptor
// reads the OWNER realm's arena. Defaults to 0 (main) if absent.
fn holder_realm_id(scope: &mut v8::PinScope<'_, '_>, args: &v8::PropertyCallbackArguments<'_>) -> i32 {
    args.holder()
        .get_internal_field(scope, 1)
        .and_then(|d| v8::Local::<v8::Value>::try_from(d).ok())
        .and_then(|v| v.int32_value(scope))
        .unwrap_or(0)
}
