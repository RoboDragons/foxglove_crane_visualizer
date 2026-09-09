/**
 * 名前空間ツリーの検算。
 *
 * <p>このリポジトリにはテストランナーが無いので、node で直接動かす形にしてある。
 * `npm run check` で走る。
 *
 * <p><b>ここを空にしないこと。</b> Namespaces まわりの不具合は
 * 「絵は正しく変わるのに保存されていない」のように画面から気づけない形で出る。
 * 型検査では捕まらないので、純関数だけでも動かして確かめる。
 */

import {
  NamespaceMap,
  collectVisibleLayers,
  hasNamespaceNode,
  migrateNamespaces,
  withLayerAdded,
  withNamespaceVisible,
} from "./namespace_tree";

let pass = 0;
let fail = 0;
const eq = (name: string, actual: unknown, expected: unknown): void => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    console.log("FAIL", name, "\n  actual  ", a, "\n  expected", e);
  }
};

// --- レイヤーの差し込み ---
let ns: NamespaceMap = {};
for (const layer of ["field/background", "field/lines", "robots/blue/positions", "robots/yellow/positions"]) {
  ns = withLayerAdded(ns, layer, true);
}
eq("階層のキー", Object.keys(ns), ["field", "robots"]);
eq("配下のキー", Object.keys(ns.field!.children!), ["background", "lines"]);
eq("孫のキー", Object.keys(ns.robots!.children!.blue!.children!), ["positions"]);

// 二重登録しても増えない・参照も変わらない
const same = withLayerAdded(ns, "field/lines", true);
eq("既存レイヤーは参照ごと据え置き", same === ns, true);

// visible_by_default=false は葉にだけ効く
const ns2 = withLayerAdded({}, "paths/blue/candidates", false);
eq("既定非表示の葉", ns2.paths!.children!.blue!.children!.candidates!.visible, false);
eq("途中の階層は表示", ns2.paths!.visible, true);

// --- 表示中レイヤーの集合 ---
eq("全部表示", [...collectVisibleLayers(ns)].sort(),
   ["field", "field/background", "field/lines", "robots", "robots/blue",
    "robots/blue/positions", "robots/yellow", "robots/yellow/positions"].sort());
eq("既定非表示は入らない", collectVisibleLayers(ns2).has("paths/blue/candidates"), false);

// --- 親の切替が配下へ伝播する ---
const hidden = withNamespaceVisible(ns, ["robots"], false);
eq("親を消すと配下も消える", hidden.robots!.children!.blue!.children!.positions!.visible, false);
eq("別の枝は無傷", hidden.field!.children!.lines!.visible, true);
eq("集合からも消える", collectVisibleLayers(hidden).has("robots/blue/positions"), false);
eq("元のツリーは壊さない", ns.robots!.children!.blue!.children!.positions!.visible, true);

const shown = withNamespaceVisible(hidden, ["robots"], true);
eq("戻すと配下も戻る", collectVisibleLayers(shown).has("robots/yellow/positions"), true);

// 隠した親の下の葉を表示にすると、先祖も開く
const leafOn = withNamespaceVisible(hidden, ["robots", "blue", "positions"], true);
eq("先祖も開く", collectVisibleLayers(leafOn).has("robots/blue/positions"), true);
eq("兄弟は消えたまま", collectVisibleLayers(leafOn).has("robots/yellow/positions"), false);

// 値が変わらないなら参照も変えない（無駄な saveState を避ける）
eq("変化なしは同一参照", withNamespaceVisible(ns, ["field"], true) === ns, true);
eq("知らないパスは同一参照", withNamespaceVisible(ns, ["nope"], false) === ns, true);

// --- ノードの存在判定 ---
eq("実在するノード", hasNamespaceNode(ns, ["robots", "blue"]), true);
eq("存在しないノード", hasNamespaceNode(ns, ["robots", "visible"]), false);

// --- 平坦だった保存状態の移行 ---
const migrated = migrateNamespaces({
  "field/background": { visible: true },
  "robots/blue/positions": { visible: false },
});
eq("移行後のキー", Object.keys(migrated), ["field", "robots"]);
eq("移行後も非表示を保つ", migrated.robots!.children!.blue!.children!.positions!.visible, false);
eq("移行後の集合", collectVisibleLayers(migrated).has("field/background"), true);
const alreadyTree = { field: { visible: true, children: { lines: { visible: true } } } };
eq("ツリーはそのまま", migrateNamespaces(alreadyTree) === alreadyTree, true);
eq("未保存は空", migrateNamespaces(undefined), {});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
