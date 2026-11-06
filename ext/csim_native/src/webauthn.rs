// Web Authentication's client and its virtual authenticators (WebAuthn Level 3 §5.1, §6.3, §11): a session's Virtual
// Authenticator Database — every window of it asks the same one, by its partition (lib.rs `session_partition_new`) —
// each authenticator's credentials, the ceremonies run over them, and the encodings they answer in. The driver adds and
// configures the authenticators (`Browser#webauthn`, webauthn.rb, as WebDriver's or CDP's commands do); the bindings
// (webauthn.js) hold what is a JS value: the promise, the abort signal, and the objects a result is made into.
//
// A ceremony is two steps, as the spec's are: `begin`, as the page calls, runs Credential Management's checks in their
// order and makes the request its document's one active request (`RealmState::webauthn_request`), the options
// snapshotted (their BufferSources must be, §5.1.3) and WebAuthn's client steps run, which a task then rejects with; and
// `ask`, in that task, asks the authenticators, again each time the driver adds one or a credential (§5.1.3 "If an
// authenticator becomes available"). A request none answers waits for its lifetime timer, on the agent's event loop as a
// page's own timer is (webauthn.js), so an abort cancels a request no authenticator has answered, and no credential is
// made for it.
//
// ES256 is the one algorithm these authenticators make keys of (a request for no other is one they refuse), and they
// attest a credential with its own key: `packed` self attestation (§8.2), or `none`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};

use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{DerSignature, SigningKey};
use pkcs8::{DecodePrivateKey as _, EncodePublicKey as _};
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};

use crate::dom::{realm_id, register, RealmArena};
use crate::webcrypto::{array_buffer, base64url_decode, base64url_encode, buffer_bytes, fail, get, random_bytes, set, throw, Failure};

type Outcome<T> = Result<T, Failure>;

const ES256: i64 = -7;
const RS256: i64 = -257;
const PUBLIC_KEY: &str = "public-key";

// The authenticator data's flags (§6.1).
const UP: u8 = 0x01;
const UV: u8 = 0x04;
const BE: u8 = 0x08;
const BS: u8 = 0x10;
const AT: u8 = 0x40;

// A public key credential source (§4), server-side or client-side discoverable: a server-side one is kept here too,
// where a real authenticator could encrypt it into its id.
struct Credential {
    id: Vec<u8>,
    key: SigningKey,
    rp_id: String,
    user_handle: Option<Vec<u8>>,
    discoverable: bool,
    // Its signature counter, none for a credential added without one (§11.5): its data says zero.
    counter: Option<u32>,
    backup_eligible: bool,
    backup_state: bool,
}

// A virtual authenticator's properties (§11.2), as Add Virtual Authenticator gives them.
struct Authenticator {
    id: String,
    transport: String,
    has_resident_key: bool,
    has_user_verification: bool,
    is_user_consenting: bool,
    is_user_verified: bool,
    default_backup_eligibility: bool,
    default_backup_state: bool,
    credentials: Vec<Credential>,
}
impl Authenticator {
    // From its Authenticator Configuration, each member's default §11.3's. (CDP's `automaticPresenceSimulation`
    // false is a user who never touches it: no consent, as far as a request can tell. CDP's `cable` is WebAuthn's
    // `hybrid`, and a transport not given a USB one.)
    fn new(id: String, config: &Value) -> Authenticator {
        let flag = |name: &str, default: bool| config.get(name).and_then(Value::as_bool).unwrap_or(default);
        let transport = match config.get("transport").and_then(Value::as_str) {
            Some("cable") => "hybrid",
            Some(transport) => transport,
            None => "usb",
        };
        Authenticator {
            id,
            transport: transport.to_owned(),
            has_resident_key: flag("hasResidentKey", false),
            has_user_verification: flag("hasUserVerification", false),
            is_user_consenting: flag("isUserConsenting", true) && flag("automaticPresenceSimulation", true),
            is_user_verified: flag("isUserVerified", false),
            default_backup_eligibility: flag("defaultBackupEligibility", false),
            default_backup_state: flag("defaultBackupState", false),
            credentials: Vec::new(),
        }
    }
    // Its attachment modality (§11.2): `internal` simulates a platform one, every other transport a roaming one.
    fn attachment(&self) -> &'static str {
        if self.transport == "internal" { "platform" } else { "cross-platform" }
    }
    // The effective user verification requirement of an assertion (§5.1.4.2) — an unknown value is the default,
    // "preferred" (§5.8.6) — none where it requires what the authenticator cannot do.
    fn require_verification(&self, requirement: &str) -> Option<bool> {
        match requirement {
            "required" => self.has_user_verification.then_some(true),
            "discouraged" => Some(false),
            _ => Some(self.has_user_verification),
        }
    }
    // A credential kept (§6.3.2 "credentials map", keyed by RP ID and user handle): a discoverable one in place of
    // the user's last on that RP, and any in place of one with its id.
    fn keep(&mut self, credential: Credential) {
        self.credentials.retain(|c| {
            c.id != credential.id && !(credential.discoverable && c.discoverable && c.rp_id == credential.rp_id && c.user_handle == credential.user_handle)
        });
        self.credentials.push(credential);
    }
}

// What a session's windows share.
#[derive(Default)]
struct Session {
    authenticators: Vec<Authenticator>,
}
// The last authenticator's number and the last request's, every session's: a handle a test kept from before a reset
// names no authenticator made since, and an old document's task no request of the next one's.
static LAST_AUTHENTICATOR: AtomicU64 = AtomicU64::new(0);
static LAST_REQUEST: AtomicU64 = AtomicU64::new(0);

static SESSIONS: LazyLock<Mutex<HashMap<u64, Session>>> = LazyLock::new(Default::default);
fn sessions() -> MutexGuard<'static, HashMap<u64, Session>> {
    SESSIONS.lock().unwrap_or_else(|e| e.into_inner())
}
// A session's forgotten (its storage cleared).
pub(crate) fn clear(partition: u64) {
    sessions().remove(&partition);
}

// ── What the page's document says of itself ─────────────────────────────────────────────────────────────────────────
struct Caller {
    // The serialization of its origin, "null" for an opaque one, and its effective domain (HTML §7.5.2: a domain
    // `document.domain` set, else its host).
    origin: String,
    effective_domain: Option<String>,
    // Whether it is same origin with its ancestors, and its top-level document's origin where it is not.
    cross_origin: bool,
    top_origin: Option<String>,
    has_transient_activation: bool,
}
impl Caller {
    // "effectiveDomain" and the RP ID of a request, `requested` or that domain (§5.1.3 steps 6-8, §5.1.4.1, §5.1.10.1):
    // an opaque origin a NotAllowedError, a host that is no valid domain — an IP address — a SecurityError, and a
    // requested one that is neither the domain nor a registrable domain suffix of it (no public suffix) a SecurityError.
    // HTML's check is of what it parses to, so `LOCALHOST` passes on `localhost`; the RP ID stays as it was given.
    fn rp_id(&self, requested: Option<&str>) -> Outcome<String> {
        let Some(domain) = self.effective_domain.as_deref() else {
            return fail("NotAllowedError", "The origin is opaque.");
        };
        if domain.is_empty() || crate::realm_location::ip_host(domain) {
            return fail("SecurityError", "This is an invalid domain.");
        }
        match requested {
            None => Ok(domain.to_owned()),
            Some(rp_id) if crate::realm_location::domain_host(rp_id).is_some_and(|host| crate::realm_location::registrable_domain_suffix(&host, domain)) => Ok(rp_id.to_owned()),
            Some(rp_id) => fail("SecurityError", format!("The relying party ID '{rp_id}' is not a registrable domain suffix of, nor equal to the current domain.")),
        }
    }
    // The JSON-compatible serialization of its client data (§5.8.1.1).
    fn client_data(&self, kind: &str, challenge: &[u8]) -> Vec<u8> {
        let mut out = format!("{{\"type\":{},\"challenge\":{},\"origin\":{},\"crossOrigin\":{}", ccd_string(kind), ccd_string(&base64url_encode(challenge)), ccd_string(&self.origin), self.cross_origin);
        if let Some(top) = self.top_origin.as_deref().filter(|_| self.cross_origin) {
            out.push_str(",\"topOrigin\":");
            out.push_str(&ccd_string(top));
        }
        out.push('}');
        out.into_bytes()
    }
}
// §5.8.1.1 CCDToString.
fn ccd_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            ' '..='\u{10FFFF}' => out.push(c),
            _ => out.push_str(&format!("\\u{:04x}", c as u32)),
        }
    }
    out.push('"');
    out
}

// ── Permissions Policy, as a frame's container declares it (§5.9) ────────────────────────────────────────────────────
// A container's declared origin (Permissions Policy "declared origin"): none, opaque, for a sandboxed document or
// `sandbox` attribute without `allow-same-origin`; its document's origin (`parent`) for `srcdoc`, no `src` or one that
// does not parse; else the origin of its `src`, relative to its document (`base`).
fn declared_origin(parent: &str, sandbox: Option<&str>, srcdoc: bool, src: Option<&str>, base: &str) -> Option<String> {
    if parent == "null" || crate::sandbox::opaque_origin(None, sandbox) {
        return None;
    }
    let parsed = src.filter(|_| !srcdoc).and_then(|src| ada_url::Url::parse(src, Some(base)).ok());
    Some(parsed.map_or_else(|| parent.to_owned(), |url| url.origin().to_owned()))
}
// What an iframe's `allow` attribute says of `feature` for a document of origin `own` in it: none where it does not name
// it. Its allowlist — `'src'` where it gives none — is `*`, `'self'` (the container document's origin, `parent`), `'src'`
// (its declared origin), `'none'` or origins.
fn allow_attribute_grants(allow: &str, feature: &str, own: &str, parent: &str, declared: Option<&str>) -> Option<bool> {
    let directive = allow.split(';').find(|directive| directive.split_ascii_whitespace().next() == Some(feature))?;
    let mut members = directive.split_ascii_whitespace().skip(1).peekable();
    if members.peek().is_none() {
        return Some(declared == Some(own));
    }
    Some(members.any(|member| match member {
        "*" => true,
        "'self'" => own == parent,
        "'src'" => declared == Some(own),
        "'none'" => false,
        origin => crate::referrer::http_origin(origin).as_deref() == Some(own),
    }))
}
// Whether realm `realm`'s document "is allowed to use" `feature`, whose default allowlist is 'self': at each frame up to
// the top-level document, the container's `allow` attribute where it names the feature, else the frame's being same
// origin with its parent. (A `Permissions-Policy` response header, which no document's policy here is read from, is a
// gap: only an attribute can narrow or delegate a feature.)
fn allowed_to_use(arena: &mut RealmArena, realm: i32, feature: &str) -> bool {
    let mut frame = realm;
    while let Some(parent) = arena.parent_realm(frame) {
        let keys = (crate::referrer::known_origin_key(arena, frame), crate::referrer::known_origin_key(arena, parent));
        let origins = (crate::referrer::known_document(arena, frame), crate::referrer::known_document(arena, parent));
        let (Some(own), Some(parent_origin)) = origins else { return false };
        let same_origin = keys.0.is_some() && keys.0 == keys.1;
        let container = arena.frame_container(parent, frame);
        let base = container.and_then(|c| arena.get(c)).and_then(|_| arena.realm_document(parent)).map(|doc| arena.document_base_url(doc)).unwrap_or_default();
        let node = container.and_then(|c| arena.get(c));
        let declared = node.and_then(|c| declared_origin(&parent_origin, c.plain_attr("sandbox"), c.plain_attr("srcdoc").is_some(), c.plain_attr("src"), &base));
        let named = node.and_then(|c| c.plain_attr("allow")).and_then(|allow| allow_attribute_grants(allow, feature, &own, &parent_origin, declared.as_deref()));
        if !named.unwrap_or(same_origin) {
            return false;
        }
        frame = parent;
    }
    true
}

