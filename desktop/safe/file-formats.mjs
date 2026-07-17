const format = (id, label, extension, mime, options = {}) => Object.freeze({
  id,
  label,
  extension,
  mime,
  seed: '',
  extensions: extension ? [extension] : [],
  ...options,
});

export const SAFE_FILE_FORMAT_GROUPS = Object.freeze([
  Object.freeze({
    label: 'Текст и документы',
    formats: Object.freeze([
      format('text/plain', 'Текст', '.txt', 'text/plain'),
      format('text/markdown', 'Markdown', '.md', 'text/markdown', { seed: '# Новый документ\n\n' }),
      format('document-log', 'Журнал', '.log', 'text/plain'),
      format('document-rst', 'reStructuredText', '.rst', 'text/x-rst'),
      format('document-asciidoc', 'AsciiDoc', '.adoc', 'text/asciidoc'),
      format('document-latex', 'LaTeX', '.tex', 'text/x-tex'),
      format('text/csv', 'CSV', '.csv', 'text/csv'),
      format('document-tsv', 'TSV', '.tsv', 'text/tab-separated-values'),
      format('document-org', 'Org Mode', '.org', 'text/org'),
      format('document-rtf', 'Rich Text Format', '.rtf', 'text/rtf', { seed: '{\\rtf1\\ansi\n}\n' }),
    ]),
  }),
  Object.freeze({
    label: 'PowerShell',
    formats: Object.freeze([
      format('powershell-script', 'Скрипт PowerShell', '.ps1', 'text/x-powershell', { seed: '#requires -Version 7.0\n\n[CmdletBinding()]\nparam()\n\n' }),
      format('powershell-module', 'Модуль PowerShell', '.psm1', 'text/x-powershell', { seed: 'Set-StrictMode -Version Latest\n\nExport-ModuleMember -Function @()\n' }),
      format('powershell-data', 'Данные / manifest PowerShell', '.psd1', 'text/x-powershell-data', { seed: '@{\n}\n' }),
      format('powershell-script-xml', 'Типы или формат PowerShell XML', '.ps1xml', 'application/xml', { seed: '<?xml version="1.0" encoding="utf-8"?>\n<Configuration>\n</Configuration>\n' }),
      format('powershell-types-xml', 'PowerShell Types XML', '.types.ps1xml', 'application/xml', { seed: '<?xml version="1.0" encoding="utf-8"?>\n<Types>\n</Types>\n' }),
      format('powershell-format-xml', 'PowerShell Format XML', '.format.ps1xml', 'application/xml', { seed: '<?xml version="1.0" encoding="utf-8"?>\n<Configuration>\n  <ViewDefinitions />\n</Configuration>\n' }),
      format('powershell-session-config', 'Конфигурация сессии PowerShell', '.pssc', 'text/x-powershell-data', { seed: "@{\n  SchemaVersion = '2.0.0.0'\n  SessionType = 'RestrictedRemoteServer'\n}\n" }),
      format('powershell-role-capability', 'Ролевая capability PowerShell', '.psrc', 'text/x-powershell-data', { seed: '@{\n  VisibleCmdlets = @()\n  VisibleFunctions = @()\n}\n' }),
      format('powershell-cdxml', 'Cmdlet Definition XML', '.cdxml', 'application/xml', { seed: '<?xml version="1.0" encoding="utf-8"?>\n<PowerShellMetadata xmlns="http://schemas.microsoft.com/cmdlets-over-objects/2009/11">\n</PowerShellMetadata>\n' }),
      format('powershell-clixml', 'PowerShell CLIXML', '.clixml', 'application/xml', { seed: '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"></Objs>\n' }),
      format('powershell-console', 'PowerShell Console', '.psc1', 'application/xml', { seed: '<?xml version="1.0" encoding="utf-8"?>\n<PSConsoleFile ConsoleSchemaVersion="1.0">\n  <PSVersion>7.0</PSVersion>\n  <PSSnapIns />\n</PSConsoleFile>\n' }),
      format('powershell-xaml', 'PowerShell Workflow XAML', '.xaml', 'application/xml', { seed: '<?xml version="1.0" encoding="utf-8"?>\n<Activity xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" />\n' }),
    ]),
  }),
  Object.freeze({
    label: 'Shell и автоматизация',
    formats: Object.freeze([
      format('shell-sh', 'Shell script', '.sh', 'text/x-shellscript', { seed: '#!/usr/bin/env sh\nset -eu\n\n' }),
      format('shell-bash', 'Bash', '.bash', 'text/x-shellscript', { seed: '#!/usr/bin/env bash\nset -euo pipefail\n\n' }),
      format('shell-zsh', 'Zsh', '.zsh', 'text/x-shellscript', { seed: '#!/usr/bin/env zsh\nset -e\n\n' }),
      format('shell-fish', 'Fish', '.fish', 'text/x-fish'),
      format('shell-nushell', 'Nushell', '.nu', 'text/x-nushell'),
      format('shell-cmd', 'Windows Command Script', '.cmd', 'text/x-batch', { seed: '@echo off\r\nsetlocal\r\n\r\n' }),
      format('shell-bat', 'Windows Batch', '.bat', 'text/x-batch', { seed: '@echo off\r\nsetlocal\r\n\r\n' }),
      format('automation-makefile', 'Makefile', '', 'text/x-makefile', { defaultName: 'Makefile' }),
      format('automation-dockerfile', 'Dockerfile', '', 'text/x-dockerfile', { defaultName: 'Dockerfile', seed: 'FROM scratch\n' }),
      format('automation-containerfile', 'Containerfile', '', 'text/x-dockerfile', { defaultName: 'Containerfile', seed: 'FROM scratch\n' }),
      format('automation-justfile', 'Justfile', '', 'text/x-makefile', { defaultName: 'justfile' }),
    ]),
  }),
  Object.freeze({
    label: 'Web',
    formats: Object.freeze([
      format('text/html', 'HTML', '.html', 'text/html', { seed: '<main>\n</main>\n' }),
      format('text/css', 'CSS', '.css', 'text/css'),
      format('web-scss', 'SCSS', '.scss', 'text/x-scss'),
      format('web-sass', 'Sass', '.sass', 'text/x-sass'),
      format('web-less', 'Less', '.less', 'text/x-less'),
      format('text/javascript', 'JavaScript', '.js', 'text/javascript', { seed: "'use strict';\n\n" }),
      format('web-mjs', 'JavaScript module', '.mjs', 'text/javascript', { seed: 'export {};\n' }),
      format('web-cjs', 'CommonJS', '.cjs', 'text/javascript', { seed: "'use strict';\n\n" }),
      format('web-jsx', 'JavaScript JSX', '.jsx', 'text/jsx'),
      format('web-typescript', 'TypeScript', '.ts', 'text/typescript', { seed: 'export {};\n' }),
      format('web-tsx', 'TypeScript TSX', '.tsx', 'text/tsx'),
      format('web-vue', 'Vue component', '.vue', 'text/x-vue', { seed: '<template>\n</template>\n\n<script setup>\n</script>\n\n<style scoped>\n</style>\n' }),
      format('web-svelte', 'Svelte component', '.svelte', 'text/x-svelte', { seed: '<script>\n</script>\n\n<main>\n</main>\n\n<style>\n</style>\n' }),
      format('web-astro', 'Astro component', '.astro', 'text/x-astro', { seed: '---\n---\n\n<main>\n</main>\n' }),
      format('web-svg', 'SVG', '.svg', 'image/svg+xml', { seed: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">\n</svg>\n' }),
      format('web-manifest', 'Web App Manifest', '.webmanifest', 'application/manifest+json', { seed: '{\n  "name": "",\n  "icons": []\n}\n' }),
    ]),
  }),
  Object.freeze({
    label: 'Языки программирования',
    formats: Object.freeze([
      format('code-python', 'Python', '.py', 'text/x-python', { seed: 'def main():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n' }),
      format('code-python-windowed', 'Python windowed', '.pyw', 'text/x-python'),
      format('code-rust', 'Rust', '.rs', 'text/x-rust', { seed: 'fn main() {\n}\n' }),
      format('code-go', 'Go', '.go', 'text/x-go', { seed: 'package main\n\nfunc main() {\n}\n' }),
      format('code-java', 'Java', '.java', 'text/x-java-source'),
      format('code-kotlin', 'Kotlin', '.kt', 'text/x-kotlin'),
      format('code-c', 'C', '.c', 'text/x-csrc'),
      format('code-c-header', 'C header', '.h', 'text/x-chdr'),
      format('code-cpp', 'C++', '.cpp', 'text/x-c++src'),
      format('code-cpp-header', 'C++ header', '.hpp', 'text/x-c++hdr'),
      format('code-csharp', 'C#', '.cs', 'text/x-csharp'),
      format('code-fsharp', 'F#', '.fs', 'text/x-fsharp'),
      format('code-swift', 'Swift', '.swift', 'text/x-swift'),
      format('code-dart', 'Dart', '.dart', 'text/x-dart'),
      format('code-ruby', 'Ruby', '.rb', 'text/x-ruby'),
      format('code-php', 'PHP', '.php', 'text/x-php', { seed: '<?php\n\n' }),
      format('code-perl', 'Perl', '.pl', 'text/x-perl'),
      format('code-lua', 'Lua', '.lua', 'text/x-lua'),
      format('code-r', 'R', '.r', 'text/x-r'),
      format('code-julia', 'Julia', '.jl', 'text/x-julia'),
      format('code-sql', 'SQL', '.sql', 'text/x-sql'),
      format('code-scala', 'Scala', '.scala', 'text/x-scala'),
      format('code-groovy', 'Groovy', '.groovy', 'text/x-groovy'),
      format('code-clojure', 'Clojure', '.clj', 'text/x-clojure'),
      format('code-elixir', 'Elixir', '.ex', 'text/x-elixir'),
      format('code-erlang', 'Erlang', '.erl', 'text/x-erlang'),
    ]),
  }),
  Object.freeze({
    label: 'Данные и конфигурация',
    formats: Object.freeze([
      format('application/json', 'JSON', '.json', 'application/json', { seed: '{\n  \n}\n' }),
      format('data-jsonc', 'JSON with Comments', '.jsonc', 'application/json'),
      format('data-jsonl', 'JSON Lines', '.jsonl', 'application/x-ndjson'),
      format('data-ipynb', 'Jupyter Notebook', '.ipynb', 'application/x-ipynb+json', { seed: '{\n  "cells": [],\n  "metadata": {},\n  "nbformat": 4,\n  "nbformat_minor": 5\n}\n' }),
      format('data-yaml', 'YAML', '.yaml', 'text/yaml', { extensions: ['.yaml', '.yml'] }),
      format('data-toml', 'TOML', '.toml', 'text/toml'),
      format('data-xml', 'XML', '.xml', 'application/xml', { seed: '<?xml version="1.0" encoding="utf-8"?>\n<root />\n' }),
      format('data-xsd', 'XML Schema', '.xsd', 'application/xml', { seed: '<?xml version="1.0" encoding="utf-8"?>\n<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" />\n' }),
      format('data-xslt', 'XSLT', '.xsl', 'application/xml', { extensions: ['.xsl', '.xslt'], seed: '<?xml version="1.0" encoding="utf-8"?>\n<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" />\n' }),
      format('data-ini', 'INI', '.ini', 'text/plain'),
      format('data-config', 'Config', '.cfg', 'text/plain', { extensions: ['.cfg', '.conf'] }),
      format('data-env', 'Environment variables', '.env', 'text/plain', { defaultName: '.env' }),
      format('data-properties', 'Java Properties', '.properties', 'text/x-java-properties'),
      format('data-plist', 'Property List XML', '.plist', 'application/xml', { seed: '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict />\n</plist>\n' }),
      format('data-editorconfig', 'EditorConfig', '', 'text/plain', { defaultName: '.editorconfig', seed: 'root = true\n\n[*]\ncharset = utf-8\n' }),
      format('data-gitignore', 'Git ignore', '', 'text/plain', { defaultName: '.gitignore' }),
      format('data-gitattributes', 'Git attributes', '', 'text/plain', { defaultName: '.gitattributes' }),
      format('data-graphql', 'GraphQL', '.graphql', 'text/graphql', { extensions: ['.graphql', '.gql'] }),
      format('data-protobuf', 'Protocol Buffers', '.proto', 'text/x-protobuf', { seed: 'syntax = "proto3";\n\n' }),
      format('data-terraform', 'Terraform', '.tf', 'text/x-hcl'),
      format('data-hcl', 'HCL', '.hcl', 'text/x-hcl'),
      format('data-nginx', 'Nginx config', '.conf', 'text/plain'),
    ]),
  }),
  Object.freeze({
    label: 'Другие',
    formats: Object.freeze([
      format('application/octet-stream', 'Пустой бинарный файл', '', 'application/octet-stream'),
    ]),
  }),
]);

export const SAFE_FILE_FORMATS = Object.freeze(SAFE_FILE_FORMAT_GROUPS.flatMap((group) => group.formats));

const formatById = new Map(SAFE_FILE_FORMATS.map((entry) => [entry.id, entry]));

export function getSafeFileFormat(id) {
  return formatById.get(String(id || '')) || formatById.get('text/plain');
}

export function withSafeFileExtension(name, formatId) {
  const clean = String(name || '').trim();
  const selected = getSafeFileFormat(formatId);
  if (!clean || !selected.extension) return clean;
  const lower = clean.toLowerCase();
  return selected.extensions.some((extension) => lower.endsWith(extension.toLowerCase()))
    ? clean
    : `${clean}${selected.extension}`;
}

export function seedSafeFileContent(formatId) {
  return getSafeFileFormat(formatId).seed;
}

export function isSafeEditableTextMime(mime) {
  const normalized = String(mime || '').toLowerCase();
  return normalized.startsWith('text/')
    || normalized.endsWith('+json')
    || normalized.endsWith('+xml')
    || ['application/json', 'application/xml', 'application/javascript', 'application/x-ndjson', 'image/svg+xml'].includes(normalized);
}
