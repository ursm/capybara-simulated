// Native DOM: the isolate's node arena the native readers — selector matching, the style engine, the layout walk,
// XPath — read.
//
// Lives in capybara-simulated's OWN native extension (not in rusty_racer, which stays a pure V8
// binding). rusty_racer is linked as a library and exposes one generic seam — set_realm_init_hook —
// which calls `install` in every realm. State lives in the isolate's own TypeId-keyed slot (`Dom`,
// reached via `dom(scope)`), independent of rusty_racer's IsolateState.
//
// `Dom` holds ONE `RealmArena` for every realm's nodes, with each realm's own state (keyed by rusty_racer's
// context_id; see `install` / `realm`). The JS side (native-query-shadow.js) builds
// the arena's copy of a document (importNode + syncChildren) and keeps it current at the DOM
// mutation seams; the Servo `selectors` matcher (selector.rs), the style engine (style.rs) and the layout
// walk (walk.rs) read a RealmArena directly. The store stays in JS; the arena is its READER copy.
//
// GENERATIONAL ARENA. A node lives in a SLOT (`Vec<Slot>`); a slot carries a `gen` counter and, when
// free, an empty `data`. A `NodeId` is a `(index, gen)` pair — and so is every INTERNAL edge
// (`parent` / `children`). Freeing a node bumps its slot's gen and lists the index for reuse; a later
// `importNode` hands the recycled index a fresh gen. The point: a STALE edge (a `children` entry left
// pointing at an index whose node was since freed + the slot reused — the class of bug the DOM has
// ~30 unsynced `_children` splice sites that can plant) carries the OLD gen, so following it
// gen-mismatches and is SKIPPED rather than aliasing the new occupant. That converts the silent
// tree corruption naive index-reuse caused (proven on Avo) into safe, self-healing behaviour, which
// is what lets a collected node's slot be reclaimed (its handle's, node_handle.rs) and bounds arena
// growth in a long no-navigation session. See native-query-shadow.js for the JS lifecycle.
//
// The `nid` that crosses the FFI is the `(index, gen)` pair PACKED into one JS Number (index in the
// low `INDEX_BITS`, gen above — both fit exactly under 2^53); JS treats it as an opaque token and only
// hands it back. `attrsView(nid)` is the native-backed `_attrs` (a named interceptor over a node's
// attributes Vec), installed by the Element constructor in place of the JS `{}`.

use std::borrow::Cow;
use style::Atom;
use web_atoms::{ns, LocalName, Namespace};

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
    pub(crate) fn to_f64(self) -> f64 {
        (((self.generation as i64) << INDEX_BITS) | (self.idx as i64)) as f64
    }
    // Unpack a non-negative wire value; a negative value (the JS `-1` "no node" sentinel) is None.
    pub(crate) fn from_i64(n: i64) -> Option<NodeId> {
        if n < 0 {
            return None;
        }
        Some(NodeId {
            idx: (n & INDEX_MASK) as u32,
            generation: (n >> INDEX_BITS) as u32,
        })
    }
}

// What kind of DOM node an arena node mirrors — the arena holds EVERY node of every tree (documents, fragments and
// shadow roots, text and comments as well as elements), so a native reader sees the tree a script sees. The element
// navigation (first child / siblings / element children) steps over the rest.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum NodeKind {
    Element,
    // Text and CDATA sections: character data that counts as content (`:empty`, text runs).
    Text,
    // Comments: character data that does not.
    Comment,
    // A processing instruction: character data that does not either, with its target in `local_name`.
    ProcessingInstruction,
    Document,
    // A DocumentFragment — a shadow root included.
    Fragment,
    // A doctype: a child of a document and nothing else.
    Other,
}

impl NodeKind {
    // From the DOM `nodeType`.
    fn from_node_type(t: i64) -> NodeKind {
        match t {
            1 => NodeKind::Element,
            3 | 4 => NodeKind::Text,
            7 => NodeKind::ProcessingInstruction,
            8 => NodeKind::Comment,
            9 => NodeKind::Document,
            11 => NodeKind::Fragment,
            _ => NodeKind::Other,
        }
    }
}

// Where one node is against another in their node tree (`RealmArena::relation`): the same node, an ancestor of it, a
// descendant of it, or before or after it otherwise.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Relation {
    Same,
    Ancestor,
    Descendant,
    Before,
    After,
}

// An attribute of the DOM's attribute list (`NodeData::attribute_list`): its namespace, prefix, local name and value.
pub(crate) struct Attribute {
    pub(crate) ns: Option<String>,
    pub(crate) prefix: Option<String>,
    pub(crate) local: String,
    pub(crate) value: Vec<u16>,
}

// One arena node's data: what the native readers see. Attributes are the source of truth
// (ordered, as the DOM keeps them); for a non-element, `local_name` / `ns` / the attributes are empty.
pub(crate) struct NodeData {
    pub(crate) kind: NodeKind,
    // The character data of a Text / Comment node (empty for any other), as the DOM holds it: UTF-16 code units, a lone
    // surrogate included.
    pub(crate) data: Vec<u16>,
    // An element's local name (`localName`: a case-preserved SVG `foreignObject` stays so) and namespace (the empty
    // one for an element in no namespace), interned — what every matcher compares.
    pub(crate) local_name: LocalName,
    pub(crate) ns: Namespace,
    // An element's namespace prefix (`prefix`; None for none) — fixed at creation.
    pub(crate) prefix: Option<Box<str>>,
    // …and, for the rare element whose namespace or prefix carries a LONE SURROGATE (U+FFFD in the two above), both
    // exactly, as UTF-16 — what a namespace lookup compares (`ns_units`, `prefix_units`).
    pub(crate) name_u16: Option<Box<(Vec<u16>, Option<Vec<u16>>)>>,
    pub(crate) attributes: Vec<(String, String)>,
    // Lossless override for the rare attribute value that carries a LONE SURROGATE (unpaired U+D800..
    // U+DFFF) — valid in a JS DOMString (UTF-16) but not in Rust's UTF-8 `String`, where it degrades to
    // U+FFFD. The selector matcher reads `attributes` (the lossy UTF-8) — a lone surrogate can't appear in
    // a spec-parsed selector anyway (an escape resolves to U+FFFD), so matching is unaffected — but the
    // attrsView GETTER must return exactly what was written (getAttribute identity), so it
    // reads the original UTF-16 units from here when present. Empty for virtually every element; only the
    // value that actually lost data lands here, keyed by attribute name.
    pub(crate) attr_u16: Vec<(String, Vec<u16>)>,
    // The namespace and local name of each attribute that HAS a namespace, by its store key (a qualified name, or the
    // JS side's synthetic key for an unprefixed one): (key, namespace URL, local name). Empty for virtually every
    // element — every other attribute is in no namespace, named by its key.
    pub(crate) attr_ns: Vec<(String, String, String)>,
    // …and, for the rare one whose namespace or local name carries a lone surrogate, both exactly: (key, namespace, local
    // name) as UTF-16.
    pub(crate) attr_ns_u16: Vec<(String, Vec<u16>, Vec<u16>)>,
    pub(crate) parent: Option<NodeId>,
    pub(crate) children: Vec<NodeId>,
    // Where it is in `parent.children`: its index there plus the parent's `first_position` (`NodeData::index_in`,
    // `RealmArena::child_index`) — kept current on every link/unlink, so the selector engine's prev/next-sibling nav is
    // O(1) — without it `:nth-child` is O(n²) per query on a wide parent (a 500-sibling list measured 2.5x slower than
    // the JS matcher it replaced; O(1) flips it). It counts ALL entries (a stale edge included), so the sibling walks
    // step from it and skip any stale neighbour they land on. Positions order siblings as their indexes do.
    pub(crate) position: i64,
    // …and, for a parent, the position its first child has: a child taken from or put at the FRONT moves this rather
    // than every sibling's (a `while (el.firstChild) el.removeChild(el.firstChild)` over 20,000 children was quadratic).
    pub(crate) first_position: i64,
    // The box the last layout pass that laid this node out gave it (`geometry::store_layout`) — KEPT by a pass that lays
    // it out no longer, which `laid_at` tells apart. None until a pass lays it out.
    pub(crate) layout_box: Option<crate::layout::Box>,
    // …or, for an INLINE box, which no record lays out, the FRAGMENTS the lines broke it into, `[x, y, w, h]` each
    // (`geometry::store_layout`); None for any other node. A node has one or the other, as the last pass laid it out.
    pub(crate) layout_frags: Option<Box<[[f64; 4]]>>,
    // The layout pass (`RealmState::layout_pass`) that last laid it out: its box or fragments are the page's only while
    // this is the current one (`geometry::laid`).
    pub(crate) laid_at: u64,
    // …and, for an OUT-OF-FLOW box, the element whose box it was placed against (None: the viewport, or a box in flow).
    pub(crate) containing_block: Option<NodeId>,
    // …and the ANONYMOUS boxes the pass made of its content — a flex or grid container's anonymous items, a table's
    // anonymous cells — which no node is, `[x, y, w, h]` each: what the scrollable overflow region of it reaches.
    pub(crate) anon_boxes: Option<Box<[[f64; 4]]>>,
    // Its SCROLL OFFSET, `[x, y]`: the scroll container's (the document scroller's on the root element), 0 on any other.
    pub(crate) scroll: [f64; 2],
    // An element's live STATE that no attribute carries (`state` bits, below): what a script or the user did to it.
    pub(crate) state: u32,
    // A shadow root's host (None for every other node): the shadow-including ancestor chain `:focus` walks…
    pub(crate) host: Option<NodeId>,
    // …and a host's shadow root, the other way; and whether a shadow root delegates focus (`attachShadow`'s
    // `delegatesFocus`).
    pub(crate) shadow_root: Option<NodeId>,
    pub(crate) delegates_focus: bool,
    // …and whether a shadow root assigns its slots by hand (`slotAssignment: "manual"`, slots.rs), and a slot's nodes
    // `assign()`ed to it, in that order — those in this arena.
    pub(crate) manual_slot_assignment: bool,
    pub(crate) manual_assigned: Vec<NodeId>,
    // The node's handle on the C++ heap (node_handle.rs), whose tree edges the slot's are written into.
    pub(crate) link: crate::node_handle::Link,
    // The realm whose tree it is in (the one that made it, until it joins another's: `RealmArena::adopt`), and its index
    // in that realm's list of nodes (`RealmArena::realm_nodes`).
    pub(crate) realm: i32,
    pub(crate) realm_pos: u32,
    // A slot's assigned nodes, in tree order, and a slotted node's slot: the flat tree the style engine walks.
    pub(crate) assigned: Vec<NodeId>,
    pub(crate) assigned_slot: Option<NodeId>,
    // A CDATA section, of the text nodes — which XML serializes as one.
    pub(crate) cdata: bool,
    // A doctype's public and system identifiers (its name is its `data`) — which XML serializes.
    pub(crate) doctype_ids: Option<Box<(Vec<u16>, Vec<u16>)>>,
    // A `<template>`'s contents (the fragment `content` is), which no child list holds — what serializing it writes; and
    // a contents fragment's template, the other way.
    pub(crate) template_content: Option<NodeId>,
    pub(crate) template_host: Option<NodeId>,
    // The `is` value an element was made with (a customized built-in's) — serialized where it holds no `is` attribute.
    pub(crate) is_value: Option<Box<[u16]>>,
    // A form control's live value once dirty (a script's `.value`, typing), in UTF-16 code units; None while it is
    // its default — the `value` attribute, or a `<textarea>`'s text.
    pub(crate) value: Option<Box<[u16]>>,
    // An `<img>`'s natural size once its image has decoded, which the layout sizes it from; None while it has not —
    // no source, still loading, broken.
    pub(crate) natural_size: Option<NaturalSize>,
    // An element's generated-content boxes, `::before` and `::after` — the nodes the JS side registered for them, which
    // no tree holds (`linkPseudoBox`) — for the walk to lay out as its first and last children.
    pub(crate) pseudo_boxes: [Option<NodeId>; 2],
    // …and such a box's element and which of the two it is: its parent in the flat tree, and whose style it has.
    pub(crate) generated_of: Option<(NodeId, u8)>,
    // What the style engine keeps on a node (an element's id atom, parsed `style` attribute and computed style; a
    // parent's selector flags): made the first time the engine asks, so a realm with no style engine pays a pointer.
    pub(crate) style: std::cell::OnceCell<Box<crate::style::StyleSlot>>,
    // The declaration block a CSSOM write made of an element's `style` attribute, and the text it wrote there — what
    // the style engine computes the element's style from while the attribute still holds that text, rather than a
    // parse of it (cssom_decl.rs: the text rounds what the write said).
    pub(crate) written_style: Option<Box<crate::cssom_decl::WrittenStyle>>,
    // The layout epoch (`RealmArena::layout_epoch`) at which this node's FLAT SUBTREE — it, or anything the flat tree
    // puts under it — last changed in a way a layout walk reads: its data, children, attributes, state or style. A
    // subtree stamped no later than the epoch the last walk began at is built as that walk built it (`walk_reuse`).
    // Kept current up the flat tree by `stamp_change`.
    pub(crate) stamp: std::cell::Cell<u64>,
}

// The element state bits (`NodeData::state`, native-query-shadow.js `STATE_*`): focus and hover (the realm's one
// focused / hovered element carries its bit, see `RealmArena::set_state`), checkedness (dirty, then its value — a
// clean one is the `checked` attribute), an option's selectedness, indeterminate, an open popover, a modal dialog, a
// filtered option, a form-associated custom element, a custom element that is custom (constructed or upgraded, not
// failed), and one created with an `is` value.
pub(crate) const STATE_FOCUSED: u32 = 1;
pub(crate) const STATE_HOVERED: u32 = 1 << 1;
pub(crate) const STATE_CHECKED_DIRTY: u32 = 1 << 2;
pub(crate) const STATE_CHECKED: u32 = 1 << 3;
pub(crate) const STATE_SELECTED: u32 = 1 << 4;
pub(crate) const STATE_INDETERMINATE: u32 = 1 << 5;
pub(crate) const STATE_POPOVER_OPEN: u32 = 1 << 6;
pub(crate) const STATE_MODAL: u32 = 1 << 7;
pub(crate) const STATE_FILTERED: u32 = 1 << 8;
pub(crate) const STATE_FORM_ASSOCIATED: u32 = 1 << 9;
pub(crate) const STATE_CUSTOM: u32 = 1 << 10;
pub(crate) const STATE_IS_VALUE: u32 = 1 << 11;
// …what constraint validation reads that no attribute records: a value last changed by the user, a custom validity
// message, the user having interacted with the control, and an `<input type=file>` holding files…
pub(crate) const STATE_DIRTY_BY_USER: u32 = 1 << 12;
pub(crate) const STATE_CUSTOM_ERROR: u32 = 1 << 13;
pub(crate) const STATE_USER_INTERACTED: u32 = 1 << 14;
pub(crate) const STATE_HAS_FILES: u32 = 1 << 15;


impl NodeData {
    // A node of `kind` with its character data and nothing else — the element fields are filled by the caller.
    pub(crate) fn of_kind(kind: NodeKind, data: Vec<u16>) -> NodeData {
        NodeData {
            kind,
            data,
            local_name: LocalName::default(),
            ns: Namespace::default(),
            prefix: None,
            name_u16: None,
            attributes: Vec::new(),
            attr_u16: Vec::new(),
            attr_ns: Vec::new(),
            attr_ns_u16: Vec::new(),
            parent: None,
            children: Vec::new(),
            position: 0,
            first_position: 0,
            layout_box: None,
            layout_frags: None,
            laid_at: 0,
            containing_block: None,
            anon_boxes: None,
            scroll: [0.0; 2],
            state: 0,
            host: None,
            shadow_root: None,
            delegates_focus: false,
            manual_slot_assignment: false,
            manual_assigned: Vec::new(),
            link: crate::node_handle::Link::default(),
            assigned: Vec::new(),
            assigned_slot: None,
            cdata: false,
            doctype_ids: None,
            template_content: None,
            template_host: None,
            realm: 0,
            realm_pos: 0,
            is_value: None,
            value: None,
            natural_size: None,
            pseudo_boxes: [None; 2],
            generated_of: None,
            style: std::cell::OnceCell::new(),
            written_style: None,
            stamp: std::cell::Cell::new(0),
        }
    }
    // An element in the HTML namespace.
    pub(crate) fn is_html(&self) -> bool {
        self.kind == NodeKind::Element && self.ns == ns!(html)
    }
    // …and one of those named `name` (a lowercase local name).
    pub(crate) fn is_html_named(&self, name: &str) -> bool {
        self.is_html() && &*self.local_name == name
    }
    // The tag HTML's rendering rules know an element by: its local name in the HTML namespace, `svg` for an SVG root (a
    // replaced element to the HTML around it), and none — "" — for every other element, which CSS lays out by its style
    // alone (an element of an unknown namespace is no `<img>` and no `<br>`, whatever its local name).
    pub(crate) fn rendering_tag(&self) -> &str {
        let svg_root = self.ns == ns!(svg) && &*self.local_name == "svg";
        if self.kind == NodeKind::Element && (self.ns == ns!(html) || svg_root) { &self.local_name } else { "" }
    }
    // The attribute list as the DOM sees it, in its order: each one's namespace, prefix (from its qualified name), local
    // name and value.
    pub(crate) fn attribute_list(&self) -> Vec<Attribute> {
        self.attributes
            .iter()
            .map(|(key, value)| {
                let value = match self.attr_u16.iter().find(|(k, _)| k == key) {
                    Some((_, units)) => units.clone(),
                    None => value.encode_utf16().collect(),
                };
                match self.attr_ns.iter().find(|(k, _, _)| k == key) {
                    Some((_, url, local)) => {
                        // (…a store key is the qualified name, a NUL and a counter after it where two would share it)
                        let qn = key.split('\0').next().unwrap_or(key);
                        let prefix = qn.split_once(':').filter(|(_, l)| l == local).map(|(p, _)| p.to_string());
                        Attribute { ns: (!url.is_empty()).then(|| url.clone()), prefix, local: local.clone(), value }
                    }
                    None => Attribute { ns: None, prefix: None, local: key.clone(), value },
                }
            })
            .collect()
    }
    // Its index in `parent`'s children, where that is its parent — None for a position that drifted out of the list.
    pub(crate) fn index_in(&self, parent: &NodeData) -> Option<usize> {
        usize::try_from(self.position - parent.first_position).ok().filter(|&i| i < parent.children.len())
    }
    // The DOM `nodeType` (an arena node with no kind of its own — no element, character data, document or fragment —
    // is a doctype where it carries one's identifiers, else an Attr's slot).
    pub(crate) fn node_type(&self) -> u32 {
        match self.kind {
            NodeKind::Element => 1,
            NodeKind::Text if self.cdata => 4,
            NodeKind::Text => 3,
            NodeKind::ProcessingInstruction => 7,
            NodeKind::Comment => 8,
            NodeKind::Document => 9,
            NodeKind::Fragment => 11,
            NodeKind::Other if self.doctype_ids.is_some() => 10,
            NodeKind::Other => 2,
        }
    }
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
        self.attr_changed(Some(name));
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

