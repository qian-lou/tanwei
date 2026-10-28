import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CAPABILITY_GROUPS,
  searchCapabilityCatalog,
  type CapabilityCatalogItem,
} from "../capability-catalog";
import { t, useLocale } from "../i18n";

export interface CapabilityPaletteProps {
  readonly open: boolean;
  readonly connected: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export default function CapabilityPalette({
  open,
  connected,
  onOpenChange,
}: CapabilityPaletteProps) {
  useLocale();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  const matches = useMemo(() => searchCapabilityCatalog(query), [query]);
  const groupedMatches = useMemo(
    () =>
      CAPABILITY_GROUPS.map((group) => ({
        group,
        items: matches.filter((item) => item.group === group),
      })).filter((entry) => entry.items.length > 0),
    [matches],
  );

  function openCapability(item: CapabilityCatalogItem): void {
    onOpenChange(false);
    const search = item.query
      ? `?${new URLSearchParams(item.query).toString()}`
      : "";
    void navigate(`${item.path}${search}`);
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (nextOpen) {
      setQuery("");
    }
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="sr-only">
          <DialogTitle>{t("全部诊断能力。")}</DialogTitle>
          <DialogDescription>
            {t("按能力、问题或参考术语搜索")}
          </DialogDescription>
        </DialogHeader>

        <Command shouldFilter={false} label={t("按能力、问题或参考术语搜索")}>
          <CommandInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            aria-label={t("按能力、问题或参考术语搜索")}
            placeholder={t("例如 thread dump、vmoption、内存泄漏")}
          />

          <div
            className="text-muted-foreground flex items-center justify-between border-b px-3 py-2 text-xs"
            aria-live="polite"
          >
            <span>{t("{count} 项匹配", { count: matches.length })}</span>
            <span>{t("↑↓ 选择 · Enter 打开 · Esc 关闭")}</span>
          </div>

          <CommandList className="max-h-[min(65vh,36rem)]">
            <CommandEmpty>
              <p className="font-medium">{t("没有匹配能力。")}</p>
              <p className="text-muted-foreground mt-1 text-xs">
                {t("尝试类、线程、Heap、JFR 或参考命令名称。")}
              </p>
            </CommandEmpty>

            {groupedMatches.map((groupEntry) => (
              <CommandGroup
                key={groupEntry.group}
                heading={t(groupEntry.group)}
              >
                {groupEntry.items.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    className="items-start py-2.5"
                    onSelect={() => openCapability(item)}
                  >
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <strong className="truncate font-medium">
                        {t(item.label)}
                      </strong>
                      <span className="text-muted-foreground truncate text-xs">
                        {t(item.description)}
                      </span>
                    </span>
                    <Badge variant="outline" className="mt-0.5 shrink-0">
                      {item.requiresConnection && !connected
                        ? t("需连接")
                        : t("可打开")}
                    </Badge>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>

          <div className="text-muted-foreground flex items-center justify-between border-t px-3 py-2 text-xs">
            <span>{t("只导航到类型化桌面检查器，不执行未知文本命令。")}</span>
            <CommandShortcut>⌘/Ctrl K</CommandShortcut>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
