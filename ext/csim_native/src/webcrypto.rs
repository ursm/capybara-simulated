// Web Cryptography (W3C Web Cryptography Level 2, the Secure Curves in it): SubtleCrypto's operations — each registered
// algorithm's import, export and generation of keys and its sign / verify / encrypt / decrypt / derive steps — and the
// checks the operations make of the keys they are handed. The bindings (webcrypto.js) convert the arguments ("normalize an
// algorithm" converts its dictionary — the IDL's, generated — to the type `registered` names), hold each CryptoKey's
// slots and settle the promises. A key's material is this module's, opaque to them: a secret key's bytes, an RSA key's
// SPKI / PKCS #8, an EC key's point (SEC 1, uncompressed) or scalar, an Ed25519 / X25519 key's 32 bytes.

use hmac::Mac as _;
use pkcs8::DecodePrivateKey as _;
use rand_core::RngCore as _;
use rsa::traits::{PrivateKeyParts as _, PublicKeyParts as _};
use sha2::Digest as _;
use spki::DecodePublicKey as _;

// What an operation is refused with: a DOMException's name, or "TypeError".
#[derive(Debug, PartialEq)]
pub(crate) struct Failure {
    pub(crate) name: &'static str,
    pub(crate) message: String,
}
type Outcome<T> = Result<T, Failure>;
fn fail<T>(name: &'static str, message: impl Into<String>) -> Outcome<T> {
    Err(Failure { name, message: message.into() })
}
fn data_error<T>(message: &str) -> Outcome<T> {
    fail("DataError", message)
}
fn operation_error<T>(message: &str) -> Outcome<T> {
    fail("OperationError", message)
}

// ── algorithms ──

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Hash {
    Sha1,
    Sha256,
    Sha384,
    Sha512,
}
// A body run with `$D` the hash's digest type.
macro_rules! with_digest {
    ($hash:expr, $D:ident => $body:expr) => {
        match $hash {
            Hash::Sha1 => {
                type $D = sha1::Sha1;
                $body
            }
            Hash::Sha256 => {
                type $D = sha2::Sha256;
                $body
            }
            Hash::Sha384 => {
                type $D = sha2::Sha384;
                $body
            }
            Hash::Sha512 => {
                type $D = sha2::Sha512;
                $body
            }
        }
    };
}
impl Hash {
    fn name(self) -> &'static str {
        match self {
            Hash::Sha1 => "SHA-1",
            Hash::Sha256 => "SHA-256",
            Hash::Sha384 => "SHA-384",
            Hash::Sha512 => "SHA-512",
        }
    }
    // …the digits a JWK `alg` names it by (`HS256`, `RS1`).
    fn digits(self) -> &'static str {
        &self.name()[4..]
    }
    // The input block of HMAC over it, in bits: an HMAC key's length where none is given.
    fn block_bits(self) -> u32 {
        match self {
            Hash::Sha1 | Hash::Sha256 => 512,
            Hash::Sha384 | Hash::Sha512 => 1024,
        }
    }
    pub(crate) fn digest(self, data: &[u8]) -> Vec<u8> {
        with_digest!(self, D => D::digest(data).to_vec())
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Alg {
    Sha(Hash),
    Hmac,
    AesCbc,
    AesCtr,
    AesGcm,
    AesKw,
    RsaPkcs1,
    RsaPss,
    RsaOaep,
    Ecdsa,
    Ecdh,
    Ed25519,
    X25519,
    Hkdf,
    Pbkdf2,
}
// The registered algorithms, by their names as a key's `algorithm.name` gives them.
const ALGORITHMS: [(&str, Alg); 18] = [
    ("SHA-1", Alg::Sha(Hash::Sha1)),
    ("SHA-256", Alg::Sha(Hash::Sha256)),
    ("SHA-384", Alg::Sha(Hash::Sha384)),
    ("SHA-512", Alg::Sha(Hash::Sha512)),
    ("HMAC", Alg::Hmac),
    ("AES-CBC", Alg::AesCbc),
    ("AES-CTR", Alg::AesCtr),
    ("AES-GCM", Alg::AesGcm),
    ("AES-KW", Alg::AesKw),
    ("RSASSA-PKCS1-v1_5", Alg::RsaPkcs1),
    ("RSA-PSS", Alg::RsaPss),
    ("RSA-OAEP", Alg::RsaOaep),
    ("ECDSA", Alg::Ecdsa),
    ("ECDH", Alg::Ecdh),
    ("Ed25519", Alg::Ed25519),
    ("X25519", Alg::X25519),
    ("HKDF", Alg::Hkdf),
    ("PBKDF2", Alg::Pbkdf2),
];
impl Alg {
    fn named(name: &str) -> Option<Alg> {
        ALGORITHMS.iter().find(|(n, _)| *n == name).map(|&(_, a)| a)
    }
    fn name(self) -> &'static str {
        ALGORITHMS.iter().find(|&&(_, a)| a == self).map_or("", |&(n, _)| n)
    }
    fn is_aes(self) -> bool {
        matches!(self, Alg::AesCbc | Alg::AesCtr | Alg::AesGcm | Alg::AesKw)
    }
    fn is_rsa(self) -> bool {
        matches!(self, Alg::RsaPkcs1 | Alg::RsaPss | Alg::RsaOaep)
    }
}

// "Normalize an algorithm"'s registry: the algorithm a name (compared ASCII case-insensitively) is for `op`, and the IDL
// dictionary its parameters convert to — None where none is registered for the operation (a NotSupportedError).
pub(crate) fn registered(op: &str, name: &str) -> Option<(Alg, &'static str)> {
    use Alg::*;
    let alg = ALGORITHMS.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|&(_, a)| a)?;
    let dictionary = match (alg, op) {
        (Sha(_), "digest") => "Algorithm",
        (Hmac, "sign" | "verify") => "Algorithm",
        (Hmac, "generateKey") => "HmacKeyGenParams",
        (Hmac, "importKey" | "get key length") => "HmacImportParams",
        (AesCbc, "encrypt" | "decrypt") => "AesCbcParams",
        (AesCtr, "encrypt" | "decrypt") => "AesCtrParams",
        (AesGcm, "encrypt" | "decrypt") => "AesGcmParams",
        (AesKw, "wrapKey" | "unwrapKey") => "Algorithm",
        (AesCbc | AesCtr | AesGcm | AesKw, "generateKey") => "AesKeyGenParams",
        (AesCbc | AesCtr | AesGcm | AesKw, "importKey") => "Algorithm",
        (AesCbc | AesCtr | AesGcm | AesKw, "get key length") => "AesDerivedKeyParams",
        (RsaPkcs1, "sign" | "verify") => "Algorithm",
        (RsaPss, "sign" | "verify") => "RsaPssParams",
        (RsaOaep, "encrypt" | "decrypt") => "RsaOaepParams",
        (RsaPkcs1 | RsaPss | RsaOaep, "generateKey") => "RsaHashedKeyGenParams",
        (RsaPkcs1 | RsaPss | RsaOaep, "importKey") => "RsaHashedImportParams",
        (Ecdsa, "sign" | "verify") => "EcdsaParams",
        (Ecdh | X25519, "deriveBits") => "EcdhKeyDeriveParams",
        (Ecdsa | Ecdh, "generateKey") => "EcKeyGenParams",
        (Ecdsa | Ecdh, "importKey") => "EcKeyImportParams",
        (Ed25519, "sign" | "verify" | "generateKey" | "importKey") => "Algorithm",
        (X25519, "generateKey" | "importKey") => "Algorithm",
        (Hkdf, "deriveBits") => "HkdfParams",
        (Pbkdf2, "deriveBits") => "Pbkdf2Params",
        (Hkdf | Pbkdf2, "importKey" | "get key length") => "Algorithm",
        _ => return None,
    };
    Some((alg, dictionary))
}

// A normalized algorithm: the algorithm and the members of its dictionary that were given (each BufferSource's bytes
// copied as normalizing copies them).
#[derive(Clone, Debug)]
pub(crate) struct Params {
    pub(crate) alg: Alg,
    pub(crate) hash: Option<Hash>,
    pub(crate) length: Option<u32>,
    pub(crate) iv: Option<Vec<u8>>,
    pub(crate) counter: Option<Vec<u8>>,
    pub(crate) additional_data: Option<Vec<u8>>,
    pub(crate) tag_length: Option<u32>,
    pub(crate) label: Option<Vec<u8>>,
    pub(crate) salt: Option<Vec<u8>>,
    pub(crate) info: Option<Vec<u8>>,
    pub(crate) iterations: Option<u32>,
    pub(crate) salt_length: Option<u32>,
    pub(crate) named_curve: Option<String>,
    pub(crate) modulus_length: Option<u32>,
    pub(crate) public_exponent: Option<Vec<u8>>,
    pub(crate) public: Option<Box<Key>>,
}
impl Params {
    pub(crate) fn new(alg: Alg) -> Params {
        Params {
            alg,
            hash: None,
            length: None,
            iv: None,
            counter: None,
            additional_data: None,
            tag_length: None,
            label: None,
            salt: None,
            info: None,
            iterations: None,
            salt_length: None,
            named_curve: None,
            modulus_length: None,
            public_exponent: None,
            public: None,
        }
    }
    // The hash its dictionary requires.
    fn hash(&self) -> Outcome<Hash> {
        self.hash.map_or_else(|| fail("TypeError", "a hash is required"), Ok)
    }
}

// ── keys ──

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Kind {
    Secret,
    Public,
    Private,
}
impl Kind {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Kind::Secret => "secret",
            Kind::Public => "public",
            Kind::Private => "private",
        }
    }
    pub(crate) fn named(name: &str) -> Option<Kind> {
        [Kind::Secret, Kind::Public, Kind::Private].into_iter().find(|k| k.name() == name)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Curve {
    P256,
    P384,
    P521,
}
// A body run with `$m` the curve's crate.
macro_rules! on_curve {
    ($curve:expr, $m:ident => $body:expr) => {
        match $curve {
            Curve::P256 => {
                use p256 as $m;
                $body
            }
            Curve::P384 => {
                use p384 as $m;
                $body
            }
            Curve::P521 => {
                use p521 as $m;
                $body
            }
        }
    };
}
impl Curve {
    pub(crate) fn named(name: &str) -> Option<Curve> {
        [Curve::P256, Curve::P384, Curve::P521].into_iter().find(|c| c.name() == name)
    }
    pub(crate) fn name(self) -> &'static str {
        match self {
            Curve::P256 => "P-256",
            Curve::P384 => "P-384",
            Curve::P521 => "P-521",
        }
    }
    // The length of a coordinate, a scalar and each half of a signature, in bytes.
    fn field_len(self) -> usize {
        match self {
            Curve::P256 => 32,
            Curve::P384 => 48,
            Curve::P521 => 66,
        }
    }
}

// The usages a key may have, as a set.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub(crate) struct Usages(u8);
// …each, in the order a key's `usages` lists them (KeyUsage's).
const USAGE_NAMES: [&str; 8] = ["encrypt", "decrypt", "sign", "verify", "deriveKey", "deriveBits", "wrapKey", "unwrapKey"];
impl Usages {
    const NONE: Usages = Usages(0);
    const ENCRYPT: Usages = Usages(1);
    const DECRYPT: Usages = Usages(2);
    const SIGN: Usages = Usages(4);
    const VERIFY: Usages = Usages(8);
    const DERIVE_KEY: Usages = Usages(16);
    const DERIVE_BITS: Usages = Usages(32);
    const WRAP_KEY: Usages = Usages(64);
    const UNWRAP_KEY: Usages = Usages(128);
    const DERIVE: Usages = Usages(16 | 32);

    pub(crate) fn named(name: &str) -> Option<Usages> {
        USAGE_NAMES.iter().position(|&n| n == name).map(|i| Usages(1 << i))
    }
    pub(crate) fn names(self) -> impl Iterator<Item = &'static str> {
        USAGE_NAMES.into_iter().enumerate().filter(move |&(i, _)| self.0 & (1 << i) != 0).map(|(_, n)| n)
    }
    fn is_empty(self) -> bool {
        self.0 == 0
    }
    fn has(self, u: Usages) -> bool {
        self.0 & u.0 == u.0
    }
}
impl std::ops::BitOr for Usages {
    type Output = Usages;
    fn bitor(self, other: Usages) -> Usages {
        Usages(self.0 | other.0)
    }
}
impl std::ops::BitAnd for Usages {
    type Output = Usages;
    fn bitand(self, other: Usages) -> Usages {
        Usages(self.0 & other.0)
    }
}
impl std::ops::BitOrAssign for Usages {
    fn bitor_assign(&mut self, other: Usages) {
        self.0 |= other.0;
    }
}
// "If usages contains an entry which is not …, then throw a SyntaxError."
fn allow(usages: Usages, allowed: Usages) -> Outcome<()> {
    if usages.0 & !allowed.0 != 0 { fail("SyntaxError", "a usage this key cannot have") } else { Ok(()) }
}

// A CryptoKey's slots: its type, extractability, algorithm (its name and the members a key of it keeps), usages and
// material.
#[derive(Clone, Debug)]
pub(crate) struct Key {
    pub(crate) kind: Kind,
    pub(crate) extractable: bool,
    pub(crate) alg: Alg,
    pub(crate) hash: Option<Hash>,
    pub(crate) length: Option<u32>,
    pub(crate) curve: Option<Curve>,
    pub(crate) usages: Usages,
    pub(crate) material: Vec<u8>,
}
impl Key {
    fn new(kind: Kind, alg: Alg, material: Vec<u8>) -> Key {
        Key { kind, extractable: false, alg, hash: None, length: None, curve: None, usages: Usages::NONE, material }
    }
    fn curve(&self) -> Outcome<Curve> {
        self.curve.map_or_else(|| data_error("the key has no curve"), Ok)
    }
    // An RSA key's modulus length in bits and public exponent (big-endian), which its `algorithm` reports.
    pub(crate) fn rsa_info(&self) -> Option<(u32, Vec<u8>)> {
        let (n, e) = match self.kind {
            Kind::Private => rsa::RsaPrivateKey::from_pkcs8_der(&self.material).ok().map(|k| (k.n().clone(), k.e().clone()))?,
            _ => rsa_public_key(&self.material).map(|k| (k.n().clone(), k.e().clone()))?,
        };
        Some((n.bits() as u32, e.to_bytes_be()))
    }
}

