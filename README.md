# SNAPSHOT//

**A local codebase time machine.** One-click snapshots, one-click restore, a visual timeline — no git, no GitHub, no cloud. Built for the AI-agent era: undo any coding session in a single click.

[![offline](https://img.shields.io/badge/100%25-offline-4c1)]() [![no account](https://img.shields.io/badge/no-account-no--cloud-d8ff3e)]() [![no git needed](https://img.shields.io/badge/no-git-required-blue)]() [![self-hosted](https://img.shields.io/badge/self--hosted-local--first-purple)]()

> **The git-free backup & restore system for your codebase.** Everything runs offline on your machine — no sign-up, no cloud upload, no telemetry, nothing leaves your disk.

```
┌─────────────────────────────────────────────────────────────────┐
│  ● NOW — 3 files changed          ← live indicator (clickable)  │
│  ○ Auto — before agent session   ← one click back to safety     │
│  ○ Before refactor                                            │
│  ○ Working login flow                                          │
└─────────────────────────────────────────────────────────────────┘
```

## Why

Editors and AI agents change dozens of files in seconds. When something breaks, `Ctrl+Z` doesn't help — you need the *whole codebase* back. SNAPSHOT// saves the entire project as a named zip on your own disk and restores any point in time with one click, automatically protecting your current state before every restore.

- **No size limit** — streaming zip/extract keeps memory flat, works on any codebase
- **No git knowledge** — if you can name a folder, you can use it
- **Nothing leaves your machine** — 100% local, no accounts, no telemetry

## Install & run

```bash
npm install
npm start
```

Open **http://localhost:3777**, browse to your codebase folder, done.
Change the port in `.env` (see `.env.example`).

> Runs locally on your machine. The browser page only reads the drives of the machine where the server runs.

## Features

### Snapshots
- **One-click save** — type a name, press Save. Entire codebase archived (fast zlib level 1)
- **Timeline UI** — vertical history, newest first, auto-snapshots dimmed, inline rename (✎)
- **Diff preview** — click `Δ` on two snapshots to see added / removed / changed files
- **Safety first** — every restore automatically saves your *current* code first (auto-pruned to last 8)
- **Disk-space guard** — refuses a snapshot that would fill the drive
- **Self-healing index** — if the snapshot index is ever corrupted, it rebuilds from metadata embedded in each zip

### Restore
- **One click + confirmation** — restore is a clean replace: extract to temp, verify, then swap (your code is never touched until the archive is fully validated)
- **Preserve ignored paths** — `node_modules/`, `.env` and anything matching your ignore rules survive restores (toggleable), so no reinstall and no lost secrets
- **Zip-slip protection** — archives can never write outside your project

### Ignore system
- Optional **`.gitignore` respect** (on by default)
- **Manual rules table** — add folder / file / glob rows in Settings
- `.snapshot/` is always excluded, and the app appends it to your project's `.gitignore` automatically

### Live change detection *(new)*
- Watches your codebase in real time through the same ignore rules
- The **NOW marker** shows unsaved changes and turns amber — click it for a per-file list (+ added / ~ modified / − deleted)
- **Session inference** — bursts of activity separated by 5-minute quiet gaps are detected as sessions

### AI-agent awareness *(opt-in)*
- **Auto-snapshot before agent sessions** — when changes begin and an agent fingerprint is detected (recent activity in `.kilo/`, `.claude/`, `.cursor/`, `.codex/`), a snapshot is taken automatically. Any AI mess becomes one-click undoable
- **Auto-snapshot on session end** — captures the session result after 5 minutes of silence
- **Scheduled snapshots** — every N hours, configurable

### Storage
- Default `<project>/.snapshot/` or any custom backup folder
- One zip per snapshot — easy to copy to an external drive
- Atomic index/settings writes; crash log (`crash.log`) instead of silent deaths

```
<project>/.snapshot/
  settings.json      per-project config
  index.json         snapshot list
  snapshots/*.zip    one archive per snapshot (metadata embedded)
```

## Settings reference

| Setting | Default | Effect |
|---|---|---|
| Backup folder | `<project>/.snapshot` | custom path for archives |
| Respect `.gitignore` | on | apply project's gitignore when snapshotting |
| Preserve ignored paths on restore | on | node_modules/.env etc. survive restores |
| Live change detection | on | NOW marker shows unsaved changes |
| Auto-snapshot before AI agent sessions | off | undo-any-AI-mess insurance |
| Auto-snapshot when a session ends | off | capture result after 5 min idle |
| Auto-snapshot interval | 0 (off) | hours between scheduled snapshots |
| Ignored files & folders table | — | manual folder / file / glob rules |

## API

The local server exposes a small REST + SSE API (all cross-origin requests blocked):

```
GET    /api/state                        current project, settings, snapshots
POST   /api/project                      open/switch codebase folder
GET    /api/fs?path=                     list drives/folders (picker)
GET    /api/dirty                        unsaved changes + session info
PUT    /api/settings                     update settings
POST   /api/snapshots                    create snapshot { name }
PUT    /api/snapshots/:id                rename { name }
DELETE /api/snapshots/:id                delete snapshot
POST   /api/snapshots/:id/restore        safety-snapshot + restore
GET    /api/snapshots/:a/diff/:b         compare two snapshots
GET    /api/events                       SSE: progress, dirty, refresh events
```

## Tests

```bash
npm test
```

Covers: snapshot/ignore/restore core, preserve-on/off, stress restore (deep trees, unicode names, locked-file handling), corrupt-index self-heal, diff accuracy, and live watcher detection.

## Tech

Node.js, Express, chokidar, archiver (streaming zip), unzipper (streaming extract), `ignore` (gitignore semantics), vanilla JS + bespoke CSS frontend. No build step.

## Find it useful?

If SNAPSHOT// saved your codebase once, star it on GitHub — it helps other developers find a simpler, offline alternative to git for quick backups.

## Keywords

backup and restore system · backup restore tool · codebase backup · folder snapshot tool · git alternative · git without commands · simple version control · no git version control · local version history · offline backup tool · file backup and restore · restore codebase to previous state · time machine for code · undo AI agent changes · backup before AI coding session · Claude Code undo · Cursor restore files · one-click backup · one-click restore · self-hosted backup · privacy-first developer tools · no cloud backup · windows backup restore · project point-in-time restore

**GitHub topics to add when publishing:** `backup` `backup-restore` `restore` `snapshot` `version-control` `git-alternative` `no-git` `backup-system` `local-first` `offline-first` `developer-tools` `ai-agents` `time-machine` `file-history` `self-hosted` `privacy` `undo` `nodejs` `express`

## License

MIT