// ── A ceremony's options, snapshotted ───────────────────────────────────────────────────────────────────────────────
// A PublicKeyCredentialDescriptor: its type (one no client knows it ignores, §5.8.3) and id.
struct Descriptor {
    kind: String,
    id: Vec<u8>,
}
fn known_ids(descriptors: Vec<Descriptor>) -> Vec<Vec<u8>> {
    descriptors.into_iter().filter(|d| d.kind == PUBLIC_KEY).map(|d| d.id).collect()
}

struct CreationOptions {
    timeout: Option<f64>,
    rp_id: Option<String>,
    user_id: Vec<u8>,
    challenge: Vec<u8>,
    // pubKeyCredParams: each type and algorithm.
    parameters: Vec<(String, i64)>,
    exclude: Vec<Descriptor>,
    attachment: Option<String>,
    resident_key: Option<String>,
    require_resident_key: bool,
    user_verification: String,
    attestation: String,
    attestation_formats: Vec<String>,
    cred_props: bool,
    conditional: bool,
}
struct RequestOptions {
    timeout: Option<f64>,
    rp_id: Option<String>,
    challenge: Vec<u8>,
    allow: Vec<Descriptor>,
    user_verification: String,
    conditional: bool,
}

// A request made: its client steps' refusal, which its task rejects with; "silent", which no credential answers
// (Credential Management §2.5.1); or one for the authenticators.
enum Request {
    Refused(Failure),
    Silent,
    Create(Creation),
    Get(Assertion),
}
// A document's one active request of the type (Credential Management's "active credential types"), kept with its
// settings object, so a new document has none: `number` tells a task of the last one's from it, `lifetime` is its timer's
// ms — none for a conditional one, whose lifetime is its document's.
pub(crate) struct ActiveRequest {
    number: u64,
    lifetime: Option<f64>,
    request: Request,
}
// §15.1's recommended range and default for a ceremony's timeout, which a request's is corrected to (§5.1.3 step 4).
fn lifetime_of(timeout: Option<f64>) -> f64 {
    timeout.unwrap_or(300_000.0).clamp(300_000.0, 600_000.0)
}
struct Creation {
    rp_id: String,
    user_id: Vec<u8>,
    client_data: Vec<u8>,
    algorithms: Vec<i64>,
    exclude: Vec<Vec<u8>>,
    attachment: Option<String>,
    resident_key: ResidentKey,
    user_verification: String,
    attestation_formats: Vec<String>,
    cred_props: bool,
}
struct Assertion {
    rp_id: String,
    client_data: Vec<u8>,
    // allowCredentials' ids, had it any — `allow_given` still where it named no type a client knows — none in a
    // conditional request, whose list is a `filter` on what it discovers instead (§5.1.4.1).
    allow: Vec<Vec<u8>>,
    allow_given: bool,
    filter: Vec<Vec<u8>>,
    user_verification: String,
    conditional: bool,
}

// A request's resident key requirement (§5.4.4, its unknown values ignored): `residentKey`, else `requireResidentKey`.
#[derive(Clone, Copy, PartialEq, Debug)]
enum ResidentKey {
    Required,
    Preferred,
    Discouraged,
}
impl ResidentKey {
    fn of(resident_key: Option<&str>, require_resident_key: bool) -> ResidentKey {
        match resident_key {
            Some("required") => ResidentKey::Required,
            Some("preferred") => ResidentKey::Preferred,
            Some("discouraged") => ResidentKey::Discouraged,
            _ if require_resident_key => ResidentKey::Required,
            _ => ResidentKey::Discouraged,
        }
    }
}

// [[Create]]'s client steps (§5.1.3), up to the authenticators.
fn begin_create(options: CreationOptions, caller: &Caller) -> Outcome<Creation> {
    if caller.cross_origin {
        if options.conditional {
            return fail("NotAllowedError", "A conditional create is not allowed in a cross-origin frame.");
        }
        if !caller.has_transient_activation {
            return fail("NotAllowedError", "A user activation is required to create a credential in a cross-origin frame.");
        }
    }
    if !(1..=64).contains(&options.user_id.len()) {
        return fail("TypeError", "Failed to execute 'create' on 'CredentialsContainer': The `user.id` attribute must be between 1 and 64 bytes long.");
    }
    let rp_id = caller.rp_id(options.rp_id.as_deref())?;
    let algorithms: Vec<i64> = if options.parameters.is_empty() {
        vec![ES256, RS256]
    } else {
        options.parameters.iter().filter(|(kind, _)| kind == PUBLIC_KEY).map(|&(_, alg)| alg).collect()
    };
    if algorithms.is_empty() {
        return fail("NotSupportedError", "No entry of `pubKeyCredParams` names a supported credential type.");
    }
    let client_data = caller.client_data("webauthn.create", &options.challenge);
    // (…a conditional create, for a user agent that has recently mediated no authentication: none here ever has)
    if options.conditional {
        return fail("NotAllowedError", "No authentication was recently mediated.");
    }
    // (…the formats `none` leaves one of; an unknown preference is the default, `none`, as §5.4.7 says)
    let attestation_formats = match options.attestation.as_str() {
        "indirect" | "direct" | "enterprise" => options.attestation_formats,
        _ => vec!["none".to_owned()],
    };
    Ok(Creation {
        rp_id,
        user_id: options.user_id,
        client_data,
        algorithms,
        exclude: known_ids(options.exclude),
        attachment: options.attachment.filter(|a| a == "platform" || a == "cross-platform"),
        resident_key: ResidentKey::of(options.resident_key.as_deref(), options.require_resident_key),
        user_verification: options.user_verification,
        attestation_formats,
        cred_props: options.cred_props,
    })
}

// [[DiscoverFromExternalSource]]'s client steps (§5.1.4.1), up to the authenticators.
fn begin_get(options: RequestOptions, caller: &Caller) -> Outcome<Assertion> {
    let rp_id = caller.rp_id(options.rp_id.as_deref())?;
    let client_data = caller.client_data("webauthn.get", &options.challenge);
    let (allow, allow_given, filter) = if options.conditional {
        (Vec::new(), false, options.allow.into_iter().map(|d| d.id).collect())
    } else {
        let allow_given = !options.allow.is_empty();
        (known_ids(options.allow), allow_given, Vec::new())
    };
    Ok(Assertion { rp_id, client_data, allow, allow_given, filter, user_verification: options.user_verification, conditional: options.conditional })
}

