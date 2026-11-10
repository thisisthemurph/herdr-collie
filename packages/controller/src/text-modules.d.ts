// Bun embeds these files into the compiled binary (`import x from "./f.md" with { type: "text" }`).
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*.txt" {
  const text: string;
  export default text;
}