// The keying material importKey takes: a BufferSource's bytes, or a JsonWebKey.
pub(crate) enum KeyData {
    Bytes(Vec<u8>),
    Jwk(Jwk),
}
// What exportKey gives.
pub(crate) enum Exported {
    Bytes(Vec<u8>),
    Jwk(Jwk),
}
// A JsonWebKey's members (RFC 7517), the ones the algorithms read.
#[derive(Clone, Default, Debug, PartialEq)]
pub(crate) struct Jwk {
    pub(crate) kty: Option<String>,
    pub(crate) use_: Option<String>,
    pub(crate) key_ops: Option<Vec<String>>,
    pub(crate) alg: Option<String>,
    pub(crate) ext: Option<bool>,
    pub(crate) crv: Option<String>,
    pub(crate) x: Option<String>,
    pub(crate) y: Option<String>,
    pub(crate) d: Option<String>,
    pub(crate) n: Option<String>,
    pub(crate) e: Option<String>,
    pub(crate) p: Option<String>,
    pub(crate) q: Option<String>,
    pub(crate) dp: Option<String>,
    pub(crate) dq: Option<String>,
    pub(crate) qi: Option<String>,
    pub(crate) k: Option<String>,
}
impl Jwk {
    // Its string members in the order the IDL dictionary has them (lexicographic, as a dictionary converted to an
    // object lists them), `ext` and `key_ops` in their places among them.
    pub(crate) fn string_members(&self) -> [(&'static str, &Option<String>); 15] {
        [
            ("alg", &self.alg),
            ("crv", &self.crv),
            ("d", &self.d),
            ("dp", &self.dp),
            ("dq", &self.dq),
            ("e", &self.e),
            ("k", &self.k),
            ("kty", &self.kty),
            ("n", &self.n),
            ("p", &self.p),
            ("q", &self.q),
            ("qi", &self.qi),
            ("use", &self.use_),
            ("x", &self.x),
            ("y", &self.y),
        ]
    }
    pub(crate) fn string_member_mut(&mut self, name: &str) -> Option<&mut Option<String>> {
        Some(match name {
            "alg" => &mut self.alg,
            "crv" => &mut self.crv,
            "d" => &mut self.d,
            "dp" => &mut self.dp,
            "dq" => &mut self.dq,
            "e" => &mut self.e,
            "k" => &mut self.k,
            "kty" => &mut self.kty,
            "n" => &mut self.n,
            "p" => &mut self.p,
            "q" => &mut self.q,
            "qi" => &mut self.qi,
            "use" => &mut self.use_,
            "x" => &mut self.x,
            "y" => &mut self.y,
            _ => return None,
        })
    }
    // A key's JWK with its `key_ops` and `ext`, as every export sets them.
    fn of(key: &Key, kty: &str) -> Jwk {
        Jwk {
            kty: Some(kty.to_owned()),
            key_ops: Some(key.usages.names().map(str::to_owned).collect()),
            ext: Some(key.extractable),
            ..Jwk::default()
        }
    }
    // Its JSON text — wrapKey's "jwk" bytes: the members in the dictionary's order.
    pub(crate) fn to_json(&self) -> String {
        let mut map = serde_json::Map::new();
        for (name, value) in self.string_members() {
            if let Some(v) = value {
                map.insert(name.to_owned(), v.clone().into());
            }
            if name == "e" {
                if let Some(ext) = self.ext {
                    map.insert("ext".to_owned(), ext.into());
                }
            }
            if name == "k" {
                if let Some(ops) = &self.key_ops {
                    map.insert("key_ops".to_owned(), ops.clone().into());
                }
            }
        }
        serde_json::Value::Object(map).to_string()
    }
    // A member the algorithm requires (a DataError where it is missing), base64url-decoded.
    fn bytes(member: &Option<String>) -> Outcome<Vec<u8>> {
        member.as_deref().map_or_else(
            || data_error("a required JWK member is missing"),
            |m| base64url_decode(m.trim_end_matches('=')).map_or_else(|| data_error("a JWK member is not base64url"), Ok)
        )
    }
}

// The JWK checks every import makes: `use` (where usages are asked for) the one the key is for, `key_ops` (where given)
// valid and holding every usage, and `ext` false only for a key imported as not extractable.
fn check_jwk(jwk: &Jwk, usages: Usages, extractable: bool, use_: &str) -> Outcome<()> {
    if !usages.is_empty() && jwk.use_.as_deref().is_some_and(|u| u != use_) {
        return data_error("the JWK's use is not the key's");
    }
    if let Some(ops) = &jwk.key_ops {
        let mut listed = Usages::NONE;
        for op in ops {
            let Some(u) = Usages::named(op) else { continue };
            if listed.has(u) {
                return data_error("the JWK's key_ops lists an operation twice");
            }
            listed |= u;
        }
        if !listed.has(usages) {
            return data_error("the JWK's key_ops does not hold every usage");
        }
    }
    if jwk.ext == Some(false) && extractable {
        return data_error("the JWK is not extractable");
    }
    Ok(())
}

// base64url (RFC 4648 §5) without padding, as JWK members are.
fn base64url_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | (b as u32) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}
// …and back — None for text that is no unpadded base64url: a character outside its alphabet (`=` among them), or a
// length that leaves six bits over, a byte short.
fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        acc = acc << 6 | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    (bits < 6).then_some(out)
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut out = vec![0u8; n];
    rand_core::OsRng.fill_bytes(&mut out);
    out
}

// ── SubtleCrypto's operations ──

// The key an operation is handed must be of its algorithm and have the usage it is for (an InvalidAccessError).
fn check_key(alg: Alg, key: &Key, usage: Usages) -> Outcome<()> {
    if key.alg != alg {
        return fail("InvalidAccessError", format!("the key is an {} key, not an {} one", key.alg.name(), alg.name()));
    }
    if !key.usages.has(usage) {
        return fail("InvalidAccessError", "the key does not have the usage the operation is for");
    }
    Ok(())
}

pub(crate) fn digest(p: &Params, data: &[u8]) -> Outcome<Vec<u8>> {
    match p.alg {
        Alg::Sha(hash) => Ok(hash.digest(data)),
        _ => fail("NotSupportedError", "not a digest"),
    }
}

// importKey's steps after the format's check of its data: the algorithm's import, then the key no secret or private one
// without a usage.
pub(crate) fn import_key(format: &str, data: KeyData, p: &Params, extractable: bool, usages: Usages) -> Outcome<Key> {
    let mut key = match p.alg {
        Alg::Hmac => hmac_import(format, data, p, extractable, usages)?,
        a if a.is_aes() => aes_import(a, format, data, extractable, usages)?,
        a if a.is_rsa() => rsa_import(a, format, data, p, extractable, usages)?,
        Alg::Ecdsa | Alg::Ecdh => ec_import(p.alg, format, data, p, extractable, usages)?,
        Alg::Ed25519 | Alg::X25519 => okp_import(p.alg, format, data, extractable, usages)?,
        Alg::Hkdf | Alg::Pbkdf2 => kdf_import(p.alg, format, data, extractable, usages)?,
        _ => return fail("NotSupportedError", "the algorithm imports no key"),
    };
    if key.kind != Kind::Public && usages.is_empty() {
        return fail("SyntaxError", "a secret or private key needs a usage");
    }
    key.extractable = extractable;
    key.usages = usages;
    Ok(key)
}

// exportKey's steps: an algorithm with no export (HKDF, PBKDF2) a NotSupportedError, a key not extractable an
// InvalidAccessError, then the algorithm's.
pub(crate) fn export_key(format: &str, key: &Key) -> Outcome<Exported> {
    if matches!(key.alg, Alg::Hkdf | Alg::Pbkdf2) {
        return fail("NotSupportedError", format!("an {} key cannot be exported", key.alg.name()));
    }
    if !key.extractable {
        return fail("InvalidAccessError", "the key is not extractable");
    }
    match key.alg {
        Alg::Hmac => hmac_export(format, key),
        a if a.is_aes() => aes_export(format, key),
        a if a.is_rsa() => rsa_export(format, key),
        Alg::Ecdsa | Alg::Ecdh => ec_export(format, key),
        _ => okp_export(format, key),
    }
}

// What generateKey makes: a secret key, or a pair.
pub(crate) enum Generated {
    One(Key),
    Pair(Key, Key),
}
// generateKey's steps: the algorithm's, then the key no secret or private one without a usage.
pub(crate) fn generate_key(p: &Params, extractable: bool, usages: Usages) -> Outcome<Generated> {
    let made = match p.alg {
        Alg::Hmac => Generated::One(hmac_generate(p, usages)?),
        a if a.is_aes() => Generated::One(aes_generate(p, usages)?),
        a if a.is_rsa() => rsa_generate(p, usages)?,
        Alg::Ecdsa | Alg::Ecdh => ec_generate(p, usages)?,
        Alg::Ed25519 | Alg::X25519 => okp_generate(p.alg, usages)?,
        _ => return fail("NotSupportedError", "the algorithm generates no key"),
    };
    Ok(match made {
        Generated::One(mut key) => {
            if usages.is_empty() {
                return fail("SyntaxError", "a secret key needs a usage");
            }
            key.extractable = extractable;
            Generated::One(key)
        }
        Generated::Pair(public, mut private) => {
            if private.usages.is_empty() {
                return fail("SyntaxError", "a private key needs a usage");
            }
            private.extractable = extractable;
            Generated::Pair(public, private)
        }
    })
}

pub(crate) fn sign(p: &Params, key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    check_key(p.alg, key, Usages::SIGN)?;
    match p.alg {
        Alg::Hmac => Ok(hmac_mac(key, data)),
        Alg::RsaPkcs1 | Alg::RsaPss => rsa_sign(p, key, data),
        Alg::Ecdsa => ecdsa_sign(p, key, data),
        Alg::Ed25519 => ed25519_sign(key, data),
        _ => fail("NotSupportedError", "the algorithm does not sign"),
    }
}

pub(crate) fn verify(p: &Params, key: &Key, signature: &[u8], data: &[u8]) -> Outcome<bool> {
    check_key(p.alg, key, Usages::VERIFY)?;
    match p.alg {
        Alg::Hmac => Ok(constant_time_eq(&hmac_mac(key, data), signature)),
        Alg::RsaPkcs1 | Alg::RsaPss => rsa_verify(p, key, signature, data),
        Alg::Ecdsa => ecdsa_verify(p, key, signature, data),
        Alg::Ed25519 => Ok(ed25519_verify(key, signature, data)),
        _ => fail("NotSupportedError", "the algorithm does not verify"),
    }
}

pub(crate) fn encrypt(p: &Params, key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    check_key(p.alg, key, Usages::ENCRYPT)?;
    encrypt_with(p, key, data)
}
pub(crate) fn decrypt(p: &Params, key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    check_key(p.alg, key, Usages::DECRYPT)?;
    decrypt_with(p, key, data)
}
// The algorithm's encrypt / decrypt, which wrapKey / unwrapKey also run where it has no wrap of its own.
fn encrypt_with(p: &Params, key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    match p.alg {
        Alg::AesCbc => aes_cbc(p, key, data, true),
        Alg::AesCtr => aes_ctr(p, key, data),
        Alg::AesGcm => aes_gcm_encrypt(p, key, data),
        Alg::RsaOaep => rsa_oaep_encrypt(p, key, data),
        _ => fail("NotSupportedError", "the algorithm does not encrypt"),
    }
}
fn decrypt_with(p: &Params, key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    match p.alg {
        Alg::AesCbc => aes_cbc(p, key, data, false),
        Alg::AesCtr => aes_ctr(p, key, data),
        Alg::AesGcm => aes_gcm_decrypt(p, key, data),
        Alg::RsaOaep => rsa_oaep_decrypt(p, key, data),
        _ => fail("NotSupportedError", "the algorithm does not decrypt"),
    }
}

pub(crate) fn derive_bits(p: &Params, key: &Key, length: Option<u32>) -> Outcome<Vec<u8>> {
    check_key(p.alg, key, Usages::DERIVE_BITS)?;
    derive(p, key, length)
}
// The algorithm's "derive bits", `length` bits of it (null: all the agreement gives).
fn derive(p: &Params, key: &Key, length: Option<u32>) -> Outcome<Vec<u8>> {
    match p.alg {
        Alg::Ecdh | Alg::X25519 => {
            let secret = agree(p, key)?;
            match length {
                None => Ok(secret),
                Some(bits) if bits as usize > secret.len() * 8 => operation_error("the agreement has fewer bits than asked for"),
                Some(bits) => Ok(first_bits(secret, bits)),
            }
        }
        Alg::Hkdf | Alg::Pbkdf2 => kdf_derive(p, key, length),
        _ => fail("NotSupportedError", "the algorithm derives no bits"),
    }
}
// The first `bits` bits of `bytes`, the rest of the last byte zero.
fn first_bits(mut bytes: Vec<u8>, bits: u32) -> Vec<u8> {
    bytes.truncate(bits.div_ceil(8) as usize);
    if bits % 8 != 0 {
        if let Some(last) = bytes.last_mut() {
            *last &= 0xffu8 << (8 - bits % 8);
        }
    }
    bytes
}

// "Get key length": the length a key of the algorithm `p` is derived at (None: whatever the derivation gives).
pub(crate) fn key_length(p: &Params) -> Outcome<Option<u32>> {
    match p.alg {
        Alg::Hmac => match p.length {
            None => Ok(Some(p.hash()?.block_bits())),
            Some(0) => fail("TypeError", "an HMAC key's length cannot be zero"),
            Some(l) => Ok(Some(l)),
        },
        a if a.is_aes() => match p.length {
            Some(l @ (128 | 192 | 256)) => Ok(Some(l)),
            _ => operation_error("an AES key is 128, 192 or 256 bits"),
        },
        Alg::Hkdf | Alg::Pbkdf2 => Ok(None),
        _ => fail("NotSupportedError", "the algorithm has no key length"),
    }
}

// deriveKey's steps after normalizing: the base key's checks, its bits derived at the length of the key made, which is
// imported from them.
pub(crate) fn derive_key(p: &Params, key: &Key, import: &Params, length: &Params, extractable: bool, usages: Usages) -> Outcome<Key> {
    check_key(p.alg, key, Usages::DERIVE_KEY)?;
    let bits = key_length(length)?;
    let secret = derive(p, key, bits)?;
    import_key("raw", KeyData::Bytes(secret), import, extractable, usages)
}

