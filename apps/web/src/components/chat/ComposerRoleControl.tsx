import type { AgentRole } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { IdCardIcon } from "lucide-react";
import { memo } from "react";

import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

const NO_ROLE = "";

/** Picks the `.agents/roles` role the thread acts as. */
export const ComposerRoleControl = memo(function ComposerRoleControl(props: {
  roles: ReadonlyArray<AgentRole>;
  /** The thread's role name, which may name a file the checkout no longer has. */
  role: string | null;
  size: "sm" | "xs";
  hidden: boolean;
  /** Absent where this connection cannot change the thread. */
  onRoleChange: ((role: AgentRole | null) => void) | undefined;
}) {
  const gt = useGT();
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const { role, roles, onRoleChange } = props;
  const tooltip =
    role === null
      ? gt("Role: none. Pick a role from .agents/roles for this thread.")
      : gt("Role: @{role}", { role });
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  size={props.size}
                  aria-label={tooltip}
                  disabled={onRoleChange === undefined}
                />
              }
            />
          }
        >
          <ComposerControlIcon
            icon={IdCardIcon}
            size={props.size}
            {...(role === null ? {} : { className: "text-current" })}
          />
          {role === null ? null : <span data-composer-control-label>@{role}</span>}
        </TooltipTrigger>
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        <MenuRadioGroup
          aria-label={gt("Role")}
          value={role ?? NO_ROLE}
          onValueChange={(next: string) => {
            if (next === (role ?? NO_ROLE)) return;
            onRoleChange?.(roles.find((candidate) => candidate.name === next) ?? null);
          }}
        >
          <MenuRadioItem value={NO_ROLE} closeOnClick>
            <span className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate">{gt("No role")}</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
          {roles.map((candidate) => (
            <MenuRadioItem key={candidate.name} value={candidate.name} closeOnClick>
              <span className="flex max-w-80 items-center gap-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">
                    @{candidate.name}
                    {candidate.title !== candidate.name ? (
                      <span className="text-muted-foreground"> {candidate.title}</span>
                    ) : null}
                  </span>
                  {candidate.description ? (
                    <span className="line-clamp-2 text-muted-foreground text-xs">
                      {candidate.description}
                    </span>
                  ) : null}
                </span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});
