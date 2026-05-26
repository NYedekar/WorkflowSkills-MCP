import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export const saveToMacSchema = z.object({
  content: z
    .string()
    .describe(
      "The text content to save (JSON, CSV, plain text, Markdown, etc.). " +
        "Use this whenever you have synthesized, aggregated, or assembled data that needs " +
        "to be written to the Mac filesystem. Claude's bash cannot write to Mac disk — " +
        "only the MCP server (Mac process) can."
    ),
  save_to: z
    .string()
    .optional()
    .default("~/Downloads")
    .describe(
      "Target folder on the Mac. Defaults to ~/Downloads. " +
        "~ is expanded to the home directory. The folder is created if it does not exist."
    ),
  filename: z
    .string()
    .describe(
      "Filename including extension (e.g. 'metadata.json', 'report.csv', 'summary.md'). " +
        "If the file already exists it will be overwritten."
    ),
});

export type SaveToMacInput = z.infer<typeof saveToMacSchema>;

export interface SaveToMacOutput {
  status: "success" | "error";
  saved_to?: string;
  size_bytes?: number;
  error?: string;
  hint?: string;
}

export async function handleSaveToMac(input: SaveToMacInput): Promise<SaveToMacOutput> {
  const folder = input.save_to ?? "~/Downloads";
  const expanded = folder.startsWith("~")
    ? path.join(os.homedir(), folder.slice(1))
    : folder;
  const resolved = path.resolve(expanded);

  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (err) {
    return {
      status: "error",
      error: `Could not create folder '${resolved}': ${String(err)}`,
    };
  }

  const filePath = path.join(resolved, input.filename);
  try {
    fs.writeFileSync(filePath, input.content, "utf-8");
  } catch (err) {
    return {
      status: "error",
      error: `Could not write file '${filePath}': ${String(err)}`,
      hint: "Check that the path is writable and the filename is valid.",
    };
  }

  return {
    status: "success",
    saved_to: filePath,
    size_bytes: Buffer.byteLength(input.content, "utf-8"),
  };
}
