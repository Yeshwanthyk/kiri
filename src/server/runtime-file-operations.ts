export type FileOperationProjection = {
  toolName: string;
  path?: string;
  summary?: string;
};

const FILE_OPERATION_NAMES = new Set([
  "edit",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "notebook_edit",
  "write",
  "apply_patch",
  "applypatch",
  "filechange",
  "file_change",
  "patch",
]);

const PATH_KEYS = [
  "file_path",
  "filePath",
  "filepath",
  "path",
  "target_file",
  "targetFile",
  "notebook_path",
  "notebookPath",
  "file",
] as const;

export function fileOperationFromTool(
  toolName: string,
  input: Record<string, unknown> = {},
): FileOperationProjection | null {
  const normalized = normalizeToolName(toolName);
  const command = stringValue(input.command) ?? stringValue(input.cmd);
  if (!isFileOperationName(normalized) && !isPatchCommand(command)) return null;

  const path = pathFromInput(input) ?? pathFromPatch(command);
  const effectiveToolName =
    isPatchCommand(command) && !isFileOperationName(normalized)
      ? "apply_patch"
      : toolName;
  return {
    toolName: effectiveToolName,
    path,
    summary: summaryFor(effectiveToolName, path, command),
  };
}

export function fileOperationFromCodexItem(
  item: Record<string, unknown>,
): FileOperationProjection | null {
  const type = stringValue(item.type);
  if (type === "fileChange") {
    return fileOperationFromTool("fileChange", item);
  }
  if (type === "commandExecution") {
    return fileOperationFromTool("commandExecution", item);
  }
  const toolName =
    stringValue(item.name) ??
    stringValue(item.toolName) ??
    stringValue(item.title);
  if (!toolName) return null;
  return fileOperationFromTool(
    toolName,
    objectValue(item.input) ?? objectValue(item.arguments) ?? item,
  );
}

export function fileOperationFromPiEvent(
  event: Record<string, unknown>,
): FileOperationProjection | null {
  const toolName =
    stringValue(event.toolName) ??
    stringValue(event.tool) ??
    stringValue(event.name) ??
    stringValue(event.kind);
  if (!toolName) return null;
  return fileOperationFromTool(
    toolName,
    objectValue(event.args) ?? objectValue(event.input) ?? event,
  );
}

export function isFileOperationCompletionEvent(event: Record<string, unknown>) {
  const type = normalizeToolName(
    stringValue(event.type) ??
      stringValue(event.event) ??
      stringValue(event.kind) ??
      "",
  );
  return (
    type.includes("complete") ||
    type.includes("completed") ||
    type.includes("finish") ||
    type.includes("finished") ||
    type.includes("end") ||
    type.includes("failed") ||
    type.includes("error")
  );
}

export function fileOperationStatusFromEvent(
  event: Record<string, unknown>,
): "completed" | "failed" {
  const type = normalizeToolName(
    stringValue(event.type) ??
      stringValue(event.event) ??
      stringValue(event.kind) ??
      "",
  );
  return type.includes("failed") || type.includes("error")
    ? "failed"
    : "completed";
}

function isFileOperationName(normalized: string) {
  return (
    FILE_OPERATION_NAMES.has(normalized) ||
    normalized.includes("filechange") ||
    normalized.includes("file_change") ||
    normalized.includes("applypatch") ||
    normalized.includes("apply_patch") ||
    (normalized.includes("edit") && normalized !== "read") ||
    normalized.includes("write")
  );
}

function isPatchCommand(command: string | undefined) {
  if (!command) return false;
  return command.includes("apply_patch") || command.includes("*** Begin Patch");
}

function pathFromInput(input: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const path = stringValue(input[key]);
    if (path?.trim()) return path.trim();
  }
  return undefined;
}

function pathFromPatch(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const match = command.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m);
  return match?.[1]?.trim();
}

function summaryFor(
  toolName: string,
  path: string | undefined,
  command: string | undefined,
) {
  if (path) return `${toolName}: ${path}`;
  if (command?.trim()) return `${toolName}: ${command.trim().slice(0, 400)}`;
  return toolName;
}

function normalizeToolName(value: string) {
  return value.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
