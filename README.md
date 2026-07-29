# cfman

`cfman` is a control plane for managing Cloudflare Tunnel connectivity across a large fleet of remote locations. It gives Head Office operators one place to manage Cloudflare account pools, zones, tunnels, ingress routes, onboarding URLs, installation logs, and browser-based RDP access.

## What it solves

Each managed location normally sits behind NAT and does not have a fixed public IP address. It runs `cloudflared`, which opens an outbound connection to Cloudflare - this connection is the tunnel cfman manages. Head Office can then reach the location through a managed hostname without opening inbound firewall ports or manually configuring every Windows machine.

The onboarding flow is:

1. An operator creates a tunnel and its hostname/path connectivity in the web UI.
2. `cfman` provisions a managed tunnel, DNS records, and ingress configuration through the Cloudflare API.
3. The operator issues a one-time enrollment URL.
4. The tunnel administrator runs the generated PowerShell installer as Administrator, or the shell installer as root.
5. The installer claims the tunnel, installs `cloudflared`, starts the local command agent, enables Windows Remote Desktop, and sends structured installation logs back to the server.
6. The server provisions browser RDP resources and retries endpoint checks while Cloudflare resources propagate.

## Features

- Cloudflare account pool with live token validation and zone synchronization.
- Per-tunnel account and zone assignment.
- Multiple public hostnames per tunnel using a tunnel ID plus optional suffix.
- Ordered ingress paths, each mapped to a different local service.
- Managed Cloudflare Tunnel creation and configuration.
- One-time PowerShell and POSIX enrollment URLs.
- Existing-install detection with explicit cleanup and override confirmation.
- Authenticated PowerShell or shell execution through a designated tunnel connectivity route.
- Versioned Windows and Unix script library with an embedded syntax-highlighting editor.
- Server-side enrollment logs and audit logs.
- Enrollment host inventory (OS name/version/build, architecture, and machine name) captured per attempt.
- Windows and Unix installer tracking; once one platform claims a link, the other is marked `staled - ignored`.
- Browser-based RDP through Cloudflare Access, including private network routes and infrastructure targets.
- RDP gateway readiness checks with retries for Cloudflare propagation delays.
- Paginated tunnel inventory and bulk refresh for the visible page.
- Streamable HTTP MCP server with full control-plane read and write tools for AI agents.
- Local administrator authentication with forced default-password change.

## Architecture

```text
Head Office browser
        |
        v
cfman (React/Vite + Node/Fastify)
        |                    \
        | Cloudflare API       \ PostgreSQL
        v                       \
Cloudflare account pool         tunnels, zones, connectivity, audit

Managed Windows host             Head Office browser RDP
  cloudflared  ----------------> Cloudflare edge / Access
       |                                |
       +--> localhost/LAN services      +--> private tunnel route --> Windows RDP
```

## Technology

- Node.js 24 LTS
- Fastify and TypeScript API
- React, Vite, and TanStack Query frontend
- PostgreSQL
- Cloudflare Tunnel, Zero Trust, Access, DNS, and Infrastructure Access APIs

## Requirements

- Node.js `24.18.x` (the repository contains an `.nvmrc`).
- PostgreSQL 14 or newer.
- A Cloudflare account with an active zone.
- A public HTTPS hostname reachable by tunnel machines for enrollment callbacks.
- A Cloudflare API token scoped to the account. The application uses these permissions:

  - Account Settings: Read
  - Cloudflare One Connector: cloudflared: Write
  - Cloudflare One Networks: Write
  - Zero Trust: Write
  - Access: Apps and Policies: Write
  - DNS: Write
  - Zone: Read
  - Zone WAF: Write

For browser RDP, configure at least one operator email per live account. The email is used in the Cloudflare Access allow policy.

Route WAF policies use Cloudflare custom rules. The Free plan currently allows five custom rules per zone, so include that limit in domain-pool capacity planning.

## Local setup

Use the latest LTS configured by the repository:

```bash
nvm install
nvm use
node --version
```

Install dependencies and create the local environment file:

```bash
npm install
cp .env.example .env
```

Generate an encryption key and place the 64-character hexadecimal value in `.env`:

```bash
openssl rand -hex 32
```

Set at least these values:

```dotenv
NODE_ENV=development
SERVER_HOST=127.0.0.1
SERVER_PORT=3000
WEB_HOST=127.0.0.1
WEB_PORT=5173
DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/cfman
DATABASE_SCHEMA=public
ENCRYPTION_KEY=64_HEX_CHARACTERS
```

