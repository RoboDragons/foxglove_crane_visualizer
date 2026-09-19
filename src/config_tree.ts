/**
 * 設定パネルのロジック。React にも Foxglove にも触れない純関数だけを置く。
 *
 * <p>`namespace_tree.ts` と同じ扱いで、`npm run check` から node で直接動かして検算する。
 * このリポジトリにテストランナーは無く、ツリーまわりの不具合は
 * 「画面は出るが中身が間違っている」形で出るため、型検査では捕まらない。
 */

/** `foxglove.ConfigNode.Kind` に対応する。proto3 の既定値は KIND_UNSPECIFIED */
export type ConfigKind =
  | "KIND_UNSPECIFIED"
  | "BOOL"
  | "INT"
  | "DOUBLE"
  | "STRING"
  | "ENUM"
  | "INT_ARRAY"
  | "DOUBLE_ARRAY"
  | "STRING_ARRAY";

/** `foxglove.ConfigNode` に対応する型。proto3 の既定値を埋めた正規化済みの形 */
export interface ConfigNode {
  /** ドット区切りの完全な名前。parameter の名前と一致する */
  path: string;
  /** 画面に出す名前。path の最後の要素 */
  label: string;
  kind: ConfigKind;
  /** kind = "ENUM" のときの定数名 */
  choices: string[];
  /** 起動時にしか読まれない値か */
  needsReboot: boolean;
  /** 組で意味を持ち、走行中の読み手がいる値か */
  risky: boolean;
}

/** ツリーの葉。入力欄を1つ描く */
export interface TreeLeaf {
  type: "leaf";
  /** ドット区切りの完全な名前 */
  path: string;
  label: string;
  node: ConfigNode;
}

/** ツリーの枝。折りたたみの単位になる */
export interface TreeGroup {
  type: "group";
  /** ここまでのドット区切りの名前。折りたたみ状態のキーに使う */
  path: string;
  label: string;
  children: TreeItem[];
}

export type TreeItem = TreeLeaf | TreeGroup;

// ---------------------------------------------------------------------------
// 正規化
// ---------------------------------------------------------------------------

const KINDS: ReadonlySet<string> = new Set([
  "KIND_UNSPECIFIED",
  "BOOL",
  "INT",
  "DOUBLE",
  "STRING",
  "ENUM",
  "INT_ARRAY",
  "DOUBLE_ARRAY",
  "STRING_ARRAY",
]);

/**
 * 受信したメッセージを `ConfigNode[]` に正規化する。
 *
 * <p>proto3 の既定値は省略されて届くので、欠けたフィールドをここで埋める。
 * path が無いものは捨てる。パネルはこれを parameter 名として使うため、
 * 空のまま通すと「書き込めない行」になる。
 *
 * @returns 正規化した並び。メッセージの形が違えば `undefined`
 */
export function normalizeLayout(message: unknown): ConfigNode[] | undefined {
  if (typeof message !== "object" || message == undefined) {
    return undefined;
  }
  const raw = (message as { nodes?: unknown }).nodes;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const nodes: ConfigNode[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry == undefined) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const path = typeof record["path"] === "string" ? record["path"] : "";
    if (path.length === 0) {
      continue;
    }
    const kindValue = record["kind"];
    const kind =
      typeof kindValue === "string" && KINDS.has(kindValue)
        ? (kindValue as ConfigKind)
        : "KIND_UNSPECIFIED";
    const label = typeof record["label"] === "string" ? record["label"] : lastSegment(path);
    const choices = Array.isArray(record["choices"])
      ? record["choices"].filter((c): c is string => typeof c === "string")
      : [];
    nodes.push({
      path,
      label: label.length > 0 ? label : lastSegment(path),
      kind,
      choices,
      needsReboot: record["needsReboot"] === true || record["needs_reboot"] === true,
      risky: record["risky"] === true,
    });
  }
  return nodes;
}

/** ドット区切りの最後の要素 */
export function lastSegment(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? path : path.slice(dot + 1);
}

// ---------------------------------------------------------------------------
// ツリー
// ---------------------------------------------------------------------------

/**
 * 葉の平坦な並びから木を組む。
 *
 * <p>サーバーは階層を送らず、ドット区切りのパスだけを送る。
 * proto に入れ子の木を持たせるとサーバー側の構築とパネル側の再帰描画の両方が要るが、
 * こちらはパスの分割で済む。
 *
 * <p>並びは入力の登場順を保つ。サーバーはフィールドの宣言順で送ってくるので、
 * 並べ替えると `config.json` を見比べたときに対応が取れなくなる。
 */
