import { useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Popover } from '@base-ui/react/popover';
import type { ChatModelPreference, ChatReasoningEffort } from '@moonbase/contracts/chat';
import { controls } from '@moonbase/ui/controls';
import { overlays } from '@moonbase/ui/overlays';
import { colors, radius, shadow, space, type } from '@moonbase/ui/tokens.stylex';
import { Icon } from '../icon.tsx';
import { providerLabel, type Provider } from './vendors.ts';

export type ModelPickerProps = {
  /** Providers that are set up; only these are listed. */
  providers: readonly Provider[];
  model: ChatModelPreference['model'] | undefined;
  effort: ChatReasoningEffort | undefined;
  /** False when the saved effort is not one this model offers. */
  effortAvailable: boolean;
  effortLabels: Record<ChatReasoningEffort, string>;
  chooseModel(model: ChatModelPreference['model']): void;
  chooseEffort(effort: ChatReasoningEffort): void;
  setUpProviders?: () => void;
  disabled?: boolean;
};

/**
 * One chip for the new chat's model and reasoning effort. Its popover lists the providers that
 * are set up, the chosen provider's models beside them, and the effort the model offers below.
 */
export function ModelPicker({
  providers,
  model,
  effort,
  effortAvailable,
  effortLabels,
  chooseModel,
  chooseEffort,
  setUpProviders,
  disabled = false,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const current = providers.find((provider) => provider.id === model?.provider);
  const currentModel = current?.models.find((item) => item.modelId === model?.modelId);
  const [browsing, setBrowsing] = useState<string | null>(null);
  // Opening focuses the chosen model, so the list starts on its provider.
  const chosenButton = useRef<HTMLButtonElement>(null);
  const shown = providers.find((provider) => provider.id === browsing) ?? current ?? providers[0];
  const efforts = currentModel?.reasoningEfforts ?? [];
  let label = 'Choose a model';
  if (!providers.length) label = 'Set up a provider';
  else if (currentModel) label = currentModel.name;
  else if (model) label = model.modelId;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setBrowsing(null);
      }}>
      <Popover.Trigger
        aria-label="Conversation model"
        disabled={disabled}
        {...stylex.props(controls.button, controls.quietButton, styles.chip)}>
        <span {...stylex.props(controls.truncate)}>{label}</span>
        {efforts.length > 0 && effort && effortAvailable && (
          <span {...stylex.props(styles.chipEffort)}>· {effortLabels[effort]}</span>
        )}
        <span aria-hidden="true" {...stylex.props(styles.caret)}>
          ▾
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          {...stylex.props(overlays.positioner)}>
          <Popover.Popup
            aria-label="Choose model"
            initialFocus={() => chosenButton.current ?? true}
            {...stylex.props(styles.popup)}>
            {providers.length ? (
              <div {...stylex.props(styles.panes)}>
                <div role="group" aria-label="Providers" {...stylex.props(styles.providers)}>
                  {providers.map((provider) => (
                    <button
                      key={provider.id}
                      type="button"
                      aria-pressed={provider.id === shown?.id}
                      {...stylex.props(styles.provider, provider.id === shown?.id && styles.shown)}
                      onMouseEnter={() => setBrowsing(provider.id)}
                      onFocus={() => setBrowsing(provider.id)}
                      onClick={() => setBrowsing(provider.id)}>
                      <span {...stylex.props(controls.truncate, controls.grow)}>
                        {providerLabel(provider, providers)}
                      </span>
                      <span {...stylex.props(styles.count)}>{provider.models.length}</span>
                      <span aria-hidden="true" {...stylex.props(styles.arrow)}>
                        <Icon name="chevronRight" />
                      </span>
                    </button>
                  ))}
                </div>
                <div
                  role="group"
                  aria-label={shown ? `${providerLabel(shown, providers)} models` : 'Models'}
                  {...stylex.props(styles.models)}>
                  {shown?.models.map((item) => {
                    const chosen = shown.id === model?.provider && item.modelId === model.modelId;
                    const fallback =
                      shown.defaultModel?.model.modelId === item.modelId ? 'default' : '';
                    return (
                      <button
                        key={item.modelId}
                        type="button"
                        aria-pressed={chosen}
                        ref={chosen ? chosenButton : undefined}
                        {...stylex.props(styles.model, chosen && styles.chosen)}
                        onClick={() => {
                          chooseModel({ provider: shown.id, modelId: item.modelId });
                          setOpen(false);
                        }}>
                        <span aria-hidden="true" {...stylex.props(styles.check)}>
                          {chosen ? '✓' : ''}
                        </span>
                        <span {...stylex.props(controls.truncate, controls.grow)}>{item.name}</span>
                        {fallback && <span {...stylex.props(styles.count)}>{fallback}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p {...stylex.props(styles.empty)}>
                No provider is set up yet. Sign in or add an API key to choose a model.
              </p>
            )}
            {efforts.length > 0 && (
              <div {...stylex.props(styles.effortRow)}>
                <span id="reasoning-effort-label" {...stylex.props(styles.heading)}>
                  Reasoning effort
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby="reasoning-effort-label"
                  {...stylex.props(styles.efforts)}>
                  {efforts.map((value) => {
                    const checked = effortAvailable && value === effort;
                    return (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        {...stylex.props(styles.effort, checked && styles.effortChecked)}
                        onClick={() => chooseEffort(value)}>
                        {effortLabels[value]}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {setUpProviders && (
              <button
                type="button"
                aria-label="Set up providers…"
                {...stylex.props(styles.footer)}
                onClick={() => {
                  setOpen(false);
                  setUpProviders();
                }}>
                <Icon name="key" />
                Set up providers…
                <span {...stylex.props(styles.shortcut)}>⌘,</span>
              </button>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

const styles = stylex.create({
  chip: {
    height: 30,
    maxWidth: 280,
    minWidth: 0,
    padding: '0 10px',
    gap: 6,
    borderRadius: radius.row,
  },
  chipEffort: { flexShrink: 0, color: colors.secondary },
  caret: { color: colors.muted },
  popup: {
    width: 'min(460px, calc(100vw - 24px))',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: type.ui,
    fontSize: type.body,
    color: colors.text,
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.controlBorder,
    borderRadius: radius.panel,
    boxShadow: shadow.raised,
    outline: 'none',
  },
  panes: { display: 'flex', minHeight: 0, maxHeight: 'min(320px, 50vh)' },
  providers: {
    flexShrink: 0,
    width: 150,
    padding: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    overflowY: 'auto',
    borderRightWidth: 1,
    borderRightStyle: 'solid',
    borderRightColor: colors.border,
  },
  provider: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    minWidth: 0,
    padding: '7px 8px',
    borderWidth: 0,
    borderRadius: radius.row,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.secondary,
    font: 'inherit',
    fontSize: type.small,
    textAlign: 'left',
    cursor: 'pointer',
  },
  shown: {
    backgroundColor: { default: colors.selected, ':hover': colors.selectedHover },
    color: colors.text,
  },
  count: { flexShrink: 0, color: colors.muted, fontSize: type.caption },
  arrow: { display: 'inline-flex', flexShrink: 0, color: colors.muted },
  models: {
    flex: 1,
    minWidth: 0,
    padding: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    overflowY: 'auto',
  },
  model: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    minWidth: 0,
    flexShrink: 0,
    padding: '6px 8px',
    borderWidth: 0,
    borderRadius: radius.row,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.secondary,
    font: 'inherit',
    fontSize: type.small,
    textAlign: 'left',
    cursor: 'pointer',
  },
  chosen: { color: colors.text, fontWeight: 600 },
  check: { flexShrink: 0, width: 12, color: colors.text },
  empty: { margin: 0, padding: space.md, color: colors.muted, fontSize: type.small },
  effortRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '8px 10px 10px',
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
  },
  heading: {
    color: colors.muted,
    fontSize: 10.5,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  efforts: {
    display: 'flex',
    gap: 2,
    padding: 2,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  effort: {
    flex: 1,
    padding: '5px 0',
    borderWidth: 0,
    borderRadius: 6,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.secondary,
    font: 'inherit',
    fontSize: type.small,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  effortChecked: {
    backgroundColor: { default: colors.accent, ':hover': colors.accent },
    color: colors.onAccent,
    fontWeight: 600,
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    padding: '8px 12px',
    borderWidth: 0,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.secondary,
    font: 'inherit',
    fontSize: type.small,
    textAlign: 'left',
    cursor: 'pointer',
  },
  shortcut: { marginLeft: 'auto', color: colors.muted },
});
