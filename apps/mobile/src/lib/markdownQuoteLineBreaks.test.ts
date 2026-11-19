import { expect, it } from "vite-plus/test";
import { markdownWithQuoteLineBreaks } from "./markdownDocument";

it("keeps each line of a quote on its own line and leaves prose wrapping", () => {
  expect(
    markdownWithQuoteLineBreaks("> Hi {name}, it's Yoav\n> Saw you started signing up?\n\nAfter"),
  ).toBe("> Hi {name}, it's Yoav  \n> Saw you started signing up?\n\nAfter");
  expect(markdownWithQuoteLineBreaks("> > a\r\n> > b\r\n> - c\r\n>   d")).toBe(
    "> > a  \r\n> > b\r\n> - c  \r\n>   d",
  );
  for (const markdown of [
    "Hard-wrapped\nprose",
    "> already  \n> broken\\\n> lines",
    "> one line\n\nThen prose\nwraps",
    "```\n> not a quote\n> here\n```",
  ]) {
    expect(markdownWithQuoteLineBreaks(markdown)).toBe(markdown);
  }
});