// wrapKey's steps after normalizing: the wrapping key's checks, the key exported (a JWK as its JSON text) and wrapped —
// by the algorithm's wrap where it has one, else its encrypt.
pub(crate) fn wrap_key(format: &str, key: &Key, wrapping: &Key, p: &Params) -> Outcome<Vec<u8>> {
    check_key(p.alg, wrapping, Usages::WRAP_KEY)?;
    let bytes = match export_key(format, key)? {
        Exported::Bytes(b) => b,
        Exported::Jwk(jwk) => jwk.to_json().into_bytes(),
    };
    if p.alg == Alg::AesKw { aes_kw_wrap(wrapping, &bytes) } else { encrypt_with(p, wrapping, &bytes) }
}
// …and unwrapKey's, to the bytes the key is imported from.
pub(crate) fn unwrap_bytes(p: &Params, unwrapping: &Key, wrapped: &[u8]) -> Outcome<Vec<u8>> {
    check_key(p.alg, unwrapping, Usages::UNWRAP_KEY)?;
    if p.alg == Alg::AesKw { aes_kw_unwrap(unwrapping, wrapped) } else { decrypt_with(p, unwrapping, wrapped) }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

// ── HMAC ──

fn hmac_import(format: &str, data: KeyData, p: &Params, extractable: bool, usages: Usages) -> Outcome<Key> {
    allow(usages, Usages::SIGN | Usages::VERIFY)?;
    let hash = p.hash()?;
    let bytes = match (format, data) {
        ("raw", KeyData::Bytes(b)) => b,
        ("jwk", KeyData::Jwk(jwk)) => {
            if jwk.kty.as_deref() != Some("oct") {
                return data_error("an HMAC JWK's kty is oct");
            }
            let bytes = Jwk::bytes(&jwk.k)?;
            if jwk.alg.as_deref().is_some_and(|a| a != format!("HS{}", hash.digits())) {
                return data_error("the JWK's alg is not the key's hash");
            }
            check_jwk(&jwk, usages, extractable, "sig")?;
            bytes
        }
        _ => return fail("NotSupportedError", format!("an HMAC key cannot be imported as {format}")),
    };
    let mut length = bytes.len() as u32 * 8;
    if length == 0 {
        return data_error("an HMAC key cannot be empty");
    }
    if let Some(l) = p.length {
        if l > length || l <= length - 8 {
            return data_error("the length is not the key data's");
        }
        length = l;
    }
    Ok(Key { hash: Some(hash), length: Some(length), ..Key::new(Kind::Secret, Alg::Hmac, bytes) })
}

fn hmac_export(format: &str, key: &Key) -> Outcome<Exported> {
    match format {
        "raw" => Ok(Exported::Bytes(key.material.clone())),
        "jwk" => Ok(Exported::Jwk(Jwk {
            k: Some(base64url_encode(&key.material)),
            alg: key.hash.map(|h| format!("HS{}", h.digits())),
            ..Jwk::of(key, "oct")
        })),
        _ => fail("NotSupportedError", format!("an HMAC key cannot be exported as {format}")),
    }
}

fn hmac_generate(p: &Params, usages: Usages) -> Outcome<Key> {
    allow(usages, Usages::SIGN | Usages::VERIFY)?;
    let hash = p.hash()?;
    let length = match p.length {
        None => hash.block_bits(),
        Some(0) => return operation_error("an HMAC key's length cannot be zero"),
        Some(l) => l,
    };
    Ok(Key { hash: Some(hash), length: Some(length), usages, ..Key::new(Kind::Secret, Alg::Hmac, random_bytes(length.div_ceil(8) as usize)) })
}

fn hmac_mac(key: &Key, data: &[u8]) -> Vec<u8> {
    with_digest!(key.hash.unwrap_or(Hash::Sha256), D => {
        let mut mac = hmac::Hmac::<D>::new_from_slice(&key.material).expect("HMAC takes a key of any length");
        mac.update(data);
        mac.finalize().into_bytes().to_vec()
    })
}

// ── AES ──

// The usages an AES key may have: AES-KW's only wrap.
fn aes_usages(alg: Alg) -> Usages {
    let wrap = Usages::WRAP_KEY | Usages::UNWRAP_KEY;
    if alg == Alg::AesKw { wrap } else { wrap | Usages::ENCRYPT | Usages::DECRYPT }
}
// A JWK `alg` for an AES key of `bits` (`A128GCM`).
fn aes_jwk_alg(alg: Alg, bits: u32) -> String {
    format!("A{bits}{}", &alg.name()[4..])
}

fn aes_import(alg: Alg, format: &str, data: KeyData, extractable: bool, usages: Usages) -> Outcome<Key> {
    allow(usages, aes_usages(alg))?;
    let bytes = match (format, data) {
        ("raw", KeyData::Bytes(b)) => b,
        ("jwk", KeyData::Jwk(jwk)) => {
            if jwk.kty.as_deref() != Some("oct") {
                return data_error("an AES JWK's kty is oct");
            }
            let bytes = Jwk::bytes(&jwk.k)?;
            if !matches!(bytes.len(), 16 | 24 | 32) {
                return data_error("an AES key is 128, 192 or 256 bits");
            }
            if jwk.alg.as_deref().is_some_and(|a| a != aes_jwk_alg(alg, bytes.len() as u32 * 8)) {
                return data_error("the JWK's alg is not the key's");
            }
            check_jwk(&jwk, usages, extractable, "enc")?;
            bytes
        }
        _ => return fail("NotSupportedError", format!("an {} key cannot be imported as {format}", alg.name())),
    };
    if !matches!(bytes.len(), 16 | 24 | 32) {
        return data_error("an AES key is 128, 192 or 256 bits");
    }
    Ok(Key { length: Some(bytes.len() as u32 * 8), ..Key::new(Kind::Secret, alg, bytes) })
}

fn aes_export(format: &str, key: &Key) -> Outcome<Exported> {
    match format {
        "raw" => Ok(Exported::Bytes(key.material.clone())),
        "jwk" => Ok(Exported::Jwk(Jwk {
            k: Some(base64url_encode(&key.material)),
            alg: Some(aes_jwk_alg(key.alg, key.material.len() as u32 * 8)),
            ..Jwk::of(key, "oct")
        })),
        _ => fail("NotSupportedError", format!("an {} key cannot be exported as {format}", key.alg.name())),
    }
}

fn aes_generate(p: &Params, usages: Usages) -> Outcome<Key> {
    allow(usages, aes_usages(p.alg))?;
    let bits = match p.length {
        Some(l @ (128 | 192 | 256)) => l,
        _ => return operation_error("an AES key is 128, 192 or 256 bits"),
    };
    Ok(Key { length: Some(bits), usages, ..Key::new(Kind::Secret, p.alg, random_bytes(bits as usize / 8)) })
}

// The AES block cipher keyed with a key's bytes.
enum Aes {
    A128(aes::Aes128),
    A192(aes::Aes192),
    A256(aes::Aes256),
}
impl Aes {
    fn new(key: &[u8]) -> Outcome<Aes> {
        use aes::cipher::KeyInit as _;
        Ok(match key.len() {
            16 => Aes::A128(aes::Aes128::new(key.into())),
            24 => Aes::A192(aes::Aes192::new(key.into())),
            32 => Aes::A256(aes::Aes256::new(key.into())),
            _ => return operation_error("an AES key is 128, 192 or 256 bits"),
        })
    }
    fn encrypt(&self, block: &mut [u8; 16]) {
        use aes::cipher::BlockEncrypt as _;
        let block = block.into();
        match self {
            Aes::A128(c) => c.encrypt_block(block),
            Aes::A192(c) => c.encrypt_block(block),
            Aes::A256(c) => c.encrypt_block(block),
        }
    }
    fn decrypt(&self, block: &mut [u8; 16]) {
        use aes::cipher::BlockDecrypt as _;
        let block = block.into();
        match self {
            Aes::A128(c) => c.decrypt_block(block),
            Aes::A192(c) => c.decrypt_block(block),
            Aes::A256(c) => c.decrypt_block(block),
        }
    }
}
fn xor_into(out: &mut [u8], with: &[u8]) {
    out.iter_mut().zip(with).for_each(|(o, w)| *o ^= w);
}

// AES-CBC with PKCS #7 padding: `encrypting`, or decrypting (a bad padding an OperationError).
fn aes_cbc(p: &Params, key: &Key, data: &[u8], encrypting: bool) -> Outcome<Vec<u8>> {
    let iv: [u8; 16] = p.iv.as_deref().and_then(|iv| iv.try_into().ok()).map_or_else(|| operation_error("an AES-CBC iv is 16 bytes"), Ok)?;
    let aes = Aes::new(&key.material)?;
    let mut chain = iv;
    if encrypting {
        let pad = 16 - data.len() % 16;
        let mut out = Vec::with_capacity(data.len() + pad);
        out.extend_from_slice(data);
        out.resize(data.len() + pad, pad as u8);
        for block in out.chunks_exact_mut(16) {
            xor_into(block, &chain);
            let block: &mut [u8; 16] = block.try_into().unwrap();
            aes.encrypt(block);
            chain = *block;
        }
        return Ok(out);
    }
    if data.is_empty() || data.len() % 16 != 0 {
        return operation_error("AES-CBC ciphertext is a whole number of blocks");
    }
    let mut out = data.to_vec();
    for block in out.chunks_exact_mut(16) {
        let block: &mut [u8; 16] = block.try_into().unwrap();
        let next = *block;
        aes.decrypt(block);
        xor_into(block, &chain);
        chain = next;
    }
    let pad = *out.last().unwrap_or(&0) as usize;
    if pad == 0 || pad > 16 || !out[out.len() - pad..].iter().all(|&b| b as usize == pad) {
        return operation_error("the AES-CBC padding is not valid");
    }
    out.truncate(out.len() - pad);
    Ok(out)
}

// AES-CTR (both ways): the counter's rightmost `length` bits incrementing, wrapping within them — more blocks than they
// count an OperationError, as a counter used twice would be.
fn aes_ctr(p: &Params, key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    let counter: [u8; 16] = p.counter.as_deref().and_then(|c| c.try_into().ok()).map_or_else(|| operation_error("an AES-CTR counter is 16 bytes"), Ok)?;
    let length = match p.length {
        Some(l @ 1..=128) => l,
        _ => return operation_error("an AES-CTR length is between 1 and 128"),
    };
    let blocks = data.len().div_ceil(16) as u128;
    if length < 128 && blocks > 1u128 << length {
        return operation_error("the AES-CTR counter would repeat");
    }
    let aes = Aes::new(&key.material)?;
    let mask = if length == 128 { u128::MAX } else { (1u128 << length) - 1 };
    let start = u128::from_be_bytes(counter);
    let mut out = data.to_vec();
    for (i, chunk) in out.chunks_mut(16).enumerate() {
        let value = (start & !mask) | (start.wrapping_add(i as u128) & mask);
        let mut block = value.to_be_bytes();
        aes.encrypt(&mut block);
        xor_into(chunk, &block);
    }
    Ok(out)
}

// AES-GCM (NIST SP 800-38D), with any IV length and any of the tag lengths WebCrypto allows: the tag truncated.
fn gcm_tag_length(p: &Params) -> Outcome<usize> {
    match p.tag_length {
        None => Ok(16),
        Some(l @ (32 | 64 | 96 | 104 | 112 | 120 | 128)) => Ok(l as usize / 8),
        _ => operation_error("not an AES-GCM tag length"),
    }
}
// The ciphertext of `data` (encrypting and decrypting alike: GCM is a counter mode) and its full tag.
fn gcm(aes: &Aes, iv: &[u8], aad: &[u8], data: &[u8], ciphertext_is_input: bool) -> (Vec<u8>, [u8; 16]) {
    use ghash::universal_hash::{KeyInit as _, UniversalHash as _};
    let mut h = [0u8; 16];
    aes.encrypt(&mut h);
    let ghash_of = |parts: &[&[u8]], lengths: [u64; 2]| -> [u8; 16] {
        let mut g = ghash::GHash::new(&h.into());
        for part in parts {
            g.update_padded(part);
        }
        let mut block = [0u8; 16];
        block[..8].copy_from_slice(&lengths[0].to_be_bytes());
        block[8..].copy_from_slice(&lengths[1].to_be_bytes());
        g.update(&[block.into()]);
        g.finalize().into()
    };
    let j0 = if iv.len() == 12 {
        let mut j = [0u8; 16];
        j[..12].copy_from_slice(iv);
        j[15] = 1;
        j
    } else {
        ghash_of(&[iv], [0, iv.len() as u64 * 8])
    };
    let mut out = data.to_vec();
    let mut counter = j0;
    for chunk in out.chunks_mut(16) {
        let low = u32::from_be_bytes(counter[12..].try_into().unwrap()).wrapping_add(1);
        counter[12..].copy_from_slice(&low.to_be_bytes());
        let mut block = counter;
        aes.encrypt(&mut block);
        xor_into(chunk, &block);
    }
    let ciphertext = if ciphertext_is_input { data } else { &out };
    let mut tag = ghash_of(&[aad, ciphertext], [aad.len() as u64 * 8, ciphertext.len() as u64 * 8]);
    let mut e_j0 = j0;
    aes.encrypt(&mut e_j0);
    xor_into(&mut tag, &e_j0);
    (out, tag)
}
fn gcm_iv(p: &Params) -> Outcome<&[u8]> {
    match p.iv.as_deref() {
        Some(iv) if !iv.is_empty() => Ok(iv),
        _ => operation_error("an AES-GCM iv cannot be empty"),
    }
}
fn aes_gcm_encrypt(p: &Params, key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    if data.len() as u64 > (1u64 << 39) - 256 {
        return operation_error("the plaintext is too long for AES-GCM");
    }
    let tag_len = gcm_tag_length(p)?;
    let aes = Aes::new(&key.material)?;
    let (mut out, tag) = gcm(&aes, gcm_iv(p)?, p.additional_data.as_deref().unwrap_or_default(), data, false);
    out.extend_from_slice(&tag[..tag_len]);
    Ok(out)
}
fn aes_gcm_decrypt(p: &Params, key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    let tag_len = gcm_tag_length(p)?;
    if data.len() < tag_len {
        return operation_error("the ciphertext is shorter than the tag");
    }
    let aes = Aes::new(&key.material)?;
    let (ciphertext, tag) = data.split_at(data.len() - tag_len);
    let (plaintext, expected) = gcm(&aes, gcm_iv(p)?, p.additional_data.as_deref().unwrap_or_default(), ciphertext, true);
    if !constant_time_eq(&expected[..tag_len], tag) {
        return operation_error("the AES-GCM tag does not match");
    }
    Ok(plaintext)
}

// AES Key Wrap (RFC 3394): the default IV, at least two 64-bit blocks.
const KW_IV: [u8; 8] = [0xa6; 8];
fn aes_kw_wrap(key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    if data.len() % 8 != 0 || data.len() < 16 {
        return operation_error("AES-KW wraps a multiple of 64 bits, at least 128");
    }
    let aes = Aes::new(&key.material)?;
    let n = data.len() / 8;
    let mut a = KW_IV;
    let mut r: Vec<[u8; 8]> = data.chunks_exact(8).map(|c| c.try_into().unwrap()).collect();
    for j in 0..6 {
        for (i, ri) in r.iter_mut().enumerate() {
            let mut b = [0u8; 16];
            b[..8].copy_from_slice(&a);
            b[8..].copy_from_slice(ri);
            aes.encrypt(&mut b);
            let t = (n * j + i + 1) as u64;
            a = (u64::from_be_bytes(b[..8].try_into().unwrap()) ^ t).to_be_bytes();
            ri.copy_from_slice(&b[8..]);
        }
    }
    Ok(a.iter().chain(r.iter().flatten()).copied().collect())
}
fn aes_kw_unwrap(key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    if data.len() % 8 != 0 || data.len() < 24 {
        return operation_error("AES-KW unwraps a multiple of 64 bits, at least 192");
    }
    let aes = Aes::new(&key.material)?;
    let n = data.len() / 8 - 1;
    let mut a: [u8; 8] = data[..8].try_into().unwrap();
    let mut r: Vec<[u8; 8]> = data[8..].chunks_exact(8).map(|c| c.try_into().unwrap()).collect();
    for j in (0..6).rev() {
        for i in (0..n).rev() {
            let t = (n * j + i + 1) as u64;
            let mut b = [0u8; 16];
            b[..8].copy_from_slice(&(u64::from_be_bytes(a) ^ t).to_be_bytes());
            b[8..].copy_from_slice(&r[i]);
            aes.decrypt(&mut b);
            a.copy_from_slice(&b[..8]);
            r[i].copy_from_slice(&b[8..]);
        }
    }
    if !constant_time_eq(&a, &KW_IV) {
        return operation_error("the AES-KW integrity check failed");
    }
    Ok(r.concat())
}

// ── RSA ──

// The usages an RSA key of each type may have: a signing algorithm's, or RSA-OAEP's.
fn rsa_usages(alg: Alg) -> (Usages, Usages) {
    if alg == Alg::RsaOaep {
        (Usages::ENCRYPT | Usages::WRAP_KEY, Usages::DECRYPT | Usages::UNWRAP_KEY)
    } else {
        (Usages::VERIFY, Usages::SIGN)
    }
}
// The JWK `alg` an RSA key of `hash` has (`RS256`, `PS1`, `RSA-OAEP-384`).
fn rsa_jwk_alg(alg: Alg, hash: Hash) -> String {
    match alg {
        Alg::RsaPkcs1 => format!("RS{}", hash.digits()),
        Alg::RsaPss => format!("PS{}", hash.digits()),
        _ if hash == Hash::Sha1 => "RSA-OAEP".to_owned(),
        _ => format!("RSA-OAEP-{}", hash.digits()),
    }
}
fn big(member: &Option<String>) -> Outcome<rsa::BigUint> {
    Jwk::bytes(member).map(|b| rsa::BigUint::from_bytes_be(&b))
}
fn spki_der<K: spki::EncodePublicKey>(key: &K) -> Outcome<Vec<u8>> {
    key.to_public_key_der().map(|d| d.as_bytes().to_vec()).or_else(|_| data_error("the key cannot be encoded"))
}
fn pkcs8_der<K: pkcs8::EncodePrivateKey>(key: &K) -> Outcome<Vec<u8>> {
    key.to_pkcs8_der().map(|d| d.as_bytes().to_vec()).or_else(|_| data_error("the key cannot be encoded"))
}

// An RSA public key from its SubjectPublicKeyInfo (rsaEncryption's) — of up to 16384 bits, as Chrome takes: the
// crate's own parse refuses one over 4096.
const RSA_ENCRYPTION: spki::ObjectIdentifier = spki::ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.1");
fn rsa_public_key(der: &[u8]) -> Option<rsa::RsaPublicKey> {
    let info = spki::SubjectPublicKeyInfoRef::try_from(der).ok()?;
    if info.algorithm.oid != RSA_ENCRYPTION {
        return None;
    }
    let key = rsa::pkcs1::RsaPublicKey::try_from(info.subject_public_key.as_bytes()?).ok()?;
    rsa_public_from(rsa::BigUint::from_bytes_be(key.modulus.as_bytes()), rsa::BigUint::from_bytes_be(key.public_exponent.as_bytes()))
}
// …and from its modulus and exponent: a modulus odd and of up to 16384 bits, an exponent odd, from 3 and below it.
fn rsa_public_from(n: rsa::BigUint, e: rsa::BigUint) -> Option<rsa::RsaPublicKey> {
    let odd = |x: &rsa::BigUint| x.to_bytes_be().last().is_some_and(|b| b & 1 == 1);
    (n.bits() <= 16384 && odd(&n) && odd(&e) && e >= rsa::BigUint::from(3u32) && e < n).then(|| rsa::RsaPublicKey::new_unchecked(n, e))
}

fn rsa_import(alg: Alg, format: &str, data: KeyData, p: &Params, extractable: bool, usages: Usages) -> Outcome<Key> {
    let (public_usages, private_usages) = rsa_usages(alg);
    let hash = p.hash()?;
    let (kind, material) = match (format, data) {
        ("spki", KeyData::Bytes(der)) => {
            allow(usages, public_usages)?;
            let key = rsa_public_key(&der).map_or_else(|| data_error("not an RSA SubjectPublicKeyInfo"), Ok)?;
            (Kind::Public, spki_der(&key)?)
        }
        ("pkcs8", KeyData::Bytes(der)) => {
            allow(usages, private_usages)?;
            let key = rsa::RsaPrivateKey::from_pkcs8_der(&der).or_else(|_| data_error("not an RSA PrivateKeyInfo"))?;
            key.validate().or_else(|_| data_error("not a valid RSA key"))?;
            (Kind::Private, pkcs8_der(&key)?)
        }
        ("jwk", KeyData::Jwk(jwk)) => {
            allow(usages, if jwk.d.is_some() { private_usages } else { public_usages })?;
            if jwk.kty.as_deref() != Some("RSA") {
                return data_error("an RSA JWK's kty is RSA");
            }
            if let Some(a) = jwk.alg.as_deref() {
                let named = [Hash::Sha1, Hash::Sha256, Hash::Sha384, Hash::Sha512].into_iter().find(|&h| rsa_jwk_alg(alg, h) == a);
                if named != Some(hash) {
                    return data_error("the JWK's alg is not the key's");
                }
            }
            check_jwk(&jwk, usages, extractable, if alg == Alg::RsaOaep { "enc" } else { "sig" })?;
            let (n, e) = (big(&jwk.n)?, big(&jwk.e)?);
            if jwk.d.is_none() {
                let key = rsa_public_from(n, e).map_or_else(|| data_error("not a valid RSA public key"), Ok)?;
                (Kind::Public, spki_der(&key)?)
            } else {
                let d = big(&jwk.d)?;
                let primes = vec![big(&jwk.p)?, big(&jwk.q)?];
                let (dp, dq, qi) = (big(&jwk.dp)?, big(&jwk.dq)?, big(&jwk.qi)?);
                let key = rsa::RsaPrivateKey::from_components(n, e, d, primes).or_else(|_| data_error("not a valid RSA private key"))?;
                key.validate().or_else(|_| data_error("not a valid RSA private key"))?;
                let qinv = key.crt_coefficient();
                if key.dp() != Some(&dp) || key.dq() != Some(&dq) || qinv.as_ref() != Some(&qi) {
                    return data_error("the JWK's CRT parameters are not the key's");
                }
                (Kind::Private, pkcs8_der(&key)?)
            }
        }
        (other, _) => return fail("NotSupportedError", format!("an RSA key cannot be imported as {other}")),
    };
    Ok(Key { hash: Some(hash), ..Key::new(kind, alg, material) })
}

fn rsa_export(format: &str, key: &Key) -> Outcome<Exported> {
    match format {
        "spki" if key.kind == Kind::Public => Ok(Exported::Bytes(key.material.clone())),
        "pkcs8" if key.kind == Kind::Private => Ok(Exported::Bytes(key.material.clone())),
        "spki" | "pkcs8" => fail("InvalidAccessError", format!("a {} key cannot be exported as {format}", key.kind.name())),
        "jwk" => {
            let b = |n: &rsa::BigUint| Some(base64url_encode(&n.to_bytes_be()));
            let mut jwk = Jwk { alg: key.hash.map(|h| rsa_jwk_alg(key.alg, h)), ..Jwk::of(key, "RSA") };
            if key.kind == Kind::Private {
                let k = rsa::RsaPrivateKey::from_pkcs8_der(&key.material).or_else(|_| data_error("not an RSA key"))?;
                let [p, q] = [&k.primes()[0], &k.primes()[1]];
                (jwk.n, jwk.e, jwk.d, jwk.p, jwk.q) = (b(k.n()), b(k.e()), b(k.d()), b(p), b(q));
                (jwk.dp, jwk.dq, jwk.qi) = (k.dp().and_then(b), k.dq().and_then(b), k.crt_coefficient().as_ref().and_then(b));
            } else {
                let k = rsa_public_key(&key.material).map_or_else(|| data_error("not an RSA key"), Ok)?;
                (jwk.n, jwk.e) = (b(k.n()), b(k.e()));
            }
            Ok(Exported::Jwk(jwk))
        }
        _ => fail("NotSupportedError", format!("an RSA key cannot be exported as {format}")),
    }
}

fn rsa_generate(p: &Params, usages: Usages) -> Outcome<Generated> {
    let (public_usages, private_usages) = rsa_usages(p.alg);
    allow(usages, public_usages | private_usages)?;
    let hash = p.hash()?;
    let bits = p.modulus_length.unwrap_or(0);
    let exponent = p.public_exponent.as_deref().unwrap_or_default();
    // (…an exponent an odd integer from 3, and a modulus Chrome generates — 256 to 16384 bits, a whole number of bytes)
    let odd_from_3 = exponent.last().is_some_and(|&b| b & 1 == 1) && (exponent.iter().rev().skip(1).any(|&b| b != 0) || exponent.last() >= Some(&3));
    if !odd_from_3 || !(256..=16384).contains(&bits) || bits % 8 != 0 {
        return operation_error("the RSA parameters cannot be generated");
    }
    let private = rsa_private_key(bits as usize, &rsa::BigUint::from_bytes_be(exponent)).map_or_else(|| operation_error("the RSA key could not be generated"), Ok)?;
    let public = Key { hash: Some(hash), extractable: true, usages: usages & public_usages, ..Key::new(Kind::Public, p.alg, spki_der(&private.to_public_key())?) };
    let private = Key { hash: Some(hash), usages: usages & private_usages, ..Key::new(Kind::Private, p.alg, pkcs8_der(&private)?) };
    Ok(Generated::Pair(public, private))
}

// An RSA key of `bits` (a whole number of bytes) and exponent `e`: two primes of half the bits each — again where they
// make no key of `e` (an exponent sharing a factor with p - 1) — None where the exponent makes none at all.
fn rsa_private_key(bits: usize, e: &rsa::BigUint) -> Option<rsa::RsaPrivateKey> {
    for _ in 0..64 {
        let (p, q) = (random_prime(bits / 2), random_prime(bits - bits / 2));
        if let Ok(key) = rsa::RsaPrivateKey::from_p_q(p, q, e.clone()) {
            if key.n().bits() == bits {
                return Some(key);
            }
        }
    }
    None
}
// The odd primes below 2^16, which a prime candidate is sieved by.
fn small_primes() -> &'static [u32] {
    static PRIMES: std::sync::OnceLock<Vec<u32>> = std::sync::OnceLock::new();
    PRIMES.get_or_init(|| {
        let mut composite = vec![false; 1 << 16];
        (3..1u32 << 16).step_by(2).filter(|&n| {
            if composite[n as usize] {
                return false;
            }
            (n * n..1 << 16).step_by(2 * n as usize).for_each(|m| composite[m as usize] = true);
            true
        }).collect()
    })
}
// A random prime of `bits` bits, its top two set (so that two make a modulus of twice the bits): the odd numbers of a
// window from a random start, those with a factor below 2^16 sieved out, the rest tested — Fermat to base 2 first,
// which turns nearly every composite away at one modular exponentiation, then Miller–Rabin and Lucas. (num-bigint-dig's
// own `gen_prime`, which `RsaPrivateKey::new` takes its primes from, sieves only to 53 and draws a new start at every
// failure: three times the exponentiations, an RSA-2048 key in 79 ms where OpenSSL takes 24.)
fn random_prime(bits: usize) -> rsa::BigUint {
    use num_bigint_dig::ToBigUint as _;
    const WINDOW: usize = 1 << 12;
    let two = 2u32.to_biguint().unwrap();
    loop {
        let mut bytes = random_bytes(bits.div_ceil(8));
        let top = bits - (bytes.len() - 1) * 8;
        bytes[0] &= ((1u16 << top) - 1) as u8;
        bytes[0] |= (3u16 << top >> 2) as u8;
        *bytes.last_mut().unwrap() |= 1;
        let start = rsa::BigUint::from_bytes_be(&bytes);
        let mut composite = vec![false; WINDOW];
        for &p in small_primes() {
            let r = bytes.iter().fold(0u64, |r, &b| (r << 8 | b as u64) % p as u64);
            // (…the first k with p | start + 2k: 2k ≡ -start, k ≡ -start · 2⁻¹ (mod p))
            let mut k = ((p as u64 - r) % p as u64 * (p as u64 + 1) / 2 % p as u64) as usize;
            while k < WINDOW {
                composite[k] = true;
                k += p as usize;
            }
        }
        for k in (0..WINDOW).filter(|&k| !composite[k]) {
            let candidate = &start + rsa::BigUint::from(2 * k as u64);
            if candidate.bits() != bits {
                break;
            }
            let minus_one = &candidate - 1u32;
            if two.modpow(&minus_one, &candidate) == 1u32.to_biguint().unwrap() && num_bigint_dig::prime::probably_prime(&candidate, 5) {
                return candidate;
            }
        }
    }
}

