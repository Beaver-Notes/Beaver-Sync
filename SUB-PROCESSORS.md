# Sub-processors

This document lists the third-party services that process data on behalf of Beaver Sync, in accordance with our [Privacy Policy](/#/Privacy) and [Data Processing Agreement](DPA.md).

## Active Sub-processors

| Sub-processor | Purpose | Data Processed | Location | Privacy Policy |
|---------------|---------|----------------|----------|----------------|
| [Cloudflare R2](https://www.cloudflare.com/) | Object storage for encrypted note blobs, snapshots, and assets | Encrypted note content (E2E encrypted, server cannot decrypt) | Multiple global regions | [Cloudflare Privacy Policy](https://www.cloudflare.com/privacypolicy/) |
| [Stripe](https://stripe.com/) | Payment processing for subscriptions | Customer ID, subscription ID, transaction metadata | USA | [Stripe Privacy Policy](https://stripe.com/privacy) |
| [Resend](https://resend.com/) | Transactional email delivery (account verification, password resets) | Email address (via encrypted alias), email content | USA | [Resend Privacy Policy](https://resend.com/legal/privacy-policy) |
| [GlitchTip](https://glitchtip.com/) | Error monitoring and reporting | Error events (PII automatically stripped before submission) | Fly.io (EU) | N/A (self-hosted) |
| [Apple App Store](https://www.apple.com/) | In-app purchases and subscription management (iOS) | Transaction ID, subscription status | USA | [Apple Privacy Policy](https://www.apple.com/legal/privacy/en-ww/) |
| [Google Play](https://play.google.com/) | In-app purchases and subscription management (Android) | Purchase token, subscription status | USA | [Google Privacy Policy](https://policies.google.com/privacy) |

## Sub-processor Changes

We will notify users at least 30 days before adding or replacing any sub-processor. Notifications will be sent via email to the address associated with your account.

## Self-Hosted Instances

When you run your own Beaver Sync instance, you control which sub-processors are used. You can configure your own S3-compatible storage (MinIO, AWS S3, etc.) and email provider. The sub-processor list above applies only to the managed Beaver Sync service hosted on Fly.io at `api.beavernotes.com`.

## Contact

For questions about our sub-processors, contact:
[danielerolli@proton.me](mailto:danielerolli@proton.me)
