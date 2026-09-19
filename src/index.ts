/**
 * 拡張が公開するパネルの登録。
 *
 * <p>⚠️ <b>パネル名は Studio の保存済みレイアウトが参照する識別子。</b>
 * 変えると既存のレイアウトでそのパネルが「不明なパネル」になり、置き直しが要る。
 * 2026-09-19 に crane- の接頭辞を外した（本家 crane_visualizer から
 * 借りて始めたが、中身はもう自分たちの実装なので）。
 */

import { ExtensionContext } from "@foxglove/studio";
import { initPanel } from "./crane_visualizer_panel";
import { initConfigPanel } from "./config_panel";
import { initUiControlPanel } from "./ui_control_panel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "visualizer-panel", initPanel: initPanel });
  extensionContext.registerPanel({
    name: "control-panel",
    initPanel: initUiControlPanel,
  });
  extensionContext.registerPanel({
    name: "config-panel",
    initPanel: initConfigPanel,
  });
}
