import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
} from "@react-navigation/native-stack";
import { msg } from "gt-react-native";

import type { ColorValue } from "react-native";

import type { AppBarMenu, AppBarMenuItem } from "../../../components/ui/AppBar.types";
import { m, type MessageResolver } from "../../../i18n/messages";
import { withNativeGlassHeaderItem } from "../native-glass-header-items";

type NativeHeaderMenuItems = NativeStackHeaderItemMenu["menu"]["items"];
type NativeHeaderIcon = NonNullable<Extract<NativeStackHeaderItem, { type: "button" }>["icon"]>;

function sfSymbolIcon(name: string): NativeHeaderIcon {
  return { type: "sfSymbol", name: name as never };
}

function toNativeHeaderMenuItems(items: ReadonlyArray<AppBarMenuItem>): NativeHeaderMenuItems {
  return items.map((item) =>
    "items" in item
      ? {
          type: "submenu" as const,
          label: item.title ?? "",
          items: toNativeHeaderMenuItems(item.items),
        }
      : {
          type: "action" as const,
          label: item.title,
          description: item.subtitle,
          onPress: item.onPress,
          state: item.selected ? ("on" as const) : undefined,
        },
  );
}

/** The sidebar column's bar items, as native header items so the title can size around them. */
export function createWorkspaceListHeaderItems(input: {
  readonly filters: ReadonlyArray<AppBarMenu>;
  /** Tints a selected filter, such as an applied one. */
  readonly selectedTintColor: ColorValue;
  readonly onOpenSettings?: () => void;
  readonly resolve?: MessageResolver;
}): NativeStackHeaderItem[] {
  const resolve = input.resolve ?? m;
  return [
    ...input.filters.map((filter) =>
      withNativeGlassHeaderItem({
        type: "menu",
        axisBehavior: "horizontalOnly",
        label: "",
        accessibilityLabel: filter.title,
        icon: sfSymbolIcon(typeof filter.icon === "string" ? filter.icon : filter.icon.ios),
        tintColor: filter.selected ? input.selectedTintColor : undefined,
        menu: {
          title: filter.title,
          items: toNativeHeaderMenuItems(filter.items),
        },
      }),
    ),
    ...(input.onOpenSettings
      ? [
          withNativeGlassHeaderItem({
            type: "button",
            axisBehavior: "horizontalOnly",
            label: resolve(msg("Settings")),
            accessibilityLabel: resolve(msg("Open settings")),
            icon: sfSymbolIcon("gearshape"),
            onPress: input.onOpenSettings,
          }),
        ]
      : []),
  ];
}
