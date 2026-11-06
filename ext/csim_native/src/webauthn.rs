// Web Authentication's client and its virtual authenticators (WebAuthn Level 3 §5.1, §6.3, §11): a session's Virtual
// Authenticator Database — every window of it asks the same one, by its partition (lib.rs `session_partition_new`) —
// each authenticator's credentials, the ceremonies run over them, and the encodings they answer in. The driver adds and
// configures the authenticators (`Browser#webauthn`, webauthn.rb, as WebDriver's or CDP's commands do); the bindings
// (webauthn.js) hold what is a JS value: the promise, the abort signal, and the objects a result is made into.
//
// A ceremony is two steps, as the spec's are: `begin_*`, as the page calls, takes a snapshot of the options (their
// BufferSources must be, §5.1.3) and runs the client's checks; `finish`, in a task, asks the authenticators. So an abort
// between them cancels a request no authenticator has answered, and no credential is made for it. The authenticators
// answer at once, with no lifetime timer: one no authenticator can answer is a NotAllowedError now rather than at its
// timeout, and an authenticator added while it is pending does not answer it.
//
// ES256 is the one algorithm these authenticators make keys of (a request for no other is one they refuse), and they
// attest a credential with its own key: `packed` self attestation (§8.2), or `none`.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{DerSignature, SigningKey};
use pkcs8::{DecodePrivateKey as _, EncodePublicKey as _};
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};

use crate::dom::{realm_id, register};
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

