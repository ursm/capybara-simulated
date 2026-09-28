// Native author cascade: the rule set the JS cascade collected, held here per realm, and for ONE element the
// winning declaration of EVERY property its rules declare — picked in one pass over its candidate rules, each
// matched once, instead of a walk of the candidates per property read.
//
// Every layout rule is loaded, but only a STATIC one is matched here: one the arena matcher answers (a compiled
// selector handle) and whose answer no generation-untracked state can move — no dynamic pseudo-class, no `:has()`,
// no `:host()` prefix, no namespace prefix. Any other rule comes back unmatched, as a CANDIDATE the element's own
// buckets select, for the JS side to match and to merge over this table under the same order (`winsProp`) — so the
// element's buckets are gathered once, here, for both halves.
//
// Candidates are pre-filtered by an ANCESTOR BLOOM FILTER, as Servo's own cascade does: each selector's
// `AncestorHashes` (the ids, classes and names its ancestor compounds require) are tested against a filter of the
// element's ancestors before the matcher walks up to look. The filter only ever says "cannot match", so what it
// skips is exactly what the matcher would have refused.
//
// Declarations cross as integers: a property is an index into the JS side's property table and a declaration an
// index into its declaration table (value, importance, specificity, source, layer, order), so an answer is pairs
// of numbers and the JS side hands back records it built once per rule set.

use std::collections::HashMap;

use precomputed_hash::PrecomputedHash;
use selectors::bloom::BloomFilter;
use selectors::context::{
    MatchingContext, MatchingForInvalidation, MatchingMode, NeedsSelectorFlags, SelectorCaches,
};
use selectors::matching::{matches_selector, selector_may_match};
use selectors::parser::AncestorHashes;

use crate::dom::{NodeId, RealmArena};
use crate::selector::{quirks_mode, with_compiled, CssStr, NodeRef, HTML_NS, NO_NAMESPACE};

// The terminal-key bucket a rule sits in, as the JS `terminalKey` put it (`bucketFor`): the element's own
// identifiers select the buckets it could match, so an element only tests those. Any other kind (0) is universal.
const TERM_CLASS: u32 = 1;
const TERM_ID: u32 = 2;
const TERM_TAG: u32 = 3;
const TERM_ATTR: u32 = 4;
const TERM_ROOT: u32 = 5;

// What `winsProp` compares, less the inline origin (which the JS side layers on top).
#[derive(Clone, Copy)]
struct Key {
    important: bool,
    // `layerPriority`: an unlayered rule is +∞ when normal and −∞ when important; a layer's rank flips its sign
    // when important. Higher wins.
    layer_priority: f64,
    spec: [u32; 3],
    source: f64,
}

impl Key {
    // Does `self`, met later, beat `cur`? The JS `winsProp`, in its order: importance, layer, specificity, and at
    // an equal everything the later source (`>=`, so a later candidate at the same source wins, as there).
    fn wins_over(&self, cur: &Key) -> bool {
        if self.important != cur.important {
            return self.important;
        }
        if self.layer_priority != cur.layer_priority {
            return self.layer_priority > cur.layer_priority;
        }
        if self.spec != cur.spec {
            return self.spec > cur.spec;
        }
        self.source >= cur.source
    }
}

struct Decl {
    prop: u32,
    decl: u32,
    important: bool,
}

struct Rule {
    // The compiled selector, or -1 for a rule the JS side matches (reported as a candidate, never matched here).
    handle: i32,
    // Per selector of the compiled list, what its ancestors must carry (empty for a JS-side rule).
    hashes: Vec<AncestorHashes>,
    spec: [u32; 3],
    source: f64,
    // The rule's `layerRank`, or None for an unlayered rule.
    layer: Option<f64>,
    decls: Vec<Decl>,
}

