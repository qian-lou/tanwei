export const APP_FONT_FAMILY_VALUES = [
  "SYSTEM",
  "INTER",
  "SOURCE_HAN_SANS",
  "MODERN_CHINESE_SANS",
  "LXGW_WENKAI",
  "JETBRAINS_MONO",
  "SOURCE_HAN_SERIF",
] as const;

export type AppFontFamily = (typeof APP_FONT_FAMILY_VALUES)[number];

export const APP_FONT_OPTIONS = [
  {
    value: "SYSTEM",
    label: "系统默认",
    detail: "系统字体 / System UI",
  },
  {
    value: "INTER",
    label: "Inter",
    detail: "Inter / SF Pro / Segoe UI",
  },
  {
    value: "SOURCE_HAN_SANS",
    label: "思源黑体",
    detail: "Source Han Sans / Noto Sans SC",
  },
  {
    value: "MODERN_CHINESE_SANS",
    label: "现代中文黑体",
    detail: "MiSans / HarmonyOS Sans / PingFang SC",
  },
  {
    value: "LXGW_WENKAI",
    label: "霞鹜文楷",
    detail: "LXGW WenKai / 楷体",
  },
  {
    value: "JETBRAINS_MONO",
    label: "JetBrains Mono",
    detail: "JetBrains Mono / SF Mono / Cascadia Code",
  },
  {
    value: "SOURCE_HAN_SERIF",
    label: "思源宋体",
    detail: "Source Han Serif / Noto Serif SC",
  },
] as const satisfies ReadonlyArray<{
  readonly value: AppFontFamily;
  readonly label: string;
  readonly detail: string;
}>;

export const DEFAULT_APP_FONT_FAMILY: AppFontFamily = "SYSTEM";

const APP_FONT_STACKS: Readonly<Record<AppFontFamily, string>> = {
  SYSTEM:
    '-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", "Noto Sans SC", "Microsoft YaHei UI", sans-serif',
  INTER:
    'Inter, "SF Pro Text", "Segoe UI Variable", "Noto Sans SC", "Microsoft YaHei UI", sans-serif',
  SOURCE_HAN_SANS:
    '"Source Han Sans SC", "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei UI", sans-serif',
  MODERN_CHINESE_SANS:
    'MiSans, "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei UI", "Noto Sans SC", sans-serif',
  LXGW_WENKAI:
    '"LXGW WenKai", "霞鹜文楷", "Kaiti SC", STKaiti, KaiTi, serif',
  JETBRAINS_MONO:
    '"JetBrains Mono", SFMono-Regular, "Cascadia Code", Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", monospace',
  SOURCE_HAN_SERIF:
    '"Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", "Songti SC", STSong, SimSun, serif',
};

export function isAppFontFamily(value: unknown): value is AppFontFamily {
  return typeof value === "string" && Object.hasOwn(APP_FONT_STACKS, value);
}

export function normalizeAppFontFamily(value: unknown): AppFontFamily {
  return isAppFontFamily(value) ? value : DEFAULT_APP_FONT_FAMILY;
}

export function getAppFontStack(fontFamily: AppFontFamily): string {
  return APP_FONT_STACKS[fontFamily];
}