    // An element's namespace, exactly (the empty one for none).
    pub(crate) fn ns_units(&self) -> Cow<'_, [u16]> {
        match &self.name_u16 {
            Some(exact) => Cow::Borrowed(&exact.0),
            None => Cow::Owned(self.ns.encode_utf16().collect()),
        }
    }
    // Whether an element's namespace is `units`, exactly.
    pub(crate) fn ns_is(&self, units: &[u16]) -> bool {
        match &self.name_u16 {
            Some(exact) => exact.0 == units,
            None => self.ns.encode_utf16().eq(units.iter().copied()),
        }
    }
    // …and its prefix (None for none).
    pub(crate) fn prefix_is(&self, units: Option<&[u16]>) -> bool {
        match (&self.name_u16, units) {
            (Some(exact), _) => exact.1.as_deref() == units,
            (None, Some(units)) => self.prefix.as_deref().is_some_and(|p| p.encode_utf16().eq(units.iter().copied())),
            (None, None) => self.prefix.is_none(),
        }
    }
    // …and its prefix, exactly.
    pub(crate) fn prefix_units(&self) -> Option<Cow<'_, [u16]>> {
        match &self.name_u16 {
            Some(exact) => exact.1.as_deref().map(Cow::Borrowed),
            None => self.prefix.as_deref().map(|p| Cow::Owned(p.encode_utf16().collect())),
        }
    }
    // The attributes that are in a namespace, in attribute-list order: each one's key, namespace and local name, exactly.
    pub(crate) fn namespaced_attributes(&self) -> impl Iterator<Item = (&str, Cow<'_, [u16]>, Cow<'_, [u16]>)> {
        let records = if self.attr_ns.is_empty() { &[][..] } else { &self.attributes[..] };
        records.iter().filter_map(|(key, _)| {
            let (_, ns, local) = self.attr_ns.iter().find(|(k, _, _)| k == key)?;
            Some(match self.attr_ns_u16.iter().find(|(k, _, _)| k == key) {
                Some((_, ns, local)) => (key.as_str(), Cow::Borrowed(&ns[..]), Cow::Borrowed(&local[..])),
                None => (key.as_str(), Cow::Owned(ns.encode_utf16().collect()), Cow::Owned(local.encode_utf16().collect())),
            })
        })
    }
    // The value of the attribute stored under `key`, exactly.
    pub(crate) fn attr_units(&self, key: &str) -> Option<Cow<'_, [u16]>> {
        match self.get_attr_u16(key) {
            Some(units) => Some(Cow::Borrowed(units)),
            None => self.get_attr(key).map(|v| Cow::Owned(v.encode_utf16().collect())),
        }
    }
    // Keep the namespace records of the attributes `keep` names.
    fn retain_attr_ns(&mut self, keep: impl Fn(&str) -> bool) {
        self.attr_ns.retain(|(k, _, _)| keep(k));
        self.attr_ns_u16.retain(|(k, _, _)| keep(k));
    }

    // The value of the attribute `local` in NO namespace — what an HTML reflection or an unprefixed selector names.
    pub(crate) fn plain_attr(&self, local: &str) -> Option<&str> {
        if self.attr_ns.iter().any(|(k, _, _)| k == local) {
            return None;
        }
        self.get_attr(local)
    }
    // The (namespace, local name) of the attribute stored under `key`: the namespace record where it has one, else no
    // namespace and the key itself — less the `\0`-numbered suffix a key two same-named attributes share is minted with.
    pub(crate) fn attribute_name<'a>(&'a self, key: &'a str) -> (&'a str, &'a str) {
        match self.attr_ns.iter().find(|(k, _, _)| k == key) {
            Some((_, ns, local)) => (ns, local),
            None => ("", key.split('\0').next().unwrap_or(key)),
        }
    }
    // The value of the attribute (`ns`, `local`).
    pub(crate) fn ns_attr(&self, ns: &str, local: &str) -> Option<&str> {
        let (key, _, _) = self.attr_ns.iter().find(|(_, n, l)| n == ns && l == local)?;
        self.get_attr(key)
    }
    // Drop the attribute stored under `name`, with what rides beside it.
    fn remove_attr(&mut self, name: &str) {
        self.attributes.retain(|(k, _)| k != name);
        self.clear_attr_u16(name);
        if !self.attr_ns.is_empty() {
            self.retain_attr_ns(|k| k != name);
        }
        self.attr_changed(Some(name));
    }

    // The attribute `name` changed (None: any may have) — what the style engine keeps of the attributes follows, and
    // the block a CSSOM write made of the `style` attribute stops being the attribute's once it holds any other text.
    fn attr_changed(&mut self, name: Option<&str>) {
        if name.is_none_or(|n| n == "style") &&
            self.written_style.as_ref().is_some_and(|w| self.plain_attr("style") != Some(w.text()))
        {
            self.written_style = None;
        }
        if self.style.get().is_none() {
            return;
        }
        let id = name.is_none_or(|n| n == "id").then(|| self.plain_attr("id").map(Atom::from)).flatten();
        if let Some(slot) = self.style.get_mut() {
            slot.attr_changed(name, id);
        }
    }

    fn clear_attr_u16(&mut self, name: &str) {
        if !self.attr_u16.is_empty() {
            self.attr_u16.retain(|(k, _)| k != name);
        }
    }

    pub(crate) fn get_attr_u16(&self, name: &str) -> Option<&[u16]> {
        if self.attr_u16.is_empty() {
            return None;
        }
        self.attr_u16.iter().find(|(k, _)| k == name).map(|(_, u)| u.as_slice())
    }
    // The value of the attribute `local` in no namespace as the page wrote it: UTF-16, a lone surrogate included.
    pub(crate) fn plain_attr_units(&self, local: &str) -> Option<Vec<u16>> {
        let value = self.plain_attr(local)?;
        Some(self.get_attr_u16(local).map_or_else(|| value.encode_utf16().collect(), <[u16]>::to_vec))
    }
}

