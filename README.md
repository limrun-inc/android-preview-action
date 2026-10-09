# Android previews for pull requests

Build an Android app on a temporary [Limrun](https://limrun.com) Gradle sandbox
and post a link to run it in a streamed Android emulator. The runner needs no
Android SDK. Reviewers must belong to the Limrun organization that owns the asset.

## Usage

Add a Limrun API key as the repository secret `LIM_API_KEY`:

```yaml
name: Android preview

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: android-preview-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: limrun-inc/android-preview-action@main
        with:
          api-key: ${{ secrets.LIM_API_KEY }}
          project-path: .
          tasks: assembleDebug
          build-env: |
            APP_ENV=preview
            API_URL=https://api.example.com
          open-url: 'myapp://checkout?item=123&source=preview'
```

The action syncs the project, runs its Gradle wrapper, uploads the APK under a
stable asset name for the PR, and creates or updates its Android preview comment.
It deletes the builder after the build, including failed builds. An `always()`
post hook retries cleanup after errors or cancellation. Each run has its own
cleanup labels so an older run cannot delete a newer run's builder.

Closing the PR cleans up its remaining builders and marks the comment as closed.
The asset stays available until its default TTL expires, 14 days after the last
upload. Opening a preview starts the stream, installs the APK, launches the app,
and then opens `open-url` if supplied.

## Inputs

| Input | Default | Description |
|---|---|---|
| `api-key` | Required | Limrun API key, supplied through a repository secret. |
| `github-token` | `${{ github.token }}` | Token with `pull-requests: write` for the preview comment. Set to an empty string to only produce outputs. |
| `project-path` | `.` | Local directory to sync. Include the project files needed by the build. |
| `gradle-project-path` | Auto-discovered | Gradle root relative to the synced directory, useful for ambiguous monorepos. |
| `tasks` | `assembleDebug` | One Gradle task per line. Use tasks that produce an installable APK, such as `:app:assembleDemoDebug`. |
| `build-env` | Empty | One `KEY=VALUE` environment variable per line, passed to the remote build. |
| `open-url` | Empty | URL or app deep link to open after the preview app launches. Pass plain text; encoding is automatic. |

`build-env` configures the build process. App configuration depends on how the
project reads those values at build time. `KEY=` sets an empty value, and values
can contain `=`. The action masks nonempty values in subsequent Actions logs;
pass sensitive values through `${{ secrets.* }}` so GitHub also masks the step's
input display. Values may be embedded in the resulting app.

`open-url` appears in the preview link, PR comment, logs, and browser history,
so use nonsecret URLs. Android previews do not accept app-launch environment
variables.

Build an APK, not an AAB, for emulator previews. A signed debug APK from
`assembleDebug` is the default. Native Android and React Native projects use
remote Gradle builds. Managed Expo projects are detected by the build service;
for an interactive Expo dev-client session with Metro, use the
[Expo workflow](https://docs.limrun.com/docs/android/build-with-gradle).

## Outputs

| Output | Description |
|---|---|
| `preview-url` | URL to install and launch the uploaded APK in a streamed emulator. |
| `asset-name` | Stable asset name, `preview/<owner>/<repo>/pr-<number>-android`. |

The action handles `pull_request` events. Fork pull requests normally receive no
repository secrets, so they cannot use the Limrun API key. Run previews only for
trusted changes; the action does not support `pull_request_target`.

## Development

Node 24 matches the GitHub Actions runtime:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Commit `dist/` with source changes. CI rebuilds the action and checks that the
bundle is current. Package version `0.1.0` is the initial release; publish the
matching `v0.1.0` Git tag from the merged commit.
