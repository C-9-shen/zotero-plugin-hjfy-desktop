import { config } from "../../package.json";

type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];

export function getPref<K extends keyof PluginPrefsMap>(key: K) {
  return Zotero.Prefs.get(
    `${config.prefsPrefix}.${key}`,
    true,
  ) as PluginPrefsMap[K];
}