export function buildTree(nodes: readonly ConfigNode[]): TreeItem[] {
  const roots: TreeItem[] = [];
  // 枝のパス -> 枝。同じ枝を2度作らないために引く
  const groups = new Map<string, TreeGroup>();

  for (const node of nodes) {
    const segments = node.path.split(".");
    let siblings = roots;
    let prefix = "";

    // 最後の要素だけが葉。手前はすべて枝になる
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i] ?? "";
      prefix = prefix.length === 0 ? segment : `${prefix}.${segment}`;
      let group = groups.get(prefix);
      if (!group) {
        group = { type: "group", path: prefix, label: segment, children: [] };
        groups.set(prefix, group);
        siblings.push(group);
      }
      siblings = group.children;
    }

    siblings.push({ type: "leaf", path: node.path, label: node.label, node });
  }
  return roots;
}

/**
 * 絞り込む。パスの部分一致で葉を残し、残った葉を持つ枝だけを残す。
 *
 * <p>大文字小文字は区別しない。約 200 件から目当ての1件を探す操作なので、
 * 綴りを正確に打たせる意味が無い。
 *
 * @param query 空文字なら素通し
 */
export function filterTree(items: readonly TreeItem[], query: string): TreeItem[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return items as TreeItem[];
  }
  const result: TreeItem[] = [];
  for (const item of items) {
    if (item.type === "leaf") {
      if (item.path.toLowerCase().includes(needle)) {
        result.push(item);
      }
      continue;
    }
    const children = filterTree(item.children, query);
    if (children.length > 0) {
      result.push({ ...item, children });
    }
  }
  return result;
}

/**
 * 既定で開いておく枝のパス。
 *
 * <p><b>1段目だけ開く。</b> 全部畳むと何があるか分からず、
 * 全部開くと約 200 行が一度に出て読めない。
 */
export function defaultExpanded(items: readonly TreeItem[]): string[] {
  return items.filter((item): item is TreeGroup => item.type === "group").map((g) => g.path);
}

/** 木に含まれる枝のパスをすべて集める。「すべて開く」に使う */
export function allGroupPaths(items: readonly TreeItem[]): string[] {
  const paths: string[] = [];
  for (const item of items) {
    if (item.type === "group") {
      paths.push(item.path);
      paths.push(...allGroupPaths(item.children));
    }
  }
  return paths;
}

/** 木に含まれる葉の数。絞り込みの結果を見出しに出すために使う */
export function countLeaves(items: readonly TreeItem[]): number {
  let total = 0;
  for (const item of items) {
    total += item.type === "leaf" ? 1 : countLeaves(item.children);
  }
  return total;
}

// ---------------------------------------------------------------------------
// 値の変換
// ---------------------------------------------------------------------------

/** 配列を扱う種類か */
export function isArrayKind(kind: ConfigKind): boolean {
  return kind === "INT_ARRAY" || kind === "DOUBLE_ARRAY" || kind === "STRING_ARRAY";
}

/** 配列の種類に対応する要素の種類 */
export function elementKind(kind: ConfigKind): ConfigKind {
  switch (kind) {
    case "INT_ARRAY":
      return "INT";
    case "DOUBLE_ARRAY":
      return "DOUBLE";
    case "STRING_ARRAY":
      return "STRING";
    default:
      return kind;
  }
}

/**
 * parameter の値を入力欄に出す文字列にする。
 *
 * <p>`undefined` は空文字。まだ値が届いていない行を `"undefined"` と描かないため。
 */
export function formatValue(value: unknown): string {
  if (value == undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return String(value);
}

/** parameter の値を配列として読む。配列でなければ空 */
export function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : [];
}

/** 入力欄の文字列を parameter の値へ変換した結果 */
export type ParseResult =
  | { ok: true; value: number | string }
  | { ok: false; message: string };

/**
 * 入力欄の文字列を種類に応じた値へ変換する。
 *
 * <p><b>整数と小数を分けているのが要点。</b> 整数のフィールドに小数を書くと
 * サーバー側で切り捨てられ、入力した値と実際の値が食い違う。
 * ここで弾いて理由を出す。
 */
export function parseValue(kind: ConfigKind, text: string): ParseResult {
  const trimmed = text.trim();
  switch (kind) {
    case "INT": {
      if (!/^[+-]?\d+$/.test(trimmed)) {
        return { ok: false, message: "整数で入力してください" };
      }
      const value = Number(trimmed);
      if (!Number.isSafeInteger(value)) {
        return { ok: false, message: "整数の範囲を超えています" };
      }
      return { ok: true, value };
    }
    case "DOUBLE": {
      if (trimmed.length === 0) {
        return { ok: false, message: "数値で入力してください" };
      }
      const value = Number(trimmed);
      if (!Number.isFinite(value)) {
        return { ok: false, message: "数値で入力してください" };
      }
      return { ok: true, value };
    }
    case "STRING":
    case "ENUM":
      return { ok: true, value: text };
    default:
      return { ok: false, message: `${kind} は入力欄で扱えません` };
  }
}

/** 配列に要素を1つ足したときの既定値。種類ごとに空の値を入れる */
export function emptyElement(kind: ConfigKind): number | string {
  return elementKind(kind) === "STRING" ? "" : 0;
}