// ── Encodings ───────────────────────────────────────────────────────────────────────────────────────────────────────
// A CBOR item's head (RFC 8949 §3): a major type and its argument, in the fewest bytes.
fn cbor_head(out: &mut Vec<u8>, major: u8, n: u64) {
    let major = major << 5;
    match n {
        0..=23 => out.push(major | n as u8),
        24..=0xff => out.extend([major | 24, n as u8]),
        0x100..=0xffff => {
            out.push(major | 25);
            out.extend((n as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(major | 26);
            out.extend((n as u32).to_be_bytes());
        }
        _ => {
            out.push(major | 27);
            out.extend(n.to_be_bytes());
        }
    }
}
fn cbor_int(out: &mut Vec<u8>, n: i64) {
    if n >= 0 {
        cbor_head(out, 0, n as u64);
    } else {
        cbor_head(out, 1, (-1 - n) as u64);
    }
}
fn cbor_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    cbor_head(out, 2, bytes.len() as u64);
    out.extend_from_slice(bytes);
}
fn cbor_text(out: &mut Vec<u8>, text: &str) {
    cbor_head(out, 3, text.len() as u64);
    out.extend_from_slice(text.as_bytes());
}
fn cbor_map(out: &mut Vec<u8>, size: u64) {
    cbor_head(out, 5, size);
}

// A credential public key as a COSE_Key (§6.5.1.1): EC2, ES256, P-256, its coordinates.
fn cose_key(key: &SigningKey) -> Vec<u8> {
    let point = key.verifying_key().to_encoded_point(false);
    let (x, y) = (point.x().expect("an uncompressed point"), point.y().expect("an uncompressed point"));
    let mut out = Vec::with_capacity(77);
    cbor_map(&mut out, 5);
    for (label, value) in [(1, 2), (3, ES256), (-1, 1)] {
        cbor_int(&mut out, label);
        cbor_int(&mut out, value);
    }
    cbor_int(&mut out, -2);
    cbor_bytes(&mut out, x);
    cbor_int(&mut out, -3);
    cbor_bytes(&mut out, y);
    out
}
// Authenticator data (§6.1): the RP ID's hash, the flags, the counter, and any attested credential data — its all-zero
// AAGUID (the one of `none` and of self attestation, §6.5.5), its id, its public key.
fn authenticator_data(rp_id: &str, flags: u8, counter: u32, attested: Option<(&[u8], &SigningKey)>) -> Vec<u8> {
    let mut out = Sha256::digest(rp_id.as_bytes()).to_vec();
    out.push(flags);
    out.extend(counter.to_be_bytes());
    if let Some((id, key)) = attested {
        out.extend([0; 16]);
        out.extend((id.len() as u16).to_be_bytes());
        out.extend_from_slice(id);
        out.extend(cose_key(key));
    }
    out
}
// `key`'s ES256 signature of the authenticator data and the client data's hash (§6.3.3, §8.2), ASN.1 DER (§6.5.5).
fn signature(key: &SigningKey, authenticator_data: &[u8], client_data: &[u8]) -> Vec<u8> {
    let mut signed = authenticator_data.to_vec();
    signed.extend(Sha256::digest(client_data));
    let signature: DerSignature = key.sign(&signed);
    signature.as_bytes().to_vec()
}
// The attestation object (§6.5.4), its map's keys in CTAP2's canonical order: the first of `formats` the authenticator
// supports, else what it prefers, `packed` — a statement of self attestation, no certificate in it — or `none`.
fn attestation_object(formats: &[String], key: &SigningKey, authenticator_data: &[u8], client_data: &[u8]) -> Vec<u8> {
    let packed = formats.iter().find(|f| *f == "none" || *f == "packed").is_none_or(|f| f == "packed");
    let mut out = Vec::new();
    cbor_map(&mut out, 3);
    cbor_text(&mut out, "fmt");
    cbor_text(&mut out, if packed { "packed" } else { "none" });
    cbor_text(&mut out, "attStmt");
    if packed {
        cbor_map(&mut out, 2);
        cbor_text(&mut out, "alg");
        cbor_int(&mut out, ES256);
        cbor_text(&mut out, "sig");
        cbor_bytes(&mut out, &signature(key, authenticator_data, client_data));
    } else {
        cbor_map(&mut out, 0);
    }
    cbor_text(&mut out, "authData");
    cbor_bytes(&mut out, authenticator_data);
    out
}
// (…BS only with BE: "if and only if the credential is a multi-device credential and is currently backed up", §6.1)
fn flags_of(user_verified: bool, backup_eligible: bool, backup_state: bool) -> u8 {
    UP | if user_verified { UV } else { 0 } | if backup_eligible { BE } else { 0 } | if backup_eligible && backup_state { BS } else { 0 }
}

// ── The authenticators' answers ─────────────────────────────────────────────────────────────────────────────────────
struct Created {
    id: Vec<u8>,
    client_data: Vec<u8>,
    attestation_object: Vec<u8>,
    authenticator_data: Vec<u8>,
    public_key: Vec<u8>,
    transport: String,
    attachment: &'static str,
    // credProps' `rk`, where it was asked for.
    resident_key: Option<bool>,
}
struct Asserted {
    id: Vec<u8>,
    client_data: Vec<u8>,
    authenticator_data: Vec<u8>,
    signature: Vec<u8>,
    user_handle: Option<Vec<u8>>,
    attachment: &'static str,
}
enum Answer {
    Created(Created),
    Asserted(Asserted),
}
// What asking the authenticators comes to.
enum Asked {
    Answered(Answer),
    Refused(Failure),
    // None can answer, for now: its lifetime timer runs on.
    Waits,
}

// §6.3.2 authenticatorMakeCredential on `authenticator`: Err a refusal, the status §5.1.3 tells apart only for an
// InvalidStateError. Its gesture includes user verification wherever the authenticator can — whatever the requirement,
// which only says it MUST where it is true — and a verification that fails refuses (Chrome and Firefox, measured).
fn make_credential(authenticator: &mut Authenticator, request: &Creation) -> Outcome<Created> {
    if !request.algorithms.contains(&ES256) {
        return fail("NotSupportedError", "None of the requested algorithms is supported.");
    }
    if authenticator.credentials.iter().any(|c| c.rp_id == request.rp_id && request.exclude.contains(&c.id)) {
        return if authenticator.is_user_consenting {
            fail("InvalidStateError", "The authenticator contains one of the credentials already registered with the relying party.")
        } else {
            fail("NotAllowedError", "The user did not consent.")
        };
    }
    if !authenticator.is_user_consenting || (authenticator.has_user_verification && !authenticator.is_user_verified) {
        return fail("NotAllowedError", "The user did not consent, or was not verified.");
    }
    let key = SigningKey::random(&mut rand_core::OsRng);
    let public_key = match key.verifying_key().to_public_key_der() {
        Ok(der) => der.as_bytes().to_vec(),
        Err(_) => return fail("UnknownError", "The key cannot be encoded."),
    };
    let id = random_bytes(32);
    let discoverable = match request.resident_key {
        ResidentKey::Required | ResidentKey::Preferred => authenticator.has_resident_key,
        ResidentKey::Discouraged => false,
    };
    let (backup_eligible, backup_state) = (authenticator.default_backup_eligibility, authenticator.default_backup_state);
    let flags = flags_of(authenticator.has_user_verification, backup_eligible, backup_state) | AT;
    let data = authenticator_data(&request.rp_id, flags, 0, Some((&id, &key)));
    let attestation_object = attestation_object(&request.attestation_formats, &key, &data, &request.client_data);
    authenticator.keep(Credential {
        id: id.clone(),
        key,
        rp_id: request.rp_id.clone(),
        user_handle: Some(request.user_id.clone()),
        discoverable,
        counter: Some(0),
        backup_eligible,
        backup_state,
    });
    Ok(Created {
        id,
        client_data: request.client_data.clone(),
        attestation_object,
        authenticator_data: data,
        public_key,
        transport: authenticator.transport.clone(),
        attachment: authenticator.attachment(),
        resident_key: request.cred_props.then_some(discoverable),
    })
}

// §6.3.3 authenticatorGetAssertion on `authenticator`. A request naming credentials takes the first it holds; one
// that does not the user's choice among the discoverable ones: the latest, as a real authenticator lists them first.
fn get_assertion(authenticator: &mut Authenticator, request: &Assertion, require_uv: bool) -> Outcome<Asserted> {
    let credentials = &authenticator.credentials;
    let chosen = if request.allow_given {
        request.allow.iter().find_map(|id| credentials.iter().position(|c| c.rp_id == request.rp_id && &c.id == id))
    } else {
        credentials.iter().rposition(|c| c.discoverable && c.rp_id == request.rp_id && (request.filter.is_empty() || request.filter.contains(&c.id)))
    };
    let Some(chosen) = chosen else {
        return fail("NotAllowedError", "No credential matches the request.");
    };
    let (consenting, verified, attachment) = (authenticator.is_user_consenting, authenticator.is_user_verified, authenticator.attachment());
    let credential = &mut authenticator.credentials[chosen];
    if !consenting || (require_uv && !verified) {
        return fail("NotAllowedError", "The user did not consent, or was not verified.");
    }
    if let Some(counter) = credential.counter.as_mut() {
        *counter = counter.wrapping_add(1);
    }
    let flags = flags_of(require_uv, credential.backup_eligible, credential.backup_state);
    let data = authenticator_data(&request.rp_id, flags, credential.counter.unwrap_or(0), None);
    let signature = signature(&credential.key, &data, &request.client_data);
    Ok(Asserted {
        id: credential.id.clone(),
        client_data: request.client_data.clone(),
        authenticator_data: data,
        signature,
        // (…a server-side credential's its authenticator did not keep: the user handle is of a discoverable one)
        user_handle: credential.user_handle.clone().filter(|handle| credential.discoverable && !handle.is_empty()),
        attachment,
    })
}

const NOT_ALLOWED: &str = "The operation either timed out or was not allowed.";

// §5.1.3's steps over the authenticators, in the order they were added — one with a discoverable credential's place
// first where the relying party prefers one. An authenticator's refusal removes it from the request, save an
// InvalidStateError, which ends it; and with none left the request's lifetime has nothing left to wait for.
fn finish_create(session: &mut Session, request: &Creation) -> Outcome<Created> {
    let mut candidates: Vec<&mut Authenticator> = session.authenticators.iter_mut().collect();
    if request.resident_key == ResidentKey::Preferred {
        candidates.sort_by_key(|a| !a.has_resident_key);
    }
    for authenticator in candidates {
        if request.attachment.as_deref().is_some_and(|a| a != authenticator.attachment()) {
            continue;
        }
        if request.resident_key == ResidentKey::Required && !authenticator.has_resident_key {
            continue;
        }
        if request.user_verification == "required" && !authenticator.has_user_verification {
            continue;
        }
        match make_credential(authenticator, request) {
            Err(failure) if failure.name == "InvalidStateError" => return Err(failure),
            Err(_) => continue,
            created => return created,
        }
    }
    fail("NotAllowedError", NOT_ALLOWED)
}
// §5.1.4.1's over them, §5.1.4.2 for each: an authenticator that holds none of a list given is not asked.
fn finish_get(session: &mut Session, request: &Assertion) -> Outcome<Asserted> {
    for authenticator in &mut session.authenticators {
        let Some(require_uv) = authenticator.require_verification(&request.user_verification) else { continue };
        if let Ok(asserted) = get_assertion(authenticator, request, require_uv) {
            return Ok(asserted);
        }
    }
    fail("NotAllowedError", NOT_ALLOWED)
}
// A request asked of the authenticators, each refusal removing one from it (§5.1.3 "not equivalent to InvalidStateError",
// §5.1.4.1 "any authenticator returns an error status"), which leaves it to wait, as the only ends a request has are an
// authenticator's answer, its abort and its lifetime timer — but for an InvalidStateError, and a list of credentials none
// of the authenticators could answer for (§5.1.4.1 "no eligible credential could be found"; a conditional request's list
// is no such list).
fn ask(session: &mut Session, request: &Request) -> Asked {
    match request {
        Request::Create(request) => match finish_create(session, request) {
            Ok(created) => Asked::Answered(Answer::Created(created)),
            Err(failure) if failure.name == "InvalidStateError" => Asked::Refused(failure),
            Err(_) => Asked::Waits,
        },
        Request::Get(request) => match finish_get(session, request) {
            Ok(asserted) => Asked::Answered(Answer::Asserted(asserted)),
            Err(failure) if request.allow_given => Asked::Refused(failure),
            Err(_) => Asked::Waits,
        },
        Request::Refused(_) | Request::Silent => Asked::Waits,
    }
}

// A relying party's signals (§5.1.10.2-3), each authenticator's action: the credential with that id on the RP removed;
// the user's discoverable credential on the RP (the map's one, by RP ID and user handle) removed unless accepted.
fn unknown_credential(partition: u64, rp_id: &str, id: &[u8]) {
    if let Some(session) = sessions().get_mut(&partition) {
        for authenticator in &mut session.authenticators {
            authenticator.credentials.retain(|c| !(c.rp_id == rp_id && c.id == id));
        }
    }
}
fn all_accepted_credentials(partition: u64, rp_id: &str, user_id: &[u8], accepted: &[Vec<u8>]) {
    if let Some(session) = sessions().get_mut(&partition) {
        for authenticator in &mut session.authenticators {
            authenticator.credentials.retain(|c| !(c.discoverable && c.rp_id == rp_id && c.user_handle.as_deref() == Some(user_id) && !accepted.contains(&c.id)));
        }
    }
}
// Whether a user-verifying platform authenticator is available (§5.1.6), and one of it that makes passkeys (§5.8.7).
fn platform_authenticators(partition: u64) -> (bool, bool) {
    let sessions = sessions();
    let platform = || sessions.get(&partition).into_iter().flat_map(|s| &s.authenticators).filter(|a| a.transport == "internal" && a.has_user_verification);
    (platform().next().is_some(), platform().any(|a| a.has_resident_key))
}

// ── The driver's commands (§11.3-11.9): text the host passes through, as JSON ───────────────────────────────────────
// (…the session's pending requests told, as anything a request could now be answered by arrives: a task of each window's)
const AUTHENTICATOR_AVAILABLE: u32 = 33;
fn tell_available(partition: u64) {
    crate::agents::tell_session(partition, AUTHENTICATOR_AVAILABLE, [0.0; 4], true);
}
pub(crate) fn add_authenticator_for_ruby(partition: u64, config: String) -> String {
    let config: Value = serde_json::from_str(&config).unwrap_or(Value::Null);
    let id = format!("csim-auth-{}", LAST_AUTHENTICATOR.fetch_add(1, Ordering::Relaxed) + 1);
    sessions().entry(partition).or_default().authenticators.push(Authenticator::new(id.clone(), &config));
    tell_available(partition);
    id
}
pub(crate) fn remove_authenticator_for_ruby(partition: u64, id: String) {
    if let Some(session) = sessions().get_mut(&partition) {
        session.authenticators.retain(|a| a.id != id);
    }
}
// Base64url, as §11.5 passes every binary member — and base64 with padding, as CDP's do, which its callers send.
fn command_bytes(text: &str) -> Option<Vec<u8>> {
    base64url_decode(&text.trim_end_matches('=').replace('+', "-").replace('/', "_"))
}
// A credential (§11.5's Credential Parameters), refused where its remote end steps refuse one's id, RP ID, key or user
// handle — but `isResidentCredential` and `signCount`, which they require, have defaults here (false, a counter from 0).
fn command_credential(authenticator: &Authenticator, parameters: &Value) -> Result<Credential, String> {
    let text = |name: &str| parameters.get(name).and_then(Value::as_str);
    let binary = |name: &str| text(name).ok_or(format!("no {name}")).and_then(|t| command_bytes(t).ok_or(format!("{name} is not base64url")));
    let id = binary("credentialId")?;
    let discoverable = parameters.get("isResidentCredential").and_then(Value::as_bool).unwrap_or(false);
    let rp_id = text("rpId").filter(|r| !r.is_empty()).ok_or("no rpId")?.to_owned();
    let key = SigningKey::from_pkcs8_der(&binary("privateKey")?).map_err(|_| "privateKey is no PKCS#8 P-256 key")?;
    let user_handle = if text("userHandle").is_some() { Some(binary("userHandle")?) } else { None };
    if discoverable && user_handle.is_none() {
        return Err("a discoverable credential needs a userHandle".to_owned());
    }
    if discoverable && !authenticator.has_resident_key {
        return Err("the authenticator cannot store a discoverable credential".to_owned());
    }
    // (…a counter null is none; left out, one from zero)
    let counter = match parameters.get("signCount") {
        Some(Value::Null) => None,
        Some(count) => Some(count.as_f64().filter(|n| n.fract() == 0.0 && (0.0..=u32::MAX as f64).contains(n)).ok_or("signCount is no 32-bit unsigned integer")? as u32),
        None => Some(0),
    };
    let backup = |name: &str, default: bool| parameters.get(name).and_then(Value::as_bool).unwrap_or(default);
    Ok(Credential {
        id,
        key,
        rp_id,
        user_handle,
        discoverable,
        counter,
        backup_eligible: backup("backupEligibility", authenticator.default_backup_eligibility),
        backup_state: backup("backupState", authenticator.default_backup_state),
    })
}
// The credential's raw id, none for an authenticator no longer there.
pub(crate) fn add_credential_for_ruby(ruby: &magnus::Ruby, partition: u64, id: String, parameters: String) -> Result<Option<magnus::RString>, magnus::Error> {
    let parameters: Value = serde_json::from_str(&parameters).unwrap_or(Value::Null);
    let mut sessions = sessions();
    let Some(authenticator) = sessions.get_mut(&partition).and_then(|s| s.authenticators.iter_mut().find(|a| a.id == id)) else {
        return Ok(None);
    };
    let credential = command_credential(authenticator, &parameters).map_err(|why| magnus::Error::new(ruby.exception_arg_error(), why))?;
    let raw_id = ruby.str_from_slice(&credential.id);
    authenticator.keep(credential);
    drop(sessions);
    tell_available(partition);
    Ok(Some(raw_id))
}
pub(crate) fn remove_credential_for_ruby(partition: u64, id: String, credential_id: String) {
    let Some(credential_id) = command_bytes(&credential_id) else { return };
    if let Some(authenticator) = sessions().get_mut(&partition).and_then(|s| s.authenticators.iter_mut().find(|a| a.id == id)) {
        authenticator.credentials.retain(|c| c.id != credential_id);
    }
}
// Its credentials (§11.6, without their keys and backup properties), as JSON; none for an authenticator no longer there.
pub(crate) fn credentials_for_ruby(partition: u64, id: String) -> String {
    let sessions = sessions();
    let credentials = sessions.get(&partition).and_then(|s| s.authenticators.iter().find(|a| a.id == id)).map_or(&[][..], |a| &a.credentials);
    let listed: Vec<Value> = credentials
        .iter()
        .map(|c| {
            json!({
                "credentialId": base64url_encode(&c.id),
                "rpId": c.rp_id,
                "isResidentCredential": c.discoverable,
                "signCount": c.counter,
                "userHandle": c.user_handle.as_deref().map(base64url_encode)
            })
        })
        .collect();
    Value::Array(listed).to_string()
}
pub(crate) fn set_user_verified_for_ruby(partition: u64, id: String, verified: bool) {
    if let Some(authenticator) = sessions().get_mut(&partition).and_then(|s| s.authenticators.iter_mut().find(|a| a.id == id)) {
        authenticator.is_user_verified = verified;
    }
}

// ── The bindings' ops ───────────────────────────────────────────────────────────────────────────────────────────────
pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    register(scope, ns, "webauthnCreate", create_op, context_id);
    register(scope, ns, "webauthnGet", get_op, context_id);
    register(scope, ns, "webauthnLifetime", lifetime_op, context_id);
    register(scope, ns, "webauthnAsk", ask_op, context_id);
    register(scope, ns, "webauthnExpire", expire_op, context_id);
    register(scope, ns, "webauthnCancel", cancel_op, context_id);
    register(scope, ns, "webauthnForgetRequest", forget_request_op, context_id);
    register(scope, ns, "webauthnSignalUnknownCredential", signal_unknown_credential_op, context_id);
    register(scope, ns, "webauthnSignalAllAcceptedCredentials", signal_all_accepted_credentials_op, context_id);
    register(scope, ns, "webauthnSignalCurrentUserDetails", signal_current_user_details_op, context_id);
    register(scope, ns, "webauthnPlatformAuthenticatorAvailable", platform_authenticator_available_op, context_id);
    register(scope, ns, "webauthnClientCapabilities", client_capabilities_op, context_id);
}

