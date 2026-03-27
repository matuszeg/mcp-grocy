# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes are appended automatically by [semantic-release](https://semantic-release.gitbook.io/) using `@semantic-release/changelog`.

## [Unreleased]

### ⚠️ Breaking Changes

- **MCP resource URIs** use the **`mcp-grocy://`** scheme (from `package.json` `name`, generated into `SERVER_NAME` at build time). Bundled docs: `mcp-grocy://examples`, `mcp-grocy://response-format`, `mcp-grocy://config`. Clients, prompts, or bookmarks that used **`grocy-api://…`** must be updated.

### Added

- **MCP tool `annotations.readOnlyHint: true`** on read-only tools (inventory/recipes/shopping/household/system getters and lookups only—no `*_print_*`, dev tools, or mutating calls). Optional hint for clients; not a security boundary.
