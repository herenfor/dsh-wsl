# dsh-wsl

English | [中文](README.zh.md)

A **WSL run mode** for DeepSeek Harness Desktop on Windows: each task can run in Windows or in WSL. For a task set to WSL, the agent, its commands, file access and plugins all run in a DSH inside WSL, while you keep using the Desktop window. Linux plugins installed in WSL work as they are, including ones that change the interface, and are managed on their own tab of Desktop's Plugins page.

Built only from plugins and external components; no official code is changed.

Status: beta, published on npm as `@herenfor/dsh-wsl`. Tested only with DSH 0.2.2-rc.1 so far.

## Use

Installing, features, updates, uninstalling and known limitations are in the plugin's README: [experiments/mirror/mirror/README.md](experiments/mirror/mirror/README.md).

In short: Desktop → Plugins → Add plugin → Install a third-party plugin, enter `@herenfor/dsh-wsl`, restart Desktop completely after the install, then switch the run location on the new-task page to WSL and follow the setup.

## How it works

```
Windows                                         WSL
Desktop (DSH Host + page)                       DSH Host (profile desktop-wsl)
  └ plugin @herenfor/dsh-wsl                       └ plugin dsh-wsl-agent
      ├ per-task routing: WSL tasks go to WSL         ├ reports WSL's page modules, routes and plugins
      ├ merges both sides' sidebar, modules,          └ credential broker: asks Desktop when needed
      │ settings
      └ one wsl.exe connection  ◄──────────────►  resident daemon, exits 5 s after Desktop closes
```

- Transport: one multiplexed connection over `wsl.exe`'s standard input and output, with a resident process on the WSL side, the same approach as Claude Code Desktop's WSL mode.
- Session IDs: WSL sessions and folders carry a `wsl:` prefix on the page; forwarded requests are rewritten by field and by value.
- Credentials: never copied into WSL; the WSL side gets a credential broker that asks Desktop when it needs one.

## Repository layout

| Path | Contents |
|---|---|
| `experiments/mirror/mirror/` | The Desktop-side plugin, the package published to npm: routing, merging, the setup window, the WSL plugins tab, page code in `client.js` |
| `experiments/mirror/agent/` | The WSL-side plugin `dsh-wsl-agent`, carried into WSL by the Desktop-side plugin |
| `experiments/transport/` | The `wsl.exe` connection: multiplexing (`mux.mjs`), the Desktop end (`client.mjs`), the WSL daemon (`daemon.mjs`) |
| `experiments/mirror/tests/` | Unit tests |
| `scripts/release.sh` | Releases a version (see below) |
| `scripts/assemble.sh` | Copies transport and agent into the plugin package |
| `.github/workflows/publish.yml` | Publishes to npm when a version tag is pushed |
| `scripts/sync-windows.sh` | Development: assembles, then copies the package into a Windows test folder |
| `docs/` | Design and experiment notes (in Chinese) |

## Development

```bash
node --test experiments/mirror/tests/*.test.mjs
```

### Releasing

```bash
scripts/release.sh 0.1.1 --dry-run   # tests, assembles, checks the package contents; changes nothing
scripts/release.sh 0.1.1             # then sets the version, commits, tags v0.1.1 and pushes
```

The pushed tag starts `.github/workflows/publish.yml`, which runs the tests, checks that the tag matches the version and that the package carries the current bridge files, and publishes to npm with npm trusted publishing (no npm token stored in GitHub). A version with a pre-release part (`0.2.0-beta.1`) goes to the npm tag `next`. Installed copies update themselves from npm.

The workflow publishes only once the package's trusted publisher is set on npmjs.com (settings of `@herenfor/dsh-wsl`: GitHub Actions, repository `herenfor/dsh-wsl`, workflow `publish.yml`). Until then, or to publish from your own machine, use `scripts/release.sh <version> --local` after `npm login`: it publishes, waits until the version is live (approve it on npmjs.com if npm staged it for 2FA approval), then commits, tags and pushes. A failed run changes nothing and can simply be run again.

`scripts/assemble.sh` copies the latest `experiments/transport` and `experiments/mirror/agent` files into the package; the release script runs it. `scripts/sync-windows.sh` is for development: it also copies the package into a Windows test folder that a Desktop links to.

## Documents (in Chinese)

- [docs/bridge-plan.md](docs/bridge-plan.md): the bridge (transport, deployment, per-session routing).
- [docs/session-routing.md](docs/session-routing.md): per-session routing; each task runs in Windows or WSL, and the sidebar lists both.
- [docs/plugin-management.md](docs/plugin-management.md): plugin management and the page mirror.
- [docs/panel.md](docs/panel.md): the Plugins page (now separate Windows and WSL tabs).
- [docs/credentials.md](docs/credentials.md): how WSL sessions use Desktop's credentials.
- [docs/deployment.md](docs/deployment.md): first-run setup, version rules, plugin self-update, interface language.

## License

MIT, see [LICENSE](LICENSE). The ID field table in `experiments/mirror/mirror/ids.mjs` is adapted from [dsh-ssh-workspaces](https://github.com/czp0312/dsh-ssh-workspace) (MIT); its copyright notice ships with the plugin package (`experiments/mirror/mirror/LICENSE`).
