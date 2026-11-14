import type { EnvironmentId, UnifiedSettings } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { InfoIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const CLI_PROXY_NAME = "CLI Proxy";

export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly readOnly: boolean;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [adding, setAdding] = useState(false);
  const entries = Object.entries(sources);

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              <T>Add hub</T>
            </Button>
          ) : null
        }
      >
        {entries.length === 0 ? (
          <SettingsRow title={gt("No hubs configured.")} />
        ) : (
          entries.map(([id, source]) => {
            const label = source.label?.trim() || source.url;
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    {source.enabled
                      ? CLI_PROXY_NAME
                      : gt("{name} · Disabled", { name: CLI_PROXY_NAME })}
                    {label !== source.url ? ` · ${source.url}` : ""}
                  </span>
                }
                control={
                  !readOnly ? (
                    <div className="flex items-center gap-3">
                      <Tooltip>
                        <TooltipTrigger
                          delay={200}
                          render={
                            <Button
                              size="icon-micro"
                              variant="ghost-muted"
                              aria-label={gt("About spending the soonest reset first")}
                            >
                              <InfoIcon className="size-3.5" />
                            </Button>
                          }
                        />
                        <TooltipPopup side="top">
                          <T>
                            Sets the hub's account priorities so the account whose weekly quota
                            resets soonest takes every new conversation until it runs out.
                          </T>
                        </TooltipPopup>
                      </Tooltip>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <T>Spend soonest reset first</T>
                        <Switch
                          size="sm"
                          checked={source.routeBySoonestReset === true}
                          onCheckedChange={(checked) =>
                            updateSettings({
                              usageLimitSources: {
                                [id]: { ...source, routeBySoonestReset: checked },
                              },
                            })
                          }
                        />
                      </label>
                      <RemoveUsageProviderButton
                        label={label}
                        onConfirm={() => updateSettings({ usageLimitSources: { [id]: null } })}
                      />
                    </div>
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {adding && !readOnly ? (
        <AddUsageLimitSourceDialog
          open
          onOpenChange={setAdding}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          sources={sources}
        />
      ) : null}
    </>
  );
}

function RemoveUsageProviderButton({
  label,
  onConfirm,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <T>Remove</T>
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Remove <Var>{label}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                The hub's management key is deleted from this server. Its accounts leave the Limits
                view, and any account priorities T3 Code set are reset. Add it again with the URL
                and key to bring them back.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              <T>Remove hub</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
