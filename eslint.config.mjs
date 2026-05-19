import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores } from 'eslint/config';

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mjs'],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			// require() is intentional — Obsidian runs in Electron; Node built-ins
			// must be loaded via require() to avoid esbuild's module resolution.
			'@typescript-eslint/no-require-imports': 'off',

			// TypeScript handles undefined variable checking better than ESLint.
			// no-undef false-positives on TypeScript global namespaces (NodeJS, etc.).
			'no-undef': 'off',

			'@typescript-eslint/no-explicit-any': 'warn',

			// TODO: audit all unsafe-any usages and add proper type narrowing
			'@typescript-eslint/no-unsafe-assignment': 'warn',
			'@typescript-eslint/no-unsafe-call': 'warn',
			'@typescript-eslint/no-unsafe-member-access': 'warn',
			'@typescript-eslint/no-misused-promises': 'warn',

			// TODO: rename command/setting strings to sentence case per Obsidian guidelines
			'obsidianmd/ui/sentence-case': 'warn',

			// TODO: replace inline style assignments with CSS classes
			'obsidianmd/no-static-styles-assignment': 'warn',

			// TODO: replace createEl('h2') with Setting.setHeading() in settings tab
			'obsidianmd/settings-tab/no-manual-html-headings': 'warn',

			// innerHTML use: confined to snippet rendering — review before promoting to error
			'@microsoft/sdl/no-inner-html': 'warn',
		},
	},
	globalIgnores([
		'node_modules',
		'main.js',
		'esbuild.config.mjs',
		'eslint.config.mjs',
		'scripts/',
	]),
);
