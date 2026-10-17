import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { VcsFallbackNotice } from "./VcsFallbackNotice";

function emptyLocalStorage(): Disposable {
  localStorage.clear();
  return { [Symbol.dispose]: () => localStorage.clear() };
}

it("persists fallback dismissal per repository and resurfaces changed text or reason", async () => {
  using _storage = emptyLocalStorage();
  const repository = "/fallback-notice";
  const props = {
    environmentId: "test",
    repository,
    notice: "Jujutsu unavailable; using Git",
    reason: null as string | null,
  };
  await using screen = await render(<VcsFallbackNotice {...props} />);
  await expect
    .element(screen.getByRole("status").getByText(props.notice, { exact: true }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Dismiss repository fallback notice" }));
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  await screen.rerender(<VcsFallbackNotice {...props} key="remount" />);
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  await screen.rerender(<VcsFallbackNotice {...props} repository={`${repository}/other`} />);
  await expect
    .element(screen.getByRole("status").getByText(props.notice, { exact: true }))
    .toBeVisible();
  await screen.rerender(
    <VcsFallbackNotice {...props} notice="Jujutsu configuration changed; using Git" />,
  );
  await expect
    .element(screen.getByRole("status").getByText("configuration changed", { exact: false }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Dismiss repository fallback notice" }));
  await screen.rerender(
    <VcsFallbackNotice
      {...props}
      notice="Jujutsu configuration changed; using Git"
      reason="Unsupported workspace"
    />,
  );
  await expect
    .element(screen.getByRole("status").getByText("configuration changed", { exact: false }))
    .toBeVisible();
});