`WEB_HOST`/`WEB_PORT` configure the Vite dev server (`apps/web`) only; they are unused in production, where the API serves the built frontend from `SERVER_HOST`/`SERVER_PORT`.

`PUBLIC_BASE_URL` is optional and defaults to `http://SERVER_HOST:SERVER_PORT`. Set it explicitly when the tunnel-reachable URL differs, such as in production. It can also be changed later at runtime from the admin UI, which persists the value to PostgreSQL and takes precedence over `.env`.

Prepare and seed PostgreSQL:

```bash
npm run db:create
npm run db:migrate
npm run db:seed
```

The default local administrator is:

```text
username: root
password: 12345678
```

The first login requires a password change. Never use the default password outside a local development environment.

Start the API and frontend:

```bash
npm run dev
```

- Frontend: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:3000`
- Health check: `http://127.0.0.1:3000/health`

## Production build

```bash
npm run typecheck
npm test
npm run build
```

Run the API build with:

```bash
NODE_ENV=production npm run start -w @cfman/server
```

The production API serves the compiled frontend from `apps/web/dist` when that build exists.

## Cloudflare account setup

1. Create an API token in the Cloudflare dashboard with the permissions listed above.
2. Add the account in **Account pool** using the Cloudflare Account ID and token.
3. Confirm the token validation succeeds. The token is encrypted with AES-256-GCM before it is stored in PostgreSQL.
4. Confirm the required zone is synchronized, or add it manually with its Zone ID.
5. Configure RDP operator email addresses under the account's RDP settings.

The application stores Cloudflare resource IDs in PostgreSQL so provisioning is idempotent and can be retried safely.

## Tunnel onboarding

In **Tunnels**, create a tunnel and define one or more publications. Each publication contains:

- An optional hostname suffix. Without a suffix, the hostname is based on the tunnel code.
- One or more ordered ingress paths.
- An HTTP or HTTPS service URL reachable from the tunnel host.

Set a route type to **Command agent** to expose the enrollment-installed script runner on that hostname and path. Only one command agent route is allowed per tunnel. The route's local service URL is managed automatically as `http://127.0.0.1:47831`.

After the tunnel is created:

1. Open the tunnel details and select **New enrollment**.
2. Copy the PowerShell URL for Windows or the shell URL for Unix-like systems.
3. Run PowerShell as Administrator, or run the shell command as root.
4. If a previous enrollment is detected, confirm cleanup and override only when the existing tunnel should be replaced.
5. Monitor the installation logs from the tunnel detail view and verify the public endpoint.

The installer never receives a Cloudflare API token. It receives a one-time enrollment token, claims a server-provisioned tunnel, and installs the resulting tunnel token as a local service credential.

## Connectivity updates

Connectivity is editable after onboarding. Saving the connectivity editor updates:

- Cloudflare Tunnel ingress rules.
- DNS records for added publications.
- Removed DNS records for deleted publications.
- The tunnel's primary hostname and origin URL.

Ingress routes are evaluated in order. The root path is kept last so more specific paths are evaluated first.

## Tunnel deletion

Use **Delete tunnel** from the tunnel details modal. CFMan runs a server-side preflight that checks the tunnel connection, installed enrollments, running command executions, and the credentials needed to clean tunnel-owned Cloudflare resources. Every check includes its current state and a resolution step.

When a safety check is not ready, the operator must enter the exact tunnel display name before **Force delete tunnel** is enabled. Force deletion terminates remaining tunnel connections, removes tunnel publication DNS records and RDP network resources, deletes the tunnel, and then removes the PostgreSQL tunnel record. Cleanup is idempotent for resources already missing from Cloudflare.

## Tunnel command agent

The enrollment installer registers the command agent as a Windows scheduled task, Linux systemd service, or macOS launch daemon. The agent listens only on `127.0.0.1:47831`; Cloudflare Tunnel publishes it through the connectivity route marked **Command agent**.

Create and version PowerShell, Bash, or POSIX sh scripts in **Script library**. Open a tunnel's details, select a saved script version compatible with the active enrollment platform, and run it through the command agent. Requests are authenticated with a per-tunnel random token. The token is encrypted in PostgreSQL, written only into the protected local agent script, and never returned to the browser. Executions are limited to a five-minute timeout, and completion metadata is written to the audit log.

The command agent runs as `SYSTEM` or root because tunnel administration scripts may need to manage services and machine configuration. Every execution is linked to the active enrollment and exact script version, then persisted with `running`, `succeeded`, `failed`, or `timed_out` status, elapsed time, exit code, stdout, stderr, and error details. Treat access to the cfman administrator account as privileged infrastructure access.

