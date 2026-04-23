import { describe, test, expect } from "bun:test";
import { parseAnnotateArgs } from "./annotate-args";

describe("parseAnnotateArgs", () => {
  test("path only", () => {
    expect(parseAnnotateArgs("spec.md")).toEqual({
      filePath: "spec.md",
      gate: false,
      json: false,
    });
  });

  test("path with --gate at end", () => {
    expect(parseAnnotateArgs("spec.md --gate")).toEqual({
      filePath: "spec.md",
      gate: true,
      json: false,
    });
  });

  test("--gate before path", () => {
    expect(parseAnnotateArgs("--gate spec.md")).toEqual({
      filePath: "spec.md",
      gate: true,
      json: false,
    });
  });

  test("path with both flags", () => {
    expect(parseAnnotateArgs("spec.md --gate --json")).toEqual({
      filePath: "spec.md",
      gate: true,
      json: true,
    });
  });

  test("flags only, no path", () => {
    expect(parseAnnotateArgs("--gate --json")).toEqual({
      filePath: "",
      gate: true,
      json: true,
    });
  });

  test("path with spaces rejoins with single space", () => {
    expect(parseAnnotateArgs("my file.md --gate")).toEqual({
      filePath: "my file.md",
      gate: true,
      json: false,
    });
  });

  test("leading @ is stripped", () => {
    expect(parseAnnotateArgs("@spec.md --gate")).toEqual({
      filePath: "spec.md",
      gate: true,
      json: false,
    });
  });

  test("URL passes through", () => {
    expect(parseAnnotateArgs("https://example.com/docs --gate")).toEqual({
      filePath: "https://example.com/docs",
      gate: true,
      json: false,
    });
  });

  test("extra whitespace is collapsed", () => {
    expect(parseAnnotateArgs("  spec.md   --gate  ")).toEqual({
      filePath: "spec.md",
      gate: true,
      json: false,
    });
  });

  test("empty string produces empty result", () => {
    expect(parseAnnotateArgs("")).toEqual({
      filePath: "",
      gate: false,
      json: false,
    });
  });

  test("nullish input is tolerated", () => {
    expect(parseAnnotateArgs(undefined as unknown as string)).toEqual({
      filePath: "",
      gate: false,
      json: false,
    });
  });

  test("folder path with trailing slash", () => {
    expect(parseAnnotateArgs("./specs/ --gate --json")).toEqual({
      filePath: "./specs/",
      gate: true,
      json: true,
    });
  });

  // Regressions from the initial parser: the tokenize-and-rejoin approach
  // collapsed consecutive whitespace in file paths. Before this branch,
  // OpenCode and Pi passed the raw args string straight through, so files
  // with double-spaces or tabs in their names worked fine. These tests pin
  // that behavior so we don't regress it again.

  test("double-space inside a file path is preserved (flag at end)", () => {
    expect(parseAnnotateArgs("My  Notes.md --gate")).toEqual({
      filePath: "My  Notes.md",
      gate: true,
      json: false,
    });
  });

  test("double-space inside a file path is preserved (flag at start)", () => {
    expect(parseAnnotateArgs("--gate My  Notes.md")).toEqual({
      filePath: "My  Notes.md",
      gate: true,
      json: false,
    });
  });

  test("tab inside a file path is preserved", () => {
    expect(parseAnnotateArgs("My\tNotes.md --gate")).toEqual({
      filePath: "My\tNotes.md",
      gate: true,
      json: false,
    });
  });

  test("multi-whitespace path with no flags passes through untouched", () => {
    expect(parseAnnotateArgs("/tmp/My  Notes.md")).toEqual({
      filePath: "/tmp/My  Notes.md",
      gate: false,
      json: false,
    });
  });
});
