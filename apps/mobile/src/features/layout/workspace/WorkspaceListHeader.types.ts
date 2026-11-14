import type { AppBarMenu } from "../../../components/ui/AppBar.types";

/** The header of the workspace thread list, on Home and in the sidebar column. */
export interface WorkspaceListHeaderProps {
  /** Spoken for the brand title, such as "T3 Code, Threads". */
  readonly accessibilityLabel: string;
  /** The connection status beside the brand opens environment settings. */
  readonly onOpenEnvironments: () => void;
  readonly search: {
    readonly value: string;
    readonly onChangeText: (value: string) => void;
    readonly placeholder: string;
    readonly accessibilityLabel: string;
  };
  /** One bar button per filter, in reading order. */
  readonly filters: ReadonlyArray<AppBarMenu>;
  /** iOS: a settings button. Android reaches Settings from the workspace navigation. */
  readonly onOpenSettings?: () => void;
  /**
   * Set when the list is the workspace's sidebar column, which draws its own bar on iOS. Without
   * it the iOS workspace root's toolbar draws the list's bar and search.
   */
  readonly sidebar?: {
    readonly width: number;
    readonly visible: boolean;
    readonly onRequestVisibility: () => void;
  };
}
