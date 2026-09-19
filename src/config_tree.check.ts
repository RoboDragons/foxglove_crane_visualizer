/**
 * 設定ツリーの検算。
 *
 * <p>このリポジトリにはテストランナーが無いので、node で直接動かす形にしてある。
 * `npm run check` で走る。
 *
 * <p><b>ここを空にしないこと。</b> 約 200 件を木に組み直す処理の不具合は
 * 「画面は出るが行がどこかに紛れている」形で出る。型検査では捕まらない。
 */

import {
  ConfigNode,
  TreeGroup,
  allGroupPaths,
  buildTree,
  countLeaves,
  displayValue,
  elementKind,
  filterTree,
  isArrayKind,
  isNumericKind,
  lastSegment,
  normalizeLayout,
  parseArray,
  parseValue,
  toArray,
  toKind,
} from "./config_tree";

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

const leaf = (path: string, kind: ConfigNode["kind"] = "BOOL"): ConfigNode => ({
  path,
  label: lastSegment(path),
  kind,
  choices: [],
  needsReboot: false,
  risky: false,
});

// --- 正規化 ---
eq("メッセージでないものは undefined", normalizeLayout(undefined), undefined);
eq("nodes が無ければ undefined", normalizeLayout({}), undefined);
eq(
  "proto3 の既定値を埋める",
  normalizeLayout({ nodes: [{ path: "useSwingGui" }] }),
  [
    {
      path: "useSwingGui",
      label: "useSwingGui",
      kind: "KIND_UNSPECIFIED",
      choices: [],
      needsReboot: false,
      risky: false,
    },
  ],
);
eq("path が空のノードは捨てる", normalizeLayout({ nodes: [{ label: "x" }] }), []);
eq(
  "label が無ければパスの末尾で補う",
  normalizeLayout({ nodes: [{ path: "a.b.c" }] })?.[0]?.label,
  "c",
);
eq(
  "知らない kind は未設定に倒す",
  normalizeLayout({ nodes: [{ path: "a", kind: "WAT" }] })?.[0]?.kind,
  "KIND_UNSPECIFIED",
);

// --- kind の正規化（Studio は proto の enum を数値で渡してくる） ---
eq("数値の 1 は BOOL", toKind(1), "BOOL");
eq("数値の 6 は INT_ARRAY", toKind(6), "INT_ARRAY");
eq("数値の 0 は未設定", toKind(0), "KIND_UNSPECIFIED");
eq("範囲外の数値は未設定", toKind(99), "KIND_UNSPECIFIED");
eq("定数名でも受ける", toKind("ENUM"), "ENUM");
eq("知らない文字列は未設定", toKind("WAT"), "KIND_UNSPECIFIED");
eq("欠けていれば未設定", toKind(undefined), "KIND_UNSPECIFIED");
eq(
  "数値で届いた kind をメッセージから読める",
  normalizeLayout({ nodes: [{ path: "a", kind: 1 }] })?.[0]?.kind,
  "BOOL",
);
eq(
  "スネークケースの needs_reboot も読む",
  normalizeLayout({ nodes: [{ path: "a", needs_reboot: true }] })?.[0]?.needsReboot,
  true,
);

// --- 木の構築 ---
const nodes = [
  leaf("useSwingGui"),
  leaf("networks.vision.port", "INT"),
  leaf("networks.vision.hostAddress", "STRING"),
  leaf("networks.useVisionTracker"),
  leaf("visibility.pathVisible"),
];
const tree = buildTree(nodes);
eq("ルートの並びは登場順", tree.map((i) => i.path), ["useSwingGui", "networks", "visibility"]);
eq("ルート直下の葉は葉のまま", tree[0]?.type, "leaf");
eq("枝になる", tree[1]?.type, "group");
eq(
  "同じ枝を2度作らない",
  (tree[1] as TreeGroup).children.map((i) => i.path),
  ["networks.vision", "networks.useVisionTracker"],
);
eq(
  "孫まで辿れる",
  ((tree[1] as TreeGroup).children[0] as TreeGroup).children.map((i) => i.label),
  ["port", "hostAddress"],
);
eq("葉の総数は入力と一致", countLeaves(tree), nodes.length);
eq("枝のパスを全部集める", allGroupPaths(tree), [
  "networks",
  "networks.vision",
  "visibility",
]);

