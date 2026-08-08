# Security Policy

## Reporting Security Issues

To report or disclose a potential security-related issue in a Beaver project, please email the details to [danielerolli@proton.me](mailto:danielerolli@proton.me). Please include the following information, as much as possible:

1. Name of the repository affected.
2. Summary of the issue and its potential impact.
3. Versions affected (optional).
4. Technical details and proof of concept (where applicable).
5. Known mitigations or workarounds.
6. Attribution information.

We will respond to valid security disclosures within 72 hours and provide security fixes on the affected GitHub repository.

## Security Measures

### Encryption

- All note content is encrypted client-side using AES-256-GCM and XChaCha20-Poly1305 before sync
- Server-side metadata encrypted with ML-KEM-768 (NIST post-quantum standard)
- Key derivation uses Argon2id (16 MiB, 2 iterations, 2 parallelism)
- Passwords hashed with bcrypt, cost factor 12
- Session tokens hashed with HMAC-SHA256 before storage, never stored in plaintext

### Authentication

- WebAuthn/FIDO2 passkeys supported as primary authentication method
- Session tokens have a 24-hour TTL and 30-day maximum age with sliding window renewal
- 10 failed login attempts trigger a 15-minute lockout
- Unknown accounts get dummy bcrypt comparisons to prevent timing-based enumeration

### Access Controls

- Workspace roles: owner, editor, viewer, guest
- Organization roles: owner, admin, member
- Admin routes require Team/Enterprise plan plus workspace ownership
- Vault key operations require owner role

### Network Security

- All API communication encrypted with TLS
- CORS restricted to configured allowed origins
- Content Security Policy headers enforced
- Per-endpoint configurable rate limits
- CSRF protection via Sec-Fetch-Site origin validation

### Data Protection

- Zero-knowledge architecture: server never sees plaintext note content
- Email addresses stored as HMAC-SHA256 hashes for lookups, ML-KEM encrypted for storage
- IP addresses truncated to /24 subnet
- Sentry/GlitchTip automatically strips PII from error reports
- Enterprise audit trails use encrypted metadata

### Infrastructure

- Docker containers run as unprivileged `beaver` user
- Reproducible builds with `--frozen-lockfile`
- All secrets validated at startup
- SQLite uses WAL mode for data integrity

## Vulnerability Disclosure Timeline

1. Report received: acknowledgment within 72 hours
2. Assessment: initial severity assessment within 7 days
3. Fix developed: security fix developed and tested
4. Disclosure: coordinated disclosure after fix is available

## Scope

This security policy covers:
- Beaver-Notes desktop application
- Beaver-Sync server application
- The Beaver Sync API service

Out of scope:
- Third-party services (Cloudflare, Stripe, etc.), refer to their respective security policies
- Issues requiring physical access to the user's device