fn partition_arg(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> u64 {
    args.get(0).number_value(scope).unwrap_or(0.0) as u64
}
// The calling realm's document, as `Caller` says of it.
fn caller(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>) -> Caller {
    let realm = realm_id(scope, args);
    let arena = &mut crate::dom::dom(scope).arena;
    let (cross_origin, top_origin) = crate::referrer::ancestors_of_document(arena, realm);
    let has_transient_activation = arena.transiently_activated(realm);
    let domain = arena.realm_document(realm).and_then(|doc| arena.document_states.domain(doc).map(str::to_owned));
    let origin = arena.realm_state_mut(realm).map(|state| state.location.origin().to_owned()).unwrap_or_default();
    let effective_domain = crate::realm_location::effective_domain(&origin, domain.as_deref());
    Caller { origin, effective_domain, cross_origin, top_origin, has_transient_activation }
}
fn member_text(scope: &mut v8::PinScope<'_, '_>, object: v8::Local<'_, v8::Object>, name: &str) -> Option<String> {
    get(scope, object, name).map(|v| v.to_rust_string_lossy(scope))
}
fn member_bytes(scope: &mut v8::PinScope<'_, '_>, object: v8::Local<'_, v8::Object>, name: &str) -> Vec<u8> {
    get(scope, object, name).and_then(buffer_bytes).unwrap_or_default()
}
fn member_object<'s>(scope: &mut v8::PinScope<'s, '_>, object: v8::Local<'_, v8::Object>, name: &str) -> Option<v8::Local<'s, v8::Object>> {
    get(scope, object, name).and_then(|v| v8::Local::<v8::Object>::try_from(v).ok())
}
// A member's items, each `read`; none for a member not given.
fn member_list<T>(scope: &mut v8::PinScope<'_, '_>, object: v8::Local<'_, v8::Object>, name: &str, read: impl Fn(&mut v8::PinScope<'_, '_>, v8::Local<'_, v8::Value>) -> Option<T>) -> Vec<T> {
    let Some(list) = get(scope, object, name).and_then(|v| v8::Local::<v8::Array>::try_from(v).ok()) else { return Vec::new() };
    let mut items = Vec::new();
    for i in 0..list.length() {
        if let Some(item) = list.get_index(scope, i).and_then(|item| read(scope, item)) {
            items.push(item);
        }
    }
    items
}
fn descriptors(scope: &mut v8::PinScope<'_, '_>, object: v8::Local<'_, v8::Object>, name: &str) -> Vec<Descriptor> {
    member_list(scope, object, name, |scope, item| {
        let item = v8::Local::<v8::Object>::try_from(item).ok()?;
        Some(Descriptor { kind: member_text(scope, item, "type")?, id: member_bytes(scope, item, "id") })
    })
}
// The dictionaries the bindings converted (generated/bindings.js): their own members, as webcrypto.rs `get` reads.
fn creation_options(scope: &mut v8::PinScope<'_, '_>, pk: v8::Local<'_, v8::Object>, conditional: bool) -> Option<CreationOptions> {
    let (rp, user) = (member_object(scope, pk, "rp")?, member_object(scope, pk, "user")?);
    let selection = member_object(scope, pk, "authenticatorSelection");
    let chosen = |scope: &mut v8::PinScope<'_, '_>, name: &str| selection.and_then(|s| member_text(scope, s, name));
    let parameters = member_list(scope, pk, "pubKeyCredParams", |scope, item| {
        let item = v8::Local::<v8::Object>::try_from(item).ok()?;
        let alg = get(scope, item, "alg")?.integer_value(scope)?;
        Some((member_text(scope, item, "type")?, alg))
    });
    let cred_props = member_object(scope, pk, "extensions").and_then(|e| get(scope, e, "credProps")).is_some_and(|v| v.boolean_value(scope));
    Some(CreationOptions {
        timeout: get(scope, pk, "timeout").and_then(|v| v.number_value(scope)),
        rp_id: member_text(scope, rp, "id"),
        user_id: member_bytes(scope, user, "id"),
        challenge: member_bytes(scope, pk, "challenge"),
        parameters,
        exclude: descriptors(scope, pk, "excludeCredentials"),
        attachment: chosen(scope, "authenticatorAttachment"),
        resident_key: chosen(scope, "residentKey"),
        require_resident_key: selection.and_then(|s| get(scope, s, "requireResidentKey")).is_some_and(|v| v.boolean_value(scope)),
        user_verification: chosen(scope, "userVerification").unwrap_or_else(|| "preferred".to_owned()),
        attestation: member_text(scope, pk, "attestation").unwrap_or_else(|| "none".to_owned()),
        attestation_formats: member_list(scope, pk, "attestationFormats", |scope, item| Some(item.to_rust_string_lossy(scope))),
        cred_props,
        conditional,
    })
}
fn request_options(scope: &mut v8::PinScope<'_, '_>, pk: v8::Local<'_, v8::Object>, conditional: bool) -> RequestOptions {
    RequestOptions {
        timeout: get(scope, pk, "timeout").and_then(|v| v.number_value(scope)),
        rp_id: member_text(scope, pk, "rpId"),
        challenge: member_bytes(scope, pk, "challenge"),
        allow: descriptors(scope, pk, "allowCredentials"),
        user_verification: member_text(scope, pk, "userVerification").unwrap_or_else(|| "preferred".to_owned()),
        conditional,
    }
}

