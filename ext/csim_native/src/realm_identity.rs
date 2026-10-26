// Who a realm is to the host, as the host told it (`realmIdentify`): the service-worker client id its document adopted
// (a navigation's reserved one, a dedicated or shared worker's), the window key of a window `window.open` made — the
// realm of its first document, which the documents it navigates to keep — and a worker's handle, its agent's owner token
// and whether it is a module worker. Kept in the realm's state (`RealmState::identity`), for its context's lifetime.

#[derive(Default)]
pub(crate) struct RealmIdentity {
    client_id: Option<String>,
    window_key: Option<u32>,
    worker_handle: u32,
    agent_owner: u64,
    module_worker: bool,
}
impl RealmIdentity {
    // (…its agent's owner token, 0 for none: agents.rs `agentJoin`)
    pub(crate) fn agent_owner(&self) -> u64 {
        self.agent_owner
    }
}

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "realmIdentify", identify_op, context_id);
    crate::dom::register(scope, ns, "realmClientId", client_id_op, context_id);
    crate::dom::register(scope, ns, "realmWindowKey", window_key_op, context_id);
    crate::dom::register(scope, ns, "workerHandle", worker_handle_op, context_id);
    crate::dom::register(scope, ns, "moduleWorker", module_worker_op, context_id);
}

// The calling realm's identity, `f` asked of it — none for a realm of no state.
fn of<T>(scope: &mut v8::PinScope<'_, '_>, cid: i32, f: impl FnOnce(&RealmIdentity) -> T) -> Option<T> {
    crate::dom::realm(scope, cid).realm_state(cid).map(|s| f(&s.identity))
}

// __dom.realmIdentify(field, value): the host's telling of the calling realm's `field` — 'clientId' (a string),
// 'windowKey', 'workerHandle', 'agentOwner' (numbers), 'moduleWorker' (true).
fn identify_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let field = args.get(0).to_rust_string_lossy(scope);
    let value = args.get(1);
    let (text, number, flag) = (value.to_rust_string_lossy(scope), value.integer_value(scope).unwrap_or(0), value.boolean_value(scope));
    let cid = crate::dom::realm_id(scope, &args);
    let Some(s) = crate::dom::realm(scope, cid).realm_state_mut(cid) else { return };
    let identity = &mut s.identity;
    match field.as_str() {
        "clientId" => identity.client_id = Some(text).filter(|id| !id.is_empty()),
        "windowKey" => identity.window_key = Some(number as u32),
        "workerHandle" => identity.worker_handle = number as u32,
        "agentOwner" => identity.agent_owner = number as u64,
        "moduleWorker" => identity.module_worker = flag,
        _ => {}
    }
}

// __dom.realmClientId() -> the client id the calling realm adopted, or undefined for none (sw-client.js `clientId`
// mints one of its realm then).
fn client_id_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    let Some(Some(id)) = of(scope, cid, |i| i.client_id.clone()) else { return };
    if let Some(s) = v8::String::new(scope, &id) {
        rv.set(s.into());
    }
}

// __dom.realmWindowKey(realm) -> the window key of realm `realm` (the calling one's where none is given) — a window
// `window.open` made — or undefined for a realm of none: a window's key its realm's id then (window.js `windowKey`).
fn window_key_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = if args.get(0).is_number() { args.get(0).int32_value(scope).unwrap_or(0) } else { crate::dom::realm_id(scope, &args) };
    if let Some(Some(key)) = of(scope, cid, |i| i.window_key) {
        rv.set_uint32(key);
    }
}

// __dom.workerHandle() -> the calling worker's handle (0 for a window's realm).
fn worker_handle_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    rv.set_uint32(of(scope, cid, |i| i.worker_handle).unwrap_or(0));
}

// __dom.moduleWorker() -> whether the calling realm is a module worker's (`{type: 'module'}`).
fn module_worker_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let cid = crate::dom::realm_id(scope, &args);
    rv.set_bool(of(scope, cid, |i| i.module_worker).unwrap_or(false));
}