// Is `key` the store key of an attribute named `local` when it has no namespace record — `local` itself, or `local`
// with the `\0`-numbered suffix a shared name is minted with? (`NodeData::attribute_name` without the record lookup.)
pub(crate) fn store_key_names(key: &str, local: &str) -> bool {
    key.starts_with(local) && (key.len() == local.len() || key.as_bytes()[local.len()] == 0)
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

// The isolate's node arena: every realm's nodes, in one slot space, so a node keeps its id whichever realm's tree it is
// in. The selector matcher reads it through NodeRef with direct slot indexing (no per-node-access map lookup).
// Element-tree navigation lives here: every navigation and deref goes through `get` (gen-checked), so a stale edge
// self-elides.
//
// What is a realm's own — its document's focus, sheets, layout, geometry — is its `RealmState`: the arena holds the one
// of the realm an op works in (`enter`), which its fields are read through (`Deref`), and keeps the others aside.
#[derive(Default)]
pub(crate) struct RealmArena {
    slots: Vec<Slot>,
    // Indices whose slot is free, LIFO. `importNode` pops one before growing `slots`, so a page's
    // live-node high-water mark bounds `slots.len()` even as nodes churn.
    free: Vec<u32>,
    // The realm whose state is `state`; the others' states; and the realms `dropRealm` freed, whose state an op a script
    // of one still runs gets afresh and leaves behind (context ids are never reused, so each would stay an entry).
    cur: i32,
    state: RealmState,
    parked: std::collections::HashMap<i32, RealmState>,
    dropped: std::collections::HashSet<i32>,
    // Each realm's nodes, by slot index: what a realm's style engine walks (`element_ids`) and a new context or
    // `dropRealm` frees, in the realm's size rather than the isolate's.
    realm_nodes: std::collections::HashMap<i32, Vec<u32>>,
    // Whether any shadow root has a host — `:focus` walks out of shadow trees only then.
    pub(crate) has_shadow_hosts: bool,
    // The form the HTML parser's form element pointer gave a control it inserted (`<table><form>…<input>`: the form
    // is no ancestor of it), until a script moves it — the few controls whose form owner the tree can't tell.
    parser_form_owners: std::collections::HashMap<NodeId, NodeId>,
    // A custom element's custom states (`ElementInternals.states`, `:state()`), for the few elements that have any.
    custom_states: std::collections::HashMap<NodeId, Vec<String>>,
    // Moves with every write to the arena (a node made or freed, any `get_mut`): what a memo of it keys on.
    pub(crate) mutations: u64,
    // The lock the style engines' rules and every element's parsed declarations are read under — ONE for the isolate's
    // life, as a block parsed under one lock can never be read under another, and an element keeps its `style` block
    // into another realm's tree.
    pub(crate) style_lock: crate::style::StyleLock,
    // Per tree root, the facts element_state.rs asks of every control in turn, as of `mutations` (`form_facts`).
    pub(crate) form_facts: std::cell::RefCell<crate::element_state::FormFactsMemo>,
    // Each element's resolved directionality asked so far, true for rtl, as of `mutations` (`is_rtl`)…
    pub(crate) directionality: std::cell::RefCell<(u64, std::collections::HashMap<NodeId, bool>)>,
    // …which nothing need be asked about until an element has ever been able to decide one of its own — a `dir`
    // written, a `<bdi>` or an `<input>` made (`notes_direction`): every other page is ltr throughout, and asking
    // cost the state scan a walk per element (a 1500-row append, 626 → 1150 ms).
    pub(crate) direction_sources: bool,
    // The layout walks' clock: a walk moves it on as it begins, and a change is stamped with where it stands
    // (`NodeData::stamp`), so a stamp past the epoch a walk began at is a change since that walk — one clock for every
    // realm's walks, as a node carries its stamp into another realm's tree.
    pub(crate) layout_epoch: std::cell::Cell<u64>,
    // The layouts begun, every realm's: what numbers each (`RealmState::layout_pass`), so one realm's never equals
    // another's — a node carries its `laid_at` into another realm's tree.
    layouts: u64,
}

// A realm's own state (`RealmArena`): its document's.
#[derive(Default)]
pub(crate) struct RealmState {
    // Moves with every write to the realm's nodes that can change an element's STATE (`:checked`, `:focus`, `:valid`, `:default`, …): a
    // state write, a value, a tree change (form owners, radio groups, fieldsets), an attribute a state reads.
    pub(crate) state_epoch: u64,
    // The realm document's focused and hovered element — the one carrying STATE_FOCUSED / STATE_HOVERED — from which
    // `:focus-within` and `:hover` walk up.
    pub(crate) focus: Option<NodeId>,
    pub(crate) hover: Option<NodeId>,
    // Whether the focus shows NO ring (not `:focus-visible`): only after a pointer focus of a non-text control.
    pub(crate) focus_ring_hidden: bool,
    // The realm document and its target fragments (as it stands, then decoded), when it has any — what `:target`
    // resolves (`is_target`).
    pub(crate) target: Option<(NodeId, Vec<String>)>,
    // The realm's style sheets, parsed under the arena's lock (sheets.rs): what its engine cascades and CSSOM reads.
    pub(crate) sheets: crate::sheets::SheetStore,
    // The `marginwidth` / `marginheight` of the frame this realm's document sits in, which its body takes its margins
    // from where it declares none (HTML §15.3.2) — pushed in by the parent realm (`setContainerMargins`).
    pub(crate) container_margins: [Option<String>; 2],
    // The faces its families resolve to, which its walks and its style engine's font metrics read (`SharedFaces`).
    pub(crate) faces: crate::walk::SharedFaces,
    // How many elements a restyle REPLACED the style of since this side last took them (`note_restyled`,
    // `styleRestyled`): what the JS side's layout gate has to hear of, since the engine decides what a change restyles.
    pub(crate) restyled: std::cell::Cell<u32>,
    // The root element the last layout laid out and the viewport it laid it out against, `[width, height]`: what the
    // geometry (geometry.rs) reads every box of that layout in.
    pub(crate) layout_root: Option<NodeId>,
    pub(crate) viewport: [f64; 2],
    // …and which layout that is (numbered across every realm's: `RealmArena::layouts`): a node laid out by an earlier one
    // has no box in this one.
    pub(crate) layout_pass: u64,
    // Moves with anything a geometry read reads (`boxes_moved`, `scrolled`): what its memo is kept against (`geometry::Memo`) —
    // and `boxes_epoch` with all of it but a scroll, which moves no box: what the parts of it no scroll offset enters are.
    pub(crate) geometry_epoch: std::cell::Cell<u64>,
    pub(crate) boxes_epoch: std::cell::Cell<u64>,
    pub(crate) geometry_memo: std::cell::RefCell<crate::geometry::Memo>,
    // The nodes holding a scroll offset (`NodeData::scroll`), which every layout clamps to the range its box has then
    // (`geometry::reclamp_scrolls`) and a removal from the tree drops (`detach`).
    pub(crate) scrolled_nodes: Vec<NodeId>,
    // The document's `@font-face`s, as the page side last listed them (font_faces.rs).
    pub(crate) font_faces: Vec<crate::font_faces::FaceRecord>,
}

impl std::ops::Deref for RealmArena {
    type Target = RealmState;
    fn deref(&self) -> &RealmState {
        &self.state
    }
}
impl std::ops::DerefMut for RealmArena {
    fn deref_mut(&mut self) -> &mut RealmState {
        &mut self.state
    }
}

impl RealmArena {
    // The arena with realm `cid`'s state the one it holds (made afresh for a realm it has not seen).
    pub(crate) fn enter(&mut self, cid: i32) -> &mut RealmArena {
        if cid != self.cur {
            let incoming = self.parked.remove(&cid).unwrap_or_default();
            let left = std::mem::replace(&mut self.state, incoming);
            if !self.dropped.contains(&self.cur) {
                self.parked.insert(self.cur, left);
            }
            self.cur = cid;
        }
        self
    }
    // …for a realm it has seen, and has not dropped.
    pub(crate) fn enter_known(&mut self, cid: i32) -> Option<&mut RealmArena> {
        let known = (cid == self.cur || self.parked.contains_key(&cid)) && !self.dropped.contains(&cid);
        known.then(|| self.enter(cid))
    }
    // `id` and everything it holds — its children, shadow tree, template contents and generated boxes, theirs — are the
    // held realm's now: they joined a tree of it, and its page load frees them, not the one of the realm that made them.
    pub(crate) fn adopt(&mut self, id: NodeId) {
        let cur = self.cur;
        let mut stack = vec![id];
        while let Some(n) = stack.pop() {
            let Some(node) = self.get(n) else { continue };
            if node.realm != cur {
                self.unlist(n.idx);
                let list = self.realm_nodes.entry(cur).or_default();
                let pos = list.len() as u32;
                list.push(n.idx);
                let node = self.get_mut_quietly(n).expect("a live node");
                node.realm = cur;
                node.realm_pos = pos;
            }
            let node = self.get(n).expect("a live node");
            stack.extend(node.children.iter().copied());
            stack.extend(node.shadow_root.into_iter().chain(node.template_content).chain(node.pseudo_boxes.into_iter().flatten()));
        }
    }
    // A new context is realm `cid`: whatever an earlier context of that id made is unreachable, and its state with it.
    pub(crate) fn realm_begins(&mut self, cid: i32) {
        if cid != self.cur && !self.parked.contains_key(&cid) {
            return;
        }
        self.enter(cid);
        // (…afresh, but its faces table and sheet store in place: the realm's style engine, which outlives the context,
        // holds the one, and the ids the other hands out are never to be handed out again — a late drop of the old
        // context's sheet would free the new page's)
        let RealmState { faces, mut sheets, state_epoch, .. } = std::mem::take(&mut self.state);
        sheets.reset();
        faces.with(|f| *f = Default::default());
        self.state = RealmState { faces, sheets, state_epoch: state_epoch + 1, ..RealmState::default() };
        self.free_realm_nodes(cid);
        // (…and what the isolate latched for any realm's page, where this is the only realm left)
        if self.parked.is_empty() {
            self.has_shadow_hosts = false;
            self.direction_sources = false;
        }
    }
    pub(crate) fn is_dropped(&self, cid: i32) -> bool {
        self.dropped.contains(&cid)
    }
    // Realm `cid` is gone: its state, and the nodes it made.
    pub(crate) fn drop_realm(&mut self, cid: i32) {
        self.dropped.insert(cid);
        self.parked.remove(&cid);
        if self.cur == cid {
            self.state = RealmState::default();
        }
        self.free_realm_nodes(cid);
    }
    // Free every node realm `cid` made.
    fn free_realm_nodes(&mut self, cid: i32) {
        self.mutations += 1;
        for idx in self.realm_nodes.remove(&cid).unwrap_or_default() {
            let slot = &mut self.slots[idx as usize];
            slot.data = None;
            if slot.generation < GEN_MAX {
                slot.generation += 1;
                self.free.push(idx);
            }
        }
        // (…and what the arena kept of them by their ids)
        let live = |slots: &[Slot], id: &NodeId| slots.get(id.idx as usize).is_some_and(|s| s.generation == id.generation && s.data.is_some());
        let slots = &self.slots;
        self.parser_form_owners.retain(|id, _| live(slots, id));
        self.custom_states.retain(|id, _| live(slots, id));
    }
}

impl RealmArena {
    // `id` changed in a way a layout walk reads: it and every node its flat subtree is part of — its parent, a shadow
    // root's host, a slotted node's slot, and theirs — are stamped with the current layout epoch, up to the first
    // stamped already, whose own ancestors are too.
    pub(crate) fn stamp_change(&self, id: NodeId) {
        self.boxes_moved();
        let epoch = self.layout_epoch.get();
        let mut stack = vec![id];
        while let Some(n) = stack.pop() {
            let Some(node) = self.get(n) else { continue };
            if node.stamp.get() == epoch {
                continue;
            }
            node.stamp.set(epoch);
            stack.extend(node.parent);
            stack.extend(node.host);
            stack.extend(node.assigned_slot);
        }
    }
    // …and one the style engine RESTYLED: stamped, as a write is, and kept for this side to take.
    pub(crate) fn note_restyled(&self, id: NodeId) {
        self.stamp_change(id);
        self.restyled.set(self.restyled.get().saturating_add(1));
    }
    // Something a geometry read reads moved: its memo is no longer the page's — `boxes_moved` where it may have moved a
    // box, `scrolled` where it moved a scroll offset alone.
    pub(crate) fn boxes_moved(&self) {
        self.boxes_epoch.set(self.boxes_epoch.get() + 1);
        self.scrolled();
    }
    pub(crate) fn scrolled(&self) {
        self.geometry_epoch.set(self.geometry_epoch.get() + 1);
    }
    // A layout of `root` against `viewport` begins: the boxes it writes are the page's from now on, and no earlier one's.
    pub(crate) fn begin_layout(&mut self, root: NodeId, viewport: [f64; 2]) {
        self.layout_root = Some(root);
        self.viewport = viewport;
        self.layouts += 1;
        self.state.layout_pass = self.layouts;
        self.boxes_moved();
    }
    // The start of a layout walk: the epoch it walks at, the clock moved on past it.
    pub(crate) fn begin_layout_walk(&self) -> u64 {
        let walked = self.layout_epoch.get();
        self.layout_epoch.set(walked + 1);
        walked
    }
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
    // A write to the node: it moves `mutations`, which the memos of the arena key on, and stamps its flat subtree's
    // change for the layout walk (`stamp_change`).
    fn get_mut(&mut self, id: NodeId) -> Option<&mut NodeData> {
        self.mutations += 1;
        self.stamp_change(id);
        self.get_mut_quietly(id)
    }
    // …and one that does not — a layout pass writing its boxes: a box is no input to any of those memos, and a pass
    // writing one per node would throw them all away every time.
    pub(crate) fn get_mut_quietly(&mut self, id: NodeId) -> Option<&mut NodeData> {
        let slot = self.slots.get_mut(id.idx as usize)?;
        if slot.generation == id.generation {
            slot.data.as_mut()
        } else {
            None
        }
    }

    // Put `data` in a free slot (reusing a recycled index when one is listed, else growing), returning
    // its NodeId at the slot's CURRENT generation. A recycled slot's gen was already bumped at free.
    fn alloc(&mut self, mut data: NodeData) -> NodeId {
        self.mutations += 1;
        data.stamp.set(self.layout_epoch.get());
        let list = self.realm_nodes.entry(data.realm).or_default();
        data.realm_pos = list.len() as u32;
        let idx = self.free.pop().unwrap_or(self.slots.len() as u32);
        list.push(idx);
        if (idx as usize) < self.slots.len() {
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
    // Take slot `idx`'s node out of its realm's list (the last one moved into its place).
    fn unlist(&mut self, idx: u32) {
        let Some((realm, pos)) = self.slots[idx as usize].data.as_ref().map(|n| (n.realm, n.realm_pos as usize)) else { return };
        let Some(list) = self.realm_nodes.get_mut(&realm) else { return };
        list.swap_remove(pos);
        if let Some(&moved) = list.get(pos) {
            if let Some(n) = self.slots[moved as usize].data.as_mut() {
                n.realm_pos = pos as u32;
            }
        }
    }

    // Free `id`'s slot: drop the node, bump the gen (so every surviving reference — the JS nid, an
    // attrsView holder, a stale tree edge — now reads absent), and list the index for reuse. A gen at
    // the pack ceiling RETIRES the slot instead (dropped but not recycled) so its index can never be
    // handed out with a gen that would collide with an outstanding reference; a no-op if `id` is
    // already stale (double-free / a FinalizationRegistry callback for a slot resetArena already
    // recycled). Idempotent and safe against any wire id.
    pub(crate) fn free_node(&mut self, id: NodeId) {
        let Some(slot) = self.slots.get_mut(id.idx as usize) else {
            return;
        };
        if slot.generation != id.generation || slot.data.is_none() {
            return;
        }
        self.mutations += 1;
        self.unlist(id.idx);
        let slot = &mut self.slots[id.idx as usize];
        let (assigned_slot, pseudo_boxes) = slot.data.as_ref().map_or((None, [None; 2]), |n| (n.assigned_slot, n.pseudo_boxes));
        slot.data = None;
        if slot.generation < GEN_MAX {
            slot.generation += 1;
            self.free.push(id.idx);
        }
        if !self.parser_form_owners.is_empty() {
            self.parser_form_owners.remove(&id);
        }
        if !self.custom_states.is_empty() {
            self.custom_states.remove(&id);
        }
        // …and the slot it was assigned to no longer lists it: a change to the slot's flat children.
        if let Some(s) = assigned_slot.and_then(|s| self.get_mut(s)) {
            s.assigned.retain(|&n| n != id);
        }
        // …and its generated boxes' slots go with it: a `::before` / `::after` is no node of its own, held by nothing but
        // its element (style-proxy.js `pseudoNodeFor`)
        for b in pseudo_boxes.into_iter().flatten() {
            self.free_node(b);
        }
    }

    // Drop every node, bumping each occupied slot's gen and listing it for reuse. This is the per-page
    // reset (a navigation) — NOT a Vec clear: bumping (rather than restarting gens from 0) means a
    // detached element from the previous page, still held across the navigation, carries a nid whose
    // gen no longer matches, so it reads absent instead of ALIASING whichever new-page node reused its
    // index. Growth stays bounded because the freed indices feed the next page's allocations.
    // A page load in the realm it holds the state of: that state, and what the style engine kept on the realm's nodes —
    // the engine starts the page afresh (`StyleEngine::reset`). The nodes stay: a node the old page's script still
    // holds, or that the new page reuses, is a node yet; the rest go as V8 collects them (node_handle.rs).
    fn reset(&mut self) {
        self.focus = None;
        self.hover = None;
        self.target = None;
        self.form_facts.get_mut().clear();
        self.directionality.get_mut().1.clear();
        self.sheets.reset();
        // (…in place: the style engine holds the same table, and outlives the page)
        self.faces.with(|faces| *faces = Default::default());
        self.mutations += 1;
        for &i in self.realm_nodes.get(&self.cur).into_iter().flatten() {
            if let Some(node) = self.slots[i as usize].data.as_mut() {
                node.style.take();
            }
        }
    }

    // Append `child` at the end of `parent`'s children, recording its position so prev/next-sibling
    // nav is O(1). The one place children are linked (create / import), so a position can never drift
    // from the list.
    fn link_child(&mut self, parent: NodeId, child: NodeId) {
        let (pos, first) = match self.get(parent) {
            Some(p) => (p.children.len(), p.first_position),
            None => return,
        };
        if let Some(p) = self.get_mut(parent) {
            p.children.push(child);
        }
        if let Some(c) = self.get_mut(child) {
            c.position = first + pos as i64;
        }
        self.relink(parent, pos.saturating_sub(1), usize::MAX);
    }

    // The handles' tree edges for `parent`'s children from `from` on (`node_handle::relink`).
    fn relink(&self, parent: NodeId, from: usize, to: usize) {
        let Some(p) = self.get(parent) else { return };
        crate::node_handle::relink(Some(&p.link), &p.children, from, to, |k| self.get(k).map(|n| &n.link));
    }
    // For verify mode: where `id`'s handle's edges disagree with the slot's tree — its parent (a root's owner), its first
    // child, its next sibling and the tree it owns, each the one the slot has where that one has a handle too — or where
    // its position does not find it in its parent's list; else None.
    pub(crate) fn edge_mismatch(&self, id: NodeId) -> Option<String> {
        let n = self.get(id)?;
        // (…and its position, handle or none, where it is listed: its parent's list holds it at the index it says)
        if let Some(p) = n.parent.and_then(|p| self.get(p)) {
            if n.index_in(p).and_then(|i| p.children.get(i)) != Some(&id) && p.children.contains(&id) {
                return Some(format!("position {} under first {}, listed at {:?}", n.position, p.first_position, p.children.iter().position(|&c| c == id)));
            }
        }
        let got = crate::node_handle::edges(&n.link)?;
        let handled = |k: NodeId| self.get(k).is_some_and(|d| crate::node_handle::edges(&d.link).is_some());
        let parent = n.parent.or(n.host).or(n.template_host).filter(|&p| handled(p));
        let first = n.children.first().copied().filter(|&c| handled(c));
        let next = n.parent.and_then(|p| self.get(p)).and_then(|p| n.index_in(p).and_then(|i| p.children.get(i + 1)).copied()).filter(|&c| handled(c));
        let owned = n.shadow_root.or(n.template_content).filter(|&c| handled(c));
        let want = [parent, first, next, owned];
        (got != want).then(|| format!("handle edges {got:?}, tree {want:?}"))
    }
    // `id`'s handle is `link`: its edges written where it is — under its parent, and over its children.
    pub(crate) fn set_link(&mut self, id: NodeId, link: crate::node_handle::Link) {
        let at = self.child_index(id);
        let Some(node) = self.get_mut_quietly(id) else { return };
        node.link = link;
        let parent = node.parent;
        match parent {
            Some(p) => self.relink(p, at.saturating_sub(1), usize::MAX),
            // (…a root here: whatever tree the handle was in before is no edge of it now)
            None => crate::node_handle::unlink(&self.get(id).expect("the node just linked").link),
        }
        self.relink(id, 0, usize::MAX);
        // …and the trees it owns, or is owned by
        self.reown(id);
    }

    // A new node, appended to `parent` when that is live (a stale parent nid leaves it a detached root).
    pub(crate) fn create(&mut self, data: NodeData, parent: Option<NodeId>) -> NodeId {
        self.direction_sources |= notes_direction(&data);
        let parent = parent.filter(|&p| self.get(p).is_some());
        if parent.is_some() {
            self.state_epoch += 1;
        }
        let id = self.alloc(NodeData { parent, realm: self.cur, ..data });
        if let Some(p) = parent {
            self.link_child(p, id);
        }
        id
    }

    // `id`'s state bits become `bits`. The realm's focused and hovered element is whichever carries that bit last.
    pub(crate) fn set_state(&mut self, id: NodeId, bits: u32) {
        self.state_epoch += 1;
        let Some(node) = self.get_mut(id) else { return };
        node.state = bits;
        let state = &mut self.state;
        for (bit, slot) in [(STATE_FOCUSED, &mut state.focus), (STATE_HOVERED, &mut state.hover)] {
            if bits & bit != 0 {
                *slot = Some(id);
            } else if *slot == Some(id) {
                *slot = None;
            }
        }
    }

    // The form the parser gave `id`, or none.
    pub(crate) fn set_parser_form_owner(&mut self, id: NodeId, form: Option<NodeId>) {
        self.mutations += 1;
        self.state_epoch += 1;
        match form {
            Some(f) => self.parser_form_owners.insert(id, f),
            None => self.parser_form_owners.remove(&id),
        };
    }
    pub(crate) fn parser_form_owner(&self, id: NodeId) -> Option<NodeId> {
        self.parser_form_owners.get(&id).copied()
    }

    // `id`'s custom states become `states`.
    pub(crate) fn set_custom_states(&mut self, id: NodeId, states: Vec<String>) {
        if self.get(id).is_none() {
            return;
        }
        self.mutations += 1;
        self.state_epoch += 1;
        if states.is_empty() {
            self.custom_states.remove(&id);
        } else {
            self.custom_states.insert(id, states);
        }
    }
    // `:state(name)`.
    pub(crate) fn has_custom_state(&self, id: NodeId, name: &str) -> bool {
        self.custom_states.get(&id).is_some_and(|s| s.iter().any(|n| n == name))
    }

    // The document `doc`'s target fragments (none: nothing is the target).
    pub(crate) fn set_target(&mut self, doc: NodeId, fragments: Vec<String>) {
        self.mutations += 1;
        self.state_epoch += 1;
        self.target = (!fragments.is_empty()).then_some((doc, fragments));
    }
    // Whether the focus shows no ring.
    pub(crate) fn set_focus_ring_hidden(&mut self, hidden: bool) {
        if self.focus_ring_hidden != hidden {
            self.mutations += 1;
            self.state_epoch += 1;
            self.focus_ring_hidden = hidden;
        }
    }

    // `root` is the shadow root of `host`, delegating focus or not.
    pub(crate) fn set_shadow_host(&mut self, root: NodeId, host: NodeId, delegates_focus: bool, manual_slot_assignment: bool) {
        if self.get(host).is_none() {
            return;
        }
        if let Some(node) = self.get_mut(root) {
            node.host = Some(host);
            node.delegates_focus = delegates_focus;
            node.manual_slot_assignment = manual_slot_assignment;
            self.has_shadow_hosts = true;
        }
        if let Some(node) = self.get_mut(host) {
            node.shadow_root = Some(root);
        }
        self.reown(host);
    }

    // `id` and its ancestors, root first — in its node tree (a shadow root is a root).
    pub(crate) fn chain(&self, id: NodeId) -> Vec<NodeId> {
        let mut out = vec![id];
        while let Some(p) = self.parent_of(*out.last().expect("never empty")) {
            out.push(p);
        }
        out.reverse();
        out
    }
    // Where `a` is against `b` in their node tree — None where they are in different trees.
    pub(crate) fn relation(&self, a: NodeId, b: NodeId) -> Option<Relation> {
        if a == b {
            return Some(Relation::Same);
        }
        let (ca, cb) = (self.chain(a), self.chain(b));
        if ca[0] != cb[0] {
            return None;
        }
        let shared = ca.iter().zip(&cb).take_while(|(x, y)| x == y).count();
        let (Some(&xa), Some(&xb)) = (ca.get(shared), cb.get(shared)) else {
            return Some(if shared == ca.len() { Relation::Ancestor } else { Relation::Descendant });
        };
        let position = |n: NodeId| self.get(n).map_or(0, |d| d.position);
        Some(if position(xa) < position(xb) { Relation::Before } else { Relation::After })
    }
    // …as tree order: an ancestor before what it contains.
    pub(crate) fn tree_order(&self, a: NodeId, b: NodeId) -> Option<std::cmp::Ordering> {
        use std::cmp::Ordering::*;
        self.relation(a, b).map(|r| match r {
            Relation::Same => Equal,
            Relation::Ancestor | Relation::Before => Less,
            Relation::Descendant | Relation::After => Greater,
        })
    }
    // The root of `id`'s tree, shadow-including: a shadow root's host is its parent here (not a template's contents':
    // they are a tree of their own). (`root_of`, element_state.rs, is the plain one.)
    pub(crate) fn shadow_including_root(&self, mut id: NodeId) -> NodeId {
        loop {
            id = self.root_of(id);
            match self.get(id).and_then(|n| n.host) {
                Some(h) => id = h,
                None => return id,
            }
        }
    }
    // Where `id` is in the JS tree: its path from `anchor`, appended to `out` as its length and then its steps down — a
    // child's index, -1 for a host's shadow root, -2 for a template's contents — or a length of -1 where `anchor` is not
    // above it. How a slot the engine answers with is found as the object a script holds (node_handle.rs).
    pub(crate) fn push_path(&self, anchor: NodeId, id: NodeId, out: &mut Vec<f64>) {
        let at = out.len();
        out.push(0.0);
        let mut cur = id;
        while cur != anchor {
            let Some(n) = self.get(cur) else { break };
            let (step, up) = match (n.parent, n.host, n.template_host) {
                (Some(p), _, _) => (self.child_index(cur) as f64, p),
                (None, Some(h), _) => (-1.0, h),
                (None, None, Some(t)) => (-2.0, t),
                _ => break,
            };
            out.push(step);
            cur = up;
        }
        if cur != anchor {
            out.truncate(at);
            out.push(-1.0);
            return;
        }
        out[at] = (out.len() - at - 1) as f64;
        out[at + 1..].reverse();
    }

    // `template`'s contents are `content` (or none) — and the handles' edges between them.
    pub(crate) fn set_template_content(&mut self, template: NodeId, content: Option<NodeId>) {
        let content = content.filter(|&c| self.get(c).is_some());
        let Some(old) = self.get_mut_quietly(template).map(|t| std::mem::replace(&mut t.template_content, content)) else { return };
        if let Some(old) = old.filter(|&o| Some(o) != content) {
            if let Some(o) = self.get_mut_quietly(old) {
                o.template_host = None;
            }
            self.reown(old);
        }
        if let Some(c) = content.and_then(|c| self.get_mut_quietly(c)) {
            c.template_host = Some(template);
        }
        self.reown(template);
    }
    // The handles' edges between `id` and the tree it owns outside its children (a shadow root, a template's contents)
    // and between `id` and its owner where it is such a tree's root — written from the slots' (`node_handle::own`).
    fn reown(&self, id: NodeId) {
        let Some(n) = self.get(id) else { return };
        let link = |k: Option<NodeId>| k.and_then(|k| self.get(k)).map(|d| &d.link);
        let owned = link(n.shadow_root.or(n.template_content));
        crate::node_handle::own(&n.link, owned);
        if let Some(owned) = owned {
            crate::node_handle::owned_by(owned, Some(&n.link));
        }
        if n.parent.is_none() {
            crate::node_handle::owned_by(&n.link, link(n.host.or(n.template_host)));
        }
    }

    // `slot`'s assigned nodes are `nodes` now; the ones it had and no longer has leave it. Returns the ones it had.
    pub(crate) fn set_assigned_nodes(&mut self, slot: NodeId, nodes: Vec<NodeId>) -> Vec<NodeId> {
        let Some(old) = self.get_mut(slot).map(|s| std::mem::take(&mut s.assigned)) else { return Vec::new() };
        for &n in &old {
            if let Some(node) = self.get_mut(n).filter(|node| node.assigned_slot == Some(slot)) {
                node.assigned_slot = None;
            }
        }
        let nodes: Vec<NodeId> = nodes.into_iter().filter(|&n| self.get(n).is_some()).collect();
        for &n in &nodes {
            if let Some(node) = self.get_mut(n) {
                node.assigned_slot = Some(slot);
            }
        }
        if let Some(s) = self.get_mut(slot) {
            s.assigned = nodes;
        }
        old
    }

    // Take `child` out of its parent's children (its own subtree goes with it). Found by its position, so taking the
    // first or the last child is O(1) and any other costs only the shift of the ones after it.
    pub(crate) fn detach(&mut self, child: NodeId) {
        self.state_epoch += 1;
        let Some(old) = self.get(child).and_then(|n| n.parent) else { return };
        let at = self.child_index(child);
        let (mut from, mut one) = (at, true);
        if let Some(o) = self.get_mut(old) {
            match o.children.get(at) {
                Some(&c) if c == child => {
                    o.children.remove(at);
                    // (…the first: the ones after it keep their positions, and the list starts one later)
                    if at == 0 {
                        o.first_position += 1;
                    }
                }
                _ => {
                    o.children.retain(|&c| c != child);
                    (from, one) = (0, false);
                }
            }
        }
        if from == 0 && one {
            self.relink(old, 0, 1);
        } else {
            self.reindex_children(old, from, one);
        }
        if let Some(c) = self.get_mut(child) {
            c.parent = None;
            crate::node_handle::unlink(&c.link);
        }
        // (…and the scroll offsets its subtree held go with its boxes: one put back in the tree starts at 0, Chrome's
        // answer for a scroller removed and inserted again — where one only `display: none` keeps its offset)
        if !self.scrolled_nodes.is_empty() {
            let (gone, kept): (Vec<NodeId>, Vec<NodeId>) =
                std::mem::take(&mut self.scrolled_nodes).into_iter().partition(|&n| self.under(n, child));
            self.scrolled_nodes = kept;
            for n in gone {
                if let Some(node) = self.get_mut_quietly(n) {
                    node.scroll = [0.0; 2];
                }
            }
        }
    }
    // Is `node` `ancestor` or in its subtree, shadow trees included?
    fn under(&self, node: NodeId, ancestor: NodeId) -> bool {
        let mut at = Some(node);
        while let Some(n) = at {
            if n == ancestor {
                return true;
            }
            at = self.get(n).and_then(|d| d.parent.or(d.host));
        }
        false
    }

    // Move `child` under `parent`, before `before` when that is one of its children, else last. Refused when it would
    // make a cycle (`child` is `parent` or one of its ancestors) — the matcher's ancestor walks assume none.
    pub(crate) fn insert_child(&mut self, parent: NodeId, child: NodeId, before: Option<NodeId>) {
        if self.get(parent).is_none() || self.get(child).is_none() {
            return;
        }
        self.state_epoch += 1;
        let mut p = Some(parent);
        while let Some(a) = p {
            if a == child {
                return;
            }
            p = self.get(a).and_then(|n| n.parent);
        }
        self.detach(child);
        // `before`'s place, by its position when it is a child of `parent`.
        let pos = match (before.and_then(|b| self.get(b).map(|n| (b, n))), self.get(parent)) {
            (Some((b, bn)), Some(pn)) if bn.parent == Some(parent) => {
                bn.index_in(pn).filter(|&i| pn.children[i] == b).or_else(|| pn.children.iter().position(|&c| c == b))
            }
            _ => None,
        };
        match pos {
            // (…at the front: the list starts one earlier, and the ones after keep their positions)
            Some(0) => {
                let mut first = 0;
                if let Some(pn) = self.get_mut(parent) {
                    pn.children.insert(0, child);
                    pn.first_position -= 1;
                    first = pn.first_position;
                }
                if let Some(c) = self.get_mut(child) {
                    c.parent = Some(parent);
                    c.position = first;
                }
                self.relink(parent, 0, 1);
            }
            Some(i) => {
                if let Some(pn) = self.get_mut(parent) {
                    pn.children.insert(i, child);
                }
                if let Some(c) = self.get_mut(child) {
                    c.parent = Some(parent);
                }
                self.reindex_children(parent, i, true);
            }
            None => {
                if let Some(c) = self.get_mut(child) {
                    c.parent = Some(parent);
                }
                self.link_child(parent, child);
            }
        }
    }

    // Rewrite the positions of the children of `parent` from index `from` on, from their list indexes — after an
    // insertion or a removal there shifted them. Quietly: the index is where to find a child in its parent's list, read
    // by nothing a layout walk or a memo keys on — the change itself is the parent's, which `get_mut` stamped. Stamped
    // as a change of each, every sibling after a removed child was walked again rather than spliced back (a 400-item
    // list, `remove()` of the 200th: 203 records walked, 3 once it is not).
    fn reindex_children(&mut self, parent: NodeId, from: usize, one: bool) {
        let (len, first) = self.get(parent).map_or((0, 0), |p| (p.children.len(), p.first_position));
        for i in from..len {
            let Some(c) = self.get(parent).and_then(|p| p.children.get(i).copied()) else { break };
            if let Some(node) = self.get_mut_quietly(c) {
                node.position = first + i as i64;
            }
        }
        // (…and the handles' edges, from the child before the first that moved: its next sibling did)
        self.relink(parent, from.saturating_sub(1), if one { from + 1 } else { usize::MAX });
    }

    // ── element-tree navigation (all gen-checked: a stale edge is skipped, never followed) ──
    // The ELEMENT view the matcher walks: a child, a sibling, is the nearest ELEMENT one — text, comments and doctypes
    // between elements are stepped over, as `firstElementChild` / `nextElementSibling` step over them.

    // `id`'s index in its parent's children (0 for a node with none).
    pub(crate) fn child_index(&self, id: NodeId) -> usize {
        let Some(n) = self.get(id) else { return 0 };
        // (…by its position, or where that drifted, by looking)
        n.parent.and_then(|p| self.get(p)).map_or(0, |p| {
            n.index_in(p).filter(|&i| p.children[i] == id).or_else(|| p.children.iter().position(|&c| c == id)).unwrap_or(0)
        })
    }
    pub(crate) fn parent_of(&self, id: NodeId) -> Option<NodeId> {
        let parent = self.get(id)?.parent?;
        // Only report a parent whose slot still holds that gen — a stale upward edge (parent freed +
        // reused) reads as no parent, so the node matches as a detached root rather than under an alias.
        self.get(parent).map(|_| parent)
    }
    pub(crate) fn first_element_child(&self, id: NodeId) -> Option<NodeId> {
        let node = self.get(id)?;
        node.children.iter().copied().find(|&c| self.is_element(c))
    }
    pub(crate) fn prev_element_sibling(&self, id: NodeId) -> Option<NodeId> {
        let node = self.get(id)?;
        let parent = self.get(node.parent?)?;
        // Step back from this child's position, skipping any stale edge, to the nearest live sibling.
        // With no stale edges (the synced document tree) this is the single `index - 1` step.
        let mut i = node.index_in(parent)?;
        while i > 0 {
            i -= 1;
            if let Some(&c) = parent.children.get(i) {
                if self.is_element(c) {
                    return Some(c);
                }
            }
        }
        None
    }
    pub(crate) fn next_element_sibling(&self, id: NodeId) -> Option<NodeId> {
        let node = self.get(id)?;
        let parent = self.get(node.parent?)?;
        let mut i = node.index_in(parent)? + 1;
        while let Some(&c) = parent.children.get(i) {
            if self.is_element(c) {
                return Some(c);
            }
            i += 1;
        }
        None
    }
    // Every element of the realm it holds the state of, whichever of its trees it is in.
    pub(crate) fn element_ids(&self) -> impl Iterator<Item = NodeId> + '_ {
        self.realm_nodes.get(&self.cur).into_iter().flatten().filter_map(|&i| {
            let slot = &self.slots[i as usize];
            let node = slot.data.as_ref()?;
            (node.kind == NodeKind::Element).then_some(NodeId { idx: i, generation: slot.generation })
        })
    }
    // An element's style slot, made on first use.
    pub(crate) fn style_slot(&self, id: NodeId) -> Option<&crate::style::StyleSlot> {
        self.get(id).filter(|n| n.kind == NodeKind::Element).map(|n| &**n.style.get_or_init(|| Box::new(crate::style::StyleSlot::of(n))))
    }
    // Any node's style slot, made on first use — a shadow root's and a document's hold their children's selector flags.
    pub(crate) fn node_style_slot(&self, id: NodeId) -> Option<&crate::style::StyleSlot> {
        self.get(id).map(|n| &**n.style.get_or_init(|| Box::new(crate::style::StyleSlot::of(n))))
    }
    // An element's style slot if the engine ever made it — none for an element it never styled.
    pub(crate) fn existing_style_slot(&self, id: NodeId) -> Option<&crate::style::StyleSlot> {
        self.get(id).filter(|n| n.kind == NodeKind::Element).and_then(|n| n.style.get()).map(|b| &**b)
    }
    // Is `id` a Document? (the matcher's `:root` is an element whose parent is one.)
    pub(crate) fn is_document(&self, id: NodeId) -> bool {
        self.get(id).is_some_and(|n| n.kind == NodeKind::Document)
    }
    pub(crate) fn is_element(&self, id: NodeId) -> bool {
        self.get(id).is_some_and(|n| n.kind == NodeKind::Element)
    }
    // `:empty`: no element child and no Text child with any data (comments and processing instructions do not count).
    pub(crate) fn is_empty(&self, id: NodeId) -> bool {
        let Some(node) = self.get(id) else { return true };
        node.children.iter().all(|&c| match self.get(c) {
            Some(child) => match child.kind {
                NodeKind::Element => false,
                NodeKind::Text => child.data.is_empty(),
                _ => true,
            },
            None => true,
        })
    }
    // The live element children of `root`, for the matcher's descendant walk (preorder seed).
    pub(crate) fn element_children(&self, id: NodeId) -> Vec<NodeId> {
        match self.get(id) {
            Some(node) => node.children.iter().copied().filter(|&c| self.is_element(c)).collect(),
            None => Vec::new(),
        }
    }
    // A stable count for the matcher's cycle backstop (see selector::query).
    pub(crate) fn slot_count(&self) -> usize {
        self.slots.len()
    }
}

// The per-isolate DOM: the node arena, with each realm's state (keyed by rusty_racer's context_id — main = 0,
// frames 1,2,…), plus the isolate-scoped instance templates every wrapper is stamped from. Reached from any
// callback via dom(scope); an op works in its realm's state by the context_id carried as each realm's `__dom`
// function data (see `realm_id` / `realm` / `install`). Templates serve every realm.
#[derive(Default)]
pub(crate) struct Dom {
    // The slots of the nodes V8 collected, to be freed (`node_handle::reclaim`).
    pub(crate) reclaim: std::sync::Arc<crate::node_handle::Reclaim>,
    // The handles of nodes that left a document, whose references go at the next node made (`node_handle::let_go`).
    pub(crate) let_go: Vec<NodeId>,
    // Every realm's nodes, and each realm's state (`RealmArena`).
    pub(crate) arena: RealmArena,
    // The store-flip's native-backed `_attrs`: a full named-interceptor view over a node's
    // attributes Vec (get/set/query/delete/enumerate/descriptor), so `el._attrs.foo`, `for..in`,
    // `hasOwnProperty`, `Object.keys`, `delete` all work against the arena in C++ — faster than a
    // JS Proxy and a faithful stand-in for the native-backed endgame.
    attrs_view_template: Option<v8::Global<v8::ObjectTemplate>>,
    // The template every node's object is made from (`node_handle`, `__dom.NodeBase`).
    pub(crate) node_template: Option<v8::Global<v8::FunctionTemplate>>,
    // Every live range's boundary points (ranges.rs).
    pub(crate) ranges: crate::ranges::Ranges,
    // Each realm's style engine (made by `styleSheets`).
    pub(crate) styles: std::collections::HashMap<i32, crate::style::StyleEngine>,
    // Each realm's Rust walk's last pass and the measures kept of it (`walk_reuse`).
    pub(crate) walk_reuse: std::collections::HashMap<i32, crate::walk_reuse::WalkReuse>,
    // Whether the session's pointer is a touchscreen (`setTouchInput`): what every realm's device answers `pointer` /
    // `hover` by (style.rs `Screen`).
    pub(crate) touch_input: bool,
}

// Borrow the isolate's Dom, lazily creating the slot on first touch. rusty_v8
// stores slots in a TypeId->value map, so this `Dom` coexists with rusty_racer's
// own IsolateState slot without either knowing about the other. Used in SHORT
// bursts (the borrow is released before any V8 call), the same discipline
// rusty_racer's istate! macro follows — and, like it, the borrow checker enforces
// it: get_slot_mut borrows the scope, which every V8 call also needs.
pub(crate) fn dom<'s>(scope: &'s mut v8::PinScope<'_, '_>) -> &'s mut Dom {
    if scope.get_slot::<Dom>().is_none() {
        scope.set_slot(Dom::default());
    }
    scope
        .get_slot_mut::<Dom>()
        .expect("Dom slot was just set")
}

