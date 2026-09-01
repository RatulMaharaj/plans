#!/bin/sh
# Wrap the container's command with `infisical run`, so the server's secrets
# are pulled fresh at start rather than baked into the image. The same shape
# as looped's services, so one set of Coolify environment variables works.
#
# Auth (one of, in this order):
#   INFISICAL_TOKEN                          a machine-identity access token
#   INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET
#                                            universal auth, exchanged here
#
# Config:
#   INFISICAL_PROJECT_ID    the Infisical project (required to inject)
#   INFISICAL_ENV           environment slug (default: prod)
#   INFISICAL_SECRETS_PATH  space-separated folder paths, app path first
#                           (default: /apps/plans-workspaces /shared)
#   INFISICAL_API_URL       the self-hosted instance, read by the CLI itself
#
# With no credentials the command runs unchanged, so a plain `docker run`
# still comes up on the in-process database.
set -e

if [ -z "$INFISICAL_TOKEN" ] && [ -n "$INFISICAL_CLIENT_ID" ] && [ -n "$INFISICAL_CLIENT_SECRET" ]; then
  INFISICAL_TOKEN="$(infisical login --method=universal-auth \
    --client-id="$INFISICAL_CLIENT_ID" \
    --client-secret="$INFISICAL_CLIENT_SECRET" \
    --plain --silent)"
  export INFISICAL_TOKEN
fi

if [ -n "$INFISICAL_TOKEN" ]; then
  path_flags=""
  for path in ${INFISICAL_SECRETS_PATH:-/apps/plans-workspaces /shared}; do
    path_flags="$path_flags --path=$path"
  done
  # shellcheck disable=SC2086
  exec infisical run \
    --projectId="$INFISICAL_PROJECT_ID" \
    --env="${INFISICAL_ENV:-prod}" \
    $path_flags \
    --silent \
    -- "$@"
fi

echo "docker-entrypoint: no Infisical credentials, starting without injection" >&2
exec "$@"
