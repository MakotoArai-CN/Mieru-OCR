#!/usr/bin/env bun
/**
 * 用 TypeScript 自带的格式化服务重新缩进文件（仅改空白，不动 AST）。
 *
 * 用途：popup-firefox.ts 全部顶格（缩进行数 0），导致与 popup.ts 的 diff 有 62%
 * 是空白噪声，任何 merge 工具都不可用。TS LanguageService 的 formatting 只产出
 * 空白 textChange，能保证不改变任何语义。
 *
 *   bun tools/reindent.ts <file> [--check]
 */
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const target = process.argv[2];
const checkOnly = process.argv.includes('--check');
if (!target) {
  console.error('用法: bun tools/reindent.ts <file> [--check]');
  process.exit(2);
}

const filePath = resolve(target);
const source = readFileSync(filePath, 'utf-8');

const options: ts.FormatCodeSettings = {
  indentSize: 2,
  tabSize: 2,
  convertTabsToSpaces: true,
  newLineCharacter: '\n',
  indentStyle: ts.IndentStyle.Smart,
  insertSpaceAfterCommaDelimiter: true,
  insertSpaceAfterKeywordsInControlFlowStatements: true,
  insertSpaceBeforeAndAfterBinaryOperators: true,
  insertSpaceAfterSemicolonInForStatements: true,
  placeOpenBraceOnNewLineForFunctions: false,
  placeOpenBraceOnNewLineForControlBlocks: false,
};

// 单文件 LanguageService，只为拿 formatting 的 textChange
const host: ts.LanguageServiceHost = {
  getScriptFileNames: () => [filePath],
  getScriptVersion: () => '1',
  getScriptSnapshot: (name) =>
    name === filePath ? ts.ScriptSnapshot.fromString(source) : undefined,
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => ({ target: ts.ScriptTarget.ES2020, allowJs: false }),
  getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  fileExists: () => true,
  readFile: (name) => (name === filePath ? source : undefined),
};

const service = ts.createLanguageService(host, ts.createDocumentRegistry());
const edits = service.getFormattingEditsForDocument(filePath, options);

// 从后往前应用，避免 offset 位移
let out = source;
for (const e of [...edits].sort((a, b) => b.span.start - a.span.start)) {
  out = out.slice(0, e.span.start) + e.newText + out.slice(e.span.start + e.span.length);
}

// 安全网：剥掉所有空白后必须完全一致，否则说明动了语义，拒绝写入
const strip = (s: string) => s.replace(/\s+/g, '');
if (strip(out) !== strip(source)) {
  console.error('✗ 中止：格式化改变了非空白内容，不予写入');
  process.exit(1);
}

const indented = out.split('\n').filter((l) => /^ +\S/.test(l)).length;
console.log(`${target}: ${edits.length} 处空白调整，缩进行数 → ${indented}`);

if (checkOnly) {
  console.log(out === source ? '已是目标格式' : '需要重新缩进');
  process.exit(out === source ? 0 : 1);
}

writeFileSync(filePath, out, 'utf-8');
console.log('✓ 已写入（仅空白变更）');