## Browser RDP

Browser RDP is provisioned automatically for Windows enrollments when the installer reports an IPv4 target address. The server creates or reuses:

- A Cloudflare virtual network.
- A tunnel CIDR route for the Windows host.
- An Infrastructure Access target.
- A proxied RDP public hostname.
- A browser RDP Access application and allow policy.

The resulting URL has this shape:

```text
https://rdp.example.com/rdp/<virtual-network-id>/<target-ip>/<port>
```

The Windows host must permit TLS in its RDP security layer. The installer configures the standard Windows RDP service and firewall rule; the Windows user's credentials are still required inside the browser session.

If Cloudflare is still propagating a newly-created RDP hostname, the UI keeps retrying the gateway check. A later **Refresh** or **Retry RDP** action is safe because provisioning is idempotent.

## MCP server

CFMan can expose its control-plane capabilities to AI agents over the MCP Streamable HTTP transport. Open **Settings**, enable **MCP server**, and save the generated token immediately. The full token is shown only when it is first issued or rotated; PostgreSQL stores only its SHA-256 hash.

The endpoint follows the configured public base URL:

```text
https://cfman.example.com/mcp
```

Configure an MCP client with the endpoint and bearer token. Client configuration formats vary, but a common HTTP configuration is:

```json
{
  "mcpServers": {
    "cfman": {
      "type": "http",
      "url": "https://cfman.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${CFMAN_MCP_TOKEN}"
      }
    }
  }
}
```

The server exposes read and write tools for dashboard data, account pools, zones, tunnels, connectivity, route WAF policies, enrollments, logs, endpoint verification, RDP retries, the script library, saved and inline command execution, audit history, and public URL settings. Named inline scripts remain in tunnel execution history unless an operator or MCP client explicitly saves the exact execution snapshot as version 1 of a reusable library script. Tunnel and script-version execution histories are independently paginated and available through MCP with their tunnel, enrollment, script-version, and execution identifiers. These tools call the same internal API handlers as the web UI, so validation, Cloudflare side effects, deletion preflight checks, and audit logging remain consistent.

Every tool result contains both human-readable JSON and `structuredContent`. The structured payload includes the original response under `data` and a `references` array containing every `id` and `*Id` found in the tool input or response. Agents can therefore carry exact account, zone, tunnel, publication, route, enrollment, script, version, and execution identifiers into subsequent calls without matching display names.

MCP bearer tokens have full administrator access. Rotating a token immediately invalidates the old value, and disabling the MCP server rejects all MCP requests. Keep the token in a secret store or environment variable, never in source control or agent prompts that may be retained externally.

## Local control-plane tunnel

The `ops/cloudflared` directory contains a macOS launchd example for publishing the local control plane itself through a named Cloudflare Tunnel. Replace the tunnel ID, credential path, hostname, and local service port for each environment. Do not commit tunnel credential JSON files.

## Data and security notes

- `.env` is intentionally ignored and must never be committed.
- Cloudflare API tokens are encrypted at rest using `ENCRYPTION_KEY`.
- Enrollment tokens are stored as SHA-256 hashes and are single-use/expiry-bound.
- Tunnel command-agent tokens are generated independently and encrypted at rest.
- Enrollment and audit events are persisted in PostgreSQL.
- Tunnel installer logs are capped and accepted through a rate-limited public endpoint.
- Use HTTPS for `PUBLIC_BASE_URL` in any shared or production environment.
- Restrict PostgreSQL access to the control-plane host and rotate the encryption key only with a planned data re-encryption procedure.

## Repository layout

```text
apps/server/src/          Fastify API, Cloudflare clients, provisioning, migrations
apps/server/migrations/   PostgreSQL schema migrations
apps/server/test/         API and monitor tests
apps/web/src/              React application and UI components
ops/cloudflared/           Local named-tunnel examples
```

## Troubleshooting

### The enrollment URL is invalid or expired

Issue a new URL from the tunnel details view. Enrollment tokens are deliberately short-lived and are not reusable after a successful claim unless the installer uses the explicit override flow.

### The tunnel hostname is unreachable immediately after installation

Cloudflare DNS and tunnel configuration are eventually consistent. Wait briefly, then use **Verify endpoint** or the tunnel-list **Refresh** button. Confirm that the local service URL is listening on the tunnel host.

### Browser RDP shows a Cloudflare DNS error

Confirm that the RDP hostname has a proxied DNS record, the Access application uses a public hostname, the infrastructure target is attached to the same virtual network as the tunnel route, and the tunnel is healthy. Do not point the hostname at the Windows private IP.
