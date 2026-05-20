/**
 * Semantic-release config for obsidian-qmd-search.
 *
 * Tag format matches existing history (no 'v' prefix): 0.12.10, 0.12.11, …
 * The release commit uses [skip ci] so the release.yml workflow does not
 * re-trigger on its own push back to main.
 *
 * Artifact packaging (obsidian-qmd-search.zip) happens in the release.yml
 * workflow before `npx semantic-release` runs, so the zip is already on disk
 * when @semantic-release/github publishes it.
 *
 * Release-note filtering:
 *   - fix(ci): and fix(docs): commits do NOT trigger releases (accumulated
 *     into the next user-facing fix/feat). Prevents version churn from
 *     CI-only patches.
 *   - The notes generator uses the conventionalcommits preset so that chore,
 *     ci, docs, refactor, and build commits are hidden from CHANGELOG.md and
 *     GitHub Release notes even when they are bundled into a release.
 */
export default {
  branches: ['main'],
  tagFormat: '${version}',

  plugins: [
    // Determine bump level from conventional commits
    ['@semantic-release/commit-analyzer', {
      preset: 'angular',
      releaseRules: [
        { type: 'feat',     release: 'minor' },
        // Internal-only fix scopes accumulate silently into the next real release
        { type: 'fix',      scope: 'ci',     release: false },
        { type: 'fix',      scope: 'docs',   release: false },
        { type: 'fix',      release: 'patch' },
        { type: 'perf',     release: 'patch' },
        { type: 'refactor', release: 'patch' },
        { breaking: true,   release: 'major' },
      ],
    }],

    // Generate human-readable release notes — hidden types are excluded from
    // both CHANGELOG.md and GitHub Release notes.
    ['@semantic-release/release-notes-generator', {
      preset: 'conventionalcommits',
      presetConfig: {
        types: [
          { type: 'feat',     section: 'Features',     hidden: false },
          { type: 'fix',      section: 'Bug Fixes',     hidden: false },
          { type: 'perf',     section: 'Performance',   hidden: false },
          { type: 'refactor', hidden: true },
          { type: 'docs',     hidden: true },
          { type: 'chore',    hidden: true },
          { type: 'ci',       hidden: true },
          { type: 'build',    hidden: true },
          { type: 'test',     hidden: true },
          { type: 'style',    hidden: true },
        ],
      },
    }],

    // Prepend to CHANGELOG.md
    ['@semantic-release/changelog', {
      changelogFile: 'CHANGELOG.md',
    }],

    // Bump manifest.json + versions.json to the new version
    ['@semantic-release/exec', {
      prepareCmd: 'node scripts/bump-version.mjs ${nextRelease.version}',
    }],

    // Commit release artifacts back to main with [skip ci]
    ['@semantic-release/git', {
      assets: ['CHANGELOG.md', 'manifest.json', 'versions.json', 'main.js', 'styles.css'],
      message: 'chore(release): ${nextRelease.version} [skip ci]',
    }],

    // Create GitHub release with built artifacts
    ['@semantic-release/github', {
      assets: [
        { path: 'main.js',                    label: 'main.js' },
        { path: 'manifest.json',              label: 'manifest.json' },
        { path: 'styles.css',                 label: 'styles.css' },
        { path: 'obsidian-qmd-search.zip',    label: 'obsidian-qmd-search.zip' },
      ],
    }],
  ],
};
