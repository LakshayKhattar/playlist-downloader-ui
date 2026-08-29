# Security policy

## Supported version

Security fixes are applied to the latest commit on `main`.

## Reporting

Please use GitHub's private vulnerability reporting flow under the repository's **Security** tab. Do not publish exploit details in a public issue.

Include the affected version, reproduction steps, impact, and any suggested remediation. Reports involving arbitrary command execution, path escape, cross-origin control, authentication bypass, or sensitive-data exposure are prioritized.

## Deployment boundary

This is a single-user downloader. Local and VPS installs bind to loopback by default. Hosted mode requires an exact HTTPS origin, explicit remote-access opt-in, and password authentication before the process will bind to `0.0.0.0`.

The unauthenticated `/api/health` endpoint returns only service health and version. Every UI asset, job status endpoint, mutation, progress stream, and verified-file download requires authentication in hosted mode. Repeated incorrect credentials are rate limited. Never remove these controls or run an unauthenticated public download service.

Verified-file routes accept only the current opaque job ID and a numeric server-issued file index. The backend rechecks that the selected entry is a regular verified media file inside the configured download directory before serving it as an attachment.

Render Free storage is ephemeral. This is an availability limitation rather than a security boundary: save completed files locally before the service restarts or is redeployed.