#[derive(Default)]
pub(crate) struct CascadeStore {
    rules: Vec<Rule>,
    by_class: HashMap<String, Vec<u32>>,
    by_id: HashMap<String, Vec<u32>>,
    by_tag: HashMap<String, Vec<u32>>,
    by_attr: HashMap<String, Vec<u32>>,
    root: Vec<u32>,
    universal: Vec<u32>,
    // Per-property scratch for one element's answer: the winner so far and the answer it belongs to (`stamp`),
    // so a new answer needs no clearing pass over every property.
    best: Vec<(u32, Key, u32)>,
    touched: Vec<u32>,
    stamp: u32,
    // The document's mode: a class or id selector matches ASCII case-insensitively in quirks mode, so the JS side
    // keys those buckets lowercased and they are asked for lowercased here, and the matcher is told.
    quirks: bool,
}

fn layer_priority(layer: Option<f64>, important: bool) -> f64 {
    match layer {
        None => {
            if important {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            }
        }
        Some(rank) => {
            if important {
                -rank
            } else {
                rank
            }
        }
    }
}

impl CascadeStore {
    // Replace the rule set. `nums` is the JS packer's flat record per rule —
    //   handle, spec a, spec b, spec c, source, layered (0/1), layer rank, term kind, term key (index into `keys`),
    //   declaration count, then per declaration: property, declaration, important (0/1)
    // — and `keys` the term-key strings it names. A record that runs past the buffer ends the load there: a
    // truncated table answers for fewer rules, which the JS side never trusts, since it checks the count.
    pub(crate) fn load(nums: &[f64], keys: &[String], prop_count: usize, quirks: bool) -> CascadeStore {
        let mut store = CascadeStore {
            best: vec![(0, Key { important: false, layer_priority: 0.0, spec: [0; 3], source: 0.0 }, 0); prop_count],
            quirks,
            ..Default::default()
        };
        let mut i = 0;
        while i + 10 <= nums.len() {
            let handle = nums[i] as i32;
            let spec = [nums[i + 1] as u32, nums[i + 2] as u32, nums[i + 3] as u32];
            let source = nums[i + 4];
            let layer = if nums[i + 5] != 0.0 { Some(nums[i + 6]) } else { None };
            let kind = nums[i + 7] as u32;
            let key = keys.get(nums[i + 8] as usize);
            let n = nums[i + 9] as usize;
            i += 10;
            if i + 3 * n > nums.len() {
                break;
            }
            let decls = (0..n)
                .map(|k| Decl {
                    prop: nums[i + 3 * k] as u32,
                    decl: nums[i + 3 * k + 1] as u32,
                    important: nums[i + 3 * k + 2] != 0.0,
                })
                .filter(|d| (d.prop as usize) < prop_count)
                .collect();
            i += 3 * n;
            let ri = store.rules.len() as u32;
            let hashes = if handle < 0 {
                Vec::new()
            } else {
                with_compiled(|c| match c.get(handle as usize) {
                    Some(list) => list.slice().iter().map(|s| AncestorHashes::new(s, quirks_mode(quirks))).collect(),
                    None => Vec::new(),
                })
            };
            store.rules.push(Rule { handle, hashes, spec, source, layer, decls });
            let bucket = match (kind, key) {
                (TERM_CLASS, Some(k)) => store.by_class.entry(k.clone()).or_default(),
                (TERM_ID, Some(k)) => store.by_id.entry(k.clone()).or_default(),
                (TERM_TAG, Some(k)) => store.by_tag.entry(k.clone()).or_default(),
                (TERM_ATTR, Some(k)) => store.by_attr.entry(k.clone()).or_default(),
                (TERM_ROOT, _) => &mut store.root,
                _ => &mut store.universal,
            };
            bucket.push(ri);
        }
        store
    }

    pub(crate) fn rule_count(&self) -> usize {
        self.rules.len()
    }

