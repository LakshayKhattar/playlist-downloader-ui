# Security policy

## Supported version

Security fixes are applied to the latest commit on `main`.

## Reporting

Please use GitHub's private vulnerability reporting flow under the repository's **Security** tab. Do not publish exploit details in a public issue.

Include the affected version, reproduction steps, impact, and any suggested remediation. Reports involving arbitrary command execution, path escape, cross-origin control, authentication bypass, or sensitive-data exposure are prioritized.

## Deployment boundary

This is a single-user downloader. It binds to loopback and is safe to expose only through an authenticated reverse proxy on the same host with an exact `APP_PUBLIC_URL`. Never publish the Node port directly or run an unauthenticated public download service.