// --- 絞り込み ---
eq("空の絞り込みは素通し", countLeaves(filterTree(tree, "  ")), nodes.length);
eq("部分一致で葉を残す", countLeaves(filterTree(tree, "port")), 1);
eq(
  "残った葉を持つ枝だけ残る",
  filterTree(tree, "port").map((i) => i.path),
  ["networks"],
);
eq("大文字小文字を区別しない", countLeaves(filterTree(tree, "PORT")), 1);
eq("一致しなければ空", filterTree(tree, "zzz"), []);
eq(
  "枝の名前でも当たる（配下が全部残る）",
  countLeaves(filterTree(tree, "networks")),
  3,
);

// --- 種類 ---
eq("配列の種類", [isArrayKind("INT_ARRAY"), isArrayKind("INT")], [true, false]);
eq("要素の種類", elementKind("STRING_ARRAY"), "STRING");
eq("配列でなければそのまま", elementKind("BOOL"), "BOOL");
eq("配列でない値は空配列", toArray(5), []);
eq("配列はそのまま", toArray([1, 2]), [1, 2]);

// --- 値の変換 ---
eq("整数を受ける", parseValue("INT", " 12 "), { ok: true, value: 12 });
eq("整数に小数は入れない", parseValue("INT", "1.5").ok, false);
eq("整数に文字は入れない", parseValue("INT", "abc").ok, false);
eq("負の整数", parseValue("INT", "-3"), { ok: true, value: -3 });
eq("安全な範囲を超えたら弾く", parseValue("INT", "9".repeat(20)).ok, false);
eq("小数を受ける", parseValue("DOUBLE", "1.5"), { ok: true, value: 1.5 });
eq("小数に整数も入る", parseValue("DOUBLE", "2"), { ok: true, value: 2 });
eq("空は数値にしない", parseValue("DOUBLE", "  ").ok, false);
eq("文字列は前後の空白を保つ", parseValue("STRING", " a "), { ok: true, value: " a " });
eq("配列そのものは入力欄で扱わない", parseValue("INT_ARRAY", "[]").ok, false);

// --- 表示 ---
eq("数値の種類", [isNumericKind("INT"), isNumericKind("DOUBLE"), isNumericKind("STRING")], [true, true, false]);
eq("配列は括弧なしで区切る", displayValue("INT_ARRAY", [0, 1, 2]), "0, 1, 2");
eq("空の配列は空文字", displayValue("STRING_ARRAY", []), "");
eq("配列でない値が来ても落ちない", displayValue("INT_ARRAY", 5), "");
eq("スカラーはそのまま", displayValue("DOUBLE", 0.5), "0.5");
eq("値が無ければ空文字", displayValue("STRING", undefined), "");

// --- 配列の編集（表示と同じ文字をその場で直す） ---
eq("カンマ区切りを読む", parseArray("INT_ARRAY", "0, 1, 2"), { ok: true, value: [0, 1, 2] });
eq("表示した文字がそのまま読める", parseArray("INT_ARRAY", displayValue("INT_ARRAY", [3, 5])), {
  ok: true,
  value: [3, 5],
});
eq("空白は無くてもよい", parseArray("INT_ARRAY", "1,2"), { ok: true, value: [1, 2] });
eq("末尾のカンマは無視", parseArray("INT_ARRAY", "0, 1,"), { ok: true, value: [0, 1] });
eq("連続したカンマも無視", parseArray("INT_ARRAY", "0,, 1"), { ok: true, value: [0, 1] });
eq("空なら空配列", parseArray("INT_ARRAY", "  "), { ok: true, value: [] });
eq("整数の配列に小数は入れない", parseArray("INT_ARRAY", "0, 1.5").ok, false);
eq(
  "何番目が悪いかを言う",
  parseArray("INT_ARRAY", "0, x"),
  { ok: false, message: "2 番目の要素: 整数で入力してください" },
);
eq("小数の配列", parseArray("DOUBLE_ARRAY", "0.5, 2"), { ok: true, value: [0.5, 2] });
eq("文字列の配列は前後の空白を落とす", parseArray("STRING_ARRAY", " robot , path "), {
  ok: true,
  value: ["robot", "path"],
});
eq("配列でない種類は弾く", parseArray("INT", "1").ok, false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
