# Security Policy

## Reporting a vulnerability

Please use GitHub's private vulnerability-reporting feature for this
repository. Do not open a public issue with exploit details, tokens, session
files, credentials, tenant data, bank data, or other personal information. If
private reporting is unavailable, contact the maintainer privately before
disclosing details.

Include the affected version, impact, and minimal reproduction with all
secrets and personal data removed. Rotate any credential that may have been
exposed.

## Security defaults

Banking and property write tools are disabled by default. Enabling a write
tool requires its environment flag and `confirm=true` on each call;
`IMMOCLOUD_READ_ONLY=true` overrides all write flags. `confirm=true` is a
technical guardrail, not evidence that a human approved an operation.

By default (`IMMOCLOUD_SESSION_BACKEND=auto`) the Bearer token and device ID are
stored in the OS keychain (macOS Keychain, Windows Credential Manager, or Linux
Secret Service). `.immocloud/session.json` then holds only non-secret metadata
(backend, origin, timestamps) with mode `0600`.

If the keychain is unavailable, or `IMMOCLOUD_SESSION_BACKEND=file`, the session
file contains the live Bearer token and must be treated as a secret. Legacy
plaintext session files are migrated into the keychain on the next successful
load when keychain storage is available.