fn rsa_sign(p: &Params, key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    if key.kind != Kind::Private {
        return fail("InvalidAccessError", "only a private key signs");
    }
    let hash = key.hash.unwrap_or(Hash::Sha256);
    let private = rsa::RsaPrivateKey::from_pkcs8_der(&key.material).or_else(|_| operation_error("not an RSA key"))?;
    let digest = hash.digest(data);
    let signed = with_digest!(hash, D => if p.alg == Alg::RsaPss {
        private.sign_with_rng(&mut rand_core::OsRng, rsa::Pss::new_with_salt::<D>(p.salt_length.unwrap_or(0) as usize), &digest)
    } else {
        private.sign(rsa::Pkcs1v15Sign::new::<D>(), &digest)
    });
    signed.or_else(|_| operation_error("the RSA signature could not be made"))
}

fn rsa_verify(p: &Params, key: &Key, signature: &[u8], data: &[u8]) -> Outcome<bool> {
    if key.kind != Kind::Public {
        return fail("InvalidAccessError", "only a public key verifies");
    }
    let hash = key.hash.unwrap_or(Hash::Sha256);
    let public = rsa_public_key(&key.material).map_or_else(|| operation_error("not an RSA key"), Ok)?;
    let digest = hash.digest(data);
    Ok(with_digest!(hash, D => if p.alg == Alg::RsaPss {
        public.verify(rsa::Pss::new_with_salt::<D>(p.salt_length.unwrap_or(0) as usize), &digest, signature)
    } else {
        public.verify(rsa::Pkcs1v15Sign::new::<D>(), &digest, signature)
    })
    .is_ok())
}

