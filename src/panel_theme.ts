/**
 * パネル共通の配色とテーマ判定。
 *
 * <p>Studio はライト/ダークを切り替えられるが、拡張パネルにテーマを伝える API が無い。
 * そこでパネルの実際の背景色から明暗を実測する。
 * select のドロップダウン一覧はブラウザ側が描画するため、色を明示しないと
 * 「既定の白背景 + 継承した白文字」で読めなくなる。
 *
 * <p>操作パネルと設定パネルの両方から使う。<b>配色をここに集約すること。</b>
 * 2つのパネルで色がずれると、同じ拡張なのに別物に見える。
 */

import * as React from "react";
import { useEffect, useState } from "react";

/**
 * Studio のテーマ（ライト/ダーク）を実測する。
 *
 * select のドロップダウン一覧はブラウザ側が描画するため、色を明示しないと
 * 「既定の白背景 + 継承した白文字」で読めなくなる。パネルの実際の背景色から
 * 明暗を判定し、不透明な色を明示的に当てるためのユーティリティ。
 */
export function parseRgb(value: string): [number, number, number, number] | undefined {
  const matched = /^rgba?\(([^)]+)\)$/.exec(value.trim());
  if (!matched) {
    return undefined;
  }
  const parts = matched[1]!.split(",").map((part) => Number(part.trim()));
  const [r, g, b] = parts;
  if (r == undefined || g == undefined || b == undefined) {
    return undefined;
  }
  return [r, g, b, parts.length > 3 ? (parts[3] ?? 1) : 1];
}

export function isDarkRgb(r: number, g: number, b: number): boolean {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/** 祖先をたどって最初に見つかった不透明な背景色から明暗を判定する */
export function detectDarkTheme(element: HTMLElement | undefined): boolean | undefined {
  const view = element?.ownerDocument.defaultView;
  if (!element || !view) {
    return undefined;
  }
  let node: HTMLElement | null = element;
  while (node) {
    const background = parseRgb(view.getComputedStyle(node).backgroundColor);
    if (background && background[3] > 0.2) {
      return isDarkRgb(background[0], background[1], background[2]);
    }
    node = node.parentElement;
  }
  // 背景がすべて透明なら文字色から推測する（明るい文字 = ダークテーマ）
  const foreground = parseRgb(view.getComputedStyle(element).color);
  if (foreground) {
    return !isDarkRgb(foreground[0], foreground[1], foreground[2]);
  }
  return undefined;
}

export function useIsDarkTheme(element: HTMLElement | undefined): boolean {
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    if (!element) {
      return;
    }
    const update = () => {
      const detected = detectDarkTheme(element);
      if (detected != undefined) {
        setIsDark((prev) => (prev === detected ? prev : detected));
      }
    };
    update();

    const doc = element.ownerDocument;
    const observer = new MutationObserver(update);
    observer.observe(doc.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    if (doc.body) {
      observer.observe(doc.body, { attributes: true, attributeFilter: ["class", "style"] });
    }
    // Studio 側のテーマ切り替えを取りこぼしても追従できるようにする保険
    const timer = doc.defaultView?.setInterval(update, 2000);

    return () => {
      observer.disconnect();
      if (timer != undefined) {
        doc.defaultView?.clearInterval(timer);
      }
    };
  }, [element]);

  return isDark;
}

export const colors = {
  border: "rgba(127, 127, 127, 0.4)",
  subtleBorder: "rgba(127, 127, 127, 0.25)",
  surface: "rgba(127, 127, 127, 0.14)",
  surfaceStrong: "rgba(127, 127, 127, 0.22)",
  accent: "#3b6fe0",
  accentText: "#ffffff",
  error: "#e05252",
  muted: "rgba(127, 127, 127, 1)",
  danger: "#d9534f",
};

export const inputColors = {
  dark: { background: "#2f2f2f", color: "#e8e8e8" },
  light: { background: "#ffffff", color: "#1a1a1a" },
};

export function inputStyle(isDark: boolean): React.CSSProperties {
  const scheme = isDark ? inputColors.dark : inputColors.light;
  return {
    background: scheme.background,
    border: `1px solid ${colors.border}`,
    borderRadius: 3,
    color: scheme.color,
    // ドロップダウン一覧やスピナーなどブラウザ描画部分の配色を揃える
    colorScheme: isDark ? "dark" : "light",
    font: "inherit",
    padding: "4px 6px",
    width: "100%",
    boxSizing: "border-box",
  };
}

export function optionStyle(isDark: boolean): React.CSSProperties {
  const scheme = isDark ? inputColors.dark : inputColors.light;
  return { background: scheme.background, color: scheme.color };
}
