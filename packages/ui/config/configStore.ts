/**
 * ConfigStore — Zustand-powered config resolver for Plannotator
 *
 * Vanilla Zustand store that resolves settings with precedence:
 *   server config file > cookie > default
 *
 * Works both inside and outside React. React components subscribe
 * via selector-based useConfigStore (see useConfig.ts), which only
 * re-renders when the selected setting actually changes.
 *
 * Server-synced settings automatically write back to ~/.plannotator/config.json
 * via a debounced POST /api/config.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { SETTINGS, type SettingName, type SettingsMap } from './settings';

/** Deep-merge source into target, recursing into plain objects. */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    if (
      typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key]) &&
      typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])
    ) {
      deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      target[key] = source[key];
    }
  }
}

/** Infer the value type from a SettingDef */
type SettingValue<K extends SettingName> = SettingsMap[K] extends { defaultValue: infer D }
  ? D extends (...args: unknown[]) => infer R ? R : D
  : never;

/** Map each SettingName to its resolved value type */
type SettingValues = {
  [K in SettingName]: SettingValue<K>;
};

/** Actions exposed on the store */
interface ConfigActions {
  /** Get a resolved config value. Works outside React. */
  get: <K extends SettingName>(key: K) => SettingValue<K>;
  /** Set a config value. Writes cookie (sync), queues server write-back if applicable. */
  set: <K extends SettingName>(key: K, value: SettingValue<K>) => void;
  /**
   * Apply server config overrides.
   * Call once after fetching /api/plan or /api/diff.
   */
  init: (serverConfig?: Record<string, unknown>) => void;
}

type ConfigState = SettingValues & ConfigActions;

// --- Server sync state (module-scoped, not part of Zustand state) ---
let pendingServerWrites: Record<string, unknown> = {};
let serverSyncTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleServerSync(): void {
  if (serverSyncTimer) clearTimeout(serverSyncTimer);
  serverSyncTimer = setTimeout(() => {
    const payload = { ...pendingServerWrites };
    pendingServerWrites = {};
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {}); // best-effort
  }, 300);
}

// --- Resolve initial values from cookie > default ---
function resolveInitialValues(): SettingValues {
  const values: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(SETTINGS)) {
    const fromCookie = def.fromCookie();
    const defaultVal = typeof def.defaultValue === 'function'
      ? (def.defaultValue as () => unknown)()
      : def.defaultValue;
    const resolved = fromCookie ?? defaultVal;
    values[name] = resolved;
    // Persist generated defaults to cookie so the value is stable across calls
    if (fromCookie === undefined) {
      def.toCookie(resolved as never);
    }
  }
  return values as SettingValues;
}

export const configStore = createStore<ConfigState>()((set, get) => ({
  // Spread all resolved setting values as top-level state
  ...resolveInitialValues(),

  get: <K extends SettingName>(key: K): SettingValue<K> => {
    return get()[key] as SettingValue<K>;
  },

  set: <K extends SettingName>(key: K, value: SettingValue<K>): void => {
    const def = SETTINGS[key];
    def.toCookie(value as never);

    if (def.serverKey && def.toServer) {
      deepMerge(pendingServerWrites, def.toServer(value as never) as Record<string, unknown>);
      scheduleServerSync();
    }

    set({ [key]: value } as Partial<ConfigState>);
  },

  init: (serverConfig?: Record<string, unknown>): void => {
    if (serverConfig) {
      const updates: Record<string, unknown> = {};
      for (const [name, def] of Object.entries(SETTINGS)) {
        if (def.serverKey && def.fromServer) {
          const fromServer = def.fromServer(serverConfig);
          if (fromServer !== undefined) {
            updates[name] = fromServer;
            def.toCookie(fromServer as never);
          }
        }
      }
      if (Object.keys(updates).length > 0) {
        set(updates as Partial<ConfigState>);
      }
    }
  },
}));

/** React hook for consuming the Zustand config store with selectors. */
export function useConfigStore<T>(selector: (state: ConfigState) => T): T {
  return useStore(configStore, selector);
}

export type { SettingValue, ConfigState };