// MGF1 (RFC 8017 B.2.1) over `hash`: `len` bytes from `seed`.
fn mgf1(hash: Hash, seed: &[u8], len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    let mut counter = 0u32;
    while out.len() < len {
        out.extend(hash.digest(&[seed, &counter.to_be_bytes()].concat()));
        counter += 1;
    }
    out.truncate(len);
    out
}
// RSAES-OAEP (RFC 8017 §7.1), its label any bytes.
fn rsa_oaep_encrypt(p: &Params, key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    if key.kind != Kind::Public {
        return fail("InvalidAccessError", "only a public key encrypts");
    }
    let hash = key.hash.unwrap_or(Hash::Sha1);
    let public = rsa_public_key(&key.material).map_or_else(|| operation_error("not an RSA key"), Ok)?;
    let (k, h_len) = (public.size(), hash.digest(b"").len());
    if k < 2 * h_len + 2 || data.len() > k - 2 * h_len - 2 {
        return operation_error("the plaintext is too long for the key");
    }
    let mut db = hash.digest(p.label.as_deref().unwrap_or_default());
    db.resize(k - h_len - 1 - data.len() - 1, 0);
    db.push(1);
    db.extend_from_slice(data);
    let seed = random_bytes(h_len);
    xor_into(&mut db, &mgf1(hash, &seed, k - h_len - 1));
    let mut masked_seed = seed;
    xor_into(&mut masked_seed, &mgf1(hash, &db, h_len));
    let em = [&[0u8][..], &masked_seed, &db].concat();
    let c = rsa::hazmat::rsa_encrypt(&public, &rsa::BigUint::from_bytes_be(&em)).or_else(|_| operation_error("the RSA encryption failed"))?;
    Ok(left_pad(c.to_bytes_be(), k))
}
fn rsa_oaep_decrypt(p: &Params, key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    if key.kind != Kind::Private {
        return fail("InvalidAccessError", "only a private key decrypts");
    }
    let hash = key.hash.unwrap_or(Hash::Sha1);
    let private = rsa::RsaPrivateKey::from_pkcs8_der(&key.material).or_else(|_| operation_error("not an RSA key"))?;
    let (k, h_len) = (private.size(), hash.digest(b"").len());
    fn failed<T>() -> Outcome<T> {
        operation_error("the RSA decryption failed")
    }
    if data.len() != k || k < 2 * h_len + 2 {
        return failed();
    }
    let c = rsa::BigUint::from_bytes_be(data);
    if &c >= private.n() {
        return failed();
    }
    let m = rsa::hazmat::rsa_decrypt_and_check(&private, Some(&mut rand_core::OsRng), &c).or_else(|_| failed())?;
    let em = left_pad(m.to_bytes_be(), k);
    let (masked_seed, masked_db) = em[1..].split_at(h_len);
    let mut seed = masked_seed.to_vec();
    xor_into(&mut seed, &mgf1(hash, masked_db, h_len));
    let mut db = masked_db.to_vec();
    xor_into(&mut db, &mgf1(hash, &seed, k - h_len - 1));
    let label_hash = hash.digest(p.label.as_deref().unwrap_or_default());
    let rest = &db[h_len..];
    let one = rest.iter().position(|&b| b != 0);
    if em[0] != 0 || !constant_time_eq(&db[..h_len], &label_hash) || one.is_none_or(|i| rest[i] != 1) {
        return failed();
    }
    Ok(rest[one.unwrap_or(0) + 1..].to_vec())
}
fn left_pad(bytes: Vec<u8>, len: usize) -> Vec<u8> {
    if bytes.len() >= len { bytes } else { [vec![0u8; len - bytes.len()], bytes].concat() }
}

// ── the NIST curves (ECDSA, ECDH) ──

// The usages an EC key of each type may have.
fn ec_usages(alg: Alg) -> (Usages, Usages) {
    if alg == Alg::Ecdh { (Usages::NONE, Usages::DERIVE) } else { (Usages::VERIFY, Usages::SIGN) }
}
// A public key (SEC 1 §2.3.4, compressed or not) on `curve`, as its uncompressed point — None for no point on it, and
// for the "compact" form (0x05) SEC 1 does not define, which the curves' decoder would take.
fn ec_point(curve: Curve, sec1: &[u8]) -> Option<Vec<u8>> {
    if !matches!(sec1.first(), Some(2..=4)) {
        return None;
    }
    on_curve!(curve, m => {
        use m::elliptic_curve::sec1::ToEncodedPoint as _;
        m::PublicKey::from_sec1_bytes(sec1).ok().map(|k| k.to_encoded_point(false).as_bytes().to_vec())
    })
}
// A private key's scalar (`field_len` bytes) and its public point (uncompressed) — None for no scalar of the curve.
fn ec_secret(curve: Curve, scalar: &[u8]) -> Option<Vec<u8>> {
    on_curve!(curve, m => {
        use m::elliptic_curve::sec1::ToEncodedPoint as _;
        m::SecretKey::from_slice(scalar).ok().map(|k| k.public_key().to_encoded_point(false).as_bytes().to_vec())
    })
}
// The public point of an EC key: its own, or its private scalar's.
fn ec_public_point(key: &Key) -> Outcome<Vec<u8>> {
    let curve = key.curve()?;
    let point = if key.kind == Kind::Private { ec_secret(curve, &key.material) } else { Some(key.material.clone()) };
    point.map_or_else(|| data_error("not a key of the curve"), Ok)
}

fn ec_import(alg: Alg, format: &str, data: KeyData, p: &Params, extractable: bool, usages: Usages) -> Outcome<Key> {
    let (public_usages, private_usages) = ec_usages(alg);
    let requested = p.named_curve.as_deref().unwrap_or_default();
    let (kind, curve, material) = match (format, data) {
        ("spki", KeyData::Bytes(der)) => {
            allow(usages, public_usages)?;
            let curve = Curve::named(requested).map_or_else(|| data_error("not a curve of this key"), Ok)?;
            // (…its point checked as a raw one is, after the structure the curve's parse checks)
            let sec1 = spki::SubjectPublicKeyInfoRef::try_from(der.as_slice()).ok().and_then(|i| i.subject_public_key.as_bytes().map(<[u8]>::to_vec));
            let parsed = on_curve!(curve, m => m::PublicKey::from_public_key_der(&der).is_ok());
            let point = sec1.filter(|_| parsed).and_then(|p| ec_point(curve, &p));
            (Kind::Public, curve, point.map_or_else(|| data_error("not an EC SubjectPublicKeyInfo of the curve"), Ok)?)
        }
        ("pkcs8", KeyData::Bytes(der)) => {
            allow(usages, private_usages)?;
            let curve = Curve::named(requested).map_or_else(|| data_error("not a curve of this key"), Ok)?;
            let scalar = on_curve!(curve, m => m::SecretKey::from_pkcs8_der(&der).ok().map(|k| k.to_bytes().to_vec()));
            (Kind::Private, curve, scalar.map_or_else(|| data_error("not an EC PrivateKeyInfo of the curve"), Ok)?)
        }
        ("raw", KeyData::Bytes(bytes)) => {
            allow(usages, public_usages)?;
            let curve = Curve::named(requested).map_or_else(|| fail("NotSupportedError", "not a supported curve"), Ok)?;
            (Kind::Public, curve, ec_point(curve, &bytes).map_or_else(|| data_error("not a point of the curve"), Ok)?)
        }
        ("jwk", KeyData::Jwk(jwk)) => {
            allow(usages, if jwk.d.is_some() { private_usages } else { public_usages })?;
            if jwk.kty.as_deref() != Some("EC") {
                return data_error("an EC JWK's kty is EC");
            }
            check_jwk(&jwk, usages, extractable, if alg == Alg::Ecdh { "enc" } else { "sig" })?;
            if jwk.crv.as_deref() != Some(requested) {
                return data_error("the JWK's curve is not the one asked for");
            }
            let curve = Curve::named(requested).map_or_else(|| fail("NotSupportedError", "not a supported curve"), Ok)?;
            if alg == Alg::Ecdsa {
                let named = match jwk.alg.as_deref() {
                    Some("ES256") => Some(Curve::P256),
                    Some("ES384") => Some(Curve::P384),
                    Some("ES512") => Some(Curve::P521),
                    _ => None,
                };
                if named.is_some_and(|c| c != curve) {
                    return data_error("the JWK's alg is not the key's curve");
                }
            }
            let (x, y) = (Jwk::bytes(&jwk.x)?, Jwk::bytes(&jwk.y)?);
            if x.len() != curve.field_len() || y.len() != curve.field_len() {
                return data_error("a JWK coordinate is not the curve's length");
            }
            let point = ec_point(curve, &[&[4u8][..], &x, &y].concat()).map_or_else(|| data_error("not a point of the curve"), Ok)?;
            match &jwk.d {
                None => (Kind::Public, curve, point),
                Some(_) => {
                    let d = Jwk::bytes(&jwk.d)?;
                    if d.len() != curve.field_len() || ec_secret(curve, &d).as_ref() != Some(&point) {
                        return data_error("the JWK's d is not the point's");
                    }
                    (Kind::Private, curve, d)
                }
            }
        }
        (other, _) => return fail("NotSupportedError", format!("an EC key cannot be imported as {other}")),
    };
    Ok(Key { curve: Some(curve), ..Key::new(kind, alg, material) })
}

fn ec_export(format: &str, key: &Key) -> Outcome<Exported> {
    let curve = key.curve()?;
    match format {
        "spki" | "raw" if key.kind == Kind::Public => {
            if format == "raw" {
                return Ok(Exported::Bytes(key.material.clone()));
            }
            let der = on_curve!(curve, m => m::PublicKey::from_sec1_bytes(&key.material).ok().map(|k| spki_der(&k)));
            der.map_or_else(|| data_error("not a key of the curve"), |d| d.map(Exported::Bytes))
        }
        "pkcs8" if key.kind == Kind::Private => {
            let der = on_curve!(curve, m => m::SecretKey::from_slice(&key.material).ok().map(|k| pkcs8_der(&k)));
            der.map_or_else(|| data_error("not a key of the curve"), |d| d.map(Exported::Bytes))
        }
        "spki" | "raw" | "pkcs8" => fail("InvalidAccessError", format!("a {} key cannot be exported as {format}", key.kind.name())),
        "jwk" => {
            let point = ec_public_point(key)?;
            let n = curve.field_len();
            Ok(Exported::Jwk(Jwk {
                crv: Some(curve.name().to_owned()),
                x: Some(base64url_encode(&point[1..1 + n])),
                y: Some(base64url_encode(&point[1 + n..])),
                d: (key.kind == Kind::Private).then(|| base64url_encode(&key.material)),
                ..Jwk::of(key, "EC")
            }))
        }
        _ => fail("NotSupportedError", format!("an EC key cannot be exported as {format}")),
    }
}

fn ec_generate(p: &Params, usages: Usages) -> Outcome<Generated> {
    let (public_usages, private_usages) = ec_usages(p.alg);
    allow(usages, public_usages | private_usages)?;
    let curve = p.named_curve.as_deref().and_then(Curve::named).map_or_else(|| fail("NotSupportedError", "not a supported curve"), Ok)?;
    let scalar = on_curve!(curve, m => m::SecretKey::random(&mut rand_core::OsRng).to_bytes().to_vec());
    let point = ec_secret(curve, &scalar).map_or_else(|| operation_error("the key could not be generated"), Ok)?;
    let public = Key { curve: Some(curve), extractable: true, usages: usages & public_usages, ..Key::new(Kind::Public, p.alg, point) };
    let private = Key { curve: Some(curve), usages: usages & private_usages, ..Key::new(Kind::Private, p.alg, scalar) };
    Ok(Generated::Pair(public, private))
}

// The digest ECDSA signs, as a field element's bytes: a shorter one padded on the left (the integer it is), a longer one
// left to the curve's truncation.
fn ecdsa_prehash(curve: Curve, p: &Params, data: &[u8]) -> Outcome<Vec<u8>> {
    Ok(left_pad(p.hash()?.digest(data), curve.field_len()))
}
fn ecdsa_sign(p: &Params, key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    if key.kind != Kind::Private {
        return fail("InvalidAccessError", "only a private key signs");
    }
    let curve = key.curve()?;
    let prehash = ecdsa_prehash(curve, p, data)?;
    let signed = on_curve!(curve, m => {
        use m::ecdsa::signature::hazmat::PrehashSigner as _;
        m::ecdsa::SigningKey::from_slice(&key.material).ok().and_then(|k| {
            let s: Result<m::ecdsa::Signature, _> = k.sign_prehash(&prehash);
            s.ok().map(|s| s.to_bytes().to_vec())
        })
    });
    signed.map_or_else(|| operation_error("the ECDSA signature could not be made"), Ok)
}
fn ecdsa_verify(p: &Params, key: &Key, signature: &[u8], data: &[u8]) -> Outcome<bool> {
    if key.kind != Kind::Public {
        return fail("InvalidAccessError", "only a public key verifies");
    }
    let curve = key.curve()?;
    let prehash = ecdsa_prehash(curve, p, data)?;
    Ok(on_curve!(curve, m => {
        use m::ecdsa::signature::hazmat::PrehashVerifier as _;
        match (m::ecdsa::VerifyingKey::from_sec1_bytes(&key.material), m::ecdsa::Signature::from_slice(signature)) {
            (Ok(k), Ok(s)) => k.verify_prehash(&prehash, &s).is_ok(),
            _ => false,
        }
    }))
}