// The context_id of the realm whose `__dom` invoked this callback — carried as each realm's `__dom`
// function DATA (set in `install`), so an op works in its OWN realm's state. `0` (main) when
// unset. This is how the isolate-global `Dom` is partitioned per realm without threading a realm id
// through the JS op signatures.
pub(crate) fn realm_id(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> i32 {
    args.data().int32_value(scope).unwrap_or(0)
}

// The arena, holding realm `cid`'s state (`RealmArena::enter`) — the realm whose `__dom` an op was called through.
pub(crate) fn realm<'s>(scope: &'s mut v8::PinScope<'_, '_>, cid: i32) -> &'s mut RealmArena {
    dom(scope).arena.enter(cid)
}

// Nodes the engine answers with, under `anchor`, to the page side: their objects, where every one is in a document (its
// handle holds its object, node_handle.rs) — else each one's path from the anchor (`RealmArena::push_path`), a
// Float64Array the page side walks (native-query-shadow.js `nodesAtPaths`).
pub(crate) fn nodes_value<'s>(scope: &mut v8::PinScope<'s, '_>, cid: i32, anchor: NodeId, ids: &[NodeId]) -> v8::Local<'s, v8::Value> {
    let arena = realm(scope, cid);
    let held: Option<Vec<crate::node_handle::HeldObject>> =
        ids.iter().map(|&id| arena.get(id).and_then(|n| crate::node_handle::held(&n.link))).collect();
    // (…the objects read before anything is allocated: a collection in between could take a handle)
    let objects: Option<Vec<v8::Local<'s, v8::Value>>> = held.and_then(|held| held.iter().map(|h| h.get(scope).map(Into::into)).collect());
    if let Some(objects) = objects {
        return v8::Array::new_with_elements(scope, &objects).into();
    }
    let arena = realm(scope, cid);
    let mut out = Vec::new();
    for &id in ids {
        arena.push_path(anchor, id, &mut out);
    }
    f64_array(scope, &out).into()
}

// The arena for realm `cid` and its style engine, for a change the engine has to hear of — the engine's change hooks
// (`attributes_will_change`, `children_changed`, `node_left`, …) are Firefox's restyle manager, called where the DOM changes.
fn arena_and_engine<'s>(
    scope: &'s mut v8::PinScope<'_, '_>,
    cid: i32,
) -> (&'s mut RealmArena, Option<&'s mut crate::style::StyleEngine>) {
    let d = dom(scope);
    (d.arena.enter(cid), d.styles.get_mut(&cid))
}

// Whether a node can decide a directionality of its own (`is_rtl`): a `dir` on it, or its being a `<bdi>` or a telephone
// `<input>` — a telephone one only: almost every app page has an input, and each one latched the whole realm into the
// per-element walk (a 1500-row append 290 → 530 ms).
fn notes_direction(n: &NodeData) -> bool {
    n.kind == NodeKind::Element
        && (n.plain_attr("dir").is_some() || n.is_html_named("bdi") || (n.is_html_named("input") && n.input_type() == "tel"))
}

// An attribute write to `id` of the attributes `names`, about to land: the style engine hears of it first, and a name
// a state can read moves the state epoch (a class, a style and data / ARIA attributes are read by none).
fn before_attribute_write(arena: &mut RealmArena, engine: Option<&mut crate::style::StyleEngine>, id: NodeId, names: &[&str]) {
    // (…and a `type` written may make an input a telephone one: latched on the write, as the value lands after this)
    arena.direction_sources |= names.contains(&"dir") || (names.contains(&"type") && arena.get(id).is_some_and(|n| n.is_html_named("input")));
    if names.iter().any(|n| attribute_reads_state(n)) {
        arena.state_epoch += 1;
    }
    if let Some(engine) = engine {
        engine.attributes_will_change(arena, id, names);
    }
}

// Can an element's state read the attribute `name`? Any but a class, a style and data / ARIA attributes can — an id
// included: `:target` names one, and `<input form=…>` finds its form owner by one.
pub(crate) fn attribute_reads_state(name: &str) -> bool {
    !(matches!(name, "class" | "style") || name.starts_with("data-") || name.starts_with("aria-"))
}

// A NodeId argument off the JS wire: reads arg `i` as a Number and unpacks it, or None for a negative
// sentinel / non-number. Does NOT check liveness — the op does that via `realm(...).get(id)`.
pub(crate) fn nid_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, i: i32) -> Option<NodeId> {
    // (…a number only: `null` or `undefined` — a node with no slot — is no node, not slot 0)
    let v = args.get(i);
    if !v.is_number() {
        return None;
    }
    v.integer_value(scope).and_then(NodeId::from_i64)
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
    // A new context for a realm id the arena has seen (main's, at every warm reset): nothing of the old context is
    // reachable from it any more, so its nodes go now, as they would one by one as V8 collected them.
    dom(scope).arena.realm_begins(context_id);
    // What the style engine parses — a property, a selector — is what a page's CSSOM may ask about before any style is
    // computed (an inline script runs before the first flush), so the switches that decide it are set first.
    crate::style::enable_properties();

    // The arena for this realm is created lazily (realm(scope, cid) on first touch) and cleared per
    // page by resetArena, so a re-installed realm (main = context_id 0 on every reset) reuses its slot
    // rather than accumulating. Each op below carries `context_id` as its function data so it works in
    // THIS realm's state.
    let ns = v8::Object::new(scope);
    // The constructor every node's object is made through (node_handle.rs).
    if let Some(base) = crate::node_handle::base_function(scope) {
        let key = v8::String::new(scope, "NodeBase").expect("a short string");
        ns.set(scope, key.into(), base.into());
    }
    // …the constructor every live range's object is made through, and the ops on its boundary points (ranges.rs)
    if let Some(base) = crate::ranges::base_function(scope) {
        let key = v8::String::new(scope, "RangeBase").expect("a short string");
        ns.set(scope, key.into(), base.into());
    }
    crate::ranges::install(scope, ns, context_id);
    // …and an attribute's token set (token_list.rs)
    crate::token_list::install(scope, ns, context_id);
    // …and the element lists named by a filter (collections.rs)
    crate::collections::install(scope, ns, context_id);
    // …and the tree mutation algorithms' checks (mutation.rs)
    crate::mutation::install(scope, ns, context_id);
    // …and where one node is against another (traversal.rs)
    crate::traversal::install(scope, ns, context_id);
    // …and the namespace lookups (namespaces.rs)
    crate::namespaces::install(scope, ns, context_id);
    // …and the realm's id, which spaces its nodes' handle ids apart from every other realm's (dom-nodes.js `Node`).
    let key = v8::String::new(scope, "realmId").expect("a short string");
    let id = v8::Integer::new(scope, context_id);
    ns.set(scope, key.into(), id.into());
    // Bulk import + id-level query: build the arena from an already-parsed page (importNode /
    // syncChildren) and match over it natively (query / matchesId).
    register(scope, ns, "importNode", import_node, context_id);
    // Every other node kind, character-data changes, and the parser's per-node tree steps.
    register(scope, ns, "createNode", create_node, context_id);
    register(scope, ns, "setData", set_data, context_id);
    register(scope, ns, "appendData", append_data, context_id);
    register(scope, ns, "insertChild", insert_child, context_id);
    register(scope, ns, "removeChild", remove_child, context_id);
    register(scope, ns, "inspectNode", inspect_node, context_id);
    // Element state no attribute carries, for the state pseudo-classes (`:checked`, `:focus`, `:hover`, …).
    register(scope, ns, "setState", set_state, context_id);
    register(scope, ns, "setNaturalSize", set_natural_size, context_id);
    register(scope, ns, "linkPseudoBox", link_pseudo_box, context_id);
    register(scope, ns, "directionality", directionality, context_id);
    register(scope, ns, "setTemplateContent", set_template_content, context_id);
    register(scope, ns, "setDoctype", set_doctype, context_id);
    register(scope, ns, "setIsValue", set_is_value, context_id);
    register(scope, ns, "setContainerMargins", set_container_margins, context_id);
    register(scope, ns, "setShadowHost", set_shadow_host, context_id);
    // Slot assignment (slots.rs): what each slot is assigned, run over a shadow tree as what it depends on changes, and
    // read back by its slots and its slottables.
    register(scope, ns, "assignSlots", assign_slots, context_id);
    register(scope, ns, "setManualAssigned", set_manual_assigned, context_id);
    register(scope, ns, "assignedSlotOf", assigned_slot_of, context_id);
    register(scope, ns, "assignedNodesOf", assigned_nodes_of, context_id);
    register(scope, ns, "setValue", set_value, context_id);
    register(scope, ns, "setParserFormOwner", set_parser_form_owner, context_id);
    register(scope, ns, "setCustomStates", set_custom_states, context_id);
    register(scope, ns, "setTarget", set_target, context_id);
    register(scope, ns, "setFocusRingHidden", set_focus_ring_hidden, context_id);
    register(scope, ns, "query", query, context_id);
    register(scope, ns, "matchesId", matches_id, context_id);
    register(scope, ns, "closestId", closest_id, context_id);
    register(scope, ns, "selectorValid", selector_valid, context_id);
    register(scope, ns, "xpathPrefixes", xpath_prefixes, context_id);
    register(scope, ns, "xpathEvaluate", xpath_evaluate, context_id);
    register(scope, ns, "resetArena", reset_arena, context_id);
    // The style engine (stylo): a document's sheets and the sheets their `@import`s ask for, and an element's computed
    // value.
    register(scope, ns, "styleSheets", style_sheets, context_id);
    register(scope, ns, "styleImport", style_import, context_id);
    register(scope, ns, "styleSheetFacts", style_sheet_facts, context_id);
    register(scope, ns, "styleShadowSheets", style_shadow_sheets, context_id);
    // …the realm's sheets they are made of (sheets.rs).
    register(scope, ns, "sheetMake", sheet_make, context_id);
    register(scope, ns, "sheetReplace", sheet_replace, context_id);
    register(scope, ns, "sheetDrop", sheet_drop, context_id);
    // …and CSSOM's rules over them (cssom_rule.rs).
    register(scope, ns, "sheetRules", sheet_rules, context_id);
    register(scope, ns, "sheetVersion", sheet_version, context_id);
    register(scope, ns, "ruleRules", rule_rules, context_id);
    register(scope, ns, "ruleText", rule_text, context_id);
    register(scope, ns, "ruleGet", rule_get, context_id);
    register(scope, ns, "ruleSet", rule_set, context_id);
    register(scope, ns, "ruleInsert", rule_insert, context_id);
    register(scope, ns, "ruleDelete", rule_delete, context_id);
    register(scope, ns, "keyframeAppend", keyframe_append, context_id);
    register(scope, ns, "keyframeFind", keyframe_find, context_id);
    register(scope, ns, "keyframeDelete", keyframe_delete, context_id);
    register(scope, ns, "importSheet", import_sheet, context_id);
    register(scope, ns, "ruleDrop", rule_drop, context_id);
    register(scope, ns, "sheetMedia", sheet_media, context_id);
    register(scope, ns, "mediaText", media_text, context_id);
    register(scope, ns, "styleValue", style_value, context_id);
    register(scope, ns, "styleProperties", style_properties, context_id);
    // CSSOM's declaration blocks, over the engine's (cssom_decl.rs): each takes the block's TEXT, its kind and the
    // document's mode.
    register(scope, ns, "declValue", decl_value, context_id);
    register(scope, ns, "declImportant", decl_important, context_id);
    register(scope, ns, "declText", decl_text, context_id);
    register(scope, ns, "declNames", decl_names, context_id);
    register(scope, ns, "declSet", decl_set, context_id);
    register(scope, ns, "declRemove", decl_remove, context_id);
    register(scope, ns, "declReplace", decl_replace, context_id);
    register(scope, ns, "declSupports", decl_supports, context_id);
    register(scope, ns, "declSupportsCondition", decl_supports_condition, context_id);
    register(scope, ns, "cssNumber", css_number, context_id);
    register(scope, ns, "mediaMatches", media_matches, context_id);
    register(scope, ns, "cssColor", css_color, context_id);
    register(scope, ns, "canvasFont", canvas_font, context_id);
    register(scope, ns, "canvasSpacing", canvas_spacing, context_id);
    register(scope, ns, "fontShorthandFamilies", font_shorthand_families, context_id);
    register(scope, ns, "setTouchInput", set_touch_input, context_id);
    register(scope, ns, "styleGenerated", style_generated, context_id);
    register(scope, ns, "styleRestyled", style_restyled, context_id);
    register(scope, ns, "styleFlush", style_flush, context_id);
    register(scope, ns, "styleTick", style_tick, context_id);
    register(scope, ns, "styleTakeAnimationEvents", style_take_animation_events, context_id);
    crate::animation_ops::install(scope, ns, context_id);
    crate::walk_ops::install(scope, ns, context_id);
    crate::geometry::install(scope, ns, context_id);
    crate::hit_test::install(scope, ns, context_id);
    crate::scroll_into_view::install(scope, ns, context_id);
    crate::rendered::install(scope, ns, context_id);
    crate::focus::install(scope, ns, context_id);
    crate::resolved::install(scope, ns, context_id);
    crate::mime::install(scope, ns, context_id);
    crate::font_faces::install(scope, ns, context_id);
    crate::canvas::install(scope, ns, context_id);
    crate::canvas_path::install(scope, ns, context_id);
    crate::text::install(scope, ns, context_id);
    crate::dom_matrix::install(scope, ns, context_id);
    crate::validity::install(scope, ns, context_id);
    crate::input_value::install(scope, ns, context_id);
    crate::image_source::install(scope, ns, context_id);
    crate::image_decode::install(scope, ns, context_id);
    crate::image_encode::install(scope, ns, context_id);
    crate::video::install(scope, ns, context_id);
    crate::serialize::install(scope, ns, context_id);
    crate::html_parse::install(scope, ns, context_id);
    crate::url_ops::install(scope, ns, context_id);
    crate::text_codec::install(scope, ns, context_id);
    crate::document_encoding::install(scope, ns, context_id);
    register(scope, ns, "nowNanos", now_nanos, context_id);
    // Incremental-sync primitives (the store-flip F1 foundation): keep the arena current
    // as the DOM mutates, instead of rebuilding it. syncChildren relinks one parent's
    // element children; setAttr/removeAttr mirror attribute writes.
    register(scope, ns, "syncChildren", sync_children, context_id);
    register(scope, ns, "syncAttrs", sync_attrs, context_id);
    register(scope, ns, "setAttrNamespace", set_attr_namespace, context_id);
    // The store-flip's native-backed `_attrs`: __dom.attrsView(nid) -> an interceptor object over
    // that node's attributes (the Element constructor installs it in place of the JS `{}`).
    register(scope, ns, "attrsView", attrs_view, context_id);
    register(scope, ns, "adoptSubtree", adopt_subtree, context_id);
    // …and a node's object, held by its handle while the node is in a document (node_handle.rs)
    register(scope, ns, "holdObjects", crate::node_handle::hold_objects, context_id);
    register(scope, ns, "releaseObjects", crate::node_handle::release_objects, context_id);
    register(scope, ns, "handleEdgesMismatch", handle_edges_mismatch, context_id);
    // Free a disposed realm's state and nodes — csim calls this before tearing down a frame realm (main
    // reuses id 0). Takes an explicit id (the realm being dropped), not the caller's own.
    register(scope, ns, "dropRealm", drop_realm, context_id);
    // The layout walk's reuse counts (the pass itself, `layoutBuild`, is walk_ops.rs's).
    register(scope, ns, "layoutMeasureCounts", layout_measure_counts, context_id);
    // Native text metrics (fontations) for inline layout: register a font (fontconfig path or in-memory
    // SFNT bytes) to a handle the JS side names its faces by (`walkFace`); layout measures runs in-process.
    register(scope, ns, "registerFontPath", register_font_path, context_id);
    register(scope, ns, "registerFontScaled", register_font_scaled, context_id);
    register(scope, ns, "registerFontStack", register_font_stack, context_id);
    if let Some(key) = v8::String::new(scope, "__dom") {
        let global = context.global(scope);
        global.set(scope, key.into(), ns.into());
    }
}

