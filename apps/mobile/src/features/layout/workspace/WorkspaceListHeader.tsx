import { useMessages } from "gt-react-native";
import { useRef } from "react";
import type { SearchBarCommands } from "react-native-screens";

import { useControlTheme } from "../../../components/ui/useControlTheme";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { useHardwareKeyboardCommand } from "../../keyboard/hardwareKeyboardCommands";
import { getConnectionAwareBrandHeaderOptions } from "./brand-header-options";
import { createWorkspaceListHeaderItems } from "./workspace-list-header-items";
import type { WorkspaceListHeaderProps } from "./WorkspaceListHeader.types";

export function WorkspaceListHeader(props: WorkspaceListHeaderProps) {
  return props.sidebar ? <SidebarColumnHeader {...props} sidebar={props.sidebar} /> : null;
}

function SidebarColumnHeader(
  props: WorkspaceListHeaderProps & {
    readonly sidebar: NonNullable<WorkspaceListHeaderProps["sidebar"]>;
  },
) {
  const m = useMessages();
  const { search, sidebar } = props;
  const searchBarRef = useRef<SearchBarCommands>(null);
  const { colors } = useControlTheme();
  useHardwareKeyboardCommand("focusSearch", () => {
    const focus = () => searchBarRef.current?.focus();
    if (!sidebar.visible) {
      sidebar.onRequestVisibility();
      // Focus once the revealed sidebar has slid in.
      setTimeout(focus, 240);
    } else {
      focus();
    }
    return true;
  });
  const items = createWorkspaceListHeaderItems({
    filters: props.filters,
    selectedTintColor: colors["--color-primary"],
    onOpenSettings: props.onOpenSettings,
    resolve: m,
  });

  return (
    <NativeStackScreenOptions
      optionsVersion={[items, sidebar.width]}
      options={{
        ...getConnectionAwareBrandHeaderOptions({
          headerWidth: sidebar.width,
          trailingItemCount: items.length,
          onOpenEnvironments: props.onOpenEnvironments,
          fallbackTitleStyle: { fontSize: 18, fontWeight: "800" },
          resolve: m,
        }),
        headerSearchBarOptions: {
          ref: searchBarRef,
          autoCapitalize: "none",
          hideNavigationBar: false,
          hideWhenScrolling: false,
          obscureBackground: false,
          placeholder: search.placeholder,
          placement: "stacked",
          onCancelButtonPress: () => search.onChangeText(""),
          onChangeText: (event) => search.onChangeText(event.nativeEvent.text),
        },
        unstable_headerRightItems: () => items,
      }}
    />
  );
}
