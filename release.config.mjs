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
        { type: 'fix',      release: 'patch' },
        { type: 'perf',     release: 'patch' },
        { type: 'refactor', release: 'patch' },
        { breaking: true,   release: 'major' },
      ],
    }],

    // Generate human-readable release notes
    '@semantic-release/release-notes-generator',

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
