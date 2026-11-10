// Jira's rich text (Atlassian Document Format) as Markdown-ish plain text, for the agent's brief.
// Unknown nodes keep whatever text they hold, so nothing readable is dropped.
export type AdfNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};

const inline = (n: AdfNode): string => {
  switch (n.type) {
    case "text": {
      const link = n.marks?.find((m) => m.type === "link")?.attrs?.href;
      const code = n.marks?.some((m) => m.type === "code");
      const t = code ? `\`${n.text ?? ""}\`` : (n.text ?? "");
      return typeof link === "string" && link !== n.text ? `${t} (${link})` : t;
    }
    case "hardBreak":
      return "\n";
    case "mention":
      return String(n.attrs?.text ?? "@someone");
    case "emoji":
      return String(n.attrs?.text ?? n.attrs?.shortName ?? "");
    case "inlineCard":
      return String(n.attrs?.url ?? "");
    case "status":
      return `[${String(n.attrs?.text ?? "")}]`;
    default:
      return (n.content ?? []).map(inline).join("") || n.text || "";
  }
};

function block(n: AdfNode, indent = ""): string {
  const kids = n.content ?? [];
  switch (n.type) {
    case "paragraph":
      return `${indent}${kids.map(inline).join("")}`;
    case "heading":
      // Jira's h1 is the ticket's own title level here, so headings sit two levels down.
      return `${"#".repeat(Math.min(6, Number(n.attrs?.level ?? 3) + 2))} ${kids.map(inline).join("")}`;
    case "codeBlock":
      return `\`\`\`${String(n.attrs?.language ?? "")}\n${kids.map(inline).join("")}\n\`\`\``;
    case "blockquote":
      return kids
        .map((k) => block(k))
        .join("\n\n")
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "rule":
      return "---";
    case "bulletList":
    case "orderedList":
      return kids
        .map((item, i) => {
          const mark = n.type === "orderedList" ? `${i + 1}.` : "-";
          const [first, ...rest] = (item.content ?? []).map((c) => block(c, ""));
          const body = [first ?? "", ...rest].join("\n").split("\n");
          return `${indent}${mark} ${body[0]}${body
            .slice(1)
            .map((l) => `\n${indent}  ${l}`)
            .join("")}`;
        })
        .join("\n");
    case "taskList":
      return kids
        .map(
          (item) =>
            `${indent}- [${item.attrs?.state === "DONE" ? "x" : " "}] ${(item.content ?? []).map(inline).join("")}`,
        )
        .join("\n");
    case "table":
      return kids
        .map((row) =>
          (row.content ?? []).map((cell) => (cell.content ?? []).map((c) => block(c)).join(" ")).join(" | "),
        )
        .join("\n");
    case "panel":
    case "expand":
    case "nestedExpand":
      return kids.map((k) => block(k)).join("\n\n");
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return "[attachment]";
    default:
      return kids.length
        ? kids.map((k) => (k.type && isBlock(k.type) ? block(k) : inline(k))).join("")
        : inline(n);
  }
}

const isBlock = (t: string) =>
  [
    "paragraph",
    "heading",
    "codeBlock",
    "blockquote",
    "rule",
    "bulletList",
    "orderedList",
    "taskList",
    "table",
    "panel",
    "expand",
    "mediaSingle",
    "mediaGroup",
  ].includes(t);

/** A whole document as text. A plain string (older Jira) passes through. */
export function adfToText(doc: unknown): string {
  if (typeof doc === "string") return doc.trim();
  if (!doc || typeof doc !== "object") return "";
  const d = doc as AdfNode;
  return (d.content ?? [])
    .map((n) => block(n))
    .join("\n\n")
    .trim();
}

const CRITERIA = /acceptance criteria/i;
const headingText = (n: AdfNode) => (n.content ?? []).map(inline).join("");

/**
 * Splits a description into the part before an "Acceptance criteria" heading, and that
 * section (up to the next heading of the same or a higher level). No such heading: all of it
 * is description.
 */
export function splitDescription(doc: unknown): { description: string; criteria: string } {
  const top = doc && typeof doc === "object" ? ((doc as AdfNode).content ?? []) : [];
  const at = top.findIndex((n) => n.type === "heading" && CRITERIA.test(headingText(n)));
  if (at === -1) return { description: adfToText(doc), criteria: "" };
  const level = Number(top[at]?.attrs?.level ?? 1);
  let end = top.length;
  for (let i = at + 1; i < top.length; i++) {
    const n = top[i] as AdfNode;
    if (n.type === "heading" && Number(n.attrs?.level ?? 1) <= level) {
      end = i;
      break;
    }
  }
  const wrap = (nodes: AdfNode[]) => adfToText({ type: "doc", content: nodes });
  return {
    description: wrap([...top.slice(0, at), ...top.slice(end)]),
    criteria: wrap(top.slice(at + 1, end)),
  };
}
