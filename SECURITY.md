# Security policy

## Supported versions

Security fixes are made on the latest release and `main`.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/quino0627/tail-aside/security/advisories/new). Do not open a public issue with session data, Tailscale identity details, access tokens, or a working exploit.

## Intended trust boundary

`tail-aside` is a single-user, self-hosted bridge to a locally authenticated Aside CLI. It must remain bound to localhost and should be exposed only through Tailscale Serve.

The default setup:

- binds the Node server to `127.0.0.1`;
- authorizes the detected Tailscale login at the API layer;
- requires same-origin JSON requests with a custom marker for mutations;
- stores configuration, state, and the SQLite cache with user-only permissions;
- never stores an Aside password or Tailscale authentication key;
- keeps external sends behind an exact, one-time approval flow.

Do not expose this service with Tailscale Funnel, a public reverse proxy, or a router port-forward. Network access grants should be treated as an additional boundary, not a replacement for the application allowlist.

## Sensitive data

Aside transcripts can contain private browsing context and agent output. Do not attach live config, state files, SQLite caches, transcripts, or service logs to issues. The repository ignores generated output and runtime state, but review every commit before publishing a fork.