// ECDH's and X25519's key agreement: the shared secret with the peer `public` — its key a public one of the same
// algorithm (and curve), an InvalidAccessError otherwise.
fn agree(p: &Params, key: &Key) -> Outcome<Vec<u8>> {
    let Some(peer) = p.public.as_deref() else { return fail("TypeError", "a public key is required") };
    if peer.kind != Kind::Public {
        return fail("InvalidAccessError", "the peer's key is not a public one");
    }
    if peer.alg != key.alg {
        return fail("InvalidAccessError", "the peer's key is not of the algorithm");
    }
    if key.alg == Alg::X25519 {
        let (Ok(secret), Ok(public)) = (<[u8; 32]>::try_from(key.material.as_slice()), <[u8; 32]>::try_from(peer.material.as_slice())) else {
            return operation_error("not an X25519 key");
        };
        let shared = x25519_dalek::StaticSecret::from(secret).diffie_hellman(&x25519_dalek::PublicKey::from(public));
        if shared.as_bytes().iter().all(|&b| b == 0) {
            return operation_error("the X25519 agreement is all zeros");
        }
        return Ok(shared.as_bytes().to_vec());
    }
    let curve = key.curve()?;
    if peer.curve != Some(curve) {
        return fail("InvalidAccessError", "the peer's key is on another curve");
    }
    let shared = on_curve!(curve, m => {
        match (m::SecretKey::from_slice(&key.material), m::PublicKey::from_sec1_bytes(&peer.material)) {
            (Ok(s), Ok(public)) => Some(m::ecdh::diffie_hellman(s.to_nonzero_scalar(), public.as_affine()).raw_secret_bytes().to_vec()),
            _ => None,
        }
    });
    shared.map_or_else(|| operation_error("the ECDH agreement failed"), Ok)
}

// ── Ed25519, X25519 ──

// The algorithm OIDs (RFC 8410), as their DER contents: id-Ed25519 1.3.101.112, id-X25519 1.3.101.110.
fn okp_oid(alg: Alg) -> spki::ObjectIdentifier {
    spki::ObjectIdentifier::new_unwrap(if alg == Alg::Ed25519 { "1.3.101.112" } else { "1.3.101.110" })
}
fn okp_usages(alg: Alg) -> (Usages, Usages) {
    if alg == Alg::Ed25519 { (Usages::VERIFY, Usages::SIGN) } else { (Usages::NONE, Usages::DERIVE) }
}
// The public key of a private one's 32 bytes.
fn okp_public(alg: Alg, private: &[u8; 32]) -> [u8; 32] {
    if alg == Alg::Ed25519 {
        ed25519_dalek::SigningKey::from_bytes(private).verifying_key().to_bytes()
    } else {
        x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(*private)).to_bytes()
    }
}
fn bytes32(bytes: &[u8]) -> Outcome<[u8; 32]> {
    bytes.try_into().or_else(|_| data_error("the key is not 32 bytes"))
}

fn okp_import(alg: Alg, format: &str, data: KeyData, extractable: bool, usages: Usages) -> Outcome<Key> {
    use der::{Decode as _, asn1::OctetStringRef};
    let (public_usages, private_usages) = okp_usages(alg);
    let (kind, material) = match (format, data) {
        ("spki", KeyData::Bytes(der)) => {
            allow(usages, public_usages)?;
            let info = spki::SubjectPublicKeyInfoRef::try_from(der.as_slice()).or_else(|_| data_error("not a SubjectPublicKeyInfo"))?;
            if info.algorithm.oid != okp_oid(alg) || info.algorithm.parameters.is_some() {
                return data_error("not a key of the algorithm");
            }
            let raw = info.subject_public_key.as_bytes().map_or_else(|| data_error("not a key of the algorithm"), Ok)?;
            (Kind::Public, bytes32(raw)?.to_vec())
        }
        ("pkcs8", KeyData::Bytes(der)) => {
            allow(usages, private_usages)?;
            let info = pkcs8::PrivateKeyInfo::try_from(der.as_slice()).or_else(|_| data_error("not a PrivateKeyInfo"))?;
            if info.algorithm.oid != okp_oid(alg) || info.algorithm.parameters.is_some() {
                return data_error("not a key of the algorithm");
            }
            let curve_private_key = OctetStringRef::from_der(info.private_key).or_else(|_| data_error("not a CurvePrivateKey"))?;
            (Kind::Private, bytes32(curve_private_key.as_bytes())?.to_vec())
        }
        ("raw", KeyData::Bytes(bytes)) => {
            allow(usages, public_usages)?;
            (Kind::Public, bytes32(&bytes)?.to_vec())
        }
        ("jwk", KeyData::Jwk(jwk)) => {
            allow(usages, if jwk.d.is_some() { private_usages } else { public_usages })?;
            if jwk.kty.as_deref() != Some("OKP") {
                return data_error("an OKP JWK's kty is OKP");
            }
            if jwk.crv.as_deref() != Some(alg.name()) {
                return data_error("the JWK's crv is not the algorithm");
            }
            if alg == Alg::Ed25519 && jwk.alg.as_deref().is_some_and(|a| a != "Ed25519" && a != "EdDSA") {
                return data_error("the JWK's alg is not Ed25519");
            }
            check_jwk(&jwk, usages, extractable, if alg == Alg::Ed25519 { "sig" } else { "enc" })?;
            let x = bytes32(&Jwk::bytes(&jwk.x)?)?;
            match &jwk.d {
                None => (Kind::Public, x.to_vec()),
                Some(_) => {
                    let d = bytes32(&Jwk::bytes(&jwk.d)?)?;
                    if okp_public(alg, &d) != x {
                        return data_error("the JWK's x is not its d's");
                    }
                    (Kind::Private, d.to_vec())
                }
            }
        }
        (other, _) => return fail("NotSupportedError", format!("an {} key cannot be imported as {other}", alg.name())),
    };
    Ok(Key::new(kind, alg, material))
}

fn okp_export(format: &str, key: &Key) -> Outcome<Exported> {
    use der::{Encode as _, asn1::OctetStringRef};
    let algorithm = spki::AlgorithmIdentifierRef { oid: okp_oid(key.alg), parameters: None };
    let encoded = |r: der::Result<Vec<u8>>| r.or_else(|_| data_error("the key cannot be encoded"));
    match format {
        "spki" | "raw" if key.kind == Kind::Public => {
            if format == "raw" {
                return Ok(Exported::Bytes(key.material.clone()));
            }
            let bits = der::asn1::BitStringRef::from_bytes(&key.material).or_else(|_| data_error("the key cannot be encoded"))?;
            encoded(spki::SubjectPublicKeyInfoRef { algorithm, subject_public_key: bits }.to_der()).map(Exported::Bytes)
        }
        "pkcs8" if key.kind == Kind::Private => {
            let inner = encoded(OctetStringRef::new(&key.material).and_then(|o| o.to_der()))?;
            encoded(pkcs8::PrivateKeyInfo::new(algorithm, &inner).to_der()).map(Exported::Bytes)
        }
        "spki" | "raw" | "pkcs8" => fail("InvalidAccessError", format!("a {} key cannot be exported as {format}", key.kind.name())),
        "jwk" => {
            let private: Option<[u8; 32]> = (key.kind == Kind::Private).then(|| bytes32(&key.material)).transpose()?;
            let x = private.map_or_else(|| key.material.clone(), |d| okp_public(key.alg, &d).to_vec());
            Ok(Exported::Jwk(Jwk {
                crv: Some(key.alg.name().to_owned()),
                x: Some(base64url_encode(&x)),
                d: private.map(|d| base64url_encode(&d)),
                alg: (key.alg == Alg::Ed25519).then(|| "Ed25519".to_owned()),
                ..Jwk::of(key, "OKP")
            }))
        }
        _ => fail("NotSupportedError", format!("an {} key cannot be exported as {format}", key.alg.name())),
    }
}

fn okp_generate(alg: Alg, usages: Usages) -> Outcome<Generated> {
    let (public_usages, private_usages) = okp_usages(alg);
    allow(usages, public_usages | private_usages)?;
    let private: [u8; 32] = random_bytes(32).try_into().unwrap();
    let public = Key { extractable: true, usages: usages & public_usages, ..Key::new(Kind::Public, alg, okp_public(alg, &private).to_vec()) };
    let private = Key { usages: usages & private_usages, ..Key::new(Kind::Private, alg, private.to_vec()) };
    Ok(Generated::Pair(public, private))
}

fn ed25519_sign(key: &Key, data: &[u8]) -> Outcome<Vec<u8>> {
    use ed25519_dalek::Signer as _;
    if key.kind != Kind::Private {
        return fail("InvalidAccessError", "only a private key signs");
    }
    let private = bytes32(&key.material).or_else(|_| operation_error("not an Ed25519 key"))?;
    Ok(ed25519_dalek::SigningKey::from_bytes(&private).sign(data).to_bytes().to_vec())
}
// RFC 8032's verification, strictly: a public key or an R of small order, an S out of range or a point not canonically
// encoded is no valid signature.
fn ed25519_verify(key: &Key, signature: &[u8], data: &[u8]) -> bool {
    let (Ok(public), Ok(signature)) = (<[u8; 32]>::try_from(key.material.as_slice()), <[u8; 64]>::try_from(signature)) else { return false };
    let Ok(public) = ed25519_dalek::VerifyingKey::from_bytes(&public) else { return false };
    key.kind == Kind::Public && public.verify_strict(data, &ed25519_dalek::Signature::from_bytes(&signature)).is_ok()
}

// ── HKDF, PBKDF2 ──

fn kdf_import(alg: Alg, format: &str, data: KeyData, extractable: bool, usages: Usages) -> Outcome<Key> {
    let KeyData::Bytes(bytes) = data else { return fail("NotSupportedError", format!("an {} key is imported raw", alg.name())) };
    if format != "raw" {
        return fail("NotSupportedError", format!("an {} key is imported raw", alg.name()));
    }
    allow(usages, Usages::DERIVE)?;
    if extractable {
        return fail("SyntaxError", format!("an {} key cannot be extractable", alg.name()));
    }
    Ok(Key::new(Kind::Secret, alg, bytes))
}

fn kdf_derive(p: &Params, key: &Key, length: Option<u32>) -> Outcome<Vec<u8>> {
    let Some(bits) = length.filter(|l| l % 8 == 0) else { return operation_error("the length is a whole number of bytes") };
    if p.alg == Alg::Pbkdf2 && p.iterations.unwrap_or(0) == 0 {
        return operation_error("PBKDF2 takes at least one iteration");
    }
    let mut out = vec![0u8; bits as usize / 8];
    if out.is_empty() {
        return Ok(out);
    }
    let salt = p.salt.as_deref().unwrap_or_default();
    with_digest!(p.hash()?, D => if p.alg == Alg::Hkdf {
        hkdf::Hkdf::<D>::new(Some(salt), &key.material)
            .expand(p.info.as_deref().unwrap_or_default(), &mut out)
            .or_else(|_| operation_error("HKDF cannot derive that many bits"))?;
    } else {
        pbkdf2::pbkdf2_hmac::<D>(&key.material, salt, p.iterations.unwrap_or(1), &mut out);
    });
    Ok(out)
}

// ── the ops ──

pub(crate) fn install(scope: &mut v8::PinScope<'_, '_>, ns: v8::Local<'_, v8::Object>, context_id: i32) {
    crate::dom::register(scope, ns, "cryptoRegistered", registered_op, context_id);
    crate::dom::register(scope, ns, "cryptoKeyInfo", key_info_op, context_id);
    crate::dom::register(scope, ns, "cryptoKeyRecord", key_record_op, context_id);
    crate::dom::register(scope, ns, "cryptoKeyFromRecord", key_from_record_op, context_id);
    crate::dom::register(scope, ns, "cryptoDigest", digest_op, context_id);
    crate::dom::register(scope, ns, "cryptoImportKey", import_op, context_id);
    crate::dom::register(scope, ns, "cryptoExportKey", export_op, context_id);
    crate::dom::register(scope, ns, "cryptoGenerateKey", generate_op, context_id);
    crate::dom::register(scope, ns, "cryptoSign", sign_op, context_id);
    crate::dom::register(scope, ns, "cryptoVerify", verify_op, context_id);
    crate::dom::register(scope, ns, "cryptoEncrypt", encrypt_op, context_id);
    crate::dom::register(scope, ns, "cryptoDecrypt", decrypt_op, context_id);
    crate::dom::register(scope, ns, "cryptoDeriveBits", derive_bits_op, context_id);
    crate::dom::register(scope, ns, "cryptoDeriveKey", derive_key_op, context_id);
    crate::dom::register(scope, ns, "cryptoWrapKey", wrap_op, context_id);
    crate::dom::register(scope, ns, "cryptoUnwrapBytes", unwrap_op, context_id);
    crate::dom::register(scope, ns, "cryptoRandomFill", random_fill_op, context_id);
    crate::dom::register(scope, ns, "cryptoRandomUUID", random_uuid_op, context_id);
    crate::dom::register(scope, ns, "base64UrlEncode", base64url_encode_op, context_id);
    crate::dom::register(scope, ns, "base64UrlDecode", base64url_decode_op, context_id);
}
// __dom.base64UrlEncode(source) -> a BufferSource's bytes as unpadded base64url — WebAuthn's wire form and a JSON
// serialization's.
fn base64url_encode_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let bytes = buffer_bytes(args.get(0)).unwrap_or_default();
    let out = string(scope, &base64url_encode(&bytes));
    rv.set(out);
}
// __dom.base64UrlDecode(text) -> its bytes in a fresh ArrayBuffer, or null for text that is no unpadded base64url
// (`base64url_decode`).
fn base64url_decode_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let text = args.get(0).to_rust_string_lossy(scope);
    match base64url_decode(&text) {
        Some(bytes) => rv.set(array_buffer(scope, bytes)),
        None => rv.set_null(),
    }
}

