import {
  getAppFontStack,
  type AppFontFamily,
} from "@shared/app-fonts";

export function applyAppFontFamily(fontFamily: AppFontFamily): void {
  const root = document.documentElement;
  root.style.setProperty("--tw-font-family", getAppFontStack(fontFamily));
  root.dataset.fontFamily = fontFamily;
}
