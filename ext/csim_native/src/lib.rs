// capybara-simulated's native extension.
//
// One cdylib that bundles the V8 engine (rusty_racer, linked as a library) and the
// native DOM (`mod dom`). Ruby loads THIS .so; it defines the same RustyRacer::*
// surface by calling rusty_racer's own class installer, then registers the native
// DOM to be installed into every realm through rusty_racer's generic hook. The
// engine itself stays a pure V8 binding with no DOM knowledge.

// The Web Animations model: the timeline, animations and their effects' timing; and the ops a JS handle asks it with.
mod adopt;
mod animation_ops;
mod animations;
mod autofocus;
mod av1;
mod blob_rules;
mod blob_urls;
mod canvas;
mod canvas_paint;
mod canvas_path;
mod canvas_state;
mod canvas_text;
mod caret;
mod ce_reactions;
mod change_on_blur;
mod character_data;
mod cloning;
mod range_contents;
mod element_references;
mod clone;
mod connection_steps;
mod collections;
mod combobox;
mod css;
mod css_animations;
mod css_transitions;
mod custom_elements;
mod details;
mod dialogs;
mod cssom_decl;
mod cssom_rule;
// The native author cascade: a realm's static rules, and one element's winning declarations in one pass.
mod document_encoding;
mod document_state;
mod dom;
mod dom_matrix;
mod easing;
mod editing;
mod element_flags;
mod editing_commands;
mod editing_delete;
mod editing_insert;
mod element_state;
mod event_path;
mod focus;
// Native text metrics (fontations) — used IN-PROCESS by inline layout (mod layout); the JS side
// registers a font (registerFontPath) to a handle it names the face by (`walkFace`).
mod font;
mod font_faces;
mod form_entries;
mod form_state;
mod fontconfig;
mod geometry;
// HTML's presentational hints: the declarations an element's attributes add to the cascade.
mod hints;
mod hit_test;
mod input_value;
mod input_types;
mod intersection;
mod intersection_observers;
mod html_parse;
mod data_url;
mod event_stream;
mod fetch_rules;
mod headers;
mod idb;
mod idb_databases;
mod image_decode;
mod image_encode;
mod image_requests;
mod drag_data_store;
mod paint;
mod perf_timeline;
mod request_state;
mod response_state;
mod search_params;
mod sw_router;
mod ws_state;
mod url_pattern;
mod storage_areas;
mod xhr_state;
mod keys;
mod cache_matching;
mod sandbox;
mod service_worker;
mod sw_registry;
mod integrity;
mod pointer;
mod webcrypto;
mod import_map;
mod image_source;
// Layout: the records the walk builds (mod walk) laid out, driven by the `layoutBuild` op (mod walk_ops).
mod keyframes;
mod layout;
mod legacy;
mod media;
mod mime;
mod multipart;
mod mutation;
mod mutation_observers;
mod foreign_observations;
mod frame_navigation;
mod navigables;
mod observation_list;
mod namespaces;
mod node_handle;
mod numbers;
mod node_iterators;
mod ranges;
mod reflect;
mod reflect_keywords;
// Bringing a box into view: the scroll boxes that move, and to where (`scrollIntoView`, a driver's scroll-if-needed).
// What is rendered, and the text it renders (`innerText`, the visible text a driver reads).
mod rendered;
mod script;
mod resize_observation;
mod resize_observers;
mod resource_timing;
mod resolved;
mod scroll_boxes;
mod scroll_events;
mod scroll_into_view;
mod selection;
mod selector;
mod serialize;
mod sheet_owners;
mod sheets;
mod slots;
// The style engine: stylo over the arena.
mod style;
mod style_fonts;
mod subresources;
mod svg_geometry;
mod tables;
mod attributes;
mod selected_content;
mod nonce;
mod popovers;
mod activation;
mod text;
mod text_codec;
mod text_geometry;
mod text_selection;
mod timers;
mod toggle_tasks;
mod selected_coordinates;
mod realm_location;
mod font_files;
mod token_list;
mod traversal;
// The Unicode classes layout asks of a character, parsed out of the regex that spells them by regex-syntax.
mod unicode;
mod url_ops;
mod validity;
mod values;
mod video;
mod walk;
mod walk_ops;
mod walk_reuse;
mod xml_parse;
mod xpath;
mod yuv;