// What a session's windows share. A request between its two steps is here too, by its number.
#[derive(Default)]
struct Session {
    authenticators: Vec<Authenticator>,
    last_authenticator: u64,
    requests: HashMap<u64, Request>,
    last_request: u64,
}

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
    fn rp_id(&self, requested: Option<&str>) -> Outcome<String> {
        let Some(domain) = self.effective_domain.as_deref() else {
            return fail("NotAllowedError", "The origin is opaque.");
        };
        if domain.is_empty() || crate::realm_location::ip_host(domain) {
            return fail("SecurityError", "This is an invalid domain.");
        }
        match requested {
            None => Ok(domain.to_owned()),
            Some(rp_id) if crate::realm_location::registrable_domain_suffix(rp_id, domain) => Ok(rp_id.to_owned()),
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
    rp_id: Option<String>,
    challenge: Vec<u8>,
    allow: Vec<Descriptor>,
    user_verification: String,
    conditional: bool,
}

// A request whose client steps are done, waiting for the authenticators.
enum Request {
    Create(Creation),
    Get(Assertion),
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
fn flags_of(user_verified: bool, backup_eligible: bool, backup_state: bool) -> u8 {
    UP | if user_verified { UV } else { 0 } | if backup_eligible { BE } else { 0 } | if backup_state { BS } else { 0 }
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
    // None yet: a conditional request nothing can answer is not settled (Credential Management §2.5.1).
    Pending,
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
// Step two of a request (`begin_*`'s): none where it has been cancelled.
fn finish(partition: u64, number: u64) -> Option<Outcome<Answer>> {
    let mut sessions = sessions();
    let session = sessions.get_mut(&partition)?;
    Some(match session.requests.remove(&number)? {
        Request::Create(request) => finish_create(session, &request).map(Answer::Created),
        // (…no credential for a conditional one, or its user's refusal: it waits on, as the spec's does for the user)
        Request::Get(request) if request.conditional => Ok(finish_get(session, &request).map_or(Answer::Pending, Answer::Asserted)),
        Request::Get(request) => finish_get(session, &request).map(Answer::Asserted),
    })
}
fn enqueue(partition: u64, request: Request) -> u64 {
    let mut sessions = sessions();
    let session = sessions.entry(partition).or_default();
    session.last_request += 1;
    session.requests.insert(session.last_request, request);
    session.last_request
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
    let mut platform = sessions.get(&partition).into_iter().flat_map(|s| &s.authenticators).filter(|a| a.transport == "internal" && a.has_user_verification);
    let uv = platform.next();
    (uv.is_some(), uv.is_some_and(|a| a.has_resident_key) || platform.any(|a| a.has_resident_key))
}

// ── The driver's commands (§11.3-11.9): text the host passes through, as JSON ───────────────────────────────────────
pub(crate) fn add_authenticator_for_ruby(partition: u64, config: String) -> String {
    let config: Value = serde_json::from_str(&config).unwrap_or(Value::Null);
    let mut sessions = sessions();
    let session = sessions.entry(partition).or_default();
    session.last_authenticator += 1;
    let id = format!("csim-auth-{}", session.last_authenticator);
    session.authenticators.push(Authenticator::new(id.clone(), &config));
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
// A credential (§11.5's Credential Parameters), checked as its remote end steps do.
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
        Some(count) => Some(count.as_f64().filter(|n| (0.0..=u32::MAX as f64).contains(n)).ok_or("signCount is out of range")? as u32),
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
    Ok(Some(raw_id))
}
pub(crate) fn remove_credential_for_ruby(partition: u64, id: String, credential_id: String) {
    let Some(credential_id) = command_bytes(&credential_id) else { return };
    if let Some(authenticator) = sessions().get_mut(&partition).and_then(|s| s.authenticators.iter_mut().find(|a| a.id == id)) {
        authenticator.credentials.retain(|c| c.id != credential_id);
    }
}
// Its credentials (§11.6), as JSON; none for an authenticator no longer there.
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
    register(scope, ns, "webauthnBeginCreate", begin_create_op, context_id);
    register(scope, ns, "webauthnBeginGet", begin_get_op, context_id);
    register(scope, ns, "webauthnFinish", finish_op, context_id);
    register(scope, ns, "webauthnCancel", cancel_op, context_id);
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
        rp_id: member_text(scope, pk, "rpId"),
        challenge: member_bytes(scope, pk, "challenge"),
        allow: descriptors(scope, pk, "allowCredentials"),
        user_verification: member_text(scope, pk, "userVerification").unwrap_or_else(|| "preferred".to_owned()),
        conditional,
    }
}

// __dom.webauthnBeginCreate(partition, publicKey, mediation) -> the request's number, or throws what its client steps
// do. A cross-origin caller's user activation is consumed by it (§5.1.3 step 2), whatever comes of it after.
fn begin_create_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let partition = partition_arg(scope, &args);
    let Ok(pk) = v8::Local::<v8::Object>::try_from(args.get(1)) else { return };
    let conditional = args.get(2).to_rust_string_lossy(scope) == "conditional";
    let Some(options) = creation_options(scope, pk, conditional) else { return };
    let caller = caller(scope, &args);
    if caller.cross_origin && !conditional {
        let realm = realm_id(scope, &args);
        crate::dom::dom(scope).arena.consume_activation(realm);
    }
    match begin_create(options, &caller) {
        Ok(request) => rv.set_double(enqueue(partition, Request::Create(request)) as f64),
        Err(failure) => throw(scope, failure),
    }
}
// __dom.webauthnBeginGet(partition, publicKey, mediation) -> the request's number, or throws what its client steps do.
fn begin_get_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let partition = partition_arg(scope, &args);
    let Ok(pk) = v8::Local::<v8::Object>::try_from(args.get(1)) else { return };
    let conditional = args.get(2).to_rust_string_lossy(scope) == "conditional";
    let options = request_options(scope, pk, conditional);
    let caller = caller(scope, &args);
    match begin_get(options, &caller) {
        Ok(request) => rv.set_double(enqueue(partition, Request::Get(request)) as f64),
        Err(failure) => throw(scope, failure),
    }
}
// __dom.webauthnFinish(partition, number) -> the authenticators' answer, as an object of the realm's own ArrayBuffers,
// or undefined for none yet (or a request cancelled); or throws their refusal.
fn finish_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let partition = partition_arg(scope, &args);
    let number = args.get(1).number_value(scope).unwrap_or(0.0) as u64;
    match finish(partition, number) {
        None | Some(Ok(Answer::Pending)) => {}
        Some(Err(failure)) => throw(scope, failure),
        Some(Ok(Answer::Created(created))) => {
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
        Some(Ok(Answer::Asserted(asserted))) => {
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
// __dom.webauthnCancel(partition, number): the authenticators cancelled (§6.3.4): an aborted request that had not asked them.
fn cancel_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let partition = partition_arg(scope, &args);
    let number = args.get(1).number_value(scope).unwrap_or(0.0) as u64;
    if let Some(session) = sessions().get_mut(&partition) {
        session.requests.remove(&number);
    }
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
        RequestOptions { rp_id: None, challenge: vec![3], allow: Vec::new(), user_verification: "preferred".to_owned(), conditional: false }
    }
    fn session(config: Value) -> Session {
        let mut session = Session::default();
        session.authenticators.push(Authenticator::new("a".to_owned(), &config));
        session
    }
    fn create(session: &mut Session, options: CreationOptions) -> Outcome<Created> {
        finish_create(session, &begin_create(options, &page()).map_err(|f| f)?)
    }
    fn get(session: &mut Session, options: RequestOptions) -> Outcome<Asserted> {
        finish_get(session, &begin_get(options, &page()).map_err(|f| f)?)
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
    fn a_conditional_request_waits_for_what_its_filter_lets_through() {
        let partition = 0xc0_0001;
        let id = add_authenticator_for_ruby(partition, r#"{"hasResidentKey": true}"#.to_owned());
        assert_eq!(id, "csim-auth-1");
        let conditional = |allow: Vec<Descriptor>| {
            let number = enqueue(partition, Request::Get(begin_get(RequestOptions { allow, conditional: true, ..request() }, &page()).ok().unwrap()));
            finish(partition, number).unwrap().ok().unwrap()
        };
        assert!(matches!(conditional(Vec::new()), Answer::Pending));
        let number = enqueue(partition, Request::Create(begin_create(CreationOptions { resident_key: Some("required".to_owned()), ..creation() }, &page()).ok().unwrap()));
        let Answer::Created(created) = finish(partition, number).unwrap().ok().unwrap() else { panic!() };
        assert!(matches!(conditional(vec![descriptor(&[9])]), Answer::Pending));
        assert!(matches!(conditional(vec![descriptor(&created.id)]), Answer::Asserted(_)));
        assert!(matches!(conditional(Vec::new()), Answer::Asserted(_)));
        // (…a request cancelled is not answered)
        let number = enqueue(partition, Request::Get(begin_get(request(), &page()).ok().unwrap()));
        sessions().get_mut(&partition).unwrap().requests.remove(&number);
        assert!(finish(partition, number).is_none());
        clear(partition);
        assert!(!sessions().contains_key(&partition));
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
