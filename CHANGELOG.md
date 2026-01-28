# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-01-28

### 🎉 Major Features - Official Plugin Release

This release transforms the DingTalk plugin into an official Clawdbot plugin that can be installed via `clawdbot plugins install` command.

### Added

- **Official NPM Installation Support**
  - Published to NPM as `@yaoyuanchao/dingtalk`
  - Install with: `clawdbot plugins install @yaoyuanchao/dingtalk`
  - Added `clawdbot.install` configuration in package.json

- **Interactive Onboarding Wizard** (`src/onboarding.ts`)
  - Run with: `clawdbot onboard --channel dingtalk`
  - Step-by-step guided configuration
  - Automatic connection testing
  - Policy selection with descriptions
  - Auto-save to configuration file

- **Zod Schema Validation** (`src/config-schema.ts`)
  - Type-safe configuration validation
  - Automatic error messages with detailed paths
  - Default values for all optional fields
  - Strict mode to catch unknown properties

- **Health Check System** (`src/probe.ts`)
  - Connection status monitoring
  - Latency measurement
  - Improved `status.probeAccount` with detailed error reporting

- **Enhanced Error Messages**
  - Validation errors show exact field and reason
  - Helpful hints for environment variable configuration
  - Guidance for troubleshooting connection issues

### Changed

- **Package Configuration**
  - Renamed from `@clawdbot/dingtalk` to `@yaoyuanchao/dingtalk`
  - Version bumped from 0.1.0 to 1.2.0
  - Added MIT license
  - Added keywords for NPM discoverability
  - Added `peerDependencies` for clawdbot version requirement
  - Added `files` field to control NPM publish content

- **Configuration Validation**
  - Migrated from JSON Schema to Zod
  - Environment variables merged before validation
  - Better error messages for invalid configurations

- **Module Imports**
  - Separated probe functionality into dedicated module
  - Improved type safety with Zod type inference

### Technical Details

- **Dependencies**: Added `zod@^3.22.0`
- **Peer Dependencies**: Requires `clawdbot >= 2026.1.24`
- **TypeScript**: Published as TypeScript source (not compiled JS)
- **Backward Compatibility**: All v0.1.0 features preserved

### Migration Guide

If you're upgrading from v0.1.0:

1. **No configuration changes required** - existing configs work as-is
2. **Optional**: Try the new onboarding wizard for fresh setup
3. **Optional**: Reinstall via NPM for easier updates:
   ```bash
   clawdbot plugins uninstall dingtalk
   clawdbot plugins install @yaoyuanchao/dingtalk
   ```

## [0.1.0] - 2026-01-26

### Initial Release

#### Added

- **Stream Mode Connection**
  - WebSocket-based connection via `dingtalk-stream@2.1.4`
  - No public domain required
  - Auto-reconnection support

- **Private Messages (DM)**
  - Support for 1-on-1 conversations
  - Pairing mode with automatic staffId display
  - Allowlist mode for restricted access
  - Open mode for unrestricted access

- **Group Chat Support**
  - @mention detection
  - Group allowlist (conversation IDs)
  - Optional mention requirement

- **Message Sending**
  - Dual-route strategy:
    - SessionWebhook (preferred, 35-minute validity)
    - REST API (fallback for expired sessions)
  - Text message support
  - Markdown format support (limited by DingTalk)
    - Auto-converts tables to code blocks

- **Access Control**
  - DM policies: disabled, pairing, allowlist, open
  - Group policies: disabled, allowlist, open
  - Per-user staffId authorization
  - Per-group conversationId authorization

- **Configuration**
  - Environment variable support (DINGTALK_CLIENT_ID, etc.)
  - JSON configuration in clawdbot.json
  - Credential source detection (config vs env)

- **Core Modules**
  - `src/monitor.ts` - Stream connection and message handling
  - `src/api.ts` - DingTalk REST API wrapper
  - `src/channel.ts` - Clawdbot ChannelPlugin implementation
  - `src/accounts.ts` - Account credential resolution
  - `src/types.ts` - TypeScript type definitions

#### Known Limitations

- **Markdown Support**: DingTalk doesn't support tables in markdown
- **Media Messages**: Sending files/images not yet implemented
- **Rate Limits**: 20 messages/minute/group (DingTalk limit)

---

## Legend

- 🎉 **Major Features**: Significant new functionality
- ✨ **Enhancements**: Improvements to existing features
- 🐛 **Bug Fixes**: Fixes for issues
- 🔒 **Security**: Security-related changes
- 📝 **Documentation**: Documentation updates
- ⚠️ **Breaking Changes**: Changes that may require migration

---

**Note**: This changelog focuses on user-facing changes. For detailed commit history, see the Git log.