// A member of a dictionary the bindings made — its own, never one a page's `Object.prototype` holds (an
// `Object.prototype.public` read as every algorithm's ECDH public key refused them all) — none where it is undefined.
fn get<'s>(scope: &mut v8::PinScope<'s, '_>, object: v8::Local<'_, v8::Object>, name: &str) -> Option<v8::Local<'s, v8::Value>> {
    let key = v8::String::new(scope, name)?;
    if !object.has_own_property(scope, key.into())? {
        return None;
    }
    object.get(scope, key.into()).filter(|v| !v.is_undefined())
}
fn set(scope: &mut v8::PinScope<'_, '_>, object: v8::Local<'_, v8::Object>, name: &str, value: v8::Local<'_, v8::Value>) {
    if let Some(key) = v8::String::new(scope, name) {
        object.create_data_property(scope, key.into(), value);
    }
}
fn text(scope: &mut v8::PinScope<'_, '_>, value: Option<v8::Local<'_, v8::Value>>) -> Option<String> {
    value.map(|v| v.to_rust_string_lossy(scope))
}
fn string<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::Value> {
    v8::String::new(scope, s).map_or_else(|| v8::undefined(scope).into(), Into::into)
}
// A BufferSource's bytes (a detached one's none), or None for a value that is none.
pub(crate) fn buffer_bytes(value: v8::Local<'_, v8::Value>) -> Option<Vec<u8>> {
    if let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(value) {
        let mut bytes = vec![0u8; view.byte_length()];
        view.copy_contents(&mut bytes);
        return Some(bytes);
    }
    let buffer = v8::Local::<v8::ArrayBuffer>::try_from(value).ok()?;
    let store = buffer.get_backing_store();
    let bytes = match store.data() {
        // SAFETY: the buffer's own bytes, read while the op runs (no script runs meanwhile).
        Some(data) => unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, store.byte_length()) }.to_vec(),
        None => Vec::new(),
    };
    Some(bytes)
}
fn number(scope: &mut v8::PinScope<'_, '_>, value: Option<v8::Local<'_, v8::Value>>) -> Option<u32> {
    value.and_then(|v| v.number_value(scope)).map(|n| n as u32)
}
fn hash_of(scope: &mut v8::PinScope<'_, '_>, value: Option<v8::Local<'_, v8::Value>>) -> Option<Hash> {
    let object = v8::Local::<v8::Object>::try_from(value?).ok()?;
    let name = get(scope, object, "name");
    match Alg::named(&text(scope, name)?)? {
        Alg::Sha(hash) => Some(hash),
        _ => None,
    }
}
fn usages_of(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Usages {
    let Ok(list) = v8::Local::<v8::Array>::try_from(value) else { return Usages::NONE };
    let mut usages = Usages::NONE;
    for i in 0..list.length() {
        if let Some(u) = list.get_index(scope, i).map(|v| v.to_rust_string_lossy(scope)).and_then(|n| Usages::named(&n)) {
            usages |= u;
        }
    }
    usages
}
// A normalized algorithm, as the bindings made it (a CryptoKey member its key's slots).
fn params_of(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Outcome<Params> {
    let Ok(object) = v8::Local::<v8::Object>::try_from(value) else { return fail("TypeError", "not an algorithm") };
    let name = get(scope, object, "name");
    let alg = text(scope, name).and_then(|n| Alg::named(&n)).map_or_else(|| fail("NotSupportedError", "not a registered algorithm"), Ok)?;
    let mut p = Params::new(alg);
    p.hash = { let v = get(scope, object, "hash"); hash_of(scope, v) };
    p.length = { let v = get(scope, object, "length"); number(scope, v) };
    p.tag_length = { let v = get(scope, object, "tagLength"); number(scope, v) };
    p.iterations = { let v = get(scope, object, "iterations"); number(scope, v) };
    p.salt_length = { let v = get(scope, object, "saltLength"); number(scope, v) };
    p.modulus_length = { let v = get(scope, object, "modulusLength"); number(scope, v) };
    p.named_curve = { let v = get(scope, object, "namedCurve"); text(scope, v) };
    p.iv = get(scope, object, "iv").and_then(buffer_bytes);
    p.counter = get(scope, object, "counter").and_then(buffer_bytes);
    p.additional_data = get(scope, object, "additionalData").and_then(buffer_bytes);
    p.label = get(scope, object, "label").and_then(buffer_bytes);
    p.salt = get(scope, object, "salt").and_then(buffer_bytes);
    p.info = get(scope, object, "info").and_then(buffer_bytes);
    p.public_exponent = get(scope, object, "publicExponent").and_then(buffer_bytes);
    if let Some(public) = get(scope, object, "public") {
        p.public = Some(Box::new(key_of(scope, public)?.clone()));
    }
    Ok(p)
}
// ── A CryptoKey's state: the engine's, on a handle the key's object holds ──
// Its key — type, extractable, algorithm, usages and the keying material page script never sees — kept on V8's C++ heap
// as long as the object the bindings keep it by (`state`): what every operation reads (`key_of`), and what a key the
// engine makes is handed out as (`key_object`). The material leaves it only as a serialization's record
// (`cryptoKeyRecord`), for a structured clone or a message to another agent.
struct KeyHandle {
    key: Key,
}
unsafe impl v8::cppgc::GarbageCollected for KeyHandle {
    fn trace(&self, _visitor: &mut v8::cppgc::Visitor) {}
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"KeyHandle"
    }
}
// The wrapper tag `Object::wrap` / `unwrap` file the handle under (image_bitmaps.rs' 16).
const KEY_TAG: u16 = 17;
// What marks an object as a key state's (its internal field 0).
static KEY_BRAND: u8 = 0;

// A key's state object: a fresh wrapper of a handle owning `key`.
fn key_object<'s>(scope: &mut v8::PinScope<'s, '_>, key: Key) -> v8::Local<'s, v8::Value> {
    let kept = crate::dom::dom(scope).crypto_key_template.clone();
    let template = match kept {
        Some(t) => v8::Local::new(scope, t),
        None => {
            let t = v8::ObjectTemplate::new(scope);
            t.set_internal_field_count(1);
            let global = v8::Global::new(scope, t);
            crate::dom::dom(scope).crypto_key_template = Some(global);
            t
        }
    };
    let Some(obj) = template.new_instance(scope) else { return v8::undefined(scope).into() };
    let brand = v8::External::new(scope, std::ptr::addr_of!(KEY_BRAND) as *mut std::ffi::c_void);
    obj.set_internal_field(0, brand.into());
    let heap = scope.get_cpp_heap().expect("a CryptoKey is made only on an isolate with a C++ heap");
    // SAFETY: the handle is moved onto the cppgc heap and its pointer straight into the wrapper, which traces it.
    unsafe {
        let ptr = v8::cppgc::make_garbage_collected(heap, KeyHandle { key });
        v8::Object::wrap::<KEY_TAG, KeyHandle>(scope, obj, &ptr);
    }
    obj.into()
}
// The key a state object holds — lent for the operation, which the object outlives — or a TypeError for anything that is
// none (the brand first: `unwrap` reads garbage from an object it never wrapped).
fn key_of<'h>(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Outcome<&'h Key> {
    let not_a_key = || fail("TypeError", "not a CryptoKey");
    let Some(obj) = v8::Local::<v8::Object>::try_from(value).ok().filter(|o| o.internal_field_count() == 1) else { return not_a_key() };
    let brand = obj.get_internal_field(scope, 0).and_then(|f| v8::Local::<v8::Value>::try_from(f).ok());
    let branded = brand.and_then(|b| v8::Local::<v8::External>::try_from(b).ok()).is_some_and(|b| b.value() as *const u8 == std::ptr::addr_of!(KEY_BRAND));
    if !branded {
        return not_a_key();
    }
    // SAFETY: a branded object was made by `key_object`, which wrapped a KeyHandle under KEY_TAG; the handle lives while
    // its object, the argument, does — through this op.
    match unsafe { v8::Object::unwrap::<KEY_TAG, KeyHandle>(scope, obj) } {
        Some(ptr) => Ok(&unsafe { &*(ptr.as_ref() as *const KeyHandle) }.key),
        None => not_a_key(),
    }
}
// A key of the slots a serialization's record carries (`cryptoKeyRecord`'s, another agent's).
fn key_from_slots(scope: &mut v8::PinScope<'_, '_>, value: v8::Local<'_, v8::Value>) -> Outcome<Key> {
    let Ok(slots) = v8::Local::<v8::Object>::try_from(value) else { return fail("TypeError", "not a CryptoKey") };
    let kind = { let v = get(scope, slots, "type"); text(scope, v) }.and_then(|k| Kind::named(&k));
    let extractable = get(scope, slots, "extractable").is_some_and(|v| v.is_true());
    let algorithm = get(scope, slots, "algorithm").and_then(|v| v8::Local::<v8::Object>::try_from(v).ok());
    let usages = get(scope, slots, "usages").map_or(Usages::NONE, |v| usages_of(scope, v));
    let material = get(scope, slots, "material").and_then(buffer_bytes);
    let (Some(kind), Some(algorithm), Some(material)) = (kind, algorithm, material) else { return fail("TypeError", "not a CryptoKey") };
    let alg = { let v = get(scope, algorithm, "name"); text(scope, v) }.and_then(|n| Alg::named(&n));
    let Some(alg) = alg else { return fail("TypeError", "not a CryptoKey") };
    let hash = { let v = get(scope, algorithm, "hash"); hash_of(scope, v) };
    let length = { let v = get(scope, algorithm, "length"); number(scope, v) };
    let curve = { let v = get(scope, algorithm, "namedCurve"); text(scope, v) }.and_then(|c| Curve::named(&c));
    Ok(Key { kind, extractable, alg, hash, length, curve, usages, material })
}
// A JsonWebKey, as the bindings converted it.
fn jwk_of(scope: &mut v8::PinScope<'_, '_>, object: v8::Local<'_, v8::Object>) -> Jwk {
    let mut jwk = Jwk::default();
    for name in ["alg", "crv", "d", "dp", "dq", "e", "k", "kty", "n", "p", "q", "qi", "use", "x", "y"] {
        let value = get(scope, object, name);
        if let (Some(member), Some(v)) = (jwk.string_member_mut(name), text(scope, value)) {
            *member = Some(v);
        }
    }
    jwk.ext = get(scope, object, "ext").map(|v| v.is_true());
    jwk.key_ops = get(scope, object, "key_ops").and_then(|v| v8::Local::<v8::Array>::try_from(v).ok()).map(|list| {
        (0..list.length()).filter_map(|i| list.get_index(scope, i)).map(|v| v.to_rust_string_lossy(scope)).collect()
    });
    jwk
}
fn jwk_value<'s>(scope: &mut v8::PinScope<'s, '_>, jwk: &Jwk) -> v8::Local<'s, v8::Value> {
    let object = v8::Object::new(scope);
    for (name, value) in jwk.string_members() {
        if let Some(v) = value {
            let v = string(scope, v);
            set(scope, object, name, v);
        }
        if name == "e" {
            if let Some(ext) = jwk.ext {
                let v = v8::Boolean::new(scope, ext).into();
                set(scope, object, "ext", v);
            }
        }
        if name == "k" {
            if let Some(ops) = &jwk.key_ops {
                let items: Vec<v8::Local<v8::Value>> = ops.iter().map(|o| string(scope, o)).collect();
                let v = v8::Array::new_with_elements(scope, &items).into();
                set(scope, object, "key_ops", v);
            }
        }
    }
    object.into()
}
// A key's slots, as its serialization's record carries them — `material` included where `with_material` — or its
// attributes read them (type, extractable, the algorithm dictionary a key of it reports — each dictionary's members in
// their order, its inherited ones first — and usages).
fn key_slots<'s>(scope: &mut v8::PinScope<'s, '_>, key: &Key, with_material: bool) -> v8::Local<'s, v8::Object> {
    let algorithm = v8::Object::new(scope);
    let name = string(scope, key.alg.name());
    set(scope, algorithm, "name", name);
    if key.alg.is_rsa() {
        let (bits, exponent) = key.rsa_info().unwrap_or_default();
        let bits = v8::Number::new(scope, bits as f64).into();
        set(scope, algorithm, "modulusLength", bits);
        let exponent = crate::dom::u8_array(scope, exponent);
        set(scope, algorithm, "publicExponent", exponent);
    }
    if let Some(hash) = key.hash {
        let h = v8::Object::new(scope);
        let name = string(scope, hash.name());
        set(scope, h, "name", name);
        set(scope, algorithm, "hash", h.into());
    }
    if let Some(length) = key.length {
        let v = v8::Number::new(scope, length as f64).into();
        set(scope, algorithm, "length", v);
    }
    if let Some(curve) = key.curve {
        let v = string(scope, curve.name());
        set(scope, algorithm, "namedCurve", v);
    }
    let slots = v8::Object::new(scope);
    let kind = string(scope, key.kind.name());
    set(scope, slots, "type", kind);
    let extractable = v8::Boolean::new(scope, key.extractable).into();
    set(scope, slots, "extractable", extractable);
    set(scope, slots, "algorithm", algorithm.into());
    let usages: Vec<v8::Local<v8::Value>> = key.usages.names().map(|u| string(scope, u)).collect();
    let usages = v8::Array::new_with_elements(scope, &usages).into();
    set(scope, slots, "usages", usages);
    if with_material {
        let material = crate::dom::u8_array(scope, key.material.clone());
        set(scope, slots, "material", material);
    }
    slots
}
// __dom.cryptoKeyInfo(state) -> {type, extractable, algorithm, usages}: what the key's attributes read (`key_slots`).
fn key_info_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let outcome = key_of(scope, args.get(0));
    answer(scope, &mut rv, outcome, |scope, key| key_slots(scope, key, false).into());
}
// __dom.cryptoKeyRecord(state) -> the key's slots, its material among them: its serialization's record.
fn key_record_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let outcome = key_of(scope, args.get(0));
    answer(scope, &mut rv, outcome, |scope, key| key_slots(scope, key, true).into());
}
// __dom.cryptoKeyFromRecord(slots) -> the state of the key a serialization's record describes.
fn key_from_record_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let outcome = key_from_slots(scope, args.get(0));
    answer(scope, &mut rv, outcome, key_object);
}
pub(crate) fn array_buffer<'s>(scope: &mut v8::PinScope<'s, '_>, bytes: Vec<u8>) -> v8::Local<'s, v8::Value> {
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    v8::ArrayBuffer::with_backing_store(scope, &store).into()
}
fn throw(scope: &mut v8::PinScope<'_, '_>, failure: Failure) {
    let Some(message) = v8::String::new(scope, &failure.message) else { return };
    if failure.name == "TypeError" {
        let e = v8::Exception::type_error(scope, message);
        scope.throw_exception(e);
    } else {
        crate::clone::throw_dom_exception(scope, message, failure.name);
    }
}
// An op's outcome, set as what it returns or thrown.
fn answer<'s, T>(scope: &mut v8::PinScope<'s, '_>, rv: &mut v8::ReturnValue<'_, v8::Value>, outcome: Outcome<T>, value: impl FnOnce(&mut v8::PinScope<'s, '_>, T) -> v8::Local<'s, v8::Value>) {
    match outcome {
        Ok(v) => {
            let v = value(scope, v);
            rv.set(v);
        }
        Err(f) => throw(scope, f),
    }
}