// Register one `__dom.<name>` for a realm, carrying the realm's `context_id` as the function's DATA so
// `realm_id(scope, &args)` can work in that realm's state (each realm gets its own `__dom` with
// its own functions, so the data is per-realm).
pub(crate) fn register(
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

// __dom.importNode(localName, ns, parentNid, attrsFlat, prefix, node) -> nid. Adds an ELEMENT to the arena — the eager
// create at construction, and a spec's bulk build. `attrsFlat` is a flat [name, value, name, value, …] array;
// `parentNid` < 0 makes a root, else the node is appended to that (live) parent; `prefix` a string, or none; `node`
// the element's object, whose handle holds the slot from now on (`node_handle::bind`).
fn import_node(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let local_name = LocalName::from(args.get(0).to_rust_string_lossy(scope));
    let (ns, ns_u16) = read_v8_value(scope, args.get(1));
    let parent = nid_arg(scope, &args, 2);
    let (attributes, attr_u16) = read_attrs_flat(scope, args.get(3));
    let (prefix, prefix_u16) = match args.get(4).is_string() {
        true => {
            let (lossy, exact) = read_v8_value(scope, args.get(4));
            (Some(lossy), exact)
        }
        false => (None, None),
    };
    // (…exactly, beside, where either lost a lone surrogate)
    let name_u16 = (ns_u16.is_some() || prefix_u16.is_some()).then(|| {
        let prefix_units = prefix.as_ref().map(|p| prefix_u16.unwrap_or_else(|| p.encode_utf16().collect()));
        Box::new((ns_u16.unwrap_or_else(|| ns.encode_utf16().collect()), prefix_units))
    });
    let (ns, prefix) = (Namespace::from(ns), prefix.map(String::into_boxed_str));
    let cid = realm_id(scope, &args);
    crate::node_handle::reclaim(dom(scope));
    let (arena, engine) = arena_and_engine(scope, cid);
    let id = arena.create(
        NodeData { local_name, ns, prefix, name_u16, attributes, attr_u16, ..NodeData::of_kind(NodeKind::Element, Vec::new()) },
        parent,
    );
    if let (Some(engine), Some(p)) = (engine, parent) {
        engine.children_changed(arena, p);
    }
    crate::node_handle::bind(scope, args.get(5), id);
    set_nid(scope, &mut rv, id);
}

// __dom.createNode(nodeType, data, parentNid, target, systemId, node) -> nid. Adds any other node — a Text / CDATA /
// Comment / PI with its data (and a PI its target), a Document, a DocumentFragment or ShadowRoot, a DocumentType (its
// name the data, its public identifier the target) — appended to `parentNid` when that is live; `node` its object, as
// importNode's.
fn create_node(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let node_type = args.get(0).integer_value(scope).unwrap_or(0);
    let kind = NodeKind::from_node_type(node_type);
    let data = utf16_arg(scope, args.get(1));
    let doctype_ids = (node_type == 10)
        .then(|| Box::new((utf16_arg(scope, args.get(3)), utf16_arg(scope, args.get(4)))));
    let parent = nid_arg(scope, &args, 2);
    let local_name = if kind == NodeKind::ProcessingInstruction {
        LocalName::from(args.get(3).to_rust_string_lossy(scope))
    } else {
        LocalName::default()
    };
    let cid = realm_id(scope, &args);
    crate::node_handle::reclaim(dom(scope));
    let (arena, engine) = arena_and_engine(scope, cid);
    let id = arena.create(NodeData { local_name, cdata: node_type == 4, doctype_ids, ..NodeData::of_kind(kind, data) }, parent);
    if let (Some(engine), Some(p)) = (engine, parent) {
        engine.children_changed(arena, p);
    }
    crate::node_handle::bind(scope, args.get(5), id);
    set_nid(scope, &mut rv, id);
}

// A string argument's UTF-16 code units, exactly (empty for a non-string).
pub(crate) fn utf16_arg(scope: &mut v8::PinScope<'_, '_>, val: v8::Local<'_, v8::Value>) -> Vec<u16> {
    let Ok(s) = v8::Local::<v8::String>::try_from(val) else { return Vec::new() };
    let mut u = vec![0u16; s.length()];
    s.write_v2(scope, 0, &mut u, v8::WriteFlags::empty());
    u
}

// __dom.setData(nid, data): a Text / Comment node's character data became `data`.
fn set_data(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let data = utf16_arg(scope, args.get(1));
    let cid = realm_id(scope, &args);
    let (arena, engine) = arena_and_engine(scope, cid);
    // (Text is a state input: a textarea's default value, an option's.)
    arena.state_epoch += 1;
    let mut had_text = false;
    if let Some(node) = arena.get_mut(id) {
        had_text = !node.data.is_empty();
        node.data = data;
    }
    text_changed(arena, engine, id, had_text);
}

// A text node's data moved: all a selector can see of it is whether there is any (`:empty`, and a `:has()` asking
// that), so only a change between none and some is a change to its parent's children as the style engine counts them.
// Anything else restyles nothing — a text edit under a page with a `:has()` rule anywhere restyled the whole document.
fn text_changed(arena: &mut RealmArena, engine: Option<&mut crate::style::StyleEngine>, id: NodeId, had_text: bool) {
    let has_text = arena.get(id).is_some_and(|n| !n.data.is_empty());
    if has_text == had_text {
        return;
    }
    if let (Some(engine), Some(p)) = (engine, arena.parent_of(id)) {
        engine.children_changed(arena, p);
    }
}

// __dom.appendData(nid, data): `data` was appended to a Text / Comment node's character data — the parser's text
// coalescing and `appendData`, which a whole-string setData per append made quadratic.
fn append_data(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let data = utf16_arg(scope, args.get(1));
    let cid = realm_id(scope, &args);
    let (arena, engine) = arena_and_engine(scope, cid);
    arena.state_epoch += 1;
    let mut had_text = false;
    if let Some(node) = arena.get_mut(id) {
        had_text = !node.data.is_empty();
        node.data.extend_from_slice(&data);
    }
    text_changed(arena, engine, id, had_text);
}

// __dom.insertChild(parentNid, childNid, beforeNid): the child is moved to `parentNid`, before `beforeNid` (a live child
// of it) or at the end. The parser's per-node step — one call per inserted node instead of re-listing the parent.
fn insert_child(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let (Some(parent), Some(child)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else {
        return;
    };
    let before = nid_arg(scope, &args, 2);
    let cid = realm_id(scope, &args);
    let (arena, mut engine) = arena_and_engine(scope, cid);
    let old = arena.parent_of(child);
    if let (Some(engine), Some(_)) = (engine.as_deref_mut(), old) {
        engine.node_left(arena, child);
    }
    arena.insert_child(parent, child, before);
    if let Some(engine) = engine {
        if let Some(o) = old.filter(|&o| o != parent) {
            engine.children_changed(arena, o);
        }
        engine.children_changed(arena, parent);
    }
}

// __dom.setState(nid, bits): the element's state bits (`STATE_*`) become `bits`.
fn set_state(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let bits = args.get(1).uint32_value(scope).unwrap_or(0);
    let cid = realm_id(scope, &args);
    realm(scope, cid).set_state(id, bits);
}

// __dom.setValue(nid, value): a form control's live value — a string once dirty, `undefined` back to its default.
fn set_value(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let v = args.get(1);
    let value = if v.is_undefined() { None } else { Some(utf16_arg(scope, v).into_boxed_slice()) };
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    arena.state_epoch += 1;
    if let Some(node) = arena.get_mut(id) {
        node.value = value;
    }
}

// __dom.setDoctype(nid, name, publicId, systemId): a doctype's name and identifiers, as a reused document's next parse
// gives them.
fn set_doctype(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let name = utf16_arg(scope, args.get(1));
    let ids = Box::new((utf16_arg(scope, args.get(2)), utf16_arg(scope, args.get(3))));
    let cid = realm_id(scope, &args);
    if let Some(node) = realm(scope, cid).get_mut_quietly(id) {
        node.data = name;
        node.doctype_ids = Some(ids);
    }
}

// __dom.setTemplateContent(nid, contentNid): a `<template>`'s contents, the fragment `contentNid` (-1 for none).
fn set_template_content(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let content = nid_arg(scope, &args, 1);
    let cid = realm_id(scope, &args);
    realm(scope, cid).set_template_content(id, content);
}

// __dom.setIsValue(nid, value): the `is` value an element was made with (null for none).
fn set_is_value(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let v = args.get(1);
    let value = (!v.is_null_or_undefined()).then(|| utf16_arg(scope, v).into_boxed_slice());
    let cid = realm_id(scope, &args);
    if let Some(node) = realm(scope, cid).get_mut_quietly(id) {
        node.is_value = value;
    }
}

// An image's natural dimensions and ratio (CSS Images 3 §4.1): a raster image's width and height; an SVG image's from
// its root's `width` and `height` (absolute lengths) and `viewBox` — any of which it may not have.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct NaturalSize {
    pub(crate) width: Option<f64>,
    pub(crate) height: Option<f64>,
    pub(crate) view_box: Option<(f64, f64)>,
}

impl NaturalSize {
    // A raster image's.
    pub(crate) fn sized(width: f64, height: f64) -> NaturalSize {
        NaturalSize { width: Some(width), height: Some(height), view_box: None }
    }
    // The concrete size it is drawn at where nothing else sizes it (CSS Images 3 §5.2, the default sizing algorithm
    // with no specified size): its own dimensions, a missing one from the other through the view box's ratio, else the
    // default object size (300 × 150) — contained, keeping the ratio, where only a ratio is known.
    pub(crate) fn concrete(self) -> (f64, f64) {
        let ratio = self.view_box.map(|(w, h)| w / h);
        match (self.width, self.height, ratio) {
            (Some(w), Some(h), _) => (w, h),
            (Some(w), None, r) => (w, r.map_or(150.0, |r| w / r)),
            (None, Some(h), r) => (r.map_or(300.0, |r| h * r), h),
            (None, None, Some(r)) => if r >= 2.0 { (300.0, 300.0 / r) } else { (150.0 * r, 150.0) },
            (None, None, None) => (300.0, 150.0),
        }
    }
}

// __dom.setNaturalSize(nid[, width, height, viewBoxWidth, viewBoxHeight]): an `<img>`'s decoded image's natural size
// (`NaturalSize`; NaN for one it has not) — or, with nothing after the nid, none: nothing decoded.
fn set_natural_size(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let [w, h, vw, vh] = [1, 2, 3, 4].map(|k| args.get(k).number_value(scope).filter(|v| v.is_finite() && *v >= 0.0));
    let natural = (args.length() > 1).then(|| NaturalSize {
        width: w,
        height: h,
        view_box: vw.zip(vh).filter(|&(vw, vh)| vw > 0.0 && vh > 0.0),
    });
    let cid = realm_id(scope, &args);
    if let Some(node) = realm(scope, cid).get_mut(id) {
        node.natural_size = natural;
    }
}

// __dom.directionality(nid) -> whether the element's directionality is rtl (`element_state::is_rtl`, what `:dir()`
// matches).
fn directionality(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = realm_id(scope, &args);
    let Some(id) = nid_arg(scope, &args, 0) else { return rv.set_bool(false) };
    rv.set_bool(realm(scope, cid).is_rtl(id));
}

// __dom.setContainerMargins(bodyNid, marginwidth, marginheight): the frame's two attributes as they stand (`null` for
// one it lacks), and the body to restyle where they changed (-1 before the document has one).
fn set_container_margins(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let mut margins = [None, None];
    for (i, m) in margins.iter_mut().enumerate() {
        let v = args.get(i as i32 + 1);
        if !v.is_null_or_undefined() {
            *m = Some(v.to_rust_string_lossy(scope));
        }
    }
    let body = nid_arg(scope, &args, 0);
    let cid = realm_id(scope, &args);
    let (arena, engine) = arena_and_engine(scope, cid);
    if arena.container_margins == margins {
        return;
    }
    if let Some(id) = body {
        before_attribute_write(arena, engine, id, &["marginwidth", "marginheight"]);
    }
    arena.container_margins = margins;
    if let Some(node) = body.and_then(|id| arena.get_mut(id)) {
        node.attr_changed(Some("marginwidth"));
    }
}


// __dom.linkPseudoBox(nid, which, boxNid): the box an element's `::before` (0) or `::after` (1) generates.
fn link_pseudo_box(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let (Some(id), Some(pseudo)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 2)) else {
        return;
    };
    let which = (args.get(1).number_value(scope).unwrap_or(0.0) as usize).min(1);
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    if let Some(node) = arena.get_mut(id) {
        node.pseudo_boxes[which] = Some(pseudo);
    }
    if let Some(node) = arena.get_mut_quietly(pseudo) {
        node.generated_of = Some((id, which as u8));
    }
}

// __dom.setParserFormOwner(nid, formNid): the form the parser gave this control — or none (`formNid` -1).
fn set_parser_form_owner(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let form = nid_arg(scope, &args, 1);
    let cid = realm_id(scope, &args);
    realm(scope, cid).set_parser_form_owner(id, form);
}

// __dom.setCustomStates(nid, names): the element's custom states (`ElementInternals.states`) become `names`.
fn set_custom_states(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let mut states = Vec::new();
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(args.get(1)) {
        for i in 0..arr.length() {
            if let Some(v) = arr.get_index(scope, i) {
                states.push(v.to_rust_string_lossy(scope));
            }
        }
    }
    let cid = realm_id(scope, &args);
    let (arena, engine) = arena_and_engine(scope, cid);
    arena.set_custom_states(id, states);
    if let Some(engine) = engine {
        engine.custom_states_changed(arena, id);
    }
}

// __dom.setTarget(docNid, fragments): the realm document's target fragments (target.js `targetFragments`) — none, one,
// or the raw one and its decoded form.
fn set_target(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(doc) = nid_arg(scope, &args, 0) else {
        return;
    };
    let mut fragments = Vec::new();
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(args.get(1)) {
        for i in 0..arr.length() {
            if let Some(v) = arr.get_index(scope, i) {
                fragments.push(v.to_rust_string_lossy(scope));
            }
        }
    }
    let cid = realm_id(scope, &args);
    realm(scope, cid).set_target(doc, fragments);
}

// __dom.setShadowHost(rootNid, hostNid, delegatesFocus): the shadow root `rootNid` is attached to `hostNid`.
fn set_shadow_host(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let (Some(root), Some(host)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else {
        return;
    };
    let cid = realm_id(scope, &args);
    let (arena, engine) = arena_and_engine(scope, cid);
    arena.set_shadow_host(root, host, args.get(2).is_true(), args.get(3).is_true());
    if let Some(engine) = engine {
        engine.shadow_attached(arena, host);
    }
}

// The nids a JS array lists (an entry that is none skipped).
fn nids_arg(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Vec<NodeId> {
    let Ok(arr) = v8::Local::<v8::Array>::try_from(value) else { return Vec::new() };
    (0..arr.length())
        .filter_map(|i| arr.get_index(scope, i).and_then(|v| v.integer_value(scope)).and_then(NodeId::from_i64))
        .collect()
}
// __dom.assignSlots(rootNid, [slotNid, …]) -> [slot, count, node, …, slot, …]: assign the slots of the shadow tree
// `rootNid` (-1 for none) and the slots listed (ones that left it, assigned what their own tree now gives them), and
// answer each slot whose assigned nodes changed with the nodes that left it — for the caller's `slotchange` and layout
// marks. A slot listed is answered by its index in the list, any other by -1 and its path; a node by its path. Every
// path is from the shadow-including root of the tree `rootNid` is in — or, without one, of the slot's.
fn assign_slots(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let root = nid_arg(scope, &args, 0);
    let extra = nids_arg(scope, args.get(1));
    let cid = realm_id(scope, &args);
    let (arena, mut engine) = arena_and_engine(scope, cid);
    let changed = crate::slots::assign(arena, root, &extra, |arena, slot, old, now| {
        if let Some(engine) = engine.as_deref_mut() {
            for &n in old.iter().filter(|n| !now.contains(n)).chain(now.iter().filter(|n| !old.contains(n))) {
                engine.node_left(arena, n);
            }
            engine.slot_assignment_changed(arena, slot);
        }
    });
    let tree = root.map(|r| arena.shadow_including_root(r));
    let mut out = Vec::new();
    for c in &changed {
        let anchor = tree.unwrap_or_else(|| arena.shadow_including_root(c.slot));
        match extra.iter().position(|&s| s == c.slot) {
            Some(i) => out.push(i as f64),
            None => {
                out.push(-1.0);
                arena.push_path(anchor, c.slot, &mut out);
            }
        }
        out.push(c.left.len() as f64);
        for &n in &c.left {
            arena.push_path(anchor, n, &mut out);
        }
    }
    rv.set(f64_array(scope, &out).into());
}

// __dom.setManualAssigned(slotNid, [nid, …]): the nodes `assign()`ed to a slot, in that order (those in this arena).
fn set_manual_assigned(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(slot) = nid_arg(scope, &args, 0) else { return };
    let nodes = nids_arg(scope, args.get(1));
    let cid = realm_id(scope, &args);
    if let Some(s) = realm(scope, cid).get_mut_quietly(slot) {
        s.manual_assigned = nodes;
    }
}

// __dom.assignedSlotOf(nid, anchorNid) -> the slot a slottable is assigned to (HTML "find a slot"), none or it, as
// `nodes_value` answers from `anchorNid` (the slottable's host, where the caller walks it from).
fn assigned_slot_of(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let (Some(id), Some(anchor)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 1)) else { return };
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let slot = arena.get(id).and_then(|n| n.assigned_slot).filter(|&s| arena.get(s).is_some());
    let answer = nodes_value(scope, cid, anchor, slot.as_slice());
    rv.set(answer);
}

// __dom.assignedNodesOf(slotNid, flatten, anchorNid) -> a slot's assigned nodes ("find slottables"), or with `flatten`
// its flattened ones ("find flattened slottables"), as `nodes_value` answers them from `anchorNid`.
fn assigned_nodes_of(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let (Some(slot), Some(anchor)) = (nid_arg(scope, &args, 0), nid_arg(scope, &args, 2)) else { return };
    let flatten = args.get(1).is_true();
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let ids = if flatten {
        let mut out = Vec::new();
        crate::slots::flattened(arena, slot, &mut out);
        out
    } else {
        arena.get(slot).map_or(Vec::new(), |s| s.assigned.clone())
    };
    let answer = nodes_value(scope, cid, anchor, &ids);
    rv.set(answer);
}

// __dom.setFocusRingHidden(hidden): whether the realm's focus shows no ring (`:focus-visible` does not match).
fn set_focus_ring_hidden(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let hidden = args.get(0).boolean_value(scope);
    let cid = realm_id(scope, &args);
    realm(scope, cid).set_focus_ring_hidden(hidden);
}

// __dom.inspectNode(nid) -> [kind, localName, data, parentNid, state, hostNid, value, childNid, …] (`value` undefined
// while clean), or null for a dead nid.
// The arena as it stands, for the verify mode that holds it against the JS tree (`CSIM_ARENA_VERIFY`); nothing else
// reads it.
fn inspect_node(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let cid = realm_id(scope, &args);
    let Some((kind, local_name, data, parent, state, host, value, children)) = realm(scope, cid).get(id).map(|n| {
        let kind = match n.kind {
            NodeKind::Element => 1,
            NodeKind::Text => 3,
            NodeKind::ProcessingInstruction => 7,
            NodeKind::Comment => 8,
            NodeKind::Document => 9,
            NodeKind::Fragment => 11,
            NodeKind::Other => 0,
        };
        (kind, n.local_name.clone(), n.data.clone(), n.parent, n.state, n.host, n.value.clone(), n.children.clone())
    }) else {
        rv.set_null();
        return;
    };
    const HEAD: usize = 7;
    let out = v8::Array::new(scope, (HEAD + children.len()) as i32);
    let vals: Vec<v8::Local<v8::Value>> = vec![
        v8::Integer::new(scope, kind).into(),
        v8::String::new(scope, &local_name).map_or_else(|| v8::undefined(scope).into(), |s| s.into()),
        utf16_value(scope, &data),
        v8::Number::new(scope, parent.map_or(-1.0, |p| p.to_f64())).into(),
        v8::Integer::new_from_unsigned(scope, state).into(),
        v8::Number::new(scope, host.map_or(-1.0, |h| h.to_f64())).into(),
        match value.as_deref() {
            Some(v) => utf16_value(scope, v),
            None => v8::undefined(scope).into(),
        },
    ];
    for (i, v) in vals.into_iter().enumerate() {
        out.set_index(scope, i as u32, v);
    }
    for (i, c) in children.iter().enumerate() {
        let v: v8::Local<v8::Value> = v8::Number::new(scope, c.to_f64()).into();
        out.set_index(scope, (HEAD + i) as u32, v);
    }
    rv.set(out.into());
}

// A JS string of these UTF-16 code units.
pub(crate) fn utf16_value<'s>(scope: &mut v8::PinScope<'s, '_>, units: &[u16]) -> v8::Local<'s, v8::Value> {
    match v8::String::new_from_two_byte(scope, units, v8::NewStringType::Normal) {
        Some(s) => s.into(),
        None => v8::undefined(scope).into(),
    }
}

// __dom.removeChild(childNid): the child leaves its parent (and keeps its own subtree).
fn remove_child(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(child) = nid_arg(scope, &args, 0) else {
        return;
    };
    let cid = realm_id(scope, &args);
    let (arena, mut engine) = arena_and_engine(scope, cid);
    let old = arena.parent_of(child);
    if let Some(engine) = engine.as_deref_mut() {
        engine.node_left(arena, child);
    }
    arena.detach(child);
    if let (Some(engine), Some(o)) = (engine, old) {
        engine.children_changed(arena, o);
    }
}

// __dom.syncChildren(parentNid, childNids): make parentNid's children EXACTLY `childNids` (in tree order).
// Each child is detached from any current parent first, so a MOVED node — still listed under its
// old parent until that parent is itself synced — is re-homed correctly whichever order the two
// syncs arrive in. The single structural-sync primitive the incremental (parse + mutation) arena
// upkeep drives. New nodes are created with
// importNode(parent = -1) first, then linked here.
fn sync_children(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(parent) = nid_arg(scope, &args, 0) else {
        return;
    };
    let mut raw: Vec<NodeId> = Vec::new();
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(args.get(1)) {
        for i in 0..arr.length() {
            if let Some(id) = arr.get_index(scope, i).and_then(|v| v.integer_value(scope)).and_then(NodeId::from_i64) {
                raw.push(id);
            }
        }
    }
    let cid = realm_id(scope, &args);
    let (st, engine) = arena_and_engine(scope, cid);
    if st.get(parent).is_none() {
        return;
    }
    st.state_epoch += 1;
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
    // Take each incoming child from a DIFFERENT current parent (a same-parent reorder skips this) — every old parent
    // once, however many of its children arrive: a fragment handing over its whole list child by child would shift and
    // reindex the rest per child.
    let mut old_parents: Vec<NodeId> = Vec::new();
    let mut arrived: Vec<NodeId> = Vec::new();
    for &k in &kids {
        let Some(kn) = st.get_mut(k) else { continue };
        if kn.parent != Some(parent) {
            if let Some(op) = kn.parent.replace(parent) {
                arrived.push(k);
                if !old_parents.contains(&op) {
                    old_parents.push(op);
                }
            }
        }
    }
    for &op in &old_parents {
        let Some(list) = st.get(op).map(|o| o.children.clone()) else { continue };
        let kept: Vec<NodeId> = list.into_iter().filter(|&c| st.get(c).is_some_and(|n| n.parent == Some(op))).collect();
        if let Some(o) = st.get_mut(op) {
            o.children = kept;
        }
        st.reindex_children(op, 0, false);
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
    let left = dropped.clone();
    for d in dropped {
        if st.get(d).and_then(|node| node.parent) == Some(parent) {
            if let Some(dn) = st.get_mut(d) {
                dn.parent = None;
                crate::node_handle::unlink(&dn.link);
            }
        }
    }
    if let Some(p) = st.get_mut(parent) {
        p.children = kids;
    }
    st.reindex_children(parent, 0, false);
    if let Some(engine) = engine {
        for &n in arrived.iter().chain(&left) {
            engine.node_left(st, n);
        }
        for op in old_parents {
            engine.children_changed(st, op);
        }
        engine.children_changed(st, parent);
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
    let (arena, engine) = arena_and_engine(scope, cid);
    // Every name the element had or will have — a wholesale write can add, drop or change any of them — listed only
    // for an engine to hear of: this is the parser's per-element write, which allocates nothing more without one.
    match engine {
        None => {
            if attributes.iter().any(|(k, _)| attribute_reads_state(k)) {
                arena.state_epoch += 1;
            }
        }
        Some(engine) => {
            let old: Vec<String> =
                arena.get(id).map_or(Vec::new(), |n| n.attributes.iter().map(|(k, _)| k.clone()).collect());
            let mut names: Vec<&str> = old.iter().map(String::as_str).collect();
            names.extend(attributes.iter().map(|(k, _)| k.as_str()).filter(|k| !old.iter().any(|o| o == k)));
            before_attribute_write(arena, Some(engine), id, &names);
        }
    }
    if let Some(node) = arena.get_mut(id) {
        node.attributes = attributes;
        node.attr_u16 = attr_u16;
        let attrs = std::mem::take(&mut node.attributes);
        node.retain_attr_ns(|k| attrs.iter().any(|(a, _)| a == k));
        node.attributes = attrs;
        node.attr_changed(None);
        // (…with or without an engine to hear of it: the parser's `dir` is what `is_rtl` must not miss)
        let notes = notes_direction(node);
        arena.direction_sources |= notes;
    }
}

// __dom.setAttrNamespace(nodeNid, key, ns, localName): the attribute stored under `key` is in namespace `ns` with that
// local name — or, for an empty `ns`, in none (its record is dropped).
fn set_attr_namespace(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let key = args.get(1).to_rust_string_lossy(scope);
    let (ns, ns_u16) = read_v8_value(scope, args.get(2));
    let (local, local_u16) = read_v8_value(scope, args.get(3));
    let cid = realm_id(scope, &args);
    let (arena, engine) = arena_and_engine(scope, cid);
    before_attribute_write(arena, engine, id, &[&key]);
    if let Some(node) = arena.get_mut(id) {
        node.retain_attr_ns(|k| k != key);
        if !ns.is_empty() {
            // (…exactly, beside, where either lost a lone surrogate)
            if ns_u16.is_some() || local_u16.is_some() {
                let exact = |lossy: &str, units: Option<Vec<u16>>| units.unwrap_or_else(|| lossy.encode_utf16().collect());
                node.attr_ns_u16.push((key.clone(), exact(&ns, ns_u16), exact(&local, local_u16)));
            }
            node.attr_ns.push((key, ns, local));
        }
        node.attr_changed(None);
    }
}

// __dom.query(rootNid, selector, quirks, firstOnly, scopeNid, xml) -> the elements matched, in document order, as
// `nodes_value` answers them, or `null` for an invalid selector (the caller's SyntaxError); `undefined` for a root the
// arena does not hold.
fn query(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(root) = nid_arg(scope, &args, 0) else {
        return;
    };
    let selector = args.get(1).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    // …in the mode of the root's document (arg 2: quirks; arg 5: an XML document); querySelector stops at the first
    // (arg 3); `:scope` is the element arg 4 names, else the root.
    let quirks = args.get(2).is_true();
    let first_only = args.get(3).is_true();
    let scope_el = if args.get(4).is_number() { nid_arg(scope, &args, 4) } else { None }.unwrap_or(root);
    let html_doc = !args.get(5).is_true();
    match crate::selector::query_text(realm(scope, cid), root, scope_el, &selector, first_only, quirks, html_doc) {
        Some(ids) => {
            let answer = nodes_value(scope, cid, root, &ids);
            rv.set(answer);
        }
        None => rv.set_null(),
    }
}

// __dom.matchesId(nodeNid, selector, quirks, scoped, xml) -> bool, or `null` for an invalid selector; `undefined`
// for a node the arena does not hold. Element.matches (`scoped`: `:scope` is the element), and the cascade's
// does-this-element-match-this-rule.
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
    let quirks = args.get(2).is_true();
    let scoped = args.get(3).is_true();
    let html_doc = !args.get(4).is_true();
    match crate::selector::matches_text(realm(scope, cid), id, &selector, None, quirks, html_doc, scoped, false) {
        Some(hit) => rv.set_bool(hit.is_some()),
        None => rv.set_null(),
    }
}

// __dom.closestId(nid, selector, quirks, xml) -> the nid of the nearest inclusive ancestor element matching (Element.closest,
// `:scope` the element itself), -1 for none; `null` / `undefined` as matchesId.
fn closest_id(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else {
        return;
    };
    let selector = args.get(1).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    let quirks = args.get(2).is_true();
    let html_doc = !args.get(3).is_true();
    match crate::selector::matches_text(realm(scope, cid), id, &selector, None, quirks, html_doc, true, true) {
        Some(Some(hit)) => set_nid(scope, &mut rv, hit),
        Some(None) => rv.set_int32(-1),
        None => rv.set_null(),
    }
}


// __dom.selectorValid(text) -> bool: a selector this engine parses — `CSS.supports('selector(…)')`.
fn selector_valid(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let text = args.get(0).to_rust_string_lossy(scope);
    rv.set_bool(crate::selector::is_valid(&text));
}

// ---- CSSOM rules over the realm's sheets (cssom_rule.rs): a rule is named by its handle, a sheet by its id ----

// `[handle, interface, …]` for a list of handed-out rules (cssom_rule.rs `kind` names the interface).
fn rule_array<'s>(scope: &mut v8::PinScope<'s, '_>, rules: &[(u32, &'static str)]) -> v8::Local<'s, v8::Value> {
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(rules.len() * 2);
    for &(handle, kind) in rules {
        items.push(v8::Integer::new_from_unsigned(scope, handle).into());
        items.push(v8::String::new(scope, kind).unwrap().into());
    }
    v8::Array::new_with_elements(scope, &items).into()
}
// An argument that names a handle or an id: a non-negative integer (-1 for none).
fn handle_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, at: i32) -> Option<u32> {
    let v = args.get(at);
    v.is_number().then(|| v.number_value(scope)).flatten().filter(|n| *n >= 0.0).map(|n| n as u32)
}
// `f` over the realm's sheets and the lock they are read under; and — after a mutation — its engine told the rules moved.
fn with_sheets<R>(
    scope: &mut v8::PinScope<'_, '_>,
    args: &v8::FunctionCallbackArguments<'_>,
    f: impl FnOnce(&mut crate::sheets::SheetStore, &style::shared_lock::SharedRwLock) -> R,
) -> R {
    let cid = realm_id(scope, args);
    let arena = realm(scope, cid);
    let lock = arena.style_lock.0.clone();
    f(&mut arena.sheets, &lock)
}
// CSSOM is about to reach the sheet `id`'s rules: one sharing a kept parse takes a copy of its own (sheets.rs `own`),
// which the engine cascades in its place.
fn own_sheet(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, id: u32) {
    let Some((old, new)) = with_sheets(scope, args, |store, _| store.own(id)) else { return };
    let cid = realm_id(scope, args);
    if let Some(engine) = dom(scope).styles.get_mut(&cid) {
        engine.swap_sheet(&old, &new);
    }
}
// The id of the sheet the rule `handle` is in.
fn sheet_of(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, handle: u32) -> Option<u32> {
    with_sheets(scope, args, |store, _| store.rule(handle).map(|r| r.sheet))
}
// …the sheet `sheet`'s rules moved: the engine restyles where it cascades that sheet (an `@import`ed one is the sheet
// that imports it — `None`, any sheet), and is left alone for one no document has.
fn rules_moved(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, sheet: Option<u32>) {
    let cid = realm_id(scope, args);
    let d = dom(scope);
    let (Some(engine), Some(arena)) = (d.styles.get_mut(&cid), d.arena.enter_known(cid)) else { return };
    let used = match sheet.and_then(|id| arena.sheets.get(id)) {
        Some(s) => s.imported || engine.uses_sheet(&s.sheet),
        None => true,
    };
    if used {
        engine.sheets_changed();
    }
}

