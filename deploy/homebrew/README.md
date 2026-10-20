# Homebrew

Templates for the tap `devmello/psyche` (repository `github.com/devmello/homebrew-psyche`, to be created before the first v1 release):

| Template | Renders to | Installs |
| --- | --- | --- |
| `psyche.rb.tmpl` | `Casks/psyche.rb` | `Psyche.app` from `Psyche-<version>-{arm64,x64}.dmg`; macOS 15+; uninstall boots out the `com.psyche.gateway` LaunchAgent; `zap` never touches `~/.psyche` |
| `psyche-cli.rb.tmpl` | `Formula/psyche-cli.rb` | the `psyche` binary for macOS and Linux (arm64, x64) plus bash/zsh/fish completions |

```bash
brew install --cask devmello/psyche/psyche
brew install devmello/psyche/psyche-cli
```

`.github/workflows/release.yml` renders both on a release tag with `deploy/scripts/homebrew.mjs <version> SHA256SUMS <out>`, which fills `{{VERSION}}` and every `{{SHA256:<asset>}}` from the release's `SHA256SUMS` and fails if an asset is missing, then pushes them to the tap with `HOMEBREW_TAP_TOKEN` (a fine-grained token with contents:write on the tap only). Prereleases do not update the tap.

To try a render locally: `node deploy/scripts/homebrew.mjs 1.0.0 SHA256SUMS /tmp/tap && ruby -c /tmp/tap/Casks/psyche.rb`, then `brew install --cask /tmp/tap/Casks/psyche.rb`.