// __dom.cryptoRegistered(op, name) -> [canonical name, dictionary type] of `registered`, or null.
fn registered_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (op, name) = (args.get(0).to_rust_string_lossy(scope), args.get(1).to_rust_string_lossy(scope));
    match registered(&op, &name) {
        Some((alg, dictionary)) => {
            let items = [string(scope, alg.name()), string(scope, dictionary)];
            rv.set(v8::Array::new_with_elements(scope, &items).into());
        }
        None => rv.set_null(),
    }
}
// __dom.cryptoDigest(algorithm, data) -> ArrayBuffer.
fn digest_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let data = buffer_bytes(args.get(1)).unwrap_or_default();
    let outcome = params_of(scope, args.get(0)).and_then(|p| digest(&p, &data));
    answer(scope, &mut rv, outcome, array_buffer);
}
// __dom.cryptoImportKey(format, keyData, algorithm, extractable, usages) -> a key's state: `keyData` a BufferSource's copy or
// a converted JsonWebKey.
fn import_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let format = args.get(0).to_rust_string_lossy(scope);
    let data = match buffer_bytes(args.get(1)) {
        Some(bytes) => KeyData::Bytes(bytes),
        None => KeyData::Jwk(v8::Local::<v8::Object>::try_from(args.get(1)).map_or_else(|_| Jwk::default(), |o| jwk_of(scope, o))),
    };
    let (extractable, usages) = (args.get(3).is_true(), usages_of(scope, args.get(4)));
    let outcome = params_of(scope, args.get(2)).and_then(|p| import_key(&format, data, &p, extractable, usages));
    answer(scope, &mut rv, outcome, key_object);
}
// __dom.cryptoExportKey(format, key) -> ArrayBuffer, or a JWK object.
fn export_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let format = args.get(0).to_rust_string_lossy(scope);
    let outcome = key_of(scope, args.get(1)).and_then(|k| export_key(&format, k));
    answer(scope, &mut rv, outcome, |scope, exported| match exported {
        Exported::Bytes(b) => array_buffer(scope, b),
        Exported::Jwk(jwk) => jwk_value(scope, &jwk),
    });
}
// __dom.cryptoGenerateKey(algorithm, extractable, usages) -> a key's state, or [public, private] of them.
fn generate_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (extractable, usages) = (args.get(1).is_true(), usages_of(scope, args.get(2)));
    let outcome = params_of(scope, args.get(0)).and_then(|p| generate_key(&p, extractable, usages));
    answer(scope, &mut rv, outcome, |scope, made| match made {
        Generated::One(key) => key_object(scope, key),
        Generated::Pair(public, private) => {
            let pair = [key_object(scope, public), key_object(scope, private)];
            v8::Array::new_with_elements(scope, &pair).into()
        }
    });
}
// __dom.cryptoSign(algorithm, key, data) -> ArrayBuffer.
fn sign_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let data = buffer_bytes(args.get(2)).unwrap_or_default();
    let outcome = params_of(scope, args.get(0)).and_then(|p| key_of(scope, args.get(1)).and_then(|k| sign(&p, k, &data)));
    answer(scope, &mut rv, outcome, array_buffer);
}
// __dom.cryptoVerify(algorithm, key, signature, data) -> boolean.
fn verify_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (signature, data) = (buffer_bytes(args.get(2)).unwrap_or_default(), buffer_bytes(args.get(3)).unwrap_or_default());
    let outcome = params_of(scope, args.get(0)).and_then(|p| key_of(scope, args.get(1)).and_then(|k| verify(&p, k, &signature, &data)));
    answer(scope, &mut rv, outcome, |scope, ok| v8::Boolean::new(scope, ok).into());
}
// __dom.cryptoEncrypt / cryptoDecrypt(algorithm, key, data) -> ArrayBuffer.
fn encrypt_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let data = buffer_bytes(args.get(2)).unwrap_or_default();
    let outcome = params_of(scope, args.get(0)).and_then(|p| key_of(scope, args.get(1)).and_then(|k| encrypt(&p, k, &data)));
    answer(scope, &mut rv, outcome, array_buffer);
}
fn decrypt_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let data = buffer_bytes(args.get(2)).unwrap_or_default();
    let outcome = params_of(scope, args.get(0)).and_then(|p| key_of(scope, args.get(1)).and_then(|k| decrypt(&p, k, &data)));
    answer(scope, &mut rv, outcome, array_buffer);
}
// __dom.cryptoDeriveBits(algorithm, key, length | null) -> ArrayBuffer.
fn derive_bits_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let length = (!args.get(2).is_null_or_undefined()).then(|| number(scope, Some(args.get(2)))).flatten();
    let outcome = params_of(scope, args.get(0)).and_then(|p| key_of(scope, args.get(1)).and_then(|k| derive_bits(&p, k, length)));
    answer(scope, &mut rv, outcome, array_buffer);
}
// __dom.cryptoDeriveKey(algorithm, base key, import algorithm, length algorithm, extractable, usages) -> a key's state.
fn derive_key_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let (extractable, usages) = (args.get(4).is_true(), usages_of(scope, args.get(5)));
    let outcome = (|| {
        let (p, key) = (params_of(scope, args.get(0))?, key_of(scope, args.get(1))?);
        let (import, length) = (params_of(scope, args.get(2))?, params_of(scope, args.get(3))?);
        derive_key(&p, key, &import, &length, extractable, usages)
    })();
    answer(scope, &mut rv, outcome, key_object);
}
// __dom.cryptoWrapKey(format, key, wrapping key, algorithm) -> ArrayBuffer.
fn wrap_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let format = args.get(0).to_rust_string_lossy(scope);
    let outcome = (|| {
        let (key, wrapping, p) = (key_of(scope, args.get(1))?, key_of(scope, args.get(2))?, params_of(scope, args.get(3))?);
        wrap_key(&format, key, wrapping, &p)
    })();
    answer(scope, &mut rv, outcome, array_buffer);
}
// __dom.cryptoUnwrapBytes(algorithm, unwrapping key, wrapped) -> Uint8Array: what the key is imported from.
fn unwrap_op(scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let wrapped = buffer_bytes(args.get(2)).unwrap_or_default();
    let outcome = params_of(scope, args.get(0)).and_then(|p| key_of(scope, args.get(1)).and_then(|k| unwrap_bytes(&p, k, &wrapped)));
    answer(scope, &mut rv, outcome, crate::dom::u8_array);
}
// __dom.cryptoRandomFill(view): `view`'s bytes random (getRandomValues, its checks the bindings').
fn random_fill_op(_scope: &mut v8::PinScope<'_, '_>, args: v8::FunctionCallbackArguments<'_>, _rv: v8::ReturnValue<'_, v8::Value>) {
    let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(args.get(0)) else { return };
    let (ptr, n) = (view.data() as *mut u8, view.byte_length());
    if n != 0 && !ptr.is_null() {
        // SAFETY: the view's own bytes, written while the op runs.
        rand_core::OsRng.fill_bytes(unsafe { std::slice::from_raw_parts_mut(ptr, n) });
    }
}
// __dom.cryptoRandomUUID() -> a version 4 UUID (RFC 9562 §5.4), lowercase.
fn random_uuid_op(scope: &mut v8::PinScope<'_, '_>, _args: v8::FunctionCallbackArguments<'_>, mut rv: v8::ReturnValue<'_, v8::Value>) {
    let mut b = random_bytes(16);
    b[6] = b[6] & 0x0f | 0x40;
    b[8] = b[8] & 0x3f | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let uuid = format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]);
    rv.set(string(scope, &uuid));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
    fn secret(alg: Alg, material: Vec<u8>, usages: Usages) -> Key {
        Key { usages, extractable: true, length: Some(material.len() as u32 * 8), ..Key::new(Kind::Secret, alg, material) }
    }

    #[test]
    fn base64url_round_trips() {
        for n in 0..10 {
            let bytes: Vec<u8> = (0..n as u8).map(|b| b.wrapping_mul(37)).collect();
            assert_eq!(base64url_decode(&base64url_encode(&bytes)).unwrap(), bytes);
        }
        assert_eq!(base64url_encode(b"\xfb\xff"), "-_8");
        assert!(base64url_decode("a").is_none());
        assert!(base64url_decode("-_8=").is_none());
    }

    #[test]
    fn aes_modes_match_their_vectors() {
        // NIST SP 800-38A F.2.1 (CBC-AES128), F.5.1 (CTR-AES128); the GCM spec's test case 4 (AES-128, 60-byte P).
        let key = hex("2b7e151628aed2a6abf7158809cf4f3c");
        let mut p = Params::new(Alg::AesCbc);
        p.iv = Some(hex("000102030405060708090a0b0c0d0e0f"));
        let cbc = secret(Alg::AesCbc, key.clone(), Usages::ENCRYPT | Usages::DECRYPT);
        let out = encrypt(&p, &cbc, &hex("6bc1bee22e409f96e93d7e117393172a")).unwrap();
        assert_eq!(&out[..16], &hex("7649abac8119b246cee98e9b12e9197d")[..]);
        assert_eq!(decrypt(&p, &cbc, &out).unwrap(), hex("6bc1bee22e409f96e93d7e117393172a"));
        let mut p = Params::new(Alg::AesCtr);
        p.counter = Some(hex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff"));
        p.length = Some(128);
        let ctr = secret(Alg::AesCtr, key, Usages::ENCRYPT);
        let out = encrypt(&p, &ctr, &hex("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51")).unwrap();
        assert_eq!(out, hex("874d6191b620e3261bef6864990db6ce9806f66b7970fdff8617187bb9fffdff"));
        let gcm_key = secret(Alg::AesGcm, hex("feffe9928665731c6d6a8f9467308308"), Usages::ENCRYPT | Usages::DECRYPT);
        let mut p = Params::new(Alg::AesGcm);
        p.iv = Some(hex("cafebabefacedbaddecaf888"));
        p.additional_data = Some(hex("feedfacedeadbeeffeedfacedeadbeefabaddad2"));
        let plain = hex("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39");
        let out = encrypt(&p, &gcm_key, &plain).unwrap();
        assert_eq!(&out[out.len() - 16..], &hex("5bc94fbc3221a5db94fae95ae7121a47")[..]);
        assert_eq!(decrypt(&p, &gcm_key, &out).unwrap(), plain);
        p.tag_length = Some(32);
        let short = encrypt(&p, &gcm_key, &plain).unwrap();
        assert_eq!(&short[short.len() - 4..], &hex("5bc94fbc")[..]);
        let mut bad = short.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert_eq!(decrypt(&p, &gcm_key, &bad).unwrap_err().name, "OperationError");
    }

    #[test]
    fn aes_kw_matches_rfc_3394() {
        let kek = secret(Alg::AesKw, hex("000102030405060708090a0b0c0d0e0f"), Usages::WRAP_KEY | Usages::UNWRAP_KEY);
        let wrapped = aes_kw_wrap(&kek, &hex("00112233445566778899aabbccddeeff")).unwrap();
        assert_eq!(wrapped, hex("1fa68b0a8112b447aef34bd8fb5a7b829d3e862371d2cfe5"));
        assert_eq!(aes_kw_unwrap(&kek, &wrapped).unwrap(), hex("00112233445566778899aabbccddeeff"));
        let mut bad = wrapped;
        bad[0] ^= 1;
        assert!(aes_kw_unwrap(&kek, &bad).is_err());
    }

    #[test]
    fn rsa_oaep_round_trips_with_any_label() {
        let mut p = Params::new(Alg::RsaOaep);
        p.hash = Some(Hash::Sha256);
        p.modulus_length = Some(1024);
        p.public_exponent = Some(vec![1, 0, 1]);
        let Generated::Pair(public, private) = generate_key(&p, true, Usages::ENCRYPT | Usages::DECRYPT).unwrap() else { panic!() };
        p.label = Some(vec![0xff, 0x00, 0xfe]);
        let c = encrypt(&p, &public, b"hello").unwrap();
        assert_eq!(decrypt(&p, &private, &c).unwrap(), b"hello");
        p.label = Some(vec![0xff]);
        assert!(decrypt(&p, &private, &c).is_err());
    }

    #[test]
    fn rsa_keys_are_their_size_and_sign() {
        let t = std::time::Instant::now();
        for bits in [512, 1024, 2048] {
            let key = rsa_private_key(bits, &rsa::BigUint::from(65537u32)).unwrap();
            assert_eq!(key.n().bits(), bits);
            key.validate().unwrap();
        }
        eprintln!("three keys in {:?}", t.elapsed());
        assert!(rsa_private_key(512, &rsa::BigUint::from(4u32)).is_none());
    }

    #[test]
    fn imports_check_their_usages_before_their_data() {
        let mut p = Params::new(Alg::Hmac);
        p.hash = Some(Hash::Sha256);
        let bad = import_key("raw", KeyData::Bytes(vec![]), &p, true, Usages::ENCRYPT).unwrap_err();
        assert_eq!(bad.name, "SyntaxError");
        assert_eq!(import_key("raw", KeyData::Bytes(vec![]), &p, true, Usages::SIGN).unwrap_err().name, "DataError");
        assert_eq!(import_key("raw", KeyData::Bytes(vec![1]), &p, true, Usages::NONE).unwrap_err().name, "SyntaxError");
        let jwk = Jwk { kty: Some("oct".into()), k: Some("AQ".into()), key_ops: Some(vec!["verify".into()]), ..Jwk::default() };
        assert_eq!(import_key("jwk", KeyData::Jwk(jwk), &p, true, Usages::SIGN).unwrap_err().name, "DataError");
    }

    #[test]
    fn ec_imports_a_compressed_point() {
        let mut p = Params::new(Alg::Ecdsa);
        p.named_curve = Some("P-256".into());
        let Generated::Pair(public, _) = generate_key(&{ let mut g = p.clone(); g.named_curve = Some("P-256".into()); g }, true, Usages::SIGN).unwrap() else { panic!() };
        let point = &public.material;
        let compressed = [&[2 + (point[64] & 1)][..], &point[1..33]].concat();
        let imported = import_key("raw", KeyData::Bytes(compressed), &p, true, Usages::VERIFY).unwrap();
        assert_eq!(&imported.material, point);
        let compact = [&[5u8][..], &point[1..33]].concat();
        assert_eq!(import_key("raw", KeyData::Bytes(compact), &p, true, Usages::VERIFY).unwrap_err().name, "DataError");
    }

    #[test]
    fn rsa_public_keys_up_to_16384_bits() {
        let big = |bits: usize| rsa::BigUint::from_bytes_be(&[&[0xc0u8][..], &vec![0u8; bits / 8 - 2], &[1u8][..]].concat());
        assert!(rsa_public_from(big(8192), rsa::BigUint::from(65537u32)).is_some());
        assert!(rsa_public_from(big(16392), rsa::BigUint::from(65537u32)).is_none());
        assert!(rsa_public_from(big(2048), rsa::BigUint::from(1u64 << 40 | 1)).is_some());
        assert!(rsa_public_from(big(2048), rsa::BigUint::from(4u32)).is_none());
    }
}
