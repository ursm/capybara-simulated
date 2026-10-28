// The style engine's sheets, as a document or a shadow root has them: each sheet owner's — a `<style>`'s made of its
// block (HTML "update a style block"), a `<link>`'s or an `<?xml-stylesheet?>`'s of the sheet fetched for its `href`
// (HTML "process the linked resource": sheet_fetch.rs) — ONE per owner (`MadeSheet`), its `@import`s fetched and handed
// over before it is used (sheet_fetch.rs `resolve_imports`); and the list of them a document's or a shadow root's
// style engine is handed — the owners whose sheets take part, in tree order (`sheet_set`), its adopted ones after them
// (dom.rs `set_document_sheets`, `set_shadow_sheets`).

use std::rc::Rc;

use crate::dom::{dom, nid_arg, realm, realm_id, register, NodeId, NodeKind, RealmArena};
use crate::font_files::Terminated;
use crate::sheet_owners::MadeSheet;

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "ownerSheet", owner_sheet_op, context_id);
    register(scope, ns, "fetchedSheet", fetched_sheet_op, context_id);
    register(scope, ns, "styleRebuild", style_rebuild_op, context_id);
    register(scope, ns, "styleFeed", style_feed_op, context_id);
    register(scope, ns, "styleFeedShadows", style_feed_shadows_op, context_id);
}

// The style engine's sheet of `owner`, made of `css` — the text its fetch gave, none for a `<style>`'s block (the data of
// its child Text nodes) — at `base` under `media` in a document of mode `quirks`: made again of other text, of the same
// text once the owner obtained another sheet (its count of them, sheet_owners.rs — HTML's "update a style block", which
// any change to a block's text is), at another base or in another mode — in place where no CSSStyleSheet shows it, else
// anew under another id (`MadeSheet::shown`), `rev` moving either way — and given another media list in place, its rules
// kept. Its sheet while the owner's count holds (`owner_sheets`). As `(id, rev, what its `@import`s wait for)`, none
// for an owner freed.
fn make(scope: &mut v8::PinScope<'_, '_>, cid: i32, owner: NodeId, css: Option<Rc<str>>, base: &str, media: &str, quirks: bool) -> Option<(u32, u32, Vec<(String, Option<String>)>)> {
    let arena = realm(scope, cid);
    let count = arena.get(owner)?.sheet_gen;
    // (…another realm's record — the owner adopted from it — is its own realm's to let go of: this one makes its own)
    let made = match arena.made_sheets.get(&owner).cloned() {
        Some(m) if m.realm != cid => {
            arena.forget_made_sheet(owner);
            None
        }
        made => made,
    };
    // (…its text the same — the same text at once — or none, a `<style>`'s block, whose every change is a new count)
    let same_text = |m: &MadeSheet| match (&m.text, &css) {
        (None, None) => true,
        (Some(had), Some(css)) => Rc::ptr_eq(had, css) || had == css,
        _ => false,
    };
    let same = made.as_ref().filter(|m| m.base == base && m.quirks == quirks && m.count == count && same_text(m)).cloned();
    let media_moved = same.as_ref().is_some_and(|m| m.media != media);
    // (…a sheet handed its text a fetched one — a `<link>`'s, an `<?xml-stylesheet?>`'s — of a location of its own)
    let located = css.is_some();
    let (id, rev, shown, waiting) = match (&same, made.as_ref()) {
        (Some(m), _) => (m.id, m.rev, m.shown, Vec::new()),
        (None, old) => {
            let text = match &css {
                Some(css) => css.to_string(),
                None => String::from_utf16_lossy(&arena.child_text(owner)),
            };
            let source = crate::sheets::SheetSource { css: text, base: base.to_owned(), media: media.to_owned(), constructed: false, located };
            let lock = arena.style_lock.0.clone();
            match old {
                Some(m) if !m.shown => (m.id, m.rev + 1, false, arena.sheets.replace(&lock, m.id, &source, quirks)),
                _ => {
                    let (id, waiting) = arena.sheets.make(&lock, &source, quirks);
                    (id, old.map_or(0, |m| m.rev + 1), false, waiting)
                }
            }
        }
    };
    let failed = same.as_ref().is_some_and(|m| m.failed);
    let record = MadeSheet { realm: cid, id, rev, shown, text: css, failed, base: base.to_owned(), media: media.to_owned(), quirks, count };
    arena.made_sheets.insert(owner, record);
    if same.is_none() {
        // (…a new sheet, made in place or anew, the owner's: its flags its own, as "add a CSS style sheet" begins them)
        if let Some(stored) = arena.sheets.stored_mut(id) {
            stored.owner = Some(owner);
            stored.located = located;
            stored.disabled = false;
            stored.enabled = false;
            stored.set_excluded = false;
        }
        arena.owner_sheets.insert(owner, (id, count));
        arena.sheet_epoch += 1;
    }
    if media_moved {
        crate::dom::own_sheet_in(scope, cid, id);
        let arena = realm(scope, cid);
        let lock = arena.style_lock.0.clone();
        arena.sheets.set_media(&lock, id, media, quirks);
        crate::dom::rules_moved_in(scope, cid, Some(id));
    }
    Some((id, rev, waiting))
}

