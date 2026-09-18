# Environments and Variables

## Managing Environments

### Create a Preview Environment

```bash
mcloud environments create \
  --name "Staging" \
  --branch develop
```

### Inspect an Environment

`environments get`, `delete`, `redeploy`, and `trigger-build` all accept either an environment ID or handle.

```bash
mcloud environments get staging --json | jq '{id, name, type, status, tracked_branch}'
```

### Delete an Environment

```bash
mcloud environments delete env_123 --yes
```

> **CRITICAL:** Production environments are protected — `delete` returns a non-zero exit code. Always check the `type` field via `environments get --json` before attempting a delete in automation.

## Managing Environment Variables

Variables are scoped to a single environment. `set` and `delete` require mcloud CLI v0.1.10+.

> **CRITICAL:** Setting or deleting a variable does NOT rebuild or redeploy — the running deployment keeps the old values until you deploy again. For a **runtime** variable, run `mcloud environments redeploy <env>`. For a **build** variable, run `mcloud environments trigger-build <env>` (a redeploy reuses the existing image and won't pick up build-variable changes).

### List Variables

```bash
mcloud variables list --json
```

Filter by type or scope:

```bash
# Storefront variables instead of backend (default: backend)
mcloud variables list --type storefront --json

# Only build (or only runtime) variables — repeatable; default is both
mcloud variables list --scope build --json

# Include system variables Medusa auto-injects
mcloud variables list --include-system --json
```

### Get a Variable

```bash
# By key (requires active project and environment)
mcloud variables get DATABASE_URL --json

# By ID (works without project/environment context)
mcloud variables get var_01XYZ --json
```

The JSON result exposes `environment_id`, `is_secret`, `is_build`, `is_runtime`, and `source` (`user` or `system`).

### Set a Variable

Create or update variables. The CLI updates when you reference an existing key or a `var_...` ID, and creates otherwise. Creating or looking up by key requires `--project` and `--environment` (or the active context).

```bash
# Single variable
mcloud variables set API_KEY pk_123

# Multiple at once
mcloud variables set -v API_KEY=pk_123 -v CLIENT_ID=my_app

# From a .env file
mcloud variables set --env-file .env
```

New variables default to runtime, non-secret. Control the kind with flags:

```bash
# A secret build-only variable
mcloud variables set STRIPE_SECRET_KEY sk_live_123 --secret --build --no-runtime
```

Redeploy (runtime) or trigger-build (build) afterward — see the note above.

### Delete a Variable

> **CRITICAL:** Deletion is irreversible, and system variables cannot be deleted. Pass `--yes` in non-interactive environments or the command errors out.

```bash
mcloud variables delete API_KEY --yes
```

Redeploy or trigger-build afterward for the change to take effect.

### Reveal Secret Values

> **CRITICAL:** Only pass `--reveal` when the user explicitly asks. Plaintext values appear in terminal scrollback, log aggregators, and process listings.

```bash
mcloud variables get STRIPE_SECRET_KEY --reveal --json | jq -r '.value'
```

### Export to .env

Replicate a Cloud environment's variables locally with `--dotenv`, which emits `KEY=VALUE` lines directly:

```bash
mcloud variables list --reveal --dotenv > .env
```

> **CRITICAL:** `--reveal` prints secrets in plaintext. Use it only when the user explicitly asks, and never commit the resulting `.env` file.