// __dom.sheetRules(sheetId) -> [handle, interface, …]: the sheet's rules; null with no such sheet.
fn sheet_rules(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(sheet) = handle_arg(scope, &args, 0) else { return rv.set_null() };
    own_sheet(scope, &args, sheet);
    match with_sheets(scope, &args, |store, lock| crate::cssom_rule::sheet_rules(store, lock, sheet)) {
        Some(rules) => rv.set(rule_array(scope, &rules)),
        None => rv.set_null(),
    }
}
// __dom.sheetVersion(sheetId) -> a number that moves whenever the sheet is made of other text (-1: no such sheet).
fn sheet_version(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let sheet = handle_arg(scope, &args, 0);
    let version = with_sheets(scope, &args, |store, _| sheet.and_then(|id| store.get(id)).map(|s| s.version));
    rv.set_double(version.map_or(-1.0, |v| v as f64));
}
// __dom.ruleRules(handle) -> [handle, interface, …]: the rules (or keyframes) the rule holds; null where it holds none.
fn rule_rules(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(handle) = handle_arg(scope, &args, 0) else { return rv.set_null() };
    match with_sheets(scope, &args, |store, lock| crate::cssom_rule::child_rules(store, lock, handle)) {
        Some(rules) => rv.set(rule_array(scope, &rules)),
        None => rv.set_null(),
    }
}
// __dom.ruleText(handle) -> the rule's `cssText`.
fn rule_text(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(handle) = handle_arg(scope, &args, 0) else { return };
    if let Some(css) = with_sheets(scope, &args, |store, lock| crate::cssom_rule::css_text(store, lock, handle)) {
        set_str(scope, &mut rv, &css);
    }
}
// __dom.ruleGet(handle, what) -> one of the rule's attributes (cssom_rule.rs `get`), null where it has none.
fn rule_get(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(handle) = handle_arg(scope, &args, 0) else { return rv.set_null() };
    let what = args.get(1).to_rust_string_lossy(scope);
    match with_sheets(scope, &args, |store, lock| crate::cssom_rule::get(store, lock, handle, &what)) {
        Some(value) => set_str(scope, &mut rv, &value),
        None => rv.set_null(),
    }
}
// __dom.ruleSet(handle, what, value) -> whether the rule took it (cssom_rule.rs `set`).
fn rule_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(handle) = handle_arg(scope, &args, 0) else { return rv.set_bool(false) };
    let what = args.get(1).to_rust_string_lossy(scope);
    let value = args.get(2).to_rust_string_lossy(scope);
    let took = with_sheets(scope, &args, |store, lock| crate::cssom_rule::set(store, lock, handle, &what, &value));
    if took {
        let sheet = sheet_of(scope, &args, handle);
        rules_moved(scope, &args, sheet);
    }
    rv.set_bool(took);
}
// __dom.ruleInsert(sheetId, parentHandle, css, index) -> [handle, interface, …the URLs an `@import` in it waits for], or
// the name of the DOMException the insertion is refused with. `parentHandle` -1: the sheet's own list.
fn rule_insert(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(sheet) = handle_arg(scope, &args, 0) else { return };
    own_sheet(scope, &args, sheet);
    let parent = handle_arg(scope, &args, 1);
    let css = args.get(2).to_rust_string_lossy(scope);
    let index = args.get(3).uint32_value(scope).unwrap_or(0) as usize;
    match with_sheets(scope, &args, |store, lock| crate::cssom_rule::insert(store, lock, sheet, parent, &css, index)) {
        Ok((handle, kind, pending)) => {
            rules_moved(scope, &args, Some(sheet));
            let mut items: Vec<v8::Local<v8::Value>> =
                vec![v8::Integer::new_from_unsigned(scope, handle).into(), v8::String::new(scope, kind).unwrap().into()];
            items.extend(pending.iter().filter_map(|u| v8::String::new(scope, u)).map(Into::<v8::Local<v8::Value>>::into));
            rv.set(v8::Array::new_with_elements(scope, &items).into());
        }
        Err(name) => set_str(scope, &mut rv, name),
    }
}
// __dom.ruleDelete(sheetId, parentHandle, index) -> '' or the name of the DOMException the removal is refused with.
fn rule_delete(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(sheet) = handle_arg(scope, &args, 0) else { return };
    own_sheet(scope, &args, sheet);
    let parent = handle_arg(scope, &args, 1);
    let index = args.get(2).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let refused = with_sheets(scope, &args, |store, lock| crate::cssom_rule::delete(store, lock, sheet, parent, index).err());
    if refused.is_none() {
        rules_moved(scope, &args, Some(sheet));
    }
    set_str(scope, &mut rv, refused.unwrap_or(""));
}
// __dom.keyframeAppend(handle, css) -> the appended keyframe's handle, or null where `css` is no keyframe.
fn keyframe_append(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(handle) = handle_arg(scope, &args, 0) else { return rv.set_null() };
    let css = args.get(1).to_rust_string_lossy(scope);
    match with_sheets(scope, &args, |store, lock| crate::cssom_rule::append_keyframe(store, lock, handle, &css)) {
        Some(keyframe) => {
            let sheet = sheet_of(scope, &args, handle);
            rules_moved(scope, &args, sheet);
            rv.set_uint32(keyframe);
        }
        None => rv.set_null(),
    }
}
// __dom.keyframeFind(handle, key) -> the index of the last keyframe whose selector is `key`, -1 for none.
fn keyframe_find(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(handle) = handle_arg(scope, &args, 0) else { return rv.set_int32(-1) };
    let key = args.get(1).to_rust_string_lossy(scope);
    let index = with_sheets(scope, &args, |store, lock| crate::cssom_rule::find_keyframe(store, lock, handle, &key));
    rv.set_int32(index.map_or(-1, |i| i as i32));
}
// __dom.keyframeDelete(handle, index): the keyframe at `index` removed.
fn keyframe_delete(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(handle), Some(index)) = (handle_arg(scope, &args, 0), handle_arg(scope, &args, 1)) else { return };
    with_sheets(scope, &args, |store, lock| crate::cssom_rule::delete_keyframe(store, lock, handle, index as usize));
    let sheet = sheet_of(scope, &args, handle);
    rules_moved(scope, &args, sheet);
}
// __dom.importSheet(handle) -> the id of an `@import`'s sheet, null while it has none.
fn import_sheet(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(handle) = handle_arg(scope, &args, 0) else { return rv.set_null() };
    match with_sheets(scope, &args, |store, lock| crate::cssom_rule::imported_sheet(store, lock, handle)) {
        Some(id) => rv.set_uint32(id),
        None => rv.set_null(),
    }
}
// __dom.sheetMedia(sheetId, media, quirks): the sheet applies under `media` now (its rules kept).
fn sheet_media(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(sheet) = handle_arg(scope, &args, 0) else { return };
    own_sheet(scope, &args, sheet);
    let media = args.get(1).to_rust_string_lossy(scope);
    let quirks = args.get(2).is_true();
    with_sheets(scope, &args, |store, lock| store.set_media(lock, sheet, &media, quirks));
    rules_moved(scope, &args, Some(sheet));
}
// __dom.mediaText(text) -> `text` as a media list, as the engine serializes one.
fn media_text(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    set_str(scope, &mut rv, &crate::cssom_rule::media_text(&text));
}
// __dom.ruleDrop(handle): the CSSOM object naming the rule is gone.
fn rule_drop(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(handle) = handle_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    if let Some(arena) = dom(scope).arena.enter_known(cid) {
        arena.sheets.drop_rule(handle);
    }
}

// __dom.xpathPrefixes(expression) -> the namespace prefixes its name tests name (for the caller to resolve before
// evaluating), or a string — the SyntaxError's message.
fn xpath_prefixes(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let text = utf16_arg(scope, args.get(0));
    match crate::xpath::prefixes(&text) {
        Ok(prefixes) => {
            let array = v8::Array::new(scope, prefixes.len() as i32);
            for (i, p) in prefixes.iter().enumerate() {
                let v = v8::String::new(scope, p).map_or_else(|| v8::undefined(scope).into(), Into::into);
                array.set_index(scope, i as u32, v);
            }
            rv.set(array.into());
        }
        Err(message) => {
            let v = v8::String::new(scope, &message).map_or_else(|| v8::undefined(scope).into(), Into::into);
            rv.set(v);
        }
    }
}

// __dom.xpathEvaluate(expression, contextNid, attrKey, html, namespaces, resultType) -> a number, string or boolean,
// or for a node-set [key, path…, key, path…, …] in document order (each node as its path from the root of the context's
// tree, `RealmArena::push_path`; `key` an attribute's store key, null for the node itself). The context is the node
// `contextNid`, or its attribute stored under `attrKey` (a string); `namespaces` a flat [prefix, uri, …] array.
// Throws a TypeError for a value of the wrong type; `undefined` for a context the arena does not hold.
fn xpath_evaluate(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 1) else {
        return;
    };
    let text = utf16_arg(scope, args.get(0));
    let attr_key = args.get(2).is_string().then(|| args.get(2).to_rust_string_lossy(scope));
    let html = args.get(3).is_true();
    let mut namespaces = std::collections::HashMap::new();
    if let Ok(flat) = v8::Local::<v8::Array>::try_from(args.get(4)) {
        let mut i = 0;
        while i + 1 < flat.length() {
            let prefix = flat.get_index(scope, i).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default();
            let uri = flat.get_index(scope, i + 1).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default();
            namespaces.insert(prefix, uri);
            i += 2;
        }
    }
    let result_type = args.get(5).uint32_value(scope).unwrap_or(0) as u8;
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    if arena.get(id).is_none() {
        return;
    }
    let context = match &attr_key {
        Some(key) => match crate::xpath::attribute_node(arena, id, key) {
            Some(x) => x,
            None => return,
        },
        None => crate::xpath::XNode::Node(id),
    };
    let answer = crate::xpath::evaluate(arena, &text, context, html, &namespaces, result_type);
    // (…the node-set as (path, key) pairs, read while the arena is borrowed)
    let root = arena.root_of(id);
    let answer = answer.map(|a| match a {
        crate::xpath::Answer::Nodes(nodes) => {
            let path = |n: NodeId| {
                let mut out = Vec::new();
                arena.push_path(root, n, &mut out);
                out
            };
            let pairs: Vec<_> = nodes
                .iter()
                .map(|x| match *x {
                    crate::xpath::XNode::Node(n) => (path(n), None),
                    crate::xpath::XNode::Attr(n, i) => (path(n), crate::xpath::attribute_key(arena, n, i).map(str::to_owned)),
                })
                .collect();
            Err(pairs)
        }
        other => Ok(other),
    });
    match answer {
        Err(e) => {
            let message = match e {
                crate::xpath::XError::Syntax(m) | crate::xpath::XError::Type(m) | crate::xpath::XError::Namespace(m) => m,
            };
            let message = v8::String::new(scope, &message).unwrap_or_else(|| v8::String::empty(scope));
            let error = v8::Exception::type_error(scope, message);
            scope.throw_exception(error);
        }
        Ok(Err(pairs)) => {
            let mut items: Vec<v8::Local<v8::Value>> = Vec::new();
            for (path, key) in &pairs {
                items.push(match key.as_deref().and_then(|k| v8::String::new(scope, k)) {
                    Some(k) => k.into(),
                    None => v8::null(scope).into(),
                });
                items.extend(path.iter().map(|&v| -> v8::Local<v8::Value> { v8::Number::new(scope, v).into() }));
            }
            rv.set(v8::Array::new_with_elements(scope, &items).into());
        }
        Ok(Ok(crate::xpath::Answer::Number(n))) => rv.set_double(n),
        Ok(Ok(crate::xpath::Answer::Bool(b))) => rv.set_bool(b),
        Ok(Ok(crate::xpath::Answer::Str(s))) => {
            let v = utf16_value(scope, &s);
            rv.set(v);
        }
        Ok(Ok(crate::xpath::Answer::Nodes(_))) => unreachable!(),
    }
}





// A JS array of `urls`.
fn url_array<'s>(scope: &mut v8::PinScope<'s, '_>, urls: &[String]) -> v8::Local<'s, v8::Value> {
    let items: Vec<v8::Local<v8::Value>> =
        urls.iter().filter_map(|u| v8::String::new(scope, u)).map(Into::into).collect();
    v8::Array::new_with_elements(scope, &items).into()
}

// Run a style-engine op, catching a panic (a bug) where it would otherwise unwind into V8's callback frame and abort
// the process: the realm's engine is dropped with every style it made, so the next op starts from a clean one.
pub(crate) fn style_op(scope: &mut v8::PinScope<'_, '_>, cid: i32, op: impl FnOnce(&mut v8::PinScope<'_, '_>)) {
    // …and an engine a change hook left poisoned is dropped before it is asked anything.
    let poisoned = dom(scope).styles.get(&cid).is_some_and(|e| e.poisoned());
    let panicked = if poisoned {
        Some(Box::new("a change hook panicked") as Box<dyn std::any::Any + Send>)
    } else {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| op(scope))).err()
    };
    let Some(panic) = panicked else { return };
    let what = panic.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| panic.downcast_ref::<String>().cloned());
    let d = dom(scope);
    let verifies = d.styles.get(&cid).is_some_and(|e| e.verifies());
    d.styles.remove(&cid);
    if let Some(arena) = d.arena.enter_known(cid) {
        for id in arena.element_ids().collect::<Vec<_>>() {
            if let Some(slot) = arena.existing_style_slot(id) {
                slot.forget_style();
            }
        }
    }
    // Loud where the engine is being verified; elsewhere the bug goes to stderr and the next op starts from a clean
    // engine.
    let message = format!("style engine panicked: {}", what.unwrap_or_default());
    if !verifies {
        eprintln!("csim: {message}");
        return;
    }
    if let Some(m) = v8::String::new(scope, &message) {
        let error = v8::Exception::error(scope, m);
        scope.throw_exception(error);
    }
}

