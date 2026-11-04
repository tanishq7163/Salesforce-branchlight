import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

globalThis.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new JsonWorker();
    if (['css', 'scss', 'less'].includes(label)) return new CssWorker();
    if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker();
    if (['typescript', 'javascript'].includes(label)) return new TypeScriptWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });
monaco.editor.onDidCreateEditor((editor) => editor.updateOptions({ editContext: false }));
monaco.languages.register({ id: 'apex' });
monaco.languages.setMonarchTokensProvider('apex', {
  keywords: [
    'public',
    'private',
    'protected',
    'global',
    'class',
    'with',
    'without',
    'sharing',
    'static',
    'return',
    'void',
    'new',
    'if',
    'else',
    'for',
    'while',
    'try',
    'catch',
    'throw',
    'extends',
    'implements',
    'trigger',
    'on',
    'before',
    'after',
    'insert',
    'update',
    'delete',
    'true',
    'false',
    'null',
  ],
  tokenizer: {
    root: [
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/'([^'\\]|\\.)*'/, 'string'],
      [/@[\w]+/, 'annotation'],
      [/\b\d+\b/, 'number'],
      [/[a-zA-Z_][\w]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
  },
});
monaco.editor.defineTheme('branchlight', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '78837C' },
    { token: 'keyword', foreground: '8C3E80' },
    { token: 'string', foreground: '17715A' },
    { token: 'annotation', foreground: '95631C' },
  ],
  colors: {
    'editor.background': '#FFFFFF',
    'editorLineNumber.foreground': '#ABB3AD',
    'editor.lineHighlightBackground': '#F5F8F6',
    'editor.selectionBackground': '#D8EEE3',
    'editorCursor.foreground': '#17715A',
  },
});

export function languageFor(path: string): string {
  if (/\.(cls|trigger)$/.test(path)) return 'apex';
  if (/\.(html|cmp|app|page|component|xml|design|evt|auradoc|svg)$/.test(path)) return 'html';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.ts')) return 'typescript';
  if (path.endsWith('.md')) return 'markdown';
  return 'javascript';
}