// The document a connected owner is in — its node document: the root of its shadow-including tree.
fn document_of(arena: &RealmArena, owner: NodeId) -> Option<NodeId> {
    let root = arena.shadow_including_root(owner);
    arena.is_document(root).then_some(root)
}

// A `<style>`'s sheet (`make`), of its block at its document's base URL under its `media`, its `@import`s handed over.
fn style_sheet(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, style: NodeId) -> Result<Option<(u32, u32)>, Terminated> {
    let arena = realm(scope, cid);
    let Some(media) = arena.get(style).map(|n| n.plain_attr("media").unwrap_or("").to_owned()) else { return Ok(None) };
    let doc = document_of(arena, style);
    let base = doc.map(|d| arena.document_base_url(d)).unwrap_or_default();
    let quirks = arena.document_mode(doc).0;
    let Some((id, rev, waiting)) = make(scope, cid, style, None, &base, &media, quirks) else { return Ok(None) };
    crate::sheet_fetch::resolve_imports(scope, cid, host, waiting, doc, None)?;
    Ok(Some((id, rev)))
}

// A `<link>`'s or an `<?xml-stylesheet?>`'s sheet (`make`), of the sheet fetched for its `href` (sheet_fetch.rs `fetch`:
// an `<?xml-stylesheet?>`'s as no element's, with no `charset` of its own) under its `media` — fetched once for the
// sheet it obtains (its count, `NodeData::sheet_gen`), whose text makes it again in another mode or under another media
// list — at the URL its response came from, origin-clean where that was CORS-same-origin, its `@import`s decoded in the
// encoding it decoded in. Where it was not fetched — its `href` no URL, or no response to use — none, tried again the
// next time; or with `empty`, an empty sheet at its URL, origin-clean only where the response it failed with was
// CORS-same-origin: what `.sheet` exposes for one (Chrome, Firefox).
fn fetched_sheet(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, owner: NodeId, empty: bool) -> Result<Option<(u32, u32)>, Terminated> {
    let arena = realm(scope, cid);
    let Some(n) = arena.get(owner) else { return Ok(None) };
    let pi = n.kind == NodeKind::ProcessingInstruction;
    let (href, media) = if pi {
        let attrs = crate::sheet_owners::pi_attributes(n).unwrap_or_default();
        let get = |name: &str| attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
        (get("href"), get("media"))
    } else {
        (n.plain_attr("href").map(str::to_owned), n.plain_attr("media").map(str::to_owned))
    };
    let Some(href) = href else { return Ok(None) };
    let media = media.unwrap_or_default();
    let count = n.sheet_gen;
    let doc = document_of(arena, owner);
    let quirks = arena.document_mode(doc).0;
    // (…its origin-clean flag the kept sheet's, which a sheet made anew of its text takes too)
    let kept = arena.made_sheets.get(&owner).filter(|m| m.realm == cid && m.count == count && !m.failed).and_then(|m| Some((m.text.clone()?, m.base.clone(), m.id)));
    let (text, location, clean) = match kept {
        Some((text, location, id)) => {
            let clean = arena.sheets.stored_mut(id).is_none_or(|s| !s.origin_dirty);
            (text, location, Some((clean, false)))
        }
        None => {
            let url = doc.and_then(|d| arena.parse_document_url(d, &href)).map(|u| u.href().to_owned());
            let sheet = match &url {
                Some(url) => Some(crate::sheet_fetch::fetch(scope, cid, host, (!pi).then_some(crate::sheet_fetch::Owner { id: owner, doc }), url, None, None)?),
                None => None,
            };
            match sheet {
                Some(crate::sheet_fetch::Sheet { text: Some(text), clean, location, .. }) => (Rc::from(text), location, Some((clean, false))),
                // (…origin-clean as the response it failed with was — a same-origin HTTP error's: its rules, none, readable —
                // at that response's URL)
                Some(crate::sheet_fetch::Sheet { clean, location, .. }) if empty => (Rc::from(""), location, Some((clean, true))),
                _ if empty => (Rc::from(""), url.unwrap_or(href), Some((false, true))),
                _ => return Ok(None),
            }
        }
    };
    let Some((id, rev, waiting)) = make(scope, cid, owner, Some(text), &location, &media, quirks) else { return Ok(None) };
    let arena = realm(scope, cid);
    if let Some((clean, failed)) = clean {
        if let Some(stored) = arena.sheets.stored_mut(id) {
            stored.origin_dirty = !clean;
        }
        if let Some(made) = arena.made_sheets.get_mut(&owner) {
            made.failed = failed;
        }
    }
    let environment = crate::sheet_fetch::encoding_of(arena, cid, &location).map(str::to_owned);
    crate::sheet_fetch::resolve_imports(scope, cid, host, waiting, doc, environment)?;
    Ok(Some((id, rev)))
}