    // A class or id bucket, asked for as the JS side keyed it: lowercased in a quirks-mode document.
    fn bucket_folded<'a>(&self, map: &'a HashMap<String, Vec<u32>>, key: &str) -> Option<&'a Vec<u32>> {
        if self.quirks && key.bytes().any(|c| c.is_ascii_uppercase()) {
            map.get(key.to_ascii_lowercase().as_str())
        } else {
            map.get(key)
        }
    }

    // Every candidate of `id`'s buckets, in the JS `walkIndex` order (tag, id, classes, attributes, root,
    // universal). The order decides nothing — `wins_over` is a total order on distinct rules — but keeping it
    // keeps a trace of the two comparable.
    fn candidates(&self, arena: &RealmArena, id: NodeId, out: &mut Vec<u32>) {
        let Some(node) = arena.get(id) else { return };
        // The JS side keys a tag bucket on the lowercased name (`terminalKey`) and looks it up with `_tag`, which is
        // lowercased too — so a case-preserved `foreignObject` / `clipPath` is asked for in lowercase here.
        let tag = &node.local_name;
        let bucket = if tag.bytes().any(|c| c.is_ascii_uppercase()) {
            self.by_tag.get(tag.to_ascii_lowercase().as_str())
        } else {
            self.by_tag.get(tag.as_str())
        };
        if let Some(b) = bucket {
            out.extend_from_slice(b);
        }
        if let Some(v) = node.get_attr("id") {
            if !v.is_empty() {
                if let Some(b) = self.bucket_folded(&self.by_id, v) {
                    out.extend_from_slice(b);
                }
            }
        }
        if let Some(cls) = node.get_attr("class") {
            for c in cls.split_ascii_whitespace() {
                if let Some(b) = self.bucket_folded(&self.by_class, c) {
                    out.extend_from_slice(b);
                }
            }
        }
        if !self.by_attr.is_empty() {
            for (name, _) in &node.attributes {
                let b = self.by_attr.get(name.as_str()).or_else(|| {
                    if name.bytes().any(|c| c.is_ascii_uppercase()) {
                        self.by_attr.get(name.to_ascii_lowercase().as_str())
                    } else {
                        None
                    }
                });
                if let Some(b) = b {
                    out.extend_from_slice(b);
                }
            }
        }
        if !self.root.is_empty() && arena.parent_of(id).is_some_and(|p| arena.is_document(p)) {
            out.extend_from_slice(&self.root);
        }
        out.extend_from_slice(&self.universal);
    }

    // `id`'s answer, written to `out` as
    //   [winner count W, candidate count C, then W (property, declaration) pairs, then C rule indices]
    // — the winning declaration of every property its static rules declare, and the JS-side rules its buckets
    // select, unmatched. None when that does not fit (the caller then runs its own cascade for the element) or
    // the node is not in the arena.
    pub(crate) fn answer(&mut self, arena: &RealmArena, id: NodeId, out: &mut [i32]) -> Option<usize> {
        arena.get(id)?;
        let mut cand = Vec::new();
        self.candidates(arena, id, &mut cand);
        self.stamp = self.stamp.wrapping_add(1);
        if self.stamp == 0 {
            for b in &mut self.best {
                b.0 = 0;
            }
            self.stamp = 1;
        }
        self.touched.clear();
        let bloom = ancestor_bloom(arena, id);
        let el = NodeRef { arena, id };
        let rules = &self.rules;
        let best = &mut self.best;
        let touched = &mut self.touched;
        let stamp = self.stamp;
        let mut js: Vec<u32> = Vec::new();
        with_compiled(|compiled| {
            let mut caches = SelectorCaches::default();
            let mut ctx = MatchingContext::new(
                MatchingMode::Normal,
                None,
                &mut caches,
                quirks_mode(self.quirks),
                NeedsSelectorFlags::No,
                MatchingForInvalidation::No,
            );
            for &ri in &cand {
                let rule = &rules[ri as usize];
                if rule.handle < 0 {
                    js.push(ri);
                    continue;
                }
                let Some(list) = compiled.get(rule.handle as usize) else { continue };
                let hit = list
                    .slice()
                    .iter()
                    .zip(&rule.hashes)
                    .any(|(sel, h)| selector_may_match(h, &bloom) && matches_selector(sel, 0, None, &el, &mut ctx));
                if !hit {
                    continue;
                }
                for d in &rule.decls {
                    let key = Key {
                        important: d.important,
                        layer_priority: layer_priority(rule.layer, d.important),
                        spec: rule.spec,
                        source: rule.source,
                    };
                    let slot = &mut best[d.prop as usize];
                    if slot.0 != stamp {
                        *slot = (stamp, key, d.decl);
                        touched.push(d.prop);
                    } else if key.wins_over(&slot.1) {
                        slot.1 = key;
                        slot.2 = d.decl;
                    }
                }
            }
        });
        let w = self.touched.len();
        let len = 2 + 2 * w + js.len();
        if len > out.len() {
            return None;
        }
        out[0] = w as i32;
        out[1] = js.len() as i32;
        for (k, &p) in self.touched.iter().enumerate() {
            out[2 + 2 * k] = p as i32;
            out[3 + 2 * k] = self.best[p as usize].2 as i32;
        }
        for (k, &ri) in js.iter().enumerate() {
            out[2 + 2 * w + k] = ri as i32;
        }
        Some(len)
    }
}

