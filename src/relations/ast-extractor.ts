import ts from 'typescript';
import type { KnowledgeRelationInput, ReferenceInput, StoredKnowledge } from '../types.js';
import { uniqueStrings } from '../util/text.js';

export interface AstExtractionResult {
  /** Symbol names declared/exported by the parsed file (de-duplicated). */
  exportedSymbols: string[];
  /** Call expressions discovered in the file (callee names; de-duplicated). */
  calls: string[];
}

export interface AstExtractionOptions {
  /** Filename hint, used to pick the TypeScript ScriptKind. */
  filename?: string;
}

const SUPPORTED_EXTENSIONS = /\.(?:tsx?|jsx?|mjs|cjs)$/i;
const CALL_STOP_WORDS = new Set([
  'require', 'console', 'log', 'warn', 'error', 'info', 'debug', 'fetch', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Promise',
]);

/**
 * Parse a single source file via the TypeScript compiler API and return exported symbol names
 * plus discovered call expressions. Failures are swallowed and the caller falls back to the
 * regex-driven inference path (see callers in relations/inference.ts).
 */
export function extractAstSymbols(source: string, options: AstExtractionOptions = {}): AstExtractionResult {
  const filename = options.filename ?? 'input.ts';
  if (!SUPPORTED_EXTENSIONS.test(filename)) {
    return { exportedSymbols: [], calls: [] };
  }

  try {
    const scriptKind = pickScriptKind(filename);
    const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, /* setParentNodes */ false, scriptKind);
    const exportedSymbols: string[] = [];
    const calls: string[] = [];

    visit(sourceFile, exportedSymbols, calls);
    return {
      exportedSymbols: uniqueStrings(exportedSymbols),
      calls: uniqueStrings(calls.filter((value) => !CALL_STOP_WORDS.has(value))),
    };
  } catch {
    return { exportedSymbols: [], calls: [] };
  }
}

/** Convert AST results into inferred KnowledgeRelations. Empty when nothing of interest is found. */
export function relationsFromAst(item: StoredKnowledge, result: AstExtractionResult): KnowledgeRelationInput[] {
  const seeds: KnowledgeRelationInput[] = [];
  for (const symbol of result.exportedSymbols) {
    seeds.push({
      project: item.project,
      fromKnowledgeId: item.id,
      relationType: 'mentions_symbol',
      targetKind: 'symbol',
      targetValue: symbol,
      confidence: 0.92,
      inferred: true,
      metadata: { source: 'ast:export' },
    });
  }
  for (const call of result.calls) {
    seeds.push({
      project: item.project,
      fromKnowledgeId: item.id,
      relationType: 'depends_on',
      targetKind: 'symbol',
      targetValue: call,
      confidence: 0.7,
      inferred: true,
      metadata: { source: 'ast:call' },
    });
  }
  return seeds;
}

export function pickAstSourceFromReferences(references: ReferenceInput[] | undefined): string | undefined {
  if (!references) return undefined;
  for (const reference of references) {
    if (reference.type === 'file' && SUPPORTED_EXTENSIONS.test(reference.uri)) {
      return reference.uri;
    }
  }
  return undefined;
}

function pickScriptKind(filename: string): ts.ScriptKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function visit(node: ts.Node, exportedSymbols: string[], calls: string[]): void {
  if (ts.isFunctionDeclaration(node) && node.name && hasExportModifier(node)) {
    exportedSymbols.push(node.name.text);
  } else if (ts.isClassDeclaration(node) && node.name && hasExportModifier(node)) {
    exportedSymbols.push(node.name.text);
  } else if (ts.isInterfaceDeclaration(node) && hasExportModifier(node)) {
    exportedSymbols.push(node.name.text);
  } else if (ts.isTypeAliasDeclaration(node) && hasExportModifier(node)) {
    exportedSymbols.push(node.name.text);
  } else if (ts.isEnumDeclaration(node) && hasExportModifier(node)) {
    exportedSymbols.push(node.name.text);
  } else if (ts.isVariableStatement(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        exportedSymbols.push(declaration.name.text);
      }
    }
  } else if (ts.isExportSpecifier(node)) {
    const exportedName = node.name.text;
    if (exportedName && exportedName !== 'default') {
      exportedSymbols.push(exportedName);
    }
  }

  if (ts.isCallExpression(node)) {
    const callee = extractCalleeName(node.expression);
    if (callee) {
      calls.push(callee);
    }
  }

  ts.forEachChild(node, (child) => visit(child, exportedSymbols, calls));
}

function hasExportModifier(node: ts.Declaration): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return Boolean(modifiers?.some((modifier) => modifier.kind === kind));
}

function extractCalleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
}
