/**
 * React hook for consuming ConfigStore values.
 *
 * Uses Zustand's selector-based subscriptions — only re-renders
 * when the specific setting changes, not on every store update.
 */

import { useConfigStore } from './configStore';
import type { SettingValue } from './configStore';
import type { SettingName } from './settings';

/** Read a config value reactively. Re-renders only when this setting changes. */
export function useConfigValue<K extends SettingName>(key: K): SettingValue<K> {
  return useConfigStore(s => s[key]) as SettingValue<K>;
}
