import { describe, expect, it } from "vitest";
import { parseCommand } from "./commands";

describe("parseCommand", () => {
  it.each([
    ["stop", "stop"],
    [" Stopp! ", "stop"],
    ["stoppen", "stop"],
    ["ende", "stop"],
    ["Pause", "pause"],
    ["pausieren", "pause"],
    ["weiter", "resume"],
    ["fortsetzen", "resume"],
    ["zurück", "previous"],
    ["zuruck", "previous"],
    ["zurueck", "previous"],
  ])("%j → %s", (input, command) => {
    expect(parseCommand(input)).toBe(command);
  });

  it("only treats the whole input as a command", () => {
    expect(parseCommand("pause dusw")).toBeNull();
    expect(parseCommand("stop motion video")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("constructor")).toBeNull();
  });
});
