# Incident Response Plan

## 1. Purpose

This document describes how we identify, respond to, and recover from security incidents and personal data breaches affecting Beaver Notes and Beaver Sync.

## 2. Scope

This plan covers:

- Security incidents affecting Beaver infrastructure
- Personal data breaches involving user data
- Vulnerabilities discovered in Beaver software
- Unauthorized access attempts
- Data integrity incidents

## 3. Roles and Responsibilities

| Role | Responsibility |
|------|---------------|
| Incident Commander | Overall coordination, decision-making, external communication |
| Technical Lead | Investigation, containment, and remediation |
| Communication Lead | User notification, supervisory authority notification |

## 4. Incident Classification

### Severity Levels

| Level | Description | Response Time | Examples |
|-------|-------------|---------------|----------|
| Critical | Active breach of personal data, system compromise | Immediate | Data exfiltration, unauthorized admin access, encryption key compromise |
| High | Confirmed vulnerability with active exploitation risk | 24 hours | RCE vulnerability, SQL injection, auth bypass |
| Medium | Vulnerability with limited impact or exploitation difficulty | 72 hours | XSS, CSRF, information disclosure |
| Low | Minor security issue, no immediate risk | 1 week | Missing security headers, verbose error messages |

### Incident Types

- Data Breach: unauthorized access to, disclosure of, or loss of personal data
- Security Vulnerability: code or configuration flaw that could be exploited
- Unauthorized Access: attempted or successful access without authorization
- Data Integrity: unintended modification or deletion of data
- Availability: service disruption affecting user access

## 5. Response Procedures

### Phase 1: Detection and Assessment (0-24 hours)

1. Identify the incident via security reports ([danielerolli@proton.me](mailto:danielerolli@proton.me)), automated GlitchTip alerts, user reports, or vulnerability disclosures.
2. Assess severity: determine if personal data is affected, identify scope, assess exploitation risk, classify severity level.
3. Document initial findings: record date/time of detection, assign incident ID.

### Phase 2: Containment (0-48 hours)

Short-term: revoke compromised credentials, block malicious IPs if applicable, enable additional logging, isolate affected systems.

Long-term: deploy emergency patches, rotate encryption keys if compromised, update access controls, implement additional monitoring.

### Phase 3: Investigation (1-7 days)

1. Root cause analysis: identify how the incident occurred, determine what data was affected, assess the scope of compromise, document timeline of events.
2. Evidence preservation: preserve logs and forensic data, document all findings, maintain chain of custody.

### Phase 4: Notification (Within 72 hours of breach)

#### Supervisory Authority Notification (GDPR Art. 33)

If the breach is likely to result in a risk to individuals' rights and freedoms, notify the relevant supervisory authority within 72 hours. Include the nature of the breach, categories and approximate number of data subjects, contact details, likely consequences, and measures taken or proposed.

#### User Notification (GDPR Art. 34)

If the breach is likely to result in a high risk to individuals, notify affected users without undue delay. Include a description of the breach in clear language, contact details, likely consequences, and recommended user actions.

### Phase 5: Remediation (1-4 weeks)

1. Fix the root cause: deploy security patches, update configurations, implement additional controls.
2. Verify remediation: test the fix, confirm the vulnerability is closed, monitor for recurrence.

### Phase 6: Post-Incident Review (1-2 weeks after resolution)

Review what worked well, what could be improved, and recommended changes to prevent recurrence. Update this plan and security documentation based on findings.

## 6. Notification Templates

### Supervisory Authority Notification

```
Subject: Personal Data Breach Notification - [Incident ID]

To the [Supervatory Authority Name]:

We are writing to notify you of a personal data breach affecting Beaver
Sync users, in accordance with Article 33 of the GDPR.

Nature of the breach: [Description]
Date of breach: [Date]
Date of discovery: [Date]
Categories of data subjects affected: [e.g., all users, specific users]
Approximate number of data subjects: [Number]
Data categories affected: [e.g., email addresses, encrypted notes]
Contact details: danielerolli@proton.me

Likely consequences: [Description]
Measures taken: [Description]

We are continuing to investigate and will provide updates as necessary.
```

### User Notification

```
Subject: Security Incident Notification

Dear [User],

We are writing to inform you of a security incident that may have
affected your data.

What happened: [Description]
When it happened: [Date range]
What data was affected: [Description]
What we are doing: [Description]
What you can do: [Description]

We sincerely apologize for this incident. We have taken steps to
prevent similar incidents in the future.

If you have questions, contact us at danielerolli@proton.me.
```

## 7. Contact Information

| Contact | Details |
|---------|---------|
| Incident Reporting | [danielerolli@proton.me](mailto:danielerolli@proton.me) |
| Security Disclosures | [danielerolli@proton.me](mailto:danielerolli@proton.me) |

## 8. Document Control

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | August 8, 2026 | Beaver | Initial version |

## 9. Review

This plan should be reviewed and tested at least annually, or after any significant security incident.