// Sheets off a JS array of [css, baseUrl, media, constructed, css, …] (`StyleEngine::set_sheets` takes them).
// The realm's sheets a `[id, …]` array names, in its order (an id the store no longer has, none).
fn sheet_ids(scope: &mut v8::PinScope<'_, '_>, val: v8::Local<'_, v8::Value>) -> Vec<u32> {
    let Ok(arr) = v8::Local::<v8::Array>::try_from(val) else { return Vec::new() };
    (0..arr.length()).filter_map(|i| arr.get_index(scope, i)?.uint32_value(scope)).collect()
}
// …and a sheet as the page hands one over: `(css, baseUrl, media, constructed)` from argument `at` on.
fn sheet_source(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, at: i32) -> crate::sheets::SheetSource {
    let text = |scope: &mut v8::PinScope<'_, '_>, k: i32| {
        let v = args.get(at + k);
        if v.is_string() { v.to_rust_string_lossy(scope) } else { String::new() }
    };
    let (css, base, media) = (text(scope, 0), text(scope, 1), text(scope, 2));
    crate::sheets::SheetSource { css, base, media, constructed: args.get(at + 3).is_true() }
}

// __dom.styleSheets(docNid, baseUrl, quirks, xml, width, height, [sheetId, …]): the realm document's sheets (the
// realm's, sheetMake), in document order, for its style engine — which is made again only when the document's base
// URL, mode, kind (`xml`: not an HTML document) or viewport moved.
fn style_sheets(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    rv: v8::ReturnValue<'_, v8::Value>,
) {
    let cid = realm_id(scope, &args);
    style_op(scope, cid, |scope| style_sheets_unguarded(scope, args, rv));
}
fn style_sheets_unguarded(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(doc) = nid_arg(scope, &args, 0) else { return };
    let base = args.get(1).to_rust_string_lossy(scope);
    let quirks = args.get(2).is_true();
    let html_document = !args.get(3).is_true();
    let viewport = (
        args.get(4).number_value(scope).unwrap_or(0.0) as f32,
        args.get(5).number_value(scope).unwrap_or(0.0) as f32,
    );
    let ids = sheet_ids(scope, args.get(6));
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    if d.arena.is_dropped(cid) {
        return;
    }
    let screen = crate::style::Screen { viewport, touch: d.touch_input };
    let arena = d.arena.enter(cid);
    let mut engine = crate::style::StyleEngine::for_document(d.styles.remove(&cid), arena, &base, quirks, html_document, screen);
    let sheets: Vec<_> = ids.iter().filter_map(|&id| arena.sheets.get(id)).collect();
    engine.set_sheets(doc, &sheets);
    d.styles.insert(cid, engine);
}

// __dom.styleShadowSheets(rootNid, [sheetId, …]): a shadow root's own sheets (the realm's), in its tree order.
fn style_shadow_sheets(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    rv: v8::ReturnValue<'_, v8::Value>,
) {
    let cid = realm_id(scope, &args);
    style_op(scope, cid, |scope| style_shadow_sheets_unguarded(scope, args, rv));
}
fn style_shadow_sheets_unguarded(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(root) = nid_arg(scope, &args, 0) else { return };
    let ids = sheet_ids(scope, args.get(1));
    let cid = realm_id(scope, &args);
    let (arena, engine) = arena_and_engine(scope, cid);
    let Some(engine) = engine else { return };
    let sheets: Vec<_> = ids.iter().filter_map(|&id| arena.sheets.get(id)).collect();
    engine.set_shadow_sheets(arena, root, &sheets);
}