// What `id`'s ancestors carry, in the form a selector's `AncestorHashes` are tested against: every ancestor's name,
// namespace, id and classes, hashed as the selector parser hashed them (`CssStr`'s precomputed hash). An HTML
// element's empty namespace is the HTML namespace to a selector (`has_namespace`), so that is what goes in.
fn ancestor_bloom(arena: &RealmArena, id: NodeId) -> BloomFilter {
    let mut bloom = BloomFilter::new();
    let hash = |s: &str| CssStr(s.to_owned()).precomputed_hash();
    let mut cur = arena.parent_of(id);
    while let Some(p) = cur {
        let Some(node) = arena.get(p) else { break };
        if arena.is_document(p) {
            break;
        }
        bloom.insert_hash(hash(&node.local_name));
        let ns = if node.ns.is_empty() {
            HTML_NS
        } else if node.ns == NO_NAMESPACE {
            ""
        } else {
            &node.ns
        };
        bloom.insert_hash(hash(ns));
        if let Some(v) = node.get_attr("id") {
            if !v.is_empty() {
                bloom.insert_hash(hash(v));
            }
        }
        if let Some(cls) = node.get_attr("class") {
            for c in cls.split_ascii_whitespace() {
                bloom.insert_hash(hash(c));
            }
        }
        cur = arena.parent_of(p);
    }
    bloom
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(important: bool, layer: Option<f64>, spec: [u32; 3], source: f64) -> Key {
        Key { important, layer_priority: layer_priority(layer, important), spec, source }
    }

    #[test]
    fn importance_then_layer_then_specificity_then_source() {
        // Important beats a higher specificity.
        assert!(key(true, None, [0, 0, 1], 1.0).wins_over(&key(false, None, [1, 0, 0], 2.0)));
        // Unlayered beats layered when normal, loses when important.
        assert!(key(false, None, [0, 0, 1], 1.0).wins_over(&key(false, Some(3.0), [1, 0, 0], 2.0)));
        assert!(!key(true, None, [1, 0, 0], 2.0).wins_over(&key(true, Some(3.0), [0, 0, 1], 1.0)));
        // A later layer wins when normal, an earlier one when important.
        assert!(key(false, Some(2.0), [0, 0, 1], 1.0).wins_over(&key(false, Some(1.0), [1, 0, 0], 2.0)));
        assert!(key(true, Some(1.0), [0, 0, 1], 1.0).wins_over(&key(true, Some(2.0), [1, 0, 0], 2.0)));
        // Specificity, then the later source (inclusive).
        assert!(key(false, None, [0, 1, 0], 1.0).wins_over(&key(false, None, [0, 0, 5], 2.0)));
        assert!(key(false, None, [0, 1, 0], 2.0).wins_over(&key(false, None, [0, 1, 0], 2.0)));
        assert!(!key(false, None, [0, 1, 0], 1.0).wins_over(&key(false, None, [0, 1, 0], 2.0)));
    }
}