// The request of realm `realm`'s document made: a number its task and timer will name it by.
fn make_active(scope: &mut v8::PinScope<'_, '_>, realm: i32, lifetime: Option<f64>, request: Request) -> f64 {
    let number = LAST_REQUEST.fetch_add(1, Ordering::Relaxed) + 1;
    if let Some(state) = crate::dom::dom(scope).arena.realm_state_mut(realm) {
        state.webauthn_request = Some(Box::new(ActiveRequest { number, lifetime, request }));
    }
    number as f64
}
fn fail_with<T>(scope: &mut v8::PinScope<'_, '_>, name: &'static str, message: String) -> Option<T> {
    throw(scope, Failure { name, message });
    None
}
// Credential Management's checks a request of `publicKey` is refused by at once: "not fully active", no `publicKey`, a
// request of the type already active, a document not allowed to use `feature`.
fn fully_active(scope: &mut v8::PinScope<'_, '_>, realm: i32) -> Option<()> {
    if crate::dom::dom(scope).arena.navigables.fully_active(realm) { Some(()) } else { fail_with(scope, "InvalidStateError", "The document is not fully active.".to_owned()) }
}
fn public_key<'s>(scope: &mut v8::PinScope<'s, '_>, options: v8::Local<'_, v8::Object>) -> Option<v8::Local<'s, v8::Object>> {
    match member_object(scope, options, "publicKey") {
        Some(pk) => Some(pk),
        None => fail_with(scope, "NotSupportedError", "Only public-key credentials are supported.".to_owned()),
    }
}
fn not_active(scope: &mut v8::PinScope<'_, '_>, realm: i32) -> Option<()> {
    if crate::dom::dom(scope).arena.realm_state(realm).is_some_and(|state| state.webauthn_request.is_some()) {
        fail_with(scope, "NotAllowedError", "A request is already pending.".to_owned())
    } else {
        Some(())
    }
}
fn permitted(scope: &mut v8::PinScope<'_, '_>, realm: i32, feature: &str) -> Option<()> {
    if allowed_to_use(&mut crate::dom::dom(scope).arena, realm, feature) {
        Some(())
    } else {
        fail_with(scope, "NotAllowedError", format!("The '{feature}' feature is not enabled in this document."))
    }
}
// §2.5.4 "Create a Credential" and [[Create]]'s client steps, a cross-origin caller's user activation consumed by them
// (§5.1.3 step 2), whatever comes of them after: the request's number, undefined for a signal already aborted.
fn begin_create_steps(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, options: v8::Local<'_, v8::Object>) -> Option<f64> {
    let realm = realm_id(scope, args);
    fully_active(scope, realm)?;
    let pk = public_key(scope, options)?;
    permitted(scope, realm, "publickey-credentials-create")?;
    if args.get(1).is_true() {
        return None;
    }
    not_active(scope, realm)?;
    let conditional = member_text(scope, options, "mediation").as_deref() == Some("conditional");
    let creation = creation_options(scope, pk, conditional)?;
    let lifetime = lifetime_of(creation.timeout);
    let caller = caller(scope, args);
    if caller.cross_origin && !conditional {
        crate::dom::dom(scope).arena.consume_activation(realm);
    }
    let request = begin_create(creation, &caller).map_or_else(Request::Refused, Request::Create);
    Some(make_active(scope, realm, Some(lifetime), request))
}
// §2.5.1 "Request a Credential" and [[DiscoverFromExternalSource]]'s client steps: the same. (…no immediate mediation
// here, its TypeError; and "silent", a public key credential always taking a gesture, before any WebAuthn step looks at
// the options.)
fn begin_get_steps(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, options: v8::Local<'_, v8::Object>) -> Option<f64> {
    let realm = realm_id(scope, args);
    fully_active(scope, realm)?;
    if args.get(1).is_true() {
        return None;
    }
    let pk = public_key(scope, options)?;
    if member_text(scope, options, "uiMode").as_deref() == Some("immediate") {
        return fail_with(scope, "TypeError", "Failed to execute 'get' on 'CredentialsContainer': Immediate mediation is not supported.".to_owned());
    }
    not_active(scope, realm)?;
    permitted(scope, realm, "publickey-credentials-get")?;
    let mediation = member_text(scope, options, "mediation");
    if mediation.as_deref() == Some("silent") {
        return Some(make_active(scope, realm, None, Request::Silent));
    }
    let conditional = mediation.as_deref() == Some("conditional");
    let assertion = request_options(scope, pk, conditional);
    let lifetime = (!conditional).then(|| lifetime_of(assertion.timeout));
    let caller = caller(scope, args);
    let request = begin_get(assertion, &caller).map_or_else(Request::Refused, Request::Get);
    Some(make_active(scope, realm, lifetime, request))
}
// __dom.webauthnCreate(options, aborted) / __dom.webauthnGet(options, aborted) -> the request's number, undefined where
// `aborted`, whether its signal is, says so, or throws a refusal of Credential Management's.
fn create_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(options) = v8::Local::<v8::Object>::try_from(args.get(0)) else { return };
    if let Some(number) = begin_create_steps(scope, &args, options) {
        rv.set_double(number);
    }
}
fn get_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(options) = v8::Local::<v8::Object>::try_from(args.get(0)) else { return };
    if let Some(number) = begin_get_steps(scope, &args, options) {
        rv.set_double(number);
    }
}
// The request `number` of the calling realm's document, out of it — none where it is no longer the active one.
fn take_active(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, number: f64) -> Option<Box<ActiveRequest>> {
    let realm = realm_id(scope, args);
    let state = crate::dom::dom(scope).arena.realm_state_mut(realm)?;
    state.webauthn_request.take_if(|active| active.number as f64 == number)
}
// __dom.webauthnLifetime(number) -> its lifetime timer's ms, undefined for none.
fn lifetime_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let number = args.get(0).number_value(scope).unwrap_or(0.0);
    let realm = realm_id(scope, &args);
    let lifetime = crate::dom::dom(scope).arena.realm_state(realm).and_then(|state| state.webauthn_request.as_ref()).filter(|active| active.number as f64 == number).and_then(|active| active.lifetime);
    if let Some(lifetime) = lifetime {
        rv.set_double(lifetime);
    }
}
// __dom.webauthnExpire(number): its lifetime timer up: the NotAllowedError it ends with (§5.1.3), where it is still the
// active one.
fn expire_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let number = args.get(0).number_value(scope).unwrap_or(0.0);
    if take_active(scope, &args, number).is_some() {
        throw(scope, Failure { name: "NotAllowedError", message: NOT_ALLOWED.to_owned() });
    }
}
// __dom.webauthnForgetRequest(): the calling realm's Document renewed for a next document (dom-nodes.js
// `__csimRenewDocument`), whose settings object has no active credential type.
fn forget_request_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let realm = realm_id(scope, &args);
    if let Some(state) = crate::dom::dom(scope).arena.realm_state_mut(realm) {
        state.webauthn_request = None;
    }
}
// __dom.webauthnAsk(partition, number) -> the authenticators' answer, as an object of the realm's own ArrayBuffers, null
// for "silent", or undefined for none yet (or no such request any more); or throws the refusal that ends the request.
fn ask_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let partition = partition_arg(scope, &args);
    let number = args.get(1).number_value(scope).unwrap_or(0.0);
    let Some(active) = take_active(scope, &args, number) else { return };
    let asked = match &active.request {
        Request::Silent => return rv.set_null(),
        Request::Refused(_) => None,
        request => Some(ask(sessions().entry(partition).or_default(), request)),
    };
    let answer = match asked {
        None => {
            let Request::Refused(failure) = active.request else { return };
            return throw(scope, failure);
        }
        Some(Asked::Refused(failure)) => return throw(scope, failure),
        Some(Asked::Waits) => {
            let realm = realm_id(scope, &args);
            if let Some(state) = crate::dom::dom(scope).arena.realm_state_mut(realm) {
                state.webauthn_request = Some(active);
            }
            return;
        }
        Some(Asked::Answered(answer)) => answer,
    };
    match answer {
        Answer::Created(created) => {
            let out = v8::Object::new(scope);
            common_members(scope, out, &created.id, created.client_data, &created.authenticator_data, created.attachment);
            let attestation_object = array_buffer(scope, created.attestation_object);
            set(scope, out, "attestationObject", attestation_object);
            let public_key = array_buffer(scope, created.public_key);
            set(scope, out, "publicKey", public_key);
            let algorithm = v8::Number::new(scope, ES256 as f64).into();
            set(scope, out, "publicKeyAlgorithm", algorithm);
            let transport = text_value(scope, &created.transport);
            let transports = v8::Array::new_with_elements(scope, &[transport]).into();
            set(scope, out, "transports", transports);
            // (…undefined its own member where credProps was not asked: never a page's `Object.prototype.residentKey`)
            let resident_key = created.resident_key.map_or_else(|| v8::undefined(&*scope).into(), |rk| v8::Boolean::new(&*scope, rk).into());
            set(scope, out, "residentKey", resident_key);
            rv.set(out.into());
        }
        Answer::Asserted(asserted) => {
            let out = v8::Object::new(scope);
            common_members(scope, out, &asserted.id, asserted.client_data, &asserted.authenticator_data, asserted.attachment);
            let signature = array_buffer(scope, asserted.signature);
            set(scope, out, "signature", signature);
            let user_handle = match asserted.user_handle {
                Some(handle) => array_buffer(scope, handle),
                None => v8::null(scope).into(),
            };
            set(scope, out, "userHandle", user_handle);
            rv.set(out.into());
        }
    }
}
fn text_value<'s>(scope: &mut v8::PinScope<'s, '_>, text: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, text).map_or_else(|| v8::undefined(scope).into(), Into::into)
}
// What a registration's and an assertion's answer both carry.
fn common_members(scope: &mut v8::PinScope<'_, '_>, out: v8::Local<'_, v8::Object>, id: &[u8], client_data: Vec<u8>, authenticator_data: &[u8], attachment: &str) {
    let text_id = text_value(scope, &base64url_encode(id));
    set(scope, out, "credentialId", text_id);
    let raw_id = array_buffer(scope, id.to_vec());
    set(scope, out, "rawId", raw_id);
    let client_data = array_buffer(scope, client_data);
    set(scope, out, "clientDataJSON", client_data);
    let authenticator_data = array_buffer(scope, authenticator_data.to_vec());
    set(scope, out, "authenticatorData", authenticator_data);
    let attachment = text_value(scope, attachment);
    set(scope, out, "authenticatorAttachment", attachment);
}
// __dom.webauthnCancel(number): the authenticators cancelled (§6.3.4): an aborted request gone from its document.
fn cancel_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let number = args.get(0).number_value(scope).unwrap_or(0.0);
    take_active(scope, &args, number);
}

