# Bunshin sandbox reference image (BUN-16).
#
# Used ONLY by `bunshin run --sandbox` when `sandbox.image` is unset: the CLI builds this and tags it
# `bunshin-sandbox:<pkgVersion>`, then runs the unattended agent inside a container against an ISOLATED
# CLONE of your repo (mounted rw at /work). The host repo itself is never bind-mounted — only what you
# explicitly allowlist in `sandbox.env` / `sandbox.mounts` crosses the boundary. Override this whole
# image with `sandbox.image`, or point at your own file with `sandbox.dockerfile`.
#
# This is a REFERENCE/default. It ships the pieces the default pipeline needs: git, the agent CLI, and
# Playwright + its browser dependencies for the web-only `verify` gate. Keep it minimal.
#
# IMPORTANT: no ENTRYPOINT that hijacks the command — the CLI runs the wrapped agent command as given
# (`sh -c "<agent command>"`), so the image must leave the command free.

FROM node:20-bookworm-slim

# git: the driver cuts worktrees / commits inside the clone. ca-certificates: HTTPS for npm + APIs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The agent CLI. Default: Claude Code. For the Codex runtime (agent.kind: "codex") swap this for the
# codex CLI, e.g. `RUN npm install -g @openai/codex` (or build your own image via sandbox.image).
RUN npm install -g @anthropic-ai/claude-code

# Playwright + the browser OS dependencies for the `verify` gate (web repos). Drop these two lines for
# a smaller image if your pipeline has no `verify` gate (config-only / CLI repos).
RUN npm install -g playwright \
    && npx --yes playwright install --with-deps chromium

WORKDIR /work