// The sheets of `owners` — a document's or a shadow root's that take part, in order (`sheet_set`) — each one's id: none
// for one whose sheet was not fetched (`fetched_sheet`).
fn owner_sheet_ids(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, owners: &[NodeId]) -> Result<Vec<u32>, Terminated> {
    let mut ids = Vec::with_capacity(owners.len());
    for &owner in owners {
        let style = realm(scope, cid).get(owner).is_some_and(|n| n.kind == NodeKind::Element && &*n.local_name == "style");
        let sheet = if style { style_sheet(scope, cid, host, owner)? } else { fetched_sheet(scope, cid, host, owner, false)? };
        ids.extend(sheet.map(|(id, _)| id));
    }
    Ok(ids)
}

// The realm document `doc`'s sheets — those of `owners` — handed to its style engine, at its base URL.
fn feed_document(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, doc: NodeId, owners: &[NodeId]) -> Result<(), Terminated> {
    let ids = owner_sheet_ids(scope, cid, host, owners)?;
    let base = realm(scope, cid).document_base_url(doc);
    crate::dom::style_op(scope, cid, |scope| crate::dom::set_document_sheets(scope, cid, doc, &base, ids));
    Ok(())
}

// Each shadow root's own sheets in `doc` handed to the style engine — a root's again where the realm's rule-set
// generation moved since it was last (a shadow tree's sheets move it without the document's key seeing it) — the
// hosts the document's shadow-including tree has now (`shadow_including_elements`), which is how a host connected since
// is found.
fn feed_shadows(scope: &mut v8::PinScope<'_, '_>, cid: i32, host: v8::Local<'_, v8::Function>, doc: NodeId) -> Result<(), Terminated> {
    let arena = realm(scope, cid);
    let version = arena.generations.get(crate::dom::GEN_CASCADE);
    let hosts = arena.shadow_including_elements(doc, |n| n.shadow_root.is_some());
    let roots: Vec<NodeId> = hosts.iter().filter_map(|&h| arena.get(h).and_then(|n| n.shadow_root)).collect();
    // (…a root no longer in it forgotten)
    let present: std::collections::HashSet<NodeId> = roots.iter().copied().collect();
    arena.shadow_sheets_fed.retain(|root, _| present.contains(root));
    for root in roots {
        if realm(scope, cid).shadow_sheets_fed.insert(root, version) == Some(version) {
            continue;
        }
        let owners = realm(scope, cid).sheet_set(root).taking_part.clone();
        let ids = owner_sheet_ids(scope, cid, host, &owners)?;
        crate::dom::style_op(scope, cid, |scope| crate::dom::set_shadow_sheets(scope, cid, root, ids));
    }
    Ok(())
}

