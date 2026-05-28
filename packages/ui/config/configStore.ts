/**
 * ConfigStore — Zustand-based config for Plannotator
 *
 * Resolves settings with precedence: server config > cookie > default.
 * Selector-based subscriptions: components only re-render when their
 * specific setting changes (unlike the old broadcast-to-all pattern).
 *
 * Server-synced settings write back to ~/.plannotator/config.json
 * via a debounced POST /api/config.
 */

import { createStore, useStore } from 'zustand';
import { SETTINGS, type SettingName, type SettingsMap } from './settings';
import { apiFetch } from '../utils/api';

/** Infer the value type from a SettingDef */
export type SettingValue<K extends SettingName> = SettingsMap[K] extends { defaultValue: infer D }
  ? D extends (...args: unknown[]) => infer R ? R : D
  : never;

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

type ConfigState = {
  [K in SettingName]: SettingValue<K>;
} & {
  get: <K extends SettingName>(key: K) => SettingValue<K>;
  set: <K extends SettingName>(key: K, value: SettingValue<K>) => void;
  init: (serverConfig?: Record<string, unknown>) => void;
};

let pendingServerWrites: Record<string, unknown> = {};
let serverSyncTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleServerSync(): void {
  if (serverSyncTimer) clearTimeout(serverSyncTimer);
  serverSyncTimer = setTimeout(() => {
    const payload = { ...pendingServerWrites };
    pendingServerWrites = {};
    apiFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }, 300);
}

function resolveInitialValues(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(SETTINGS)) {
    const fromCookie = def.fromCookie();
    const defaultVal = typeof def.defaultValue === 'function'
      ? (def.defaultValue as () => unknown)()
      : def.defaultValue;
    const resolved = fromCookie ?? defaultVal;
    values[name] = resolved;
    if (fromCookie === undefined) {
      def.toCookie(resolved as never);
    }
  }
  return values;
}

export const configStore = createStore<ConfigState>()((setState, getState) => ({
  ...resolveInitialValues() as { [K in SettingName]: SettingValue<K> },

  get: <K extends SettingName>(key: K): SettingValue<K> => {
    return getState()[key] as SettingValue<K>;
  },

  set: <K extends SettingName>(key: K, value: SettingValue<K>): void => {
    const def = SETTINGS[key];
    def.toCookie(value as never);

    if (def.serverKey && def.toServer) {
      deepMerge(pendingServerWrites, def.toServer(value as never) as Record<string, unknown>);
      scheduleServerSync();
    }

    setState({ [key]: value } as Partial<ConfigState>);
  },

  init: (serverConfig?: Record<string, unknown>): void => {
    if (!serverConfig) return;
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
      setState(updates as Partial<ConfigState>);
    }
  },
}));

export function useConfigStore<T>(selector: (state: ConfigState) => T): T {
  return useStore(configStore, selector);
}
