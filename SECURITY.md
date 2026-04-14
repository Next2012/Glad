# Security Policy

## Scope

Glad is a local-first Web interface for terminal-based AI tools. It is designed to run on your machine and expose a browser UI on your local network.

This project does not provide a hosted relay service, remote account system, or managed multi-tenant backend.

## Reporting a Vulnerability

If you discover a security issue, please report it responsibly.

- Do not post full exploit details publicly before a fix is available.
- Open an issue with a minimal description if no private channel is available.
- If you already have a direct contact channel with the maintainer, prefer that for sensitive reports.

Please include:

- affected version
- impact
- reproduction steps
- proof of concept if necessary
- proposed mitigation if you have one

## Supported Versions

Only the latest released version is supported for security fixes.

## Security Model

Glad's security model is intentionally simple:

- the server runs locally on the machine where Glad is started
- terminal I/O stays on that machine
- the browser UI communicates with the local Glad process
- file access is scoped to the selected working directory in the current implementation

## Known Risks and Limitations

- Anyone who can access the exposed Glad port may be able to interact with the active UI.
- Glad is intended for trusted local or private-network environments.
- Terminal sessions may expose secrets already visible to the local shell or AI tool.
- Security also depends on the behavior of third-party AI CLIs launched through Glad.

## Recommended Usage

- Run Glad only on machines and networks you trust.
- Avoid exposing the port directly to the public internet.
- Be careful when running against repositories that contain secrets.
- Keep your Glad binary or npm installation up to date.
- Review changes from AI tools before executing or committing them.

## Dependency and Supply Chain Notes

Glad depends on Node.js packages and external AI CLI tools. Vulnerabilities in those dependencies may affect Glad deployments.

When updating or packaging Glad:

- refresh dependencies deliberately
- verify release artifacts before distribution
- test packaged builds on a clean machine when possible

## Disclosure Process

For confirmed issues, the expected process is:

1. reproduce and assess impact
2. prepare a fix
3. publish the fix
4. document the change in the changelog when appropriate

## Questions

For general project support, use the repository issue tracker:

https://gitee.com/next2012/glad/issues
