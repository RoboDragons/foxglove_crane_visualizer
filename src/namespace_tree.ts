/**
 * レイヤー名（`robots/blue/positions` のような階層パス）の表示状態を持つツリー。
 *
 * <p>可視化パネルの Namespaces がこれを設定ツリーとして描く。
 * <b>純関数だけを置く。</b> React にも Foxglove の API にも触れないので、
 * node から直接呼んで確かめられる。
 */

/** ツリーの1ノード */
export interface NamespaceNode {
  visible: boolean;
  children?: { [key: string]: NamespaceNode };
}

/** 同じ階層に並ぶノード。キーはその階層での名前で、フルパスではない */
export type NamespaceMap = { [key: string]: NamespaceNode };


// レイヤー名の区切り。サーバーは "robots/blue/positions" のような階層パスで送ってくる
const LAYER_SEPARATOR = "/";

/** 配下すべての表示状態を一括で書き換えた新しいノードを返す */
export function withDescendantsVisible(node: NamespaceNode, visible: boolean): NamespaceNode {
  const children = node.children;
  if (!children) {
    return node.visible === visible ? node : { ...node, visible };
  }
  const nextChildren: { [key: string]: NamespaceNode } = {};
  let changed = node.visible !== visible;
  for (const [name, child] of Object.entries(children)) {
    const next = withDescendantsVisible(child, visible);
    nextChildren[name] = next;
    if (next !== child) changed = true;
  }
  return changed ? { ...node, visible, children: nextChildren } : node;
}

/**
 * 名前空間ツリーの1ノードの表示状態を変えた新しいツリーを返す。
 *
 * <p><b>根から対象ノードまでを複製する。</b> 浅いコピーだと子の参照を共有したまま
 * 書き換えることになり、参照が変わらないノードの変更が保存されない。
 *
 * <p>切替は配下すべてに伝播する。さらに<b>表示にするときは先祖もまとめて表示にする。</b>
 * 描画は経路上のすべてが表示のときだけ行うので、これをしないと
 * 「チェックは入っているのに出ない」という読めない状態ができる。
 *
 * <p>対象が見つからない、または値が変わらない場合は元のオブジェクトをそのまま返す。
 * 呼び出し側が参照の同一性で「変化なし」を判定し、無駄な再描画と saveState を避けられる。
 */
export function withNamespaceVisible(
  namespaces: NamespaceMap,
  path: readonly string[],
  visible: boolean,
): NamespaceMap {
  const [head, ...rest] = path;
  if (head == undefined) {
    return namespaces;
  }
  const node = namespaces[head];
  if (!node) {
    return namespaces;
  }
  if (rest.length === 0) {
    const next = withDescendantsVisible(node, visible);
    return next === node ? namespaces : { ...namespaces, [head]: next };
  }
  const children = node.children;
  if (!children) {
    return namespaces;
  }
  const nextChildren = withNamespaceVisible(children, rest, visible);
  if (nextChildren === children) {
    return namespaces;
  }
  // 表示にするときは先祖も開ける。隠したままだと配下が出ない
  const nextVisible = visible ? true : node.visible;
  return { ...namespaces, [head]: { ...node, visible: nextVisible, children: nextChildren } };
}

/** そのパスのノードが存在するか。actionHandler が末尾の "visible" を見分けるのに使う */
export function hasNamespaceNode(namespaces: NamespaceMap, path: readonly string[]): boolean {
  let current: NamespaceMap | undefined = namespaces;
  for (const segment of path) {
    const node: NamespaceNode | undefined = current?.[segment];
    if (!node) {
      return false;
    }
    current = node.children;
  }
  return true;
}

/**
 * レイヤー名をスラッシュで分解してツリーへ差し込む。すでにあれば元のまま返す。
 *
 * <p>途中の階層（`robots` や `robots/blue`）は実在するレイヤーとは限らないが、
 * まとめて切り替えるための節として作る。既定は表示。
 */
export function withLayerAdded(
  namespaces: NamespaceMap,
  layer: string,
  visibleByDefault: boolean,
): NamespaceMap {
  const segments = layer.split(LAYER_SEPARATOR).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return namespaces;
  }
  const insert = (level: NamespaceMap, depth: number): NamespaceMap => {
    const name = segments[depth]!;
    const isLeaf = depth === segments.length - 1;
    const existing = level[name];
    if (isLeaf) {
      if (existing) {
        return level;
      }
      return { ...level, [name]: { visible: visibleByDefault } };
    }
    const node: NamespaceNode = existing ?? { visible: true };
    const children = node.children ?? {};
    const nextChildren = insert(children, depth + 1);
    if (existing && nextChildren === children) {
      return level;
    }
    return { ...level, [name]: { ...node, children: nextChildren } };
  };
  return insert(namespaces, 0);
}

/**
 * 表示中のレイヤー名の集合。
 *
 * <p>経路上のすべてのノードが表示のものだけを集める。1フレームに 30 レイヤー分の
 * 判定が要るので、毎回ツリーを歩かずに済むよう名前の集合にしておく。
 */
export function collectVisibleLayers(namespaces: NamespaceMap): Set<string> {
  const visible = new Set<string>();
  const walk = (level: NamespaceMap, prefix: string) => {
    for (const [name, node] of Object.entries(level)) {
      if (!node.visible) {
        continue;
      }
      const path = prefix.length > 0 ? `${prefix}${LAYER_SEPARATOR}${name}` : name;
      visible.add(path);
      if (node.children) {
        walk(node.children, path);
      }
    }
  };
  walk(namespaces, "");
  return visible;
}

/**
 * 保存済みのパネル状態をツリー形式へ移行する。
 *
 * <p>2026-09-10 より前は `"robots/blue/positions"` をそのままキーにした平坦な形だった。
 * そのまま読むと、階層に分けたツリーと二重に並んで表示が壊れる。
 */
export function migrateNamespaces(saved: NamespaceMap | undefined): NamespaceMap {
  if (!saved) {
    return {};
  }
  const flatKeys = Object.keys(saved).filter((key) => key.includes(LAYER_SEPARATOR));
  if (flatKeys.length === 0) {
    return saved;
  }
  let migrated: NamespaceMap = {};
  for (const [key, node] of Object.entries(saved)) {
    if (!key.includes(LAYER_SEPARATOR)) {
      migrated = { ...migrated, [key]: node };
      continue;
    }
    migrated = withLayerAdded(migrated, key, node.visible);
  }
  return migrated;
}
