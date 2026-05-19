// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFile } = require('child_process') as typeof import('child_process');

import { App, Modal, Notice } from 'obsidian';
import type QmdSearchPlugin from '../main';
import { buildEnv } from '../util/env';

interface Step {
  id: string;
  title: string;
  detail: string;
  done: boolean;
}

export class OnboardingModal extends Modal {
  private currentStep = 0;
  private steps: Step[] = [];
  private stepsEl!: HTMLElement;
  private progressEl!: HTMLElement;

  constructor(app: App, private readonly plugin: QmdSearchPlugin) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    this.modalEl.addClass('qmd-onboarding-modal');

    contentEl.createEl('h2', { text: 'Let\'s get QMD ready', cls: 'qmd-onboarding-title' });
    contentEl.createEl('p', {
      text: 'QMD adds semantic + hybrid search to Obsidian. Three quick steps, all local.',
      cls: 'qmd-onboarding-subtitle',
    });

    this.progressEl = contentEl.createDiv({ cls: 'qmd-onboarding-progress' });

    this.stepsEl = contentEl.createDiv({ cls: 'qmd-onboarding-steps' });

    const footer = contentEl.createDiv({ cls: 'qmd-onboarding-footer' });
    const skipBtn = footer.createEl('button', { text: 'Skip — I\'ll set it up later', cls: 'qmd-onboarding-skip' });
    const continueBtn = footer.createEl('button', { text: 'Continue →', cls: 'qmd-onboarding-continue mod-cta' });

    skipBtn.addEventListener('click', () => {
      this.plugin.settings.onboardingDone = true;
      this.plugin.saveSettings(false).catch(console.error);
      this.close();
    });

    continueBtn.addEventListener('click', () => {
      if (this.currentStep >= this.steps.length - 1) {
        this.plugin.settings.onboardingDone = true;
        this.plugin.saveSettings(false).catch(console.error);
        this.close();
      } else {
        this.currentStep++;
        this.render();
      }
    });

    await this.buildSteps();
    this.render();
  }

  private async buildSteps(): Promise<void> {
    // Step 1: Binary detected
    const binaryOk = this.plugin.resolvedBinaryPath !== 'qmd';
    let binaryVersion = '';
    if (binaryOk) {
      try {
        binaryVersion = await new Promise<string>((resolve, reject) => {
          execFile(this.plugin.resolvedBinaryPath, ['--version'], { timeout: 5000, env: buildEnv() }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout.trim());
          });
        });
      } catch {
        binaryVersion = '';
      }
    }

    // Step 2: Vault registered
    let collectionsCount = 0;
    try {
      const s = await this.plugin.client.status();
      collectionsCount = s.collections.length;
    } catch {
      collectionsCount = 0;
    }

    this.steps = [
      {
        id: 'binary',
        title: 'qmd binary detected',
        detail: binaryOk
          ? `${this.plugin.resolvedBinaryPath}${binaryVersion ? ' · ' + binaryVersion : ''}`
          : 'qmd not found — set binary path in settings',
        done: binaryOk,
      },
      {
        id: 'vault',
        title: 'Vault registered as a collection',
        detail: collectionsCount > 0
          ? `${collectionsCount} collection${collectionsCount !== 1 ? 's' : ''} registered`
          : 'Not yet registered — click Register to add this vault',
        done: collectionsCount > 0,
      },
      {
        id: 'index',
        title: 'Build the initial index',
        detail: '~30s for 1,000 notes · runs in background',
        done: false,
      },
      {
        id: 'hotkey',
        title: 'Bind a hotkey for search',
        detail: 'Suggested: open Hotkeys and search for "QMD: Search"',
        done: false,
      },
    ];
  }

  private render(): void {
    this.renderProgress();
    this.renderSteps();
  }

  private renderProgress(): void {
    this.progressEl.empty();
    for (let i = 0; i < this.steps.length; i++) {
      const dot = this.progressEl.createSpan({
        cls: i <= this.currentStep ? 'qmd-progress-dot qmd-progress-dot--active' : 'qmd-progress-dot',
      });
      void dot;
    }
  }

  private renderSteps(): void {
    this.stepsEl.empty();
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      const isCurrent = i === this.currentStep;
      const isCompleted = step.done;

      const row = this.stepsEl.createDiv({
        cls: [
          'qmd-onboarding-step',
          isCompleted ? 'qmd-onboarding-step--done' : '',
          isCurrent ? 'qmd-onboarding-step--current' : '',
        ].filter(Boolean).join(' '),
      });

      const icon = row.createSpan({ cls: 'qmd-onboarding-step-icon' });
      icon.setText(isCompleted ? '✓' : i < this.currentStep ? '○' : '○');

      const content = row.createDiv({ cls: 'qmd-onboarding-step-content' });
      content.createEl('strong', { text: step.title, cls: 'qmd-onboarding-step-title' });
      content.createEl('div', { text: step.detail, cls: 'qmd-onboarding-step-detail' });

      // Action buttons for specific steps
      if (isCurrent && !isCompleted) {
        const actions = row.createDiv({ cls: 'qmd-onboarding-step-actions' });

        if (step.id === 'vault') {
          const regBtn = actions.createEl('button', { text: 'Register this vault', cls: 'mod-cta' });
          regBtn.addEventListener('click', async () => {
            regBtn.disabled = true;
            regBtn.textContent = 'Registering…';
            try {
              const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath ?? '';
              const vaultName = this.app.vault.getName();
              await new Promise<void>((resolve, reject) => {
                execFile(
                  this.plugin.resolvedBinaryPath,
                  ['collection', 'add', vaultPath, '--name', vaultName],
                  { timeout: 30_000, env: buildEnv() },
                  (err) => (err ? reject(err) : resolve()),
                );
              });
              new Notice(`QMD: vault registered as "${vaultName}" ✓`);
              step.done = true;
              step.detail = `${vaultName} · registered`;
              this.render();
            } catch (err) {
              new Notice(`QMD: registration failed — ${(err as Error).message}`);
              if (regBtn.isConnected) {
                regBtn.disabled = false;
                regBtn.textContent = 'Register this vault';
              }
            }
          });
        }

        if (step.id === 'index') {
          const idxBtn = actions.createEl('button', { text: 'Start indexing', cls: 'mod-cta' });
          idxBtn.addEventListener('click', async () => {
            idxBtn.disabled = true;
            idxBtn.textContent = 'Indexing…';
            step.detail = 'Indexing in background…';
            this.render();
            await this.plugin.reindex();
            step.done = true;
            step.detail = 'Index built ✓';
            this.render();
          });
        }

        if (step.id === 'hotkey') {
          const hotkeyBtn = actions.createEl('button', { text: 'Open Hotkeys', cls: 'mod-cta' });
          hotkeyBtn.addEventListener('click', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const appAny = this.app as any;
            if (appAny.setting) {
              appAny.setting.open();
              appAny.setting.openTabById?.('hotkeys');
            }
            step.done = true;
            this.render();
          });
        }
      }

      // Show ready badge for done steps
      if (isCompleted) {
        const badge = row.createSpan({ cls: 'qmd-onboarding-badge qmd-onboarding-badge--ready', text: 'ready ●' });
        void badge;
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
