import { config } from "../../package.json";
import { FluentMessageId } from "../../typings/i10n";

export function initLocale() {
  const l10n = new (
    typeof Localization === "undefined"
      ? ztoolkit.getGlobal("Localization")
      : Localization
  )([`${config.addonRef}-addon.ftl`], true);
  addon.data.locale = {
    current: l10n,
  };
}

export function getString(localeString: FluentMessageId): string {
  const id = `${config.addonRef}-${localeString}`;
  const pattern = addon.data.locale?.current.formatMessagesSync([{ id }])[0];
  return pattern?.value || id;
}