fn host_arg<'s>(args: &v8::FunctionCallbackArguments<'s>, i: i32) -> Option<v8::Local<'s, v8::Function>> {
    v8::Local::<v8::Function>::try_from(args.get(i)).ok()
}
fn sheet_value(scope: &mut v8::PinScope<'_, '_>, rv: &mut v8::ReturnValue<'_, v8::Value>, sheet: Option<(u32, u32)>) {
    let Some((id, rev)) = sheet else { return };
    let items = [v8::Integer::new_from_unsigned(scope, id).into(), v8::Integer::new_from_unsigned(scope, rev).into()];
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

// __dom.ownerSheet(styleNid, host) -> [sheetId, rev] of a connected `<style>`'s sheet (`style_sheet`), undefined for none.
fn owner_sheet_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(style), Some(host)) = (nid_arg(scope, &args, 0), host_arg(&args, 1)) else { return };
    let cid = realm_id(scope, &args);
    if let Ok(sheet) = style_sheet(scope, cid, host, style) {
        sheet_value(scope, &mut rv, sheet);
    }
}

// __dom.fetchedSheet(ownerNid, host) -> [sheetId, rev] of a connected `<link>`'s or `<?xml-stylesheet?>`'s sheet — an
// empty one where it was not fetched (`fetched_sheet`) — undefined for one with no `href`.
fn fetched_sheet_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(owner), Some(host)) = (nid_arg(scope, &args, 0), host_arg(&args, 1)) else { return };
    let cid = realm_id(scope, &args);
    if let Ok(sheet) = fetched_sheet(scope, cid, host, owner, true) {
        sheet_value(scope, &mut rv, sheet);
    }
}

// __dom.styleRebuild(docNid, host) -> whether the realm document's cascade was made of other sheets than its style
// engine was last handed (sheet_owners.rs `cascade_rekey`), and so handed them — none of the redundant rebuilds a page
// graft schedules (a build, then one per linked sheet's deferred load, all of the same sheet sets and viewport).
fn style_rebuild_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    rv.set_bool(false);
    let (Some(doc), Some(host)) = (nid_arg(scope, &args, 0), host_arg(&args, 1)) else { return };
    let cid = realm_id(scope, &args);
    let size = crate::viewport::of(scope, cid);
    let d = dom(scope);
    let screen = crate::style::Screen { viewport: (size[0] as f32, size[1] as f32), touch: d.touch_input };
    let engine = d.styles.get(&cid);
    let Some(owners) = d.arena.enter(cid).cascade_rekey(engine, screen, doc, cid) else { return };
    rv.set_bool(true);
    let _ = feed_document(scope, cid, host, doc, &owners);
}

// __dom.styleFeed(docNid, host): the realm document's sheets that take part (`sheet_set`) handed to its style engine.
fn style_feed_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(doc), Some(host)) = (nid_arg(scope, &args, 0), host_arg(&args, 1)) else { return };
    let cid = realm_id(scope, &args);
    let owners = realm(scope, cid).sheet_set(doc).taking_part.clone();
    let _ = feed_document(scope, cid, host, doc, &owners);
}

// __dom.styleFeedShadows(docNid, host): the shadow roots' own sheets in the realm document handed to its style engine
// where they moved (`feed_shadows`).
fn style_feed_shadows_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let (Some(doc), Some(host)) = (nid_arg(scope, &args, 0), host_arg(&args, 1)) else { return };
    let cid = realm_id(scope, &args);
    let _ = feed_shadows(scope, cid, host, doc);
}
