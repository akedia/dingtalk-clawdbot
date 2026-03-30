# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.11] - 2026-03-30

### Added

- **Per-group sender allowlist** — New `groups.<conversationId>.allowFrom` config field.
  When set, the bot silently ignores @ messages from anyone not in the list.
  Supports `"*"` wildcard to allow all senders (same as omitting the field).
  Useful for restricting a shared group bot to specific authorized users.

## [1.5.3] - 2026-02-03

### Improved

- **sendAttachment action** — Now accepts both `target` and `to` parameters (agent may use either)
- **Context inference** — Tries to infer target from `conversationTarget` if not explicitly provided
- **Better error messages** — Returns clear error descriptions instead of silent `null` when parameters are missing

## [1.5.2] - 2026-02-03

### Fixed

- **OpenClaw plugin install** — Added `openclaw.extensions` field for proper plugin installation

## [1.5.1] - 2026-02-03

### Added

- **OpenClaw compatibility** — added `openclaw.plugin.json` for seamless migration from ClawdBot to OpenClaw
- Plugin now works with both ClawdBot and OpenClaw without any code changes

### Changed

- Updated package description to mention OpenClaw support
- Added "openclaw" to keywords

## [1.5.0] - 2026-01-31

### 🎉 New Feature: Typing Indicator with Auto-Recall

- **Typing Indicator** — When processing a message, automatically sends "⏳ 思考中..." which is silently recalled when the reply is ready. Much better UX than the old `showThinking` option.
- **Message Recall APIs** — New functions in `api.ts`:
  - `sendDMMessageWithKey()` — Send DM and return processQueryKey for recall
  - `sendGroupMessageWithKey()` — Send group message and return processQueryKey
  - `recallDMMessages()` — Batch recall DM messages
  - `recallGroupMessages()` — Batch recall group messages
  - `sendTypingIndicator()` — One-stop helper that returns a cleanup function

### Configuration

- `typingIndicator: false` — Disable typing indicator (default: enabled)
- `typingIndicatorMessage: "xxx"` — Customize the thinking message

### Changed

- Deprecated `showThinking` option (still works as fallback if `typingIndicator` is explicitly disabled)

## [1.4.10] - 2026-01-30

### Fixed

- **Remove peerDependencies** — removed `clawdbot` from peerDependencies to prevent npm 7+ from installing the entire clawdbot package (400+ deps, ~55MB) into plugin's node_modules; clawdbot is injected at runtime via jiti alias
- **`clawdbot plugins update` now works** — installation reduced from timeout (~5min+) to seconds

## [1.4.9] - 2026-01-30

### Fixed

- **zod v4 compatibility** — upgraded zod dependency from `^3.22.0` to `^4.3.6` to match clawdbot's version; fixed `ZodError.errors` → `ZodError.issues` API change

### Changed

- **Dependency alignment** — now uses same zod version as clawdbot core and clawdbot-feishu plugin

## [1.3.6] - 2026-01-28

### Fixed

- **Stream ACK method name** — corrected `socketResponse()` to `socketCallBackResponse()` (the actual SDK method); previous typo caused ACK to silently fail, triggering DingTalk 60-second retry
- **Audio message handling** — skip .amr file download when DingTalk ASR recognition text is available; prevents agent from being confused by audio attachment and trying Whisper instead of reading the already-transcribed text

## [1.3.5] - 2026-01-28

### Fixed

- **Outbound `to` parameter parsing** — bare userId (no `dm:` prefix) now correctly treated as DM target; previously silently dropped with ok:true
- **SessionWebhook response validation** — `sendViaSessionWebhook()` and `sendMarkdownViaSessionWebhook()` now return errcode/errmsg and check `.ok`; failures trigger REST API fallback instead of being silently ignored
- **Stream ACK timing** — immediately call `socketResponse()` on message receipt to prevent DingTalk 60-second retry timeout; previously awaited full AI processing before ACK
- **`resolveDeliverText()` type safety** — check `typeof payload.markdown === 'string'` to avoid treating boolean flags as text content

### Changed

- **`parseOutboundTo()` enhanced** — handles `"dm:id"`, `"group:id"`, `"dingtalk:dm:id"`, `"dingtalk:group:id"`, and bare `"id"` (defaults to DM)
- **`deliverReply()` error propagation** — throws on sessionWebhook rejection to trigger retry + REST API fallback
- **Media URL merging** — `resolveDeliverText()` merges `payload.mediaUrl`/`payload.imageUrl` into text as markdown image syntax
- **Webhook functions** return `{ ok, errcode, errmsg }` for proper error inspection

## [1.3.0] - 2026-01-28

### Added

- **Full SDK Pipeline** — runtime feature detection for `dispatchReplyFromConfig` with 9-step SDK integration (routing, session, envelope, dispatch)
- **Media support** — image download via `downloadPicture()`, audio/video/file recognition via `downloadMediaFile()`
- **Smart Markdown detection** — `messageFormat: 'auto'` option with regex-based content detection
- **Thinking indicator** — `showThinking` config option sends "正在思考..." before AI processing
- **Activity recording** — `runtime.channel.activity.record()` calls for start/stop/message events
- **`cleanupOldMedia()`** — generalized media cleanup (replaces `cleanupOldPictures`)

### Changed

- **Message extraction refactored** — `extractMessageContent()` switch-case structure for text/richText/picture/audio/video/file
- **Config schema** — added `showThinking`, `messageFormat: 'auto'` option
- **`sendMedia()` outbound** — uses markdown image syntax instead of plain URL text

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

If you're upgrading from v0.1.0, see [UPGRADE.md](./UPGRADE.md) for detailed steps.

Summary:
1. **No configuration changes required** - existing configs work as-is
2. Backup, stop gateway, delete old plugin, install via NPM, restart
3. **Optional**: Try the new onboarding wizard for fresh setup

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
