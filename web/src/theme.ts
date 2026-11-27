// 個人外觀：淺色／深色／跟隨系統＋主題色＋字體大小。先用本機快取立即套用，登入後以帳號上的設定為準。
export type ThemeMode = 'system' | 'light' | 'dark';
export type Palette = 'indigo' | 'ocean' | 'forest' | 'terracotta' | 'plum' | 'graphite';
export type FontSize = 'sm' | 'md' | 'lg' | 'xl';
export interface ThemePrefs {
  mode: ThemeMode;
  palette: Palette;
  /** 整個畫面的字體大小（只放大文字，版面寬度不變） */
  fontSize?: FontSize;
}

export const FONT_SIZES: { key: FontSize; label: string; scale: number }[] = [
  { key: 'sm', label: '小', scale: 0.92 },
  { key: 'md', label: '標準', scale: 1 },
  { key: 'lg', label: '大', scale: 1.12 },
  { key: 'xl', label: '特大', scale: 1.25 },
];

export const PALETTES: { key: Palette; label: string; colors: [string, string, string] }[] = [
  { key: 'indigo', label: '靛藍（預設）', colors: ['#2f4a73', '#e6ecf5', '#8fb0e0'] },
  { key: 'ocean', label: '湖水', colors: ['#16697a', '#e0f0f2', '#7cc6d3'] },
  { key: 'forest', label: '森林', colors: ['#2f6b4f', '#e3efe8', '#8cc9a7'] },
  { key: 'terracotta', label: '陶土', colors: ['#a4532f', '#f6e8e0', '#e8a685'] },
  { key: 'plum', label: '梅紫', colors: ['#6a4a97', '#ece6f5', '#c3a8ec'] },
  { key: 'graphite', label: '石墨', colors: ['#3d4450', '#e8eaee', '#c4cad4'] },
];

const KEY = 'grabit-theme';

export function applyTheme(p: ThemePrefs): void {
  const root = document.documentElement;
  if (p.mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', p.mode);
  root.setAttribute('data-palette', p.palette);
  if (!p.fontSize || p.fontSize === 'md') root.removeAttribute('data-font');
  else root.setAttribute('data-font', p.fontSize);
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // 私密瀏覽等情況無法儲存，不影響使用
  }
}

export function initTheme(): void {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || 'null') as ThemePrefs | null;
    if (p) applyTheme(p);
  } catch {
    // 忽略
  }
}