// A signal's id or user id (§5.1.10): an error in decoding it a TypeError, before anything else of it is looked at.
fn signalled_id(member: &str, name: &str, text: &str) -> Outcome<Vec<u8>> {
    base64url_decode(text).map_or_else(|| fail("TypeError", format!("Failed to execute '{member}' on 'PublicKeyCredential': Invalid base64url string for {name}.")), Ok)
}
// A signal's arguments: the dictionary, its RP ID checked (§5.1.10.1).
fn signal_rp_id(scope: &mut v8::PinScope<'_, '_>, args: &v8::FunctionCallbackArguments<'_>, options: v8::Local<'_, v8::Object>) -> Outcome<String> {
    let requested = member_text(scope, options, "rpId");
    caller(scope, args).rp_id(requested.as_deref())
}
// __dom.webauthnSignalUnknownCredential(partition, options)
fn signal_unknown_credential_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let partition = partition_arg(scope, &args);
    let Ok(options) = v8::Local::<v8::Object>::try_from(args.get(1)) else { return };
    let credential_id = member_text(scope, options, "credentialId").unwrap_or_default();
    let outcome = signalled_id("signalUnknownCredential", "credentialId", &credential_id).and_then(|id| Ok((id, signal_rp_id(scope, &args, options)?)));
    match outcome {
        Ok((id, rp_id)) => unknown_credential(partition, &rp_id, &id),
        Err(failure) => throw(scope, failure),
    }
}
// __dom.webauthnSignalAllAcceptedCredentials(partition, options)
fn signal_all_accepted_credentials_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    const MEMBER: &str = "signalAllAcceptedCredentials";
    let partition = partition_arg(scope, &args);
    let Ok(options) = v8::Local::<v8::Object>::try_from(args.get(1)) else { return };
    let user_id = member_text(scope, options, "userId").unwrap_or_default();
    let accepted = member_list(scope, options, "allAcceptedCredentialIds", |scope, item| Some(item.to_rust_string_lossy(scope)));
    let outcome = signalled_id(MEMBER, "userId", &user_id).and_then(|user_id| {
        let accepted = accepted.iter().map(|id| signalled_id(MEMBER, "allAcceptedCredentialIds", id)).collect::<Outcome<Vec<_>>>()?;
        Ok((user_id, accepted, signal_rp_id(scope, &args, options)?))
    });
    match outcome {
        Ok((user_id, accepted, rp_id)) => all_accepted_credentials(partition, &rp_id, &user_id, &accepted),
        Err(failure) => throw(scope, failure),
    }
}
// __dom.webauthnSignalCurrentUserDetails(options): checked; a user's details are no state these authenticators keep.
fn signal_current_user_details_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(options) = v8::Local::<v8::Object>::try_from(args.get(0)) else { return };
    let user_id = member_text(scope, options, "userId").unwrap_or_default();
    let outcome = signalled_id("signalCurrentUserDetails", "userId", &user_id).and_then(|_| signal_rp_id(scope, &args, options));
    if let Err(failure) = outcome {
        throw(scope, failure);
    }
}
// __dom.webauthnPlatformAuthenticatorAvailable(partition) -> `platform_authenticators`' first (§5.1.6).
fn platform_authenticator_available_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let partition = partition_arg(scope, &args);
    rv.set_bool(platform_authenticators(partition).0);
}
// __dom.webauthnClientCapabilities(partition) -> what this client can do (§5.1.7, its keys in lexicographical order):
// a conditional get, the one extension it implements and the signals; a platform authenticator where one is there; no
// conditional create, hybrid transport or related origins.
fn client_capabilities_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let partition = partition_arg(scope, &args);
    let (user_verifying, passkey) = platform_authenticators(partition);
    let out = v8::Object::new(scope);
    for (name, value) in [
        ("conditionalCreate", false),
        ("conditionalGet", true),
        ("extension:credProps", true),
        ("hybridTransport", false),
        ("passkeyPlatformAuthenticator", passkey),
        ("relatedOrigins", false),
        ("signalAllAcceptedCredentials", true),
        ("signalCurrentUserDetails", true),
        ("signalUnknownCredential", true),
        ("userVerifyingPlatformAuthenticator", user_verifying),
    ] {
        let value = v8::Boolean::new(scope, value).into();
        set(scope, out, name, value);
    }
    rv.set(out.into());
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier as _;
    use p256::ecdsa::Signature;

    fn caller(origin: &str, host: &str) -> Caller {
        Caller { origin: origin.to_owned(), effective_domain: Some(host.to_owned()), cross_origin: false, top_origin: None, has_transient_activation: false }
    }
    fn page() -> Caller {
        caller("https://a.example.com", "a.example.com")
    }
    fn creation() -> CreationOptions {
        CreationOptions {
            timeout: None,
            rp_id: None,
            user_id: vec![1],
            challenge: vec![2],
            parameters: vec![(PUBLIC_KEY.to_owned(), ES256)],
            exclude: Vec::new(),
            attachment: None,
            resident_key: None,
            require_resident_key: false,
            user_verification: "preferred".to_owned(),
            attestation: "none".to_owned(),
            attestation_formats: Vec::new(),
            cred_props: false,
            conditional: false,
        }
    }
    fn request() -> RequestOptions {
        RequestOptions { timeout: None, rp_id: None, challenge: vec![3], allow: Vec::new(), user_verification: "preferred".to_owned(), conditional: false }
    }
    fn session(config: Value) -> Session {
        let mut session = Session::default();
        session.authenticators.push(Authenticator::new("a".to_owned(), &config));
        session
    }
    fn create(session: &mut Session, options: CreationOptions) -> Outcome<Created> {
        finish_create(session, &begin_create(options, &page())?)
    }
    fn get(session: &mut Session, options: RequestOptions) -> Outcome<Asserted> {
        finish_get(session, &begin_get(options, &page())?)
    }
    fn name<T>(outcome: Outcome<T>) -> &'static str {
        outcome.err().map_or("ok", |f| f.name)
    }
    fn descriptor(id: &[u8]) -> Descriptor {
        Descriptor { kind: PUBLIC_KEY.to_owned(), id: id.to_vec() }
    }
    fn allow(id: &[u8]) -> RequestOptions {
        RequestOptions { allow: vec![descriptor(id)], ..request() }
    }
    const FLAGS_AT: usize = 32;

    #[test]
    fn client_data_is_the_specs_serialization() {
        let data = page().client_data("webauthn.get", &[0xff, 0xef]);
        assert_eq!(String::from_utf8(data).unwrap(), r#"{"type":"webauthn.get","challenge":"_-8","origin":"https://a.example.com","crossOrigin":false}"#);
        let framed = Caller { cross_origin: true, top_origin: Some("https://top.test".to_owned()), ..page() };
        assert_eq!(String::from_utf8(framed.client_data("webauthn.create", &[])).unwrap(), r#"{"type":"webauthn.create","challenge":"","origin":"https://a.example.com","crossOrigin":true,"topOrigin":"https://top.test"}"#);
        assert_eq!(ccd_string("a\"\\\n\u{7f}é"), "\"a\\\"\\\\\\u000a\u{7f}é\"");
    }

    #[test]
    fn cbor_heads_take_the_fewest_bytes() {
        let head = |n| {
            let mut out = Vec::new();
            cbor_head(&mut out, 2, n);
            out
        };
        assert_eq!(head(23), [0x57]);
        assert_eq!(head(24), [0x58, 24]);
        assert_eq!(head(256), [0x59, 1, 0]);
        assert_eq!(head(65536), [0x5a, 0, 1, 0, 0]);
        assert_eq!(head(1 << 32), [0x5b, 0, 0, 0, 1, 0, 0, 0, 0]);
        let mut negative = Vec::new();
        cbor_int(&mut negative, -7);
        cbor_int(&mut negative, -257);
        assert_eq!(negative, [0x26, 0x39, 1, 0]);
    }

    #[test]
    fn a_cose_key_says_es256_on_p256() {
        let key = SigningKey::random(&mut rand_core::OsRng);
        let cose = cose_key(&key);
        assert_eq!(cose[..7], [0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01]);
        assert_eq!(cose[7..10], [0x21, 0x58, 32]);
        assert_eq!(cose[42..45], [0x22, 0x58, 32]);
        assert_eq!(cose.len(), 77);
    }

    #[test]
    fn a_registration_and_its_assertion_are_signed_by_the_key_it_reports() {
        let mut session = session(json!({"hasUserVerification": true, "isUserVerified": true}));
        let created = create(&mut session, creation()).unwrap();
        assert_eq!(created.authenticator_data[..32], *Sha256::digest("a.example.com"));
        assert_eq!(created.authenticator_data[FLAGS_AT], UP | UV | AT);
        assert_eq!(created.authenticator_data[33..37], [0, 0, 0, 0]);
        assert_eq!(created.authenticator_data[37..53], [0; 16]);
        assert_eq!(created.authenticator_data[53..55], [0, 32]);
        assert_eq!(created.authenticator_data[55..87], created.id[..]);
        assert_eq!(created.attestation_object[..1], [0xa3]);
        assert!(created.attestation_object.windows(4).any(|w| w == b"none"));

        let asserted = get(&mut session, allow(&created.id)).unwrap();
        assert_eq!(asserted.id, created.id);
        assert_eq!(asserted.authenticator_data.len(), 37);
        assert_eq!(asserted.authenticator_data[33..37], [0, 0, 0, 1]);
        let mut signed = asserted.authenticator_data.clone();
        signed.extend(Sha256::digest(&asserted.client_data));
        let key = session.authenticators[0].credentials[0].key.verifying_key().to_owned();
        key.verify(&signed, &Signature::from_der(&asserted.signature).unwrap()).unwrap();
        assert_eq!(get(&mut session, allow(&created.id)).unwrap().authenticator_data[33..37], [0, 0, 0, 2]);
    }

    #[test]
    fn attestation_conveyance_picks_the_format() {
        let mut session = session(json!({}));
        let fmt = |session: &mut Session, attestation: &str, formats: &[&str]| {
            let created = create(session, CreationOptions { attestation: attestation.to_owned(), attestation_formats: formats.iter().map(|f| (*f).to_owned()).collect(), ..creation() }).unwrap();
            let object = created.attestation_object;
            if object.windows(6).any(|w| w == b"packed") { "packed" } else { "none" }
        };
        assert_eq!(fmt(&mut session, "none", &["packed"]), "none");
        assert_eq!(fmt(&mut session, "bogus", &[]), "none");
        assert_eq!(fmt(&mut session, "direct", &[]), "packed");
        assert_eq!(fmt(&mut session, "enterprise", &[]), "packed");
        assert_eq!(fmt(&mut session, "indirect", &["fido-u2f", "none", "packed"]), "none");
        assert_eq!(fmt(&mut session, "direct", &["fido-u2f"]), "packed");
    }

    #[test]
    fn the_client_checks_in_the_specs_order() {
        let mut opaque = page();
        opaque.effective_domain = None;
        assert_eq!(name(begin_create(CreationOptions { user_id: Vec::new(), ..creation() }, &opaque)), "TypeError");
        assert_eq!(name(begin_create(CreationOptions { user_id: vec![0; 65], ..creation() }, &page())), "TypeError");
        assert_eq!(name(begin_create(creation(), &opaque)), "NotAllowedError");
        assert_eq!(name(begin_create(creation(), &caller("http://127.0.0.1", "127.0.0.1"))), "SecurityError");
        assert_eq!(name(begin_get(request(), &caller("http://[::1]", "[::1]"))), "SecurityError");
        assert_eq!(name(begin_create(CreationOptions { rp_id: Some("other.test".to_owned()), ..creation() }, &page())), "SecurityError");
        assert_eq!(name(begin_create(CreationOptions { rp_id: Some("com".to_owned()), ..creation() }, &page())), "SecurityError");
        assert_eq!(begin_create(CreationOptions { rp_id: Some("example.com".to_owned()), ..creation() }, &page()).ok().unwrap().rp_id, "example.com");
        assert_eq!(begin_create(creation(), &page()).ok().unwrap().rp_id, "a.example.com");
        assert_eq!(name(begin_create(CreationOptions { parameters: vec![("x".to_owned(), ES256)], ..creation() }, &page())), "NotSupportedError");
        assert_eq!(name(begin_create(CreationOptions { conditional: true, ..creation() }, &page())), "NotAllowedError");
        let framed = Caller { cross_origin: true, top_origin: Some("https://top.test".to_owned()), ..page() };
        assert_eq!(name(begin_create(creation(), &framed)), "NotAllowedError");
        assert_eq!(name(begin_create(creation(), &Caller { has_transient_activation: true, ..framed })), "ok");
    }

    #[test]
    fn an_authenticator_that_cannot_answer_is_only_not_asked() {
        let mut plain = session(json!({}));
        assert_eq!(name(create(&mut plain, CreationOptions { resident_key: Some("required".to_owned()), ..creation() })), "NotAllowedError");
        assert_eq!(name(create(&mut plain, CreationOptions { require_resident_key: true, ..creation() })), "NotAllowedError");
        assert_eq!(name(create(&mut plain, CreationOptions { user_verification: "required".to_owned(), ..creation() })), "NotAllowedError");
        assert_eq!(name(create(&mut plain, CreationOptions { attachment: Some("platform".to_owned()), ..creation() })), "NotAllowedError");
        assert_eq!(name(create(&mut plain, CreationOptions { attachment: Some("bogus".to_owned()), ..creation() })), "ok");
        assert_eq!(name(create(&mut plain, CreationOptions { parameters: vec![(PUBLIC_KEY.to_owned(), -999)], ..creation() })), "NotAllowedError");
        assert_eq!(name(create(&mut plain, CreationOptions { parameters: Vec::new(), ..creation() })), "ok");
        assert_eq!(name(create(&mut Session::default(), creation())), "NotAllowedError");
    }

    #[test]
    fn user_verification_follows_the_effective_requirement() {
        let mut unverified = session(json!({"hasUserVerification": true}));
        assert_eq!(name(create(&mut unverified, creation())), "NotAllowedError");
        assert_eq!(name(create(&mut unverified, CreationOptions { user_verification: "required".to_owned(), ..creation() })), "NotAllowedError");
        assert_eq!(name(create(&mut unverified, CreationOptions { user_verification: "discouraged".to_owned(), ..creation() })), "NotAllowedError");

        let mut verified = session(json!({"hasUserVerification": true, "isUserVerified": true}));
        let created = create(&mut verified, CreationOptions { user_verification: "discouraged".to_owned(), ..creation() }).unwrap();
        assert_eq!(created.authenticator_data[FLAGS_AT], UP | UV | AT);
        assert_eq!(get(&mut verified, RequestOptions { user_verification: "discouraged".to_owned(), ..allow(&created.id) }).unwrap().authenticator_data[FLAGS_AT], UP);
        assert_eq!(get(&mut verified, allow(&created.id)).unwrap().authenticator_data[FLAGS_AT], UP | UV);
        verified.authenticators[0].is_user_verified = false;
        assert_eq!(name(get(&mut verified, allow(&created.id))), "NotAllowedError");
        assert_eq!(get(&mut verified, RequestOptions { user_verification: "discouraged".to_owned(), ..allow(&created.id) }).unwrap().authenticator_data[FLAGS_AT], UP);

        let mut unable = session(json!({}));
        let created = create(&mut unable, creation()).unwrap();
        assert_eq!(name(get(&mut unable, RequestOptions { user_verification: "required".to_owned(), ..allow(&created.id) })), "NotAllowedError");
    }

    #[test]
    fn a_user_who_does_not_consent_refuses_everything() {
        for config in [json!({"isUserConsenting": false}), json!({"automaticPresenceSimulation": false})] {
            let mut session = session(config);
            assert_eq!(name(create(&mut session, creation())), "NotAllowedError");
        }
        let mut session = session(json!({}));
        let id = create(&mut session, creation()).unwrap().id;
        session.authenticators[0].is_user_consenting = false;
        assert_eq!(name(get(&mut session, allow(&id))), "NotAllowedError");
        assert_eq!(session.authenticators[0].credentials[0].counter, Some(0));
    }

    #[test]
    fn the_exclude_list_refuses_only_what_it_names_on_the_rp() {
        let mut session = session(json!({}));
        let id = create(&mut session, creation()).unwrap().id;
        assert_eq!(name(create(&mut session, CreationOptions { exclude: vec![descriptor(&id)], ..creation() })), "InvalidStateError");
        assert_eq!(name(create(&mut session, CreationOptions { exclude: vec![Descriptor { kind: "x".to_owned(), id: id.clone() }], ..creation() })), "ok");
        let other_rp = CreationOptions { rp_id: Some("example.com".to_owned()), exclude: vec![descriptor(&id)], ..creation() };
        assert_eq!(name(create(&mut session, other_rp)), "ok");
        session.authenticators[0].is_user_consenting = false;
        assert_eq!(name(create(&mut session, CreationOptions { exclude: vec![descriptor(&id)], ..creation() })), "NotAllowedError");
    }

    #[test]
    fn an_assertion_finds_credentials_by_the_rules() {
        let mut session = session(json!({"hasResidentKey": true}));
        let server_side = create(&mut session, CreationOptions { resident_key: Some("discouraged".to_owned()), ..creation() }).unwrap();
        assert_eq!(server_side.resident_key, None);
        assert_eq!(name(get(&mut session, request())), "NotAllowedError");
        assert_eq!(get(&mut session, allow(&server_side.id)).unwrap().user_handle, None);
        assert_eq!(name(get(&mut session, RequestOptions { rp_id: Some("example.com".to_owned()), ..allow(&server_side.id) })), "NotAllowedError");
        assert_eq!(name(get(&mut session, RequestOptions { allow: vec![Descriptor { kind: "x".to_owned(), id: server_side.id.clone() }], ..request() })), "NotAllowedError");
        assert_eq!(name(get(&mut session, allow(&[9]))), "NotAllowedError");

        let first = create(&mut session, CreationOptions { resident_key: Some("required".to_owned()), cred_props: true, ..creation() }).unwrap();
        assert_eq!(first.resident_key, Some(true));
        let second = create(&mut session, CreationOptions { resident_key: Some("preferred".to_owned()), user_id: vec![7], ..creation() }).unwrap();
        let chosen = get(&mut session, request()).unwrap();
        assert_eq!(chosen.id, second.id);
        assert_eq!(chosen.user_handle, Some(vec![7]));
        assert_eq!(get(&mut session, allow(&first.id)).unwrap().user_handle, Some(vec![1]));
    }

    #[test]
    fn a_discoverable_credential_replaces_the_users_last_on_the_rp() {
        let mut session = session(json!({"hasResidentKey": true}));
        let required = || CreationOptions { resident_key: Some("required".to_owned()), ..creation() };
        let first = create(&mut session, required()).unwrap();
        let second = create(&mut session, required()).unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(name(get(&mut session, allow(&first.id))), "NotAllowedError");
        assert_eq!(name(get(&mut session, allow(&second.id))), "ok");
    }

    #[test]
    fn backup_state_is_the_credentials_from_its_creation() {
        let mut session = session(json!({"hasResidentKey": true, "hasUserVerification": true, "isUserVerified": true}));
        let plain = create(&mut session, creation()).unwrap();
        assert_eq!(plain.authenticator_data[FLAGS_AT] & (BE | BS), 0);
        session.authenticators[0].default_backup_eligibility = true;
        session.authenticators[0].default_backup_state = true;
        assert_eq!(get(&mut session, allow(&plain.id)).unwrap().authenticator_data[FLAGS_AT] & (BE | BS), 0);
        let backed = create(&mut session, CreationOptions { user_id: vec![2], ..creation() }).unwrap();
        assert_eq!(backed.authenticator_data[FLAGS_AT] & (BE | BS), BE | BS);
        assert_eq!(get(&mut session, allow(&backed.id)).unwrap().authenticator_data[FLAGS_AT] & (BE | BS), BE | BS);
    }

    #[test]
    fn a_backup_state_needs_backup_eligibility() {
        let mut session = session(json!({"defaultBackupState": true}));
        assert_eq!(create(&mut session, creation()).unwrap().authenticator_data[FLAGS_AT] & (BE | BS), 0);
    }

    #[test]
    fn an_allow_attribute_says_who_may_use_a_feature() {
        const F: &str = "publickey-credentials-get";
        let (own, parent) = ("https://b.test", "https://a.test");
        let grants = |allow: &str, declared: Option<&str>| allow_attribute_grants(allow, F, own, parent, declared);
        assert_eq!(grants("fullscreen", Some(own)), None);
        assert_eq!(grants("publickey-credentials-getter", Some(own)), None);
        assert_eq!(grants("publickey-credentials-get", Some(own)), Some(true));
        assert_eq!(grants("publickey-credentials-get", Some("https://c.test")), Some(false));
        assert_eq!(grants("fullscreen *; publickey-credentials-get *", None), Some(true));
        assert_eq!(grants("publickey-credentials-get 'none'", Some(own)), Some(false));
        assert_eq!(grants("publickey-credentials-get 'self'", Some(own)), Some(false));
        assert_eq!(allow_attribute_grants("publickey-credentials-get 'self'", F, parent, parent, None), Some(true));
        assert_eq!(grants("publickey-credentials-get 'src'", Some(own)), Some(true));
        assert_eq!(grants("publickey-credentials-get https://c.test https://b.test", None), Some(true));
        assert_eq!(grants("publickey-credentials-get https://c.test", None), Some(false));
    }

    #[test]
    fn a_request_none_can_answer_waits() {
        let mut session = session(json!({"hasResidentKey": true}));
        let conditional = |allow: Vec<Descriptor>| Request::Get(begin_get(RequestOptions { allow, conditional: true, ..request() }, &page()).ok().unwrap());
        let modal = |options: RequestOptions| Request::Get(begin_get(options, &page()).ok().unwrap());
        assert!(matches!(ask(&mut session, &conditional(Vec::new())), Asked::Waits));
        assert!(matches!(ask(&mut session, &modal(request())), Asked::Waits));
        assert!(matches!(ask(&mut Session::default(), &Request::Create(begin_create(creation(), &page()).ok().unwrap())), Asked::Waits));
        assert!(matches!(ask(&mut session, &modal(allow(&[9]))), Asked::Refused(_)));
        let made = Request::Create(begin_create(CreationOptions { resident_key: Some("required".to_owned()), ..creation() }, &page()).ok().unwrap());
        let Asked::Answered(Answer::Created(created)) = ask(&mut session, &made) else { panic!() };
        assert!(matches!(ask(&mut session, &conditional(vec![descriptor(&[9])])), Asked::Waits));
        assert!(matches!(ask(&mut session, &conditional(vec![descriptor(&created.id)])), Asked::Answered(_)));
        assert!(matches!(ask(&mut session, &modal(request())), Asked::Answered(_)));
        let excluded = Request::Create(begin_create(CreationOptions { exclude: vec![descriptor(&created.id)], ..creation() }, &page()).ok().unwrap());
        assert!(matches!(ask(&mut session, &excluded), Asked::Refused(_)));
    }

    #[test]
    fn a_requests_timeout_is_corrected_to_the_recommended_range() {
        assert_eq!(lifetime_of(None), 300_000.0);
        assert_eq!(lifetime_of(Some(1000.0)), 300_000.0);
        assert_eq!(lifetime_of(Some(400_000.0)), 400_000.0);
        assert_eq!(lifetime_of(Some(9_000_000.0)), 600_000.0);
    }

    #[test]
    fn a_handle_is_not_reused_after_a_session_is_cleared() {
        let partition = 0xc0_0004;
        let first = add_authenticator_for_ruby(partition, "{}".to_owned());
        clear(partition);
        assert_ne!(add_authenticator_for_ruby(partition, "{}".to_owned()), first);
        clear(partition);
    }

    #[test]
    fn a_declared_origin_is_where_a_frame_says_it_loads_from() {
        let declared = |sandbox, srcdoc, src| declared_origin("https://a.test", sandbox, srcdoc, src, "https://base.test/dir/");
        assert_eq!(declared(None, false, None).as_deref(), Some("https://a.test"));
        assert_eq!(declared(None, true, Some("https://b.test/")).as_deref(), Some("https://a.test"));
        assert_eq!(declared(None, false, Some("https://b.test/x")).as_deref(), Some("https://b.test"));
        assert_eq!(declared(None, false, Some("/x")).as_deref(), Some("https://base.test"));
        assert_eq!(declared(None, false, Some("http://[")).as_deref(), Some("https://a.test"));
        assert_eq!(declared(Some("allow-scripts"), false, None), None);
        assert_eq!(declared(Some("allow-same-origin"), false, None).as_deref(), Some("https://a.test"));
        assert_eq!(declared_origin("null", None, false, None, ""), None);
    }

    #[test]
    fn an_rp_id_is_checked_as_the_host_it_parses_to() {
        for (requested, host, ok) in [("LOCALHOST", "localhost", true), ("B.EXAMPLE.com", "a.b.example.com", true), ("a b", "localhost", false), ("OTHER.test", "localhost", false)] {
            let got = caller("https://x", host).rp_id(Some(requested));
            assert_eq!(got.is_ok(), ok, "{requested}");
            if ok {
                assert_eq!(got.ok().unwrap(), requested);
            }
        }
    }

    #[test]
    fn the_signals_remove_what_they_name() {
        let partition = 0xc0_0002;
        let handle = add_authenticator_for_ruby(partition, r#"{"hasResidentKey": true}"#.to_owned());
        let make = |user: u8, resident: &str| {
            let options = CreationOptions { user_id: vec![user], resident_key: Some(resident.to_owned()), ..creation() };
            let mut sessions = sessions();
            finish_create(sessions.get_mut(&partition).unwrap(), &begin_create(options, &page()).ok().unwrap()).ok().unwrap().id
        };
        let (kept, gone, server_side) = (make(1, "required"), make(2, "required"), make(1, "discouraged"));
        let listed = |id: &[u8]| credentials_for_ruby(partition, handle.clone()).contains(&base64url_encode(id));
        unknown_credential(partition, "other.test", &kept);
        assert!(listed(&kept));
        all_accepted_credentials(partition, "a.example.com", &[2], std::slice::from_ref(&kept));
        assert!(!listed(&gone));
        all_accepted_credentials(partition, "a.example.com", &[1], std::slice::from_ref(&kept));
        assert!(listed(&kept) && listed(&server_side));
        all_accepted_credentials(partition, "a.example.com", &[1], &[]);
        assert!(!listed(&kept) && listed(&server_side));
        unknown_credential(partition, "a.example.com", &server_side);
        assert!(!listed(&server_side));
        clear(partition);
    }

    #[test]
    fn a_credential_command_is_checked_as_its_steps_say() {
        const KEY: &str = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg2AWg10o6aoM0s55halZvcQLnpM2tVO2D8Ugw7wFCjzyhRANCAASYWPowzSTPINJcij94rw8bPpqyl6nylGN3-1KOKVkzw49N8ZLUptCU0qmw3n4buVgCh-1UUJll6LY7SP_JGvz9";
        let plain = Authenticator::new("a".to_owned(), &json!({}));
        let resident = Authenticator::new("b".to_owned(), &json!({"hasResidentKey": true}));
        let base = json!({"credentialId": "AQ+/AQ==", "rpId": "a.test", "privateKey": KEY, "signCount": 5});
        let credential = command_credential(&plain, &base).unwrap();
        assert_eq!(credential.id, [1, 15, 191, 1]);
        assert_eq!(credential.counter, Some(5));
        assert_eq!(command_credential(&plain, &json!({"credentialId": "AQ", "rpId": "a.test", "privateKey": KEY, "signCount": null})).unwrap().counter, None);
        assert!(command_credential(&plain, &json!({"credentialId": "AQ", "privateKey": KEY})).is_err());
        assert!(command_credential(&plain, &json!({"credentialId": "AQ", "rpId": "a.test", "privateKey": "AQ"})).is_err());
        assert!(command_credential(&plain, &json!({"credentialId": "*", "rpId": "a.test", "privateKey": KEY})).is_err());
        let discoverable = json!({"credentialId": "AQ", "rpId": "a.test", "privateKey": KEY, "isResidentCredential": true, "userHandle": "AQ"});
        assert!(command_credential(&plain, &discoverable).is_err());
        assert!(command_credential(&resident, &discoverable).is_ok());
        assert!(command_credential(&resident, &json!({"credentialId": "AQ", "rpId": "a.test", "privateKey": KEY, "isResidentCredential": true})).is_err());
    }

    #[test]
    fn a_platform_authenticator_is_one_that_verifies() {
        let partition = 0xc0_0003;
        assert_eq!(platform_authenticators(partition), (false, false));
        add_authenticator_for_ruby(partition, r#"{"transport": "usb", "hasUserVerification": true, "hasResidentKey": true}"#.to_owned());
        assert_eq!(platform_authenticators(partition), (false, false));
        add_authenticator_for_ruby(partition, r#"{"transport": "internal"}"#.to_owned());
        assert_eq!(platform_authenticators(partition), (false, false));
        let id = add_authenticator_for_ruby(partition, r#"{"transport": "internal", "hasUserVerification": true}"#.to_owned());
        assert_eq!(platform_authenticators(partition), (true, false));
        remove_authenticator_for_ruby(partition, id);
        add_authenticator_for_ruby(partition, r#"{"transport": "internal", "hasUserVerification": true, "hasResidentKey": true}"#.to_owned());
        assert_eq!(platform_authenticators(partition), (true, true));
        clear(partition);
    }
}
