# Data Processing Agreement (DPA)

This DPA is part of the Terms of Service between Beaver and users of Beaver Sync. It governs how personal data is processed through the sync service.

## 1. Definitions

- Personal Data: any information relating to an identified or identifiable natural person.
- Processing: any operation performed on personal data, including collection, storage, use, and deletion.
- Controller: the natural person whose personal data is processed (the user).
- Processor: Beaver Sync, which processes personal data on behalf of the Controller.
- Sub-processor: a third party engaged by the Processor to process personal data.

## 2. Subject Matter and Duration

This DPA applies to all personal data processed through Beaver Sync. Processing continues for the duration of the user's account.

## 3. Nature and Purpose of Processing

Beaver Sync processes personal data for these purposes:

- Providing end-to-end encrypted note synchronization
- Managing user accounts and authentication
- Processing payments for subscription plans
- Sending transactional emails (account verification, password resets)
- Monitoring application errors (PII automatically stripped)

## 4. Types of Personal Data

| Category | Data Elements | Encryption |
|----------|---------------|------------|
| Account | Email address, username, password hash | ML-KEM-768 encrypted, bcrypt |
| Authentication | Session tokens, WebAuthn credentials, device labels | HMAC-hashed sessions, public keys |
| Technical | IP subnet (truncated /24), device fingerprint hash | Hashed/truncated |
| Payment | Stripe customer ID, subscription ID, Apple/Google transaction IDs | Payment provider managed |
| Content | Encrypted note blobs, snapshots, assets | AES-256-GCM / XChaCha20-Poly1305 (E2E) |
| Audit | Action types, encrypted metadata, IP subnet | ML-KEM-768 encrypted metadata |

## 5. Processing Instructions

The Processor agrees to:

- Process personal data only according to documented instructions from the Controller
- Process personal data solely for providing the sync service
- Not sell, share, or use personal data for advertising, profiling, or marketing
- Not process personal data for any purpose beyond those listed in this DPA
- Ensure that authorized personnel have committed to confidentiality

## 6. Sub-processors

The Processor uses the following sub-processors:

| Sub-processor | Purpose | Location | Privacy Policy |
|---------------|---------|----------|----------------|
| Cloudflare R2 | Object storage for encrypted blobs | Multiple regions | https://www.cloudflare.com/privacypolicy/ |
| Stripe | Payment processing | USA | https://stripe.com/privacy |
| Resend | Transactional email delivery | USA | https://resend.com/legal/privacy-policy |
| GlitchTip | Error monitoring (PII stripped) | Fly.io (EU) | N/A (self-hosted) |
| Apple App Store | In-app purchases (iOS) | USA | https://www.apple.com/legal/privacy/en-ww/ |
| Google Play | In-app purchases (Android) | USA | https://policies.google.com/privacy |

The Processor will notify the Controller of any sub-processor changes at least 30 days before they take effect.

## 7. International Transfers

Some sub-processors may process personal data outside the European Economic Area (EEA). When this happens, the Processor relies on:

- Standard Contractual Clauses (SCCs) approved by the European Commission
- End-to-end encryption, which protects data regardless of where it is stored
- The fact that note content is encrypted before leaving the Controller's device

## 8. Security Measures

Technical measures include end-to-end encryption (AES-256-GCM, XChaCha20-Poly1305), post-quantum ML-KEM-768 encryption for server-side metadata, Argon2id key derivation, bcrypt password hashing (cost factor 12), WebAuthn/FIDO2 passkey authentication, HMAC-hashed session tokens, rate limiting, account lockout, CSRF protection, and TLS for all data in transit.

Organizational measures include role-based access controls (owner/editor/viewer/guest), audit logging for enterprise accounts, security monitoring via GlitchTip, and regular dependency auditing.

## 9. Data Subject Rights

The Processor assists the Controller in fulfilling data subject rights:

| Right | Implementation |
|-------|---------------|
| Access (Art. 15) | Account settings page and data export feature |
| Rectification (Art. 16) | Username update via account settings |
| Erasure (Art. 17) | Account deletion via account settings (within 30 days) |
| Portability (Art. 20) | Data export as ZIP archive (7-day presigned URL) |
| Restriction (Art. 18) | Contact support |
| Object (Art. 21) | Account deletion |

## 10. Data Breach Notification

If a personal data breach occurs:

1. The Processor will notify the Controller without undue delay and no later than 72 hours after becoming aware of the breach
2. The notification will include the nature of the breach, categories and approximate number of data subjects affected, and measures taken or proposed to address the breach
3. The Processor will cooperate with the Controller in investigating and remedying the breach

## 11. Data Retention and Deletion

| Data Type | Retention Period |
|-----------|-----------------|
| Account data | While account is active plus 30 days after deletion |
| Sync data (Basic plan) | 30 days version history |
| Sync data (Pro/Team/Enterprise) | Unlimited version history |
| Session tokens | 24-hour TTL, 30-day maximum age |
| Audit logs (Enterprise) | 1 year |
| R2 object storage | Deleted within 30 days of account deletion |

Upon termination of the account, the Processor will delete all personal data within 30 days, except where retention is required by applicable law.

## 12. Data Protection Impact Assessment

The Processor cooperates with the Controller in conducting DPIAs where required under GDPR Article 35.

## 13. Audit Rights

The Controller may request audit information from the Processor to verify compliance with this DPA. The Processor will provide relevant information and cooperate with audits.

## 14. Liability

Each party will be liable for damages caused by processing that violates this DPA or applicable data protection law, in accordance with GDPR Article 82.

## 15. Termination

This DPA terminates automatically when the account or Terms of Service end. The Processor's obligations regarding data deletion survive termination as specified in Section 11.

## 16. Governing Law

This DPA is governed by the laws of Italy, consistent with the governing law of the Terms of Service.

## Contact

For questions about this DPA, contact:
[danielerolli@proton.me](mailto:danielerolli@proton.me)
