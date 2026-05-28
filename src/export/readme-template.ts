export const README_TEMPLATE = `# Tuberosa Project Pack

This directory is a portable export of a Tuberosa project. You can:

- **Read** atoms and knowledge by opening any \`.md\` file.
- **Edit** an atom: change the body or frontmatter fields, save. Bump the \`revision\` if you want.
- **Add** a new atom: drop a \`.md\` file in \`atoms/\` with valid frontmatter (copy any existing file as a template).
- **Append** a new edge: append a JSON line to \`edges.jsonl\` with the same shape as existing lines.

Import on the receiving side:

\`\`\`bash
pnpm run import-pack -- --from path/to/.tuberosa-pack
\`\`\`

Conflicts (same atom id, different content) go to the Tuberosa workbench "Import conflicts" tab for review. Edges auto-merge by max confidence.
`;