// __dom.styleSheetFacts() -> [cssImage, sheetIndex, faceText, …]: what the document's sheets declare that the page side
// asks of them (`StyleEngine::sheet_facts`) — whether one could paint an image, then each `@font-face` that applies, by
// the index of its sheet in the last `styleSheets` set and its declarations as text. Undefined with no engine yet.
fn style_sheet_facts(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    rv: v8::ReturnValue<'_, v8::Value>,
) {
    let cid = realm_id(scope, &args);
    style_op(scope, cid, |scope| style_sheet_facts_unguarded(scope, args, rv));
}
fn style_sheet_facts_unguarded(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let (Some(engine), Some(arena)) = (d.styles.get(&cid), d.arena.enter_known(cid)) else { return };
    let (css_image, faces) = engine.sheet_facts(&arena.sheets);
    let mut items: Vec<v8::Local<v8::Value>> = vec![v8::Boolean::new(scope, css_image).into()];
    for (sheet, text) in faces {
        items.push(v8::Number::new(scope, sheet as f64).into());
        if let Some(text) = v8::String::new(scope, &text) {
            items.push(text.into());
        } else {
            items.pop();
        }
    }
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.styleImport(url, css, quirks) -> the URLs the imported sheet's own `@import`s wait for. The sheet at `url`
// arrived (`css` null: it could not be fetched), for every realm sheet whose `@import` waits for it.
fn style_import(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    rv: v8::ReturnValue<'_, v8::Value>,
) {
    let cid = realm_id(scope, &args);
    style_op(scope, cid, |scope| style_import_unguarded(scope, args, rv));
}
fn style_import_unguarded(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let url = args.get(0).to_rust_string_lossy(scope);
    let css = args.get(1).is_string().then(|| args.get(1).to_rust_string_lossy(scope));
    let quirks = args.get(2).is_true();
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let arena = d.arena.enter(cid);
    let lock = arena.style_lock.0.clone();
    let pending = arena.sheets.import(&lock, &url, css.as_deref(), quirks);
    if let Some(engine) = d.styles.get_mut(&cid) {
        engine.sheets_changed();
    }
    let urls = url_array(scope, &pending);
    rv.set(urls);
}

// __dom.sheetMake(css, baseUrl, media, constructed, quirks) -> [sheetId, …the URLs its `@import`s wait for]: a new sheet
// of the realm's (sheets.rs), for a `<style>` / `<link>` or a constructed sheet, in a document of `quirks` mode.
fn sheet_make(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let source = sheet_source(scope, &args, 0);
    let quirks = args.get(4).is_true();
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let lock = arena.style_lock.0.clone();
    let (id, pending) = arena.sheets.make(&lock, &source, quirks);
    let mut items: Vec<v8::Local<v8::Value>> = vec![v8::Integer::new_from_unsigned(scope, id).into()];
    items.extend(pending.iter().filter_map(|u| v8::String::new(scope, u)).map(Into::<v8::Local<v8::Value>>::into));
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.sheetReplace(sheetId, css, baseUrl, media, constructed, quirks) -> the URLs its `@import`s wait for: the sheet
// made of other text (or under another base or media). The engine takes it as the new sheet it is at its next set.
fn sheet_replace(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = args.get(0).uint32_value(scope) else { return };
    let source = sheet_source(scope, &args, 1);
    let quirks = args.get(5).is_true();
    let cid = realm_id(scope, &args);
    let arena = realm(scope, cid);
    let lock = arena.style_lock.0.clone();
    let pending = arena.sheets.replace(&lock, id, &source, quirks);
    let urls = url_array(scope, &pending);
    rv.set(urls);
}
// __dom.sheetDrop(sheetId): the page let go of the sheet.
fn sheet_drop(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Some(id) = args.get(0).uint32_value(scope) else { return };
    let cid = realm_id(scope, &args);
    if let Some(arena) = dom(scope).arena.enter_known(cid) {
        arena.sheets.drop_sheet(id);
    }
}

// __dom.styleValue(nid, property, pseudo, now) — `now` the page's animation clock (ms) — the element's (or, with `pseudo` — `before`, `placeholder`, … — its
// pseudo-element's) computed value of that longhand, or undefined (a shorthand, an unknown property, an element the
// style engine did not style).
fn style_value(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    rv: v8::ReturnValue<'_, v8::Value>,
) {
    let cid = realm_id(scope, &args);
    style_op(scope, cid, |scope| style_value_unguarded(scope, args, rv));
}
fn style_value_unguarded(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let name = args.get(1).to_rust_string_lossy(scope);
    let pseudo = args.get(2).is_string().then(|| args.get(2).to_rust_string_lossy(scope));
    let cid = realm_id(scope, &args);
    let now = clock_arg(scope, &args, 3);
    let d = dom(scope);
    let (Some(engine), Some(arena)) = (d.styles.get_mut(&cid), d.arena.enter_known(cid)) else { return };
    let value = engine.value(arena, id, &name, pseudo.as_deref(), now);
    let failures = engine.take_verify_failures();
    if threw_verify_failures(scope, failures) {
        return;
    }
    let Some(value) = value else { return };
    if let Some(s) = v8::String::new(scope, &value) {
        rv.set(s.into());
    }
}

// __dom.styleSupports(property) -> whether the style engine implements the property: one it computes a value of for
// every element it styles.
// __dom.styleProperties() -> every property a page can name, as `[name, property, animatable, longhands, initial]`
// (cssom_decl.rs `properties`): what script/gen_css_properties.rb writes js/src/css-properties.js from.
fn style_properties(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let mut rows = Vec::new();
    for p in crate::cssom_decl::properties() {
        let longhands: Vec<v8::Local<v8::Value>> =
            p.longhands.iter().filter_map(|l| v8::String::new(scope, l)).map(Into::into).collect();
        let row: [v8::Local<v8::Value>; 5] = [
            v8::String::new(scope, p.name).unwrap().into(),
            v8::String::new(scope, p.property).unwrap().into(),
            v8::Boolean::new(scope, p.animatable).into(),
            v8::Array::new_with_elements(scope, &longhands).into(),
            p.initial.as_deref().and_then(|i| v8::String::new(scope, i)).map_or_else(|| v8::null(scope).into(), Into::into),
        ];
        rows.push(v8::Array::new_with_elements(scope, &row).into());
    }
    rv.set(v8::Array::new_with_elements(scope, &rows).into());
}

// The declaration-block ops (cssom_decl.rs): `(text, kind, quirks, base, …, nid, rule)` — `kind` 0 a style rule's block
// (an element's `style` attribute is one), 1 a keyframe's, 2 a page's, 3 an `@font-face` rule's descriptors; `base` the
// document's base URL; `nid` the element whose `style` attribute it is and `rule` the handle of the rule whose block it
// is (cssom_rule.rs), -1 for neither.
fn decl_key(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> crate::cssom_decl::Key {
    let text = args.get(0).to_rust_string_lossy(scope);
    let kind = crate::cssom_decl::Kind::from_u32(args.get(1).uint32_value(scope).unwrap_or(0));
    let base = args.get(3).to_rust_string_lossy(scope);
    crate::cssom_decl::Key::new(&text, kind, args.get(2).is_true(), &base)
}
fn set_str(scope: &mut v8::PinScope<'_, '_>, rv: &mut v8::ReturnValue<'_, v8::Value>, s: &str) {
    if let Some(s) = v8::String::new(scope, s) {
        rv.set(s.into());
    }
}
// __dom.declValue(text, kind, quirks, base, name, nid) -> `getPropertyValue(name)`.
fn decl_value(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = decl_key(scope, &args);
    let made = written_style(scope, &args, &key, 5);
    let name = args.get(4).to_rust_string_lossy(scope);
    let value = crate::cssom_decl::value(&key, made, &name);
    set_str(scope, &mut rv, &value);
}
// __dom.declImportant(text, kind, quirks, base, name, nid) -> whether `getPropertyPriority(name)` is `important`.
fn decl_important(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = decl_key(scope, &args);
    let made = written_style(scope, &args, &key, 5);
    let name = args.get(4).to_rust_string_lossy(scope);
    rv.set_bool(crate::cssom_decl::important(&key, made, &name));
}
// __dom.declText(text, kind, quirks, base, nid) -> `cssText`.
fn decl_text(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = decl_key(scope, &args);
    let made = written_style(scope, &args, &key, 4);
    let css = crate::cssom_decl::css_text(&key, made);
    set_str(scope, &mut rv, &css);
}
// __dom.declNames(text, kind, quirks, base, nid) -> the declared longhand and custom property names, in order.
fn decl_names(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = decl_key(scope, &args);
    let made = written_style(scope, &args, &key, 4);
    let names = crate::cssom_decl::names(&key, made);
    let items: Vec<v8::Local<v8::Value>> = names.iter().filter_map(|n| v8::String::new(scope, n)).map(Into::into).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}
// __dom.declSet(text, kind, quirks, base, name, value, important, nid) -> the new text, or null where the block did not change.
fn decl_set(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = decl_key(scope, &args);
    let name = args.get(4).to_rust_string_lossy(scope);
    let value = args.get(5).to_rust_string_lossy(scope);
    let made = written_style(scope, &args, &key, 7);
    match crate::cssom_decl::set(&key, made, &name, &value, args.get(6).is_true()) {
        Some(written) => {
            set_str(scope, &mut rv, &written.text);
            keep_written_style(scope, &args, &key, 7, written);
        }
        None => rv.set_null(),
    }
}
// __dom.declRemove(text, kind, quirks, base, name, nid) -> [the value it had, the new text or null where it set nothing].
fn decl_remove(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = decl_key(scope, &args);
    let name = args.get(4).to_rust_string_lossy(scope);
    let made = written_style(scope, &args, &key, 5);
    let (old, written) = crate::cssom_decl::remove(&key, made, &name);
    let old: v8::Local<v8::Value> = v8::String::new(scope, &old).map(Into::into).unwrap_or_else(|| v8::null(scope).into());
    let css: v8::Local<v8::Value> = match &written {
        Some(written) => v8::String::new(scope, &written.text).map(Into::into).unwrap_or_else(|| v8::null(scope).into()),
        None => v8::null(scope).into(),
    };
    rv.set(v8::Array::new_with_elements(scope, &[old, css]).into());
    if let Some(written) = written {
        keep_written_style(scope, &args, &key, 5, written);
    }
}
// __dom.declReplace(text, kind, quirks, base, nid) -> the block `text` parses to, serialized: `cssText`'s setter.
fn decl_replace(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let key = decl_key(scope, &args);
    let written = crate::cssom_decl::replace(&key);
    set_str(scope, &mut rv, &written.text);
    keep_written_style(scope, &args, &key, 4, written);
}
// The block a read or a write is of where it is not the parse of the text: argument `at + 1` a rule's handle — the
// rule's own block (cssom_rule.rs) — or argument `at` an element's nid, while its `style` attribute still declares the
// block its last write made (cssom_decl.rs `WrittenStyle`); -1 for neither.
fn written_style(
    scope: &mut v8::PinScope<'_, '_>,
    args: &v8::FunctionCallbackArguments<'_>,
    key: &crate::cssom_decl::Key,
    at: i32,
) -> Option<std::rc::Rc<crate::cssom_decl::Block>> {
    if let Some(rule) = handle_arg(scope, args, at + 1) {
        return with_sheets(scope, args, |store, lock| crate::cssom_rule::rule_block(store, lock, rule)).map(std::rc::Rc::new);
    }
    let id = nid_arg(scope, args, at)?;
    let cid = realm_id(scope, args);
    realm(scope, cid).get(id)?.written_style.as_ref()?.for_key(key)
}
// …and the block a write made, put in its place: the rule's, or kept on the element.
fn keep_written_style(
    scope: &mut v8::PinScope<'_, '_>,
    args: &v8::FunctionCallbackArguments<'_>,
    key: &crate::cssom_decl::Key,
    at: i32,
    written: crate::cssom_decl::Written,
) {
    if let Some(rule) = handle_arg(scope, args, at + 1) {
        if with_sheets(scope, args, |store, lock| crate::cssom_rule::set_rule_block(store, lock, rule, written.into_block())) {
            let sheet = sheet_of(scope, args, rule);
            rules_moved(scope, args, sheet);
        }
        return;
    }
    let Some(id) = nid_arg(scope, args, at) else { return };
    let Some(style) = crate::cssom_decl::WrittenStyle::new(key, written) else { return };
    let cid = realm_id(scope, args);
    if let Some(node) = realm(scope, cid).get_mut(id) {
        node.written_style = Some(Box::new(style));
    }
}
// __dom.declSupports(name, value) -> `CSS.supports(name, value)`.
fn decl_supports(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let name = args.get(0).to_rust_string_lossy(scope);
    let value = args.get(1).to_rust_string_lossy(scope);
    rv.set_bool(crate::cssom_decl::supports(&name, &value));
}

// __dom.cssNumber(text) -> the `<number>` the text is (`cssom_decl::number`), NaN where it is none.
fn css_number(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    rv.set_double(crate::cssom_decl::number(&text).unwrap_or(f64::NAN));
}

// __dom.mediaMatches(text, width, height) -> whether the media query list matches on a viewport of that size
// (`style::media_matches`).
fn media_matches(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    let viewport = [1, 2].map(|i| args.get(i).number_value(scope).unwrap_or(0.0) as f32);
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let screen = crate::style::Screen { viewport: (viewport[0], viewport[1]), touch: d.touch_input };
    let Some(arena) = d.arena.enter_known(cid) else { return rv.set_bool(false) };
    rv.set_bool(crate::style::media_matches(d.styles.get(&cid), arena, screen, &text));
}

// __dom.cssColor(text, currentColor) -> `[r, g, b, alpha, legacy, css]` — the colour `text` is (`style::parse_color`):
// its red, green and blue in sRGB, 0 to 1 and outside that where it lies outside the sRGB gamut, its alpha, whether it
// was written in a legacy sRGB form (a keyword, a hex, `rgb()`, `hsl()`, `hwb()`) and its serialization as a computed
// colour — or null where it is no colour.
fn css_color(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    use style_traits::ToCss;
    let text = args.get(0).to_rust_string_lossy(scope);
    let current = args.get(1).to_rust_string_lossy(scope);
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let arena = d.arena.enter(cid);
    let Some(color) = crate::style::parse_color(d.styles.get(&cid), arena, &text, &current) else { return rv.set_null() };
    let srgb = color.to_color_space(style::color::ColorSpace::Srgb);
    let [r, g, b, _] = *srgb.raw_components();
    let css = color.to_css_string();
    let mut items: Vec<v8::Local<v8::Value>> = [r, g, b, color.alpha]
        .iter()
        .map(|&c| v8::Number::new(scope, f64::from(c)).into())
        .collect();
    items.push(v8::Boolean::new(scope, color.is_legacy_syntax()).into());
    let Some(css) = v8::String::new(scope, &css) else { return rv.set_null() };
    items.push(css.into());
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.canvasFont(text, em, rem, lh, rlh) -> a canvas's `font` of `text` (`cssom_decl::canvas_font`) — `[css, px,
// weight, slant, smallCaps, family]` — or null.
fn canvas_font(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    let [em, rem, lh, rlh] = [1, 2, 3, 4].map(|i| args.get(i).number_value(scope).unwrap_or(f64::NAN));
    let Some(font) = crate::cssom_decl::canvas_font(&text, em, rem, lh, rlh) else { return rv.set_null() };
    let (Some(css), Some(family)) = (v8::String::new(scope, &font.css), v8::String::new(scope, &font.family)) else { return };
    let items: [v8::Local<v8::Value>; 6] = [
        css.into(),
        v8::Number::new(scope, font.px).into(),
        v8::Number::new(scope, font.weight).into(),
        v8::Number::new(scope, f64::from(font.slant)).into(),
        v8::Boolean::new(scope, font.small_caps).into(),
        family.into(),
    ];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.canvasSpacing(text, em, rem) -> a canvas's letter / word spacing of `text` (`cssom_decl::canvas_spacing`) —
// `[css, px]` — or null.
fn canvas_spacing(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    let [em, rem] = [1, 2].map(|i| args.get(i).number_value(scope).unwrap_or(f64::NAN));
    let Some((css, px)) = crate::cssom_decl::canvas_spacing(&text, em, rem) else { return rv.set_null() };
    let Some(css) = v8::String::new(scope, &css) else { return };
    let items: [v8::Local<v8::Value>; 2] = [css.into(), v8::Number::new(scope, px).into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.fontShorthandFamilies(text) -> the families a `font` value names (`cssom_decl::font_shorthand_families`), or
// null.
fn font_shorthand_families(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    let Some(families) = crate::cssom_decl::font_shorthand_families(&text) else { return rv.set_null() };
    let items: Vec<v8::Local<v8::Value>> = families.iter().filter_map(|f| v8::String::new(scope, f)).map(Into::into).collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.setTouchInput(touch): whether the session's pointer is a touchscreen — its documents' devices answer by it from
// their next sheet update on.
fn set_touch_input(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let touch = args.get(0).is_true();
    dom(scope).touch_input = touch;
}

// __dom.declSupportsCondition(text) -> `CSS.supports(conditionText)`.
fn decl_supports_condition(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    rv.set_bool(crate::cssom_decl::supports_condition(&text));
}


// __dom.styleGenerated(nid, which, now) -> string | null: what the element's `::before` (0) or `::after` (1) renders as
// the style engine styled it (`StyleEngine::generated`) — its text, empty for a box holding none — or null where it
// generates no box. Undefined where the realm has no engine.
fn style_generated(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let cid = realm_id(scope, &args);
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let which = args.get(1).int32_value(scope).unwrap_or(0).clamp(0, 1) as usize;
    let now = clock_arg(scope, &args, 2);
    style_op(scope, cid, |scope| {
        let d = dom(scope);
        let (Some(engine), Some(arena)) = (d.styles.get_mut(&cid), d.arena.enter_known(cid)) else { return };
        let text = engine.generated(arena, id, which, now);
        let failures = engine.take_verify_failures();
        if threw_verify_failures(scope, failures) {
            return;
        }
        match text.and_then(|u| v8::String::new_from_two_byte(scope, &u, v8::NewStringType::Normal)) {
            Some(js) => rv.set(js.into()),
            None => rv.set_null(),
        }
    });
}

// __dom.styleRestyled() -> how many elements a restyle replaced the style of since the last call
// (`RealmArena::note_restyled`), taken.
fn style_restyled(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let cid = realm_id(scope, &args);
    let Some(arena) = dom(scope).arena.enter_known(cid) else { return };
    rv.set_uint32(arena.restyled.take());
}

// The page's clock (ms) an op is given at `index`: 0 when it is not a finite number (an undefined argument reads NaN).
pub(crate) fn clock_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, index: i32) -> f64 {
    args.get(index).number_value(scope).filter(|n| n.is_finite()).unwrap_or(0.0)
}

// Under CSIM_STYLE_VERIFY, what the engine's last restyles disagreed with a full one about (`failures`), thrown as the
// error the op ends with; whether there was any.
pub(crate) fn threw_verify_failures(scope: &mut v8::PinScope<'_, '_>, failures: Vec<String>) -> bool {
    if failures.is_empty() {
        return false;
    }
    let message = format!("style verify: {}", failures.join("; "));
    if let Some(m) = v8::String::new(scope, &message) {
        let error = v8::Exception::error(scope, m);
        scope.throw_exception(error);
    }
    true
}

// __dom.styleFlush(now) -> [nid, …] | undefined: a style flush at `now` (the page's clock, ms) — what a forced
// `getComputedStyle` or layout read is in a browser: the style engine's animations move to it and the document is
// styled, starting the animations and transitions a change since the last one owes. The events wait for `styleTick`;
// what comes back is the elements whose animations' properties changed since the JS side was last told, if any.
fn style_flush(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let cid = realm_id(scope, &args);
    style_op(scope, cid, |scope| {
        let now = clock_arg(scope, &args, 0);
        let d = dom(scope);
        let (Some(engine), Some(arena)) = (d.styles.get_mut(&cid), d.arena.enter_known(cid)) else { return };
        engine.flush(arena, now);
        let failures = engine.take_verify_failures();
        let retargeted = engine.web_animations.take_retargeted();
        if threw_verify_failures(scope, failures) || retargeted.is_empty() {
            return;
        }
        let items: Vec<v8::Local<v8::Value>> = retargeted.iter().map(|n| v8::Number::new(scope, n.to_f64()).into()).collect();
        rv.set(v8::Array::new_with_elements(scope, &items).into());
    });
}

// __dom.styleTick(now) -> [retargeted count, nid…, then type, nid, pseudo, name, elapsedTime, animation, scheduled, …]:
// a rendering update at `now` (the page's clock, ms): a style flush — the elements whose animations' properties
// changed first, as `styleFlush` gives them — and the animation / transition events the state changes since the last
// update owe, handed back in order (`pseudo` null for an element's own; `animation` the engine's id of the CSS
// animation or transition it is about; `scheduled` its scheduled event time on the timeline).
fn style_tick(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    rv: v8::ReturnValue<'_, v8::Value>,
) {
    let cid = realm_id(scope, &args);
    style_op(scope, cid, |scope| style_tick_unguarded(scope, args, rv));
}
fn style_tick_unguarded(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let now = clock_arg(scope, &args, 0);
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let (Some(engine), Some(arena)) = (d.styles.get_mut(&cid), d.arena.enter_known(cid)) else { return };
    // (The Web Animations' frame first: it moves their timeline, and the flush composes what it moved.)
    engine.web_animations_op(|animations| animations.tick(now));
    engine.flush(arena, now);
    let failures = engine.take_verify_failures();
    let events = engine.take_animation_events(arena);
    let retargeted = engine.web_animations.take_retargeted();
    if threw_verify_failures(scope, failures) {
        return;
    }
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(1 + retargeted.len() + events.len() * ANIMATION_EVENT_STRIDE);
    items.push(v8::Number::new(scope, retargeted.len() as f64).into());
    items.extend(retargeted.iter().map(|n| -> v8::Local<v8::Value> { v8::Number::new(scope, n.to_f64()).into() }));
    push_animation_events(scope, &mut items, events);
    let array = v8::Array::new_with_elements(scope, &items);
    rv.set(array.into());
}

// __dom.styleTakeAnimationEvents() -> [type, nid, pseudo, name, elapsedTime, animation, scheduled, …]: the CSS
// animation and transition events queued since the last update, as `styleTick` hands them back, without moving
// anything — what a script queued in that update's microtask checkpoint (a `cancel()` in a `ready` reaction) is due in
// the same update (web-animations §4.2 step 4).
fn style_take_animation_events(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let (Some(engine), Some(arena)) = (d.styles.get_mut(&cid), d.arena.enter_known(cid)) else { return };
    let events = engine.take_animation_events(arena);
    let mut items: Vec<v8::Local<v8::Value>> = Vec::with_capacity(events.len() * ANIMATION_EVENT_STRIDE);
    push_animation_events(scope, &mut items, events);
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

const ANIMATION_EVENT_STRIDE: usize = 7;
fn push_animation_events<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    items: &mut Vec<v8::Local<'s, v8::Value>>,
    events: Vec<crate::style::AnimationEvent>,
) {
    for e in events {
        items.push(v8::String::new(scope, e.kind).map_or_else(|| v8::undefined(scope).into(), Into::into));
        items.push(v8::Number::new(scope, e.node.to_f64()).into());
        items.push(match e.pseudo.and_then(|p| v8::String::new(scope, p)) {
            Some(p) => p.into(),
            None => v8::null(scope).into(),
        });
        items.push(v8::String::new(scope, &e.name).map_or_else(|| v8::undefined(scope).into(), Into::into));
        items.push(v8::Number::new(scope, e.elapsed).into());
        items.push(v8::Number::new(scope, e.animation as f64).into());
        items.push(v8::Number::new(scope, e.scheduled).into());
    }
}

// __dom.resetArena() — the CALLING REALM starts a new page (a navigation): its state afresh (`RealmArena::reset`), and
// its walk's kept pass and measures (`walk_reuse`), which name the old page's nodes: dead the moment the page is, rather
// than after the idle passes that would evict them (`walk_reuse::IDLE_PASSES`).
fn reset_arena(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let cid = realm_id(scope, &args);
    realm(scope, cid).reset();
    crate::text_codec::drop_realm(scope, cid);   // (…a page's stream decoders die with it)
    dom(scope).walk_reuse.remove(&cid);
    // …and the style engine forgets the nodes it held (its sheets stay until the new page sets its own).
    if let Some(engine) = dom(scope).styles.get_mut(&cid) {
        engine.reset();
    }
}

// __dom.adoptSubtree(nid) — a subtree another realm made joined a tree of this realm, in the slots it has
// (`RealmArena::adopt`).
fn adopt_subtree(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    realm(scope, cid).adopt(id);
}

// __dom.handleEdgesMismatch(nid) -> where the node's handle's tree edges, or its position, disagree with its slot's tree
// (`RealmArena::edge_mismatch`), or undefined — verify mode's check on what keeps the node alive.
fn handle_edges_mismatch(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let Some(id) = nid_arg(scope, &args, 0) else { return };
    let cid = realm_id(scope, &args);
    if let Some(message) = realm(scope, cid).edge_mismatch(id) {
        let s = v8::String::new(scope, &message).expect("a short string");
        rv.set(s.into());
    }
}

// __dom.dropRealm(id) — free realm `id`'s state and nodes entirely (not the caller's own). csim calls this as it
// disposes a frame realm, so a page's frames don't accumulate across visits. Main (id 0) is not dropped — it reuses
// its id across resets, cleared per page by resetArena.
fn drop_realm(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    _rv: v8::ReturnValue<'_, v8::Value>,
) {
    if let Some(id) = args.get(0).integer_value(scope) {
        let d = dom(scope);
        let id = id as i32;
        d.arena.drop_realm(id);
        d.styles.remove(&id);          // (…and its style engine)
        d.walk_reuse.remove(&id);      // (…and its Rust walk's last pass)
        crate::text_codec::drop_realm(scope, id);   // (…and the stream decoders it left open)
    }
}

// __dom.registerFontPath(face) -> handle (>=0), or -1 when the face can't be read/parsed. The host resolved the face
// (`font::face_name`) via fontconfig; native parses it (skrifa) into an advance table, cached.
fn register_font_path(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let path = args.get(0).to_rust_string_lossy(scope);
    rv.set_int32(crate::font::register_path(&path));
}

// __dom.registerFontScaled(handle, scale) -> handle: the face `handle` under a `size-adjust` of `scale`.
fn register_font_scaled(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let handle = args.get(0).int32_value(scope).unwrap_or(-1);
    let scale = args.get(1).number_value(scope).unwrap_or(f64::NAN);
    rv.set_int32(if scale.is_finite() && scale > 0.0 { crate::font::register_scaled(handle, scale) } else { -1 });
}

// __dom.registerFontStack(primary, members) -> handle: a `unicode-range` split, `members` a flat [handle, ascOverride,
// descOverride, gapOverride, rangeCount, lo, hi, …] list in pick order — each member's `@font-face` metric overrides (NaN
// for none: its file's metrics, `FontMetrics::face`), and rangeCount -1 where it covers every code point.
fn register_font_stack(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let primary = args.get(0).int32_value(scope).unwrap_or(-1);
    let flat = f64_arg(args.get(1));
    let mut members = Vec::new();
    let mut i = 0;
    while i + 4 < flat.len() {
        let (handle, overrides, count) = (flat[i] as i32, [flat[i + 1], flat[i + 2], flat[i + 3]].map(|v| v.is_finite().then_some(v)), flat[i + 4]);
        i += 5;
        let ranges = if count < 0.0 {
            None
        } else {
            let n = count as usize;
            if i + 2 * n > flat.len() {
                break;
            }
            let r = (0..n).map(|k| (flat[i + 2 * k] as u32, flat[i + 2 * k + 1] as u32)).collect();
            i += 2 * n;
            Some(r)
        };
        let vertical = crate::font::with_font(handle, |fm| fm.face(overrides).map(|(v, _, _)| v)).flatten();
        members.push(crate::font::StackMember { ranges, handle, vertical });
    }
    rv.set_int32(crate::font::register_stack(primary, members));
}

// A Float64Array argument's values, read IN PLACE rather than copied out twice through a byte vector. Copied only
// where the view is not aligned for f64 (a view at an odd byte offset, which no caller makes). The borrow is sound
// because nothing between here and the op's answer runs JS or allocates on V8's heap, so nothing can move the data;
// the answer is made after the last read.
pub(crate) enum F64Arg<'a> {
    Borrowed(&'a [f64]),
    Owned(Vec<f64>),
}
impl std::ops::Deref for F64Arg<'_> {
    type Target = [f64];
    fn deref(&self) -> &[f64] {
        match self {
            F64Arg::Borrowed(s) => s,
            F64Arg::Owned(v) => v,
        }
    }
}
pub(crate) fn f64_arg<'a>(val: v8::Local<'a, v8::Value>) -> F64Arg<'a> {
    let Ok(arr) = v8::Local::<v8::Float64Array>::try_from(val) else {
        return F64Arg::Owned(Vec::new());
    };
    let n = arr.length();
    let ptr = arr.data() as *const f64;
    if n == 0 || ptr.is_null() {
        return F64Arg::Owned(Vec::new());
    }
    if (ptr as usize) % std::mem::align_of::<f64>() == 0 {
        // SAFETY: `n` f64s of the view's own data (V8 hands the pointer past its byte offset), valid and unmoved for the
        // borrow as argued above.
        return F64Arg::Borrowed(unsafe { std::slice::from_raw_parts(ptr, n) });
    }
    let mut bytes = vec![0u8; n * 8];
    arr.copy_contents(&mut bytes);
    F64Arg::Owned(bytes.chunks_exact(8).map(|c| f64::from_ne_bytes(c.try_into().unwrap())).collect())
}

// Write `vals` into the Float64Array `val` (as many as it holds) — how an op answers a few numbers without making an
// array for them on every call.
pub(crate) fn write_f64s(val: v8::Local<'_, v8::Value>, vals: &[f64]) {
    let Ok(arr) = v8::Local::<v8::Float64Array>::try_from(val) else { return };
    let n = arr.length().min(vals.len());
    let ptr = arr.data() as *mut f64;
    if n == 0 || ptr.is_null() || (ptr as usize) % std::mem::align_of::<f64>() != 0 {
        return;
    }
    // SAFETY: the view's own data past its byte offset, `n` f64s of it, aligned, and no Rust reference to it is held.
    unsafe { std::ptr::copy_nonoverlapping(vals.as_ptr(), ptr, n) };
}

// __dom.layoutMeasureCounts() -> [put back, kept, records held, records spliced, records walked]: the Rust walk's kept
// measures (`layout::MeasureCache` in `walk_reuse`), and the records it spliced back from its last pass rather than built
// (`Walk::splice`) and those it built, for a spec and the perf gate.
fn layout_measure_counts(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) {
    let cid = realm_id(scope, &args);
    let d = dom(scope);
    let mut counts = [0.0; 5];
    if let Some(m) = d.walk_reuse.get(&cid).map(|r| &r.measure) {
        counts[0] = m.put_back as f64;
        counts[1] = m.kept as f64;
        counts[2] = m.records() as f64;
    }
    counts[3] = d.walk_reuse.get(&cid).map_or(0.0, |r| r.spliced_records as f64);
    counts[4] = d.walk_reuse.get(&cid).map_or(0.0, |r| r.walked_records as f64);
    let out = v8::Array::new(scope, 5);
    for (i, n) in counts.into_iter().enumerate() {
        let v: v8::Local<v8::Value> = v8::Number::new(scope, n).into();
        out.set_index(scope, i as u32, v);
    }
    rv.set(out.into());
}


// A Float64Array holding `vals` — how a pass hands a flat table back to JS in one crossing.
// A Uint8Array of `bytes`, which it takes over.
pub(crate) fn u8_array<'s>(scope: &mut v8::PinScope<'s, '_>, bytes: Vec<u8>) -> v8::Local<'s, v8::Value> {
    let len = bytes.len();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
    v8::Uint8Array::new(scope, buffer, 0, len).map_or_else(|| v8::undefined(scope).into(), Into::into)
}
// …and a Uint8ClampedArray: pixels.
pub(crate) fn u8_clamped_array<'s>(scope: &mut v8::PinScope<'s, '_>, bytes: Vec<u8>) -> v8::Local<'s, v8::Value> {
    let len = bytes.len();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
    v8::Uint8ClampedArray::new(scope, buffer, 0, len).map_or_else(|| v8::undefined(scope).into(), Into::into)
}
pub(crate) fn f64_array<'s>(scope: &mut v8::PinScope<'s, '_>, vals: &[f64]) -> v8::Local<'s, v8::Float64Array> {
    let mut bytes = Vec::with_capacity(vals.len() * 8);
    vals.iter().for_each(|v| bytes.extend_from_slice(&v.to_ne_bytes()));
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    let buf = v8::ArrayBuffer::with_backing_store(scope, &store);
    v8::Float64Array::new(scope, buf, 0, vals.len()).expect("a Float64Array over its own backing store")
}



// __dom.nowNanos() -> a process-monotonic wall time in nanoseconds (as a Number). csim's own clock (Date.now /
// performance.now) is the VIRTUAL event-loop clock, which no amount of work inside one synchronous JS turn moves as a
// wall clock would — so a timing taken from INSIDE JS (a scaling spec, a benchmark) reads this one. Not a web API.
// Anchored to the first call so the value stays a small integer that an f64 represents exactly (nanos fit exactly
// below 2^53 ≈ 104 days of uptime).
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
// interceptors work in the RIGHT realm's state and on the RIGHT node generation — the template is
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
        // (…an attribute named like an array index — `<div 2=a>` — is a key V8 hands the INDEXED handler)
        tmpl.set_indexed_property_handler(
            v8::IndexedPropertyHandlerConfiguration::new()
                .getter(|scope: &mut v8::PinScope<'_, '_>, index: u32, args: v8::PropertyCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>| attr_get(scope, &index.to_string(), &args, rv))
                .setter(|scope: &mut v8::PinScope<'_, '_>, index: u32, value: v8::Local<'_, v8::Value>, args: v8::PropertyCallbackArguments<'_>, _rv: v8::ReturnValue<'_, ()>| attr_set(scope, &index.to_string(), value, &args))
                .query(|scope: &mut v8::PinScope<'_, '_>, index: u32, args: v8::PropertyCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Integer>| attr_query(scope, &index.to_string(), &args, rv))
                .deleter(|scope: &mut v8::PinScope<'_, '_>, index: u32, args: v8::PropertyCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Boolean>| attr_delete(scope, &index.to_string(), &args, rv))
                .descriptor(|scope: &mut v8::PinScope<'_, '_>, index: u32, args: v8::PropertyCallbackArguments<'_>, rv: v8::ReturnValue<'_, v8::Value>| attr_descriptor(scope, &index.to_string(), &args, rv)),
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
    rv: v8::ReturnValue<'_, v8::Value>,
) -> v8::Intercepted {
    match name_string(scope, key) {
        Some(name) => attr_get(scope, &name, &args, rv),
        None => v8::Intercepted::kNo,
    }
}
fn attr_get(
    scope: &mut v8::PinScope<'_, '_>,
    name: &str,
    args: &v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) -> v8::Intercepted {
    let Some(id) = holder_node_id(scope, args) else {
        return v8::Intercepted::kNo;
    };
    let cid = holder_realm_id(scope, args);
    // Prefer the lossless UTF-16 override (a value that carried a lone surrogate); else the UTF-8. Clone
    // the chosen representation out of the node borrow so the V8 string can be built with the scope after.
    let value: Option<Result<Vec<u16>, String>> = realm(scope, cid).get(id).and_then(|n| {
        match n.get_attr_u16(name) {
            Some(u) => Some(Ok(u.to_vec())),
            None => n.get_attr(name).map(|v| Err(v.to_string())),
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
    match name_string(scope, key) {
        Some(name) => attr_set(scope, &name, value, &args),
        None => v8::Intercepted::kNo,
    }
}
fn attr_set(
    scope: &mut v8::PinScope<'_, '_>,
    name: &str,
    value: v8::Local<'_, v8::Value>,
    args: &v8::PropertyCallbackArguments<'_>,
) -> v8::Intercepted {
    let Some(id) = holder_node_id(scope, args) else {
        return v8::Intercepted::kNo;
    };
    let cid = holder_realm_id(scope, args);
    let (utf8, u16) = read_v8_value(scope, value);
    let (arena, engine) = arena_and_engine(scope, cid);
    before_attribute_write(arena, engine, id, &[name]);
    if let Some(node) = arena.get_mut(id) {
        node.set_attr_full(name, utf8, u16);
    }
    v8::Intercepted::kYes
}

fn attrs_query(
    scope: &mut v8::PinScope<'_, '_>,
    key: v8::Local<'_, v8::Name>,
    args: v8::PropertyCallbackArguments<'_>,
    rv: v8::ReturnValue<'_, v8::Integer>,
) -> v8::Intercepted {
    match name_string(scope, key) {
        Some(name) => attr_query(scope, &name, &args, rv),
        None => v8::Intercepted::kNo,
    }
}
fn attr_query(
    scope: &mut v8::PinScope<'_, '_>,
    name: &str,
    args: &v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Integer>,
) -> v8::Intercepted {
    let Some(id) = holder_node_id(scope, args) else {
        return v8::Intercepted::kNo;
    };
    let cid = holder_realm_id(scope, args);
    let present = realm(scope, cid).get(id).is_some_and(|n| n.get_attr(name).is_some());
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
    rv: v8::ReturnValue<'_, v8::Boolean>,
) -> v8::Intercepted {
    match name_string(scope, key) {
        Some(name) => attr_delete(scope, &name, &args, rv),
        None => v8::Intercepted::kNo,
    }
}
fn attr_delete(
    scope: &mut v8::PinScope<'_, '_>,
    name: &str,
    args: &v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Boolean>,
) -> v8::Intercepted {
    let Some(id) = holder_node_id(scope, args) else {
        return v8::Intercepted::kNo;
    };
    let cid = holder_realm_id(scope, args);
    let (arena, engine) = arena_and_engine(scope, cid);
    before_attribute_write(arena, engine, id, &[name]);
    if let Some(node) = arena.get_mut(id) {
        node.remove_attr(name);
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
    rv: v8::ReturnValue<'_, v8::Value>,
) -> v8::Intercepted {
    match name_string(scope, key) {
        Some(name) => attr_descriptor(scope, &name, &args, rv),
        None => v8::Intercepted::kNo,
    }
}
fn attr_descriptor(
    scope: &mut v8::PinScope<'_, '_>,
    name: &str,
    args: &v8::PropertyCallbackArguments<'_>,
    mut rv: v8::ReturnValue<'_, v8::Value>,
) -> v8::Intercepted {
    let Some(id) = holder_node_id(scope, args) else {
        return v8::Intercepted::kNo;
    };
    let cid = holder_realm_id(scope, args);
    let value: Option<Result<Vec<u16>, String>> = realm(scope, cid).get(id).and_then(|n| {
        match n.get_attr_u16(name) {
            Some(u) => Some(Ok(u.to_vec())),
            None => n.get_attr(name).map(|v| Err(v.to_string())),
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
// works in the OWNER realm's state. Defaults to 0 (main) if absent.
fn holder_realm_id(scope: &mut v8::PinScope<'_, '_>, args: &v8::PropertyCallbackArguments<'_>) -> i32 {
    args.holder()
        .get_internal_field(scope, 1)
        .and_then(|d| v8::Local::<v8::Value>::try_from(d).ok())
        .and_then(|v| v.int32_value(scope))
        .unwrap_or(0)
}
