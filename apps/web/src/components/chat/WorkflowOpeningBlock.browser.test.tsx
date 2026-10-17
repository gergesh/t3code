import {
  deriveWorkflowGroups,
  projectedSubagentsToRuntime,
  type WorkflowOpening,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { MarkdownFindContext } from "./markdownFindContext";
import { useThreadFindHighlights } from "./threadFindHighlights";
import { WorkflowOpeningBlock } from "./WorkflowOpeningBlock";

const state = vi.hoisted(() => ({ tooltipEnvironment: vi.fn() }));

vi.mock(import("./SubagentTooltipContent"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    SubagentTooltipContent: (props: ComponentProps<typeof actual.SubagentTooltipContent>) => {
      state.tooltipEnvironment(props.title, props.environmentId);
      return <actual.SubagentTooltipContent {...props} />;
    },
  };
});

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const providers = Atom.make([]).pipe(Atom.keepAlive);
  const noConfig = Atom.make(null);
  return {
    ...actual,
    providersIgnoringCheckedAtAtom: (() => providers) as never,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
// Loading the real Shiki WASM and grammar can take seconds on a busy runner; the block only
// needs to hand its script to the markdown code block that highlights it.
vi.mock(import("../../lib/syntaxHighlighting"), async (original) => ({
  ...(await original()),
  getSyntaxHighlighterPromise: async () =>
    ({
      codeToHtml: (code: string) =>
        Object.assign(document.createElement("pre"), { textContent: code }).outerHTML,
    }) as never,
}));

const SHORT_SCRIPT =
  "export const meta = { name: 'repo-check' }\nagent('Run SCRIPTONLY with Bash')";
const LONG_SCRIPT = [
  "export const meta = { name: 'repo-check' }",
  ...Array.from({ length: 24 }, (_, index) => `const step${index} = await agent('Step ${index}')`),
  "return 'TAILONLY'",
].join("\n");

const opening = (script: string): WorkflowOpening => ({
  messageId: "message-script",
  script,
  name: "repo-check",
  description: "Two agents each inspect one file",
  driver: null,
  providerInstanceId: null,
  group: null,
});

function Find(props: { readonly container: HTMLElement | null; readonly query: string }) {
  useThreadFindHighlights({
    container: props.container,
    query: props.query,
    activeRowId: "opening",
    activeOccurrence: 0,
    onActiveRange: () => undefined,
  });
  return null;
}

async function renderOpening(script: string, query = "", workflow?: WorkflowOpening) {
  state.tooltipEnvironment.mockClear();
  const container = document.createElement("div");
  container.style.width = "720px";
  const block = (script: string, query: string) => (
    <AppAtomRegistryProvider>
      <MarkdownFindContext value={query.length > 0}>
        <div data-timeline-row-id="opening">
          <WorkflowOpeningBlock
            opening={workflow ?? opening(script)}
            environmentId={EnvironmentId.make("environment-local")}
            onOpenThread={() => undefined}
          />
        </div>
      </MarkdownFindContext>
      <Find container={container} query={query} />
    </AppAtomRegistryProvider>
  );
  await using stack = new AsyncDisposableStack();
  stack.defer(() => CSS.highlights.clear());
  const screen = stack.use(await render(block(script, query), { container }));
  const environment = stack.move();
  return {
    container,
    rerender: async (script: string, query: string) => {
      await screen.rerender(block(script, query));
    },
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

const foldToggle = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].find((button) =>
    /Show full script|Show less/.test(button.textContent ?? ""),
  );

it("passes the workflow environment to the real member hover card", async () => {
  const [group] = deriveWorkflowGroups(
    projectedSubagentsToRuntime([
      {
        id: "workflow",
        title: "Checkout review",
        prompt: "",
        model: null,
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-09-21T12:00:00Z"),
        workflow: {
          name: "Checkout review",
          phases: [{ index: 0, title: "Inspect" }],
          agents: [
            {
              index: 0,
              label: "Checker",
              state: "running",
              phaseIndex: 0,
              childThreadId: ThreadId.make("checker"),
            },
          ],
        },
      },
    ]),
  );
  if (!group) throw new Error("Workflow fixture did not produce a group.");
  await using _screen = await renderOpening(SHORT_SCRIPT, "", {
    ...opening(SHORT_SCRIPT),
    providerInstanceId: ProviderInstanceId.make("claude-work"),
    group,
  });
  await userEvent.hover(page.getByRole("button", { name: "Open Checker", exact: true }));
  await vi.waitFor(() =>
    expect(state.tooltipEnvironment).toHaveBeenCalledWith(
      "Checker",
      EnvironmentId.make("environment-local"),
    ),
  );
});