use magnus::{Error, Module, Ruby};

#[magnus::init]
fn init(ruby: &Ruby) -> Result<(), Error> {
    // Define RustyRacer::Isolate / Context / Snapshot / … exactly as the standalone
    // gem would — the engine code is the same, only the cdylib owner differs.
    rusty_racer::install_classes(ruby)?;
    // Install the native DOM (globalThis.__dom + its templates) into every realm,
    // main and frames alike, via the engine's DOM-agnostic seam.
    rusty_racer::set_realm_init_hook(dom::install);
    // Build the Unicode class tables now: a regex-syntax feature missing at build time has to surface HERE, at
    // `require`, where magnus turns the panic into a Ruby-level failure that names it — not later on the
    // layout path, which runs inside a V8 `extern "C"` callback where the unwind aborts the process instead.
    unicode::init();
    // …and expose them: the suite checks them against what the JS engine (V8) answers for the same
    // regex, which is the invariant `unicode.rs` rests on. Nothing in the driver itself calls this.
    // fontconfig resolves every font family: a machine without it fails here, saying so, not on the first page.
    fontconfig::require().map_err(|e| Error::new(ruby.exception_load_error(), e))?;
    let native = ruby
        .define_module("Capybara")?
        .define_module("Simulated")?
        .define_module("Native")?;
    native.define_module_function("unicode_class_ranges", magnus::function!(unicode::class_ranges, 1))?;
    // HTML's "encode" for a form the host submits in its legacy submission encoding.
    native.define_module_function("form_encode", magnus::function!(text_codec::form_encode, 2))?;
    // An image resource's bytes decoded to RGBA, on whichever thread fetched them.
    native.define_module_function("decode_image", magnus::function!(image_decode::decode_for_ruby, 3))?;
    // A web font's file unwrapped from its WOFF / WOFF2 container.
    native.define_module_function("font_sfnt", magnus::function!(font::sfnt_for_ruby, 1))?;
    // A font pattern matched, and the families it is substituted through, by this machine's fontconfig.
    native.define_module_function("font_match", magnus::function!(fontconfig::font_match_for_ruby, 1))?;
    native.define_module_function("font_family_list", magnus::function!(font_faces::family_list_for_ruby, 1))?;
    // The document's import map, as the page's module loader keeps it (import_map.rs).
    native.define_module_function("import_map_resolve", magnus::function!(import_map::resolve_for_ruby, 3))?;
    native.define_module_function("import_map_integrity", magnus::function!(import_map::integrity_for_ruby, 2))?;
    native.define_module_function("font_strong_families", magnus::function!(fontconfig::strong_families_for_ruby, 1))?;
    // A URL's parts as the URL Standard's parser makes them, the page's own (url_ops.rs).
    native.define_module_function("url_parts", magnus::function!(url_ops::parts_for_ruby, 2))?;
    native.define_module_function("url_fragment_navigation", magnus::function!(url_ops::is_fragment_navigation_for_ruby, 2))?;
    // A `data:` URL's MIME type and body, by Fetch's data: URL processor, the page's too (data_url.rs).
    native.define_module_function("data_url", magnus::function!(data_url::process_for_ruby, 1))?;
    // A GET form submission's URL: the action's query the entry list (url_ops.rs `mutated_action_url`), the page's too.
    native.define_module_function("form_action_url", magnus::function!(url_ops::mutated_action_url_for_ruby, 2))?;
    // A live `text/event-stream`'s chunks read into events by a parser kept between them, as the page reads a whole one
    // (event_stream.rs).
    native.define_module_function("event_stream_open", magnus::function!(event_stream::open_for_ruby, 0))?;
    native.define_module_function("event_stream_feed", magnus::function!(event_stream::feed_for_ruby, 2))?;
    native.define_module_function("event_stream_close", magnus::function!(event_stream::close_for_ruby, 1))?;
    // Fetch's fixed header, method and port rules, the page's too (fetch_rules.rs).
    native.define_module_function("bad_port", magnus::function!(fetch_rules::bad_port_for_ruby, 1))?;
    native.define_module_function("link_noopener", magnus::function!(token_list::noopener_for_ruby, 2))?;
    native.define_module_function("site", magnus::function!(realm_location::site_for_ruby, 1))?;
    native.define_module_function("target_keyword", magnus::function!(navigables::target_keyword_for_ruby, 1))?;
    native.define_module_function("link_noreferrer", magnus::function!(token_list::noreferrer_for_ruby, 1))?;
    native.define_module_function("cors_safelisted_method", magnus::function!(fetch_rules::cors_safelisted_method_for_ruby, 1))?;
    native.define_module_function("redirect_to_get", magnus::function!(fetch_rules::redirect_to_get_for_ruby, 2))?;
    native.define_module_function("service_worker_response_allowed", magnus::function!(fetch_rules::service_worker_response_allowed_for_ruby, 4))?;
    native.define_module_function("service_worker_start_register", magnus::function!(service_worker::start_register_for_ruby, 4))?;
    native.define_module_function("service_worker_max_scope", magnus::function!(service_worker::max_scope_for_ruby, 3))?;
    // A session's service worker registrations (sw_registry.rs).
    native.define_module_function("sw_partition_new", magnus::function!(sw_registry::partition_new_for_ruby, 0))?;
    native.define_module_function("sw_clear", magnus::function!(sw_registry::clear_for_ruby, 1))?;
    native.define_module_function("sw_registrations", magnus::function!(sw_registry::registrations_for_ruby, 1))?;
    native.define_module_function("sw_note_registered", magnus::function!(sw_registry::note_registered_for_ruby, 2))?;
    native.define_module_function("sw_versions", magnus::function!(sw_registry::versions_for_ruby, 2))?;
    native.define_module_function("sw_set_version", magnus::function!(sw_registry::set_version_for_ruby, 4))?;
    native.define_module_function("sw_worker_new", magnus::function!(sw_registry::worker_new_for_ruby, 4))?;
    native.define_module_function("sw_worker", magnus::function!(sw_registry::worker_for_ruby, 2))?;
    native.define_module_function("sw_set_worker_state", magnus::function!(sw_registry::set_worker_state_for_ruby, 3))?;
    native.define_module_function("sw_note_client", magnus::function!(sw_registry::note_client_for_ruby, 7))?;
    native.define_module_function("sw_set_client_controller", magnus::function!(sw_registry::set_client_controller_for_ruby, 3))?;
    native.define_module_function("sw_forget_client", magnus::function!(sw_registry::forget_client_for_ruby, 2))?;
    native.define_module_function("sw_forget_clients", magnus::function!(sw_registry::forget_clients_for_ruby, 1))?;
    native.define_module_function("sw_clients", magnus::function!(sw_registry::clients_for_ruby, 1))?;
    native.define_module_function("sw_client_entry", magnus::function!(sw_registry::client_entry_for_ruby, 2))?;
    native.define_module_function("sw_set_focused", magnus::function!(sw_registry::set_focused_for_ruby, 2))?;
    native.define_module_function("sw_client", magnus::function!(sw_registry::client_for_ruby, 4))?;
    native.define_module_function("sw_match_clients", magnus::function!(sw_registry::match_clients_for_ruby, 5))?;
    native.define_module_function("sw_schedule_job", magnus::function!(sw_registry::schedule_job_for_ruby, 9))?;
    native.define_module_function("sw_job", magnus::function!(sw_registry::job_for_ruby, 2))?;
    native.define_module_function("sw_finish_job", magnus::function!(sw_registry::finish_job_for_ruby, 2))?;
    native.define_module_function("sw_registrations_of_origin", magnus::function!(sw_registry::registrations_of_origin_for_ruby, 2))?;
    native.define_module_function("sw_match_registration", magnus::function!(sw_registry::match_registration_for_ruby, 3))?;
    native.define_module_function("sw_registered_at", magnus::function!(sw_registry::registered_at_for_ruby, 2))?;
    native.define_module_function("sw_begin_lifecycle", magnus::function!(sw_registry::begin_lifecycle_for_ruby, 2))?;
    native.define_module_function("sw_note_phase", magnus::function!(sw_registry::note_phase_for_ruby, 4))?;
    native.define_module_function("sw_advance", magnus::function!(sw_registry::advance_for_ruby, 3))?;
    native.define_module_function("sw_awaits_activation", magnus::function!(sw_registry::awaits_activation_for_ruby, 2))?;
    native.define_module_function("sw_note_activating", magnus::function!(sw_registry::note_activating_for_ruby, 3))?;
    native.define_module_function("sw_activated", magnus::function!(sw_registry::activated_for_ruby, 3))?;
    native.define_module_function("sw_unregister", magnus::function!(sw_registry::unregister_for_ruby, 2))?;
    native.define_module_function("sw_clear_registration", magnus::function!(sw_registry::clear_registration_for_ruby, 2))?;
    native.define_module_function("sw_forget_worker", magnus::function!(sw_registry::forget_worker_for_ruby, 2))?;
    native.define_module_function("sw_forget_activating", magnus::function!(sw_registry::forget_activating_for_ruby, 2))?;
    native.define_module_function("sw_update_via_cache", magnus::function!(sw_registry::update_via_cache_for_ruby, 2))?;
    native.define_module_function("sw_set_update_via_cache", magnus::function!(sw_registry::set_update_via_cache_for_ruby, 3))?;
    native.define_module_function("sw_navigation_preload", magnus::function!(sw_registry::navigation_preload_for_ruby, 2))?;
    native.define_module_function("sw_set_navigation_preload", magnus::function!(sw_registry::set_navigation_preload_for_ruby, 4))?;
    native.define_module_function("cors_safelisted_request_header", magnus::function!(fetch_rules::cors_safelisted_request_header_for_ruby, 2))?;
    native.define_module_function("cors_safelisted_response_header", magnus::function!(fetch_rules::cors_safelisted_response_header_for_ruby, 1))?;
    native.define_module_function("forbidden_response_header", magnus::function!(fetch_rules::forbidden_response_header_for_ruby, 1))?;
    native.define_module_function("http_token", magnus::function!(fetch_rules::http_token_for_ruby, 1))?;
    native.define_module_function("content_type_essence", magnus::function!(mime::content_type_essence_for_ruby, 1))?;
    native.define_module_function("javascript_content", magnus::function!(script::javascript_content_for_ruby, 1))?;
    native.define_module_function("module_content", magnus::function!(script::module_content_for_ruby, 2))?;
    // A driver session's IndexedDB storage: a new partition of the one registry, cleared as the session resets, and
    // whether an agent of it has notices to take — its event loop has work (idb_databases.rs).
    native.define_module_function("idb_partition_new", magnus::function!(idb_databases::partition_new, 0))?;
    native.define_module_function("storage_partition_new", magnus::function!(storage_areas::partition_new, 0))?;
    native.define_module_function("storage_clear", magnus::function!(storage_areas::clear, 1))?;
    native.define_module_function("idb_clear", magnus::function!(idb_databases::clear, 1))?;
    native.define_module_function("idb_pending", magnus::function!(idb_databases::pending, 1))?;
    Ok(())
}
